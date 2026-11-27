import { parseCsvText } from './sandbox/csv.ts';
import { emptyFlags, type Cell, type SheetOutput, type SheetTable } from './sandbox/sheet.ts';
import { cellText, isTotalRow, roleOf, sheetWarnings, type RoleRule } from './table.ts';
import { compact, findDates, isoDate, isValidBizNo, normText, parseWon } from './util.ts';

export type InvoiceRole =
  | 'biz_no' | 'sub_biz_no' | 'name' | 'ceo' | 'email' | 'address' | 'biz_type' | 'biz_item'
  | 'date' | 'tax_type' | 'supply' | 'vat' | 'total' | 'amount' | 'qty' | 'unit_price' | 'spec' | 'item' | 'memo';

export const INVOICE_ROLES: readonly InvoiceRole[] = [
  'biz_no', 'sub_biz_no', 'name', 'ceo', 'email', 'address', 'biz_type', 'biz_item',
  'date', 'tax_type', 'supply', 'vat', 'total', 'amount', 'qty', 'unit_price', 'spec', 'item', 'memo',
];

type RuleRole = InvoiceRole | 'own';

/** 앞 규칙이 이긴다. 'own'은 공급자(우리) 칸이라 읽지 않는다(홈택스 일괄 양식에 공급자와 공급받는자가 같이 있다). */
const RULES: RoleRule<RuleRole>[] = [
  { role: 'own', any: ['공급자'] },
  { role: 'email', any: ['이메일', 'email', 'e-mail', '메일'] },
  { role: 'sub_biz_no', any: ['종사업장'] },
  { role: 'address', any: ['주소', '소재지'] },
  { role: 'biz_type', any: ['업태'] },
  { role: 'biz_item', any: ['종목'] },
  { role: 'ceo', any: ['대표자', '대표', '성명'] },
  { role: 'biz_no', any: ['사업자등록번호', '사업자번호', '등록번호', '사업자no', '사업자#'] },
  { role: 'name', any: ['상호', '거래처', '업체', '회사', '법인명', '사업자명', '고객', '매출처', '납품처', '공급받는자', '받는곳', '받는분', 'company', 'customer', 'client'], not: ['담당', '연락처', '전화', '코드'] },
  { role: 'date', any: ['작성일', '발행일', '발급일', '거래일', '공급일', '매출일', '납품일', '일자', '날짜', 'date'] },
  { role: 'total', any: ['합계', '총액', '총금액', '청구금액', '청구액', '결제금액', '발행금액', 'vat포함', '부가세포함', '세포함', 'total'], not: ['공급가', '세액합계', '부가세합계'] },
  { role: 'supply', any: ['공급가', '공급금액', 'vat별도', '부가세별도', '부가세제외', 'vat제외', '세전', '순금액', '매출액', '과세표준', 'supply'] },
  { role: 'vat', any: ['부가세', '부가가치세', '세액', 'vat', 'tax'] },
  { role: 'unit_price', any: ['단가'] },
  { role: 'amount', any: ['금액', '매출', 'amount', 'price'] },
  { role: 'qty', any: ['수량', 'qty'] },
  { role: 'spec', any: ['규격'] },
  { role: 'item', any: ['품목', '품명', '상품', '제품', '내역', '내용', '적요', '항목', '서비스', 'item', 'description'] },
  { role: 'memo', any: ['비고', '메모', '참고', 'memo', 'note'] },
  { role: 'tax_type', any: ['과세구분', '과세유형', '세금구분', '종류', '구분'] },
];

/** 홈택스 일괄 양식의 품목 줄: 품목1~4, 규격1~4 … */
const LINE_COL = /^(일자|품목|품명|규격|수량|단가|공급가액|세액|품목비고|비고)([1-9])$/;
type LineField = 'day' | 'item' | 'spec' | 'qty' | 'unit_price' | 'supply' | 'vat' | 'memo';
const LINE_FIELD: Record<string, LineField> = { 일자: 'day', 품목: 'item', 품명: 'item', 규격: 'spec', 수량: 'qty', 단가: 'unit_price', 공급가액: 'supply', 세액: 'vat', 품목비고: 'memo', 비고: 'memo' };

