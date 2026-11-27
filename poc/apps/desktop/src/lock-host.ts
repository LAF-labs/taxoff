import fs from 'node:fs';
import type { UnlockGrantBody, UnlockRequestBody, UxAckBody, UxEnrollBody } from '@sax/remote';

/**
 * PC 잠금 화면 뒤의 main 쪽(ADR-061 결정 5, 6, 7). 금고의 lock.* 메서드를 부르고, 폰과 풀기 요청과 답을 주고받고, 렌더러에 화면 상태를 준다.
 * 열쇠와 비밀은 여기를 지나지 않는다. 폰과의 통로에는 금고가 만든 요청과 폰의 봉인된 답만 오간다.
 */

/** 폰이 답하지 않는다고 보는 시간(요청의 exp와 같다). */
export const LOCK_PHONE_QUIET_MS = 60_000;

export type LockStep = 'start' | 'phone' | 'quiet' | 'declined' | 'other' | 'email_code';

/** 렌더러 잠금 화면이 그리는 값. 기기 번호와 오류 코드는 없다. */
export interface LockView {
  locked: boolean;
  step: LockStep;
  /** 이 PC 생체인식으로 열 수 있으면 그 이름. */
  local: 'Touch ID' | 'Windows Hello' | null;
  phone: string | null;
  phoneKind: 'ios' | 'android' | null;
  declinedUntil: number;
  email: string | null;
  recovery: boolean;
  busy: boolean;
  wrong: 'code' | 'paused' | null;
}

export interface LockSettingsView {
  local: { name: 'Touch ID' | 'Windows Hello'; on: boolean } | null;
  phones: Array<{ pairId: string; name: string; kind: 'Face ID' | '지문'; on: boolean }>;
  email: boolean | null;
  recovery: boolean | null;
}

interface VaultLockState {
  exists: boolean;
  open: boolean;
  scope: 'screen' | 'remote' | null;
  phones: string[];
  local: boolean;
  localOff: boolean;
  localAvailable: boolean;
  email: boolean;
  recovery: boolean;
  guarded: boolean;
  declinedUntil: number;
}

export interface LockPhone {
  pairId: string;
  deviceId: string;
  name: string;
  platform: 'ios' | 'android';
  online: boolean;
  lastSeenAt: number | null;
  /** 설정 > 잠금에서 이 폰으로 여는 것을 껐다. */
  off: boolean;
}

export interface UnlockCloud {
  email: string;
  putShare(se: string): Promise<void>;
  deleteShare(): Promise<void>;
  startEmail(): Promise<{ unlockId: string }>;
  finishEmail(x: { unlockId: string; code: string; Tx: string }): Promise<{ enc: string; ct: string }>;
  putRecovery(blob: string): Promise<void>;
  recovery(): Promise<{ blob: string }>;
}

export interface LockHostPorts {
  control: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  phones: () => LockPhone[];
  uxOwner: (pairId: string, body: UxEnrollBody) => string | null;
  wake: (pairId: string) => Promise<string>;
  cloud: () => UnlockCloud | null;
  platform: NodeJS.Platform;
  /** 렌더러에 새 상태를 보낸다. */
  push: (view: LockView) => void;
  /** 복구 코드 금고 창을 띄운다. 창이 닫히면 resolve. */
  recoveryWindow: (mode: 'recovery_show' | 'recovery_enter', reqId: string) => Promise<void>;
  log: (name: string, data?: Record<string, string | number | boolean>) => void;
  /** 사람이 화면까지 금고를 열었다(앱을 켜고 처음 본 열린 상태 포함). 월 리포트 자동 받기가 듣는다. */
  screenOpened?: () => void;
  /** 메인 창이 보이나. 창이 숨어 있을 때는 Touch ID 창을 띄우지 않고 창이 보일 때 묻는다. 없으면 언제나 보인다고 본다. */
  visible?: () => boolean;
  emailOff?: { get(): boolean; set(off: boolean): void };
  now?: () => number;
}

export const EMAIL_SHARE_RETRY_MS = 30 * 60_000;

