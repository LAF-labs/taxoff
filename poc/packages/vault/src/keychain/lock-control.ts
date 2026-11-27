import { randomBytes } from 'node:crypto';
import type { EventLog, PortLike } from '@sax/platform';
import type { InboundMessage, RecoveryBind } from '../protocol.ts';
import type { HumanSecretVault } from './human.ts';
import type { UnlockFail, UnlockResult, UnlockScope } from './lockkey.ts';
import { newRecoveryCode, recoveryGroups, sealRecovery } from './recovery.ts';

/**
 * 잠금 화면과 설정 > 잠금이 부르는 control 메서드(lock.*)와 복구 코드 금고 창(ADR-061 결정 5, 7, 8).
 * 바이너리 값은 base64로 오간다. 사람 비밀(LK, 복구 코드, RK)은 control로 나가지 않는다. Se는 서버에 맡기는 조각이라 main이 올린다.
 */

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RKR_MAX = 200;
const RECOVERY_TTL_MS = 600_000;

const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
function bytes(v: unknown, min: number, max: number): Uint8Array {
  if (typeof v !== 'string' || !B64.test(v)) throw new Error('bad_params');
  const b = new Uint8Array(Buffer.from(v, 'base64'));
  if (b.length < min || b.length > max) throw new Error('bad_params');
  return b;
}
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !ID_RE.test(v)) throw new Error('bad_params');
  return v;
};

export interface LockControlOptions {
  human: HumanSecretVault;
  log: EventLog;
  aikPub: () => Promise<Uint8Array>;
  readRk: () => Promise<Uint8Array | null>;
  emit: (name: 'vault.state' | 'lock.recovery', data: Record<string, unknown>) => void;
  now?: () => number;
}

type Result = UnlockResult | { ok: false; reason: UnlockFail | 'needs_open' | 'no_identity' };

export class LockControl {
  private readonly o: LockControlOptions;
  private readonly now: () => number;
  private show: { reqId: string; code: string; rk: Uint8Array; blob: Uint8Array; shown: boolean; done: boolean; at: number } | null = null;
  private enter: { reqId: string; rkr: Uint8Array; at: number } | null = null;

