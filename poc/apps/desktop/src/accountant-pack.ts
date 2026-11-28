import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import writeXlsxFile from 'write-excel-file/node';
import { checkPaperDraft, checkPaperInvoice, type PaperInvoice, type PaperInvoiceDraft } from '@sax/remote';
import { writePrivateExport } from './private-exports.ts';

type PackMonth = string;

type PackGapKind = 'bank_short' | 'paper_check' | 'receipt_check';
interface PackGap {
  kind: PackGapKind;
  who: string | null;
  day: string | null;
  total: number | null;
}

/** 엔진 db.query.bank.packRows 답: 그달 통장(계좌마다 거래와 다 받은 날)과 사장님이 적은 현금 매출 */
interface PackRows {
  bank: Array<{ bank: string; last4: string; coverTo: string | null; txns: Array<{ at: string; direction: 'in' | 'out'; amount: number; balance: number | null; payer: string | null; memo: string | null }> }>;
  cashSales: Array<{ day: string; amount: number }>;
}

/** 그달 확인한 급여대장 한 줄 */
interface PackPayLine {
  name: string;
  gross: number;
  nontax: number;
  incomeTax: number;
  localIncomeTax: number;
  pension: number;
  health: number;
  ltc: number;
  employment: number;
  netPay: number;
}

/** 꾸러미 맨 위 파일이나 폴더 한 줄(대화 카드, 00 목록.txt). note는 든 것("3건") */
interface PackEntry {
  name: string;
  kind: 'xlsx' | 'txt' | 'dir';
  note: string;
}

/** 꾸러미 화면 목록: 엑셀 파일(통장, 급여대장, 현금 매출)과 종이 증빙. 화면은 이것으로 그리고 같은 값이 파일에 들어간다 */
interface PackSummary {
  month: PackMonth;
  label: string;
  entries: PackEntry[];
  gaps: PackGap[];
  /** 계좌마다. coverTo는 거래내역을 받은 마지막 날, full이면 그달 끝까지 받았다 */
  bank: Array<{ who: string; coverTo: string | null; full: boolean; txns: number }>;
  payroll: { people: number; gross: number } | null;
  cash: { days: number; total: number } | null;
  evidence: PackEvidence[];
  zipName: string;
  files: string[];
  madeAt: string;
}

export const GAP_LABEL: Record<PackGapKind, string> = {
  bank_short: '통장 거래내역을 다 받지 못했어요',
  paper_check: '종이 계산서 값 확인 필요',
  receipt_check: '영수증 날짜, 금액 확인 필요',
};
const GAP_ORDER: PackGapKind[] = ['bank_short', 'paper_check', 'receipt_check'];

/** 확인할 것(확정 전 증빙만). 앞의 것부터 하나만 알린다: 금액, 작성일, 매입 매출, 거래처, 못 읽음 */
export type PackCheck = 'amount' | 'day' | 'direction' | 'party' | 'unread';
const CHECK_OF: Array<[PackCheck, RegExp]> = [
  ['amount', /^(total|supplyAmount|vatAmount|items)/],
  ['day', /^writtenOn/],
  ['direction', /^direction/],
  ['party', /^(supplier|buyer|docKind|receiptOrClaim)/],
];
/** 검산이 틀린 칸 이름(checkPaperInvoice, checkPaperDraft의 field) → 사장님이 볼 것 하나 */
export function paperCheck(fields: string[]): PackCheck | null {
  if (!fields.length) return null;
  return CHECK_OF.find(([, re]) => fields.some((f) => re.test(f)))?.[0] ?? 'party';
}

interface PackParty {
  bizNo: string | null;
  name: string | null;
}

/**
 * 꾸러미에 드는 종이 증빙 하나(main이 장부 증빙 줄에서 packEvidence로 만든다, ADR-073).
 * 확정한 것은 확정 값, 확정 전 것은 읽은 후보다. 후보는 화면과 파일에 "확인 필요"로만 나간다.
 */
