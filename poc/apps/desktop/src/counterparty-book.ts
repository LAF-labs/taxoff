import { randomUUID } from 'node:crypto';
import { COUNTERPARTY_ITEMS_MAX, isValidBizNo, type Counterparty as DbCounterparty, type CounterpartyItem } from '@sax/db';
import type { PhoneCounterpartySave } from '@sax/remote';
import type { BizFields } from './onboarding.ts';

export const CP_FIELD_MAX = { name: 100, bizNo: 20, rep: 100, email: 254, phone: 20, item: 100 } as const;
export const CP_CERT_HOLD_MS = 30 * 60_000;
/** 폰 저장에서 입력이 틀려 거절할 엔진 오류. 나머지 오류(엔진 꺼짐 등)는 그대로 올린다. */
const PHONE_SAVE_INVALID = new Set(['invalid_biz_no', 'own_biz_no', 'name_required', 'invalid_email', 'not_found']);

export type CpCertRead = BizFields | 'unreadable' | null;
type CpCertReply = { found: true; name: string; bizNo: string; rep: string; hold: string; item: string } | { found: false; reason: 'cancelled' | 'unreadable' };

type Rpc = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const text = (v: unknown, n: number) => String(v ?? '').trim().slice(0, n);
export const certItem = (s: string): string =>
  String(s ?? '')
    .split(/[,，、/·\n]/)[0]!
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CP_FIELD_MAX.item)
    .trim();

export class CounterpartyBook {
  private hold: { id: string; bizNo: string; address: string; at: number } | null = null;
  private reading = false;
  private readonly rpc: Rpc;
  private readonly read: () => Promise<CpCertRead>;
  private readonly now: () => number;
  constructor(rpc: Rpc, read: () => Promise<CpCertRead>, now: () => number = Date.now) {
    this.rpc = rpc;
    this.read = read;
    this.now = now;
  }

  async readCert(): Promise<CpCertReply> {
    if (this.reading) throw new Error('busy');
    this.reading = true;
    try {
      const f = await this.read();
      if (f === null) return { found: false, reason: 'cancelled' };
      if (f === 'unreadable') {
        this.hold = null;
        return { found: false, reason: 'unreadable' };
      }
      this.hold = { id: randomUUID(), bizNo: f.bizNo, address: f.address, at: this.now() };
      return { found: true, name: f.name.slice(0, CP_FIELD_MAX.name), bizNo: isValidBizNo(f.bizNo) ? f.bizNo : '', rep: f.rep.slice(0, CP_FIELD_MAX.rep), hold: this.hold.id, item: certItem(f.bizItem) };
    } finally {
      this.reading = false;
    }
  }

  async save(p: Record<string, unknown>): Promise<DbCounterparty> {
    const v = { name: text(p.name, CP_FIELD_MAX.name), repName: text(p.rep, CP_FIELD_MAX.rep) || null, email: text(p.email, CP_FIELD_MAX.email) || null, phone: text(p.phone, CP_FIELD_MAX.phone) || null };
    const id = typeof p.id === 'string' && p.id ? p.id : null;
    if (id) return (await this.rpc('counterparty.update', { id, patch: v })) as DbCounterparty;
    const bizNo = text(p.bizNo, CP_FIELD_MAX.bizNo).replace(/\D/g, '');
    const live = this.hold && this.now() - this.hold.at <= CP_CERT_HOLD_MS ? this.hold : null;
    const h = live && (live.bizNo === bizNo || (!isValidBizNo(live.bizNo) && typeof p.certHold === 'string' && p.certHold === live.id)) ? live : null;
    const saved = (await this.rpc('counterparty.create', { ...v, bizNo, source: h ? 'ocr' : 'manual', ...(h?.address ? { address: h.address } : {}) })) as DbCounterparty;
    if (h) this.hold = null;
    return saved;
  }

