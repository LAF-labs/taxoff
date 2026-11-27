import { hkdfSync, randomBytes } from 'node:crypto';
import { open, seal } from './backend.ts';

/**
 * 복구 코드와 그 코드로 잠근 계정 열쇠 사본 RKr(ADR-061 결정 8).
 * 코드는 120비트 무작위 값을 크록퍼드 base32 24글자(4글자씩 여섯 묶음)로 쓴 것이다. 서버는 RKr만 갖고, 코드가 무작위라 서버 자료로 맞혀 볼 수 없다.
 * RKr = salt(16) ‖ seal(HKDF(code, salt, "SAX-recovery-v1"), RK).
 */

export const RECOVERY_INFO = 'SAX-recovery-v1';
export const RECOVERY_CODE_GROUPS = 6;
const CODE_CHARS = 24;
const CODE_BYTES = 15;
const SALT_BYTES = 16;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 사람이 옮겨 적다 헷갈리는 글자를 맞추고(O→0, I L→1) 띄어쓰기와 줄표를 뺀다. 24글자 base32가 아니면 null. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === CODE_CHARS && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

function codeBytes(code: string): Uint8Array {
  const out = new Uint8Array(CODE_BYTES);
  let acc = 0;
  let bits = 0;
  let i = 0;
  for (const c of code) {
    acc = (acc << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[i++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

function codeKey(code: string, salt: Uint8Array): Uint8Array {
  const raw = codeBytes(code);
  try {
    return new Uint8Array(hkdfSync('sha256', raw, salt, RECOVERY_INFO, 32));
  } finally {
    raw.fill(0);
  }
}

export function newRecoveryCode(): string {
  const raw = new Uint8Array(randomBytes(CODE_BYTES));
  let acc = 0;
  let bits = 0;
  let s = '';
  for (const b of raw) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      s += ALPHABET[(acc >> bits) & 31];
    }
  }
  raw.fill(0);
  return s;
}

export const recoveryGroups = (code: string): string[] => Array.from({ length: RECOVERY_CODE_GROUPS }, (_, i) => code.slice(i * 4, i * 4 + 4));

export function sealRecovery(code: string, rk: Uint8Array): Uint8Array {
  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const k = codeKey(code, salt);
  try {
    return new Uint8Array(Buffer.concat([salt, seal(k, rk, RECOVERY_INFO)]));
  } finally {
    k.fill(0);
  }
}

/** 코드가 틀리거나 사본이 깨졌으면 던진다. */
export function openRecovery(code: string, rkr: Uint8Array): Uint8Array {
  if (rkr.length <= SALT_BYTES) throw new Error('open_failed');
  const k = codeKey(code, rkr.subarray(0, SALT_BYTES));
  try {
    return open(k, rkr.subarray(SALT_BYTES), RECOVERY_INFO);
  } finally {
    k.fill(0);
  }
}
