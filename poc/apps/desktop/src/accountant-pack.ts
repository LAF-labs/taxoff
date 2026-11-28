import fs from 'node:fs/promises';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import writeXlsxFile from 'write-excel-file/node';
import { checkPaperInvoice, paperDirection, type PaperInvoice } from '@sax/remote';
import { writePrivateExport } from './private-exports.ts';
import type { Doc } from './shell-model.ts';
import type { PastRun } from './run-history.ts';

type PackMonth = string;

interface PackInvoice {
  runId: string;
  day: string | null;
  who: string | null;
  supply: number | null;
  tax: number | null;
  total: number | null;
  approvalNo: string | null;
  mail: PastRun['mail'];
  pdf: string | null;
}

type PackGapKind = 'not_received' | 'bank_short' | 'unsure' | 'no_pdf' | 'mail_unconfirmed' | 'not_issued' | 'paper_check';
interface PackGap {
  kind: PackGapKind;
  who: string | null;
  day: string | null;
  total: number | null;
}

/** 엔진 db.query.bank.packRows 답(그달 홈택스 자료와 통장, ADR-072 장부와 같은 줄) */
interface PackRows {
  sales: { known: boolean; rows: PackInvoiceRow[] };
  purchases: { known: boolean; rows: PackInvoiceRow[] };
  card: { known: boolean; rows: Array<{ usedOn: string; cardLast4: string | null; merchantBizNo: string | null; merchant: string | null; supply: number | null; vat: number | null; amount: number; canceled: boolean; deductible: boolean | null }> };
  cashReceiptsOut: { known: boolean; rows: PackReceiptRow[] };
  cashReceiptsIn: { known: boolean; rows: PackReceiptRow[] };
  cardSales: { known: boolean; rows: Array<{ issuer: string; count: number; amount: number }> };
  bank: Array<{ bank: string; last4: string; coverTo: string | null; txns: Array<{ at: string; direction: 'in' | 'out'; amount: number; balance: number | null; payer: string | null; memo: string | null }> }>;
}
type PackInvoiceRow = { approvalNo: string | null; writtenOn: string; cpBizNo: string | null; cpName: string | null; item: string | null; supply: number | null; tax: number | null; total: number };
type PackReceiptRow = { day: string; approvalNo: string; supply: number | null; tax: number | null; amount: number; cpBizNo: string | null; cpName: string | null; canceled: boolean; deductible: boolean | null };

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

/** 꾸러미 맨 위 파일이나 폴더 한 줄(화면 목록). note는 든 것("3건"), missing이면 자료를 아직 못 받아 파일을 넣지 않았다 */
interface PackEntry {
  name: string;
  kind: 'xlsx' | 'txt' | 'dir';
  note: string;
  missing?: boolean;
}

interface PackSummary {
  month: PackMonth;
  label: string;
  entries: PackEntry[];
  invoices: PackInvoice[];
  certs: Array<{ id: string; name: string; issuedOn: string | null; file: string | null }>;
  gaps: PackGap[];
  paper: PackPaper[];
  zipName: string;
  files: string[];
  madeAt: string;
}

export const GAP_LABEL: Record<PackGapKind, string> = {
  not_received: '자료를 아직 못 받았어요',
  bank_short: '통장 거래내역을 다 받지 못했어요',
  unsure: '발급됐는지 확인 필요',
  no_pdf: 'PDF 없음',
  mail_unconfirmed: '메일 확인 못 함',
  not_issued: '발급 안 된 시도',
  paper_check: '종이 세금계산서 값 확인 필요',
};
const GAP_ORDER: PackGapKind[] = ['not_received', 'bank_short', 'unsure', 'no_pdf', 'mail_unconfirmed', 'not_issued', 'paper_check'];

/** 폰이나 PC로 넣은 증빙 하나. paper가 있으면 종이 세금계산서, 없으면 영수증이다 */
interface PackPaperSource {
  docId: string;
  paper?: PaperInvoice | null;
  file: string | null;
  issuedOn?: string | null;
  merchant?: string | null;
  amount?: number | null;
}