export interface InvoiceColumn {
  role: InvoiceRole;
  index: number;
  header: string;
}

/** 사람이 고른(또는 기억한, 모델이 고른) 열. headerRow가 -1이면 머리글 줄이 없는 표다. */
export interface InvoiceMapping {
  sheet: string;
  headerRow: number;
  columns: Partial<Record<InvoiceRole, number>>;
}

export interface InvoiceLine {
  item: string | null;
  spec: string | null;
  qty: number | null;
  unitPrice: number | null;
  supply: number | null;
  vat: number | null;
  memo: string | null;
}

export type InvoiceIssue =
  | 'party_missing' | 'party_filled_down' | 'bizno_invalid' | 'bizno_not_business'
  | 'amount_missing' | 'amount_zero' | 'amount_negative' | 'amount_mismatch' | 'vat_unusual'
  | 'date_invalid' | 'date_future' | 'duplicate_in_file';

export interface InvoiceDraftRow {
  /** 파일에서 본 줄 번호(1부터). 사장님에게 "37번째 줄"로 말할 수 있다. */
  line: number;
  bizNo: string | null;
  subBizNo: string | null;
  name: string | null;
  ceo: string | null;
  email: string | null;
  address: string | null;
  bizType: string | null;
  bizItem: string | null;
  date: string | null;
  /** 날짜 칸이 비어 기준일(오늘)을 넣었으면 'default' */
  dateSource: 'cell' | 'default';
  taxType: 'taxable' | 'zero' | 'exempt';
  supply: number | null;
  vat: number | null;
  total: number | null;
  lines: InvoiceLine[];
  memo: string | null;
  issues: InvoiceIssue[];
}

export type InvoiceBatchWarning =
  | 'header_not_found' | 'header_inferred' | 'no_rows' | 'rows_skipped' | 'amount_basis_assumed'
  | 'other_sheets_ignored' | 'sheet_truncated' | 'hidden_rows_skipped' | 'encoding_euc_kr' | 'formula_cached_values';

export interface InvoiceBatchParse {
  extractor: 'invoice-batch-v1';
  signature: string | null;
  mapping: InvoiceMapping | null;
  headers: string[];
  columns: InvoiceColumn[];
  rows: InvoiceDraftRow[];
  skipped: number;
  /** 금액 칸을 무엇으로 봤는지. 'assumed_supply'는 "금액" 하나뿐이라 공급가액으로 본 것(사장님에게 한 번 확인한다). */
  amountBasis: 'supply' | 'total' | 'assumed_supply' | null;
  totals: { count: number; ready: number; parties: number; supply: number; vat: number; total: number };
  period: { from: string | null; to: string | null };
  /** 열을 못 찾았을 때 사람이나 모델이 열을 고르도록 보이는 앞 8줄 */
  sample: string[][];
  warnings: InvoiceBatchWarning[];
}

export interface InvoiceBatchOptions {
  /** 기준일 'YYYY-MM-DD'(KST). 날짜가 빈 줄의 작성일, 연도 없는 날짜의 연도, 미래 날짜 판단에 쓴다. */
  today: string;
  mapping?: InvoiceMapping | null;
}

const MAX_ROWS = 5000;

const UNIT: Record<string, number> = { 억: 1e8, 천만: 1e7, 백만: 1e6, 십만: 1e5, 만: 1e4, 천: 1e3, 백: 1e2 };

