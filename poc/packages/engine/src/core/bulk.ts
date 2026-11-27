import { normalizeName } from './constants.ts';

/**
 * 홈택스 일괄발급 묶음(ADR-063). 엔진 입력 rows와 금고가 읽은 변환 목록(GridRow)을 맞춘다. 값은 일지에 남기지 않는다(줄 번호와 칸 이름만).
 * 입력 모양은 금고 bulk/hometax-sheet.ts SheetRow와 같다(금고가 다시 검사한다).
 */
export interface BulkParty {
  bizNo: string;
  name: string;
  repName: string;
  email?: string;
}
export interface BulkRow {
  writeDate: string;
  buyer: BulkParty;
  item: string;
  supply: number;
  tax: number;
  receipt: '01' | '02';
  remark?: string;
}

/** 금고 bulk.readGrid 한 줄(열 id는 홈택스 실측). */
export interface BulkGridRow {
  checked: boolean;
  disabled: boolean;
  chk: string;
  wrtDt: string;
  dmnrTxprDscmNo: string;
  dmnrTnmNm: string;
  dmnrRprsFnm: string;
  splCft: string;
  txamt: string;
  apprvNo: string;
  recApeClCd: string;
  splrTxprDscmNo: string;
}

export const BULK_ROWS_PER_RUN = 50;
export const APPROVAL_NO_RE = /^[0-9A-Za-z]{8}-?[0-9A-Za-z]{8}-?[0-9A-Za-z]{8}$/;

const digits = (s: string) => s.replace(/\D/g, '');
const name = (s: string) => normalizeName(s).replace(/\s+/g, '');

export function isBulkRows(v: unknown): v is BulkRow[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > BULK_ROWS_PER_RUN) return false;
  return v.every((r) => {
    if (!r || typeof r !== 'object') return false;
    const x = r as Record<string, unknown>;
    const b = x.buyer as Record<string, unknown> | undefined;
    return typeof x.writeDate === 'string' && /^\d{8}$/.test(x.writeDate) && !!b && typeof b.bizNo === 'string' && /^\d{10}$/.test(b.bizNo)
      && typeof b.name === 'string' && typeof b.repName === 'string' && typeof x.item === 'string'
      && Number.isSafeInteger(x.supply) && Number.isSafeInteger(x.tax) && (x.receipt === '01' || x.receipt === '02');
  });
}

export function isBulkParty(v: unknown): v is BulkParty {
  if (!v || typeof v !== 'object') return false;
  const x = v as Record<string, unknown>;
  return typeof x.bizNo === 'string' && /^\d{10}$/.test(x.bizNo) && typeof x.name === 'string' && typeof x.repName === 'string';
}

/** 확인창 「(총 건수: n, 총 합계금액: x)」에 들어갈 값. 합계는 공급가액+세액을 천 단위 쉼표로. */
export function bulkTotals(rows: readonly BulkRow[]): { count: string; total: string } {
  const sum = rows.reduce((n, r) => n + r.supply + r.tax, 0);
  return { count: String(rows.length), total: sum.toLocaleString('en-US') };
}

export type GridVerdict = { ok: true; approvalNos?: string[] } | { ok: false; code: string; row?: number; field?: string };

/**
 * converted: 줄 수, 순서, 공급자 번호, 거래처 번호·상호·성명, 작성일, 공급가액, 세액, 영수/청구가 같고 모든 줄이 선택(비활성 아님)이다.
 * issued: 위에 더해 모든 줄에 승인번호가 있다(홈택스는 묶음 전체가 같이 발급되거나 같이 실패한다, 스크립트 실측).
 */
export function checkGrid(rows: readonly BulkRow[], supplier: BulkParty, grid: readonly BulkGridRow[], expect: 'converted' | 'issued'): GridVerdict {
  if (grid.length !== rows.length) return { ok: false, code: 'bulk.grid_count_mismatch' };
  const approvalNos: string[] = [];
  for (const [i, r] of rows.entries()) {
    const g = grid[i]!;
    const bad = (field: string): GridVerdict => ({ ok: false, code: 'bulk.grid_mismatch', row: i + 1, field });
    if (digits(g.splrTxprDscmNo) !== supplier.bizNo) return bad('supplierBizNo');
    if (digits(g.dmnrTxprDscmNo) !== r.buyer.bizNo) return bad('counterpartBizNo');
    if (name(g.dmnrTnmNm) !== name(r.buyer.name)) return bad('counterpartName');
    if (name(g.dmnrRprsFnm) !== name(r.buyer.repName)) return bad('counterpartRepName');
    if (digits(g.wrtDt) !== r.writeDate) return bad('writeDate');
    if (digits(g.splCft) !== String(r.supply)) return bad('supplyAmount');
    if (digits(g.txamt) !== String(r.tax)) return bad('taxAmount');
    if (g.recApeClCd !== r.receipt) return bad('receiptType');
    if (expect === 'converted') {
      if (!g.checked || g.disabled) return { ok: false, code: 'bulk.row_unchecked', row: i + 1 };
      if (g.apprvNo.trim() !== '') return { ok: false, code: 'bulk.already_issued', row: i + 1 };
    } else {
      if (!APPROVAL_NO_RE.test(g.apprvNo.trim())) return { ok: false, code: 'bulk.approval_missing', row: i + 1 };
      approvalNos.push(g.apprvNo.trim());
    }
  }
  return expect === 'issued' ? { ok: true, approvalNos } : { ok: true };
}

/** 정규식 이스케이프(확인창 패턴의 `{이름}` 자리에 넣는다). */
export const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** expectConfirm 패턴의 `{이름}`을 값으로 바꾼다. 없는 이름이 남으면 null(무장하지 않는다). */
export function fillConfirmPattern(pattern: string, vars: Readonly<Record<string, string>>): string | null {
  let missing = false;
  const out = pattern.replace(/\{([a-z][A-Za-z0-9]{0,30})\}/g, (_, k: string) => {
    const v = vars[k];
    if (v === undefined) {
      missing = true;
      return '';
    }
    return reEscape(v);
  });
  return missing ? null : out;
}