interface PackPaper {
  docId: string;
  direction: 'sales' | 'purchase' | null;
  docKind: PaperInvoice['docKind'];
  writtenOn: string;
  supplier: string;
  buyer: string;
  supply: number;
  tax: number;
  total: number;
  issues: string[];
  image: string | null;
}

interface PackPorts {
  past(): Promise<PastRun[]>;
  docs(): Promise<Doc[]>;
  docFile(id: string): Promise<string>;
  /** 그달 홈택스 자료와 통장(엔진 db.query.bank.packRows). 계좌 연결이나 홈택스 받기 전이면 비어 있다 */
  rows?(month: PackMonth): Promise<PackRows>;
  /** 그달 확인한 급여대장. 급여를 쓰지 않거나 확인 전이면 null */
  payroll?(month: PackMonth): Promise<PackPayLine[] | null>;
  businessName(): string | null;
  paperInvoices?(month: PackMonth): Promise<PackPaperSource[]>;
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
const signed = (n: number | null, canceled: boolean) => (n === null ? null : canceled ? -Math.abs(n) : n);
const DEDUCT_KO = (d: boolean | null) => (d === null ? '' : d ? '공제' : '불공제');
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
    const [past, docs, rows, pay] = await Promise.all([
      this.ports.past(),
      this.ports.docs(),
      this.ports.rows ? this.ports.rows(month) : null,
      this.ports.payroll ? this.ports.payroll(month).catch(() => null) : null,
    ]);
    const inMonth = past.filter((p) => p.day?.startsWith(month)).sort((a, b) => `${a.day}${a.time}`.localeCompare(`${b.day}${b.time}`));
    const dir = this.dir(month);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const files: Array<{ rel: string; bytes: Buffer }> = [];
    const put = async (rel: string, bytes: Buffer) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(dir, rel), bytes, { mode: 0o600 });
      files.push({ rel, bytes });
    };
    const fileOf = async (id: string | null): Promise<string | null> => {
      if (!id) return null;
      const f = await this.ports.docFile(id).catch(() => null);
      return f && path.extname(f).toLowerCase() === '.pdf' && (await exists(f)) ? f : null;
    };
    const entries: PackEntry[] = [];
    const gaps: PackGap[] = [];
    const me = { bizNo: bizNoText(this.ports.businessBizNo?.() ?? null), name: this.ports.businessName() ?? '' };
    const index: string[] = [];

    // 홈택스 자료: 다 받은 달만 파일로 넣는다. 받지 못했으면 파일을 빼고 빠진 것과 목록에 적는다(0건처럼 보이지 않게)
    const sheet = async (n: number, title: string, known: boolean, rowCount: number, note: string, make: () => Promise<Buffer>, line: string) => {
      const name = `${String(n).padStart(2, '0')} ${title}.xlsx`;
      if (!known) {
        entries.push({ name, kind: 'xlsx', note: '아직 못 받았어요', missing: true });
        gaps.push({ kind: 'not_received', who: title, day: null, total: null });
        index.push(`${title}: 홈택스에서 아직 못 받았어요`);
        return;
      }
      if (!rowCount) {
        index.push(`${title}: ${Number(month.slice(5))}월에 없음`);
        return;
      }
      await put(name, await make());
      entries.push({ name, kind: 'xlsx', note });
      index.push(line);
    };
    const sumOf = <T>(xs: T[], f: (x: T) => number | null) => xs.reduce((t, x) => t + (f(x) ?? 0), 0);
    const invoiceSheet = (r: PackRows['sales'], sale: boolean) => () =>
      xlsx(sale ? '매출' : '매입', ['작성일자', '승인번호', '공급자사업자등록번호', '공급자 상호', '공급받는자사업자등록번호', '공급받는자 상호', '합계금액', '공급가액', '세액', '품목명'],
        r.rows.map((v) => {
          const other = [bizNoText(v.cpBizNo), v.cpName ?? ''];
          const self = [me.bizNo, me.name];
          return [v.writtenOn, v.approvalNo ?? '', ...(sale ? [...self, ...other] : [...other, ...self]), v.total, v.supply, v.tax, v.item ?? ''];
        }));
    const invoiceLine = (title: string, r: PackRows['sales']) =>
      `${title} ${count(r.rows.length)}, 공급가액 ${won(sumOf(r.rows, (v) => v.supply))}, 세액 ${won(sumOf(r.rows, (v) => v.tax))}, 합계 ${won(sumOf(r.rows, (v) => v.total))}`;

    if (rows) {
      index.push('[매출]');
      await sheet(1, '매출 전자세금계산서', rows.sales.known, rows.sales.rows.length, count(rows.sales.rows.length), invoiceSheet(rows.sales, true), invoiceLine('매출 전자세금계산서', rows.sales));
      const crIn = rows.cashReceiptsIn.rows;
      await sheet(5, '현금영수증 매출', rows.cashReceiptsIn.known, crIn.length, count(crIn.length),
        () => xlsx('현금영수증 매출', ['거래일자', '승인번호', '공급가액', '부가세', '총금액', '거래구분'], crIn.map((c) => [c.day, c.approvalNo, signed(c.supply, c.canceled), signed(c.tax, c.canceled), signed(c.amount, c.canceled), c.canceled ? '취소거래' : '승인거래'])),
        `현금영수증 매출 ${count(crIn.length)}, 합계 ${won(sumOf(crIn, (c) => signed(c.amount, c.canceled)))}`);
      const cs = rows.cardSales.rows;
      await sheet(6, '카드 매출', rows.cardSales.known, cs.length, count(cs.length, '곳'),
        () => xlsx('카드 매출', ['년월', '자료 구분', '건수', '매출액'], cs.map((c) => [month, c.issuer, c.count, c.amount])),
        `카드 매출 ${count(cs.length, '곳')}, 합계 ${won(sumOf(cs, (c) => c.amount))}`);
      index.push('', '[매입]');
      await sheet(2, '매입 전자세금계산서', rows.purchases.known, rows.purchases.rows.length, count(rows.purchases.rows.length), invoiceSheet(rows.purchases, false), invoiceLine('매입 전자세금계산서', rows.purchases));
      const card = rows.card.rows;
      await sheet(3, '사업용 카드 매입', rows.card.known, card.length, count(card.length),
        () => xlsx('사업용 카드', ['승인일자', '카드번호', '가맹점사업자번호', '가맹점명', '공급가액', '부가세', '합계', '공제여부', '거래구분'],
          card.map((c) => [c.usedOn, c.cardLast4 ? `****-****-****-${c.cardLast4}` : '', bizNoText(c.merchantBizNo), c.merchant ?? '', signed(c.supply, c.canceled), signed(c.vat, c.canceled), signed(c.amount, c.canceled), DEDUCT_KO(c.deductible), c.canceled ? '취소' : '승인'])),
        `사업용 카드 ${count(card.length)}, 합계 ${won(sumOf(card, (c) => signed(c.amount, c.canceled)))} (공제 ${count(card.filter((c) => c.deductible && !c.canceled).length)})`);
      const crOut = rows.cashReceiptsOut.rows;
      await sheet(4, '현금영수증 매입', rows.cashReceiptsOut.known, crOut.length, count(crOut.length),
        () => xlsx('현금영수증 매입', ['매입일자', '가맹점 사업자번호', '가맹점명', '공급가액', '부가세', '총금액', '승인번호', '거래구분', '공제여부'],
          crOut.map((c) => [c.day, bizNoText(c.cpBizNo), c.cpName ?? '', signed(c.supply, c.canceled), signed(c.tax, c.canceled), signed(c.amount, c.canceled), c.approvalNo, c.canceled ? '취소거래' : '승인거래', DEDUCT_KO(c.deductible)])),
        `현금영수증 매입 ${count(crOut.length)}, 합계 ${won(sumOf(crOut, (c) => signed(c.amount, c.canceled)))} (공제 ${count(crOut.filter((c) => c.deductible && !c.canceled).length)})`);
      entries.sort((a, b) => a.name.localeCompare(b.name));

      index.push('', '[통장]');
      const end = `${month}-${String(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
      if (!rows.bank.length) index.push('통장: 계좌를 아직 연결하지 않았어요');
      for (const a of rows.bank) {
        const who = `${a.bank} ${a.last4}`;
        const short = !a.coverTo || a.coverTo < end;
        if (short) gaps.push({ kind: 'bank_short', who, day: a.coverTo && a.coverTo >= `${month}-01` ? a.coverTo : null, total: null });
        const upTo = short ? (a.coverTo && a.coverTo >= `${month}-01` ? `${Number(a.coverTo.slice(8))}일까지` : '못 받음') : '전부';
        if (!a.txns.length) {
          index.push(`통장 ${who}: ${upTo}, 거래 없음`);
          continue;
        }
        const name = `07 통장 거래내역 ${SAFE(who)}.xlsx`;
        await put(name, await xlsx('거래내역', ['거래일시', '적요', '메모', '출금', '입금', '잔액'],
          a.txns.map((t) => [t.at.replace('T', ' ').slice(0, 19), t.payer ?? '', t.memo ?? '', t.direction === 'out' ? t.amount : null, t.direction === 'in' ? t.amount : null, t.balance])));
        entries.push({ name, kind: 'xlsx', note: count(a.txns.length) });
        index.push(`통장 ${who}: ${upTo}, ${count(a.txns.length)}`);
      }
    } else index.push('홈택스 자료와 통장: 아직 연결하지 않았어요');

    if (pay?.length) {
      await put('08 급여대장.xlsx', await xlsx('급여대장', ['성명', '총지급액', '비과세', '소득세', '지방소득세', '국민연금', '건강보험', '장기요양보험', '고용보험', '실지급액'],
        pay.map((l) => [l.name, l.gross, l.nontax, l.incomeTax, l.localIncomeTax, l.pension, l.health, l.ltc, l.employment, l.netPay])));
      entries.push({ name: '08 급여대장.xlsx', kind: 'xlsx', note: count(pay.length, '명') });
      index.push('', `[급여] ${count(pay.length, '명')}, 총지급 ${won(sumOf(pay, (l) => l.gross))}`);
    } else index.push('', `[급여] ${Number(month.slice(5))}월에 확인한 급여대장 없음`);

    const invoices: PackInvoice[] = [];
    const usedNames = new Set<string>();
    for (const p of inMonth) {
      const g = { who: p.who, day: p.day, total: p.total };
      if (p.kind === 'unsure') gaps.push({ kind: 'unsure', ...g });
      if (p.kind === 'not_issued' || p.kind === 'stopped_before_gate') gaps.push({ kind: 'not_issued', ...g });
      if (p.kind !== 'issued') continue;
      const src = await fileOf(p.documentId);
      let pdf: string | null = null;
      if (src) {
        let name = `${ymd(p.day)}_${SAFE(p.who ?? '거래처')}_${(p.approvalNo ?? p.runId).slice(-8)}.pdf`;
        for (let i = 2; usedNames.has(name); i++) name = name.replace(/(_\d+)?\.pdf$/, `_${i}.pdf`);
        usedNames.add(name);
        pdf = `09 증빙/세금계산서/${name}`;
        await put(pdf, await fs.readFile(src));
      } else gaps.push({ kind: 'no_pdf', ...g });
      if (p.mail !== 'sent') gaps.push({ kind: 'mail_unconfirmed', ...g });
      invoices.push({ runId: p.runId, day: p.day, who: p.who, supply: p.supply, tax: p.tax, total: p.total, approvalNo: p.approvalNo, mail: p.mail, pdf });
    }

    const paper: PackPaper[] = [];
    const evidenceSrc = (await this.ports.paperInvoices?.(month).catch(() => [])) ?? [];
    const paperSrc = evidenceSrc.filter((x): x is PackPaperSource & { paper: PaperInvoice } => !!x.paper?.writtenOn?.startsWith(month)).sort((a, b) => a.paper.writtenOn.localeCompare(b.paper.writtenOn));
    let receiptPhotos = 0;
    for (const x of evidenceSrc.filter((e) => !e.paper && e.issuedOn?.startsWith(month)).sort((a, b) => a.issuedOn!.localeCompare(b.issuedOn!))) {
      const ext = path.extname(x.file ?? '').toLowerCase();
      if (!x.file || !['.jpg', '.jpeg', '.png', '.pdf', '.heic'].includes(ext) || !(await exists(x.file))) continue;
      let name = `${ymd(x.issuedOn!)}_${SAFE(x.merchant ?? '가게')}_${x.amount ?? '금액모름'}${ext}`;
      for (let i = 2; usedNames.has(name); i++) name = name.replace(/(_\d+)?(\.[a-z]+)$/, `_${i}$2`);
      usedNames.add(name);
      await put(`09 증빙/영수증/${name}`, await fs.readFile(x.file));
      receiptPhotos++;
    }
    const myBiz = this.ports.businessBizNo?.() ?? null;
    for (const x of paperSrc) {
      const p = x.paper;
      let issues: string[];
      try {
        issues = checkPaperInvoice(p);
      } catch {
        issues = ['shape'];
      }
      const direction = paperDirection(p, myBiz);
      if (!direction) issues = [...issues, 'direction'];
      let image: string | null = null;
      if (x.file && /\.(jpe?g)?$/i.test(path.extname(x.file) || '.jpg') && (await exists(x.file))) {
        let name = `${ymd(p.writtenOn)}_${direction === 'sales' ? '매출' : direction === 'purchase' ? '매입' : '확인필요'}_${SAFE(direction === 'purchase' ? p.supplier?.name ?? '' : p.buyer?.name ?? '')}_${x.docId.slice(-6)}.jpg`;
        for (let i = 2; usedNames.has(name); i++) name = name.replace(/(_\d+)?\.jpg$/, `_${i}.jpg`);
        usedNames.add(name);
        image = `09 증빙/종이 세금계산서/${name}`;
        await put(image, await fs.readFile(x.file));
      }
      const row: PackPaper = {
        docId: x.docId, direction, docKind: p.docKind, writtenOn: p.writtenOn,
        supplier: p.supplier?.name ?? '', buyer: p.buyer?.name ?? '', supply: p.supplyAmount, tax: p.vatAmount, total: p.total, issues, image,
      };
      paper.push(row);
      if (issues.length) gaps.push({ kind: 'paper_check', who: direction === 'purchase' ? row.supplier : row.buyer, day: p.writtenOn, total: p.total });
    }
    if (paper.length) {
      const DIR_KO = { sales: '매출', purchase: '매입' } as const;
      const name = '09 증빙/종이 세금계산서.xlsx';
      await put(name, await xlsx('종이 세금계산서', ['구분', '종류', '작성일자', '공급자 사업자번호', '공급자 상호', '공급받는자 사업자번호', '공급받는자 상호', '공급가액', '세액', '합계', '영수/청구', '품목', '원본 사진', '확인'],
        paper.map((r) => {
          const p = paperSrc.find((x) => x.docId === r.docId)!.paper;
          return [
            r.direction ? DIR_KO[r.direction] : '확인 필요', r.docKind === 'invoice' ? '계산서(면세)' : '세금계산서', r.writtenOn,
            bizNoText(p.supplier?.bizNo), r.supplier, bizNoText(p.buyer?.bizNo), r.buyer, r.supply, r.tax, r.total,
            p.receiptOrClaim === 'receipt' ? '영수' : p.receiptOrClaim === 'claim' ? '청구' : '',
            (p.items ?? []).map((it) => it.name).join(' / '), r.image ? '있음' : '없음', r.issues.length ? `확인 필요(${r.issues.join(', ')})` : '이상 없음',
          ];
        })));
    }
    const evidence = files.filter((f) => f.rel.startsWith('09 증빙/')).length;
    if (evidence) entries.push({ name: '09 증빙', kind: 'dir', note: count(evidence, '개') });
    index.push('', `[증빙] 이 앱에서 발급한 세금계산서 PDF ${count(invoices.filter((v) => v.pdf).length, '개')}${paper.length ? `, 종이 세금계산서 ${count(paper.length)}(매출 ${paper.filter((r) => r.direction === 'sales').length}, 매입 ${paper.filter((r) => r.direction === 'purchase').length})` : ''}${receiptPhotos ? `, 영수증 ${count(receiptPhotos, '장')}` : ''}`);

    const certs: PackSummary['certs'] = [];
    for (const d of docs.filter((x) => x.kind === '증명서' && x.profile !== 'personal' && x.issuedOn?.startsWith(month))) {
      const src = await fileOf(d.id);
      let file: string | null = null;
      if (src) {
        file = `10 증명서/${ymd(d.issuedOn)}_${SAFE(d.docName || d.name)}_${d.id.slice(-6)}.pdf`;
        await put(file, await fs.readFile(src));
      }
      certs.push({ id: d.id, name: d.docName || d.name, issuedOn: d.issuedOn, file });
    }
    if (certs.some((c) => c.file)) entries.push({ name: '10 증명서', kind: 'dir', note: count(certs.filter((c) => c.file).length, '개') });
    index.push(`[증명서] ${certs.length ? certs.map((c) => c.name).join(', ') : `${Number(month.slice(5))}월에 뗀 증명서 없음`}`);
    gaps.sort((a, b) => GAP_ORDER.indexOf(a.kind) - GAP_ORDER.indexOf(b.kind) || (a.day ?? '').localeCompare(b.day ?? ''));

    const madeAt = (this.ports.now?.() ?? new Date()).toISOString();
    const label = `${Number(month.slice(5))}월`;
    const gapLine = (g: PackGap) =>
      g.kind === 'not_received' ? `${g.who}: 홈택스에서 아직 못 받았어요`
      : g.kind === 'bank_short' ? `${g.who} 통장: ${g.day ? `${Number(g.day.slice(8)) + 1}일부터` : `${label} 전부`} 못 받았어요`
      : `${GAP_LABEL[g.kind]}${g.who ? `, ${g.who}` : ''}${g.day ? `, ${g.day}` : ''}${g.total !== null ? `, ${won(g.total)}` : ''}`;
    const readme = [
      `${me.name || '사업장'}${me.bizNo ? ` (${me.bizNo})` : ''} ${month.slice(0, 4)}년 ${label} 세무사 꾸러미`,
      `만든 때 ${new Date(madeAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}`,
      '',
      ...index,
      '',
      gaps.length ? '[빠진 것]' : '[빠진 것] 없음',
      ...gaps.map((g) => `- ${gapLine(g)}`),
    ].join('\r\n');
    const indexName = '00 목록과 합계.txt';
    await put(indexName, Buffer.from('﻿' + readme + '\r\n'));
    entries.unshift({ name: indexName, kind: 'txt', note: '한눈에 보기' });

    const zipName = this.zipName(month);
    const top = zipName.replace(/\.zip$/, '');
    await writePrivateExport(path.join(this.ports.outRoot, zipName), zip(files.map((f) => ({ name: `${top}/${f.rel}`, bytes: f.bytes })), new Date(madeAt)));
    return { month, label, entries, invoices, certs, gaps, paper, zipName, files: files.map((f) => f.rel), madeAt };
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
export const PACK_SHELL_METHODS = {
  'pack.make': { month: MONTH },
  'pack.reveal': { month: MONTH },
  'pack.share': { month: MONTH },
} as const;
