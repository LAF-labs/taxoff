import { analyzeCashFlow, classifyTxns, shiftMonth, type CashFlowMonth, type CashFlowSnapshot, type CfInput, type CfInvoice, type HometaxKind } from './cashflow.ts';
import { settledThrough, SYNC_KINDS } from './hometax-sync.ts';

/**
 * 월 리포트(ADR-068). 저장하지 않고 장부 입력(ledgerInput) 하나에서 다시 계산한다.
 * 달마다 숫자는 돈 흐름(analyzeCashFlow)의 그 달 결과를 그대로 쓴다. 그래서 리포트와 돈 흐름, 폰 사본의 같은 달 숫자는 늘 같다(결정 10).
 * 이익은 만들지 않는다(ADR-045 결정 4). 받지 못한 자료는 null(확인 못 함)이고 0으로 세지 않는다(결정 7).
 */

export const REPORT_WINDOWS = [1, 3, 6, 12] as const;
export type ReportWindow = (typeof REPORT_WINDOWS)[number];

/** 묶음 한 칸. null이면 기간 안에 받은 자료가 하나도 없다. partial이면 기간 일부만 받았다 */
export interface Line {
  amount: number | null;
  partial: boolean;
}

export interface ReportSales {
  invoices: Line;
  cashReceipts: Line;
  cardSales: Line;
  cashSales: Line;
  total: Line;
}

export interface ReportPurchase {
  invoices: Line;
  card: Line;
  cashReceipts: Line;
  receipts: Line;
  payroll: Line;
  total: Line;
}

export interface ReportBank {
  in: number;
  out: number;
  net: number;
  complete: boolean;
  hasAccounts: boolean;
}

export type BankLines = { in: Record<string, { amount: number; count: number }>; out: Record<string, { amount: number; count: number }> };

export interface ReportMonth {
  month: string;
  inWindow: boolean;
  sales: ReportSales;
  purchase: ReportPurchase;
  bank: ReportBank;
  /** 그달 통장 갈래(폰 사본이 기간 합을 스스로 낸다) */
  bankLines: BankLines;
}

export interface RankRow {
  key: string;
  name: string | null;
  count: number;
  amount: number;
  share: number;
  /** 거래처 줄만: 받은(낸) 돈과 남은 돈 */
  settled?: number;
  remaining?: number;
  /** 거래처 줄만: 남은 돈 가운데 기한이 지난 것 */
  late?: number;
  /** 거래처 줄만: month에서 끝나는 12달의 달마다 금액(오래된 달이 앞). 기간과 상관없이 늘 12달이다(폰 거래처 시트, 결정 8) */
  monthly?: number[];
  /** 거래처 줄만: 그 12달에 다 받은(낸) 세금계산서가 작성일에서 받기까지 걸린 날의 금액 가중 평균. 다 받은 것이 없으면 null */
  days?: number | null;
}

export interface Ranking {
  top: RankRow[];
  rest: { n: number; count: number; amount: number; share: number; remaining?: number } | null;
  total: number;
  /** 앱에서 발급한 것과 앱 밖에서 발급한 것(매출 세금계산서 말풍선) */
  split?: { ledger: { count: number; amount: number }; outside: { count: number; amount: number } };
}

export interface ReportReceivable {
  received: number;
  left: number;
  late: { count: number; amount: number };
}

/** 고른 달이 든 부가세 과세기간(1기 1월부터 6월, 2기 7월부터 12월)에서 고른 달까지. 매입은 세금계산서 부가세만 센다 */
export interface ReportVat {
  half: 1 | 2;
  from: string;
  to: string;
  sale: number | null;
  saleCount: number;
  purchase: number | null;
  deadline: string;
}

export type ReportNote =
  | { kind: 'account_gap'; accountId: string; bank: string; last4: string; coverTo: string | null }
  | { kind: 'no_accounts' }
  | { kind: 'hometax_stale'; lastAt: string | null; days: number | null };

/** 홈택스 자료 종류마다 어디까지 받았나(through)와, 고른 달을 아직 하나도 알 수 없으면 그 달이 다 들어오는 날(expectedOn, ADR-072 결정 4) */
export interface ReportArrival {
  kind: HometaxKind;
  through: string | null;
  expectedOn: string | null;
}