/** 금액 칸 → 원. 숫자, "2,400,000원", "(3,000)", "330만원", "1억 2천만", "1.5억" */
export function parseAmountKo(raw: Cell | undefined): number | null {
  if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
  const direct = parseWon(raw);
  if (direct !== null || typeof raw === 'number') return direct;
  let s = normText(raw).replace(/[₩\\원\s,]/g, '').replace(/^KRW/i, '').replace(/정$/, '');
  let neg = false;
  if (s.startsWith('-')) {
    neg = true;
    s = s.slice(1);
  }
  if (!s || !/[억만천백]/.test(s)) return null;
  const re = /(\d+(?:\.\d+)?)(억|천만|백만|십만|만|천|백)?/y;
  let sum = 0;
  let at = 0;
  let lastUnit = Infinity;
  while (at < s.length) {
    re.lastIndex = at;
    const m = re.exec(s);
    if (!m) return null;
    const unit = m[2] ? UNIT[m[2]]! : 1;
    if (unit >= lastUnit) return null;
    lastUnit = unit;
    sum += Number(m[1]) * unit;
    at = re.lastIndex;
  }
  const n = Math.round(sum);
  if (Math.abs(n - sum) > 1e-6 || !Number.isSafeInteger(n)) return null;
  return neg ? -n : n;
}

/** 날짜 칸 → 'YYYY-MM-DD'. 연도가 없으면("11/24", "11월 24일") 기준일의 연도 */
export function parseInvoiceDate(v: Cell | undefined, today: string): string | null {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'number') {
    if (Number.isInteger(v) && v >= 20000101 && v <= 20991231) return isoDate(Math.floor(v / 10000), Math.floor((v % 10000) / 100), v % 100);
    if (v > 36526 && v < 73051) return new Date(Math.round((Math.floor(v) - 25569) * 86400000)).toISOString().slice(0, 10);
    return null;
  }
  const t = normText(v);
  const hit = findDates(t, { compactYmd: true })[0];
  if (hit) return hit.iso;
  const m = t.match(/^(\d{1,2})\s*(?:[-./]|월)\s*(\d{1,2})\s*일?$/);
  if (m) return isoDate(Number(today.slice(0, 4)), Number(m[1]), Number(m[2]));
  return null;
}

const text = (v: Cell | undefined, max = 120): string | null => {
  const t = normText(cellText(v ?? null));
  return t ? t.slice(0, max) : null;
};

const digits = (v: Cell | undefined): string => (typeof v === 'number' && Number.isInteger(v) ? String(v) : cellText(v ?? null).replace(/[\s-]/g, ''));

const looksBizNo = (v: Cell | undefined): boolean => /^\d{10}$/.test(digits(v)) && (typeof v === 'number' || /^\d{3}-?\d{2}-?\d{5}$/.test(normText(cellText(v ?? null)).replace(/\s/g, '')));

function taxTypeOf(v: Cell | undefined): InvoiceDraftRow['taxType'] {
  const t = compact(cellText(v ?? null));
  if (/영세/.test(t) || t === '02' || t === '2') return 'zero';
  if (/면세/.test(t)) return 'exempt';
  return 'taxable';
}

interface Found {
  sheet: SheetTable;
  headerRow: number;
  columns: InvoiceColumn[];
  lineCols: Array<{ n: number; field: LineField; index: number }>;
  inferred: boolean;
}

const hasParty = (c: InvoiceColumn[]) => c.some((x) => x.role === 'name' || x.role === 'biz_no');
const hasAmount = (c: InvoiceColumn[]) => c.some((x) => x.role === 'supply' || x.role === 'total' || x.role === 'amount' || x.role === 'unit_price');

function readHeader(row: Cell[]): Pick<Found, 'columns' | 'lineCols'> {
  const used = new Set<RuleRole>();
  const columns: InvoiceColumn[] = [];
  const lineCols: Found['lineCols'] = [];
  row.forEach((c, i) => {
    if (typeof c !== 'string') return;
    const lm = LINE_COL.exec(compact(c));
    if (lm) {
      lineCols.push({ n: Number(lm[2]), field: LINE_FIELD[lm[1]!]!, index: i });
      return;
    }
    const rule = roleOf(c, RULES);
    if (!rule || rule.role === 'own' || used.has(rule.role)) return;
    used.add(rule.role);
    columns.push({ role: rule.role, index: i, header: c.slice(0, 80) });
  });
  return { columns, lineCols };
}

