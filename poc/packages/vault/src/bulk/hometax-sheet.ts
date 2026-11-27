import { writeXlsx } from './xlsx.ts';

/**
 * 홈택스 「전자세금계산서 일괄 작성」(UTEETBAA77) 업로드 파일(ADR-063). 금고가 엔진이 넘긴 묶음(검사한 값)으로만 만든다.
 * 모양은 홈택스 양식 「세금계산서등록양식(일반).xls」 엑셀업로드양식 시트(2026-11-24 맥북 실측, /mnt/project-files/hometax-ref/bulk-probe.md):
 * 6행 머리글, 7행부터 자료, A~BG 59열, 모든 값 글자. 홈택스는 암호 없는 xlsx를 그대로 받는다(실측).
 * 지금은 일반(01) 과세 세금계산서, 품목 1줄만 쓴다. 영세율, 품목 2~4, 결제 수단 칸은 비운다.
 */

export const SHEET_NAME = '엑셀업로드양식';
export const SHEET_COLUMNS = 59;
export const HEADER_ROW = 6;
/** 파일 하나에 넣는 건수. 홈택스는 파일당 100건, [일괄발급]은 한 번에 50건이라 한 파일 = 한 번 누름 = 장부 의도 하나로 맞춘다. */
export const SHEET_ROWS_MAX = 50;

export interface SheetParty {
  bizNo: string;
  name: string;
  repName: string;
}
export interface SheetRow {
  /** YYYYMMDD */
  writeDate: string;
  buyer: SheetParty & { email?: string };
  item: string;
  supply: number;
  tax: number;
  /** 01 영수, 02 청구 */
  receipt: '01' | '02';
  remark?: string;
}
export interface SheetSpec {
  supplier: SheetParty;
  rows: SheetRow[];
}

/** 홈택스 길이는 바이트(한글 2). CP949 밖 글자(이모지, 옛한글 등)는 받지 않는다. */
const byteLen = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) < 0x80 ? 1 : 2), 0);
const TEXT = /^[ -~\u00B7\u1100-\u11FF\u3000-\u303F\u3131-\u318E\uAC00-\uD7A3\u4E00-\u9FFF\uFF01-\uFF5E]*$/;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;

function text(v: unknown, max: number, required: boolean): string | null {
  if (typeof v !== 'string') return required ? null : v === undefined ? '' : null;
  const s = v.normalize('NFC').trim();
  if (s === '') return required ? null : '';
  if (!TEXT.test(s) || byteLen(s) > max) return null;
  // 글자 칸이어도 =, +, -, @로 시작하면 엑셀이 수식으로 읽을 수 있다(홈택스는 수식이 든 파일을 거부한다).
  if (/^[=+\-@]/.test(s)) return null;
  return s;
}

function bizNoOk(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{10}$/.test(s)) return false;
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(s[i]) * w[i]!;
  sum += Math.floor((Number(s[8]) * 5) / 10);
  return (10 - (sum % 10)) % 10 === Number(s[9]);
}

function dateOk(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{8}$/.test(s)) return false;
  const d = new Date(Date.UTC(Number(s.slice(0, 4)), Number(s.slice(4, 6)) - 1, Number(s.slice(6, 8))));
  return d.getUTCFullYear() === Number(s.slice(0, 4)) && d.getUTCMonth() + 1 === Number(s.slice(4, 6)) && d.getUTCDate() === Number(s.slice(6, 8));
}

const amountOk = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 999_999_999_999_999;

export type SheetCheck = { ok: true; spec: SheetSpec } | { ok: false; code: string; row?: number };

