import assert from 'node:assert/strict';
import { FileEventLog } from '@sax/platform';
import { constants as cc, createECDH, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import {
  codefPublicKey, hpkeOpenBase, hpkeSealBase, LockKeyStore, MemoryItemStore, MemoryKeyStore, MemoryWrapper, RK_ESCROW_INFO, RK_LINK_INFO, UNLOCK_GRANT_INFO,
  UnavailableHello, unlockGrantAad, VaultCrypto, x25519FromSeed,
} from '@sax/vault';

assert.ok(process.versions.electron, 'Electron 런타임이 아니다');
const utf8 = (s: string) => new TextEncoder().encode(s);
const pc = () => new VaultCrypto({ keyStore: new MemoryKeyStore(), log: new FileEventLog(null, 'vault') });

const r = x25519FromSeed(new Uint8Array(32).fill(3));
const sealed = hpkeSealBase(r.pub, utf8('info'), utf8('aad'), utf8('TEST-PT'));
assert.deepEqual(hpkeOpenBase(r.priv, r.pub, sealed.enc, utf8('info'), utf8('aad'), sealed.ct), utf8('TEST-PT'));

const oldPc = pc();
const newPc = pc();
const aikOld = (await oldPc.publicKeys()).aik;
assert.notDeepEqual((await newPc.publicKeys()).aik, aikOld);
const aad = new Uint8Array(32).fill(5);
const rk = await oldPc.rkSeal({ recipient: await newPc.linkKey(), info: RK_LINK_INFO, aad });
assert.deepEqual([rk.enc.length, rk.ct.length], [32, 48]);
assert.deepEqual(await newPc.rkImport({ ...rk, info: RK_LINK_INFO, aad, aikPub: aikOld }), aikOld);
assert.deepEqual((await newPc.publicKeys()).aik, aikOld);
const thirdPc = pc();
const esc = await oldPc.rkSeal({ recipient: await thirdPc.linkKey(), info: RK_ESCROW_INFO, aad });
await assert.rejects(thirdPc.rkImport({ ...esc, info: RK_LINK_INFO, aad, aikPub: aikOld }), /open_failed/);
assert.deepEqual(await thirdPc.rkImport({ ...esc, info: RK_ESCROW_INFO, aad, aikPub: aikOld }), aikOld);

const envAad = utf8('SAX-env-v1\u0001');
const q = hpkeSealBase((await oldPc.publicKeys()).qd, utf8('SAX-env-v1'), envAad, utf8('QUEUED'));
assert.deepEqual(await oldPc.hpkeOpen({ enc: q.enc, ct: q.ct, info: 'SAX-env-v1', aad: envAad }), utf8('QUEUED'));

assert.equal((await oldPc.noiseDH({ remotePub: r.pub, ctx: 'SAX-session-v1' })).length, 32);
assert.equal((await oldPc.signVd({ purpose: 'SAX-dpop-v1', msg: utf8('x') })).length, 64);
assert.equal((await oldPc.signAik({ purpose: 'SAX-acct-op-v1', msg: utf8('x') })).length, 64);
assert.equal((await oldPc.shareKey({ epoch: 0 })).key.length, 32);
assert.equal((await oldPc.signShare({ msg: utf8('x') })).length, 64);

const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
const spki = rsa.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const codefKey = codefPublicKey(spki);
assert.ok(codefKey, 'CODEF 공개키(DER SPKI)를 읽지 못했다');
assert.ok(codefPublicKey(rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString()), 'CODEF 공개키(PEM)를 읽지 못했다');
assert.equal(publicEncrypt({ key: codefKey, padding: cc.RSA_PKCS1_PADDING }, utf8('TEST-PW')).length, 256);

const lock = new LockKeyStore({
  backend: { items: new MemoryItemStore(), wrapper: new MemoryWrapper(), hello: new UnavailableHello() },
  log: new FileEventLog(null, 'vault'),
});
const ux = createECDH('prime256v1');
await lock.create();
await lock.setIdentity('pc-1', aikOld);
await lock.addPhone('phone-1', new Uint8Array(ux.generateKeys()));
const lockEmail = await lock.setEmail();
await lock.setRecovery(new Uint8Array(32).fill(9));
assert.equal(await lock.lock(), true);
const ask = await lock.phoneRequest('phone-1', 'screen');
assert.ok(ask.ok);
const z = new Uint8Array(ux.computeSecret(ask.request.e));
const grant = hpkeSealBase(ask.request.txPub, utf8(UNLOCK_GRANT_INFO), unlockGrantAad(ask.request.reqId, ask.request.n, 'pc-1', 'phone-1', ask.request.e), z);
assert.equal((await lock.phoneGrant({ reqId: ask.request.reqId, ...grant })).ok, true);
await lock.lock();
assert.equal((await lock.unlockEmail(lockEmail)).ok, true);
await lock.lock();
assert.equal((await lock.unlockRecovery(new Uint8Array(32).fill(9))).ok, true);

process.stdout.write(`vault-crypto-electron ok ${process.versions.electron}\n`);
