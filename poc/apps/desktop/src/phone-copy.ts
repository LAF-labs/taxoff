import { monthOf, newestFirst } from '@sax/chat-core';
import type { ReportResult } from '@sax/engine';
import type { CopyBankCats, CopyCashflow, CopyCounterparty, CopyIssued, CopyLine, CopyRank, CopyReport, MoneySide, PhoneCopyBody } from '@sax/remote';
import type { Counterparty, RunView } from './shell-model.ts';

const CP_REF = /^[A-Za-z0-9_-]{1,40}$/;
const BIZNO = /^\d{3}-\d{2}-\d{5}$/;
const DAY = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_WON = 100_000_000_000;
const MAX_REPORT_WON = 10_000_000_000_000;

const won = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= MAX_WON ? (v as number) : null);
const count = (v: unknown): number => (Number.isSafeInteger(v) && (v as number) >= 0 ? Math.min(v as number, 1_000_000) : 0);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function bizNoOf(v: string): string | undefined {
  const d = v.replace(/\D/g, '');
  if (d.length !== 10) return BIZNO.test(v) ? v : undefined;
  return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
}

export function maskEmail(v: string): string | undefined {
  const at = v.lastIndexOf('@');
  if (at < 1 || at === v.length - 1) return undefined;
  const local = v.slice(0, at);
  const out = `${local.slice(0, Math.min(2, local.length))}***@${v.slice(at + 1)}`;
  return out.length <= 80 ? out : undefined;
}

export function lastIssues(runs: readonly RunView[]): Map<string, CopyCounterparty['last']> {
  const out = new Map<string, NonNullable<CopyCounterparty['last']> & { at: string }>();
  for (const r of runs) {
    if (r.status !== 'done' || r.doc !== 'H-01' || !r.counterparty.id || !DAY.test(r.writeDate)) continue;
    const supply = won(r.supply);
    if (supply === null) continue;
    const prev = out.get(r.counterparty.id);
    if (prev && prev.at >= r.writeDate) continue;
    out.set(r.counterparty.id, { supply, vatMode: r.vat === 'included' ? 'incl' : 'excl', item: clip(r.item, 60), day: r.writeDate, at: r.writeDate });
  }
  return new Map([...out].map(([k, { at, ...v }]) => (void at, [k, v])));
}

const ISSUED_MONTHS = 13;
const ISSUED_MAX = 400;

type IssuedSrc = { counterpartyId: string | null; counterparty: string; date: string; total: number | null; approvalNo?: string | null; supply?: number | null; tax?: number | null; item?: string | null; issueDate?: string | null; amendOf?: string | null; amend?: { cancelled: boolean; replaced: boolean; adjusted: { supply: number; tax: number } } | null };
const APPROVAL = /^\d{8}-\d{8}-\d{8}$/;
const signed = (v: unknown): number | null => (Number.isSafeInteger(v) && Math.abs(v as number) <= MAX_WON ? (v as number) : null);

/**
 * 13달 발급 기록(issued.v1). amend.v1 폰에는 수정세금계산서(ADR-058)에 쓰는 칸을 더한다: 승인번호, 부호 있는 공급가액과 세액, 품목, 작성일자,
 * 수정분이면 당초분 승인번호, 당초분이면 수정 상태. amend.v1이 아닌 폰에는 수정분 줄을 보내지 않는다(합계가 음수라 그 폰의 스키마에 맞지 않는다).
 */
export function copyIssued(rows: ReadonlyArray<IssuedSrc>, today: string, amend = false): CopyIssued[] {
  const from = `${monthOf(today, 1 - ISSUED_MONTHS)}-01`;
  return newestFirst(rows.filter((r) => DAY.test(r.date) && r.date >= from && r.date <= today && r.counterparty.trim() && (amend || !r.amendOf)))
    .slice(0, ISSUED_MAX)
    .map((r) => {
      const base: CopyIssued = { ...(r.counterpartyId && CP_REF.test(r.counterpartyId) ? { ref: r.counterpartyId } : {}), name: clip(r.counterparty.trim(), 60), day: r.date, total: r.total === null ? null : won(r.total) };
      if (!amend) return base;
      const sp = signed(r.supply);
      const tx = signed(r.tax);
      const adjS = r.amend ? signed(r.amend.adjusted.supply) : null;
      const adjT = r.amend ? signed(r.amend.adjusted.tax) : null;
      return {
        ...base,
        ...(r.approvalNo && APPROVAL.test(r.approvalNo) ? { approvalNo: r.approvalNo } : {}),
        ...(sp !== null && tx !== null ? { supply: sp, tax: tx } : {}),
        ...(r.item?.trim() ? { item: clip(r.item.trim(), 60) } : {}),
        ...(r.issueDate && DAY.test(r.issueDate) ? { wrtDay: r.issueDate } : {}),
        ...(r.amendOf && APPROVAL.test(r.amendOf) ? { amendOf: r.amendOf } : {}),
        ...(r.amend?.cancelled ? { amendState: 'cancelled' as const } : r.amend?.replaced ? { amendState: 'replaced' as const } : {}),
        ...((adjS || adjT) && adjS !== null && adjT !== null ? { adjSupply: adjS, adjTax: adjT } : {}),
      };
    });
}