export interface PackEvidenceSource {
  docId: string;
  file: string | null;
  kind: 'tax_invoice' | 'invoice' | 'receipt';
  /** 들어갈 꾸러미 달: 확정한 날, 읽은 작성일, PC에서 넣은 달, 받은 달 순 */
  month: PackMonth;
  confirmed: boolean;
  /** 작성일이나 영수증 날짜 */
  day: string | null;
  /** 상대 이름: 매입이면 공급자, 매출이면 공급받는자, 영수증은 가게 */
  name: string | null;
  amount: number | null;
  direction: 'sales' | 'purchase' | null;
  supply: number | null;
  vat: number | null;
  /** 계산서의 공급자, 공급받는자(엑셀 칸). 영수증은 null */
  supplier: PackParty | null;
  buyer: PackParty | null;
  receiptOrClaim: 'receipt' | 'claim' | null;
  items: string[];
  /** 승인번호(전자세금계산서 출력물이면 있다). 화면에는 보이지 않고 고칠 때 그대로 돌려줘 장부의 겹침 판단을 지킨다 */
  approvalNo: string | null;
  check: PackCheck | null;
}

/** 화면이 그리는 증빙 한 줄. image는 꾸러미 안 원본 파일 이름(없으면 null). 공급자, 공급받는자는 고치기 칸의 기본값이다 */
export type PackEvidence = Omit<PackEvidenceSource, 'file' | 'month' | 'receiptOrClaim' | 'items'> & { image: string | null };

/** 엔진 db.query.receipt.list의 증빙 한 줄(ReceiptView) */
export interface PackReceiptRow {
  docId: string;
  source: 'pc_file' | 'phone_capture';
  issuedOn: string | null;
  merchant: string | null;
  merchantBizNo: string | null;
  amount: number | null;
  docKind: 'tax_invoice' | 'invoice' | 'receipt' | null;
  direction: 'sales' | 'purchase' | null;
  supply: number | null;
  vat: number | null;
  approvalNo: string | null;
  phoneOcr: unknown;
  ocr: unknown;
  confirmedAt: string | null;
}

/** PC로 넣은 증빙의 ocr_json(main이 pack.paperAdd에서 쓴다): 넣은 꾸러미 달과 읽은 계산서 후보 */
export interface PackPcOcr {
  v: 1;
  addedFor: PackMonth;
  engine: string | null;
  paperDraft: PaperInvoiceDraft | null;
}

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const dayOk = (d: unknown): d is string => typeof d === 'string' && DAY_RE.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const amountOk = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;
const digits = (b: string | null | undefined) => (b ?? '').replace(/\D/g, '');
const approvalOk = (a: unknown): string | null => (typeof a === 'string' && /^\d{8}-\d{8}-\d{8}$/.test(a) ? a : null);

/**
 * 장부 증빙 줄 → 꾸러미 증빙. listedMonth는 그 줄을 받아 온 receipt.list의 달이다(확정 전 줄은 받은 날의 달로 나온다).
 * - 확정한 것: 확정 값(종류, 날짜, 금액, 매입 매출). 품목과 상대 번호는 읽은 후보에서 채운다.
 * - 확정 전 계산서: 폰이 보낸 값(checkPaperInvoice) 또는 PC가 읽은 후보(checkPaperDraft)를 검산해 확인할 것을 정한다. 매입 매출은 내 사업자번호로 정한다.
 * - 확정 전 영수증: 폰에서 사장님이 확인한 날짜와 금액이 있으면 그대로, 없으면 확인할 것(못 읽음).
 */
