import { normalizePayerName } from '@sax/db';
import { settledThrough } from './hometax-sync.ts';
import { addDays } from './match.ts';

type OutCategory = 'payable' | 'own_transfer' | 'tax' | 'card_payment' | 'payroll' | 'other';
type InCategory = 'receivable' | 'own_transfer' | 'card_sales' | 'interest' | 'other';
/** 사람이 고를 수 있는 갈래(bank.categorize). unrelated = 사업과 무관(분석에서 뺀다) */
export const HUMAN_CATEGORIES = ['own_transfer', 'tax', 'card_payment', 'payroll', 'card_sales', 'interest', 'other', 'unrelated'] as const;
export type HumanCategory = (typeof HUMAN_CATEGORIES)[number];

const CARD_COMPANIES = ['삼성카드', '신한카드', '현대카드', '국민카드', 'KB카드', '롯데카드', '하나카드', '우리카드', '비씨카드', 'BC카드', '농협카드', 'NH카드', '씨티카드', '카카오뱅크카드', '토스카드'];
const TAX_WORDS = ['국세', '지방세', '국민연금', '건강보험', '고용보험', '산재보험', '근로복지공단', '국민건강보험', '위택스', '세무서', '부가세', '종합소득세', '원천세'];
const INTEREST_WORDS = ['이자', '결산이자', '예금이자'];
const norm = (xs: string[]) => xs.map((x) => normalizePayerName(x)).filter(Boolean);
const CARD_N = norm(CARD_COMPANIES);
const TAX_N = norm(TAX_WORDS);
const INTEREST_N = norm(INTEREST_WORDS);

export interface CfAccount {
  id: string;
  last4: string;
  bank: string;
  ranges: Array<{ from: string; to: string }>;
  coverTo: string | null;
  balance: number | null;
  balanceDay: string | null;
}

export interface CfTxn {
  id: string;
  accountId: string;
  day: string;
  direction: 'in' | 'out';
  amount: number;
  label: string;
  payer?: string | null;
  counterOwn: boolean;
  settled: number;
  human: string | null;
}

export interface CfInvoice {
  id: string;
  kind: 'sale' | 'purchase';
  counterpartyKey: string;
  cpName: string | null;
  writtenOn: string;
  total: number;
  tax?: number | null;
  remaining: number;
  overdue?: boolean;
  dueOn: string | null;
  state: 'open' | 'unknown' | 'waiting' | 'settled' | 'excluded';
  settledOn: string | null;
  /** 품목명(홈택스 목록은 첫 품목, 앱 발급은 실행 입력). 리포트 품목 묶기에만 쓴다 */
  item?: string | null;
  /** 앱에서 발급한 줄인가(리포트 말풍선의 앱 발급, 앱 밖 발급 나눔) */
  fromLedger?: boolean;
}

/** 홈택스에서 받은 자료의 덮은 구간(hometax_syncs, ADR-068 결정 10). 성공한 회차만 */
export type HometaxKind = 'sale_invoice' | 'purchase_invoice' | 'cash_receipt_in' | 'cash_receipt_out' | 'card_sales' | 'business_card';

export interface CfInput {
  today: string;
  month: string;
  accounts: CfAccount[];
  txns: CfTxn[];
  invoices: CfInvoice[];
  cashSales: Array<{ day: string; amount: number }>;
  /** 사업용 카드 내역. 취소는 음수 금액이다 */
  cardTxns: Array<{ day: string; amount: number; merchantBizNo: string | null }>;
  receipts: Array<{ day: string; amount: number; merchantBizNo: string | null }>;
  payroll: Array<{ month: string; gross: number; net: number }>;
  payees: Array<{ nameNorm: string; month: string; net: number }>;
  rules: Array<{ direction: 'in' | 'out'; labelNorm: string; category: HumanCategory }>;
  cardRanges: Array<{ from: string; to: string }>;
  /** 홈택스 현금영수증(in 매출, out 매입). 취소거래는 음수 금액이다 */
  cashReceipts?: Array<{ side: 'in' | 'out'; day: string; amount: number; cpBizNo?: string | null }>;
  /** 홈택스 신용카드 매출자료(달마다 합계) */
  cardSales?: Array<{ month: string; amount: number; count: number }>;
  /** 홈택스 자료 덮은 구간. 다 들어온 데까지로 줄인 것(coveredTo) */
  hometax?: Array<{ kind: HometaxKind; from: string; to: string }>;
}