export function issueCounts(runs: readonly RunView[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of runs) if (r.status === 'done' && r.doc === 'H-01' && r.counterparty.id) out.set(r.counterparty.id, (out.get(r.counterparty.id) ?? 0) + 1);
  return out;
}

/** 장부의 휴폐업 조회 값('status:02', 'valid:03')에서 폰에 보일 상태만 꺼낸다. 계속사업자와 조회 전은 없음. */
function stateOf(status: string): CopyCounterparty['state'] {
  const m = /^(?:status|valid):(0[23])$/.exec(status);
  return m ? (m[1] === '02' ? 'paused' : 'closed') : undefined;
}

export function copyCounterparties(cps: readonly Counterparty[], last: Map<string, CopyCounterparty['last']>, approver = false, counts: ReadonlyMap<string, number> = new Map()): CopyCounterparty[] {
  const recent = (c: Counterparty) => last.get(c.id)?.day ?? c.lastIssuedOn ?? '';
  const many = (c: Counterparty) => counts.get(c.id) ?? 0;
  return [...cps]
    .filter((c) => CP_REF.test(c.id) && c.name.trim().length > 0)
    .sort((a, b) => (recent(a) !== recent(b) ? (recent(a) < recent(b) ? 1 : -1) : many(b) - many(a) || a.name.localeCompare(b.name, 'ko')))
    .slice(0, 100)
    .map((c) => {
      const row: CopyCounterparty = { ref: c.id, name: clip(c.name.trim(), 60), phoneApprovable: approver && (!!c.lastIssuedOn || last.has(c.id) || c.phoneAdded === true) };
      const b = bizNoOf(c.bizNo);
      if (b) row.bizNo = b;
      const e = maskEmail(c.email);
      if (e) row.emailHint = e;
      if (c.rep.trim()) row.rep = clip(c.rep.trim(), 100);
      if (c.item.trim()) row.item = clip(c.item.trim(), 100);
      const st = stateOf(c.status);
      if (st) {
        row.state = st;
        if (DAY.test(c.checkedOn)) row.stateOn = c.checkedOn;
      }
      const l = last.get(c.id);
      if (l) row.last = l;
      return row;
    });
}

export interface BankSummaryLike {
  hasAccounts: boolean;
  unpaidCount: number;
  unpaidTotal: number;
  overdueCount: number;
  overdueTotal: number;
  reviewCount: number;
  payable: { unpaidCount: number; unpaidTotal: number; overdueCount: number; overdueTotal: number; dueSoonCount: number; dueSoonTotal: number; reviewCount: number };
}

export interface CashFlowLike {
  month: { month: string; complete: boolean; hasAccounts: boolean; missing: Array<{ bank: string }>; cash: { in: { total: number }; out: { total: number }; net: number } };
  snapshot: { next30: { payOut: number; payOverdue: number; payIn: number; noDuePay: number } };
  alerts: Array<{ id: string; kind: string; gap?: number; cpName?: string | null; priorDays?: number; recentDays?: number; share?: number; total?: number }>;
}

interface ReceivableLike {
  remaining: number;
  dueIn: number | null;
  overdue: boolean;
}

const fmtWon = (n: number) => `${n.toLocaleString('ko-KR')}원`;

