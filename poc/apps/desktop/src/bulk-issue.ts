import { isIsoDay } from '@sax/chat-core';
import { isValidBizNo } from '@sax/db';
import { INVOICE_ROLES, parseInvoiceBatch, parseInvoiceText, sniffFormat, type InvoiceBatchParse, type InvoiceDraftRow, type InvoiceMapping, type SheetOutput } from '@sax/docparse';

/** 여러 건 발급(ADR-059 결정 2): 입력창에 붙인 파일이나 붙여 넣은 표를 읽어 묶음 카드의 행으로 바꾼다. 발급은 하지 않는다. */

export const BULK_FILE_MAX = 10 * 1024 * 1024;
/** base64는 4/3배라 파일 상한보다 조금 크게 받는다 */
export const BULK_DATA_MAX = Math.ceil((BULK_FILE_MAX * 4) / 3) + 4;
export const BULK_TEXT_MAX = 400_000;
const SHEET_FORMATS = new Set(['xlsx', 'xls', 'csv', 'html']);

/** 화면이 그리는 한 건. 확인할 이유는 렌더러(bulk-model.js)가 거래처 목록과 맞춰 정한다. */
export interface BulkRow {
  key: string;
  line: number;
  name: string;
  bizNo: string | null;
  date: string | null;
  item: string;
  supply: number | null;
  vat: number | null;
  taxable: boolean;
  fileIssues: string[];
}

/** 국세청 사업자 상태(휴폐업 조회). 01 계속, 02 휴업, 03 폐업, 빈 값은 국세청에 없는 번호. 조회하지 못한 번호는 싣지 않는다. */
export type BizStatusCode = '01' | '02' | '03' | '';

export type BulkRead =
  | { kind: 'rows'; source: 'file' | 'text'; rows: BulkRow[]; assumedSupply: boolean; status?: Record<string, BizStatusCode> }
  /** 거래처나 금액 칸을 못 찾았다(결정 2). 앞 몇 줄을 보여 사람이 칸을 고른다. */
  | { kind: 'pick'; sheet: string; headers: string[]; sample: string[][] }
  | { kind: 'none'; reason: 'header_not_found' | 'no_rows' | 'not_sheet' | 'too_big' };

export function bulkRows(p: InvoiceBatchParse, source: 'file' | 'text', sheet?: string | null): BulkRead {
  if (p.warnings.includes('header_not_found')) {
    if (sheet && p.sample.length >= 1 && p.sample.some((r) => r.length >= 2)) return { kind: 'pick', sheet, headers: p.headers.slice(0, 40), sample: p.sample.map((r) => r.slice(0, 40)) };
    return { kind: 'none', reason: 'header_not_found' };
  }
  if (!p.rows.length) return { kind: 'none', reason: 'no_rows' };
  const rows = p.rows.map((r: InvoiceDraftRow, i): BulkRow => ({
    key: `r${i + 1}`,
    line: r.line,
    name: r.name ?? '',
    bizNo: r.bizNo,
    date: r.date,
    item: r.lines[0]?.item ?? r.memo ?? '',
    supply: r.supply,
    vat: r.vat,
    taxable: r.taxType === 'taxable',
    fileIssues: [...r.issues],
  }));
  return { kind: 'rows', source, rows, assumedSupply: p.amountBasis === 'assumed_supply' };
}

export interface BulkPorts {
  readSheet: (bytes: Uint8Array) => Promise<SheetOutput>;
  today: () => string;
}

export async function readBulkFile(data: string, ports: BulkPorts, mapping: InvoiceMapping | null = null): Promise<BulkRead> {
  const bytes = Uint8Array.from(Buffer.from(data, 'base64'));
  if (!bytes.length || bytes.length > BULK_FILE_MAX) return { kind: 'none', reason: 'too_big' };
  const f = sniffFormat(bytes);
  if (!('format' in f) || !SHEET_FORMATS.has(f.format)) return { kind: 'none', reason: 'not_sheet' };
  const out = await ports.readSheet(bytes);
  const p = parseInvoiceBatch(out, { today: ports.today(), mapping });
  if (mapping && p.warnings.includes('header_not_found')) return { kind: 'none', reason: 'header_not_found' };
  return bulkRows(p, 'file', mapping ? null : (out.sheets.find((x) => !x.hidden)?.name ?? null));
}

/**
 * 사람이 고른 칸(렌더러가 보낸 JSON) → 파서 mapping. 시트 이름, 머리글 줄(-1이면 없음), 역할별 열 번호만 받는다.
 * 거래처 칸과 금액 칸이 없으면 받지 않는다.
 */
export function mappingFrom(json: string): InvoiceMapping | null {
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return null;
  }
  const v = o as { sheet?: unknown; headerRow?: unknown; columns?: unknown };
  if (!v || typeof v.sheet !== 'string' || v.sheet.length > 200 || !Number.isInteger(v.headerRow) || (v.headerRow as number) < -1 || (v.headerRow as number) > 50) return null;
  if (!v.columns || typeof v.columns !== 'object' || Array.isArray(v.columns)) return null;
  const columns: InvoiceMapping['columns'] = {};
  for (const [k, i] of Object.entries(v.columns as Record<string, unknown>)) {
    if (!(INVOICE_ROLES as readonly string[]).includes(k) || !Number.isInteger(i) || (i as number) < 0 || (i as number) > 200) return null;
    columns[k as keyof InvoiceMapping['columns']] = i as number;
  }
  const party = columns.name !== undefined || columns.biz_no !== undefined;
  const amount = columns.supply !== undefined || columns.total !== undefined || columns.amount !== undefined;
  return party && amount ? { sheet: v.sheet, headerRow: v.headerRow as number, columns } : null;
}

