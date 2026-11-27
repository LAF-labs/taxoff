import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import { b64, CTX, fromB64, softSigner, uxEnrollMessage, verifyUxEnroll, type UnlockGrantBody, type UnlockRequestBody, type UxEnrollBody } from '@sax/remote';
import { hpkeSealBase, HumanSecretVault, MemoryItemStore, MemoryWrapper, MockHello, unlockGrantAad, UNLOCK_GRANT_INFO } from '@sax/vault';
import { LockHost, type LockPhone, type LockView } from '../apps/desktop/src/lock-host.ts';
import { phoneSession } from '../apps/desktop/src/phone-session.ts';
import { startHarness, type Harness } from './harness.ts';

const PC = '0b6f1b39-9d3c-4f53-9a55-4d8f2a2a9b11';
const PHONE: LockPhone = { pairId: 'pair-1', deviceId: '6a1c7e1e-1f51-4a52-8f3a-8b8f43d6a0c2', name: 'iPhone 16', platform: 'ios', online: true, lastSeenAt: 1, off: false };
const enc = new TextEncoder();

/** 폰 앱 흉내: Vm으로 Ux 등록 알림에 서명하고, 풀기 요청에 생체가 통과한 셈 치고 Z를 봉인해 답한다. */
function fakePhone() {
  const vm = softSigner(new Uint8Array(randomBytes(32)), [CTX.uxEnroll]);
  const ux = createECDH('prime256v1');
  const uxPub = new Uint8Array(ux.generateKeys());
  return {
    vmPub: vm.publicKey,
    async enroll(): Promise<UxEnrollBody> {
      return { uxPub: b64(uxPub), hw: 'ios_se', sig: b64(await vm.sign(CTX.uxEnroll, uxEnrollMessage(PHONE.pairId, PHONE.deviceId, uxPub, 'ios_se'))) };
    },
    answer(r: UnlockRequestBody, decision: 'open' | 'deny'): UnlockGrantBody {
      if (decision === 'deny') return { unlockId: r.unlockId, decision };
      const e = fromB64(r.unlockE);
      const z = new Uint8Array(ux.computeSecret(e));
      const s = hpkeSealBase(fromB64(r.txPub), enc.encode(UNLOCK_GRANT_INFO), unlockGrantAad(r.unlockId, fromB64(r.unlockN), PC, PHONE.deviceId, e), z);
      return { unlockId: r.unlockId, decision, grantEnc: b64(s.enc), grantCt: b64(s.ct) };
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('PC 잠금: 폰으로 열기(ADR-061 결정 3, 5, 6)', () => {
  let h: Harness;
  let lock: LockHost;
  let views: LockView[];
  let sent: Array<{ type: string; body: UnlockRequestBody }>;
  let wakes: string[];
  const phone = fakePhone();

  before(async () => {
    const human = new HumanSecretVault({ backend: { items: new MemoryItemStore(), wrapper: new MemoryWrapper(), hello: new MockHello() }, log: { event() {} } });
    h = await startHarness({ human });
    await h.control.rpc('session.idle', { idleSec: 0 });
    views = [];
    sent = [];
    wakes = [];
    lock = new LockHost({
      control: (m, p) => h.control.rpc(m, p ?? {}),
      phones: () => [PHONE],
      uxOwner: (pairId, body) => (verifyUxEnroll(phone.vmPub, pairId, PHONE.deviceId, fromB64(body.uxPub), body.hw, fromB64(body.sig)) ? PHONE.deviceId : null),
      wake: async (pairId) => (wakes.push(pairId), 'sent'),
      cloud: () => null,
      platform: 'darwin',
      push: (v) => views.push(v),
      recoveryWindow: async () => {},
      log: () => {},
    });
    h.control.on('vault.state', () => void lock.onVaultState());
    await lock.identity(PC);
  });
  after(async () => {
    await h.close();
  });

  const session = () =>
    phoneSession({
      issue: { attach() {}, detach() {}, handle: async () => ({}), resume: async () => {}, human: async () => {} } as never,
      copy: async () => ({}) as never,
      lock: { attach: (p, s) => lock.attach(p, s), detach: (p) => lock.detach(p), enroll: (p, b) => lock.enroll(p, b), grant: (p, b) => lock.grant(p, b), remote: (p) => lock.remote(p) },
    });
  const channel = () => {
    const out: Array<{ type: string; body: unknown }> = [];
    return { out, ch: { closed: false, send: (type: string, body: unknown) => (out.push({ type, body }), sent.push({ type, body: body as UnlockRequestBody })) } };
  };

  it('폰이 라이브 세션에서 Ux를 등록하면 사본이 생기고, 남의 서명은 거부한다', async () => {
    const s = session();
    const { ch, out } = channel();
    await s.open(PHONE.pairId, ch as never, ['unlock.v1']);
    const forged = { ...(await phone.enroll()), sig: b64(new Uint8Array(64)) };
    await s.handle(PHONE.pairId, ch as never, { type: 'ux.enroll', body: forged } as never);
    await s.handle(PHONE.pairId, ch as never, { type: 'ux.enroll', body: await phone.enroll() } as never);
    assert.deepEqual(out.map((x) => x.body), [{ state: 'rejected' }, { state: 'enrolled' }]);
    const st = await h.control.rpc<{ phones: string[]; guarded: boolean }>('lock.state');
    assert.deepEqual(st.phones, [PHONE.deviceId]);
    assert.equal(st.guarded, true);
    s.close(PHONE.pairId, ch as never);
  });

  it('잠그면 잠금 화면, [폰으로 열기]는 그 폰에 요청을 보내고, 폰의 답으로 열린다', async () => {
    await h.control.rpc('lock.now');
    await lock.refresh();
    assert.equal(lock.view().locked, true);
    assert.equal(lock.view().phone, 'iPhone 16');
    const s = session();
    const { ch } = channel();
    await s.open(PHONE.pairId, ch as never, ['unlock.v1']);
    sent.length = 0;
    await lock.askPhone();
    await tick();
    assert.equal(lock.view().step, 'phone');
    const req = sent.find((x) => x.type === 'unlock.request')!.body;
    assert.equal(req.scope, 'screen');
    await s.handle(PHONE.pairId, ch as never, { type: 'unlock.grant', body: phone.answer(req, 'open') } as never);
    await tick();
    assert.equal(lock.view().locked, false);
    s.close(PHONE.pairId, ch as never);
  });

  it('폰이 꺼져 있으면 푸시로 깨우고, 붙으면 그때 보낸다. 거절하면 거절 화면이고 5분 동안 다시 보내지 않는다', async () => {
    await h.control.rpc('lock.now');
    await lock.refresh();
    sent.length = 0;
    wakes.length = 0;
    await lock.askPhone();
    await tick();
    assert.deepEqual(wakes, [PHONE.pairId]);
    assert.equal(sent.length, 0);
    const s = session();
    const { ch } = channel();
    await s.open(PHONE.pairId, ch as never, ['unlock.v1']);
    const req = sent.find((x) => x.type === 'unlock.request')!.body;
    await s.handle(PHONE.pairId, ch as never, { type: 'unlock.grant', body: phone.answer(req, 'deny') } as never);
    await tick();
    assert.equal(lock.view().step, 'declined');
    assert.ok(lock.view().declinedUntil > Date.now());
    sent.length = 0;
    await lock.askPhone();
    await tick();
    assert.equal(sent.length, 0);
    assert.equal(lock.view().step, 'declined');
    s.close(PHONE.pairId, ch as never);
  });

  it('잠긴 PC에 맡긴 일: 원격 풀기 요청을 보내고, 열려도 잠금 화면은 그대로다', async () => {
    const human = new HumanSecretVault({ backend: { items: new MemoryItemStore(), wrapper: new MemoryWrapper(), hello: new MockHello() }, log: { event() {} } });
    const h2 = await startHarness({ human });
    try {
      await h2.control.rpc('lock.identity', { deviceId: PC });
      const lk2 = new LockHost({ control: (m, p) => h2.control.rpc(m, p ?? {}), phones: () => [PHONE], uxOwner: () => PHONE.deviceId, wake: async () => 'sent', cloud: () => null, platform: 'darwin', push: () => {}, recoveryWindow: async () => {}, log: () => {} });
      await lk2.enroll(PHONE.pairId, await phone.enroll());
      await h2.control.rpc('lock.now');
      const out: UnlockRequestBody[] = [];
      lk2.attach(PHONE.pairId, (_t, b) => out.push(b as UnlockRequestBody));
      const opened = lk2.remote(PHONE.pairId);
      await tick();
      assert.equal(out[0]!.scope, 'remote');
      await lk2.grant(PHONE.pairId, phone.answer(out[0]!, 'open'));
      assert.equal(await opened, true);
      assert.equal(lk2.open, true);
      assert.equal(lk2.view().locked, true, '화면은 잠긴 그대로');
      assert.deepEqual(await h2.control.rpc('session.event', { kind: 'lock-screen' }), { open: true, scope: 'remote' });
    } finally {
      await h2.close();
    }
  });
});
