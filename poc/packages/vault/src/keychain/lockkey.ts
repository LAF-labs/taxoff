import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import { aikSeedFromRk, ed25519FromSeed, hpkeOpenBase, x25519FromSeed } from '../crypto/ops.ts';
import { open, seal, type HelloPrompt, type KeychainBackend } from './backend.ts';
import { normalizeRecoveryCode, openRecovery } from './recovery.ts';

/**
 * PC 잠금 열쇠(LK)와 그 사본들(ADR-061 결정 5, 7).
 *
 * LK는 PC마다 하나인 32바이트 값이고, 열려 있는 동안만 금고 메모리에 있다. 디스크에는 사본(봉인문)만 있다.
 * - 폰 사본: 폰 보안칩 키 Ux의 공개키로 봉인한다. 폰은 생체 확인 뒤 ECDH 결과(Z)만 돌려주고, 봉인문은 PC를 떠나지 않는다.
 * - 이 PC 사본: Touch ID나 Windows Hello(HelloProvider)로만 풀린다.
 * - 이메일 사본: 서버가 가진 조각(Se)과 이 PC의 기기 결박(KekWrapper)이 함께 있어야 풀린다.
 * - 복구 코드 사본: 계정 열쇠(RK)에서 뽑은 키로 봉인한다. RK는 복구 코드로 서버의 암호문을 열어 얻는다.
 * 서버 혼자 풀리는 사본은 없다.
 *
 * 처음 만든 LK는 위 사본이 하나라도 생길 때까지 기기 결박만으로 풀리는 첫 사본(lk/device)을 둔다. 그동안은 잠그지 않는다(열 길이 없다).
 * 사본이 생기면 첫 사본을 지운다.
 */

export const LK_BYTES = 32;
export const UNLOCK_INFO = 'SAX-unlock-v1';
export const UNLOCK_GRANT_INFO = 'SAX-unlock-grant-v1';
export const UNLOCK_EMAIL_INFO = 'SAX-unlock-email-v1';
export const LOCK_RECOVERY_INFO = 'SAX-lock-recovery-v1';
/** 서버가 이메일 숫자를 확인하고 Se를 봉인해 줄 때의 HPKE info(services/account UNLOCK_EMAIL_INFO와 같다). */
export const UNLOCK_EMAIL_SEAL_INFO = 'SAX-unlock-email-seal-v1';

/** 서버 봉인의 AAD: SHA-256(info ‖ 0x00 ‖ utf8(deviceId) ‖ 0x00 ‖ Tx). */
export const unlockEmailSealAad = (pcDeviceId: string, txPub: Uint8Array): Uint8Array => sha256(enc.encode(UNLOCK_EMAIL_SEAL_INFO), Uint8Array.of(0), enc.encode(pcDeviceId), Uint8Array.of(0), txPub);
/** 폰에 보낸 풀기 요청이 살아 있는 시간. */
export const UNLOCK_REQUEST_TTL_MS = 60_000;
/** 풀기 요청 상한: 이 시간 안에 이 횟수까지(졸라서 누르게 하는 공격을 줄인다). */
export const UNLOCK_REQUEST_WINDOW_MS = 600_000;
export const UNLOCK_REQUEST_MAX = 3;
/** 폰이 거절한 뒤 다시 묻지 않는 시간. */
export const UNLOCK_DECLINE_PAUSE_MS = 300_000;
/** 복구 코드(RK)와 이메일 조각이 틀린 횟수 상한과 막는 시간. */
export const UNLOCK_WRONG_MAX = 5;
export const UNLOCK_WRONG_PAUSE_MS = 3_600_000;
export const PHONE_COPY_MAX = 3;

export type UnlockScope = 'screen' | 'remote';
export type UnlockVia = 'phone' | 'local' | 'email' | 'recovery' | 'device';

const P256_POINT = 65;
const ITEM_META = 'lk/meta';
const ITEM_LOCAL = 'lk/local';
const ITEM_EMAIL = 'lk/email';
const ITEM_RECOVERY = 'lk/recovery';
const ITEM_DEVICE = 'lk/device';
const phoneItem = (id: string) => `lk/phone/${id}`;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