function detectHeader(out: SheetOutput): { best: Found | null; others: number } {
  let best: Found | null = null;
  let matched = 0;
  for (const sheet of out.sheets) {
    if (sheet.hidden) continue;
    let mine: Found | null = null;
    for (let r = 0; r < Math.min(sheet.rows.length, 40); r++) {
      const h = readHeader(sheet.rows[r] ?? []);
      if (!hasParty(h.columns) || !(hasAmount(h.columns) || h.lineCols.some((l) => l.field === 'supply'))) continue;
      if (!mine || h.columns.length + h.lineCols.length > mine.columns.length + mine.lineCols.length) mine = { sheet, headerRow: r, ...h, inferred: false };
    }
    if (!mine) continue;
    matched++;
    if (!best || mine.columns.length + mine.lineCols.length > best.columns.length + best.lineCols.length) best = mine;
  }
  return { best, others: Math.max(0, matched - 1) };
}

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol;

/** 머리글 줄이 없는 표: 칸의 내용으로 열을 짐작한다(사업자번호 꼴, 날짜 꼴, 숫자, 글자). */
function inferColumns(out: SheetOutput, today: string): Found | null {
  for (const sheet of out.sheets) {
    if (sheet.hidden) continue;
    const rows = sheet.rows.filter((r) => r.some((c) => cellText(c).trim() !== '') && !isTotalRow(r)).slice(0, 50);
    if (!rows.length) continue;
    const width = Math.max(...rows.map((r) => r.length));
    const share = (i: number, test: (c: Cell | undefined) => boolean) => rows.filter((r) => test(r[i])).length / rows.length;
    const kind: Array<'biz' | 'date' | 'num' | 'email' | 'text' | null> = [];
    for (let i = 0; i < width; i++) {
      if (share(i, looksBizNo) >= 0.6) kind.push('biz');
      else if (share(i, (c) => (typeof c === 'string' || (typeof c === 'number' && c >= 20000101 && c <= 20991231)) && parseInvoiceDate(c, today) !== null) >= 0.6) kind.push('date');
      else if (share(i, (c) => parseAmountKo(c) !== null) >= 0.6) kind.push('num');
      else if (share(i, (c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cellText(c ?? null).trim())) >= 0.6) kind.push('email');
      else if (share(i, (c) => typeof c === 'string' && c.trim() !== '') >= 0.6) kind.push('text');
      else kind.push(null);
    }
    const idx = (k: (typeof kind)[number]) => kind.flatMap((x, i) => (x === k ? [i] : []));
    const nums = idx('num');
    const texts = idx('text');
    if (!nums.length || (!idx('biz').length && !texts.length)) continue;
    const columns: InvoiceColumn[] = [];
    const put = (role: InvoiceRole, index: number | undefined) => {
      if (index !== undefined) columns.push({ role, index, header: '' });
    };
    put('biz_no', idx('biz')[0]);
    put('name', texts[0]);
    put('item', texts[1]);
    put('memo', texts[2]);
    put('date', idx('date')[0]);
    put('email', idx('email')[0]);
    const val = (r: Cell[], i: number) => parseAmountKo(r[i]);
    const holds = (test: (r: Cell[]) => boolean | null) => {
      const seen = rows.map(test).filter((x) => x !== null);
      return seen.length > 0 && seen.filter(Boolean).length / seen.length >= 0.8;
    };
    const rel = (i: number, j: number, k: number, f: (a: number, b: number) => number, tol = 1) =>
      holds((r) => {
        const [a, b, c] = [val(r, i), val(r, j), val(r, k)];
        return a === null || b === null || c === null ? null : near(f(a, b), c, tol);
      });
    let done = false;
    for (const i of nums) for (const j of nums) for (const k of nums) {
      if (done || i >= j || k === i || k === j) continue;
      if (rel(i, j, k, (a, b) => a + b)) {
        const iBig = holds((r) => (val(r, i) === null || val(r, j) === null ? null : Math.abs(val(r, i)!) >= Math.abs(val(r, j)!)));
        put('supply', iBig ? i : j);
        put('vat', iBig ? j : i);
        put('total', k);
        done = true;
      }
    }
    if (!done) {
      for (const i of nums) for (const j of nums) {
        if (done || i === j) continue;
        const pair = (f: (a: number) => number) => holds((r) => (val(r, i) === null || val(r, j) === null || val(r, i) === 0 ? null : near(f(val(r, i)!), val(r, j)!, 1)));
        if (pair((a) => Math.floor(a / 10)) || pair((a) => Math.round(a / 10))) {
          put('supply', i);
          put('vat', j);
          done = true;
        } else if (pair((a) => a + Math.floor(a / 10)) || pair((a) => a + Math.round(a / 10))) {
          put('supply', i);
          put('total', j);
          done = true;
        }
      }
    }
    if (!done) {
      for (const i of nums) for (const j of nums) for (const k of nums) {
        if (done || i >= j || k === i || k === j) continue;
        if (rel(i, j, k, (a, b) => a * b, 0)) {
          const iQty = holds((r) => (val(r, i) === null || val(r, j) === null ? null : Math.abs(val(r, i)!) <= Math.abs(val(r, j)!)));
          put('qty', iQty ? i : j);
          put('unit_price', iQty ? j : i);
          put('supply', k);
          done = true;
        }
      }
    }
    if (!done) put('amount', nums[nums.length - 1]);
    const first = sheet.rows.findIndex((row) => nums.some((i) => parseAmountKo(row[i]) !== null));
    return { sheet, headerRow: first - 1, columns, lineCols: [], inferred: true };
  }
  return null;
}

