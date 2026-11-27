import { SESSION_IDLE_STALE_MS, UNLOCK_RUN_WINDOW_SEC, type SessionEventKind, type VaultLockReason } from '../protocol.ts';
import type { UnlockScope } from './lockkey.ts';

export const VAULT_IDLE_LOCK_SEC = 900;
export const VAULT_UNLOCK_MAX_SEC = 28_800;
/** 폰이 맡긴 일로만 연 금고(scope remote)가 마지막 일이 끝난 뒤 열려 있는 시간. */
export const VAULT_REMOTE_LINGER_SEC = 600;

export interface SessionLockOptions {
  now?: () => number;
  idleLockSec?: number;
  unlockMaxSec?: number;
  remoteLingerSec?: number;
  idleStaleMs?: number;
  unlockRunSec?: number;
}

export type OpenVerdict = { open: true; scope: UnlockScope } | { open: false; reason: VaultLockReason };

/**
 * 금고를 언제 닫을지 정한다(ADR-061 결정 5, 6). 여는 일은 사람 확인(이 PC 생체인식, 폰, 이메일, 복구 코드)을 거친 opened()뿐이다.
 * OS 잠금을 풀어도 다시 열지 않는다.
 * - screen: 앱 화면까지 연 것. OS 화면 잠금, 잠자기, 사용자 전환, 15분 유휴, 유휴 보고가 끊김, 8시간에 닫는다.
 * - remote: 폰이 맡긴 일에만 금고를 연 것. PC 앞 사람의 유휴와 OS 잠금과 상관없고, 마지막 일이 끝나고 10분 뒤나 8시간에 닫는다.
 * guarded가 false면(다시 열 사본이 없다) 닫지 않는다.
 */
export class SessionLock {
  private readonly now: () => number;
  private readonly idleLockSec: number;
  private readonly unlockMaxSec: number;
  private readonly remoteLingerMs: number;
  private readonly idleStaleMs: number;
  private readonly unlockRunMs: number;
  /** 사람이 화면까지 연 때. 그 뒤 unlock 실행 한 번에 쓴다(ADR-068 결정 6) */
  private screenOpenedAt = 0;
  private unlockRunTaken = true;
  private scope: UnlockScope | null = null;
  private openedAt = 0;
  private sessionOpen = true;
  private idle: { sec: number; at: number } | null = null;
  private readonly runs = new Set<string>();
  private remoteUntil = 0;
  private reason: VaultLockReason = 'startup';
  guarded: () => boolean = () => true;
  onLock: (reason: VaultLockReason) => void = () => {};

  constructor(opts: SessionLockOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.idleLockSec = opts.idleLockSec ?? VAULT_IDLE_LOCK_SEC;
    this.unlockMaxSec = opts.unlockMaxSec ?? VAULT_UNLOCK_MAX_SEC;
    this.remoteLingerMs = (opts.remoteLingerSec ?? VAULT_REMOTE_LINGER_SEC) * 1000;
    this.idleStaleMs = opts.idleStaleMs ?? SESSION_IDLE_STALE_MS;
    this.unlockRunMs = (opts.unlockRunSec ?? UNLOCK_RUN_WINDOW_SEC) * 1000;
  }

  private idleSec(t: number): number {
    return this.idle ? this.idle.sec + (t - this.idle.at) / 1000 : Number.POSITIVE_INFINITY;
  }

  private due(t: number): VaultLockReason | null {
    if (t - this.openedAt >= this.unlockMaxSec * 1000) return 'max_open';
    if (this.scope === 'remote') return this.runs.size === 0 && t >= this.remoteUntil ? 'remote_done' : null;
    if (!this.sessionOpen) return 'session_locked';
    if (!this.idle || t - this.idle.at > this.idleStaleMs) return 'idle_unknown';
    if (this.idleSec(t) >= this.idleLockSec) return 'idle';
    return null;
  }

  private close(reason: VaultLockReason): void {
    this.scope = null;
    this.unlockRunTaken = true;
    this.reason = reason;
    this.onLock(reason);
  }

  check(): OpenVerdict {
    if (this.scope && this.guarded()) {
      const why = this.due(this.now());
      if (why) this.close(why);
    }
    return this.scope ? { open: true, scope: this.scope } : { open: false, reason: this.reason };
  }

  /** 사람 확인을 거쳐 열렸다. 화면까지 연 것(screen)은 원격으로만 연 것(remote)을 넓힌다. */
  opened(scope: UnlockScope): OpenVerdict {
    const t = this.now();
    if (this.scope !== 'screen' || scope === 'screen') this.scope = scope;
    this.openedAt = t;
    if (scope === 'screen') {
      this.sessionOpen = true;
      this.idle = { sec: 0, at: t };
      this.screenOpenedAt = t;
      this.unlockRunTaken = false;
    } else this.remoteUntil = t + this.remoteLingerMs;
    return this.check();
  }

  /**
   * unlock 실행을 시작해도 되는가. 화면까지 연 금고가 지금도 열려 있고, 그 잠금 풀기에서 120초 안이며, 그 풀기로 아직 받은 적이 없을 때 한 번만 true다.
   * 폰이 맡긴 일로만 연 금고(remote)와 OS 잠금 풀기는 사람이 앱 앞에 있다는 뜻이 아니라 세지 않는다.
   */
  takeUnlockRun(): boolean {
    const v = this.check();
    if (!v.open || v.scope !== 'screen' || this.unlockRunTaken || this.now() - this.screenOpenedAt > this.unlockRunMs) return false;
    this.unlockRunTaken = true;
    return true;
  }

  lockNow(): OpenVerdict {
    if (this.scope && this.guarded()) this.close('user');
    return this.check();
  }

  sessionEvent(kind: SessionEventKind): OpenVerdict {
    switch (kind) {
      case 'lock-screen':
      case 'suspend':
      case 'session-switch':
      case 'remote-switch':
        this.sessionOpen = false;
        break;
      case 'unlock-screen':
        this.sessionOpen = true;
        this.idle = { sec: 0, at: this.now() };
        break;
      case 'resume':
        break;
    }
    return this.check();
  }

  /** 유휴 보고가 끊겼던 사이에 닫을 때가 지났으면 새 보고가 와도 닫는다. */
  reportIdle(idleSec: number): OpenVerdict {
    if (!Number.isFinite(idleSec) || idleSec < 0) return this.check();
    this.check();
    this.idle = { sec: idleSec, at: this.now() };
    return this.check();
  }

  runBegan(runId: string): void {
    this.runs.add(runId);
  }

  runEnded(runId: string): void {
    if (this.runs.delete(runId) && this.runs.size === 0) this.remoteUntil = this.now() + this.remoteLingerMs;
    this.check();
  }
}
