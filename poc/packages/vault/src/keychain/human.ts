import { randomBytes } from 'node:crypto';
import type { EventLog } from '@sax/platform';
import {
  isProfileScope, STORABLE_KINDS,
  type ConsentRecord, type KeyTier, type PortalField, type ProfileScope, type StorableKind, type StoredSecretInfo, type VaultLockReason,
} from '../protocol.ts';
import { ITEM_MAX_BYTES, open, seal, type KeychainBackend } from './backend.ts';
import { AccountRefreshStore } from './account.ts';
import { CodefPasswordStore } from './codef.ts';
import { LockKeyStore, type UnlockResult } from './lockkey.ts';
import { SessionLock, type SessionLockOptions } from './session.ts';

/** 칸 하나의 평문 상한(포털·인증서 비밀번호). 넘으면 거부한다. */
export const HUMAN_SECRET_MAX_BYTES = 256;

const INDEX_ITEM = 'index/human';
/** 옛 판의 엄격 모드 설정(ADR-026 결정 4). 이제는 설정 > 잠금의 여는 기기 스위치다. 기동 때 지운다. */
const RETIRED_STRICT_ITEM = 'settings/strict';

/**
 * 지원을 끝낸 보안카드 슬롯(대표 결정 2026-11-19). 옛 판의 색인 종류 이름, 슬롯 이름, 칸 번호 상한이다.
 * 기동 때 색인에 이 종류가 있으면 칸·KEK·동의 레코드를 지우고 색인에서 뺀다(purgeRetiredCard). 값은 읽지 않는다.
 */
export const RETIRED_CARD = { kind: 'security_card', slot: 'securitycard', rows: 35 } as const;

export const slotName = (kind: StorableKind, scope: ProfileScope): string => `${kind === 'cert_password' ? 'cert' : 'portal'}/${scope}`;
/** 슬롯 KEK 항목: 잠금 열쇠와 기기 결박으로 두 번 감싼 것 하나다(ADR-061 결정 5). */
export const slotKekItem = (slot: string): string => `kek/${slot}/lk`;
/** 옛 판의 슬롯 KEK 사본(기기 결박만, Hello). 처음 열릴 때 옮기고 지운다. */
const legacyKekItems = (slot: string): [device: string, hello: string] => [`kek/${slot}/device`, `kek/${slot}/hello`];

/** 사람 비밀의 KEK를 잠금 열쇠로 감싸고 푸는 길. 잠겨 있으면 open()이 false이고 감싸기와 풀기가 던진다. */
export interface SlotKeks {
  open(): boolean;
  wrap(kek: Uint8Array, label: string): Promise<Uint8Array>;
  unwrap(blob: Uint8Array, label: string): Promise<Uint8Array>;
}

export function itemName(kind: StorableKind, scope: ProfileScope, cell: { field?: PortalField }): string {
  if (cell.field !== 'pw') throw new Error('bad_cell');
  return `${slotName(kind, scope)}/${cell.field}`;
}

interface SlotIndex {
  v: 1;
  kind: StorableKind;
  scope: ProfileScope;
  cells: string[];
  tier: KeyTier;
  suspect: boolean;
}

export interface HumanVaultOptions extends SessionLockOptions {
  backend: KeychainBackend;
  log: EventLog;
}

/**
 * 꺼내기 결과. `vault_locked`는 금고가 닫혀 사람 확인(잠금 화면)이 필요할 때만이다.
 * `kek_unavailable`은 금고는 열렸지만 슬롯 KEK를 못 얻은 것(사본 없음, 다른 기기, 래핑 해제 실패)이다.
 */
export type ReadResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'vault_locked' | 'secret_missing' | 'credential_suspect' | 'corrupt' | 'kek_unavailable' };

export class HumanSecretVault implements SlotKeks {
  private readonly b: KeychainBackend;
  private readonly log: EventLog;
  readonly lock: SessionLock;
  readonly lk: LockKeyStore;
  private readonly keks = new Map<string, Uint8Array>();
  private indexP: Promise<Map<string, SlotIndex>> | null = null;
  private readonly readyP: Promise<void>;
  readonly account: AccountRefreshStore;
  readonly codef: CodefPasswordStore;

