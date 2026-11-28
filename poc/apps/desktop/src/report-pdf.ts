import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReportResult } from '@sax/engine';
import { bigWon, reportDocHtml, type ReportDoc, type ReportDocLine, type ReportDocRank } from '@sax/remote';
import { invoiceFonts, type HtmlToPdf } from './invoice-pdf.ts';
import { writePrivateExport } from './private-exports.ts';

/**
 * 월 리포트 PDF(ADR-068 결정 11). 엔진 리포트 값을 ReportDoc으로 옮기고 공용 reportDocHtml로 그린다.
 * 폰도 같은 ReportDoc 모양(리포트 사본)에서 같은 함수로 그린다.
 */

export const OUT_LABEL: Record<string, string> = { payable: '매입 결제', payroll: '급여', card_payment: '카드대금', tax: '세금과 4대보험', other: '기타' };
export const IN_LABEL: Record<string, string> = { receivable: '받을 돈', card_sales: '카드 매출 입금', interest: '이자', other: '기타' };
const OUT_ORDER = ['payable', 'payroll', 'card_payment', 'tax', 'other'];
const IN_ORDER = ['receivable', 'card_sales', 'interest', 'other'];

const md = (iso: string) => `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일`;

/** 달력 기간 이름(month = 기간 끝 달): "11월", "4분기", "하반기", "2026년" */
export function spanName(month: string, months: number): string {
  const m = Number(month.slice(5, 7));
  return months === 1 ? `${m}월` : months === 3 ? `${m / 3}분기` : months === 6 ? (m <= 6 ? '상반기' : '하반기') : `${month.slice(0, 4)}년`;
}

/** 기간 글: "2026년 11월", "2026년 4분기", "2026년 하반기", "2026년" */
export function periodText(month: string, months: number): string {
  return months === 12 ? `${month.slice(0, 4)}년` : `${month.slice(0, 4)}년 ${spanName(month, months)}`;
}

const PREV: Record<number, string> = { 1: '지난달', 3: '앞 분기', 6: '앞 반기', 12: '작년' };

export function reportFileName(month: string, months: number): string {
  return `택스오프 리포트 ${periodText(month, months)}.pdf`;
}