const floorVat = (supply: number) => (supply < 0 ? -Math.floor(-supply / 10) : Math.floor(supply / 10));

/**
 * 여러 건 발급 표 읽기(ADR-059). 엑셀, CSV, HTML 표, 붙여 넣은 표를 SheetOutput으로 받아 발급 행으로 바꾼다.
 * mapping이 있으면 그것을 쓰고, 없으면 머리글 사전으로 열을 찾고, 머리글이 없으면 칸 내용으로 짐작한다.
 * 문제가 있는 줄도 버리지 않고 issues를 붙여 돌려준다(목록의 "확인할 건"). 거래처 목록 대조와 휴폐업 조회는 엔진이 한다.
 */
export function parseInvoiceBatch(out: SheetOutput, opts: InvoiceBatchOptions): InvoiceBatchParse {
  const KEEP: readonly string[] = ['sheet_truncated', 'encoding_euc_kr', 'hidden_rows_skipped', 'formula_cached_values'];
  const warnings = new Set<InvoiceBatchWarning>(sheetWarnings(out).filter((w) => KEEP.includes(w)) as InvoiceBatchWarning[]);
  const visible = out.sheets.find((s) => !s.hidden);
  let found: Found | null = null;
  const m = opts.mapping;
  if (m) {
    const sheet = out.sheets.find((s) => s.name === m.sheet && !s.hidden);
    if (sheet) {
      const head = m.headerRow >= 0 ? (sheet.rows[m.headerRow] ?? []) : [];
      const columns = INVOICE_ROLES.filter((r) => Number.isInteger(m.columns[r])).map((r) => ({ role: r, index: m.columns[r]!, header: cellText(head[m.columns[r]!] ?? null).slice(0, 80) }));
      found = { sheet, headerRow: m.headerRow, columns, lineCols: m.headerRow >= 0 ? readHeader(head).lineCols : [], inferred: false };
    }
  } else {
    const d = detectHeader(out);
    found = d.best;
    if (d.others) warnings.add('other_sheets_ignored');
    if (!found) {
      found = inferColumns(out, opts.today);
      if (found) warnings.add('header_inferred');
    }
  }
  const sampleOf = (s: SheetTable | undefined, from: number) => s?.rows.slice(from, from + 8).map((r) => r.map((c) => cellText(c).slice(0, 40))) ?? [];
  if (!found || !hasParty(found.columns) || !(hasAmount(found.columns) || found.lineCols.some((l) => l.field === 'supply'))) {
    return {
      extractor: 'invoice-batch-v1', signature: null, mapping: null, headers: (visible?.rows[0] ?? []).map((c) => cellText(c).slice(0, 80)), columns: [], rows: [], skipped: 0, amountBasis: null,
      totals: { count: 0, ready: 0, parties: 0, supply: 0, vat: 0, total: 0 }, period: { from: null, to: null }, sample: sampleOf(found?.sheet ?? visible, 0), warnings: [...warnings, 'header_not_found'],
    };
  }
  const { sheet, headerRow, columns, lineCols } = found;
  const col = (r: InvoiceRole) => columns.find((c) => c.role === r)?.index;
  const head = headerRow >= 0 ? (sheet.rows[headerRow] ?? []) : [];
  const headers = head.map((c) => cellText(c).slice(0, 80));
  const lineNos = [...new Set(lineCols.map((l) => l.n))].sort((a, b) => a - b);
  const amountBasis: InvoiceBatchParse['amountBasis'] =
    col('supply') !== undefined || col('unit_price') !== undefined || lineCols.some((l) => l.field === 'supply') ? 'supply' : col('total') !== undefined ? 'total' : 'assumed_supply';
  if (amountBasis === 'assumed_supply') warnings.add('amount_basis_assumed');

  const rows: InvoiceDraftRow[] = [];
  let skipped = 0;
  let prev: InvoiceDraftRow | null = null;
  const seen = new Set<string>();
  for (let r = headerRow + 1; r < sheet.rows.length; r++) {
    const raw = sheet.rows[r] ?? [];
    if (!raw.length || raw.every((c) => cellText(c).trim() === '')) continue;
    if (isTotalRow(raw)) continue;
    const at = (role: InvoiceRole) => (col(role) === undefined ? undefined : raw[col(role)!]);
    const amt = (role: InvoiceRole) => parseAmountKo(at(role));
    const issues: InvoiceIssue[] = [];

    let name = text(at('name'));
    const bizRaw = digits(at('biz_no'));
    let bizNo: string | null = null;
    if (bizRaw) {
      if (/^\d{10}$/.test(bizRaw) && isValidBizNo(bizRaw)) bizNo = bizRaw;
      else if (/^\d{13}$/.test(bizRaw)) issues.push('bizno_not_business');
      else issues.push('bizno_invalid');
    }

    const lines: InvoiceLine[] = [];
    const mainQty = amt('qty');
    const mainUnit = amt('unit_price');
    for (const n of lineNos) {
      const f = (field: LineField) => {
        const c = lineCols.find((l) => l.n === n && l.field === field);
        return c ? raw[c.index] : undefined;
      };
      const line: InvoiceLine = { item: text(f('item')), spec: text(f('spec'), 60), qty: parseAmountKo(f('qty')), unitPrice: parseAmountKo(f('unit_price')), supply: parseAmountKo(f('supply')), vat: parseAmountKo(f('vat')), memo: text(f('memo')) };
      if (line.item !== null || line.supply !== null) lines.push(line);
    }

    const taxType = taxTypeOf(at('tax_type'));
    let supply = amt('supply');
    let vat = amt('vat');
    const fileTotal = amt('total');
    const loose = amt('amount');
    if (supply === null && lines.some((l) => l.supply !== null)) supply = lines.reduce((s, l) => s + (l.supply ?? 0), 0);
    if (supply === null && mainQty !== null && mainUnit !== null) supply = mainQty * mainUnit;
    if (supply === null && col('supply') === undefined && loose !== null && col('total') === undefined) supply = loose;
    if (supply === null && col('supply') === undefined && mainUnit !== null && mainQty === null && col('qty') === undefined) supply = mainUnit;
    if (vat === null && lines.some((l) => l.vat !== null)) vat = lines.reduce((s, l) => s + (l.vat ?? 0), 0);
    const total0 = fileTotal;
    if (taxType !== 'taxable') vat = 0;
    let total: number | null = null;
    if (supply !== null) {
      if (vat === null) vat = total0 !== null ? total0 - supply : floorVat(supply);
      total = supply + vat;
      if (total0 !== null && total0 !== total) issues.push('amount_mismatch');
    } else if (total0 !== null) {
      if (vat !== null) supply = total0 - vat;
      else {
        supply = Math.round(total0 / 1.1);
        vat = total0 - supply;
      }
      total = total0;
    } else issues.push('amount_missing');
    if (supply !== null) {
      if (supply === 0) issues.push('amount_zero');
      if (supply < 0) issues.push('amount_negative');
      if (taxType === 'taxable' && vat !== null && Math.abs(vat - supply / 10) > 10) issues.push('vat_unusual');
    }

    const hasMoney = supply !== null;
    if (!name && !bizNo && !bizRaw) {
      if (!hasMoney) {
        skipped++;
        continue;
      }
      const hasItem = text(at('item')) !== null || lines.length > 0;
      if (prev && hasItem) {
        name = prev.name;
        bizNo = prev.bizNo;
        issues.push('party_filled_down');
      } else issues.push('party_missing');
    }

    const dateCell = at('date');
    let date: string | null;
    let dateSource: InvoiceDraftRow['dateSource'] = 'cell';
    if (dateCell === undefined || dateCell === null || cellText(dateCell).trim() === '') {
      date = issues.includes('party_filled_down') && prev ? prev.date : opts.today;
      dateSource = issues.includes('party_filled_down') && prev ? prev.dateSource : 'default';
    } else {
      date = parseInvoiceDate(dateCell, opts.today);
      if (date === null) issues.push('date_invalid');
      else if (date > opts.today) issues.push('date_future');
    }

    if (!lines.length) {
      const item = text(at('item'));
      if (item !== null || mainQty !== null || mainUnit !== null) lines.push({ item, spec: text(at('spec'), 60), qty: mainQty, unitPrice: mainUnit, supply, vat, memo: null });
    }

    const key = `${bizNo ?? compact(name ?? '')}|${date}|${supply}|${compact(lines[0]?.item ?? '')}`;
    if ((bizNo || name) && supply !== null) {
      if (seen.has(key)) issues.push('duplicate_in_file');
      seen.add(key);
    }

    const row: InvoiceDraftRow = {
      line: r + 1, bizNo, subBizNo: digits(at('sub_biz_no')).match(/^\d{4}$/)?.[0] ?? null, name, ceo: text(at('ceo'), 40), email: text(at('email'))?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)?.[0] ?? null,
      address: text(at('address'), 200), bizType: text(at('biz_type'), 60), bizItem: text(at('biz_item'), 60), date, dateSource, taxType, supply, vat, total, lines, memo: text(at('memo')), issues,
    };
    rows.push(row);
    prev = row;
    if (rows.length >= MAX_ROWS) {
      warnings.add('sheet_truncated');
      break;
    }
  }
  if (skipped) warnings.add('rows_skipped');
  if (!rows.length) warnings.add('no_rows');
  const ready = rows.filter((x) => x.issues.length === 0);
  const days = rows.flatMap((x) => (x.date ? [x.date] : [])).sort();
  return {
    extractor: 'invoice-batch-v1',
    signature: headers.map((h) => compact(h)).join('|').slice(0, 400) || null,
    mapping: { sheet: sheet.name, headerRow, columns: Object.fromEntries(columns.map((c) => [c.role, c.index])) },
    headers,
    columns,
    rows,
    skipped,
    amountBasis,
    totals: {
      count: rows.length,
      ready: ready.length,
      parties: new Set(ready.map((x) => x.bizNo ?? compact(x.name ?? ''))).size,
      supply: ready.reduce((s, x) => s + (x.supply ?? 0), 0),
      vat: ready.reduce((s, x) => s + (x.vat ?? 0), 0),
      total: ready.reduce((s, x) => s + (x.total ?? 0), 0),
    },
    period: { from: days[0] ?? null, to: days[days.length - 1] ?? null },
    sample: sampleOf(sheet, Math.max(headerRow, 0)),
    warnings: [...warnings],
  };
}

