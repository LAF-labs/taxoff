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
  /** 작년 같은 달의 매출, 매입 합계(작년과 비교 점선) */
  lastYear: { sales: Line; purchase: Line };
}

/** 앞 기간보다 매출이 많이 바뀐 거래처와 품목(왜 늘었을까/줄었을까). 금액 차이가 큰 것부터 */
export interface ReportWhy {
  kind: 'partner' | 'item';
  name: string | null;
  delta: number;
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
  /** false면 법인의 예정신고 기간(1~3월, 7~9월) */
  final: boolean;
  from: string;
  to: string;
  sale: number | null;
  saleCount: number;
  purchase: number | null;
  deadline: string;
  /** 카드, 현금영수증, 현금 매출까지 더한 매출 세액과, 공제받는 카드, 현금영수증까지 더한 매입 세액(vatTotals) */
  saleAll: number | null;
  purchaseAll: number | null;
  /** 낼 부가세 어림(vatNet). 음수면 돌려받는다. 모르면 null */
  due: number | null;
  /** 면세사업자(사업자번호 90~99)는 부가세 신고가 없다. PC, 폰, PDF가 부가세 칸을 그리지 않는다 */
  exempt: boolean;
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
  /** 바로 앞 같은 길이 기간의 합계(지난달보다). comparable이 false면 앞 기간에 받은 자료가 지금 기간보다 적어서 늘고 줄었다고 말하지 않는다 */
  prev: { sales: Line; purchase: Line; comparable: { sales: boolean; purchase: boolean } };
  receivable: ReportReceivable;
  /** 앞 기간과 비교할 수 없으면 빈 줄 */
  why: ReportWhy[];
  vat: ReportVat;
  series: ReportMonth[];
  partners: { sale: Ranking; purchase: Ranking };
  items: { sale: Ranking; purchase: Ranking };
  bankLines: BankLines;
  balance: CashFlowSnapshot['balance'];
  /** 자료가 어디까지인지. 계좌는 가장 늦게 받은 계좌 기준(가장 이른 날), 홈택스는 마지막으로 받은 날 */
  through: { bank: string | null; hometax: string | null };
  /** 마지막으로 홈택스 자료를 받은 시각(UTC ISO). 화면 머리의 "업데이트" 시각 */
  hometaxAt: string | null;
  notes: ReportNote[];
  arrivals: ReportArrival[];
}

export interface ReportInput extends Omit<CfInput, 'month'> {
  /** 마지막으로 홈택스 자료를 받은 시각(성공한 회차). 받은 적이 없으면 null */
  hometaxLastAt: string | null;
  /** 법인 사업자(법인등록번호가 있거나 사업자번호가 법인 코드). 부가세 과세기간이 석 달이다 */
  corporate?: boolean;
  /** 사업자번호가 개인 면세 코드(90~99). 부가세 신고가 없다 */
  exempt?: boolean;
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

function monthLines(ms: CashFlowMonth[], exempt: boolean): { sales: ReportSales; purchase: ReportPurchase; bank: ReportBank } {
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
    // 면세사업자의 전자계산서는 아직 홈택스에서 받지 않는다. 받기 전에는 매출 합계를 다 안 것으로 두지 않는다
    sales: { invoices: sInv, cashReceipts: sCr, cardSales: sCard, cashSales: sCash, total: totalOf([sInv, sCr, sCard, sCash], [sInv, sCr, sCard, ...(exempt ? [{ amount: null, partial: true }] : [])]) },
    purchase: { invoices: pInv, card: pCard, cashReceipts: pCr, receipts: pRec, payroll: pPay, total: totalOf([pInv, pCard, pCr, pRec, pPay], [pInv, pCard, pCr]) },
    bank: { in: cin, out: cout, net: cin - cout, complete: ms.every((m) => m.complete), hasAccounts: ms.some((m) => m.hasAccounts) },
  };
}