  constructor(o: LockControlOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  private get lk() {
    return this.o.human.lk;
  }

  /** 열렸으면 세션을 열고 main에 알린다. */
  private async settle(r: UnlockResult): Promise<UnlockResult> {
    await this.o.human.opened(r);
    if (r.ok) this.o.emit('vault.state', { open: true, scope: r.scope });
    return r;
  }

  private openScreen(): boolean {
    const v = this.o.human.lock.check();
    return v.open && v.scope === 'screen';
  }

  async state(): Promise<Record<string, unknown>> {
    await this.o.human.ready();
    const s = await this.lk.state();
    const v = this.o.human.lock.check();
    return {
      ...s,
      open: v.open,
      scope: v.open ? v.scope : null,
      reason: v.open ? null : v.reason,
      localAvailable: await this.lk.localAvailable(),
    };
  }

  async handle(method: string, p: Record<string, unknown>): Promise<unknown> {
    await this.o.human.ready();
    switch (method) {
      case 'lock.state':
        return this.state();
      case 'lock.identity': {
        if (!this.lk.isOpen) return { result: 'needs_open' };
        return { result: await this.lk.setIdentity(id(p.deviceId), await this.o.aikPub()) };
      }
      case 'lock.openLocal': {
        const task = typeof p.reason === 'string' ? p.reason.slice(0, 60) : '';
        return this.settle(await this.lk.unlockLocal({ task, portal: '' }));
      }
      case 'lock.setLocal': {
        if (typeof p.on !== 'boolean') throw new Error('bad_params');
        if (!this.openScreen()) return { ok: false, reason: 'needs_open' };
        await this.lk.setLocal(p.on);
        return { ok: true };
      }
      case 'lock.now':
        return this.o.human.lock.lockNow();
      case 'lock.addPhone': {
        const phoneId = id(p.phoneId);
        const uxPub = bytes(p.uxPub, 65, 65);
        if (await this.lk.phoneKeyIs(phoneId, uxPub).catch(() => false)) return { state: 'enrolled' };
        if (!this.lk.isOpen) return { state: 'needs_open' };
        await this.lk.addPhone(phoneId, uxPub);
        return { state: 'enrolled' };
      }
      case 'lock.removePhone':
        return { removed: await this.lk.removePhone(id(p.phoneId)) };
      case 'lock.phoneRequest': {
        const scope: UnlockScope = p.scope === 'remote' ? 'remote' : 'screen';
        const r = await this.lk.phoneRequest(id(p.phoneId), scope).catch((e: Error) => ({ ok: false as const, reason: e.message === 'no_identity' ? ('no_identity' as const) : ('no_copy' as const) }));
        if (!r.ok) return r;
        const q = r.request;
        return { ok: true, body: { unlockId: q.reqId, unlockE: b64(q.e), txPub: b64(q.txPub), unlockN: b64(q.n), exp: q.exp, scope: q.scope } };
      }
      case 'lock.phoneAnswer': {
        const unlockId = typeof p.unlockId === 'string' ? p.unlockId.slice(0, 64) : '';
        if (p.decision === 'deny') {
          this.lk.phoneDeclined(unlockId);
          return { ok: false, reason: 'declined_pause' };
        }
        if (p.decision !== 'open') throw new Error('bad_params');
        return this.settle(await this.lk.phoneGrant({ reqId: unlockId, enc: bytes(p.grantEnc, 32, 32), ct: bytes(p.grantCt, 48, 48) }));
      }
      case 'lock.emailShare': {
        if (!this.openScreen()) return { ok: false, reason: 'needs_open' };
        return { ok: true, se: b64(await this.lk.setEmail()) };
      }
      case 'lock.emailClear':
        await this.lk.clearEmail();
        return { ok: true };
      case 'lock.emailBegin':
        return { tx: b64(this.lk.emailBegin()) };
      case 'lock.emailOpen': {
        const r = await this.lk.unlockEmailSealed(bytes(p.enc, 32, 32), bytes(p.ct, 48, 48));
        await this.settle(r);
        return r.ok ? { ok: true, scope: r.scope, nextShare: r.nextShare ? b64(r.nextShare) : null } : r;
      }
      case 'lock.recoveryBegin':
        return this.recoveryBegin();
      case 'lock.recoveryCommit':
        return this.recoveryCommit(String(p.reqId));
      case 'lock.recoveryArm': {
        const rkr = bytes(p.blob, 33, RKR_MAX);
        const reqId = randomBytes(16).toString('hex');
        this.enter = { reqId, rkr, at: this.now() };
        return { reqId };
      }
    }
    throw new Error('not_implemented');
  }

  private async recoveryBegin(): Promise<Result | { ok: true; reqId: string }> {
    if (!this.openScreen()) return { ok: false, reason: 'needs_open' };
    const rk = await this.o.readRk();
    if (!rk) return { ok: false, reason: 'no_identity' };
    this.dropShow();
    const code = newRecoveryCode();
    const reqId = randomBytes(16).toString('hex');
    this.show = { reqId, code, rk, blob: sealRecovery(code, rk), shown: false, done: false, at: this.now() };
    return { ok: true, reqId };
  }

  /** 서버에 RKr을 올린 뒤에만 이 PC 복구 코드 사본을 만든다(서버에 없는 코드로는 열 수 없다). */
  private async recoveryCommit(reqId: string): Promise<{ ok: boolean }> {
    const s = this.show;
    if (!s || s.reqId !== reqId || !s.done) return { ok: false };
    try {
      await this.lk.setRecovery(s.rk);
    } finally {
      this.dropShow();
    }
    return { ok: true };
  }

  private dropShow(): void {
    this.show?.rk.fill(0);
    this.show = null;
  }

  hasRecovery(b: RecoveryBind): boolean {
    const live = (x: { reqId: string; at: number } | null) => !!x && x.reqId === b.reqId && this.now() - x.at < RECOVERY_TTL_MS;
    return b.mode === 'recovery_show' ? live(this.show) : live(this.enter);
  }

  /** 금고 창 하나와 주고받는다. 보여 주기 창은 코드를 한 번만 받는다. */
  async onWindow(port: PortLike, b: RecoveryBind, msg: InboundMessage): Promise<void> {
    if (msg?.t !== 'rpc') return;
    const reply = (result: unknown) => port.postMessage({ t: 'rpc', id: msg.id, result });
    const fail = (error: string) => port.postMessage({ t: 'rpc', id: msg.id, error });
    if (!this.hasRecovery(b)) return fail('expired');
    const s = this.show;
    if (b.mode === 'recovery_show' && s) {
      if (msg.method === 'recovery.show' && !s.shown) {
        s.shown = true;
        return reply({ groups: recoveryGroups(s.code) });
      }
      if (msg.method === 'recovery.done' && s.shown && !s.done) {
        s.done = true;
        this.o.emit('lock.recovery', { reqId: s.reqId, blob: b64(s.blob) });
        return reply({ ok: true });
      }
      return fail('denied');
    }
    const e = this.enter;
    if (b.mode === 'recovery_enter' && e && msg.method === 'recovery.enter') {
      const code = typeof msg.params?.code === 'string' ? msg.params.code.slice(0, 64) : '';
      const r = await this.settle(await this.lk.unlockRecoveryCode(code, e.rkr).catch(() => ({ ok: false as const, reason: 'wrong' as const })));
      if (r.ok) this.enter = null;
      return reply(r.ok ? { ok: true } : { ok: false, reason: r.reason });
    }
    return fail('denied');
  }
}
