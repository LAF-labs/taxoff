import { isValidBizNo } from '@sax/db';
import { isIsoDay, issueDateRule } from '@sax/chat-core';
import { BULK_ROWS_PER_RUN, bulkTotals, type BulkParty, type BulkRow } from './core/bulk.ts';
import { jcs, sha256hex, type ReadbackKey } from './gate.ts';
import { RunEnd } from './run-end.ts';

/** 홈택스 일괄발급 플레이북 id(ADR-063). */
export const BULK_PLAYBOOK_ID = 'hometax.invoice.bulk';

/** startBulk 한 줄. 거래처 값은 앱이 거래처 목록에서 맞춘 것(번호, 상호, 대표자)이다. 작성일은 YYYY-MM-DD. */
export interface BulkStartRow {
  buyer: { bizNo: string; name: string; repName: string; email?: string | null };
  writeDate: string;
  item: string;
  supply: number;
  tax: number;
  receipt?: 'receipt' | 'claim';
}

export interface BulkStartParams {
  runId: string;
  rows: BulkStartRow[];
  rehearsal?: boolean;
}

export interface BulkPlan {
  rows: BulkRow[];
  supplier: BulkParty;
  /** 줄마다 건별 발급과 같은 식의 사업 키(장부 $dup.businessKey와 일괄 줄 표가 같이 쓴다). */
  keys: string[];
  rowsHash: string;
  total: string;
  count: string;
  first: string;
}

const MAX_AMOUNT = 999_999_999_999_999;
const text = (s: unknown) => String(s ?? '').normalize('NFC').trim();
/** 홈택스 칸 길이는 바이트(한글 2). 넘는 값은 자르지 않고 막는다(잘린 상호로 발급하지 않는다). */
const bytes = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) < 0x80 ? 1 : 2), 0);
const fits = (s: string, max: number) => s !== '' && bytes(s) <= max;

/**
 * 줄을 다시 검사해 금고와 플레이북이 받는 모양으로 바꾼다. 하나라도 틀리면 시작하지 않는다(`bulk.bad_row:<줄>`).
 * 작성일은 오늘이거나 지난날이어야 하고 발급기한(다음 달 10일) 안이어야 한다. 기한이 지난 줄은 홈택스가 줄마다 묻고 [취소]하면 빼는데,
 * 엔진은 모르는 확인창을 닫으므로 그 줄이 빠지고 건수가 어긋나 아무것도 보내지 않는다. 그래서 시작에서 막는다(앱이 확인할 건으로 보인다).
 * 사업 키 식(businessKey)은 RunService가 넘긴다(h01은 runs.ts만 import한다, 승격 점검 (라)).
 */
export function bulkPlan(profile: { bizNo: string | null; displayName: string; repName: string | null }, rows: unknown, today: string, businessKey: (rb: Readonly<Record<ReadbackKey, string>>) => string): BulkPlan {
  if (!profile.bizNo || !isValidBizNo(profile.bizNo) || !profile.repName?.trim() || !profile.displayName.trim()) throw new RunEnd('failed', 'profile_missing');
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > BULK_ROWS_PER_RUN) throw new RunEnd('failed', 'bulk.bad_rows');
  const supplier: BulkParty = { bizNo: profile.bizNo, name: text(profile.displayName), repName: text(profile.repName) };
  if (!fits(supplier.name, 70) || !fits(supplier.repName, 30)) throw new RunEnd('failed', 'profile_missing');
  const out: BulkRow[] = [];
  const keys: string[] = [];
  for (const [i, x] of (rows as BulkStartRow[]).entries()) {
    const bad = (why: string) => new RunEnd('failed', `bulk.${why}:${i + 1}`);
    const b = x?.buyer;
    const bizNo = String(b?.bizNo ?? '').replace(/\D/g, '');
    if (!isValidBizNo(bizNo) || bizNo === supplier.bizNo) throw bad('bad_bizno');
    const name = text(b?.name);
    const repName = text(b?.repName);
    if (!name || !repName) throw bad('party_missing');
    if (!fits(name, 70) || !fits(repName, 30)) throw bad('too_long');
    const date = String(x?.writeDate ?? '');
    if (!isIsoDay(date)) throw bad('bad_date');
    const rule = issueDateRule(date, today);
    if (rule !== 'ok') throw bad(rule === 'late' ? 'issue_late' : 'bad_date');
    const item = text(x?.item);
    if (!item) throw bad('item_missing');
    if (!fits(item, 100)) throw bad('too_long');
    const ok = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= MAX_AMOUNT;
    if (!ok(x?.supply) || !ok(x?.tax) || x.supply === 0) throw bad('bad_amount');
    const email = typeof b?.email === 'string' && b.email.trim() ? b.email.trim() : undefined;
    out.push({ writeDate: date.replace(/-/g, ''), buyer: { bizNo, name, repName, ...(email ? { email } : {}) }, item, supply: x.supply, tax: x.tax, receipt: x.receipt === 'receipt' ? '01' : '02' });
    keys.push(businessKey({ supplierBizNo: supplier.bizNo, counterpartBizNo: bizNo, supplyAmount: String(x.supply), taxAmount: String(x.tax), issueDate: date, itemName: item } as Readonly<Record<ReadbackKey, string>>));
  }
  if (new Set(keys).size !== keys.length) throw new RunEnd('failed', 'bulk.duplicate_rows');
  const t = bulkTotals(out);
  return { rows: out, supplier, keys, rowsHash: sha256hex(jcs({ supplier, rows: out })), total: t.total, count: t.count, first: out[0]!.buyer.name };
}
