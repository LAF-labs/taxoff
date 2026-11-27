import { createHash, createPrivateKey, hkdfSync, timingSafeEqual, type KeyObject } from 'node:crypto';
import { key32 } from '@sax/svc-shared';
import { hpkeOpen, hpkeSeal, rawPublic, x25519Priv } from './hpke.ts';

export { hpkeOpen, hpkeSeal };

export const RK_ESCROW_INFO = 'SAX-rk-escrow-v1';
const STORE_AAD = 'SAX-rk-escrow-store-v1';
const CLAIM_AAD = 'SAX-rk-escrow-claim-v1';

const ED25519_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const EMPTY = Buffer.alloc(0);

const sha256 = (...parts: Uint8Array[]) => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
/** 맡길 때의 aad(@sax/remote escrowStoreAad와 같다) */
export const escrowStoreAad = (aikPub: Uint8Array): Buffer => sha256(Buffer.from(STORE_AAD), aikPub);
/** 받을 때의 aad(@sax/remote escrowClaimAad와 같다) */
export const escrowClaimAad = (aikPub: Uint8Array, deviceId: string, linkPub: Uint8Array): Buffer => sha256(Buffer.from(CLAIM_AAD), aikPub, Buffer.from(deviceId, 'utf8'), linkPub);

function aikPubOf(rk: Uint8Array): Buffer {
  const seed = Buffer.from(hkdfSync('sha256', rk, EMPTY, 'aik', 32));
  try {
    return rawPublic(createPrivateKey({ key: Buffer.concat([ED25519_PKCS8, seed]), format: 'der', type: 'pkcs8' }));
  } finally {
    seed.fill(0);
  }
}

export class KeyEscrow {
  private readonly key: KeyObject;
  private readonly pub: Buffer;
  readonly publicKey: string;
  constructor(seed: Uint8Array) {
    this.key = x25519Priv(seed);
    this.pub = rawPublic(this.key);
    this.publicKey = this.pub.toString('base64');
  }
  static fromSeedHex(hex: string | undefined): KeyEscrow {
    const seed = key32(hex, 'KEY_ESCROW_KEY');
    try {
      return new KeyEscrow(seed);
    } finally {
      seed.fill(0);
    }
  }

  private open(enc: Uint8Array, ct: Uint8Array, aikPub: Uint8Array): Buffer | null {
    let rk: Buffer;
    try {
      rk = hpkeOpen(this.key, this.pub, enc, Buffer.from(RK_ESCROW_INFO), escrowStoreAad(aikPub), ct);
    } catch {
      return null;
    }
    if (rk.length === 32 && timingSafeEqual(aikPubOf(rk), aikPub)) return rk;
    rk.fill(0);
    return null;
  }

  holds(enc: Uint8Array, ct: Uint8Array, aikPub: Uint8Array): boolean {
    const rk = this.open(enc, ct, aikPub);
    rk?.fill(0);
    return !!rk;
  }

  reseal(enc: Uint8Array, ct: Uint8Array, aikPub: Uint8Array, deviceId: string, linkPub: Uint8Array): { enc: Buffer; ct: Buffer } | null {
    const rk = this.open(enc, ct, aikPub);
    if (!rk) return null;
    try {
      return hpkeSeal(linkPub, Buffer.from(RK_ESCROW_INFO), escrowClaimAad(aikPub, deviceId, linkPub), rk);
    } finally {
      rk.fill(0);
    }
  }
}