const enc = new TextEncoder();
const cat = (...xs: Uint8Array[]) => new Uint8Array(Buffer.concat(xs));
const i2osp = (n: number, len: number) => {
  const b = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--, n = Math.floor(n / 256)) b[i] = n & 0xff;
  return b;
};
/** 길이를 앞에 붙인 조각(이어 붙인 값의 경계가 흐려지지 않게 한다). */
const lp = (s: string) => {
  const b = enc.encode(s);
  return cat(i2osp(b.length, 2), b);
};
const sha256 = (...xs: Uint8Array[]) => new Uint8Array(createHash('sha256').update(cat(...xs)).digest());

/* RFC 9180 Base 모드, DHKEM(P-256, HKDF-SHA256) 0x0010, HKDF-SHA256 0x0001, AES-256-GCM 0x0002, seq 0. */
const KEM_SUITE = cat(enc.encode('KEM'), i2osp(0x0010, 2));
const HPKE_SUITE = cat(enc.encode('HPKE'), i2osp(0x0010, 2), i2osp(0x0001, 2), i2osp(0x0002, 2));
const EMPTY = new Uint8Array(0);
const extract = (salt: Uint8Array, ikm: Uint8Array) => new Uint8Array(createHmac('sha256', salt).update(ikm).digest());
function expand(prk: Uint8Array, info: Uint8Array, len: number): Uint8Array {
  const out: Buffer[] = [];
  let t: Buffer = Buffer.alloc(0);
  for (let i = 1; out.length * 32 < len; i++) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
  }
  return new Uint8Array(Buffer.concat(out).subarray(0, len));
}
const labeledExtract = (suite: Uint8Array, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(salt, cat(enc.encode('HPKE-v1'), suite, enc.encode(label), ikm));
const labeledExpand = (suite: Uint8Array, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(prk, cat(i2osp(len, 2), enc.encode('HPKE-v1'), suite, enc.encode(label), info), len);

/** ECDH 결과 Z(x좌표 32B)에서 봉인 키와 논스를 뽑는다. Z는 덮지 않는다(부른 쪽 것). */
function p256HpkeKeys(z: Uint8Array, encap: Uint8Array, pkR: Uint8Array, info: Uint8Array): { key: Uint8Array; nonce: Uint8Array } {
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', z);
  const shared = labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', cat(encap, pkR), 32);
  const pskIdHash = labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info);
  const ctx = cat(Uint8Array.of(0), pskIdHash, infoHash);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY);
  try {
    return { key: labeledExpand(HPKE_SUITE, secret, 'key', ctx, 32), nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', ctx, 12) };
  } finally {
    for (const b of [eaePrk, shared, secret]) b.fill(0);
  }
}

function gcmSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, pt: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-256-gcm', key, nonce);
  c.setAAD(aad);
  return new Uint8Array(Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]));
}

function gcmOpen(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  if (ct.length < 16) throw new Error('open_failed');
  const b = Buffer.from(ct);
  const d = createDecipheriv('aes-256-gcm', key, nonce);
  d.setAAD(aad);
  d.setAuthTag(b.subarray(b.length - 16));
  try {
    return new Uint8Array(Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]));
  } catch {
    throw new Error('open_failed');
  }
}

/** 압축하지 않은 P-256 점(0x04 ‖ X ‖ Y)인지, 곡선 위에 있는지 본다. */
function assertP256Point(pub: Uint8Array): void {
  if (!(pub instanceof Uint8Array) || pub.length !== P256_POINT || pub[0] !== 4) throw new Error('bad_point');
  try {
    const probe = createECDH('prime256v1');
    probe.generateKeys();
    probe.computeSecret(pub);
  } catch {
    throw new Error('bad_point');
  }
}

/** 받는 공개키(폰의 UxPub)로 단발 봉인한다. enc는 임시 공개키 E다. */
export function p256HpkeSeal(pkR: Uint8Array, info: Uint8Array, aad: Uint8Array, pt: Uint8Array): { enc: Uint8Array; ct: Uint8Array } {
  assertP256Point(pkR);
  const e = createECDH('prime256v1');
  const encap = new Uint8Array(e.generateKeys());
  const z = new Uint8Array(e.computeSecret(pkR));
  const { key, nonce } = p256HpkeKeys(z, encap, pkR, info);
  try {
    return { enc: encap, ct: gcmSeal(key, nonce, aad, pt) };
  } finally {
    key.fill(0);
    z.fill(0);
  }
}

