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

export function reportDoc(r: ReportResult, biz: { name: string; bizNo: string | null; bankTo: string | null; hometaxTo: string | null }, nowMs: number): ReportDoc {
  const L = (label: string, l: { amount: number | null; partial: boolean }, optional = false): ReportDocLine | null => (optional && l.amount === null ? null : { label, amount: l.amount, partial: l.partial });
  const sales = [L('세금계산서', r.sales.invoices), L('현금영수증', r.sales.cashReceipts), L('카드 매출', r.sales.cardSales), L('현금 매출', r.sales.cashSales, true)].filter((x): x is ReportDocLine => !!x);
  const purchase = [L('세금계산서', r.purchase.invoices), L('사업용 카드', r.purchase.card), L('현금영수증', r.purchase.cashReceipts), L('영수증', r.purchase.receipts, true), L('급여', r.purchase.payroll, true)]
    .filter((x): x is ReportDocLine => !!x && !(x.label === '영수증' && x.amount === 0));
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