  constructor(opts: HumanVaultOptions) {
    this.b = opts.backend;
    this.log = opts.log;
    this.lk = new LockKeyStore({ backend: this.b, log: this.log, now: opts.now });
    this.lock = new SessionLock(opts);
    this.lock.guarded = () => this.lk.guarded;
    this.lock.onLock = (reason) => this.wipe(reason);
    this.readyP = this.boot();
    this.account = new AccountRefreshStore({ backend: this.b, ready: () => this.readyP, log: this.log });
    this.codef = new CodefPasswordStore({ backend: this.b, keks: this, ready: () => this.readyP, log: this.log });
  }

  /** 잠금 열쇠가 없으면 만들고, 첫 사본만 있으면 그것으로 연다. 사본이 있으면 잠긴 채로 둔다. */
  private async boot(): Promise<void> {
    await this.b.items.delete(RETIRED_STRICT_ITEM).catch(() => false);
    try {
      const s = await this.lk.state();
      if (!s.exists) await this.lk.create();
      else if (!s.guarded) await this.lk.openDevice();
    } catch {
      this.log.event('vault.lock_boot_failed');
      return;
    }
    if (this.lk.isOpen) await this.opened({ ok: true, via: 'device', scope: 'screen' });
  }

  ready(): Promise<void> {
    return this.readyP;
  }

  get tier(): KeyTier {
    return this.b.wrapper.tier;
  }

  open(): boolean {
    return this.lk.isOpen && this.lock.check().open;
  }

  wrap(kek: Uint8Array, label: string): Promise<Uint8Array> {
    return this.lk.wrapKek(kek, label);
  }

  unwrap(blob: Uint8Array, label: string): Promise<Uint8Array> {
    return this.lk.unwrapKek(blob, label);
  }

  /** 잠금 열쇠가 열린 뒤: 세션을 열고, 옛 슬롯 KEK를 옮기고, 이 PC 생체인식 사본이 없으면 만든다. */
  async opened(r: UnlockResult): Promise<UnlockResult> {
    if (!r.ok) return r;
    this.lock.opened(r.scope);
    await this.migrateLegacy().catch(() => this.log.event('vault.kek_migrate_failed', { why: 'index' }));
    await this.lk.ensureLocal().catch(() => this.log.event('vault.lock_local_failed'));
    return r;
  }

  private wipe(reason: VaultLockReason): void {
    for (const k of this.keks.values()) k.fill(0);
    this.log.event('vault.locked', { reason, slots: this.keks.size });
    this.keks.clear();
    this.lk.wipe();
  }

  /** 옛 판 슬롯 KEK(기기 결박만)를 잠금 열쇠 아래로 옮기고 옛 항목을 지운다. Hello 사본은 실제로 만든 적이 없어 지우기만 한다. */
  private async migrateLegacy(): Promise<void> {
    for (const s of (await this.index()).values()) {
      const slot = slotName(s.kind, s.scope);
      const [device, hello] = legacyKekItems(slot);
      const old = await this.b.items.get(device);
      if (old && !(await this.b.items.get(slotKekItem(slot)))) {
        let kek: Uint8Array;
        try {
          kek = await this.b.wrapper.unwrap(old, slot);
        } catch {
          this.log.event('vault.kek_migrate_failed', { why: 'unwrap' });
          continue;
        }
        try {
          await this.b.items.set(slotKekItem(slot), await this.wrap(kek, slot));
        } finally {
          kek.fill(0);
        }
        this.log.event('vault.kek_migrated', { kind: s.kind });
      }
      await this.b.items.delete(device);
      await this.b.items.delete(hello);
    }
  }

  private index(): Promise<Map<string, SlotIndex>> {
    this.indexP ??= (async () => {
      const raw = await this.b.items.get(INDEX_ITEM);
      const m = new Map<string, SlotIndex>();
      if (!raw) return m;
      const retired: Array<{ scope: ProfileScope; cells: number }> = [];
      try {
        const arr = JSON.parse(Buffer.from(raw).toString('utf8')) as Array<Omit<SlotIndex, 'kind'> & { kind: string }>;
        for (const s of arr) {
          if (s?.v !== 1 || !isProfileScope(s.scope)) continue;
          if (s.kind === RETIRED_CARD.kind) retired.push({ scope: s.scope, cells: Array.isArray(s.cells) ? s.cells.length : 0 });
          else if ((STORABLE_KINDS as readonly string[]).includes(s.kind)) m.set(slotName(s.kind as StorableKind, s.scope), s as SlotIndex);
        }
      } catch {
        this.log.event('vault.index_corrupt');
      }
      if (retired.length) await this.purgeRetiredCard(m, retired);
      return m;
    })();
    const p = this.indexP;
    p.catch(() => {
      if (this.indexP === p) this.indexP = null;
    });
    return p;
  }

