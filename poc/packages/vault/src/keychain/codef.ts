import { randomBytes } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import type { ProfileScope } from '../protocol.ts';
import { ITEM_MAX_BYTES, open as openSealed, seal, type KeychainBackend } from './backend.ts';
import type { SlotKeks } from './human.ts';

export const CODEF_CERT_ID_RE = /^[0-9a-f]{16}$/;
/** 인증서 비밀번호 평문 상한(바이트) */
export const CODEF_PASSWORD_MAX_BYTES = 128;

export const codefItem = (scope: ProfileScope, certId: string): string => `codef/${scope}/${certId}`;
export const codefKekItem = (scope: ProfileScope, certId: string): string => `kek/codef/${scope}/${certId}/lk`;
/** 옛 판의 KEK 사본(기기 결박만). 열린 금고에서 처음 읽을 때 옮기고 지운다. */
const legacyCodefKekItem = (scope: ProfileScope, certId: string): string => `kek/codef/${scope}/${certId}/device`;

export type CodefPasswordRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'vault_locked' | 'missing' | 'corrupt' | 'kek_unavailable' };

interface CodefStoreOptions {
  backend: KeychainBackend;
  keks: SlotKeks;
  ready: () => Promise<void>;
  log: EventLog;
}

export class CodefPasswordStore {
  private readonly o: CodefStoreOptions;
  constructor(o: CodefStoreOptions) {
    this.o = o;
  }

  private async kek(scope: ProfileScope, certId: string, name: string): Promise<Uint8Array | null> {
    const b = this.o.backend;
    const wrapped = await b.items.get(codefKekItem(scope, certId));
    if (wrapped) return this.o.keks.unwrap(wrapped, name).catch(() => null);
    const old = await b.items.get(legacyCodefKekItem(scope, certId));
    if (!old) return null;
    const kek = await b.wrapper.unwrap(old, name).catch(() => null);
    if (!kek) return null;
    await b.items.set(codefKekItem(scope, certId), await this.o.keks.wrap(kek, name));
    await b.items.delete(legacyCodefKekItem(scope, certId));
    this.o.log.event('vault.kek_migrated', { kind: 'codef' });
    return kek;
  }

  private check(certId: string): void {
    if (typeof certId !== 'string' || !CODEF_CERT_ID_RE.test(certId)) throw new Error('bad_cert');
  }

  async read(scope: ProfileScope, certId: string): Promise<CodefPasswordRead> {
    this.check(certId);
    await this.o.ready();
    if (!this.o.keks.open()) return { ok: false, reason: 'vault_locked' };
    const name = codefItem(scope, certId);
    const blob = await this.o.backend.items.get(name);
    if (!blob) return { ok: false, reason: 'missing' };
    const kek = await this.kek(scope, certId, name);
    if (!kek) return { ok: false, reason: this.o.keks.open() ? 'kek_unavailable' : 'vault_locked' };
    try {
      const pt = openSealed(kek, blob, name);
      if (pt.length === 0 || pt.length > CODEF_PASSWORD_MAX_BYTES) {
        pt.fill(0);
        return { ok: false, reason: 'corrupt' };
      }
      if (!this.o.keks.open()) {
        pt.fill(0);
        return { ok: false, reason: 'vault_locked' };
      }
      return { ok: true, bytes: pt };
    } catch {
      return { ok: false, reason: 'corrupt' };
    } finally {
      kek.fill(0);
    }
  }

  async write(scope: ProfileScope, certId: string, bytes: Uint8Array): Promise<'ok' | 'vault_locked' | 'kek_unavailable' | 'write_failed'> {
    this.check(certId);
    if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > CODEF_PASSWORD_MAX_BYTES) throw new Error('bad_params');
    await this.o.ready();
    if (!this.o.keks.open()) return 'vault_locked';
    const name = codefItem(scope, certId);
    const kek = new Uint8Array(randomBytes(32));
    try {
      let wrapped: Uint8Array;
      try {
        wrapped = await this.o.keks.wrap(kek, name);
      } catch {
        return 'kek_unavailable';
      }
      const blob = seal(kek, bytes, name);
      if (blob.length > ITEM_MAX_BYTES) return 'write_failed';
      await this.o.backend.items.set(codefKekItem(scope, certId), wrapped);
      await this.o.backend.items.set(name, blob);
      this.o.log.event('vault.codef_password_stored');
      return 'ok';
    } catch {
      return 'write_failed';
    } finally {
      kek.fill(0);
    }
  }

  async forget(scope: ProfileScope, certId: string): Promise<boolean> {
    this.check(certId);
    const a = await this.o.backend.items.delete(codefItem(scope, certId)).catch(() => false);
    const b = await this.o.backend.items.delete(codefKekItem(scope, certId)).catch(() => false);
    const c = await this.o.backend.items.delete(legacyCodefKekItem(scope, certId)).catch(() => false);
    if (a || b || c) this.o.log.event('vault.codef_password_forgotten');
    return a || b || c;
  }

  async has(scope: ProfileScope, certId: string): Promise<boolean> {
    this.check(certId);
    return (await this.o.backend.items.get(codefItem(scope, certId))) !== null;
  }
}