function party(p: unknown, buyer: boolean): (SheetParty & { email?: string }) | null {
  if (!p || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (!bizNoOk(o.bizNo)) return null;
  const name = text(o.name, 70, true);
  const repName = text(o.repName, 30, true);
  if (name === null || repName === null) return null;
  if (!buyer) return { bizNo: o.bizNo, name, repName };
  if (o.email !== undefined && (typeof o.email !== 'string' || o.email.length > 40 || !EMAIL.test(o.email))) return null;
  return { bizNo: o.bizNo, name, repName, ...(typeof o.email === 'string' ? { email: o.email } : {}) };
}

/** 엔진이 넘긴 값을 다시 검사한다(금고는 엔진을 믿지 않는다). 틀린 칸이 하나라도 있으면 파일을 만들지 않는다. */
export function checkSheet(raw: unknown): SheetCheck {
  if (!raw || typeof raw !== 'object') return { ok: false, code: 'bad_params' };
  const o = raw as Record<string, unknown>;
  const supplier = party(o.supplier, false);
  if (!supplier) return { ok: false, code: 'bad_supplier' };
  if (!Array.isArray(o.rows) || o.rows.length === 0 || o.rows.length > SHEET_ROWS_MAX) return { ok: false, code: 'bad_rows' };
  const rows: SheetRow[] = [];
  for (const [i, r] of (o.rows as unknown[]).entries()) {
    const x = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>;
    const buyer = party(x.buyer, true);
    const item = text(x.item, 100, true);
    const remark = text(x.remark, 150, false);
    if (!buyer || item === null || remark === null || !dateOk(x.writeDate) || !amountOk(x.supply) || !amountOk(x.tax) || (x.receipt !== '01' && x.receipt !== '02')) {
      return { ok: false, code: 'bad_row', row: i + 1 };
    }
    if (buyer.bizNo === supplier.bizNo) return { ok: false, code: 'self_buyer', row: i + 1 };
    rows.push({ writeDate: x.writeDate, buyer, item, supply: x.supply, tax: x.tax, receipt: x.receipt, ...(remark ? { remark } : {}) });
  }
  return { ok: true, spec: { supplier, rows } };
}

/** 6행 머리글(홈택스 양식 글 그대로, 줄바꿈은 빼고). 홈택스는 열 위치로 읽고 행·열 추가를 막는다. */
export const SHEET_HEADERS: readonly string[] = [
  '전자(세금)계산서 종류(01:일반, 02:영세율)', '작성일자', '공급자 등록번호("-" 없이 입력)', '공급자 종사업장번호', '공급자 상호', '공급자 성명',
  '공급자 사업장주소', '공급자 업태', '공급자 종목', '공급자 이메일', '공급받는자 등록번호("-" 없이 입력)', '공급받는자 종사업장번호',
  '공급받는자 상호', '공급받는자 성명', '공급받는자 사업장주소', '공급받는자 업태', '공급받는자 종목', '공급받는자 이메일1', '공급받는자 이메일2',
  '공급가액 합계', '세액 합계', '비고',
  ...[1, 2, 3, 4].flatMap((n) => [`일자${n}(2자리, 작성년월 제외)`, `품목${n}`, `규격${n}`, `수량${n}`, `단가${n}`, `공급가액${n}`, `세액${n}`, `품목비고${n}`]),
  '현금', '수표', '어음', '외상미수금', '영수(01), 청구(02)',
];

/** 한 줄 = 계산서 한 장, 59칸. */
export function sheetLine(supplier: SheetParty, r: SheetRow): string[] {
  const v = new Array<string>(SHEET_COLUMNS).fill('');
  const put = (col: string, s: string) => {
    let i = 0;
    for (const ch of col) i = i * 26 + (ch.charCodeAt(0) - 64);
    v[i - 1] = s;
  };
  put('A', '01');
  put('B', r.writeDate);
  put('C', supplier.bizNo);
  put('E', supplier.name);
  put('F', supplier.repName);
  put('K', r.buyer.bizNo);
  put('M', r.buyer.name);
  put('N', r.buyer.repName);
  if (r.buyer.email) put('R', r.buyer.email);
  put('T', String(r.supply));
  put('U', String(r.tax));
  if (r.remark) put('V', r.remark);
  put('W', r.writeDate.slice(6, 8));
  put('X', r.item);
  put('AB', String(r.supply));
  put('AC', String(r.tax));
  put('BG', r.receipt);
  return v;
}

/** 업로드 파일 바이트. 1행 제목, 2~5행 비움, 6행 머리글, 7행부터 자료. */
export function buildSheet(spec: SheetSpec): Uint8Array {
  const rows: string[][] = [['엑셀 업로드 양식(전자세금계산서-일반(영세율)) - 100건 이하'], [], [], [], [], [...SHEET_HEADERS]];
  for (const r of spec.rows) rows.push(sheetLine(spec.supplier, r));
  return writeXlsx(SHEET_NAME, rows);
}