  private async saveIndex(m: Map<string, SlotIndex>): Promise<void> {
    await this.b.items.set(INDEX_ITEM, new TextEncoder().encode(JSON.stringify([...m.values()])));
  }

  private async purgeRetiredCard(m: Map<string, SlotIndex>, retired: ReadonlyArray<{ scope: ProfileScope; cells: number }>): Promise<void> {
    try {
      for (const { scope } of retired) {
        const slot = `${RETIRED_CARD.slot}/${scope}`;
        for (let r = 1; r <= RETIRED_CARD.rows; r++) await this.b.items.delete(`${slot}/${r}`);
        for (const n of [...legacyKekItems(slot), `consent/${slot}`]) await this.b.items.delete(n);
      }
      await this.saveIndex(m);
      this.log.event('vault.card_purged', { items: retired.reduce((n, s) => n + s.cells, 0) });
    } catch {
      this.log.event('vault.card_purge_failed');
    }
  }

  async store(kind: StorableKind, scope: ProfileScope, entries: Array<{ field?: PortalField; bytes: Uint8Array }>, notice: { version: string }): Promise<ConsentRecord> {
    const wipe = () => entries.forEach((e) => e.bytes?.fill?.(0));
    try {
      if (!(STORABLE_KINDS as readonly string[]).includes(kind) || !isProfileScope(scope)) throw new Error('bad_slot');
      if (!entries.length) throw new Error('bad_entries');
      const names = entries.map((e) => itemName(kind, scope, e));
      if (new Set(names).size !== names.length) throw new Error('duplicate_cell');
      for (const e of entries) if (!(e.bytes instanceof Uint8Array) || e.bytes.length === 0 || e.bytes.length > HUMAN_SECRET_MAX_BYTES) throw new Error('bad_value');
      if (kind === 'portal_password' && !names.some((n) => n.endsWith('/pw'))) throw new Error('portal_pw_required');
      await this.readyP;
      if (!this.open()) throw new Error('vault_locked');

      const slot = slotName(kind, scope);
      const backup = await this.snapshotSlot(kind, scope);
      const kek = new Uint8Array(randomBytes(32));
      try {
        await this.forget(kind, scope, 'replace');
        await this.b.items.set(slotKekItem(slot), await this.wrap(kek, slot));
        for (let i = 0; i < entries.length; i++) {
          const blob = seal(kek, entries[i]!.bytes, names[i]!);
          if (blob.length > ITEM_MAX_BYTES) throw new Error('vault.item_too_large');
          await this.b.items.set(names[i]!, blob);
        }
        const consent: ConsentRecord = { v: 1, kind, scope, items: entries.length, tier: this.tier, noticeVersion: notice.version, at: new Date().toISOString(), via: 'T-06' };
        await this.b.items.set(`consent/${slot}`, new TextEncoder().encode(JSON.stringify(consent)));
        const idx = await this.index();
        idx.set(slot, { v: 1, kind, scope, cells: names, tier: this.tier, suspect: false });
        await this.saveIndex(idx);
        this.log.event('vault.secret_stored', { kind, items: entries.length, tier: this.tier });
        return consent;
      } catch (e) {
        await this.forget(kind, scope, 'replace').catch(() => {});
        await this.restoreSlot(kind, scope, backup).catch(() => this.log.event('vault.restore_failed', { kind }));
        throw e;
      } finally {
        kek.fill(0);
      }
    } finally {
      wipe();
    }
  }

  private async snapshotSlot(kind: StorableKind, scope: ProfileScope): Promise<{ info: SlotIndex; items: Array<[string, Uint8Array]> } | null> {
    const slot = slotName(kind, scope);
    const info = (await this.index()).get(slot);
    if (!info) return null;
    const items: Array<[string, Uint8Array]> = [];
    for (const n of [...info.cells, slotKekItem(slot), `consent/${slot}`]) {
      const raw = await this.b.items.get(n);
      if (raw) items.push([n, raw]);
    }
    return { info: { ...info, cells: [...info.cells] }, items };
  }

  private async restoreSlot(kind: StorableKind, scope: ProfileScope, backup: Awaited<ReturnType<HumanSecretVault['snapshotSlot']>>): Promise<void> {
    if (!backup) return;
    for (const [n, raw] of backup.items) await this.b.items.set(n, raw);
    const idx = await this.index();
    idx.set(slotName(kind, scope), backup.info);
    await this.saveIndex(idx);
  }