export interface ReportResult {
  today: string;
  month: string;
  months: ReportWindow;
  from: string;
  to: string;
  sales: ReportSales;
  purchase: ReportPurchase;
  bank: ReportBank;
  /** 바로 앞 같은 길이 기간의 합계(지난달보다) */
  prev: { sales: Line; purchase: Line };
  receivable: ReportReceivable;
  vat: ReportVat;
  series: ReportMonth[];
  partners: { sale: Ranking; purchase: Ranking };
  items: { sale: Ranking; purchase: Ranking };
  bankLines: BankLines;
  balance: CashFlowSnapshot['balance'];
  /** 자료가 어디까지인지. 계좌는 가장 늦게 받은 계좌 기준(가장 이른 날), 홈택스는 마지막으로 받은 날 */
  through: { bank: string | null; hometax: string | null };
  notes: ReportNote[];
  arrivals: ReportArrival[];
}

export interface ReportInput extends Omit<CfInput, 'month'> {
  /** 마지막으로 홈택스 자료를 받은 시각(성공한 회차). 받은 적이 없으면 null */
  hometaxLastAt: string | null;
}

/** 자료가 묵었다고 알리는 날수. 자동 받기가 돌면 하루를 넘지 않는다(결정 6) */
export const HOMETAX_STALE_DAYS = 3;
const TOP = 10;

const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const ratio = (n: number, all: number) => (all > 0 ? Math.round((n / all) * 1000) / 1000 : 0);

/** 품목명 묶기 열쇠: 앞뒤 공백, 겹친 공백, "외 n건" 꼬리를 뗀다. 모델로 묶지 않는다(ADR-045 결정 2) */
export function itemKey(name: string | null | undefined): string | null {
  if (typeof name !== 'string') return null;
  const k = name.replace(/\s+/g, ' ').trim().replace(/\s*외\s*\d+\s*(건|개|종)?$/, '').trim();
  return k || null;
}

const line = (vals: Array<number | null>): Line => {
  const known = vals.filter((v): v is number => v !== null);
  return { amount: known.length ? known.reduce((a, b) => a + b, 0) : null, partial: known.length > 0 && known.length < vals.length };
};
const optional = (vals: Array<number | null>): Line => {
  // 현금매출과 급여는 사장님이 넣은 달만 있다. 넣지 않은 달은 0이 아니라 없음이지만, 묶음 합계를 "확인 못 함"으로 만들지 않는다
  const known = vals.filter((v): v is number => v !== null);
  return { amount: known.length ? known.reduce((a, b) => a + b, 0) : null, partial: false };
};
/**
 * 세금계산서 칸. 홈택스 목록을 덮어 받은 달은 장부 합 그대로, 못 받은 달은 앱에서 발급한 것만 알아서 일부(있으면)나 모름(없으면)이다.
 * 홈택스 받기가 한 번도 끝나지 않았는데 앱 발급분만으로 매출 전체처럼 보이던 것(2026-11-26 실기기: 6건 586원)을 막는다(결정 7).
 */
const invoiceLine = (ms: Array<{ v: number; known: boolean }>): Line => {
  const l = line(ms.map((m) => (m.known || m.v !== 0 ? m.v : null)));
  return { amount: l.amount, partial: l.partial || (l.amount !== null && ms.some((m) => !m.known)) };
};
const totalOf = (lines: Line[], strict: Line[]): Line => {
  const amount = lines.reduce((a, l) => a + (l.amount ?? 0), 0);
  return { amount, partial: strict.some((l) => l.amount === null || l.partial) };
};