export function packEvidence(x: PackReceiptRow, myBizNo: string | null, listedMonth: PackMonth): Omit<PackEvidenceSource, 'file'> {
  const phone = (x.phoneOcr ?? null) as { ownerConfirmed?: unknown; candidates?: { amount?: unknown; issuedOn?: unknown; merchant?: unknown }; paperInvoice?: PaperInvoice } | null;
  const pc = (x.ocr ?? null) as Partial<PackPcOcr> | null;
  const addedFor = isPackMonth(pc?.addedFor) ? pc.addedFor : null;
  const cand = phone?.paperInvoice ?? pc?.paperDraft ?? null;
  const party = (q: { bizNo?: string | null; name?: string | null } | undefined): PackParty => ({ bizNo: q?.bizNo ?? null, name: q?.name?.trim() || null });
  const sides = cand ? { supplier: party(cand.supplier), buyer: party(cand.buyer) } : null;
  const extra = { receiptOrClaim: cand?.receiptOrClaim ?? null, items: (cand?.items ?? []).map((it) => it.name).filter(Boolean) };
  const mine = digits(myBizNo);
  if (x.confirmedAt && dayOk(x.issuedOn) && amountOk(x.amount)) {
    if (x.docKind === 'tax_invoice' || x.docKind === 'invoice') {
      const other: PackParty = { bizNo: x.merchantBizNo, name: x.merchant };
      const me: PackParty = { bizNo: myBizNo, name: (x.direction === 'sales' ? sides?.supplier.name : sides?.buyer.name) ?? null };
      return {
        docId: x.docId, kind: x.docKind, month: x.issuedOn.slice(0, 7), confirmed: true, day: x.issuedOn, name: x.merchant, amount: x.amount,
        direction: x.direction, supply: x.supply, vat: x.vat, supplier: x.direction === 'sales' ? me : other, buyer: x.direction === 'sales' ? other : me, ...extra, approvalNo: approvalOk(x.approvalNo), check: null,
      };
    }
    return { docId: x.docId, kind: 'receipt', month: x.issuedOn.slice(0, 7), confirmed: true, day: x.issuedOn, name: x.merchant, amount: x.amount, direction: null, supply: null, vat: null, supplier: null, buyer: null, receiptOrClaim: null, items: [], approvalNo: null, check: null };
  }
  if (cand && sides) {
    let fields: string[];
    try {
      fields = phone?.paperInvoice ? checkPaperInvoice(phone.paperInvoice).filter((f) => f !== 'direction') : checkPaperDraft(pc!.paperDraft!).map((i) => i.field).filter((f) => f !== 'direction');
    } catch {
      fields = ['shape'];
    }
    const direction = !mine ? null : digits(sides.supplier.bizNo) === mine ? 'sales' : digits(sides.buyer.bizNo) === mine ? 'purchase' : null;
    if (!direction) fields.push('direction');
    const day = dayOk(cand.writtenOn) ? cand.writtenOn : null;
    return {
      docId: x.docId, kind: cand.docKind === 'invoice' ? 'invoice' : 'tax_invoice', month: day?.slice(0, 7) ?? addedFor ?? listedMonth, confirmed: false, day,
      name: (direction === 'sales' ? sides.buyer.name : sides.supplier.name) ?? null, amount: amountOk(cand.total) ? cand.total : null,
      direction, supply: amountOk(cand.supplyAmount) ? cand.supplyAmount : null, vat: amountOk(cand.vatAmount) ? cand.vatAmount : null, ...sides, ...extra, approvalNo: approvalOk(cand.approvalNo), check: paperCheck(fields),
    };
  }
  const c = phone?.ownerConfirmed === true ? phone.candidates : undefined;
  const day = dayOk(c?.issuedOn) ? c.issuedOn : null;
  const amount = amountOk(c?.amount) ? c.amount : null;
  const name = typeof c?.merchant === 'string' ? c.merchant.trim().slice(0, 100) || null : null;
  return {
    docId: x.docId, kind: 'receipt', month: day?.slice(0, 7) ?? addedFor ?? listedMonth, confirmed: false, day, name, amount,
    direction: null, supply: null, vat: null, supplier: null, buyer: null, receiptOrClaim: null, items: [], approvalNo: null, check: day && amount !== null ? null : 'unread',
  };
}

/**
 * 세무사 꾸러미는 세무사가 홈택스에서 볼 수 없는 것만 담는다(대표 결정 2026-11-28): 통장 거래내역, 급여대장, 사장님이 적은 현금 매출, 종이 증빙.
 * 전자세금계산서, 사업용 카드, 현금영수증, 카드 매출, 증명서는 세무사가 홈택스에서 직접 본다.
 */