  async readOne(kind: StorableKind, scope: ProfileScope, cell: { field?: PortalField }): Promise<ReadResult> {
    let name: string;
    try {
      name = itemName(kind, scope, cell);
    } catch {
      return { ok: false, reason: 'secret_missing' };
    }
    await this.readyP;
    const slot = slotName(kind, scope);
    const info = (await this.index()).get(slot);
    if (!info || !info.cells.includes(name)) return { ok: false, reason: 'secret_missing' };
    if (info.suspect) return { ok: false, reason: 'credential_suspect' };
    if (!this.open()) return { ok: false, reason: 'vault_locked' };
    const got = await this.slotKek(slot, info);
    if (!('kek' in got)) return { ok: false, reason: got.reason };
    const kek = got.kek;
    const blob = await this.b.items.get(name);
    if (!blob) return { ok: false, reason: 'secret_missing' };
    try {
      return { ok: true, bytes: open(kek, blob, name) };
    } catch {
      this.log.event('vault.item_corrupt', { kind });
      return { ok: false, reason: 'corrupt' };
    }
  }

  private async slotKek(slot: string, info: SlotIndex): Promise<{ kek: Uint8Array } | { reason: 'vault_locked' | 'kek_unavailable' }> {
    const cached = this.keks.get(slot);
    if (cached) return { kek: cached };
    const wrapped = await this.b.items.get(slotKekItem(slot));
    if (!wrapped) {
      this.log.event('vault.kek_unwrap_failed', { tier: info.tier, why: 'missing' });
      return { reason: 'kek_unavailable' };
    }
    let kek: Uint8Array;
    try {
      kek = await this.unwrap(wrapped, slot);
    } catch {
      if (!this.open()) return { reason: 'vault_locked' };
      this.log.event('vault.kek_unwrap_failed', { tier: info.tier, why: 'unwrap' });
      return { reason: 'kek_unavailable' };
    }
    if (!this.open()) {
      kek.fill(0);
      return { reason: 'vault_locked' };
    }
    this.keks.set(slot, kek);
    return { kek };
  }

  async has(kind: StorableKind, scope: ProfileScope): Promise<boolean> {
    return (await this.index()).has(slotName(kind, scope));
  }

  async list(): Promise<StoredSecretInfo[]> {
    const out: StoredSecretInfo[] = [];
    for (const s of (await this.index()).values()) {
      const raw = await this.b.items.get(`consent/${slotName(s.kind, s.scope)}`);
      let at = '';
      try {
        at = raw ? String((JSON.parse(Buffer.from(raw).toString('utf8')) as ConsentRecord).at) : '';
      } catch {
        // 동의 레코드가 깨졌으면 시각만 비운다
      }
      out.push({ kind: s.kind, scope: s.scope, items: s.cells.length, tier: s.tier, suspect: s.suspect, consentAt: at });
    }
    return out;
  }

  async consent(kind: StorableKind, scope: ProfileScope): Promise<ConsentRecord | null> {
    const raw = await this.b.items.get(`consent/${slotName(kind, scope)}`);
    if (!raw) return null;
    return JSON.parse(Buffer.from(raw).toString('utf8')) as ConsentRecord;
  }

  async forget(kind: StorableKind, scope: ProfileScope, why: 'user' | 'replace' = 'user'): Promise<boolean> {
    const slot = slotName(kind, scope);
    const idx = await this.index();
    const info = idx.get(slot);
    const names = new Set(info?.cells ?? []);
    for (const f of ['id', 'pw']) names.add(`${slot}/${f}`);
    for (const n of [...names, slotKekItem(slot), ...legacyKekItems(slot), `consent/${slot}`]) await this.b.items.delete(n);
    this.keks.get(slot)?.fill(0);
    this.keks.delete(slot);
    if (info) {
      idx.delete(slot);
      await this.saveIndex(idx);
      if (why === 'user') this.log.event('vault.secret_forgotten', { kind });
    }
    return !!info;
  }

  async markSuspect(kind: StorableKind, scope: ProfileScope): Promise<boolean> {
    const idx = await this.index();
    const info = idx.get(slotName(kind, scope));
    if (!info || info.suspect) return false;
    info.suspect = true;
    try {
      await this.saveIndex(idx);
    } catch (e) {
      info.suspect = false;
      throw e;
    }
    this.log.event('vault.credential_suspect', { kind });
    return true;
  }
}
