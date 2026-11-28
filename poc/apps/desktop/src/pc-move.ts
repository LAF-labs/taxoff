import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  acceptMoveSender, b64url, fromB64, fromB64url, moveChunkCount, MOVE_CHUNK, openMoveReceiver, receiveMove, sendMove,
  type DeviceListJson, type MoveResult, type MoveSink, type NoiseStatic, type RelayClient,
} from '@sax/remote';
import type { AccountClient, DeviceAuth, PcMoveRequest, RelayHttpClient } from './remote-ports.ts';

export type PcMoveView =
  | { step: 'none' }
  | { step: 'waiting' }
  | { step: 'receiving'; fromName: string; got: number; total: number }
  | { step: 'received'; fromName: string; counts: Record<string, number> }
  | { step: 'update_needed' }
  | { step: 'sending'; toName: string; sent: number; total: number }
  | { step: 'sent'; toName: string };

export interface PcMoveDevice {
  readonly deviceId: string;
  readonly deviceList: DeviceListJson;
  auth: DeviceAuth;
}

export interface PcMoveBundle {
  file: string;
  schema: number;
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
}

export interface PcMoveEngine {
  exportBundle(): Promise<PcMoveBundle>;
  importBundle(file: string): Promise<MoveResult>;
  discard(file: string): Promise<void>;
  received(): Promise<string | null>;
  newFile(): string;
}

interface PcMoveOptions {
  client: Pick<AccountClient, 'askMove' | 'moves' | 'meetMove' | 'endMove'>;
  relayHttp: Pick<RelayHttpClient, 'createRoom'>;
  relay: Pick<RelayClient, 'joinRoom'>;
  device: () => Promise<PcMoveDevice | null>;
  noise: () => Promise<NoiseStatic>;
  engine: PcMoveEngine;
  onView?: (v: PcMoveView) => void;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
  now?: () => number;
}

export const PC_MOVE_NEW_PC_DAYS = 30;
export const PC_MOVE_WAIT_POLL_MS = 30_000;
export const PC_MOVE_POLL_MS = 5 * 60_000;
const MEET_AGAIN_MS = 3 * 60_000;

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : (e as Error | null)?.message?.slice(0, 40) ?? 'unknown';
};

export class PcMoveHost {
  #o: PcMoveOptions;
  #now: () => number;
  #view: PcMoveView = { step: 'none' };
  #busy = false;
  #met = new Map<string, number>();

  constructor(o: PcMoveOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  view(): PcMoveView {
    return this.#view;
  }

  pollMs(): number {
    return this.#view.step === 'waiting' ? PC_MOVE_WAIT_POLL_MS : PC_MOVE_POLL_MS;
  }

  #set(v: PcMoveView): void {
    this.#view = v;
    this.#o.onView?.(v);
  }