const sheetOf = (rows: Cell[][]): SheetOutput => ({ format: 'csv', encoding: null, sheets: [{ name: 'text', hidden: false, rows, hiddenRows: 0 }], flags: emptyFlags() });

const AMOUNT_TOKEN = /^-?[₩\\]?\(?\d[\d,]*(\.\d+)?\)?(억|천만|백만|십만|만|천)?원?$/;

/** 빈칸으로만 띄운 줄: 사업자번호, 날짜, 금액 꼴은 한 칸씩, 그 사이 글자는 이어 한 칸 */
function tokenRows(lines: string[], today: string): Cell[][] {
  return lines.map((line) => {
    const cells: Cell[] = [];
    let run: string[] = [];
    const flush = () => {
      if (run.length) cells.push(run.join(' '));
      run = [];
    };
    for (const tok0 of line.split(/[ \t]+/)) {
      const tok = tok0.replace(/[,;]+$/, '');
      if (!tok) continue;
      const own = /^\d{3}-?\d{2}-?\d{5}$/.test(tok) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(tok) || (/\d/.test(tok) && parseInvoiceDate(tok, today) !== null && /[-./월]/.test(tok)) || (AMOUNT_TOKEN.test(tok) && parseAmountKo(tok) !== null);
      const last = cells[cells.length - 1];
      if (own && !run.length && typeof last === 'string' && /[억만천]$/.test(last) && AMOUNT_TOKEN.test(tok) && parseAmountKo(last + tok) !== null) cells[cells.length - 1] = last + tok;
      else if (own) {
        flush();
        cells.push(tok);
      } else run.push(tok);
    }
    flush();
    return cells;
  });
}