function monthLines(ms: CashFlowMonth[]): { sales: ReportSales; purchase: ReportPurchase; bank: ReportBank } {
  const a = ms.map((m) => m.accrual);
  const sInv = invoiceLine(a.map((x) => ({ v: x.salesInvoices, known: x.invoicesKnown.sale })));
  const sCr = line(a.map((x) => x.cashReceiptsIn));
  const sCard = line(a.map((x) => x.cardSales));
  const sCash = optional(a.map((x) => x.cashSales));
  const pInv = invoiceLine(a.map((x) => ({ v: x.purchaseInvoices, known: x.invoicesKnown.purchase })));
  const pCard = line(a.map((x) => x.card));
  const pCr = line(a.map((x) => x.cashReceiptsOut));
  const pRec = line(a.map((x) => x.receipts));
  const pPay = optional(a.map((x) => x.payroll));
  const cin = ms.reduce((s, m) => s + m.cash.in.total, 0);
  const cout = ms.reduce((s, m) => s + m.cash.out.total, 0);
  return {
    sales: { invoices: sInv, cashReceipts: sCr, cardSales: sCard, cashSales: sCash, total: totalOf([sInv, sCr, sCard, sCash], [sInv, sCr, sCard]) },
    purchase: { invoices: pInv, card: pCard, cashReceipts: pCr, receipts: pRec, payroll: pPay, total: totalOf([pInv, pCard, pCr, pRec, pPay], [pInv, pCard, pCr]) },
    bank: { in: cin, out: cout, net: cin - cout, complete: ms.every((m) => m.complete), hasAccounts: ms.some((m) => m.hasAccounts) },
  };
}

function linesOf(ms: CashFlowMonth[]): BankLines {
  const out: BankLines = { in: {}, out: {} };
  for (const m of ms)
    for (const [side, money] of [['in', m.cash.in], ['out', m.cash.out]] as const)
      for (const [k, v] of Object.entries(money.by)) {
        const cur = out[side][k] ?? { amount: 0, count: 0 };
        cur.amount += v;
        cur.count += money.n[k] ?? 0;
        out[side][k] = cur;
      }
  return out;
}

function rank(rows: Array<{ key: string; name: string | null; amount: number; settled?: number; remaining?: number; late?: number }>, withMoney: boolean, topN: number): Ranking {
  const by = new Map<string, RankRow>();
  for (const r of rows) {
    const cur = by.get(r.key) ?? { key: r.key, name: r.name, count: 0, amount: 0, share: 0, ...(withMoney ? { settled: 0, remaining: 0, late: 0 } : {}) };
    cur.count++;
    cur.amount += r.amount;
    if (withMoney) {
      cur.settled! += r.settled ?? 0;
      cur.remaining! += r.remaining ?? 0;
      cur.late! += r.late ?? 0;
    }
    if (r.name) cur.name = r.name;
    by.set(r.key, cur);
  }
  const all = [...by.values()].filter((r) => r.amount !== 0).sort((a, b) => b.amount - a.amount || (a.key < b.key ? -1 : 1));
  const total = all.reduce((s, r) => s + r.amount, 0);
  for (const r of all) r.share = ratio(r.amount, total);
  const top = all.slice(0, topN);
  const rest = all.slice(topN);
  return {
    top, total,
    rest: rest.length
      ? { n: rest.length, count: rest.reduce((s, r) => s + r.count, 0), amount: rest.reduce((s, r) => s + r.amount, 0), share: ratio(rest.reduce((s, r) => s + r.amount, 0), total), ...(withMoney ? { remaining: rest.reduce((s, r) => s + (r.remaining ?? 0), 0) } : {}) }
      : null,
  };
}

/** 신고 기한(25일)이 주말이면 다음 월요일. 공휴일은 따지지 않는다 */
function vatDeadline(half: 1 | 2, year: number): string {
  const d = new Date(Date.UTC(half === 1 ? year : year + 1, half === 1 ? 6 : 0, 25));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(27);
  if (dow === 0) d.setUTCDate(26);
  return d.toISOString().slice(0, 10);
}

function vatOf(input: ReportInput, month: string, to: string, known: (m: string) => boolean): ReportVat {
  const year = Number(month.slice(0, 4));
  const half = Number(month.slice(5, 7)) <= 6 ? 1 : 2;
  const first = `${year}-${half === 1 ? '01' : '07'}`;
  const from = `${first}-01`;
  const live = input.invoices.filter((v) => v.state !== 'excluded' && v.writtenOn >= from && v.writtenOn <= to);
  const taxSum = (xs: CfInvoice[]) => (xs.some((v) => typeof v.tax !== 'number') ? null : xs.reduce((s, v) => s + (v.tax as number), 0));
  const sales = live.filter((v) => v.kind === 'sale');
  const months = Array.from({ length: Number(month.slice(5, 7)) - Number(first.slice(5, 7)) + 1 }, (_, i) => shiftMonth(first, i));
  return {
    half, from, to,
    sale: taxSum(sales),
    saleCount: sales.length,
    purchase: months.every(known) ? taxSum(live.filter((v) => v.kind === 'purchase')) : null,
    deadline: vatDeadline(half, year),
  };
}