const kstText = (ms: number) => {
  const d = new Date(ms + 9 * 3_600_000);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

type Amount = { amount: number | null; partial: boolean };

/** 화면(shell-report.js trendText)과 같은 비교 글 */
export function trendText(months: number, cur: Amount, prev: Amount, comparable: boolean): string | null {
  if (cur.amount === null) return null;
  if (prev.amount === null || !prev.amount || !comparable || (prev.partial && !cur.partial)) return `비교할 ${PREV[months]} 자료가 없어요`;
  const label = `${PREV[months]}보다`;
  const diff = cur.amount - prev.amount;
  const p = Math.round((diff / prev.amount) * 100);
  if (!diff) return `${label} 같아요`;
  const sign = diff > 0 ? '+' : '−';
  return `${label} ${sign}${bigWon(Math.abs(diff))} (${sign}${Math.abs(p)}%)`;
}

const shortWon = (v: number) => {
  const a = Math.abs(v);
  const [u, name] = a >= 1e12 ? [1e12, '조'] : a >= 1e8 ? [1e8, '억'] : [1e4, '만'];
  const n = v / (u as number);
  return `${(Math.abs(n) >= 100 || name === '만' ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-US')}${name}원`;
};
const spanText = (r: ReportResult) => spanName(r.month, r.months);

/** 화면 달마다 카드의 한 줄(shell-report.js headline, 작년과 비교를 끈 모양) */
export function headlineText(r: ReportResult): string | null {
  const total = r.sales.total.amount;
  if (total === null) return null;
  const what = `${spanText(r)} 매출은 ${shortWon(total)}`;
  const prev = r.prev.sales;
  if (!r.prev.comparable.sales || !prev.amount || (prev.partial && !r.sales.total.partial)) return `${what}이에요`;
  const label = `${PREV[r.months]}보다`;
  const p = Math.round(((total - prev.amount) / prev.amount) * 100);
  return p === 0 ? `${what}, ${label} 같아요` : `${what}, ${label} ${Math.abs(p)}% ${p > 0 ? '많아요' : '적어요'}`;
}

const dday = (today: string, day: string) => {
  const n = Math.round((Date.parse(day) - Date.parse(today)) / 86_400_000);
  return n > 0 ? ` D-${n}` : n === 0 ? ' D-DAY' : '';
};

/** 화면 "왜 늘었을까" 카드와 같은 줄 */
function whyOf(r: ReportResult): ReportDoc['why'] {
  const diff = r.sales.total.amount !== null && r.prev.sales.amount !== null ? r.sales.total.amount - r.prev.sales.amount : 0;
  const rows = r.why.filter((x) => (diff > 0 ? x.delta > 0 : x.delta < 0)).slice(0, 3);
  if (!rows.length || !diff) return null;
  return {
    title: `${spanText(r)} 매출이 왜 ${diff > 0 ? '늘었을까' : '줄었을까'}`,
    rows: rows.map((x) => ({ label: x.kind === 'item' ? `${x.name ?? '품목 없음'} 품목` : (x.name ?? '이름 없음'), delta: x.delta })),
  };
}

/** 화면 요약 카드와 같은 두 줄: 앞 기간 합계와 평균(1개월은 하루 평균) */
function summaryRows(r: ReportResult, total: Amount, prev: Amount, comparable: boolean): ReportDocLine[] {
  const prevName = PREV[r.months]!;
  const end = r.to < r.today ? r.to : r.today;
  const days = Math.round((Date.parse(end) - Date.parse(r.from)) / 86_400_000) + 1;
  const gone = Math.max(1, r.series.filter((m) => m.inWindow && m.month <= r.today.slice(0, 7)).length);
  const avg = total.amount === null ? null : r.months === 1 ? total.amount / days : total.amount / gone;
  return [
    comparable ? { label: prevName, amount: prev.amount } : { label: prevName, amount: null, note: '일부만 받았어요' },
    { label: total.amount === null ? '평균' : r.months === 1 ? '하루 평균' : '한 달 평균', amount: avg },
  ];
}

/** 화면 자료 카드와 같은 줄 */
function sources(r: ReportResult): NonNullable<ReportDoc['sources']> {
  const at = (label: string, kinds: string[]) => {
    const xs = kinds.map((k) => r.arrivals.find((x) => x.kind === k)).filter((x) => !!x);
    const wait = xs.find((x) => x.expectedOn);
    if (wait) return { state: 'wait' as const, text: `${label} ${Number(r.month.slice(5, 7))}월분은 ${md(wait.expectedOn!)}쯤` };
    const ths = xs.map((x) => x.through).filter((t): t is string => !!t);
    return ths.length ? { state: 'ok' as const, text: `${label} ${md(ths.sort()[0]!)}까지` } : { state: 'none' as const, text: `${label} 아직 못 받았어요` };
  };
  return [
    at('세금계산서', ['sale_invoice', 'purchase_invoice']),
    at('현금영수증', ['cash_receipt_in', 'cash_receipt_out']),
    at('카드 매출', ['card_sales']),
    at('사업용 카드', ['business_card']),
    r.bank.hasAccounts && r.through.bank ? { state: 'ok', text: `통장 ${md(r.through.bank)}까지` } : { state: 'none', text: '통장 아직 못 받았어요' },
  ];
}

export function reportDoc(r: ReportResult, biz: { name: string; bizNo: string | null; bankTo: string | null; hometaxTo: string | null }, nowMs: number): ReportDoc {
  const later = (kind: string) => {
    const a = r.arrivals.find((x) => x.kind === kind);
    return a?.expectedOn ? `${md(a.expectedOn)}쯤 들어와요` : undefined;
  };
  const L = (label: string, l: Amount, more: { optional?: boolean; kind?: string; count?: number } = {}): ReportDocLine | null =>
    more.optional && l.amount === null
      ? null
      : { label, amount: l.amount, partial: l.partial, ...(more.count ? { count: more.count } : {}), ...(l.amount === null && more.kind && later(more.kind) ? { note: later(more.kind)! } : {}) };
  const split = r.partners.sale.split;
  const saleCount = split ? split.ledger.count + split.outside.count : undefined;
  const buyCount = r.partners.purchase.top.reduce((n, x) => n + x.count, 0) + (r.partners.purchase.rest?.count ?? 0);
  const sales = [
    L('세금계산서', r.sales.invoices, { kind: 'sale_invoice', count: saleCount }),
    L('카드 매출', r.sales.cardSales, { kind: 'card_sales' }),
    L('현금영수증', r.sales.cashReceipts, { kind: 'cash_receipt_in' }),
    L('현금 매출', r.sales.cashSales, { optional: true }),
  ].filter((x): x is ReportDocLine => !!x);
  const purchase = [
    L('세금계산서', r.purchase.invoices, { kind: 'purchase_invoice', count: buyCount }),
    L('사업용 카드', r.purchase.card, { kind: 'business_card' }),
    L('현금영수증', r.purchase.cashReceipts, { kind: 'cash_receipt_out' }),
    L('영수증', r.purchase.receipts, { optional: true }),
    L('급여', r.purchase.payroll, { optional: true }),
  ].filter((x): x is ReportDocLine => !!x && !(x.label === '영수증' && x.amount === 0));
  const rank = (k: ReportResult['partners']['sale']) => ({
    rows: k.top.map((x): ReportDocRank => ({ name: x.name ?? '이름 없음', count: x.count, amount: x.amount, share: x.share })),
    rest: k.rest ? { name: `그 밖에 ${k.rest.n}곳`, count: k.rest.count, amount: k.rest.amount, share: k.rest.share } : null,
    total: k.total,
    count: k.top.reduce((s, x) => s + x.count, 0) + (k.rest?.count ?? 0),
  });
  const order = (side: 'in' | 'out') =>
    (side === 'out' ? OUT_ORDER : IN_ORDER).filter((k) => r.bankLines[side][k]?.amount).map((k) => ({ label: (side === 'out' ? OUT_LABEL : IN_LABEL)[k]!, amount: r.bankLines[side][k]!.amount }));
  const days = r.balance.accounts.map((a) => a.day).filter((d): d is string => !!d).sort();
  return {
    bizName: biz.name, bizNo: biz.bizNo, period: periodText(r.month, r.months), made: kstText(nowMs), bankTo: biz.bankTo, hometaxTo: biz.hometaxTo,
    sales, salesTotal: { label: '합계', amount: r.sales.total.amount, partial: r.sales.total.partial },
    purchase, purchaseTotal: { label: '합계', amount: r.purchase.total.amount, partial: r.purchase.total.partial },
    bank: { in: r.bank.in, out: r.bank.out, net: r.bank.net },
    months: r.series.map((m) => (m.month > r.today.slice(0, 7) ? { label: `${Number(m.month.slice(5, 7))}월`, on: m.inWindow, sales: null, purchase: null, in: 0, out: 0 } : { label: `${Number(m.month.slice(5, 7))}월`, on: m.inWindow, sales: m.sales.total.amount, purchase: m.purchase.total.amount, in: m.bank.in, out: m.bank.out })),
    partnersSale: rank(r.partners.sale), partnersPurchase: rank(r.partners.purchase),
    itemsSale: r.items.sale.top.map((x) => ({ name: x.name ?? '품목 없음', count: x.count, amount: x.amount })),
    bankOut: order('out'), bankIn: order('in'),
    balances: r.balance.accounts.map((a) => ({ label: `${a.bank} ${a.last4}`, amount: a.balance })),
    balanceDay: days.length ? md(days.at(-1)!) : null,
    salesRows: summaryRows(r, r.sales.total, r.prev.sales, r.prev.comparable.sales),
    purchaseRows: summaryRows(r, r.purchase.total, r.prev.purchase, r.prev.comparable.purchase),
    salesTrend: trendText(r.months, r.sales.total, r.prev.sales, r.prev.comparable.sales),
    purchaseTrend: trendText(r.months, r.purchase.total, r.prev.purchase, r.prev.comparable.purchase),
    vat: { title: `부가세 ${r.vat.half}기`, deadline: `${md(r.vat.deadline)}${dday(r.today, r.vat.deadline)}`, sale: r.vat.sale, purchase: r.vat.purchase },
    headline: headlineText(r),
    why: whyOf(r),
    receivable: { received: r.receivable.received, waiting: r.receivable.left - r.receivable.late.amount, late: r.receivable.late.amount, lateCount: r.receivable.late.count },
    bankLinked: r.bank.hasAccounts,
    sources: sources(r),
  };
}

/** 다운로드 폴더에 같은 이름이 있으면 (2), (3)을 붙인다. 쓰기는 .part를 거쳐 한 번에 옮긴다 */
export async function saveReportPdf(dir: string, name: string, html: string, render: HtmlToPdf): Promise<string> {
  const bytes = await render(html);
  const stem = name.replace(/\.pdf$/, '');
  for (let i = 1; i < 100; i++) {
    const file = path.join(dir, i === 1 ? name : `${stem} (${i}).pdf`);
    const taken = await fs.access(file).then(() => true, () => false);
    if (taken) continue;
    await writePrivateExport(file, bytes);
    return file;
  }
  throw new Error('save_failed');
}

export async function reportPdfHtml(doc: ReportDoc, staticDir: string): Promise<string> {
  return reportDocHtml(doc, { fonts: await invoiceFonts(staticDir) });
}