/**
 * 붙여 넣은 글 → 발급 행. 엑셀에서 복사한 표(탭), CSV, 마크다운 표(|), 빈칸으로 띄운 줄을 모두 받아 본다.
 * 여러 방법으로 나눠 보고 문제 없는 줄이 가장 많은 것을 고른다. 표 꼴이 아닌 말("한빛물산이랑 대한테크에 각각 …")은 대화 판정이 맡는다.
 */
export function parseInvoiceText(input: string, opts: InvoiceBatchOptions): InvoiceBatchParse {
  const lines = input.replace(/\r\n?/g, '\n').split('\n').map((l) => l.replace(/[\u00A0\u3000]/g, ' ').trimEnd()).filter((l) => l.trim() !== '').slice(0, MAX_ROWS + 50);
  const tries: Cell[][][] = [];
  if (lines.some((l) => l.includes('\t'))) tries.push(parseCsvText(lines.join('\n')).rows);
  if (lines.filter((l) => l.trim().startsWith('|')).length >= Math.max(1, lines.length * 0.6)) {
    tries.push(lines.filter((l) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(l)).map((l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim() || null)));
  }
  if (!tries.length) {
    tries.push(tokenRows(lines, opts.today));
    if (lines.filter((l) => / {2,}/.test(l.trim())).length >= lines.length * 0.6) tries.push(lines.map((l) => l.trim().split(/ {2,}/).map((c) => c.trim() || null)));
    if (lines.some((l) => l.includes(','))) tries.push(parseCsvText(lines.join('\n')).rows);
  }
  let best: InvoiceBatchParse | null = null;
  const score = (p: InvoiceBatchParse) => p.totals.ready * 1000 + p.rows.length - (p.warnings.includes('header_inferred') ? 0.5 : 0);
  for (const rows of tries) {
    const p = parseInvoiceBatch(sheetOf(rows), opts);
    if (!best || score(p) > score(best)) best = p;
  }
  return best ?? parseInvoiceBatch(sheetOf([]), opts);
}

/** 머리글 칸 하나의 역할 후보(열 고르기 기본값) */
export const invoiceRoleOfHeader = (h: string): InvoiceRole | null => {
  const r = roleOf(h, RULES)?.role;
  return !r || r === 'own' ? null : r;
};