  /**
   * 폰이 보낸 거래처 저장(ADR-066). ref가 있으면 그 거래처를 고치고, 없으면 같은 등록번호를 찾아 그대로 돌려주거나 새로 넣는다.
   * 같은 번호가 이미 있으면 덮어쓰지 않는다(폰 사본은 100곳까지라 폰이 모르는 PC 거래처일 수 있다). 폰이 넣은 거래처면 빈 칸만 채운다.
   * 폰이 비워 보낸 칸(undefined)은 그대로 두고, 빈 글('')은 지운다. 등록번호는 고칠 수 없다.
   */
  async saveFromPhone(s: PhoneCounterpartySave): Promise<{ id: string; added: boolean } | 'unknown' | 'invalid'> {
    const bizNo = s.bizNo.replace(/\D/g, '');
    const keep = (v: string | undefined, cur: string | null, n: number) => (v === undefined ? cur : text(v, n) || null);
    try {
      if (s.ref) {
        const cur = (await this.rpc('db.query.counterparties.get', { id: s.ref })) as DbCounterparty | null;
        if (!cur) return 'unknown';
        if (cur.bizNo.replace(/\D/g, '') !== bizNo) return 'invalid';
        await this.rpc('counterparty.update', { id: cur.id, patch: { name: text(s.name, CP_FIELD_MAX.name), repName: keep(s.rep, cur.repName, CP_FIELD_MAX.rep), email: keep(s.email, cur.email, CP_FIELD_MAX.email) } });
        await this.setFirstItem(cur.id, s.item);
        return { id: cur.id, added: false };
      }
      const have = ((await this.rpc('db.query.counterparties.list')) as DbCounterparty[]).find((c) => c.bizNo.replace(/\D/g, '') === bizNo);
      if (have) {
        // 폰이 넣은 거래처면 빈 칸만 채운다: 등록번호로 먼저 발급한 뒤 늦게 온 저장의 대표자, 메일, 품목을 잃지 않게. PC 거래처는 건드리지 않는다.
        if (have.phoneAddedAt) {
          const fill = { ...(!have.repName && s.rep ? { repName: text(s.rep, CP_FIELD_MAX.rep) } : {}), ...(!have.email && s.email ? { email: text(s.email, CP_FIELD_MAX.email) } : {}) };
          if (Object.keys(fill).length) await this.rpc('counterparty.update', { id: have.id, patch: fill });
          if (s.item && !(await this.items(have.id)).length) await this.setFirstItem(have.id, s.item);
        }
        return { id: have.id, added: false };
      }
      const made = (await this.rpc('counterparty.create', { bizNo, name: text(s.name, CP_FIELD_MAX.name), repName: keep(s.rep, null, CP_FIELD_MAX.rep), email: keep(s.email, null, CP_FIELD_MAX.email), source: 'manual', phoneAdded: true })) as DbCounterparty;
      await this.setFirstItem(made.id, s.item);
      return { id: made.id, added: true };
    } catch (e) {
      if (PHONE_SAVE_INVALID.has((e as Error).message)) return 'invalid';
      throw e;
    }
  }

  async items(id: string): Promise<CounterpartyItem[]> {
    try {
      const r = await this.rpc('counterparty.getItems', { id });
      return Array.isArray(r) ? (r as CounterpartyItem[]) : [];
    } catch {
      return [];
    }
  }

  async setFirstItem(id: string, raw: unknown): Promise<void> {
    if (raw === null || raw === undefined) return;
    const name = text(raw, CP_FIELD_MAX.item);
    const cur = await this.items(id);
    const same = cur.find((i) => i.name === name);
    const rest = cur.slice(1).filter((i) => i.name !== name);
    const next = (name ? [same ?? { name, unitPrice: null, unit: null }, ...rest] : rest).slice(0, COUNTERPARTY_ITEMS_MAX);
    if (JSON.stringify(next) === JSON.stringify(cur)) return;
    await this.rpc('counterparty.setItems', { id, items: next });
  }
}