/** 발급할 한 건(목록에서 고친 뒤 렌더러가 보낸 값). main이 다시 검사한다. */
export interface IssueRow {
  key: string;
  name: string;
  bizNo: string;
  cpId: string | null;
  date: string;
  item: string;
  supply: number;
  vat: number;
  taxable: boolean;
}

/** 건별 화면을 이어서 쓰는 상한(결정 1). 홈택스 직접 입력 일괄발급 10건과 같다. */
export const EACH_MAX = 10;
export const ISSUE_ROWS_MAX = 5000;
export const BULK_ROWS_MAX = 4_000_000;
const ISSUE_JSON_MAX = BULK_ROWS_MAX;

const bizOk = (b: string) => isValidBizNo(b);

/**
 * 렌더러가 보낸 발급할 건 목록을 다시 검사한다(결정 4, 5). 렌더러가 확인할 건을 이미 뺐어도 main이 같은 규칙으로 한 번 더 본다:
 * 사업자번호 검증 숫자, 작성일 꼴과 앞날, 금액(공급가액은 1원 이상, 부가세는 0 이상 정수, 면세는 부가세 0), 품목(비면 받지 않는다). 하나라도 어긋나면 묶음 전체를 받지 않는다.
 */
export function issueRowsFrom(json: string, today: string): { ok: true; rows: IssueRow[] } | { ok: false; code: string } {
  if (json.length > ISSUE_JSON_MAX) return { ok: false, code: 'bulk.too_many' };
  let o: unknown;
  try {
    o = JSON.parse(json);
  } catch {
    return { ok: false, code: 'bulk.bad_rows' };
  }
  if (!Array.isArray(o) || o.length < 1) return { ok: false, code: 'bulk.no_rows' };
  if (o.length > ISSUE_ROWS_MAX) return { ok: false, code: 'bulk.too_many' };
  const rows: IssueRow[] = [];
  const keys = new Set<string>();
  for (const x of o as Array<Record<string, unknown>>) {
    if (!x || typeof x !== 'object') return { ok: false, code: 'bulk.bad_rows' };
    const key = typeof x.key === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(x.key) ? x.key : null;
    const name = typeof x.name === 'string' ? x.name.trim().slice(0, 100) : '';
    const bizNo = typeof x.bizNo === 'string' ? x.bizNo.replace(/\D/g, '') : '';
    const cpId = typeof x.cpId === 'string' && x.cpId.length <= 128 ? x.cpId : null;
    const date = typeof x.date === 'string' ? x.date : '';
    const item = typeof x.item === 'string' ? x.item.trim().slice(0, 100) : '';
    const supply = x.supply;
    const vat = x.vat;
    const taxable = x.taxable !== false;
    if (!key || keys.has(key) || !name || !item || !bizOk(bizNo) || !isIsoDay(date) || date > today) return { ok: false, code: 'bulk.bad_row' };
    if (!Number.isSafeInteger(supply) || (supply as number) < 0 || !Number.isSafeInteger(vat) || (vat as number) < 0 || (!taxable && vat !== 0)) return { ok: false, code: 'bulk.bad_row' };
    if ((supply as number) === 0) return { ok: false, code: 'bulk.bad_row' };
    keys.add(key);
    rows.push({ key, name, bizNo, cpId, date, item, supply: supply as number, vat: vat as number, taxable });
  }
  return { ok: true, rows };
}

/**
 * 홈택스 길 고르기(결정 1). 사장님은 고르지 않는다. 건별 화면은 작성일이 오늘이고(건별 플레이북이 작성일을 바꾸지 않는다),
 * 과세이며 부가세가 공급가액의 10%(원 아래 버림)인 건만 낼 수 있다. 10건 이하이고 모두 그러면 건별 묶음 승인, 아니면 홈택스 일괄발급이다.
 */
export function bulkRoute(rows: readonly IssueRow[], today: string): 'each' | 'sheet' {
  if (rows.length > EACH_MAX) return 'sheet';
  return rows.every((r) => r.date === today && r.taxable && r.vat === Math.floor(r.supply / 10)) ? 'each' : 'sheet';
}

const compactName = (s: string) => s.replace(/\s+/g, '').replace(/\(주\)|㈜|주식회사/g, '').toLowerCase();

/** 휴폐업 조회할 번호: 파일에 있는 번호와, 이름으로 거래처 목록에 맞는 곳의 번호(렌더러의 matchParty와 같은 규칙). */
export function statusTargets(rows: readonly BulkRow[], cps: ReadonlyArray<{ name: string; bizNo: string }>): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    if (r.bizNo) out.add(r.bizNo);
    else {
      const k = compactName(r.name);
      const hits = k ? cps.filter((c) => compactName(c.name) === k && c.bizNo) : [];
      if (hits.length === 1) out.add(hits[0]!.bizNo);
    }
  }
  return [...out].filter(bizOk);
}

/** 엔진 bizverify.statusMany 답 → 번호별 상태. 계속(01)은 싣지 않는다. */
export function statusMap(r: unknown): Record<string, BizStatusCode> {
  const out: Record<string, BizStatusCode> = {};
  const list = (r as { statuses?: unknown } | null)?.statuses;
  if (!Array.isArray(list)) return out;
  for (const x of list as Array<{ bizNo?: unknown; statusCode?: unknown }>) {
    const b = typeof x?.bizNo === 'string' ? x.bizNo : '';
    const c = x?.statusCode;
    if (bizOk(b) && (c === '02' || c === '03' || c === '')) out[b] = c;
  }
  return out;
}

export function readBulkText(text: string, today: string): BulkRead {
  return bulkRows(parseInvoiceText(text, { today }), 'text');
}