interface Pending {
  unlockId: string;
  pairId: string;
  scope: 'screen' | 'remote';
  body: UnlockRequestBody;
  sent: boolean;
  timer: ReturnType<typeof setTimeout>;
  done: (opened: boolean) => void;
}

type ControlResult = { ok?: boolean; reason?: string };

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

export class LockHost {
  readonly #o: LockHostPorts;
  #s: VaultLockState | null = null;
  #step: LockStep = 'start';
  #busy = false;
  #wrong: LockView['wrong'] = null;
  #pending: Pending | null = null;
  #emailId: string | null = null;
  #asked = false;
  #wantId: string | null = null;
  #idDone = false;
  #emailRetryAt = 0;
  readonly #live = new Map<string, (type: 'unlock.request', body: object) => void>();

  constructor(o: LockHostPorts) {
    this.#o = o;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  get locked(): boolean {
    const s = this.#s;
    return !!s && s.guarded && !(s.open && s.scope === 'screen');
  }

  /** 금고가 열려 있다(화면이든 폰이 맡긴 일이든). */
  get open(): boolean {
    return !!this.#s?.open;
  }

  #localName(): LockView['local'] {
    const s = this.#s;
    if (!s?.local || !s.localAvailable) return null;
    return this.#o.platform === 'win32' ? 'Windows Hello' : 'Touch ID';
  }

  /** 풀기 사본이 있는 폰 가운데 지금 붙어 있는 폰, 없으면 마지막에 본 폰. */
  #phone(): LockPhone | null {
    const ids = new Set(this.#s?.phones ?? []);
    const xs = this.#o.phones().filter((p) => ids.has(p.deviceId) && !p.off);
    return xs.find((p) => p.online) ?? xs.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0))[0] ?? null;
  }

  view(): LockView {
    const s = this.#s;
    const cloud = this.#o.cloud();
    const phone = this.#phone();
    return {
      locked: this.locked,
      step: this.#step,
      local: this.#localName(),
      phone: phone?.name ?? null,
      phoneKind: phone?.platform ?? null,
      declinedUntil: s?.declinedUntil ?? 0,
      email: s?.email && cloud ? cloud.email : null,
      recovery: !!s?.recovery && !!cloud,
      busy: this.#busy,
      wrong: this.#wrong,
    };
  }

  settingsView(): LockSettingsView {
    const s = this.#s;
    const ids = new Set(s?.phones ?? []);
    const cloud = this.#o.cloud();
    return {
      local: s?.localAvailable || s?.local ? { name: this.#o.platform === 'win32' ? 'Windows Hello' : 'Touch ID', on: !!s?.local } : null,
      phones: this.#o.phones().map((p) => ({ pairId: p.pairId, name: p.name, kind: p.platform === 'ios' ? 'Face ID' : '지문', on: !p.off && ids.has(p.deviceId) })),
      email: cloud ? !!s?.email : null,
      recovery: cloud ? !!s?.recovery : null,
    };
  }

  #push(): void {
    this.#o.push(this.view());
  }

  async refresh(): Promise<LockView> {
    const was = this.locked;
    const wasScreen = !!this.#s?.open && this.#s.scope === 'screen';
    this.#s = (await this.#o.control('lock.state')) as VaultLockState;
    if (!wasScreen && this.#s?.open && this.#s.scope === 'screen') this.#o.screenOpened?.();
    if (!this.locked) {
      this.#step = 'start';
      this.#asked = false;
      this.#wrong = null;
      this.#clearPending(true);
    } else if (!was) this.#step = 'start';
    this.#push();
    this.#ensureEmail();
    return this.view();
  }

  /** 잠금 화면이 보일 때 한 번: 생체인식이 되면 바로 묻고, 안 되면 바로 폰에 보낸다. 취소하면 단추로 다시 연다. */
  async greet(): Promise<void> {
    if (!this.locked || this.#asked || this.#busy || this.#o.visible?.() === false) return;
    this.#asked = true;
    if (this.#localName()) await this.openLocal();
    else if (this.#phone()) await this.askPhone();
  }

  /** 메인 창이 숨었다. 다음에 창이 보이면 다시 묻는다. */
  hidden(): void {
    if (!this.#busy) this.#asked = false;
  }

  async onVaultState(): Promise<void> {
    await this.refresh();
    if (this.#wantId && this.#s?.open) await this.identity(this.#wantId);
  }

  /** 이 PC를 계정에 연결했다. 금고가 사본을 이 기기 번호와 계정에 묶는다. 잠겨 있으면 열린 뒤에 한다. */
  async identity(deviceId: string): Promise<void> {
    if (this.#wantId === deviceId && this.#idDone) return;
    this.#wantId = deviceId;
    const r = (await this.#o.control('lock.identity', { deviceId }).catch(() => null)) as { result?: string } | null;
    if (r?.result === 'needs_open') return;
    this.#idDone = !!r?.result;
    this.#o.log('main.lock_identity', { result: r?.result ?? 'error' });
    if (r?.result === 'set' || r?.result === 'replaced') await this.#shareEmail();
    else this.#ensureEmail();
  }

  #ensureEmail(): void {
    const s = this.#s;
    if (!this.#idDone || !s?.open || s.scope !== 'screen' || s.email || this.#o.emailOff?.get() || !this.#o.cloud()) return;
    const now = this.#now();
    if (now < this.#emailRetryAt) return;
    this.#emailRetryAt = now + EMAIL_SHARE_RETRY_MS;
    void this.#shareEmail().then((ok) => (ok ? this.refresh() : null), () => this.#o.log('main.lock_email', { step: 'share', result: 'error' }));
  }

  async #run<T>(fn: () => Promise<T>): Promise<T | null> {
    if (this.#busy) return null;
    this.#busy = true;
    this.#push();
    try {
      return await fn();
    } finally {
      this.#busy = false;
      await this.refresh().catch(() => this.#push());
    }
  }

  async openLocal(): Promise<boolean> {
    const r = await this.#run(() => this.#o.control('lock.openLocal', { reason: '잠금을 풀어요' }) as Promise<ControlResult>);
    this.#o.log('main.lock_open', { via: 'local', result: r?.ok ? 'ok' : (r?.reason ?? 'busy') });
    return !!r?.ok;
  }

  async lockNow(): Promise<void> {
    await this.#o.control('lock.now');
    await this.refresh();
  }

  setStep(step: 'start' | 'other'): void {
    if (!this.locked) return;
    this.#step = step;
    this.#wrong = null;
    this.#push();
  }

  /* 폰 */

  attach(pairId: string, send: (type: 'unlock.request', body: object) => void): void {
    this.#live.set(pairId, send);
    const p = this.#pending;
    if (p && p.pairId === pairId && !p.sent && this.#now() < p.body.exp) {
      send('unlock.request', p.body);
      p.sent = true;
      this.#o.log('main.lock_phone', { step: 'sent_on_attach' });
    }
  }

  detach(pairId: string): void {
    this.#live.delete(pairId);
  }

  #clearPending(opened: boolean): void {
    const p = this.#pending;
    if (!p) return;
    this.#pending = null;
    clearTimeout(p.timer);
    p.done(opened);
  }

  /** 폰에 풀기 요청을 보낸다. 통로가 닫혀 있으면 푸시로 깨우고, 폰이 붙으면 그때 보낸다. */
  async #request(phone: LockPhone, scope: 'screen' | 'remote'): Promise<boolean> {
    const r = (await this.#o.control('lock.phoneRequest', { phoneId: phone.deviceId, scope })) as { ok: boolean; reason?: string; body?: UnlockRequestBody };
    if (!r.ok || !r.body) {
      this.#o.log('main.lock_phone', { step: 'request', result: r.reason ?? 'error' });
      if (r.reason === 'declined_pause' && scope === 'screen' && this.#step === 'phone') this.#step = 'declined';
      return false;
    }
    this.#clearPending(false);
    const body = r.body;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        if (this.#pending?.unlockId !== body.unlockId) return;
        this.#pending = null;
        resolve(false);
        this.#o.log('main.lock_phone', { step: 'quiet', scope });
        if (scope === 'screen' && this.locked && this.#step === 'phone') {
          this.#step = 'quiet';
          this.#push();
        }
      }, Math.max(0, body.exp - this.#now()));
      this.#pending = { unlockId: body.unlockId, pairId: phone.pairId, scope, body, sent: false, timer, done: resolve };
      const send = this.#live.get(phone.pairId);
      if (send) {
        send('unlock.request', body);
        this.#pending.sent = true;
        this.#o.log('main.lock_phone', { step: 'sent', scope });
      } else
        void this.#o.wake(phone.pairId).then((w) => this.#o.log('main.lock_phone', { step: 'wake', scope, result: w }));
    });
  }

  async askPhone(): Promise<void> {
    const phone = this.#phone();
    if (!this.locked || !phone) return;
    this.#step = 'phone';
    this.#wrong = null;
    this.#push();
    void this.#request(phone, 'screen').then(() => this.locked && this.#push());
  }

  async grant(pairId: string, body: UnlockGrantBody): Promise<void> {
    const p = this.#pending;
    if (!p || p.pairId !== pairId || p.unlockId !== body.unlockId) {
      this.#o.log('main.lock_phone', { step: 'grant', result: 'unknown' });
      return;
    }
    const r = (await this.#o.control('lock.phoneAnswer', body as unknown as Record<string, unknown>).catch(() => ({ ok: false, reason: 'error' }))) as ControlResult;
    this.#o.log('main.lock_phone', { step: 'grant', decision: body.decision, result: r.ok ? 'ok' : (r.reason ?? 'error') });
    if (this.#pending === p) {
      this.#pending = null;
      clearTimeout(p.timer);
      p.done(!!r.ok);
    }
    if (body.decision === 'deny' && p.scope === 'screen' && this.#step === 'phone') this.#step = 'declined';
    await this.refresh();
  }

  /** 잠긴 PC에 폰이 일을 맡겼다: 그 폰에 원격 풀기(scope remote)를 묻고 답을 기다린다. 화면은 잠긴 그대로다. */
  async remote(pairId: string): Promise<boolean> {
    await this.refresh().catch(() => null);
    if (!this.#s?.guarded || this.#s.open) return true;
    const phone = this.#o.phones().find((p) => p.pairId === pairId);
    if (!phone || !this.#s.phones.includes(phone.deviceId)) return false;
    return this.#request(phone, 'remote');
  }

  async enroll(pairId: string, body: UxEnrollBody): Promise<UxAckBody> {
    const deviceId = typeof body?.uxPub === 'string' && B64.test(body.uxPub) ? this.#o.uxOwner(pairId, body) : null;
    if (!deviceId) {
      this.#o.log('main.lock_ux', { result: 'rejected' });
      return { state: 'rejected' };
    }
    const r = (await this.#o.control('lock.addPhone', { phoneId: deviceId, uxPub: body.uxPub }).catch(() => ({ state: 'rejected' }))) as UxAckBody;
    this.#o.log('main.lock_ux', { result: r.state });
    await this.refresh().catch(() => null);
    return r;
  }

  async removePhone(deviceId: string): Promise<void> {
    await this.#o.control('lock.removePhone', { phoneId: deviceId }).catch(() => this.#o.log('main.lock_ux', { result: 'remove_failed' }));
    await this.refresh().catch(() => null);
  }

  /* 설정 > 잠금 */

  async setLocal(on: boolean): Promise<boolean> {
    const r = (await this.#o.control('lock.setLocal', { on })) as ControlResult;
    await this.refresh();
    return !!r.ok;
  }

  async #shareEmail(): Promise<boolean> {
    const cloud = this.#o.cloud();
    if (!cloud) return false;
    const r = (await this.#o.control('lock.emailShare')) as { ok: boolean; se?: string };
    if (!r.ok || !r.se) return false;
    try {
      await cloud.putShare(r.se);
      this.#o.log('main.lock_email', { step: 'share', result: 'ok' });
      return true;
    } catch (e) {
      await this.#o.control('lock.emailClear');
      this.#o.log('main.lock_email', { step: 'share', result: (e as { code?: string }).code ?? 'error' });
      return false;
    }
  }

  async setEmail(on: boolean): Promise<boolean> {
    this.#o.emailOff?.set(!on);
    const ok = on
      ? await this.#shareEmail()
      : await this.#o.control('lock.emailClear').then(async () => {
          await this.#o.cloud()?.deleteShare().catch(() => this.#o.log('main.lock_email', { step: 'delete', result: 'error' }));
          return true;
        });
    await this.refresh();
    return ok;
  }

  /** 복구 코드를 새로 만든다: 금고 창이 코드를 보이고, [다 적었어요] 뒤 서버에 RKr을 올리고 나서야 이 PC 사본을 바꾼다. */
  async makeRecovery(): Promise<boolean> {
    const cloud = this.#o.cloud();
    if (!cloud) return false;
    const r = (await this.#o.control('lock.recoveryBegin')) as { ok: boolean; reqId?: string };
    if (!r.ok || !r.reqId) return false;
    await this.#o.recoveryWindow('recovery_show', r.reqId);
    return true;
  }

  async onRecoveryReady(data: { reqId?: unknown; blob?: unknown }): Promise<void> {
    const cloud = this.#o.cloud();
    if (!cloud || typeof data.reqId !== 'string' || typeof data.blob !== 'string') return;
    try {
      await cloud.putRecovery(data.blob);
      await this.#o.control('lock.recoveryCommit', { reqId: data.reqId });
      this.#o.log('main.lock_recovery', { step: 'set', result: 'ok' });
    } catch (e) {
      this.#o.log('main.lock_recovery', { step: 'set', result: (e as { code?: string }).code ?? 'error' });
    }
    await this.refresh();
  }

  /* 다른 방법(잠긴 화면) */

  async startEmail(): Promise<void> {
    const cloud = this.#o.cloud();
    if (!cloud || !this.locked) return;
    await this.#run(async () => {
      try {
        this.#emailId = (await cloud.startEmail()).unlockId;
        this.#step = 'email_code';
        this.#o.log('main.lock_email', { step: 'code', result: 'sent' });
      } catch (e) {
        this.#o.log('main.lock_email', { step: 'code', result: (e as { code?: string }).code ?? 'error' });
      }
    });
  }

  async finishEmail(code: string): Promise<boolean> {
    const cloud = this.#o.cloud();
    const unlockId = this.#emailId;
    if (!cloud || !unlockId || !/^\d{6}$/.test(code)) return false;
    const r = await this.#run(async () => {
      const { tx } = (await this.#o.control('lock.emailBegin')) as { tx: string };
      let sealed: { enc: string; ct: string };
      try {
        sealed = await cloud.finishEmail({ unlockId, code, Tx: tx });
      } catch (e) {
        this.#wrong = 'code';
        this.#o.log('main.lock_email', { step: 'verify', result: (e as { code?: string }).code ?? 'error' });
        return false;
      }
      const o = (await this.#o.control('lock.emailOpen', sealed)) as { ok: boolean; reason?: string; nextShare?: string | null };
      this.#o.log('main.lock_email', { step: 'open', result: o.ok ? 'ok' : (o.reason ?? 'error') });
      if (!o.ok) {
        this.#wrong = o.reason === 'paused' ? 'paused' : 'code';
        return false;
      }
      this.#emailId = null;
      if (o.nextShare) await cloud.putShare(o.nextShare).catch(() => this.#o.log('main.lock_email', { step: 'reshare', result: 'error' }));
      return true;
    });
    return !!r;
  }

  async enterRecovery(): Promise<void> {
    const cloud = this.#o.cloud();
    if (!cloud || !this.locked) return;
    let blob: string;
    try {
      blob = (await cloud.recovery()).blob;
    } catch (e) {
      this.#o.log('main.lock_recovery', { step: 'fetch', result: (e as { code?: string }).code ?? 'error' });
      return;
    }
    const r = (await this.#o.control('lock.recoveryArm', { blob })) as { reqId: string };
    await this.#o.recoveryWindow('recovery_enter', r.reqId);
    await this.refresh();
  }
}

export function lockEmailOffFile(file: string): { get(): boolean; set(off: boolean): void } {
  return {
    get: () => fs.existsSync(file),
    set: (off) => (off ? fs.writeFileSync(file, '', { mode: 0o600 }) : fs.rmSync(file, { force: true })),
  };
}