const bankThrough = (accounts: CashFlowSnapshot['balance']['accounts'], to: string): string | null => {
  if (!accounts.length || accounts.some((x) => !x.day)) return null;
  const first = accounts.map((x) => x.day!).sort()[0]!;
  return first < to ? first : to;
};

const addDay = (iso: string, n: number) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function arrivalsOf(input: ReportInput, month: string): ReportArrival[] {
  const start = `${month}-01`;
  const end = lastDay(month);
  return SYNC_KINDS.map((kind) => {
    const ranges = kind === 'business_card' ? input.cardRanges : (input.hometax ?? []).filter((h) => h.kind === kind);
    const through = ranges.map((r) => r.to).sort().at(-1) ?? null;
    let expectedOn: string | null = null;
    if (settledThrough(kind, input.today) < start) {
      for (let d = addDay(input.today, 1), i = 0; i < 200 && !expectedOn; d = addDay(d, 1), i++) if (settledThrough(kind, d) >= end) expectedOn = d;
    }
    return { kind, through, expectedOn };
  });
}

/** top: 순위마다 몇 줄까지 따로 둘지. 나머지는 rest 한 줄로 묶는다. 전체 목록 모달은 Infinity로 부른다 */
export function analyzeReport(input: ReportInput, month: string, months: ReportWindow, top = TOP): ReportResult {
  const today = input.today;
  const span = Math.max(6, months);
  const seriesMonths = Array.from({ length: span }, (_, i) => shiftMonth(month, i - span + 1));
  const windowMonths = new Set(seriesMonths.slice(span - months));
  const results = new Map(seriesMonths.map((m) => [m, analyzeCashFlow({ ...input, month: m })] as const));
  const series: ReportMonth[] = seriesMonths.map((m) => ({ month: m, inWindow: windowMonths.has(m), ...monthLines([results.get(m)!.month]), bankLines: linesOf([results.get(m)!.month]) }));
  const inWin = seriesMonths.filter((m) => windowMonths.has(m)).map((m) => results.get(m)!.month);
  const totals = monthLines(inWin);

  const from = `${[...windowMonths][0]}-01`;
  const end = lastDay(month);
  const to = end < today ? end : today;
  const inRange = (d: string) => d >= from && d <= to;

  const live = input.invoices.filter((v) => v.state !== 'excluded' && inRange(v.writtenOn));
  const owed = (v: CfInvoice) => (v.total < 0 ? v.total : v.remaining);
  const cpRows = (kind: CfInvoice['kind']) =>
    live.filter((v) => v.kind === kind).map((v) => ({ key: v.counterpartyKey, name: v.cpName, amount: v.total, settled: v.total - owed(v), remaining: owed(v), late: v.overdue ? v.remaining : 0 }));
  const itemRows = (kind: CfInvoice['kind']) =>
    live.filter((v) => v.kind === kind).map((v) => {
      const k = itemKey(v.item);
      return { key: k ?? '', name: k, amount: v.total };
    });
  const saleRank = rank(cpRows('sale'), true, top);
  const purchaseRank = rank(cpRows('purchase'), true, top);
  // 거래처 줄의 12달 달마다 금액과 받기까지 평균 날수. 기간(1, 3, 6개월)과 상관없이 같은 12달로 센다
  const yearMonths = Array.from({ length: 12 }, (_, i) => shiftMonth(month, i - 11));
  const year = new Map<string, CfInvoice[]>();
  for (const v of input.invoices) {
    if (v.state === 'excluded' || v.writtenOn < `${yearMonths[0]}-01` || v.writtenOn > to) continue;
    const k = `${v.kind} ${v.counterpartyKey}`;
    const xs = year.get(k);
    if (xs) xs.push(v);
    else year.set(k, [v]);
  }
  for (const [kind, r] of [['sale', saleRank], ['purchase', purchaseRank]] as const) {
    for (const row of r.top) {
      const mine = year.get(`${kind} ${row.key}`) ?? [];
      row.monthly = yearMonths.map((m) => mine.filter((v) => v.writtenOn.startsWith(m)).reduce((s, v) => s + v.total, 0));
      const done = mine.filter((v) => v.state === 'settled' && v.settledOn);
      const w = done.reduce((s, v) => s + v.total, 0);
      row.days = w > 0 ? Math.round(done.reduce((s, v) => s + v.total * daysBetween(v.writtenOn, v.settledOn!), 0) / w) : null;
    }
  }
  const sales = live.filter((v) => v.kind === 'sale');
  const ledgerSales = sales.filter((v) => v.fromLedger);
  saleRank.split = {
    ledger: { count: ledgerSales.length, amount: ledgerSales.reduce((s, v) => s + v.total, 0) },
    outside: { count: sales.length - ledgerSales.length, amount: sales.reduce((s, v) => s + v.total, 0) - ledgerSales.reduce((s, v) => s + v.total, 0) },
  };

  const bankLines = linesOf(inWin);
  const prevMonths = Array.from({ length: months }, (_, i) => shiftMonth(month, i - 2 * months + 1));
  const prevTotals = monthLines(prevMonths.map((m) => results.get(m)?.month ?? analyzeCashFlow({ ...input, month: m }).month));
  const lateSales = sales.filter((v) => v.overdue);
  const receivable: ReportReceivable = {
    received: sales.reduce((s, v) => s + v.total - owed(v), 0),
    left: Math.max(0, sales.reduce((s, v) => s + owed(v), 0)),
    late: { count: lateSales.length, amount: lateSales.reduce((s, v) => s + v.remaining, 0) },
  };
  const purchaseKnown = (m: string) => (results.get(m)?.month ?? analyzeCashFlow({ ...input, month: m }).month).accrual.invoicesKnown.purchase;

  const notes: ReportNote[] = [];
  const last = results.get(month)!;
  if (!last.month.hasAccounts) notes.push({ kind: 'no_accounts' });
  const gaps = new Map<string, ReportNote>();
  for (const m of inWin) for (const g of m.missing) gaps.set(g.accountId, { kind: 'account_gap', accountId: g.accountId, bank: g.bank, last4: g.last4, coverTo: g.coverTo });
  notes.push(...gaps.values());
  const days = input.hometaxLastAt ? daysBetween(input.hometaxLastAt.slice(0, 10), today) : null;
  if (days === null || days >= HOMETAX_STALE_DAYS) notes.push({ kind: 'hometax_stale', lastAt: input.hometaxLastAt, days });

  return {
    today, month, months, from, to,
    ...totals,
    prev: { sales: prevTotals.sales.total, purchase: prevTotals.purchase.total },
    receivable,
    vat: vatOf(input, month, to, purchaseKnown),
    series,
    partners: { sale: saleRank, purchase: purchaseRank },
    items: { sale: rank(itemRows('sale'), false, top), purchase: rank(itemRows('purchase'), false, top) },
    bankLines,
    balance: last.snapshot.balance,
    through: { bank: bankThrough(last.snapshot.balance.accounts, to), hometax: input.hometaxLastAt ? input.hometaxLastAt.slice(0, 10) : null },
    notes,
    arrivals: arrivalsOf(input, month),
  };
}

/** 기간 끝 달과 오늘로 고를 수 있는가(미래 달 안 됨) */
export function reportMonthOk(month: unknown, today: string): month is string {
  return typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= today.slice(0, 7) && month >= shiftMonth(today.slice(0, 7), -120);
}

export interface ReportLineRow {
  id: string;
  day: string;
  label: string;
  accountId: string;
  amount: number;
  category: string;
}

/** 리포트의 통장 갈래 하나를 이룬 줄(PC 목록 모달). 통장 표시 원문이 들어 있어 폰 사본에는 싣지 않는다(결정 8) */
export function reportLines(input: ReportInput, month: string, months: ReportWindow, side: 'in' | 'out', category: string): ReportLineRow[] {
  const end = lastDay(month);
  const from = `${shiftMonth(month, 1 - months)}-01`;
  const to = end < input.today ? end : input.today;
  return classifyTxns(input, from, to)
    .filter((x) => x.txn.direction === side && x.category === category)
    .map((x) => ({ id: x.txn.id, day: x.txn.day, label: x.txn.label, accountId: x.txn.accountId, amount: x.amount, category: x.category }))
    .sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.amount - a.amount));
}
