import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  aikSeedFromRk, ed25519FromSeed, hpkeSealBase, LockKeyStore, newRecoveryCode, normalizeRecoveryCode, recoveryGroups, sealRecovery, unlockEmailSealAad, UNLOCK_EMAIL_SEAL_INFO, MemoryItemStore, MemoryWrapper, MockHello, UnavailableHello,
  p256HpkeOpenWithZ, p256HpkeSeal, unlockGrantAad, UNLOCK_GRANT_INFO,
  UNLOCK_DECLINE_PAUSE_MS, UNLOCK_REQUEST_TTL_MS, UNLOCK_WRONG_MAX, UNLOCK_WRONG_PAUSE_MS,
  type KeychainBackend, type UnlockGrant, type UnlockRequest,
} from '@sax/vault';

const log = { event() {} };
const enc = new TextEncoder();
const PC = 'pc-device-1';
const PHONE = 'phone-1';

/** 폰 보안칩 흉내: Ux 개인키는 여기서만 쓰고, 생체가 통과한 셈 치고 Z를 txPub로 봉인해 돌려준다. */
function phone(id = PHONE) {
  const ux = createECDH('prime256v1');
  const uxPub = new Uint8Array(ux.generateKeys());
  const grant = (r: UnlockRequest): UnlockGrant => {
    const z = new Uint8Array(ux.computeSecret(r.e));
    const aad = unlockGrantAad(r.reqId, r.n, r.pcDeviceId, id, r.e);
    return { reqId: r.reqId, ...hpkeSealBase(r.txPub, enc.encode(UNLOCK_GRANT_INFO), aad, z) };
  };
  return { id, uxPub, grant };
}

function setup(opts: { hello?: boolean; wrapper?: MemoryWrapper; items?: MemoryItemStore } = {}) {
  let t = 1_000_000;
  const items = opts.items ?? new MemoryItemStore();
  const hello = opts.hello ? new MockHello() : new UnavailableHello();
  const backend: KeychainBackend = { items, wrapper: opts.wrapper ?? new MemoryWrapper(), hello };
  const aik = new Uint8Array(randomBytes(32));
  const s = new LockKeyStore({ backend, log, now: () => t });
  const create = async () => {
    await s.create();
    await s.setIdentity(PC, aik);
  };
  return { s, create, items, hello, backend, aik, tick: (ms: number) => (t += ms) };
}

async function request(s: LockKeyStore, id = PHONE): Promise<UnlockRequest> {
  const r = await s.phoneRequest(id, 'screen');
  assert.equal(r.ok, true);
  return (r as { request: UnlockRequest }).request;
}

describe('P-256 봉인(폰 사본)', () => {
  it('받는 쪽이 돌려준 Z로 열리고, 다른 AAD나 다른 Z로는 안 열린다', () => {
    const ux = createECDH('prime256v1');
    const pub = new Uint8Array(ux.generateKeys());
    const pt = new Uint8Array(randomBytes(32));
    const info = enc.encode('i');
    const { enc: e, ct } = p256HpkeSeal(pub, info, enc.encode('a'), pt);
    const z = new Uint8Array(ux.computeSecret(e));
    assert.deepEqual(p256HpkeOpenWithZ(z, pub, e, info, enc.encode('a'), ct), pt);
    assert.throws(() => p256HpkeOpenWithZ(z, pub, e, info, enc.encode('b'), ct), /open_failed/);
    assert.throws(() => p256HpkeOpenWithZ(new Uint8Array(32).fill(7), pub, e, info, enc.encode('a'), ct), /open_failed/);
  });

  it('곡선 위에 없는 공개키는 거부한다', () => {
    const bad = new Uint8Array(65).fill(1);
    bad[0] = 4;
    assert.throws(() => p256HpkeSeal(bad, enc.encode('i'), enc.encode('a'), new Uint8Array(32)), /bad_point/);
  });
});