interface PackPorts {
  /** 그달 통장과 현금 매출(엔진 db.query.bank.packRows). 계좌 연결 전이면 통장이 비어 있다 */
  rows?(month: PackMonth): Promise<PackRows>;
  /** 그달 확인한 급여대장. 급여를 쓰지 않거나 확인 전이면 null */
  payroll?(month: PackMonth): Promise<PackPayLine[] | null>;
  businessName(): string | null;
  /** 그달 꾸러미에 드는 종이 증빙(packEvidence의 month가 그달인 것) */
  evidence?(month: PackMonth): Promise<PackEvidenceSource[]>;
  businessBizNo?(): string | null;
  outRoot: string;
  now?: () => Date;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export const isPackMonth = (m: unknown): m is PackMonth => typeof m === 'string' && MONTH_RE.test(m);

function packMonths(today: string): { last: PackMonth; this: PackMonth } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return { last, this: today.slice(0, 7) };
}

const PACK_RE = /꾸러미|세무사\s*.{0,8}(자료|보낼|넘길|묶)/;
export function packAsk(text: string, today: string): PackMonth | null {
  if (!PACK_RE.test(text)) return null;
  const { last, this: cur } = packMonths(today);
  if (/이번\s*달|이달/.test(text)) return cur;
  const n = /(\d{1,2})\s*월/.exec(text);
  if (n) {
    const mm = Number(n[1]);
    if (mm >= 1 && mm <= 12) {
      const y = Number(today.slice(0, 4));
      const yy = mm > Number(today.slice(5, 7)) ? y - 1 : y;
      return `${yy}-${String(mm).padStart(2, '0')}`;
    }
  }
  return last;
}