export interface Money {
  total: number;
  by: Record<string, number>;
  /** 갈래마다 줄 수(리포트 말풍선) */
  n: Record<string, number>;
}

export interface CashFlowMonth {
  month: string;
  from: string;
  to: string;
  complete: boolean;
  missing: Array<{ accountId: string; last4: string; bank: string; coverTo: string | null }>;
  hasAccounts: boolean;
  cash: { in: Money; out: Money; net: number; excluded: number };
  accrual: {
    /** 장부에 있는 세금계산서 합(앱 발급과 받은 홈택스 목록). 그 달 홈택스 목록을 덮어 받았는지는 invoicesKnown */
    salesInvoices: number;
    cashSales: number | null;
    purchaseInvoices: number;
    /** 그 달 홈택스 세금계산서 목록을 덮어 받았나. 아니면 앱에서 발급한 것만 알고 앱 밖 발급분은 모른다(리포트는 "일부"나 "확인 못 함") */
    invoicesKnown: { sale: boolean; purchase: boolean };
    card: number | null;
    receipts: number;
    payroll: number | null;
    /** 홈택스 현금영수증 매출, 매입, 신용카드 매출자료. 그 달을 덮어 받지 못했으면 null(확인 못 함) */
    cashReceiptsIn: number | null;
    cashReceiptsOut: number | null;
    cardSales: number | null;
  };
  collectionRate: number | null;
  unknown: { inTotal: number; outTotal: number; inCount: number; outCount: number; topIds: string[] };
}

export interface CashFlowSnapshot {
  today: string;
  balance: { total: number | null; partial: boolean; accounts: Array<{ accountId: string; last4: string; bank: string; balance: number | null; day: string | null }> };
  next30: { payOut: number; payOverdue: number; payIn: number; noDuePay: number; noDueRecv: number };
  aging: { notDue: number; d0_30: number; d31_60: number; d61_90: number; d90p: number; unknown: number };
  collectDays: { overall: number | null; byCounterparty: Array<{ key: string; cpName: string | null; days: number; count: number; recentDays: number | null; priorDays: number | null }> };
  payDays: number | null;
  concentration: { months: string[]; invoiceCount: number; top1: { key: string; cpName: string | null; share: number } | null; top3Share: number | null };
}

export type CashFlowAlert =
  | { id: string; kind: 'shortfall'; gap: number }
  | { id: string; kind: 'slowdown'; counterpartyKey: string; cpName: string | null; priorDays: number; recentDays: number }
  | { id: string; kind: 'concentration'; counterpartyKey: string; cpName: string | null; share: number }
  | { id: string; kind: 'unknown_in'; month: string; total: number; share: number };

export interface CashFlowResult {
  month: CashFlowMonth;
  snapshot: CashFlowSnapshot;
  alerts: CashFlowAlert[];
}

