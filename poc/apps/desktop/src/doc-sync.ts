import { createHash } from 'node:crypto';
import {
  b64url, docBlobSize, docKeyOf, DOC_ID, DOC_MAX_BYTES, newDocId, newDocKey, openDocBlob, openDocRecord, sealDocBlob, sealDocRecord, shareEpoch, SHARE_MAX_EPOCH,
  type DocRecordCore,
} from '@sax/remote';
import type { DocCloudRow } from '@sax/engine';
import type { DeviceAuth, DocServerEntry, DocsClient, ShareVault } from './remote-ports.ts';
import type { ShareDevice } from './share-sync.ts';

/**
 * 문서함 계정 사본 맞추기(ADR-064). PC 파일이 원본이고, 계정에는 봉인한 사본만 둔다.
 *   내려받기: 커서 뒤 변경을 받아 기록을 열고(K_doc(e), Ws 서명), 이 PC에 없는 문서만 조각을 받아 보관함에 넣는다.
 *             지운 표시는 이 PC 줄이 다시 올라가지 않게만 적는다(파일은 두고).
 *   올리기:   계정 사본이 없는 보관함 줄을 새 DEK로 조각 봉인해 start → 조각 → 기록 순서로 올린다.
 * 서버가 계정 열쇠를 열 수 있는 동안(맡긴 열쇠가 남은 계정)은 서버가 받지 않으므로(account.docs_escrow_on) 조용히 멈춘다.
 * 로그에는 사건 이름과 수만 남긴다. 이름, 종류, 날짜는 남기지 않는다.
 */

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

interface DocSyncOptions {
  client: DocsClient | null;
  device: () => Promise<ShareDevice | null>;
  vault: () => Promise<ShareVault>;
  rpc: Rpc;
  /** 보관함 줄의 파일 바이트. 없으면 던진다. */
  readFile: (id: string) => Promise<Uint8Array>;
  now?: () => number;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
}

interface DocSyncResult {
  state: 'ok' | 'not_needed' | 'stopped' | 'failed';
  code?: string;
  pulled: number;
  restored: number;
  linked: number;
  forgot: number;
  rejected: number;
  pushed: number;
  skipped: number;
}

const PULL_PAGES = 25;
const PUSH_BATCH = 20;
/** 서버가 받지 않는 동안 이번 차례를 조용히 끝내는 코드. 다음 차례에 다시 본다. */
const STOP = new Set(['account.docs_escrow_on', 'account.docs_full', 'request.not_found', 'account.scope_denied']);

const codeOf = (e: unknown): string => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' && /^[a-z_]+\.[a-z_]+$/.test(c) ? c : 'docs.failed';
};
class Stop extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