describe('잠금 열쇠(LockKeyStore)', () => {
  it('사본이 하나도 없으면 잠그지 않는다', async () => {
    const { s, create } = setup();
    await create();
    assert.equal(await s.lock(), false);
    assert.equal(s.isOpen, true);
  });

  it('폰 답으로 열리고 슬롯 KEK가 그대로 풀린다', async () => {
    const { s, create } = setup();
    const p = phone();
    await create();
    await s.addPhone(p.id, p.uxPub);
    const kek = new Uint8Array(randomBytes(32));
    const wrapped = await s.wrapKek(kek, 'cert/business');
    assert.equal(await s.lock(), true);
    await assert.rejects(s.unwrapKek(wrapped, 'cert/business'), /vault_locked/);
    const r = await s.phoneGrant(p.grant(await request(s)));
    assert.deepEqual(r, { ok: true, via: 'phone', scope: 'screen' });
    assert.deepEqual(await s.unwrapKek(wrapped, 'cert/business'), kek);
    await assert.rejects(s.unwrapKek(wrapped, 'portal/business'));
  });

  it('열린 뒤 폰 사본을 다시 봉인해서, 가로챈 답은 다음에 못 쓴다', async () => {
    const { s, create } = setup();
    const p = phone();
    await create();
    await s.addPhone(p.id, p.uxPub);
    await s.lock();
    const r1 = await request(s);
    const g1 = p.grant(r1);
    assert.equal((await s.phoneGrant(g1)).ok, true);
    await s.lock();
    assert.deepEqual(await s.phoneGrant(g1), { ok: false, reason: 'unknown_request' });
    const r2 = await request(s);
    assert.notDeepEqual(r2.e, r1.e);
    assert.equal((await s.phoneGrant({ ...g1, reqId: r2.reqId })).ok, false);
    assert.equal(s.isOpen, false);
  });

  it('다른 폰의 키로 만든 답, 시간이 지난 답은 열지 못한다', async () => {
    const { s, create, tick } = setup();
    const p = phone();
    const other = phone();
    await create();
    await s.addPhone(p.id, p.uxPub);
    await s.lock();
    assert.deepEqual(await s.phoneGrant(other.grant(await request(s))), { ok: false, reason: 'wrong' });
    const r = await request(s);
    tick(UNLOCK_REQUEST_TTL_MS + 1);
    assert.deepEqual(await s.phoneGrant(p.grant(r)), { ok: false, reason: 'expired' });
    assert.equal(s.isOpen, false);
  });

  it('요청은 10분에 3번까지, 거절하면 5분 동안 만들지 않는다', async () => {
    const { s, create, tick } = setup();
    const p = phone();
    await create();
    await s.addPhone(p.id, p.uxPub);
    await s.lock();
    const r = await request(s);
    s.phoneDeclined(r.reqId);
    assert.deepEqual(await s.phoneRequest(p.id, 'screen'), { ok: false, reason: 'declined_pause' });
    tick(UNLOCK_DECLINE_PAUSE_MS);
    await request(s);
    await request(s);
    assert.deepEqual(await s.phoneRequest(p.id, 'screen'), { ok: false, reason: 'rate_limited' });
  });

  it('폰을 끊으면 그 폰으로는 요청도 못 만든다', async () => {
    const { s, create } = setup({ hello: true });
    const p = phone();
    await create();
    await s.addPhone(p.id, p.uxPub);
    await s.setLocal(true);
    assert.equal(await s.removePhone(p.id), true);
    await s.lock();
    assert.deepEqual(await s.phoneRequest(p.id, 'screen'), { ok: false, reason: 'no_copy' });
    assert.deepEqual((await s.state()).phones, []);
  });

  it('이 PC 생체인식으로 열고, 취소하면 잠긴 그대로다', async () => {
    const { s, create, hello } = setup({ hello: true });
    await create();
    await s.setLocal(true);
    await s.lock();
    (hello as MockHello).next = 'cancel';
    assert.deepEqual(await s.unlockLocal({ task: '', portal: '' }), { ok: false, reason: 'cancelled' });
    (hello as MockHello).next = 'approve';
    assert.deepEqual(await s.unlockLocal({ task: '', portal: '' }), { ok: true, via: 'local', scope: 'screen' });
  });

  it('생체인식이 없는 PC에는 이 PC 사본을 만들지 않는다', async () => {
    const { s, create } = setup();
    await create();
    await assert.rejects(s.setLocal(true), /hello_unavailable/);
    assert.equal((await s.state()).local, false);
  });

  it('이메일 조각: 맞는 조각과 이 기기가 함께 있어야 열리고, 열리면 조각이 바뀐다', async () => {
    const wrapper = new MemoryWrapper();
    const { s, create, items } = setup({ wrapper });
    await create();
    const se = await s.setEmail();
    await s.lock();
    assert.deepEqual(await s.unlockEmail(new Uint8Array(32)), { ok: false, reason: 'wrong' });
    const stolen = new MemoryItemStore();
    for (const [k, v] of items.items) await stolen.set(k, v);
    const thief = setup({ items: stolen, wrapper: MemoryWrapper.otherDevice() });
    assert.deepEqual(await thief.s.unlockEmail(se), { ok: false, reason: 'wrong' });
    const r = await s.unlockEmail(se);
    assert.equal(r.ok, true);
    assert.equal(r.nextShare?.length, 32);
    await s.lock();
    assert.equal((await s.unlockEmail(se)).ok, false);
    assert.equal((await s.unlockEmail(r.nextShare!)).ok, true);
  });

  it('복구 코드로 연 계정 열쇠로 열리고, 5번 틀리면 1시간 막는다', async () => {
    const { s, create, tick } = setup();
    const rk = new Uint8Array(randomBytes(32));
    await create();
    await s.setRecovery(rk);
    await s.lock();
    for (let i = 0; i < UNLOCK_WRONG_MAX; i++) assert.deepEqual(await s.unlockRecovery(new Uint8Array(32)), { ok: false, reason: 'wrong' });
    assert.deepEqual(await s.unlockRecovery(rk), { ok: false, reason: 'paused' });
    tick(UNLOCK_WRONG_PAUSE_MS);
    assert.deepEqual(await s.unlockRecovery(rk), { ok: true, via: 'recovery', scope: 'screen' });
  });

  it('디스크에는 잠금 열쇠가 평문으로 남지 않는다', async () => {
    const { s, create, items } = setup({ hello: true });
    const p = phone();
    await create();
    await s.addPhone(p.id, p.uxPub);
    await s.setLocal(true);
    await s.setEmail();
    await s.setRecovery(new Uint8Array(randomBytes(32)));
    const kek = new Uint8Array(randomBytes(32));
    const wrapped = await s.wrapKek(kek, 'cert/business');
    const lk = (s as unknown as { lk: Uint8Array }).lk;
    const hex = Buffer.from(lk).toString('hex');
    for (const v of [...items.items.values(), wrapped]) assert.equal(Buffer.from(v).toString('hex').includes(hex), false);
    await s.lock();
    assert.equal(lk.every((b) => b === 0), true);
  });
});