/** 폰이 돌려준 Z = ECDH(Ux, E)로 연다. 받는 쪽 개인키는 폰 보안칩 밖으로 나오지 않는다. */
export function p256HpkeOpenWithZ(z: Uint8Array, pkR: Uint8Array, encap: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Uint8Array {
  if (z.length !== 32) throw new Error('open_failed');
  const { key, nonce } = p256HpkeKeys(z, encap, pkR, info);
  try {
    return gcmOpen(key, nonce, aad, ct);
  } finally {
    key.fill(0);
  }
}

/** 폰 사본의 AAD: 이 PC, 이 폰, 이 계정에 묶는다. */
export const phoneCopyAad = (pcDeviceId: string, phoneDeviceId: string, aikPub: Uint8Array): Uint8Array => sha256(lp(pcDeviceId), lp(phoneDeviceId), aikPub);

/** 풀기 답(unlock.grant)의 AAD. 폰도 같은 값을 계산한다. */
export const unlockGrantAad = (reqId: string, n: Uint8Array, pcDeviceId: string, phoneDeviceId: string, e: Uint8Array): Uint8Array =>
  sha256(lp(reqId), n, lp(pcDeviceId), lp(phoneDeviceId), e);

/** 폰에 보내는 풀기 요청(unlock.request). 비밀은 없다. */
export interface UnlockRequest {
  reqId: string;
  pcDeviceId: string;
  phoneDeviceId: string;
  /** 폰 사본의 임시 공개키(P-256, 65B). 폰은 Z = ECDH(Ux, e)를 계산한다. */
  e: Uint8Array;
  /** 답을 봉인할 한 번용 공개키(X25519, 32B). */
  txPub: Uint8Array;
  n: Uint8Array;
  exp: number;
  scope: UnlockScope;
}

/** 폰의 답(unlock.grant): Z를 txPub로 봉인한 것(HPKE X25519, info UNLOCK_GRANT_INFO, aad unlockGrantAad). */
export interface UnlockGrant {
  reqId: string;
  enc: Uint8Array;
  ct: Uint8Array;
}

export type UnlockFail =
  | 'no_lock_key'
  | 'no_copy'
  | 'cancelled'
  | 'unavailable'
  | 'rate_limited'
  | 'declined_pause'
  | 'expired'
  | 'unknown_request'
  | 'wrong'
  | 'paused';
export type UnlockResult = { ok: true; via: UnlockVia; scope: UnlockScope } | { ok: false; reason: UnlockFail };

interface Meta {
  v: 1;
  phones: string[];
  /** 사본을 묶는 이 PC의 계정 기기 번호와 계정 신원 공개키(base64). 계정에 연결한 뒤 setIdentity로 한 번 적는다. */
  pc?: string;
  aik?: string;
  /** 설정에서 이 PC 생체인식을 껐다. */
  localOff?: boolean;
}

interface Pending {
  req: UnlockRequest;
  tx: ReturnType<typeof x25519FromSeed>;
}

export interface LockKeyOptions {
  backend: KeychainBackend;
  log: EventLog;
  now?: () => number;
}

export interface LockKeyState {
  exists: boolean;
  open: boolean;
  phones: string[];
  local: boolean;
  localOff: boolean;
  email: boolean;
  recovery: boolean;
  /** 사본이 하나라도 있어 잠글 수 있다(첫 사본만 있으면 false). */
  guarded: boolean;
  /** 거절 뒤 다시 보낼 수 있는 시각(ms, 지금 막혀 있지 않으면 0). */
  declinedUntil: number;
}

export class LockKeyStore {
  private readonly b: KeychainBackend;
  private readonly log: EventLog;
  private readonly now: () => number;
  private lk: Uint8Array | null = null;
  private scope: UnlockScope = 'screen';
  private readonly pending = new Map<string, Pending>();
  private requests: number[] = [];
  private declinedAt = Number.NEGATIVE_INFINITY;
  private wrong = 0;
  private wrongPausedUntil = 0;

  private guardedNow = false;

  constructor(o: LockKeyOptions) {
    this.b = o.backend;
    this.log = o.log;
    this.now = o.now ?? Date.now;
  }

  /** 잠글 수 있는지(첫 사본 말고 다른 사본이 있다). 마지막으로 state()를 읽은 값이다. */
  get guarded(): boolean {
    return this.guardedNow;
  }

  get isOpen(): boolean {
    return this.lk !== null;
  }

  /** 열려 있을 때 무엇으로 열렸는지('remote'면 본체 화면은 잠긴 그대로다). */
  get openScope(): UnlockScope | null {
    return this.lk ? this.scope : null;
  }

  private async meta(): Promise<Meta> {
    const raw = await this.b.items.get(ITEM_META);
    if (!raw) return { v: 1, phones: [] };
    const m = JSON.parse(Buffer.from(raw).toString('utf8')) as Meta;
    if (m?.v !== 1 || !Array.isArray(m.phones) || !m.phones.every((p) => typeof p === 'string' && ID_RE.test(p))) throw new Error('vault.item_corrupt');
    if (m.pc !== undefined && (typeof m.pc !== 'string' || !ID_RE.test(m.pc) || typeof m.aik !== 'string')) throw new Error('vault.item_corrupt');
    return m;
  }

  private async saveMeta(m: Meta): Promise<void> {
    await this.b.items.set(ITEM_META, enc.encode(JSON.stringify(m)));
  }

  async state(): Promise<LockKeyState> {
    const raw = await this.b.items.get(ITEM_META);
    const m = raw ? await this.meta() : null;
    const local = !!(await this.b.items.get(ITEM_LOCAL));
    const email = !!(await this.b.items.get(ITEM_EMAIL));
    const recovery = !!(await this.b.items.get(ITEM_RECOVERY));
    const phones = m?.phones ?? [];
    this.guardedNow = phones.length > 0 || local || email || recovery;
    const pause = this.declinedAt + UNLOCK_DECLINE_PAUSE_MS;
    return { exists: m !== null, open: this.isOpen, phones, local, localOff: m?.localOff === true, email, recovery, guarded: this.guardedNow, declinedUntil: pause > this.now() ? pause : 0 };
  }

  /** LK를 처음 만든다. 만든 직후는 열려 있고, 다른 사본이 생길 때까지 첫 사본(기기 결박)으로 다시 연다. */
  async create(): Promise<void> {
    if (await this.b.items.get(ITEM_META)) throw new Error('lock_key_exists');
    const lk = new Uint8Array(randomBytes(LK_BYTES));
    await this.b.items.set(ITEM_DEVICE, await this.b.wrapper.wrap(lk, 'lk|device'));
    await this.saveMeta({ v: 1, phones: [] });
    this.lk = lk;
    this.scope = 'screen';
    this.guardedNow = false;
    this.log.event('vault.lock_key_created');
  }

  /** 다른 사본이 없을 때만 있는 첫 사본으로 연다. */
  async openDevice(): Promise<UnlockResult> {
    const blob = await this.b.items.get(ITEM_DEVICE);
    if (!blob) return { ok: false, reason: 'no_copy' };
    let lk: Uint8Array;
    try {
      lk = await this.b.wrapper.unwrap(blob, 'lk|device');
    } catch {
      this.log.event('vault.unlock_failed', { via: 'device' });
      return { ok: false, reason: 'wrong' };
    }
    if (lk.length !== LK_BYTES) return { ok: false, reason: 'wrong' };
    return this.opened(lk, 'device', 'screen');
  }

  private async copyAdded(kind: 'phone' | 'local' | 'email' | 'recovery'): Promise<void> {
    this.guardedNow = true;
    if (await this.b.items.delete(ITEM_DEVICE)) this.log.event('vault.lock_copy_removed', { kind: 'device' });
    this.log.event('vault.lock_copy_added', { kind });
  }

  /** 사본을 지운 뒤, 남은 사본이 없고 열려 있으면 첫 사본을 다시 둔다(다음에 열 길이 없어지지 않게). */
  private async copyRemoved(kind: 'phone' | 'local' | 'email' | 'recovery'): Promise<void> {
    this.log.event('vault.lock_copy_removed', { kind });
    if ((await this.state()).guarded || !this.lk) return;
    await this.b.items.set(ITEM_DEVICE, await this.b.wrapper.wrap(this.lk, 'lk|device'));
    this.log.event('vault.lock_copy_added', { kind: 'device' });
  }

  /**
   * 사본을 묶을 이 PC의 계정 기기 번호와 계정 신원 공개키를 적는다. 처음 적는 값이 고정된다.
   * 다른 값이 오면(이 PC를 계정에 새로 연결함) 옛 값에 묶인 폰, 이메일, 복구 코드 사본을 지우고 새 값을 적는다. 열려 있을 때만 된다.
   */
  async setIdentity(pcDeviceId: string, aikPub: Uint8Array): Promise<'same' | 'set' | 'replaced'> {
    if (!ID_RE.test(pcDeviceId) || !(aikPub instanceof Uint8Array) || aikPub.length !== 32) throw new Error('bad_params');
    const m = await this.meta();
    const aik = Buffer.from(aikPub).toString('base64');
    if (m.pc === pcDeviceId && m.aik === aik) return 'same';
    this.need();
    const had = m.pc !== undefined;
    if (had) {
      for (const id of m.phones) await this.b.items.delete(phoneItem(id));
      await this.b.items.delete(ITEM_EMAIL);
      await this.b.items.delete(ITEM_RECOVERY);
      m.phones = [];
    }
    m.pc = pcDeviceId;
    m.aik = aik;
    await this.saveMeta(m);
    if (had) await this.copyRemoved('phone');
    this.log.event('vault.lock_identity', { result: had ? 'replaced' : 'set' });
    return had ? 'replaced' : 'set';
  }

  private async identity(): Promise<{ pc: string; aik: Uint8Array }> {
    const m = await this.meta();
    if (!m.pc || !m.aik) throw new Error('no_identity');
    return { pc: m.pc, aik: new Uint8Array(Buffer.from(m.aik, 'base64')) };
  }

  /** 잠근다: LK와 진행 중인 풀기 요청을 지운다. 첫 사본만 있으면 잠그지 않는다(다시 열 길이가 그것뿐이다). */
  async lock(): Promise<boolean> {
    if (!this.lk) return true;
    if (!(await this.state()).guarded) {
      this.log.event('vault.lock_refused', { why: 'no_copy' });
      return false;
    }
    this.wipe();
    return true;
  }

  /** 조건 없이 메모리의 LK를 지운다(프로세스 종료, 세션 잠금). */
  wipe(): void {
    this.lk?.fill(0);
    this.lk = null;
    this.pending.clear();
  }

  private need(): Uint8Array {
    if (!this.lk) throw new Error('vault_locked');
    return this.lk;
  }

  private opened(lk: Uint8Array, via: UnlockVia, scope: UnlockScope): UnlockResult {
    this.lk?.fill(0);
    this.lk = lk;
    this.scope = scope;
    this.pending.clear();
    this.wrong = 0;
    this.log.event('vault.unlocked', { via, scope });
    return { ok: true, via, scope };
  }

  /* 슬롯 KEK: LK로 한 번, 기기 결박으로 한 번 더 감싼다. 디스크만으로도 LK만으로도 풀리지 않는다. */

  async wrapKek(kek: Uint8Array, slot: string): Promise<Uint8Array> {
    return this.b.wrapper.wrap(seal(this.need(), kek, `kek-lk|${slot}`), `lk|${slot}`);
  }

  async unwrapKek(blob: Uint8Array, slot: string): Promise<Uint8Array> {
    const lk = this.need();
    const inner = await this.b.wrapper.unwrap(blob, `lk|${slot}`);
    return open(lk, inner, `kek-lk|${slot}`);
  }

  /* 폰 사본 */

  private async sealForPhone(lk: Uint8Array, phoneId: string, uxPub: Uint8Array): Promise<void> {
    const id = await this.identity();
    const aad = phoneCopyAad(id.pc, phoneId, id.aik);
    const { enc: e, ct } = p256HpkeSeal(uxPub, enc.encode(UNLOCK_INFO), aad, lk);
    await this.b.items.set(phoneItem(phoneId), cat(uxPub, e, ct));
  }

  private async phoneCopy(phoneId: string): Promise<{ uxPub: Uint8Array; e: Uint8Array; ct: Uint8Array } | null> {
    const raw = await this.b.items.get(phoneItem(phoneId));
    if (!raw || raw.length !== 2 * P256_POINT + LK_BYTES + 16) return null;
    return { uxPub: raw.subarray(0, P256_POINT), e: raw.subarray(P256_POINT, 2 * P256_POINT), ct: raw.subarray(2 * P256_POINT) };
  }

  /** 폰의 풀기 공개키(UxPub)를 받아 사본을 만든다. 열려 있을 때만 된다. */
  async addPhone(phoneId: string, uxPub: Uint8Array): Promise<void> {
    if (!ID_RE.test(phoneId)) throw new Error('bad_device_id');
    assertP256Point(uxPub);
    const lk = this.need();
    const m = await this.meta();
    if (!m.phones.includes(phoneId) && m.phones.length >= PHONE_COPY_MAX) throw new Error('too_many_phones');
    await this.sealForPhone(lk, phoneId, Uint8Array.from(uxPub));
    if (!m.phones.includes(phoneId)) {
      m.phones.push(phoneId);
      await this.saveMeta(m);
    }
    await this.copyAdded('phone');
  }

  /** 이 폰의 사본이 이 공개키로 만든 것인지(같은 키로 다시 등록하면 할 일이 없다). */
  async phoneKeyIs(phoneId: string, uxPub: Uint8Array): Promise<boolean> {
    const c = await this.phoneCopy(phoneId);
    return !!c && c.uxPub.length === uxPub.length && timingSafeEqual(c.uxPub, uxPub);
  }

  async removePhone(phoneId: string): Promise<boolean> {
    const m = await this.meta();
    const had = m.phones.includes(phoneId);
    await this.b.items.delete(phoneItem(phoneId));
    for (const [id, p] of this.pending) if (p.req.phoneDeviceId === phoneId) this.pending.delete(id);
    if (had) {
      m.phones = m.phones.filter((p) => p !== phoneId);
      await this.saveMeta(m);
      await this.copyRemoved('phone');
    }
    return had;
  }

  /** 폰에 보낼 풀기 요청을 만든다. 10분에 3번까지이고, 폰이 거절하면 5분 동안 만들지 않는다. */
  async phoneRequest(phoneId: string, scope: UnlockScope): Promise<{ ok: true; request: UnlockRequest } | { ok: false; reason: UnlockFail }> {
    const t = this.now();
    if (t - this.declinedAt < UNLOCK_DECLINE_PAUSE_MS) return { ok: false, reason: 'declined_pause' };
    this.requests = this.requests.filter((at) => t - at < UNLOCK_REQUEST_WINDOW_MS);
    if (this.requests.length >= UNLOCK_REQUEST_MAX) return { ok: false, reason: 'rate_limited' };
    if (!(await this.b.items.get(ITEM_META))) return { ok: false, reason: 'no_lock_key' };
    const copy = await this.phoneCopy(phoneId);
    if (!copy) return { ok: false, reason: 'no_copy' };
    const seed = new Uint8Array(randomBytes(32));
    const tx = x25519FromSeed(seed);
    seed.fill(0);
    const { pc } = await this.identity();
    const request: UnlockRequest = {
      reqId: randomBytes(16).toString('base64url'),
      pcDeviceId: pc,
      phoneDeviceId: phoneId,
      e: Uint8Array.from(copy.e),
      txPub: tx.pub,
      n: new Uint8Array(randomBytes(32)),
      exp: t + UNLOCK_REQUEST_TTL_MS,
      scope,
    };
    this.requests.push(t);
    this.pending.set(request.reqId, { req: request, tx });
    this.log.event('vault.unlock_requested', { scope });
    return { ok: true, request };
  }

  /** 폰이 [아니요]를 눌렀다. */
  phoneDeclined(reqId: string): void {
    if (!this.pending.delete(reqId)) return;
    this.declinedAt = this.now();
    this.log.event('vault.unlock_declined');
  }

  /** 폰의 답으로 연다. 열리면 모든 폰 사본을 새 임시 키로 다시 봉인한다(가로챈 Z는 다음에 쓸 수 없다). */
  async phoneGrant(g: UnlockGrant): Promise<UnlockResult> {
    const p = this.pending.get(g.reqId);
    if (!p) return { ok: false, reason: 'unknown_request' };
    this.pending.delete(g.reqId);
    if (this.now() > p.req.exp) return { ok: false, reason: 'expired' };
    const copy = await this.phoneCopy(p.req.phoneDeviceId);
    if (!copy || !timingSafeEqual(copy.e, p.req.e)) return { ok: false, reason: 'no_copy' };
    let z: Uint8Array | null = null;
    try {
      const id = await this.identity();
      const aad = unlockGrantAad(p.req.reqId, p.req.n, id.pc, p.req.phoneDeviceId, p.req.e);
      z = hpkeOpenBase(p.tx.priv, p.tx.pub, g.enc, enc.encode(UNLOCK_GRANT_INFO), aad, g.ct);
      const lk = p256HpkeOpenWithZ(z, copy.uxPub, copy.e, enc.encode(UNLOCK_INFO), phoneCopyAad(id.pc, p.req.phoneDeviceId, id.aik), copy.ct);
      if (lk.length !== LK_BYTES) throw new Error('open_failed');
      const r = this.opened(lk, 'phone', p.req.scope);
      await this.resealPhones(lk);
      return r;
    } catch {
      this.log.event('vault.unlock_failed', { via: 'phone' });
      return { ok: false, reason: 'wrong' };
    } finally {
      z?.fill(0);
    }
  }

  private async resealPhones(lk: Uint8Array): Promise<void> {
    for (const id of (await this.meta()).phones) {
      const c = await this.phoneCopy(id);
      if (c) await this.sealForPhone(lk, id, Uint8Array.from(c.uxPub));
    }
  }

  /* 이 PC 사본(Touch ID, Windows Hello) */

  async localAvailable(): Promise<boolean> {
    return this.b.hello.available().catch(() => false);
  }

  /** 이 PC 생체인식 사본을 켜고 끈다. 끈 것은 기억해서 ensureLocal이 다시 만들지 않는다. */
  async setLocal(on: boolean): Promise<void> {
    const lk = this.need();
    const m = await this.meta();
    if (!on) {
      if (await this.b.items.delete(ITEM_LOCAL)) await this.copyRemoved('local');
      if (!m.localOff) await this.saveMeta({ ...m, localOff: true });
      return;
    }
    if (!(await this.localAvailable())) throw new Error('vault.hello_unavailable');
    await this.b.items.set(ITEM_LOCAL, await this.b.hello.wrap(lk, 'lk'));
    if (m.localOff) await this.saveMeta({ ...m, localOff: false });
    await this.copyAdded('local');
  }

  /** 열려 있고, 끄지 않았고, 이 PC 생체인식을 쓸 수 있는데 사본이 없으면 만든다(첫 실행, 덮개를 연 뒤). */
  async ensureLocal(): Promise<boolean> {
    if (!this.lk) return false;
    const s = await this.state();
    if (s.local || s.localOff || !(await this.localAvailable())) return false;
    await this.setLocal(true);
    return true;
  }

  async unlockLocal(prompt: HelloPrompt): Promise<UnlockResult> {
    const blob = await this.b.items.get(ITEM_LOCAL);
    if (!blob) return { ok: false, reason: 'no_copy' };
    if (!(await this.localAvailable())) return { ok: false, reason: 'unavailable' };
    const lk = await this.b.hello.unwrap(blob, 'lk', prompt).catch(() => null);
    if (!lk || lk.length !== LK_BYTES) return { ok: false, reason: 'cancelled' };
    const r = this.opened(lk, 'local', 'screen');
    await this.resealPhones(lk);
    return r;
  }

  /* 틀린 입력 세기(이메일 조각, 복구 코드) */

  private paused(): boolean {
    return this.now() < this.wrongPausedUntil;
  }

  private miss(via: UnlockVia): UnlockResult {
    this.wrong += 1;
    this.log.event('vault.unlock_failed', { via });
    if (this.wrong >= UNLOCK_WRONG_MAX) {
      this.wrong = 0;
      this.wrongPausedUntil = this.now() + UNLOCK_WRONG_PAUSE_MS;
    }
    return { ok: false, reason: 'wrong' };
  }

  /* 이메일 사본: 서버가 가진 조각 Se로 봉인하고 그 위를 기기 결박으로 감싼다. Se는 금고에 남기지 않는다. */

  /** 새 조각을 만들어 사본을 다시 쓴다. 돌려준 Se는 서버에 맡기고 버린다. */
  async setEmail(): Promise<Uint8Array> {
    const lk = this.need();
    const { pc } = await this.identity();
    const se = new Uint8Array(randomBytes(32));
    const k = new Uint8Array(hkdfSync('sha256', se, enc.encode(pc), UNLOCK_EMAIL_INFO, 32));
    try {
      await this.b.items.set(ITEM_EMAIL, await this.b.wrapper.wrap(seal(k, lk, 'lk-email'), 'lk|email'));
    } finally {
      k.fill(0);
    }
    await this.copyAdded('email');
    return se;
  }

  async clearEmail(): Promise<void> {
    if (await this.b.items.delete(ITEM_EMAIL)) await this.copyRemoved('email');
  }

  private emailTx: ReturnType<typeof x25519FromSeed> | null = null;

  /** 이메일 숫자 확인을 시작한다: 서버가 Se를 봉인할 한 번용 공개키(Tx)를 돌려준다. */
  emailBegin(): Uint8Array {
    const seed = new Uint8Array(randomBytes(32));
    this.emailTx = x25519FromSeed(seed);
    seed.fill(0);
    return this.emailTx.pub;
  }

  /** 서버가 Tx로 봉인해 준 Se로 연다. */
  async unlockEmailSealed(encap: Uint8Array, ct: Uint8Array): Promise<UnlockResult & { nextShare?: Uint8Array }> {
    const tx = this.emailTx;
    if (!tx) return { ok: false, reason: 'unknown_request' };
    this.emailTx = null;
    if (this.paused()) return { ok: false, reason: 'paused' };
    let se: Uint8Array;
    try {
      se = hpkeOpenBase(tx.priv, tx.pub, encap, enc.encode(UNLOCK_EMAIL_SEAL_INFO), unlockEmailSealAad((await this.identity()).pc, tx.pub), ct);
    } catch {
      return this.miss('email');
    }
    try {
      return await this.unlockEmail(se);
    } finally {
      se.fill(0);
    }
  }

  /** 서버가 이메일 숫자를 확인하고 내준 조각으로 연다. 열리면 조각을 새로 만들어 돌려준다(다시 맡긴다). */
  async unlockEmail(se: Uint8Array): Promise<UnlockResult & { nextShare?: Uint8Array }> {
    if (this.paused()) return { ok: false, reason: 'paused' };
    const blob = await this.b.items.get(ITEM_EMAIL);
    if (!blob) return { ok: false, reason: 'no_copy' };
    if (!(se instanceof Uint8Array) || se.length !== 32) return this.miss('email');
    const { pc } = await this.identity();
    const k = new Uint8Array(hkdfSync('sha256', se, enc.encode(pc), UNLOCK_EMAIL_INFO, 32));
    let lk: Uint8Array;
    try {
      lk = open(k, await this.b.wrapper.unwrap(blob, 'lk|email'), 'lk-email');
    } catch {
      return this.miss('email');
    } finally {
      k.fill(0);
    }
    const r = this.opened(lk, 'email', 'screen');
    await this.resealPhones(lk);
    return { ...r, nextShare: await this.setEmail() };
  }

  /* 복구 코드 사본: RK에서 뽑은 키로 봉인한다. */

  private async recoveryKey(rk: Uint8Array): Promise<Uint8Array> {
    const { pc } = await this.identity();
    return new Uint8Array(hkdfSync('sha256', rk, enc.encode(pc), LOCK_RECOVERY_INFO, 32));
  }

  async setRecovery(rk: Uint8Array): Promise<void> {
    const lk = this.need();
    if (rk.length !== 32) throw new Error('bad_key');
    const k = await this.recoveryKey(rk);
    try {
      await this.b.items.set(ITEM_RECOVERY, seal(k, lk, 'lk-recovery'));
    } finally {
      k.fill(0);
    }
    await this.copyAdded('recovery');
  }

  /** 적어 둔 복구 코드로 서버의 RKr을 열고, 그 RK가 이 계정의 것이면 연다. 코드가 틀린 것도 틀린 횟수에 센다. */
  async unlockRecoveryCode(code: string, rkr: Uint8Array): Promise<UnlockResult> {
    if (this.paused()) return { ok: false, reason: 'paused' };
    const c = normalizeRecoveryCode(code);
    if (!c) return this.miss('recovery');
    let rk: Uint8Array;
    try {
      rk = openRecovery(c, rkr);
    } catch {
      return this.miss('recovery');
    }
    try {
      const seed = aikSeedFromRk(rk);
      const aik = ed25519FromSeed(seed).pub;
      seed.fill(0);
      if (!timingSafeEqual(aik, (await this.identity()).aik)) return this.miss('recovery');
      return await this.unlockRecovery(rk);
    } finally {
      rk.fill(0);
    }
  }

  /** 복구 코드로 연 RK로 연다. RK는 부른 쪽이 덮는다. */
  async unlockRecovery(rk: Uint8Array): Promise<UnlockResult> {
    if (this.paused()) return { ok: false, reason: 'paused' };
    const blob = await this.b.items.get(ITEM_RECOVERY);
    if (!blob) return { ok: false, reason: 'no_copy' };
    if (!(rk instanceof Uint8Array) || rk.length !== 32) return this.miss('recovery');
    const k = await this.recoveryKey(rk);
    let lk: Uint8Array;
    try {
      lk = open(k, blob, 'lk-recovery');
    } catch {
      return this.miss('recovery');
    } finally {
      k.fill(0);
    }
    const r = this.opened(lk, 'recovery', 'screen');
    await this.resealPhones(lk);
    return r;
  }
}
