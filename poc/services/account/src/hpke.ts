import { createCipheriv, createDecipheriv, createHmac, createPrivateKey, createPublicKey, diffieHellman, randomBytes, type KeyObject } from 'node:crypto';

/** HPKE Base(RFC 9180): DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, ChaCha20-Poly1305. 금고의 hpkeSealBase와 같은 스위트다. */
const X25519_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');

export const rawPublic = (priv: KeyObject): Buffer => {
  const der = createPublicKey(priv).export({ format: 'der', type: 'spki' });
  return Buffer.from(der.subarray(der.length - 32));
};
export const x25519Priv = (seed: Uint8Array) => createPrivateKey({ key: Buffer.concat([X25519_PKCS8, seed]), format: 'der', type: 'pkcs8' });

function dh(priv: KeyObject, pub: Uint8Array): Buffer {
  let out: Buffer;
  try {
    out = diffieHellman({ privateKey: priv, publicKey: createPublicKey({ key: Buffer.concat([X25519_SPKI, pub]), format: 'der', type: 'spki' }) });
  } catch {
    throw new Error('bad_point');
  }
  if (out.every((b) => b === 0)) throw new Error('bad_point');
  return out;
}

const i2osp = (n: number, len: number) => {
  const b = Buffer.alloc(len);
  b.writeUIntBE(n, 0, len);
  return b;
};
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), i2osp(0x0020, 2)]);
const HPKE_SUITE = Buffer.concat([Buffer.from('HPKE'), i2osp(0x0020, 2), i2osp(0x0001, 2), i2osp(0x0003, 2)]);
const EMPTY = Buffer.alloc(0);

const extract = (salt: Uint8Array, ikm: Uint8Array) => createHmac('sha256', salt).update(ikm).digest();
function expand(prk: Uint8Array, info: Uint8Array, len: number): Buffer {
  const out: Buffer[] = [];
  let t: Buffer = EMPTY;
  for (let i = 1; out.length * 32 < len; i++) {
    t = createHmac('sha256', prk).update(Buffer.concat([t, info, Buffer.from([i])])).digest();
    out.push(t);
  }
  return Buffer.concat(out).subarray(0, len);
}
const labeledExtract = (suite: Buffer, salt: Uint8Array, label: string, ikm: Uint8Array) => extract(salt, Buffer.concat([Buffer.from('HPKE-v1'), suite, Buffer.from(label), ikm]));
const labeledExpand = (suite: Buffer, prk: Uint8Array, label: string, info: Uint8Array, len: number) =>
  expand(prk, Buffer.concat([i2osp(len, 2), Buffer.from('HPKE-v1'), suite, Buffer.from(label), info]), len);

function hpkeKeys(shared0: Buffer, encap: Uint8Array, pkR: Uint8Array, info: Uint8Array): { key: Buffer; nonce: Buffer } {
  const eaePrk = labeledExtract(KEM_SUITE, EMPTY, 'eae_prk', shared0);
  const shared = labeledExpand(KEM_SUITE, eaePrk, 'shared_secret', Buffer.concat([encap, pkR]), 32);
  const ksContext = Buffer.concat([Buffer.from([0]), labeledExtract(HPKE_SUITE, EMPTY, 'psk_id_hash', EMPTY), labeledExtract(HPKE_SUITE, EMPTY, 'info_hash', info)]);
  const secret = labeledExtract(HPKE_SUITE, shared, 'secret', EMPTY);
  try {
    return { key: labeledExpand(HPKE_SUITE, secret, 'key', ksContext, 32), nonce: labeledExpand(HPKE_SUITE, secret, 'base_nonce', ksContext, 12) };
  } finally {
    for (const b of [shared0, eaePrk, shared, secret]) b.fill(0);
  }
}

/** 단발 봉인. 결과 {enc 32B, ct = 암호문 ‖ 태그 16B}. skE는 시험 벡터용이다. */
export function hpkeSeal(pkR: Uint8Array, info: Uint8Array, aad: Uint8Array, pt: Uint8Array, skE?: Uint8Array): { enc: Buffer; ct: Buffer } {
  const seed = skE ? Buffer.from(skE) : randomBytes(32);
  try {
    const e = x25519Priv(seed);
    const enc = rawPublic(e);
    const { key, nonce } = hpkeKeys(dh(e, pkR), enc, pkR, info);
    try {
      const c = createCipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
      c.setAAD(aad, { plaintextLength: pt.length });
      return { enc, ct: Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]) };
    } finally {
      key.fill(0);
    }
  } finally {
    seed.fill(0);
  }
}

/** 단발 개봉. 실패는 Error('open_failed'). */
export function hpkeOpen(skR: KeyObject, pkR: Uint8Array, encap: Uint8Array, info: Uint8Array, aad: Uint8Array, ct: Uint8Array): Buffer {
  let k: { key: Buffer; nonce: Buffer };
  try {
    k = hpkeKeys(dh(skR, encap), encap, pkR, info);
  } catch {
    throw new Error('open_failed');
  }
  try {
    if (ct.length < 16) throw new Error('short');
    const d = createDecipheriv('chacha20-poly1305', k.key, k.nonce, { authTagLength: 16 });
    d.setAAD(aad, { plaintextLength: ct.length - 16 });
    d.setAuthTag(ct.subarray(ct.length - 16));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  } catch {
    throw new Error('open_failed');
  } finally {
    k.key.fill(0);
  }
}