describe('잠금 열쇠: 첫 사본, 계정 신원, 이메일 숫자, 복구 코드', () => {
  it('처음에는 첫 사본(기기 결박)만 있고, 다른 사본이 생기면 지우며, 마지막 사본을 지우면 다시 둔다', async () => {
    const { s, create, items } = setup();
    const p = phone();
    await create();
    assert.equal((await s.state()).guarded, false);
    assert.ok(items.items.has('lk/device'));
    await s.addPhone(p.id, p.uxPub);
    assert.equal(s.guarded, true);
    assert.equal(items.items.has('lk/device'), false);
    await s.removePhone(p.id);
    assert.equal(s.guarded, false);
    assert.ok(items.items.has('lk/device'));
    s.wipe();
    assert.deepEqual(await s.openDevice(), { ok: true, via: 'device', scope: 'screen' });
  });

  it('다른 계정 신원이 오면 옛 신원에 묶인 폰, 이메일, 복구 코드 사본을 지운다', async () => {
    const { s, create, aik } = setup({ hello: true });
    const p = phone();
    await create();
    await s.setLocal(true);
    await s.addPhone(p.id, p.uxPub);
    await s.setEmail();
    assert.equal(await s.setIdentity(PC, aik), 'same');
    assert.equal(await s.setIdentity('pc-device-2', new Uint8Array(randomBytes(32))), 'replaced');
    const st = await s.state();
    assert.deepEqual([st.phones, st.email, st.local], [[], false, true]);
  });

  it('이 PC 생체인식을 끄면 다시 만들지 않는다', async () => {
    const { s, create } = setup({ hello: true });
    await create();
    assert.equal(await s.ensureLocal(), true);
    await s.setLocal(false);
    assert.equal(await s.ensureLocal(), false);
    assert.deepEqual([(await s.state()).local, (await s.state()).localOff], [false, true]);
  });

  it('이메일 숫자: 서버가 이 PC와 한 번용 키에 묶어 봉인한 Se로만 열린다', async () => {
    const { s, create } = setup();
    await create();
    const se = await s.setEmail();
    await s.lock();
    const tx = s.emailBegin();
    const other = hpkeSealBase(tx, enc.encode(UNLOCK_EMAIL_SEAL_INFO), unlockEmailSealAad('pc-other', tx), se);
    assert.deepEqual(await s.unlockEmailSealed(other.enc, other.ct), { ok: false, reason: 'wrong' });
    assert.deepEqual(await s.unlockEmailSealed(other.enc, other.ct), { ok: false, reason: 'unknown_request' }, 'Tx는 한 번만 쓴다');
    const tx2 = s.emailBegin();
    const good = hpkeSealBase(tx2, enc.encode(UNLOCK_EMAIL_SEAL_INFO), unlockEmailSealAad(PC, tx2), se);
    const r = await s.unlockEmailSealed(good.enc, good.ct);
    assert.equal(r.ok, true);
    assert.equal(r.nextShare?.length, 32);
  });

  it('복구 코드: 24글자 여섯 묶음, 헷갈리는 글자를 맞추고, 이 계정의 RK일 때만 열고 틀린 코드도 센다', async () => {
    const rk = new Uint8Array(randomBytes(32));
    const seed = aikSeedFromRk(rk);
    const aik = ed25519FromSeed(seed).pub;
    const items = new MemoryItemStore();
    let t = 1_000_000;
    const s = new LockKeyStore({ backend: { items, wrapper: new MemoryWrapper(), hello: new UnavailableHello() }, log, now: () => t });
    await s.create();
    await s.setIdentity(PC, aik);
    await s.setRecovery(rk);
    await s.lock();
    const code = newRecoveryCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{24}$/);
    assert.equal(recoveryGroups(code).join(''), code);
    assert.equal(normalizeRecoveryCode(recoveryGroups(code).join('-').toLowerCase()), code);
    assert.equal(normalizeRecoveryCode('O1IL'.repeat(6)), '0111'.repeat(6));
    const rkr = sealRecovery(code, rk);
    assert.ok(rkr.length <= 200);
    const otherRk = new Uint8Array(randomBytes(32));
    assert.deepEqual(await s.unlockRecoveryCode(code, sealRecovery(code, otherRk)), { ok: false, reason: 'wrong' }, '다른 계정의 RK');
    for (let i = 1; i < UNLOCK_WRONG_MAX; i++) assert.deepEqual(await s.unlockRecoveryCode(newRecoveryCode(), rkr), { ok: false, reason: 'wrong' });
    assert.deepEqual(await s.unlockRecoveryCode(code, rkr), { ok: false, reason: 'paused' });
    t += UNLOCK_WRONG_PAUSE_MS;
    assert.deepEqual(await s.unlockRecoveryCode(code.toLowerCase(), rkr), { ok: true, via: 'recovery', scope: 'screen' });
  });
});