const SAFE = (s: string) => s.replace(/[\\/:*?"<>|\p{Cc}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 60) || '이름 없음';
const ymd = (d: string | null) => (d ? d.replaceAll('-', '') : '날짜모름');

type XCell = string | number | null | undefined;
const xCell = (v: XCell) => (v === null || v === undefined ? null : typeof v === 'number' ? { value: v, type: Number, format: '#,##0' } : { value: v, type: String });
/** 시트 하나짜리 엑셀. 첫 줄은 열 이름(굵게)이고 고정한다 */
const xlsx = (sheet: string, head: string[], rows: XCell[][]): Promise<Buffer> =>
  writeXlsxFile(
    [{ sheet, data: [head.map((h) => ({ value: h, fontWeight: 'bold' as const, backgroundColor: '#F2F2F2' })), ...rows.map((r) => r.map(xCell))], columns: head.map((h) => ({ width: Math.max(10, h.length * 2 + 4) })), stickyRowsCount: 1 }] as never,
    { fontFamily: 'Malgun Gothic', fontSize: 10 },
  ).toBuffer();
const bizNoText = (b: string | null | undefined) => (b && /^\d{10}$/.test(b) ? `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}` : (b ?? ''));
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`;
const count = (n: number, unit = '건') => `${n.toLocaleString('ko-KR')}${unit}`;

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(
    (s) => s.isFile(),
    () => false,
  );
}

export class AccountantPack {
  private readonly ports: PackPorts;
  private readonly making = new Map<PackMonth, Promise<PackSummary>>();
  constructor(ports: PackPorts) {
    this.ports = ports;
  }

  dir(month: PackMonth): string {
    return path.join(this.ports.outRoot, month);
  }

  zipPath(month: PackMonth): string {
    return path.join(this.ports.outRoot, this.zipName(month));
  }

  private zipName(month: PackMonth): string {
    const biz = this.ports.businessName();
    return `세무사 꾸러미 ${month}${biz ? ` ${SAFE(biz)}` : ''}.zip`;
  }

  async make(month: PackMonth): Promise<PackSummary> {
    const previous = this.making.get(month);
    const make = () => this.makeNow(month);
    const run = previous ? previous.then(make, make) : make();
    this.making.set(month, run);
    try {
      return await run;
    } finally {
      if (this.making.get(month) === run) this.making.delete(month);
    }
  }

  private async makeNow(month: PackMonth): Promise<PackSummary> {
    const [rows, pay] = await Promise.all([
      this.ports.rows ? this.ports.rows(month) : null,
      this.ports.payroll ? this.ports.payroll(month).catch(() => null) : null,
    ]);
    const dir = this.dir(month);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const files: Array<{ rel: string; bytes: Buffer }> = [];
    const put = async (rel: string, bytes: Buffer) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, rel), bytes, { mode: 0o600 });
      files.push({ rel, bytes });
    };
    const entries: PackEntry[] = [];
    const gaps: PackGap[] = [];
    const me = { bizNo: bizNoText(this.ports.businessBizNo?.() ?? null), name: this.ports.businessName() ?? '' };
    const index: string[] = [];
    const sumOf = <T>(xs: T[], f: (x: T) => number | null) => xs.reduce((t, x) => t + (f(x) ?? 0), 0);
    const mm = Number(month.slice(5));

    index.push('[통장]');
    const end = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), mm, 0)).getUTCDate()).padStart(2, '0')}`;
    if (!rows?.bank.length) index.push('통장: 계좌를 아직 연결하지 않았어요');
    const bank: PackSummary['bank'] = [];
    for (const a of rows?.bank ?? []) {
      const who = `${a.bank} ${a.last4}`;
      const short = !a.coverTo || a.coverTo < end;
      const coverTo = a.coverTo && a.coverTo >= `${month}-01` ? (a.coverTo < end ? a.coverTo : end) : null;
      bank.push({ who, coverTo, full: !short, txns: a.txns.length });
      if (short) gaps.push({ kind: 'bank_short', who, day: coverTo, total: null });
      const upTo = short ? (a.coverTo && a.coverTo >= `${month}-01` ? `${Number(a.coverTo.slice(8))}일까지` : '못 받음') : '전부';
      if (!a.txns.length) {
        index.push(`통장 ${who}: ${upTo}, 거래 없음`);
        continue;
      }
      const name = `01 통장 거래내역 ${SAFE(who)}.xlsx`;
      await put(name, await xlsx('거래내역', ['거래일시', '적요', '메모', '출금', '입금', '잔액'],
        a.txns.map((t) => [t.at.replace('T', ' ').slice(0, 19), t.payer ?? '', t.memo ?? '', t.direction === 'out' ? t.amount : null, t.direction === 'in' ? t.amount : null, t.balance])));
      entries.push({ name, kind: 'xlsx', note: count(a.txns.length) });
      index.push(`통장 ${who}: ${upTo}, ${count(a.txns.length)}`);
    }

    const payroll = pay?.length ? { people: pay.length, gross: sumOf(pay, (l) => l.gross) } : null;
    if (pay?.length) {
      await put('02 급여대장.xlsx', await xlsx('급여대장', ['성명', '총지급액', '비과세', '소득세', '지방소득세', '국민연금', '건강보험', '장기요양보험', '고용보험', '실지급액'],
        pay.map((l) => [l.name, l.gross, l.nontax, l.incomeTax, l.localIncomeTax, l.pension, l.health, l.ltc, l.employment, l.netPay])));
      entries.push({ name: '02 급여대장.xlsx', kind: 'xlsx', note: count(pay.length, '명') });
      index.push('', `[급여] ${count(pay.length, '명')}, 총지급 ${won(sumOf(pay, (l) => l.gross))}`);
    } else index.push('', `[급여] ${mm}월에 확인한 급여대장 없음`);

    const cash = (rows?.cashSales ?? []).filter((c) => c.day.startsWith(`${month}-`) && c.amount > 0);
    const cashSum = cash.length ? { days: cash.length, total: sumOf(cash, (c) => c.amount) } : null;
    if (cash.length) {
      await put('03 현금 매출.xlsx', await xlsx('현금 매출', ['날짜', '금액'], cash.map((c) => [c.day, c.amount])));
      entries.push({ name: '03 현금 매출.xlsx', kind: 'xlsx', note: count(cash.length, '일') });
      index.push('', `[현금 매출] ${count(cash.length, '일')}, 합계 ${won(sumOf(cash, (c) => c.amount))}`);
    }

    const usedNames = new Set<string>();
    const unique = (name: string) => {
      let n = name;
      for (let i = 2; usedNames.has(n); i++) n = name.replace(/(\.[a-z]+)$/, `_${i}$1`);
      usedNames.add(n);
      return n;
    };
    const myBiz = this.ports.businessBizNo?.() ?? null;
    const src = ((await this.ports.evidence?.(month).catch(() => [])) ?? [])
      .filter((x) => x.month === month)
      .sort((a, b) => (a.day ?? `${month}-99`).localeCompare(b.day ?? `${month}-99`) || a.docId.localeCompare(b.docId));
    const evidence: PackEvidence[] = [];
    const KIND_KO = { tax_invoice: '세금계산서', invoice: '계산서(면세)', receipt: '영수증' } as const;
    const DIR_KO = { sales: '매출', purchase: '매입' } as const;
    for (const x of src) {
      // 폰으로 찍은 것은 확장자 없는 JPEG로 보관한다. PC로 올린 것은 jpg, png, pdf
      const ext = x.file ? path.extname(x.file).toLowerCase() || '.jpg' : '';
      let image: string | null = null;
      if (x.file && ['.jpg', '.jpeg', '.png', '.pdf', '.heic'].includes(ext) && (await exists(x.file))) {
        const who = SAFE(x.name ?? (x.kind === 'receipt' ? '가게' : '거래처'));
        image = x.kind === 'receipt'
          ? `04 증빙/영수증/${unique(`${ymd(x.day)}_${who}_${x.amount ?? '금액모름'}${ext}`)}`
          : `04 증빙/종이 계산서/${unique(`${ymd(x.day)}_${x.direction ? DIR_KO[x.direction] : '확인필요'}_${who}_${x.docId.slice(-6)}${ext}`)}`;
        await put(image, await fs.readFile(x.file));
      }
      evidence.push({
        docId: x.docId, kind: x.kind, confirmed: x.confirmed, day: x.day, name: x.name, amount: x.amount, direction: x.direction,
        supply: x.supply, vat: x.vat, supplier: x.supplier, buyer: x.buyer, approvalNo: x.approvalNo, check: x.check, image,
      });
      if (x.check) gaps.push({ kind: x.kind === 'receipt' ? 'receipt_check' : 'paper_check', who: x.name, day: x.day, total: x.amount });
    }
    const paper = src.filter((x) => x.kind !== 'receipt');
    if (paper.length) {
      await put('04 증빙/종이 계산서.xlsx', await xlsx('종이 계산서', ['구분', '종류', '작성일자', '공급자 사업자번호', '공급자 상호', '공급받는자 사업자번호', '공급받는자 상호', '공급가액', '세액', '합계', '영수/청구', '품목', '원본 사진', '확인'],
        paper.map((x) => [
          x.direction ? DIR_KO[x.direction] : '확인 필요', KIND_KO[x.kind], x.day ?? '',
          bizNoText(x.supplier?.bizNo ?? (x.direction === 'sales' ? myBiz : null)), x.supplier?.name ?? '', bizNoText(x.buyer?.bizNo ?? (x.direction === 'purchase' ? myBiz : null)), x.buyer?.name ?? '',
          x.supply, x.vat, x.amount, x.receiptOrClaim === 'receipt' ? '영수' : x.receiptOrClaim === 'claim' ? '청구' : '',
          x.items.join(' / '), evidence.find((e) => e.docId === x.docId)?.image ? '있음' : '없음', x.check ? '확인 필요' : x.confirmed ? '사장님 확인' : '이상 없음',
        ])));
    }
    const receipts = src.filter((x) => x.kind === 'receipt');
    const evidenceFiles = files.filter((f) => f.rel.startsWith('04 증빙/')).length;
    if (evidenceFiles) entries.push({ name: '04 증빙', kind: 'dir', note: count(evidenceFiles, '개') });
    const paperLine = paper.length ? `종이 계산서 ${count(paper.length)}(매출 ${paper.filter((r) => r.direction === 'sales').length}, 매입 ${paper.filter((r) => r.direction === 'purchase').length})` : '';
    const photoLine = receipts.length ? `영수증 ${count(receipts.length, '장')}` : '';
    index.push('', `[증빙] ${[paperLine, photoLine].filter(Boolean).join(', ') || `${mm}월에 넣은 종이 증빙 없음`}`);
    gaps.sort((a, b) => GAP_ORDER.indexOf(a.kind) - GAP_ORDER.indexOf(b.kind) || (a.day ?? '').localeCompare(b.day ?? ''));

    const madeAt = (this.ports.now?.() ?? new Date()).toISOString();
    const label = `${Number(month.slice(5))}월`;
    const gapLine = (g: PackGap) =>
      g.kind === 'bank_short' ? `${g.who} 통장: ${g.day ? `${Number(g.day.slice(8)) + 1}일부터` : `${label} 전부`} 못 받았어요`
      : `${GAP_LABEL[g.kind]}${g.who ? `, ${g.who}` : ''}${g.day ? `, ${g.day}` : ''}${g.total !== null ? `, ${won(g.total)}` : ''}`;
    const readme = [
      `${me.name || '사업장'}${me.bizNo ? ` (${me.bizNo})` : ''} ${month.slice(0, 4)}년 ${label} 세무사 꾸러미`,
      `만든 때 ${new Date(madeAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
      '홈택스에서 보실 수 있는 전자세금계산서, 사업용 카드, 현금영수증, 카드 매출은 넣지 않았어요.',
      '',
      ...index,
      '',
      gaps.length ? '[빠진 것]' : '[빠진 것] 없음',
      ...gaps.map((g) => `- ${gapLine(g)}`),
    ].join('\r\n');
    const indexName = '00 목록.txt';
    await put(indexName, Buffer.from('﻿' + readme + '\r\n'));
    entries.unshift({ name: indexName, kind: 'txt', note: '한눈에 보기' });

    const zipName = this.zipName(month);
    const top = zipName.replace(/\.zip$/, '');
    await writePrivateExport(path.join(this.ports.outRoot, zipName), zip(files.map((f) => ({ name: `${top}/${f.rel}`, bytes: f.bytes })), new Date(madeAt)));
    return { month, label, entries, gaps, bank, payroll, cash: cashSum, evidence, zipName, files: files.map((f) => f.rel), madeAt };
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function zip(entries: Array<{ name: string; bytes: Uint8Array }>, at: Date): Buffer {
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = deflateRawSync(e.bytes);
    const crc = crc32(e.bytes);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(e.bytes.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(e.bytes.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const MONTH = { t: 'string', max: 7, required: true } as const;
const DOC = { t: 'string', max: 64, required: true } as const;
export const PACK_SHELL_METHODS = {
  'pack.make': { month: MONTH },
  'pack.reveal': { month: MONTH },
  'pack.share': { month: MONTH },
  'pack.paperAdd': { month: MONTH },
  'pack.paperThumb': { docId: DOC },
  'pack.paperSave': {
    docId: DOC,
    kind: { t: 'enum', of: ['tax_invoice', 'invoice', 'receipt'], required: true },
    day: { t: 'string', max: 10, required: true },
    name: { t: 'string', max: 100, nullable: true },
    bizNo: { t: 'string', max: 20, nullable: true },
    amount: { t: 'number', required: true },
    direction: { t: 'enum', of: ['sales', 'purchase'], nullable: true },
    supply: { t: 'number' },
    vat: { t: 'number' },
    approvalNo: { t: 'string', max: 26, nullable: true },
  },
  'pack.paperRemove': { docId: DOC },
} as const;