class Keys {
  readonly #vault: ShareVault;
  readonly #byEpoch = new Map<number, Uint8Array>();
  #signPub: Uint8Array | null = null;
  constructor(vault: ShareVault) {
    this.#vault = vault;
  }
  async key(epoch: number): Promise<Uint8Array> {
    const have = this.#byEpoch.get(epoch);
    if (have) return have;
    const r = await this.#vault.key(epoch);
    this.#byEpoch.set(epoch, r.key);
    this.#signPub = r.signPub;
    return r.key;
  }
  async signPub(): Promise<Uint8Array> {
    if (!this.#signPub) await this.key(0);
    return this.#signPub!;
  }
  sign(msg: Uint8Array): Promise<Uint8Array> {
    return this.#vault.sign(msg);
  }
  wipe(): void {
    for (const k of this.#byEpoch.values()) k.fill(0);
    this.#byEpoch.clear();
  }
}

function cloudState(v: unknown): { off: boolean; cursor: number; docs: DocCloudRow[] } {
  const r = v as { off?: unknown; cursor?: unknown; docs?: unknown } | null;
  if (!r || typeof r.off !== 'boolean' || !Number.isSafeInteger(r.cursor) || (r.cursor as number) < 0 || !Array.isArray(r.docs)) throw new Stop('docs.store_failed');
  return { off: r.off, cursor: r.cursor as number, docs: r.docs as DocCloudRow[] };
}

export class DocSync {
  readonly #o: DocSyncOptions;
  readonly #now: () => number;
  #chain: Promise<unknown> = Promise.resolve();

  constructor(o: DocSyncOptions) {
    this.#o = o;
    this.#now = o.now ?? Date.now;
  }

  /** 한 번에 하나만 돈다. 겹쳐 부르면 앞 차례가 끝난 뒤 이어서 돈다. */
  sync(): Promise<DocSyncResult> {
    const p = this.#chain.then(() => this.#run());
    this.#chain = p.catch(() => {});
    return p;
  }

  async #run(): Promise<DocSyncResult> {
    const out: DocSyncResult = { state: 'ok', pulled: 0, restored: 0, linked: 0, forgot: 0, rejected: 0, pushed: 0, skipped: 0 };
    const started = this.#now();
    let keys: Keys | null = null;
    try {
      const client = this.#o.client;
      const dev = client ? await this.#o.device() : null;
      const st = client && dev ? cloudState(await this.#o.rpc('db.query.docs.cloud')) : null;
      if (!client || !dev || !st || st.off) {
        out.state = 'not_needed';
        return out;
      }
      keys = new Keys(await this.#o.vault());
      await this.#pull(client, dev, keys, st, out);
      await this.#push(client, dev, keys, out);
    } catch (e) {
      const code = codeOf(e);
      out.state = STOP.has(code) ? 'stopped' : 'failed';
      out.code = code;
    } finally {
      keys?.wipe();
      if (out.state !== 'not_needed') {
        const { state, code, ...n } = out;
        this.#o.log?.('main.doc_sync', { result: code ?? state, ...n, ms: this.#now() - started });
      }
    }
    return out;
  }

  async #call<T>(dev: ShareDevice, f: (auth: DeviceAuth) => Promise<T>): Promise<T> {
    try {
      return await f(dev.auth);
    } catch (e) {
      if (codeOf(e) !== 'account.unauthorized') throw e;
      dev.clearToken();
      return f(dev.auth);
    }
  }

  async #pull(client: DocsClient, dev: ShareDevice, keys: Keys, st: { cursor: number; docs: DocCloudRow[] }, out: DocSyncResult): Promise<void> {
    let cursor = st.cursor;
    const byDocId = new Map(st.docs.filter((d) => d.docId).map((d) => [d.docId!, d]));
    const bySha = new Map(st.docs.map((d) => [d.sha256, d]));
    for (let page = 0; page < PULL_PAGES; page++) {
      const got = await this.#call(dev, (auth) => client.list(auth, cursor));
      if (got.head < cursor) {
        this.#o.log?.('main.doc_head_regressed', { behind: cursor - got.head });
        throw new Stop('docs.head_regressed');
      }
      for (const e of got.docs) {
        out.pulled++;
        await this.#apply(client, dev, keys, e, byDocId, bySha, out);
      }
      if (got.docs.length) {
        cursor = got.docs[got.docs.length - 1]!.seq;
        await this.#o.rpc('docs.cursor', { cursor });
      }
      if (!got.more) return;
    }
  }

  async #apply(client: DocsClient, dev: ShareDevice, keys: Keys, e: DocServerEntry, byDocId: Map<string, DocCloudRow>, bySha: Map<string, DocCloudRow>, out: DocSyncResult): Promise<void> {
    const mine = byDocId.get(e.docId);
    if (e.state === 'deleted') {
      if (mine && mine.state !== 'none') {
        await this.#o.rpc('docs.forget', { docId: e.docId });
        mine.state = 'none';
        out.forgot++;
      }
      return;
    }
    if (mine && mine.state === 'uploaded' && mine.rev >= e.rev) return;
    if (e.epoch > SHARE_MAX_EPOCH || e.record === null) {
      out.rejected++;
      return;
    }
    const opened = openDocRecord(await keys.key(e.epoch), { docId: e.docId, rev: e.rev, epoch: e.epoch, record: e.record }, await keys.signPub());
    if (!opened.ok || opened.core.body.chunks !== e.chunks) {
      out.rejected++;
      this.#o.log?.('main.doc_rejected', { reason: opened.ok ? 'chunks' : opened.reason });
      return;
    }
    const body = opened.core.body;
    const local = mine ?? bySha.get(body.sha256);
    if (local) {
      // 같은 내용이 이미 이 PC에 있다. 그 줄이 계정 사본을 아직 안 가졌으면 이 사본과 잇는다(다시 올리지 않게).
      if (local.docId === e.docId || !local.docId || local.state !== 'uploaded') {
        await this.#o.rpc('docs.mark', { id: local.id, state: 'uploaded', docId: e.docId, rev: e.rev, epoch: e.epoch });
        Object.assign(local, { docId: e.docId, state: 'uploaded', rev: e.rev, epoch: e.epoch });
        byDocId.set(e.docId, local);
        out.linked++;
      }
      return;
    }
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < e.chunks; i++) chunks.push(await this.#call(dev, (auth) => client.getChunk(auth, e.docId, i)));
    const dek = docKeyOf(body);
    try {
      const blob = openDocBlob(dek, e.docId, chunks, { bytes: body.bytes, sha256: body.sha256 });
      if (!blob.ok) {
        out.rejected++;
        this.#o.log?.('main.doc_rejected', { reason: `blob_${blob.reason}` });
        return;
      }
      const r = (await this.#o.rpc('docs.restore', {
        bytes: blob.bytes, docId: e.docId, rev: e.rev, epoch: e.epoch, origin: body.src, docType: body.docType, name: body.name, issuedOn: body.issuedOn, expiresOn: body.expiresOn,
      })) as { id?: unknown } | null;
      if (typeof r?.id === 'string') {
        const row: DocCloudRow = { id: r.id, name: body.name, docType: body.docType, issuedOn: body.issuedOn, expiresOn: body.expiresOn, bytes: body.bytes, sha256: body.sha256, origin: body.src, docId: e.docId, state: 'uploaded', rev: e.rev, epoch: e.epoch };
        byDocId.set(e.docId, row);
        bySha.set(body.sha256, row);
      }
      out.restored++;
    } finally {
      dek.fill(0);
    }
  }

  async #push(client: DocsClient, dev: ShareDevice, keys: Keys, out: DocSyncResult): Promise<void> {
    // 내려받기가 줄을 이었을 수 있으니 상태를 다시 읽는다.
    const st = cloudState(await this.#o.rpc('db.query.docs.cloud'));
    const todo = st.docs.filter((d) => !d.docId || d.state === 'pending' || d.state === 'failed').slice(0, PUSH_BATCH);
    for (const row of todo) {
      try {
        await this.#upload(client, dev, keys, row);
        out.pushed++;
      } catch (e) {
        const code = codeOf(e);
        if (STOP.has(code) || code.startsWith('net.') || code === 'account.unauthorized' || code === 'account.rate_limited') throw e;
        // 이 문서만의 문제(파일 없음, 모양, 서버가 거절한 상태). 다음 차례에 다시 본다.
        await this.#o.rpc('docs.mark', { id: row.id, state: 'failed', docId: row.docId }).catch(() => undefined);
        this.#o.log?.('main.doc_upload_skipped', { code });
        out.skipped++;
      }
    }
  }

  async #upload(client: DocsClient, dev: ShareDevice, keys: Keys, row: DocCloudRow): Promise<void> {
    let plain: Uint8Array;
    try {
      plain = await this.#o.readFile(row.id);
    } catch {
      throw new Stop('docs.read_failed');
    }
    if (plain.length !== row.bytes || plain.length > DOC_MAX_BYTES || sha256(plain) !== row.sha256) throw new Stop('docs.file_changed');
    const docId = row.docId && DOC_ID.test(row.docId) ? row.docId : newDocId();
    if (docId !== row.docId) {
      await this.#o.rpc('docs.mark', { id: row.id, state: 'pending', docId });
      row.docId = docId;
    }
    row.state = 'pending';
    const epoch = shareEpoch(dev.deviceList);
    const dek = newDocKey();
    try {
      const size = docBlobSize(plain.length);
      const core: DocRecordCore = {
        t: 'doc', v: 1, doc_id: docId, rev: 1, epoch, at: this.#now(), dev: dev.deviceId,
        body: {
          name: row.name.slice(0, 100), docType: row.docType, issuedOn: row.issuedOn, expiresOn: row.expiresOn, bytes: plain.length, sha256: row.sha256, dek: b64url(dek), chunks: size.chunks, src: row.origin,
        },
      };
      let wire;
      try {
        wire = await sealDocRecord(await keys.key(epoch), core, (m) => keys.sign(m));
      } catch (e) {
        if (e instanceof Error && /^docs: record /.test(e.message)) throw new Stop('docs.record_shape');
        throw e;
      }
      try {
        await this.#call(dev, (auth) => client.start(auth, docId, size));
      } catch (e) {
        // 앞 차례가 기록까지 올리고 장부에 적기 전에 끊겼다. 계정에는 이미 있다.
        if (codeOf(e) === 'account.doc_state') {
          await this.#o.rpc('docs.mark', { id: row.id, state: 'uploaded', docId, rev: 1, epoch });
          return;
        }
        throw e;
      }
      const chunks = sealDocBlob(dek, docId, plain);
      for (let i = 0; i < chunks.length; i++) await this.#call(dev, (auth) => client.putChunk(auth, docId, i, chunks[i]!));
      await this.#call(dev, (auth) => client.putRecord(auth, wire));
      await this.#o.rpc('docs.mark', { id: row.id, state: 'uploaded', docId, rev: 1, epoch });
      row.state = 'uploaded';
    } finally {
      dek.fill(0);
    }
  }
}