  #log(step: string, d: Record<string, string | number | boolean> = {}): void {
    this.#o.log?.('main.pc_move', { step, ...d });
  }

  async tick(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      const dev = await this.#o.device();
      if (!dev) return;
      const desktops = dev.deviceList.entries.map((e) => e.entry).filter((e) => e.role === 'desktop');
      const me = desktops.find((e) => e.device_id === dev.deviceId);
      if (!me) return;
      const r = await this.#o.client.moves(dev.auth);
      for (const ask of r.asks) {
        const to = desktops.find((e) => e.device_id === ask.toDeviceId);
        if (!to || !ask.askerOnline || ask.roomId !== null || this.#now() - (this.#met.get(ask.id) ?? 0) < MEET_AGAIN_MS) continue;
        this.#met.set(ask.id, this.#now());
        await this.#send(dev, ask, fromB64(to.Sx));
      }
      const older = desktops.some((e) => e.device_id !== dev.deviceId && e.registered_at < me.registered_at);
      const fresh = this.#now() - me.registered_at < PC_MOVE_NEW_PC_DAYS * 86_400_000;
      if (!older || !fresh || (await this.#o.engine.received())) {
        if (this.#view.step === 'waiting') this.#set({ step: 'none' });
        return;
      }
      const mine = r.mine ?? (await this.#o.client.askMove(dev.auth));
      const from = mine.fromDeviceId ? desktops.find((e) => e.device_id === mine.fromDeviceId) : undefined;
      if (mine.roomId && from) await this.#receive(dev, mine, fromB64(from.Sx));
      else if (this.#view.step !== 'update_needed') this.#set({ step: 'waiting' });
    } catch (e) {
      this.#log('tick', { result: codeOf(e) });
    } finally {
      this.#busy = false;
    }
  }

  async #receive(dev: PcMoveDevice, mine: PcMoveRequest, senderStatic: Uint8Array): Promise<void> {
    const fromName = mine.fromName ?? '';
    const link = await this.#o.relay.joinRoom(fromB64url(mine.roomId!), 'mobile');
    const pipe = await openMoveReceiver(link, { requestId: mine.id, fromDeviceId: mine.fromDeviceId!, toDeviceId: dev.deviceId, noise: await this.#o.noise(), senderStatic });
    if (!pipe) {
      link.close();
      return this.#log('receive', { result: 'handshake' });
    }
    const file = this.#o.engine.newFile();
    let fh: fs.FileHandle | null = null;
    const sink: MoveSink = {
      open: async (m) => {
        this.#set({ step: 'receiving', fromName, got: 0, total: m.chunks });
        await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
        fh = await fs.open(file, 'wx', 0o600);
        return null;
      },
      write: async (_i, data) => void (await fh!.write(data)),
      finish: async () => {
        await fh!.close();
        fh = null;
        return this.#o.engine.importBundle(file);
      },
      abort: async () => {
        await fh?.close();
        fh = null;
        await this.#o.engine.discard(file);
      },
    };
    try {
      const r = await receiveMove(pipe, sink, { idleMs: 5 * 60_000, onProgress: (got, total) => this.#view.step === 'receiving' && got % 32 === 0 && this.#set({ step: 'receiving', fromName, got, total }) });
      this.#log('receive', { result: r ? (r.state === 'stored' ? 'stored' : r.reason) : 'cut' });
      if (r?.state === 'stored') {
        await this.#o.client.endMove(dev.auth, mine.id, 'done').catch((e: unknown) => this.#log('done', { result: codeOf(e) }));
        this.#set({ step: 'received', fromName, counts: r.counts });
      } else if (r?.state === 'refused' && r.reason === 'schema_newer') {
        this.#set({ step: 'update_needed' });
      } else {
        this.#set({ step: 'waiting' });
      }
    } finally {
      pipe.close();
    }
  }

  async #send(dev: PcMoveDevice, ask: PcMoveRequest, receiverStatic: Uint8Array): Promise<void> {
    const roomId = randomBytes(16);
    await this.#o.relayHttp.createRoom(dev.auth, roomId);
    const link = await this.#o.relay.joinRoom(roomId, 'desktop');
    await this.#o.client.meetMove(dev.auth, ask.id, b64url(roomId));
    const pipe = await acceptMoveSender(link, { requestId: ask.id, fromDeviceId: dev.deviceId, toDeviceId: ask.toDeviceId, noise: await this.#o.noise(), receiverStatic, timeoutMs: 110_000 });
    if (!pipe) {
      link.close();
      return this.#log('send', { result: 'no_peer' });
    }
    const toName = ask.toName;
    let bundle: PcMoveBundle | null = null;
    let fh: fs.FileHandle | null = null;
    try {
      bundle = await this.#o.engine.exportBundle();
      fh = await fs.open(bundle.file, 'r');
      const total = moveChunkCount(bundle.bytes);
      this.#set({ step: 'sending', toName, sent: 0, total });
      const read = fh;
      const r = await sendMove(
        pipe,
        {
          manifest: { v: 1, schema: bundle.schema, bytes: bundle.bytes, sha256: bundle.sha256, chunks: total, counts: bundle.counts },
          chunk: async (i) => {
            const b = Buffer.alloc(Math.min(MOVE_CHUNK, bundle!.bytes - i * MOVE_CHUNK));
            await read.read(b, 0, b.length, i * MOVE_CHUNK);
            return b;
          },
        },
        { onProgress: (sent, n) => sent % 32 === 0 && this.#set({ step: 'sending', toName, sent, total: n }) },
      );
      this.#log('send', { result: r ? (r.state === 'stored' ? 'stored' : r.reason) : 'cut', bytes: bundle.bytes });
      this.#set(r?.state === 'stored' ? { step: 'sent', toName } : { step: 'none' });
    } finally {
      await fh?.close();
      if (bundle) await this.#o.engine.discard(bundle.file);
      pipe.close();
    }
  }
}
