import { spawn } from 'node:child_process';
import type { HelloPrompt, HelloProvider } from './backend.ts';
import { p256HpkeOpenWithZ, p256HpkeSeal } from './lockkey.ts';

/**
 * 맥 Touch ID 사본(ADR-061 결정 5 "이 PC 사본"). 감쌀 때마다 보안칩(Secure Enclave)에 새 P-256 키를 만들고 그 공개키로 봉인한다.
 * 키의 접근 제어는 privateKeyUsage + biometryCurrentSet, 이 기기 전용이라 맥 로그인 암호로는 쓸 수 없고 지문을 새로 등록하면 죽는다.
 * 보안칩 키는 CryptoKit만 다룰 수 있어 작은 Swift 도우미(native/mac/touchid.swift)를 부른다. 도우미는 ECDH 결과(Z)만 돌려주고 LK는 보지 않는다.
 * 봉인문 = 1 ‖ u16 키 길이 ‖ 보안칩 키 묶음 ‖ 공개키(65) ‖ E(65) ‖ ct.
 */

const INFO = new TextEncoder().encode('SAX-touchid-v1');
const P256_POINT = 65;
const HELPER_TIMEOUT_MS = 120_000;

type HelperOut = { available?: boolean; pub?: string; key?: string; z?: string; error?: string };

export class MacTouchIdHello implements HelloProvider {
  private readonly helper: string;

  constructor(helperPath: string) {
    this.helper = helperPath;
  }

  private run(req: Record<string, string>): Promise<HelperOut> {
    return new Promise((resolve, reject) => {
      const p = spawn(this.helper, [], { stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      const timer = setTimeout(() => p.kill(), HELPER_TIMEOUT_MS);
      p.stdout.on('data', (c: Buffer) => chunks.push(c));
      p.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      p.on('close', () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as HelperOut);
        } catch {
          reject(new Error('vault.hello_helper_failed'));
        } finally {
          for (const c of chunks) c.fill(0);
        }
      });
      p.stdin.end(JSON.stringify(req));
    });
  }

  async available(): Promise<boolean> {
    return (await this.run({ op: 'available' }).catch(() => ({}) as HelperOut)).available === true;
  }

  async wrap(secret: Uint8Array, label: string): Promise<Uint8Array> {
    const r = await this.run({ op: 'create' });
    if (!r.pub || !r.key) throw new Error('vault.hello_unavailable');
    const pub = new Uint8Array(Buffer.from(r.pub, 'base64'));
    const key = Buffer.from(r.key, 'base64');
    if (key.length > 0xffff) throw new Error('vault.hello_helper_failed');
    const { enc, ct } = p256HpkeSeal(pub, INFO, new TextEncoder().encode(label), secret);
    return new Uint8Array(Buffer.concat([Buffer.of(1, key.length >> 8, key.length & 0xff), key, pub, enc, ct]));
  }

  /** 사람이 취소하면 null. 지문을 새로 등록해 키가 죽었거나 봉인문이 깨졌으면 던진다. */
  async unwrap(blob: Uint8Array, label: string, prompt: HelloPrompt): Promise<Uint8Array | null> {
    const b = Buffer.from(blob);
    if (b.length < 3 || b[0] !== 1) throw new Error('vault.item_corrupt');
    const keyLen = (b[1]! << 8) | b[2]!;
    const at = 3 + keyLen;
    if (b.length < at + 2 * P256_POINT + 16) throw new Error('vault.item_corrupt');
    const key = b.subarray(3, at);
    const pub = new Uint8Array(b.subarray(at, at + P256_POINT));
    const e = new Uint8Array(b.subarray(at + P256_POINT, at + 2 * P256_POINT));
    const ct = new Uint8Array(b.subarray(at + 2 * P256_POINT));
    const r = await this.run({ op: 'derive', key: key.toString('base64'), e: Buffer.from(e).toString('base64'), reason: prompt.task });
    if (r.error === 'cancelled') return null;
    if (!r.z) throw new Error('vault.hello_invalid');
    const z = new Uint8Array(Buffer.from(r.z, 'base64'));
    try {
      return p256HpkeOpenWithZ(z, pub, e, INFO, new TextEncoder().encode(label), ct);
    } finally {
      z.fill(0);
    }
  }
}