export function alertOf(a: CashFlowLike['alerts'][number]): NonNullable<CopyCashflow['alerts']>[number] | null {
  const who = a.cpName ?? '한 거래처';
  switch (a.kind) {
    case 'shortfall':
      return won(a.gap) === null ? null : { id: clip(a.id, 64), kind: 'low_balance', text: `다음 30일에 낼 돈이 통장 잔액과 들어올 돈보다 ${fmtWon(a.gap!)} 많아요` };
    case 'slowdown':
      return { id: clip(a.id, 64), kind: 'slow_collection', text: clip(`${who} 입금이 평소보다 늦어지고 있어요(평균 ${count(a.priorDays)}일 → ${count(a.recentDays)}일)`, 200) };
    case 'concentration':
      return { id: clip(a.id, 64), kind: 'concentration', text: clip(`지난 3개월 매출의 ${Math.round((a.share ?? 0) * 100)}%가 ${who}예요`, 200) };
    case 'unknown_in':
      return won(a.total) === null ? null : { id: clip(a.id, 64), kind: 'unknown_inflow', text: `어디서 온 돈인지 모르는 입금이 ${fmtWon(a.total!)} 있어요. 확인해 둘까요?` };
    default:
      return null;
  }
}

export function copyMoney(s: BankSummaryLike, cf: CashFlowLike | null, recv: readonly ReceivableLike[] | null, accounts: number, now: number): PhoneCopyBody['money'] {
  const soon = (recv ?? []).filter((r) => !r.overdue && r.dueIn !== null && r.dueIn >= 0 && r.dueIn <= 7);
  const side = (x: Omit<MoneySide, 'dueSoonCount' | 'dueSoonTotal'> & Partial<MoneySide>): MoneySide => ({
    unpaidCount: count(x.unpaidCount),
    unpaidTotal: won(x.unpaidTotal) ?? 0,
    overdueCount: count(x.overdueCount),
    overdueTotal: won(x.overdueTotal) ?? 0,
    dueSoonCount: count(x.dueSoonCount),
    dueSoonTotal: won(x.dueSoonTotal) ?? 0,
    reviewCount: count(x.reviewCount),
  });
  const money: NonNullable<PhoneCopyBody['money']> = {
    asOf: now,
    accounts: Math.min(count(accounts), 20),
    receivable: side({ ...s, dueSoonCount: soon.length, dueSoonTotal: soon.reduce((t, r) => t + (won(r.remaining) ?? 0), 0) }),
    payable: side(s.payable),
  };
  if (cf && cf.month.hasAccounts && /^\d{4}-(0[1-9]|1[0-2])$/.test(cf.month.month)) {
    const sure = cf.month.complete;
    const n30 = cf.snapshot.next30;
    money.cashflow = {
      month: cf.month.month,
      complete: sure,
      ...(cf.month.missing.length ? { missing: cf.month.missing.slice(0, 8).map((m) => clip(m.bank || '계좌', 40)) } : {}),
      inTotal: sure ? won(cf.month.cash.in.total) : null,
      outTotal: sure ? won(cf.month.cash.out.total) : null,
      net: sure && Number.isSafeInteger(cf.month.cash.net) && Math.abs(cf.month.cash.net) <= MAX_WON ? cf.month.cash.net : null,
      in30: won(n30.payIn),
      out30: won(n30.payOut + n30.payOverdue),
      noDueOutCount: count(n30.noDuePay),
      alerts: cf.alerts.map(alertOf).filter((a): a is NonNullable<typeof a> => a !== null).slice(0, 4),
    };
  }
  return money;
}

const BANK_CATS = ['receivable', 'payable', 'payroll', 'card_payment', 'tax', 'card_sales', 'interest', 'other'] as const;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v * 100))) : 0);

/**
 * 월 리포트 사본(ADR-068 결정 8, 봉투 v1.15). 엔진 리포트(1, 3, 6, 12개월) 넷에서 만든다.
 * 12달 값은 달마다 따로 실어 폰이 기간 합을 스스로 낸다. 계좌는 은행과 끝 4자리만, 통장 표시 원문과 입금자 이름은 싣지 않는다.
 * 값이 틀이 맞지 않으면 그 칸을 null로(확인 못 함) 둔다. 0으로 바꾸지 않는다.
 */