/** 자료 종류마다 받은 달 수. 매출은 세금계산서, 현금영수증, 카드 매출, 매입은 세금계산서, 사업용 카드, 현금영수증 */
function coverage(ms: CashFlowMonth[]): { sales: number[]; purchase: number[] } {
  const n = (f: (a: CashFlowMonth['accrual']) => boolean) => ms.filter((m) => f(m.accrual)).length;
  return {
    sales: [n((a) => a.invoicesKnown.sale), n((a) => a.cashReceiptsIn !== null), n((a) => a.cardSales !== null)],
    purchase: [n((a) => a.invoicesKnown.purchase), n((a) => a.card !== null), n((a) => a.cashReceiptsOut !== null)],
  };
}
const covers = (prev: number[], cur: number[]) => cur.every((c, i) => prev[i]! >= c);

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

/** 과세기간 끝 달의 다음 달 25일. 주말이면 다음 월요일. 공휴일은 따지지 않는다 */
function filingDeadline(lastMonth: string): string {
  const [y, m] = lastMonth.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m, 25));
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(27);
  if (dow === 0) d.setUTCDate(26);
  return d.toISOString().slice(0, 10);
}

const monthsFrom = (first: string, last: string) => Array.from({ length: (Number(last.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(last.slice(5, 7)) - Number(first.slice(5, 7)) + 1 }, (_, i) => shiftMonth(first, i));

/** from부터 to까지 세금계산서 세액. 매입은 그 달들 홈택스 매입 목록을 다 받았을 때만 센다 */
function invoiceTax(input: ReportInput, from: string, to: string, known: (m: string) => boolean) {
  // 부가세는 홈택스에 낸 계산서 그대로 센다. 받을 돈에서 뺀 건(excluded)도 들어간다(F8)
  const live = input.invoices.filter((v) => v.writtenOn >= from && v.writtenOn <= to);
  const taxSum = (xs: CfInvoice[]) => (xs.some((v) => typeof v.tax !== 'number') ? null : xs.reduce((s, v) => s + (v.tax as number), 0));
  const sales = live.filter((v) => v.kind === 'sale');
  return { sale: taxSum(sales), saleCount: sales.length, purchase: monthsFrom(from.slice(0, 7), to.slice(0, 7)).every(known) ? taxSum(live.filter((v) => v.kind === 'purchase')) : null };
}

/** 그달이 든 부가세 과세기간. 법인은 석 달마다 예정·확정 신고, 개인 일반과세자는 여섯 달마다 확정 신고다(부가가치세법 48조, 49조) */
function vatPeriod(month: string, corporate: boolean) {
  const span = corporate ? 3 : 6;
  const first = Math.floor((Number(month.slice(5, 7)) - 1) / span) * span + 1;
  const fromM = `${month.slice(0, 4)}-${String(first).padStart(2, '0')}`;
  const lastM = shiftMonth(fromM, span - 1);
  return { fromM, lastM, deadline: filingDeadline(lastM), half: (first <= 6 ? 1 : 2) as 1 | 2, final: Number(lastM.slice(5, 7)) % 6 === 0 };
}

function vatOf(input: ReportInput, month: string, to: string, known: (m: string) => boolean): ReportVat {
  const p = vatPeriod(month, !!input.corporate);
  const from = `${p.fromM}-01`;
  const end = [to, lastDay(p.lastM)].sort()[0]!;
  return { half: p.half, final: p.final, from, to: end, ...invoiceTax(input, from, end, known), deadline: p.deadline, ...vatTotals(vatEstimate(input, p, end)), exempt: !!input.exempt };
}

/**
 * 다음에 낼 부가세 신고(대화 vat_summary). 법인은 석 달마다 예정·확정 신고, 개인 일반과세자는 여섯 달마다 확정 신고다(부가가치세법 48조, 49조).
 * 지난 기간의 신고 기한이 아직이면 그 기간, 지났으면 지금 기간이다. 값은 그 기간 오늘까지 받은 자료로 낸 어림이다.
 * sale·purchase는 세금계산서 세액이고, null이면 그 기간 홈택스 매출이나 매입 목록을 다 받지 못했다.
 * card·cashReceipts는 홈택스가 공제로 둔 사업용 카드, 현금영수증 매입의 부가세이고, 기간 첫날부터 …Through까지 다 받은 것만이다.
 * 첫 달부터 받지 못했거나 공제여부를 모르는 줄이 있으면 null이다.
 * cardSales·cashReceiptsIn은 카드 매출과 현금영수증 매출의 부가세다. 카드 매출은 합계만 오니 부가세가 든 금액의 11분의 1로 어림한다.
 * cashSales는 사장님이 넣은 현금 매출의 11분의 1이고, 넣은 것이 없으면 null이다.
 * salesComplete: 세금계산서, 카드 매출, 현금영수증 매출을 기간 끝(through)까지 다 받았다. 아니면 돌려받는다고 말할 수 없다.
 * prepaid: 개인이 그 기간 가운데 달(4월, 10월)에 예정고지로 냈을 수 있는 세액이 빠졌다.
 */
export interface VatDue {
  half: 1 | 2;
  final: boolean;
  corporate: boolean;
  from: string;
  to: string;
  through: string;
  deadline: string;
  sale: number | null;
  purchase: number | null;
  card: number | null;
  cardThrough: string | null;
  cashReceipts: number | null;
  cashReceiptsThrough: string | null;
  cardSales: number | null;
  cardSalesThrough: string | null;
  cashReceiptsIn: number | null;
  cashReceiptsInThrough: string | null;
  cashSales: number | null;
  salesComplete: boolean;
  prepaid: boolean;
  exempt: boolean;
}

export function vatDue(input: ReportInput): VatDue {
  const today = input.today;
  const cur = vatPeriod(today.slice(0, 7), !!input.corporate);
  const prev = vatPeriod(shiftMonth(cur.fromM, -1), !!input.corporate);
  const p = today <= prev.deadline ? prev : cur;
  const to = lastDay(p.lastM);
  return vatEstimate(input, p, to < today ? to : today);
}

/** 낼 부가세 어림. 매출 자료를 기간 끝까지 다 받지 못했으면 돌려받는다고 하지 않는다(빠진 매출 세액이 더 클 수 있다) */
export function vatNet(v: VatDue): number | null {
  return vatTotals(v).due;
}

function vatTotals(v: VatDue): { saleAll: number | null; purchaseAll: number | null; due: number | null } {
  const saleAll = v.sale === null ? null : [v.cardSales, v.cashReceiptsIn, v.cashSales].reduce<number>((t, x) => t + (x ?? 0), v.sale);
  const purchaseAll = v.purchase === null ? null : v.purchase + (v.card ?? 0) + (v.cashReceipts ?? 0);
  const net = saleAll === null || purchaseAll === null ? null : saleAll - purchaseAll;
  return { saleAll, purchaseAll, due: net !== null && net < 0 && !v.salesComplete ? null : net };
}

function vatEstimate(input: ReportInput, p: ReturnType<typeof vatPeriod>, through: string): VatDue {
  const corporate = !!input.corporate;
  const from = `${p.fromM}-01`;
  const to = lastDay(p.lastM);
  const byMonth = new Map(monthsFrom(p.fromM, through.slice(0, 7)).map((m) => [m, analyzeCashFlow({ ...input, month: m }).month.accrual] as const));
  const accrual = [...byMonth.values()];
  const tax = invoiceTax(input, from, through, (m) => byMonth.get(m)!.invoicesKnown.purchase);
  const sale = accrual.every((a) => a.invoicesKnown.sale) ? tax.sale : null;
  const purchase = tax.purchase;
  const within = (d: string) => d >= from && d <= through;
  // 카드 자료는 다음 달 15일쯤 다 들어온다. 앞에서부터 다 받은 달까지만 세고 어디까지인지 같이 낸다
  const knownUpTo = (known: (a: (typeof accrual)[number]) => boolean): string | null => {
    const months = [...byMonth].filter(([, a]) => known(a)).map(([m]) => m);
    const n = months.findIndex((m, i) => m !== shiftMonth(p.fromM, i));
    const upTo = n < 0 ? months.length : n;
    return upTo ? [lastDay(months[upTo - 1]!), through].sort()[0]! : null;
  };
  const taxOf = (end: string | null, xs: Array<{ day: string; vat?: number | null; deductible?: boolean | null }>, all = false) => {
    if (!end) return { tax: null, through: null };
    const rows = xs.filter((x) => x.day >= from && x.day <= end);
    if (rows.some((x) => x.vat == null || (!all && x.deductible == null))) return { tax: null, through: null };
    return { tax: rows.reduce((t, x) => t + (all || x.deductible ? x.vat! : 0), 0), through: end };
  };
  const receipts = (side: 'in' | 'out') => (input.cashReceipts ?? []).filter((c) => c.side === side).map((c) => ({ ...c, vat: c.tax }));
  const card = taxOf(knownUpTo((a) => a.card !== null), input.cardTxns);
  const cashReceipts = taxOf(knownUpTo((a) => a.cashReceiptsOut !== null), receipts('out'));
  const cashReceiptsIn = taxOf(knownUpTo((a) => a.cashReceiptsIn !== null), receipts('in'), true);
  const cardSalesEnd = knownUpTo((a) => a.cardSales !== null);
  const cardSales = taxOf(cardSalesEnd, (input.cardSales ?? []).map((c) => ({ day: `${c.month}-01`, vat: Math.round(c.amount / 11) })), true);
  const cash = input.cashSales.filter((c) => within(c.day));
  const middle = `${p.fromM.slice(0, 4)}-${p.half === 1 ? '04' : '10'}-25`;
  return {
    half: p.half, final: p.final, corporate, from, to, through, deadline: p.deadline, sale, purchase,
    card: card.tax, cardThrough: card.through, cashReceipts: cashReceipts.tax, cashReceiptsThrough: cashReceipts.through,
    cardSales: cardSales.tax, cardSalesThrough: cardSales.through, cashReceiptsIn: cashReceiptsIn.tax, cashReceiptsInThrough: cashReceiptsIn.through,
    cashSales: cash.length ? Math.round(cash.reduce((t, c) => t + c.amount, 0) / 11) : null,
    salesComplete: sale !== null && cardSales.through === through && cashReceiptsIn.through === through,
    prepaid: !corporate && through > middle,
    exempt: !!input.exempt,
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
  const lastYearOf = (m: string) => {
    const t = monthLines([analyzeCashFlow({ ...input, month: shiftMonth(m, -12) }).month], !!input.exempt);
    // 그해 자료를 하나도 받지 않은 달은 0이 아니라 모름이다
    const none = (ls: Line[]) => ls.every((l) => l.amount === null);
    return {
      sales: none([t.sales.invoices, t.sales.cashReceipts, t.sales.cardSales]) ? { amount: null, partial: false } : t.sales.total,
      purchase: none([t.purchase.invoices, t.purchase.card, t.purchase.cashReceipts]) ? { amount: null, partial: false } : t.purchase.total,
    };
  };
  const series: ReportMonth[] = seriesMonths.map((m) => ({ month: m, inWindow: windowMonths.has(m), ...monthLines([results.get(m)!.month], !!input.exempt), bankLines: linesOf([results.get(m)!.month]), lastYear: lastYearOf(m) }));
  // 기간 합계는 오늘이 든 달까지(이번 분기의 남은 달은 아직 오지 않은 달이라 일부라고 하지 않는다)
  const inWin = seriesMonths.filter((m) => windowMonths.has(m) && m <= today.slice(0, 7)).map((m) => results.get(m)!.month);
  const totals = monthLines(inWin, !!input.exempt);

  const from = `${[...windowMonths][0]}-01`;
  const end = lastDay(month);
  const to = end < today ? end : today;
  const inRange = (d: string) => d >= from && d <= to;

  // 거래처, 품목, 매출 나눔은 낸 계산서 전부(filed)로, 받을 돈은 받을 돈에서 빼지 않은 것(live)으로 센다(F8)
  const filed = input.invoices.filter((v) => inRange(v.writtenOn));
  const live = filed.filter((v) => v.state !== 'excluded');
  // 음수분 중 당초분에 붙인 만큼은 당초분 남은 돈에서 이미 빠졌다. 음수 줄의 remaining은 붙이지 못한 만큼이라 그만큼만 거래처 남은 돈에서 뺀다
  const owed = (v: CfInvoice) => (v.state === 'excluded' ? 0 : v.remaining);
  // 붙인 음수분은 받은 돈이 아니다. 당초분은 붙인 만큼, 음수 줄은 붙인 만큼(음수)을 받은 돈에서 뺀다(둘을 더하면 0)
  const credit = (v: CfInvoice) => (v.total < 0 ? -(v.credited ?? 0) : (v.credited ?? 0));
  // 종이 세금계산서는 받을 돈 건이 아니어서 받았는지 모른다: 받은 돈에 넣지 않는다
  const cpRows = (kind: CfInvoice['kind']) =>
    filed.filter((v) => v.kind === kind).map((v) => ({ key: v.counterpartyKey, name: v.cpName, amount: v.total, settled: v.paper ? 0 : v.total - v.remaining - credit(v), remaining: owed(v), late: v.overdue && v.total > 0 ? owed(v) : 0 }));
  const itemRows = (kind: CfInvoice['kind']) =>
    filed.filter((v) => v.kind === kind).map((v) => {
      const k = itemKey(v.item);
      return { key: k ?? '', name: k, amount: v.total };
    });
  const saleRank = rank(cpRows('sale'), true, top);
  const purchaseRank = rank(cpRows('purchase'), true, top);
  // 거래처 줄의 12달 달마다 금액과 받기까지 평균 날수. 기간(1, 3, 6개월)과 상관없이 같은 12달로 센다
  const yearMonths = Array.from({ length: 12 }, (_, i) => shiftMonth(month, i - 11));
  const year = new Map<string, CfInvoice[]>();
  for (const v of input.invoices) {
    if (v.writtenOn < `${yearMonths[0]}-01` || v.writtenOn > to) continue;
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
  const filedSales = filed.filter((v) => v.kind === 'sale');
  const ledgerSales = filedSales.filter((v) => v.fromLedger);
  saleRank.split = {
    ledger: { count: ledgerSales.length, amount: ledgerSales.reduce((s, v) => s + v.total, 0) },
    outside: { count: filedSales.length - ledgerSales.length, amount: filedSales.reduce((s, v) => s + v.total, 0) - ledgerSales.reduce((s, v) => s + v.total, 0) },
  };
  const sales = live.filter((v) => v.kind === 'sale');

  const bankLines = linesOf(inWin);
  // 앞 기간. 이번 기간이 아직 끝나지 않았으면 앞 기간도 지난 달 수만큼만 센다(4분기가 11월까지면 3분기는 7, 8월)
  const elapsed = Math.max(1, [...windowMonths].filter((m) => m <= today.slice(0, 7)).length);
  const prevMonths = Array.from({ length: months }, (_, i) => shiftMonth(month, i - 2 * months + 1)).slice(0, elapsed);
  const prevCf = prevMonths.map((m) => results.get(m)?.month ?? analyzeCashFlow({ ...input, month: m }).month);
  const prevTotals = monthLines(prevCf, !!input.exempt);
  const prevCover = coverage(prevCf);
  const curCover = coverage(inWin);
  // 왜 늘었을까: 앞 기간과 같은 길이, 매출 세금계산서만. 거래처와 품목을 함께 보고 차이가 큰 것부터 열둘(보이는 쪽이 늘어난 것만 또는 줄어든 것만 셋을 고른다)
  const prevFrom = `${prevMonths[0]}-01`;
  const prevTo = lastDay(prevMonths.at(-1)!);
  // 거래처 순위와 같이 낸 계산서 전부로 센다(받을 돈에서 뺀 건도 매출, F8)
  const prevSales = input.invoices.filter((v) => v.kind === 'sale' && v.writtenOn >= prevFrom && v.writtenOn <= prevTo);
  const deltas = (key: (v: CfInvoice) => string | null, name: (v: CfInvoice) => string | null, kind: ReportWhy['kind']) => {
    const by = new Map<string, ReportWhy>();
    for (const [vs, sign] of [[filed.filter((v) => v.kind === 'sale'), 1], [prevSales, -1]] as const)
      for (const v of vs) {
        const k = key(v);
        if (k === null) continue;
        const cur = by.get(k) ?? { kind, name: name(v), delta: 0 };
        cur.delta += sign * v.total;
        if (!cur.name) cur.name = name(v);
        by.set(k, cur);
      }
    return [...by.values()];
  };
  const why = [...deltas((v) => v.counterpartyKey, (v) => v.cpName, 'partner'), ...deltas((v) => itemKey(v.item), (v) => itemKey(v.item), 'item')]
    .filter((x) => x.delta !== 0)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || (a.kind < b.kind ? -1 : 1))
    .slice(0, 12);
  const lateSales = sales.filter((v) => v.overdue);
  // 받을 돈은 거래처마다 모은다. 한 거래처에 돌려줄 돈(붙이지 못한 음수분)이 다른 거래처의 받을 돈을 줄이지 않는다(받을 돈 화면 합계와 같다)
  const owedByCp = new Map<string, number>();
  for (const v of sales) owedByCp.set(v.counterpartyKey, (owedByCp.get(v.counterpartyKey) ?? 0) + owed(v));
  const receivable: ReportReceivable = {
    received: sales.reduce((s, v) => s + v.total - owed(v) - credit(v), 0),
    left: [...owedByCp.values()].reduce((s, x) => s + Math.max(0, x), 0),
    late: { count: lateSales.length, amount: lateSales.reduce((s, v) => s + v.remaining, 0) },
  };
  const purchaseKnown = (m: string) => (results.get(m)?.month ?? analyzeCashFlow({ ...input, month: m }).month).accrual.invoicesKnown.purchase;

  const notes: ReportNote[] = [];
  // 이번 기간의 끝 달이 오늘보다 뒤면 잔액, 자료 도착은 오늘이 든 달로 본다
  const now = month > today.slice(0, 7) ? today.slice(0, 7) : month;
  const last = results.get(now) ?? analyzeCashFlow({ ...input, month: now });
  if (!last.month.hasAccounts) notes.push({ kind: 'no_accounts' });
  const gaps = new Map<string, ReportNote>();
  for (const m of inWin) for (const g of m.missing) gaps.set(g.accountId, { kind: 'account_gap', accountId: g.accountId, bank: g.bank, last4: g.last4, coverTo: g.coverTo });
  notes.push(...gaps.values());
  const days = input.hometaxLastAt ? daysBetween(input.hometaxLastAt.slice(0, 10), today) : null;
  if (days === null || days >= HOMETAX_STALE_DAYS) notes.push({ kind: 'hometax_stale', lastAt: input.hometaxLastAt, days });

  return {
    today, month, months, from, to,
    ...totals,
    prev: { sales: prevTotals.sales.total, purchase: prevTotals.purchase.total, comparable: { sales: covers(prevCover.sales, curCover.sales), purchase: covers(prevCover.purchase, curCover.purchase) } },
    receivable,
    why: covers(prevCover.sales, curCover.sales) ? why : [],
    vat: vatOf(input, month, to, purchaseKnown),
    series,
    partners: { sale: saleRank, purchase: purchaseRank },
    items: { sale: rank(itemRows('sale'), false, top), purchase: rank(itemRows('purchase'), false, top) },
    bankLines,
    balance: last.snapshot.balance,
    through: { bank: bankThrough(last.snapshot.balance.accounts, to), hometax: input.hometaxLastAt ? input.hometaxLastAt.slice(0, 10) : null },
    notes,
    hometaxAt: input.hometaxLastAt,
    arrivals: arrivalsOf(input, now),
  };
}

/**
 * 달력 기간의 끝 달(대표 11-28): 1개월은 그 달, 3개월은 분기(1~3, 4~6, 7~9, 10~12월), 6개월은 반기(1~6, 7~12월, 부가세 1기와 2기), 12개월은 그해.
 * 이번 기간은 끝 달이 오늘보다 뒤일 수 있다. 그 달들은 자료가 없어 모름으로 보인다.
 */
export function periodEnd(month: string, months: ReportWindow): string {
  if (months === 1) return month;
  const m = Number(month.slice(5, 7));
  return `${month.slice(0, 4)}-${String(Math.ceil(m / months) * months).padStart(2, '0')}`;
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