const monthOf = (day: string) => day.slice(0, 7);
const lastDay = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
};
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const shiftMonth = (month: string, d: number) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const t = new Date(Date.UTC(y, m - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};
const add = (m: Money, k: string, v: number) => {
  if (!v) return;
  m.total += v;
  m.by[k] = (m.by[k] ?? 0) + v;
  m.n[k] = (m.n[k] ?? 0) + 1;
};
const has = (label: string, words: string[]) => words.some((w) => w.length >= 2 && label.includes(w));

/** 줄 하나의 나머지(붙지 않은 금액) 갈래(§3.3). 사람 → 내 계좌 사이 → 사전 → 급여 후보 → 기타 */
export function categorize(t: CfTxn, ownPair: boolean, rules: Map<string, HumanCategory>, payees: CfInput['payees']): OutCategory | InCategory | 'unrelated' {
  const label = normalizePayerName(t.label);
  const human = (t.human ?? rules.get(`${t.direction}|${label}`) ?? null) as string | null;
  if (human === 'unrelated') return 'unrelated';
  if (human) {
    if (t.direction === 'out' && ['own_transfer', 'tax', 'card_payment', 'payroll', 'other'].includes(human)) return human as OutCategory;
    if (t.direction === 'in' && ['own_transfer', 'card_sales', 'interest', 'other'].includes(human)) return human as InCategory;
  }
  if (t.counterOwn || ownPair) return 'own_transfer';
  if (t.direction === 'out') {
    if (has(label, TAX_N)) return 'tax';
    if (has(label, CARD_N)) return 'card_payment';
    const m = monthOf(t.day);
    const prev = shiftMonth(m, -1);
    const who = t.payer != null ? normalizePayerName(t.payer) : label;
    if (who.length >= 2 && payees.some((p) => p.nameNorm === who && p.net === t.amount && (p.month === m || p.month === prev))) return 'payroll';
    return 'other';
  }
  if (has(label, CARD_N)) return 'card_sales';
  if (has(label, INTEREST_N)) return 'interest';
  return 'other';
}

function ownPairs(txns: CfTxn[]): Set<string> {
  const out = new Set<string>();
  const byKey = new Map<string, CfTxn[]>();
  for (const t of txns) byKey.set(`${t.day}|${t.amount}`, [...(byKey.get(`${t.day}|${t.amount}`) ?? []), t]);
  for (const list of byKey.values()) {
    const ins = list.filter((t) => t.direction === 'in' && t.settled === 0);
    const outs = list.filter((t) => t.direction === 'out' && t.settled === 0);
    for (const o of outs) {
      const i = ins.find((x) => x.accountId !== o.accountId && !out.has(x.id));
      if (i) {
        out.add(o.id);
        out.add(i.id);
      }
    }
  }
  return out;
}

/**
 * 기간 안 거래 줄마다 갈래(리포트 [갈래] 목록, ADR-068 결정 4). analyzeCashFlow와 같은 규칙이다.
 * 받을 돈, 낼 돈에 붙은 금액은 receivable, payable, 나머지는 categorize 결과. 내 계좌 사이와 사업과 무관은 빠진다.
 */
export function classifyTxns(input: Pick<CfInput, 'txns' | 'rules' | 'payees'>, from: string, to: string): Array<{ txn: CfTxn; category: string; amount: number }> {
  const rules = new Map(input.rules.map((r) => [`${r.direction}|${r.labelNorm}`, r.category]));
  const pairs = ownPairs(input.txns);
  const out: Array<{ txn: CfTxn; category: string; amount: number }> = [];
  for (const t of input.txns) {
    if (t.day < from || t.day > to) continue;
    const settled = Math.min(t.settled, t.amount);
    if (settled) out.push({ txn: t, category: t.direction === 'in' ? 'receivable' : 'payable', amount: settled });
    const rest = t.amount - settled;
    if (!rest) continue;
    const c = categorize(t, pairs.has(t.id), rules, input.payees);
    if (c !== 'unrelated' && c !== 'own_transfer') out.push({ txn: t, category: c, amount: rest });
  }
  return out;
}

/** 구간들의 합이 [from, to]를 빈틈없이 덮는가 */
export function rangesCover(ranges: Array<{ from: string; to: string }>, from: string, to: string): boolean {
  let reach = addDays(from, -1);
  for (const r of [...ranges].sort((a, b) => (a.from < b.from ? -1 : 1))) {
    if (r.from > addDays(reach, 1)) break;
    if (r.to > reach) reach = r.to;
    if (reach >= to) return true;
  }
  return reach >= to;
}

const covers = (a: CfAccount, from: string, to: string, today: string) => {
  const need = to >= today ? addDays(today, -7) : to;
  return rangesCover(a.ranges, from, need < from ? from : need) || (need < from && a.ranges.some((r) => r.from <= from && r.to >= need));
};

export function analyzeCashFlow(input: CfInput): CashFlowResult {
  const { today } = input;
  const rules = new Map(input.rules.map((r) => [`${r.direction}|${r.labelNorm}`, r.category]));
  const pairs = ownPairs(input.txns);
  const from = `${input.month}-01`;
  const monthEnd = lastDay(input.month);
  const to = monthEnd < today ? monthEnd : today;
  const accounts = input.accounts;
  const missing = accounts.filter((a) => !covers(a, from, to, today)).map((a) => ({ accountId: a.id, last4: a.last4, bank: a.bank, coverTo: a.coverTo }));

  const cin: Money = { total: 0, by: {}, n: {} };
  const cout: Money = { total: 0, by: {}, n: {} };
  let excluded = 0;
  const unknownRows: CfTxn[] = [];
  const unknown = { inTotal: 0, outTotal: 0, inCount: 0, outCount: 0, topIds: [] as string[] };
  for (const t of input.txns) {
    if (t.day < from || t.day > to) continue;
    const settled = Math.min(t.settled, t.amount);
    const rest = t.amount - settled;
    const m = t.direction === 'in' ? cin : cout;
    if (settled) add(m, t.direction === 'in' ? 'receivable' : 'payable', settled);
    if (!rest) continue;
    const c = categorize(t, pairs.has(t.id), rules, input.payees);
    if (c === 'unrelated') {
      excluded += rest;
      continue;
    }
    if (c === 'own_transfer') {
      excluded += rest;
      continue;
    }
    add(m, c, rest);
    if (c === 'other') {
      unknownRows.push({ ...t, amount: rest });
      if (t.direction === 'in') {
        unknown.inTotal += rest;
        unknown.inCount++;
      } else {
        unknown.outTotal += rest;
        unknown.outCount++;
      }
    }
  }
  unknown.topIds = unknownRows.sort((a, b) => b.amount - a.amount || (a.day < b.day ? -1 : 1)).slice(0, 5).map((t) => t.id);

  const inMonth = (d: string) => d >= from && d <= monthEnd;
  // 매출과 매입은 홈택스에 낸 계산서 그대로다. '받지 않기로 함'이나 '거래 취소'로 받을 돈에서 뺀 건(excluded)도 매출에서는 빠지지 않는다.
  // 매출을 바꾸는 것은 수정세금계산서뿐이다(그것은 음수 계산서로 들어온다). 받을 돈, 회수, 나이 계산만 live를 쓴다(파이프라인 점검 11-28 F8).
  const filed = input.invoices;
  const live = filed.filter((v) => v.state !== 'excluded');
  const salesInvoices = filed.filter((v) => v.kind === 'sale' && inMonth(v.writtenOn)).reduce((s, v) => s + v.total, 0);
  const purchaseInvoices = filed.filter((v) => v.kind === 'purchase' && inMonth(v.writtenOn)).reduce((s, v) => s + v.total, 0);
  const cs = input.cashSales.filter((c) => inMonth(c.day));
  const cards = input.cardTxns.filter((c) => inMonth(c.day));
  const cardTotal = cards.reduce((s, c) => s + c.amount, 0);
  // 홈택스 자료는 늦게 들어온다(카드는 다음 달 15일쯤). 그달에서 지금 다 들어와 있을 수 있는 데까지를 덮었으면 안다.
  // 아직 아무 날도 다 들어올 수 없는 달(이번 달 카드)은 모른다. 받은 구간은 ledgerInput이 받은 날 기준으로 이미 줄여 준다
  const knownBy = (ranges: Array<{ from: string; to: string }>, kind: HometaxKind) => {
    const settled = settledThrough(kind, today);
    const end = [monthEnd, today, settled].sort()[0]!;
    return end >= from && rangesCover(ranges, from, end);
  };
  const cardKnown = knownBy(input.cardRanges, 'business_card');
  const usedCard = new Set<number>();
  const crs = (input.cashReceipts ?? []).filter((c) => inMonth(c.day));
  const crOut = crs.filter((c) => c.side === 'out');
  const usedCr = new Set<number>();
  let receipts = 0;
  // 종이 영수증은 같은 거래가 카드 내역이나 현금영수증 매입으로 이미 들어왔으면 세지 않는다(두 번 세지 않기, ADR-068 결정 10)
  for (const r of input.receipts.filter((x) => inMonth(x.day))) {
    const same = (amount: number, day: string, biz: string | null | undefined) => amount === r.amount && Math.abs(daysBetween(day, r.day)) <= 1 && (!r.merchantBizNo || !biz || r.merchantBizNo === biz);
    const i = cards.findIndex((c, k) => !usedCard.has(k) && same(c.amount, c.day, c.merchantBizNo));
    if (i >= 0) {
      usedCard.add(i);
      continue;
    }
    const j = crOut.findIndex((c, k) => !usedCr.has(k) && same(c.amount, c.day, c.cpBizNo));
    if (j >= 0) usedCr.add(j);
    else receipts += r.amount;
  }
  const htKnown = (kind: HometaxKind) => knownBy((input.hometax ?? []).filter((h) => h.kind === kind), kind);
  const sum = (xs: Array<{ amount: number }>) => xs.reduce((a, x) => a + x.amount, 0);
  const cardSalesRows = (input.cardSales ?? []).filter((c) => c.month === input.month);
  const pay = input.payroll.filter((p) => p.month === input.month);

  const needTo = addDays(monthEnd, 60) < today ? addDays(monthEnd, 60) : today;
  const recvCovered = accounts.length > 0 && accounts.every((a) => covers(a, from, needTo, today));
  const issued = live.filter((v) => v.kind === 'sale' && inMonth(v.writtenOn));
  const issuedTotal = issued.reduce((s, v) => s + v.total, 0);
  const collectionRate = recvCovered && issuedTotal > 0 ? Math.round((issued.reduce((s, v) => s + (v.total - v.remaining), 0) / issuedTotal) * 1000) / 1000 : null;

  const month: CashFlowMonth = {
    month: input.month, from, to, complete: accounts.length > 0 && missing.length === 0, missing, hasAccounts: accounts.length > 0,
    cash: { in: cin, out: cout, net: cin.total - cout.total, excluded },
    accrual: {
      salesInvoices, cashSales: cs.length ? cs.reduce((s, c) => s + c.amount, 0) : null, purchaseInvoices,
      invoicesKnown: { sale: htKnown('sale_invoice'), purchase: htKnown('purchase_invoice') },
      card: cardKnown || htKnown('business_card') ? cardTotal : null, receipts, payroll: pay.length ? pay.reduce((s, p) => s + p.gross, 0) : null,
      cashReceiptsIn: htKnown('cash_receipt_in') ? sum(crs.filter((c) => c.side === 'in')) : null,
      cashReceiptsOut: htKnown('cash_receipt_out') ? sum(crOut) : null,
      cardSales: htKnown('card_sales') || cardSalesRows.length ? sum(cardSalesRows) : null,
    },
    collectionRate, unknown,
  };

  const balAccounts = accounts.map((a) => ({ accountId: a.id, last4: a.last4, bank: a.bank, balance: a.balance, day: a.balanceDay }));
  const balKnown = balAccounts.filter((a) => a.balance !== null);
  const balance = { total: balKnown.length ? balKnown.reduce((s, a) => s + a.balance!, 0) : null, partial: balKnown.length < balAccounts.length, accounts: balAccounts };

  const open = (v: CfInvoice) => v.state === 'open' || v.state === 'waiting';
  const in30 = addDays(today, 30);
  const next30 = { payOut: 0, payOverdue: 0, payIn: 0, noDuePay: 0, noDueRecv: 0 };
  for (const v of live) {
    if (!open(v) && v.state !== 'unknown') continue;
    if (v.kind === 'purchase') {
      if (!v.dueOn) next30.noDuePay++;
      else if (v.dueOn < today) next30.payOverdue += v.remaining;
      else if (v.dueOn <= in30) next30.payOut += v.remaining;
    } else if (open(v)) {
      if (!v.dueOn) next30.noDueRecv++;
      else if (v.dueOn >= today && v.dueOn <= in30) next30.payIn += v.remaining;
    }
  }

  const aging = { notDue: 0, d0_30: 0, d31_60: 0, d61_90: 0, d90p: 0, unknown: 0 };
  for (const v of live.filter((x) => x.kind === 'sale')) {
    if (v.state === 'unknown') {
      aging.unknown += v.remaining;
      continue;
    }
    if (v.state !== 'open') continue;
    const over = v.dueOn ? daysBetween(v.dueOn, today) : -1;
    if (over < 0) aging.notDue += v.remaining;
    else if (over <= 30) aging.d0_30 += v.remaining;
    else if (over <= 60) aging.d31_60 += v.remaining;
    else if (over <= 90) aging.d61_90 += v.remaining;
    else aging.d90p += v.remaining;
  }

  const weighted = (xs: CfInvoice[]) => {
    const w = xs.reduce((s, v) => s + v.total, 0);
    return w ? Math.round(xs.reduce((s, v) => s + v.total * daysBetween(v.writtenOn, v.settledOn!), 0) / w) : null;
  };
  const doneSales = live.filter((v) => v.kind === 'sale' && v.state === 'settled' && v.settledOn);
  const donePurch = live.filter((v) => v.kind === 'purchase' && v.state === 'settled' && v.settledOn);
  const byCp = new Map<string, CfInvoice[]>();
  for (const v of doneSales) byCp.set(v.counterpartyKey, [...(byCp.get(v.counterpartyKey) ?? []), v]);
  const byCounterparty = [...byCp]
    .filter(([, xs]) => xs.length >= 3)
    .map(([key, xs]) => {
      const sorted = [...xs].sort((a, b) => (a.settledOn! < b.settledOn! ? -1 : 1));
      const recent = sorted.slice(-3);
      const prior = sorted.slice(0, -3);
      return { key, cpName: xs[xs.length - 1]!.cpName, days: weighted(xs)!, count: xs.length, recentDays: prior.length ? weighted(recent) : null, priorDays: prior.length ? weighted(prior) : null };
    })
    .sort((a, b) => b.days - a.days || (a.key < b.key ? -1 : 1));

  const months = [shiftMonth(monthOf(today), -2), shiftMonth(monthOf(today), -1), monthOf(today)];
  const recentSales = filed.filter((v) => v.kind === 'sale' && months.includes(monthOf(v.writtenOn)));
  const shares = new Map<string, { total: number; cpName: string | null }>();
  for (const v of recentSales) shares.set(v.counterpartyKey, { total: (shares.get(v.counterpartyKey)?.total ?? 0) + v.total, cpName: v.cpName });
  const all = recentSales.reduce((s, v) => s + v.total, 0);
  const ranked = [...shares].sort((a, b) => b[1].total - a[1].total || (a[0] < b[0] ? -1 : 1));
  const enough = recentSales.length >= 5 && all > 0;
  const share = (n: number) => Math.round((n / all) * 1000) / 1000;
  const concentration = {
    months, invoiceCount: recentSales.length,
    top1: enough && ranked[0] ? { key: ranked[0][0], cpName: ranked[0][1].cpName, share: share(ranked[0][1].total) } : null,
    top3Share: enough ? share(ranked.slice(0, 3).reduce((s, [, x]) => s + x.total, 0)) : null,
  };

  const snapshot: CashFlowSnapshot = {
    today, balance, next30, aging,
    collectDays: { overall: weighted(doneSales), byCounterparty }, payDays: weighted(donePurch), concentration,
  };

  const alerts: CashFlowAlert[] = [];
  const fresh = accounts.length > 0 && accounts.every((a) => !!a.coverTo && a.coverTo >= addDays(today, -7));
  if (fresh && balance.total !== null && !balance.partial) {
    const gap = next30.payOut + next30.payOverdue - (balance.total + next30.payIn);
    if (gap > 0) alerts.push({ id: `shortfall:${today}`, kind: 'shortfall', gap });
  }
  for (const c of byCounterparty)
    if (c.recentDays !== null && c.priorDays !== null && c.recentDays - c.priorDays > 15) alerts.push({ id: `slowdown:${c.key}`, kind: 'slowdown', counterpartyKey: c.key, cpName: c.cpName, priorDays: c.priorDays, recentDays: c.recentDays });
  if (concentration.top1 && concentration.top1.share > 0.5) {
    const q = `${today.slice(0, 4)}Q${Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1}`;
    alerts.push({ id: `concentration:${q}`, kind: 'concentration', counterpartyKey: concentration.top1.key, cpName: concentration.top1.cpName, share: concentration.top1.share });
  }
  if (month.complete && cin.total > 0 && unknown.inTotal / cin.total > 0.2) alerts.push({ id: `unknown_in:${input.month}`, kind: 'unknown_in', month: input.month, total: unknown.inTotal, share: Math.round((unknown.inTotal / cin.total) * 1000) / 1000 });

  return { month, snapshot, alerts };
}