export function copyReport(byWindow: ReadonlyMap<number, ReportResult>, biz?: { name: string; bizNo?: string | null } | null, v2 = false, v3 = false): CopyReport | null {
  // report.v3 폰은 리포트 합계를 10조까지 받는다(envelope reportWon). 그 앞 폰은 1,000억 넘는 값을 null(확인 못 함)로 받는다
  const max = v3 ? MAX_REPORT_WON : MAX_WON;
  const rw = (v: unknown): number | null => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= max ? (v as number) : null);
  const year = byWindow.get(12);
  if (!year || !MONTH.test(year.month) || !DAY.test(year.today)) return null;
  const line = (l: { amount: number | null; partial: boolean }): CopyLine => ({ a: l.amount === null ? null : rw(l.amount), p: !!l.partial });
  const cats = (side: Record<string, { amount: number }>): CopyBankCats => {
    const out: CopyBankCats = {};
    for (const k of BANK_CATS) {
      const v = rw(side[k]?.amount);
      if (v) out[k] = v;
    }
    return out;
  };
  // 거래처 시트의 12달 금액과 받기까지 날수는 기간 넷에서 겹치는 거래처가 많아 한 번씩만 싣고 줄은 칸 번호(i)로 가리킨다
  const pm: NonNullable<CopyReport['pm']> = [];
  const pmAt = new Map<string, number>();
  const pmOf = (side: string, x: ReportResult['partners']['sale']['top'][number]): number | undefined => {
    if (!x.monthly || x.monthly.length !== 12) return undefined;
    const k = `${side} ${x.key}`;
    let i = pmAt.get(k);
    if (i === undefined) {
      i = pm.length;
      pm.push({ m: x.monthly.map((v) => (Number.isSafeInteger(v) && Math.abs(v) <= max ? v : 0)), d: typeof x.days === 'number' && Number.isInteger(x.days) && x.days >= 0 && x.days <= 3650 ? x.days : null });
      pmAt.set(k, i);
    }
    return i;
  };
  const rank = (r: ReportResult['partners']['sale'], side?: 'sale' | 'purchase'): CopyRank => ({
    rows: r.top.slice(0, 10).map((x) => {
      const row: CopyRank['rows'][number] = { name: x.name?.trim() ? clip(x.name.trim(), 60) : null, n: count(x.count), a: rw(x.amount) ?? 0, pct: pct(x.share) };
      if (x.settled !== undefined) row.settled = rw(x.settled) ?? 0;
      if (x.remaining !== undefined) row.left = rw(x.remaining) ?? 0;
      if (v2 && x.late) row.late = rw(x.late) ?? 0;
      const i = side ? pmOf(side, x) : undefined;
      if (i !== undefined) row.i = i;
      return row;
    }),
    rest: r.rest ? { k: count(r.rest.n), n: count(r.rest.count), a: rw(r.rest.amount) ?? 0, pct: pct(r.rest.share), ...(v2 && r.rest.remaining !== undefined ? { left: rw(r.rest.remaining) ?? 0 } : {}) } : null,
    total: rw(r.total) ?? 0,
  });
  const months = year.series.slice(-12).map((m) => {
    const row: CopyReport['months'][number] = {
      month: m.month,
      sales: { inv: line(m.sales.invoices), cr: line(m.sales.cashReceipts), card: line(m.sales.cardSales), cash: line(m.sales.cashSales) },
      purchase: { inv: line(m.purchase.invoices), card: line(m.purchase.card), cr: line(m.purchase.cashReceipts), rcpt: line(m.purchase.receipts), pay: line(m.purchase.payroll) },
    };
    if (m.bank.hasAccounts) row.bank = { in: rw(m.bank.in) ?? 0, out: rw(m.bank.out) ?? 0, done: m.bank.complete, bin: cats(m.bankLines.in), bout: cats(m.bankLines.out) };
    return row;
  });
  const windows = ([1, 3, 6, 12] as const).flatMap((w) => {
    const r = byWindow.get(w);
    if (!r || r.month !== year.month) return [];
    const split = r.partners.sale.split;
    return [{
      months: w,
      ps: rank(r.partners.sale, 'sale'), pp: rank(r.partners.purchase, 'purchase'), is: rank(r.items.sale), ip: rank(r.items.purchase),
      ...(split ? { split: { inN: count(split.ledger.count), inA: rw(split.ledger.amount) ?? 0, outN: count(split.outside.count), outA: rw(split.outside.amount) ?? 0 } } : {}),
      ...(v2
        ? {
            prev: { s: line(r.prev.sales), p: line(r.prev.purchase) },
            recv: { got: rw(r.receivable.received) ?? 0, left: rw(r.receivable.left) ?? 0, lateN: count(r.receivable.late.count), lateA: rw(r.receivable.late.amount) ?? 0 },
          }
        : {}),
    }];
  });
  const balances = year.balance.accounts
    .filter((x) => /^\d{4}$/.test(x.last4))
    .slice(0, 20)
    .map((x) => ({ bank: clip(x.bank?.trim() || '계좌', 40), last4: x.last4, a: x.balance === null ? null : rw(x.balance), ...(x.day && DAY.test(x.day) ? { d: x.day } : {}) }));
  const bizName = biz?.name?.trim();
  const v = year.vat;
  return {
    month: year.month, today: year.today,
    bankTo: year.through.bank && DAY.test(year.through.bank) ? year.through.bank : null,
    hometaxTo: year.through.hometax && DAY.test(year.through.hometax) ? year.through.hometax : null,
    months, windows, balances,
    ...(v2 ? { vat: { h: v.half, from: v.from, to: v.to, s: v.sale === null ? null : (rw(v.sale) ?? null), sn: count(v.saleCount), p: v.purchase === null ? null : (rw(v.purchase) ?? null), dl: v.deadline } } : {}),
    ...(pm.length ? { pm } : {}),
    ...(bizName ? { biz: { name: clip(bizName, 60), bizNo: biz?.bizNo ? (bizNoOf(biz.bizNo) ?? null) : null } } : {}),
  };
}

