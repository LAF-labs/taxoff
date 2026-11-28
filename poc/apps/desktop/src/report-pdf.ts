import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReportResult } from '@sax/engine';
import { reportDocHtml, type ReportDoc, type ReportDocLine, type ReportDocRank } from '@sax/remote';
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
const ym = (m: string) => `${m.slice(0, 4)}년 ${Number(m.slice(5, 7))}월`;
const shiftMonth = (month: string, d: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};

/** 기간 글: "2026년 11월", "2026년 9월부터 11월", 해가 바뀌면 "2025년 12월부터 2026년 11월" */
export function periodText(month: string, months: number): string {
  if (months === 1) return ym(month);
  const first = shiftMonth(month, 1 - months);
  return first.slice(0, 4) === month.slice(0, 4) ? `${ym(first)}부터 ${Number(month.slice(5, 7))}월` : `${ym(first)}부터 ${ym(month)}`;
}

export function reportFileName(month: string, months: number): string {
  return `택스오프 리포트 ${periodText(month, months)}.pdf`;
}

const kstText = (ms: number) => {
  const d = new Date(ms + 9 * 3_600_000);
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일 ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
};

type Amount = { amount: number | null; partial: boolean };

/** 화면(shell-report.js trendText)과 같은 비교 글 */
export function trendText(months: number, cur: Amount, prev: Amount): string | null {
  if (cur.amount === null) return null;
  if (prev.amount === null || !prev.amount || (prev.partial && !cur.partial)) return `비교할 ${months === 12 ? '작년' : months === 1 ? '지난달' : '앞 기간'} 자료가 없어요`;
  const label = months === 1 ? '지난달보다' : months === 12 ? '지난해보다' : `앞 ${months}개월보다`;
  const p = Math.round(((cur.amount - prev.amount) / prev.amount) * 100);
  return p === 0 ? `${label} 같아요` : `${label} ${Math.abs(p)}% ${p > 0 ? '늘었어요' : '줄었어요'}`;
}

/** 화면 자료 카드와 같은 줄 */
function sources(r: ReportResult): NonNullable<ReportDoc['sources']> {
  const at = (label: string, kinds: string[]) => {
    const xs = kinds.map((k) => r.arrivals.find((x) => x.kind === k)).filter((x) => !!x);
    const wait = xs.find((x) => x.expectedOn);
    if (wait) return { state: 'wait' as const, text: `${label} ${Number(r.month.slice(5, 7))}월분은 ${md(wait.expectedOn!)}쯤` };
    const ths = xs.map((x) => x.through);
    return !ths.length || ths.some((t) => !t) ? { state: 'none' as const, text: `${label} 아직 못 받았어요` } : { state: 'ok' as const, text: `${label} ${md((ths as string[]).sort()[0]!)}까지` };
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
    months: r.series.map((m) => ({ label: `${Number(m.month.slice(5, 7))}월`, on: m.inWindow, sales: m.sales.total.amount, purchase: m.purchase.total.amount, in: m.bank.in, out: m.bank.out })),
    partnersSale: rank(r.partners.sale), partnersPurchase: rank(r.partners.purchase),
    itemsSale: r.items.sale.top.map((x) => ({ name: x.name ?? '품목 없음', count: x.count, amount: x.amount })),
    bankOut: order('out'), bankIn: order('in'),
    balances: r.balance.accounts.map((a) => ({ label: `${a.bank} ${a.last4}`, amount: a.balance })),
    balanceDay: days.length ? md(days.at(-1)!) : null,
    salesTrend: trendText(r.months, r.sales.total, r.prev.sales),
    purchaseTrend: trendText(r.months, r.purchase.total, r.prev.purchase),
    vat: { title: `부가세 ${r.vat.half}기`, deadline: `${md(r.vat.deadline)}까지`, sale: r.vat.saleAll, purchase: r.vat.purchaseAll },
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