interface PhoneCopySource {
  counterparties: () => readonly Counterparty[];
  runs: () => readonly RunView[];
  bank: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  approval?: () => Promise<{ approver: boolean; left: number }>;
  issued?: () => ReadonlyArray<IssuedSrc> | Promise<ReadonlyArray<IssuedSrc>>;
  today?: () => string;
  /** 폰이 amend.v1이면 수정세금계산서 칸을 싣는다 */
  amend?: boolean;
  now?: () => number;
  /** report.v1 폰에만 월 리포트 사본을 싣는다 */
  report?: boolean;
  /** report.v2 폰에만 지난 기간, 받을 돈, 부가세 칸을 싣는다 */
  reportV2?: boolean;
  reportV3?: boolean;
  /** 폰 PDF 머리에 쓰는 사업장 이름과 번호 */
  biz?: () => { name: string; bizNo?: string | null } | null;
  /** 리포트를 싣지 못한 까닭(main.phone_copy_report). 값은 남기지 않고 기간과 오류 글 앞 60자만 */
  log?: (name: string, data: Record<string, string | number>) => void;
}

interface OverviewLike {
  summary: BankSummaryLike;
  unpaid: ReceivableLike[];
  accounts: unknown[];
}

export async function buildPhoneCopy(src: PhoneCopySource): Promise<PhoneCopyBody> {
  const now = (src.now ?? Date.now)();
  const ap = (await src.approval?.().catch(() => null)) ?? null;
  const body: PhoneCopyBody = { asOf: now, counterparties: copyCounterparties(src.counterparties(), lastIssues(src.runs()), !!ap?.approver, issueCounts(src.runs())) };
  if (ap?.approver) body.todayApprovalsLeft = ap.left;
  if (src.issued && src.today) {
    const rows = await Promise.resolve().then(src.issued).catch(() => null);
    if (rows) body.issued = copyIssued(rows, src.today(), !!src.amend);
  }
  try {
    const o = (await src.bank('db.query.bank.overview')) as OverviewLike;
    if (o?.summary?.payable && Array.isArray(o.unpaid) && Array.isArray(o.accounts)) {
      const cf = o.accounts.length ? ((await src.bank('db.query.bank.cashflow').catch(() => null)) as CashFlowLike | null) : null;
      body.money = copyMoney(o.summary, cf, o.unpaid, o.accounts.length, now);
    }

  } catch {
    // 돈 칸 없이(폰은 마지막에 받은 돈 요약을 그대로 둔다)
  }
  if (src.report) {
    // 리포트를 읽지 못하면 리포트 칸 없이 보내고 까닭을 남긴다. 폰은 마지막에 받은 리포트를 그대로 둔다
    const byWindow = new Map<number, ReportResult>();
    for (const months of [1, 3, 6, 12]) {
      try {
        const r = (await src.bank('db.query.bank.report', { months })) as ReportResult | null;
        if (r) byWindow.set(months, r);
        else src.log?.('main.phone_copy_report', { result: 'empty', months });
      } catch (e) {
        src.log?.('main.phone_copy_report', { result: 'query_failed', months, code: String((e as Error)?.message ?? 'error').slice(0, 60) });
      }
    }
    const report = copyReport(byWindow, src.biz?.() ?? null, !!src.reportV2, !!src.reportV3);
    if (report) body.report = report;
    else if (byWindow.has(12)) src.log?.('main.phone_copy_report', { result: 'invalid', months: 12 });
  }
  return body;
}
