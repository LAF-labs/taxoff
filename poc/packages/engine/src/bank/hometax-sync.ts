import type { HometaxKind } from './cashflow.ts';

/**
 * 홈택스 자동 받기 계획(ADR-068 결정 6). 순수 함수다.
 * 자료 종류마다 지난 12개월에서 다 들어온 자료로 덮지 못한 날을 받는다. 처음이면 지난 12개월 전부.
 * 실패한 받기(code 있음)는 덮음으로 치지 않으므로 다음 받기가 같은 구간을 다시 받는다.
 */

/** 한 번의 받기(hometax.report.sync)가 받는 자료 전부. 리포트, 받을 돈, 세무사 꾸러미가 모두 이것을 쓴다(결정 10) */
export const SYNC_KINDS = ['sale_invoice', 'purchase_invoice', 'cash_receipt_in', 'cash_receipt_out', 'card_sales', 'business_card'] as const satisfies readonly HometaxKind[];
export type SyncKind = (typeof SYNC_KINDS)[number];
/** 잠겼다 다시 풀었을 때 이만큼 지났으면 다시 받는다 */
export const SYNC_AGAIN_MS = 6 * 3_600_000;
const FIRST_MONTHS = 12;
const CHUNK_MONTHS = 3;

export interface SyncRecord {
  kind: HometaxKind;
  from: string;
  to: string;
  finishedAt: string;
  code: string | null;
}

export interface SyncStep {
  kind: SyncKind;
  from: string;
  to: string;
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);
const addDays = (iso: string, n: number) => day(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000);
const addMonths = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
};
const monthStart = (iso: string) => `${iso.slice(0, 7)}-01`;
const quarterStart = (iso: string) => `${iso.slice(0, 4)}-${String(Math.floor((Number(iso.slice(5, 7)) - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
const min = (a: string, b: string) => (a < b ? a : b);
/** 끝난 시각(UTC ISO)의 한국 날짜 */
const kstDayOf = (at: string) => day(Date.parse(at) + 9 * 3_600_000);

/**
 * 홈택스 화면마다 한 번에 고르는 기간(2026-11-25 실측, hometax-ref/report-probe.md).
 * 세금계산서 목록은 날짜 범위 3개월까지, 현금영수증과 사업용 카드는 달 하나, 카드 매출자료는 분기다.
 */
export const SYNC_UNIT: Readonly<Record<SyncKind, 'range' | 'month' | 'quarter'>> = {
  sale_invoice: 'range', purchase_invoice: 'range', cash_receipt_in: 'month', cash_receipt_out: 'month', business_card: 'month', card_sales: 'quarter',
};

/**
 * 그날 홈택스에 어디까지 다 들어와 있나(실측 안내 문구). 그 뒤는 받아도 아직 덜 들어온 것이라 덮었다고 치지 않는다.
 * - 세금계산서, 현금영수증: 다음 날 조회된다 → 어제까지
 * - 사업용 카드, 카드 매출(카드사): 매월 15일쯤 지난달 분 → 16일부터 지난달 끝까지, 그 전에는 지지난달 끝까지
 * - 카드 매출(판매대행): 분기 다음 달 17일쯤 → 그 달 18일부터 지난 분기 끝까지. 카드 매출은 둘 중 이른 쪽
 */
export function settledThrough(kind: HometaxKind, today: string): string {
  if (kind === 'sale_invoice' || kind === 'purchase_invoice' || kind === 'cash_receipt_in' || kind === 'cash_receipt_out') return addDays(today, -1);
  const card = addDays(monthStart(addMonths(monthStart(today), Number(today.slice(8, 10)) >= 16 ? 0 : -1)), -1);
  if (kind === 'business_card') return card;
  const q = quarterStart(today);
  const pgReady = addDays(addMonths(q, 1), 17) <= today ? q : addMonths(q, -3);
  return min(card, addDays(pgReady, -1));
}

/** 받은 회차 하나가 다 들어온 자료로 덮은 끝 날. 받은 날 기준으로 늦게 들어오는 만큼 줄인다 */
export function coveredTo(kind: HometaxKind, to: string, finishedAt: string): string {
  return min(to, settledThrough(kind, kstDayOf(finishedAt)));
}

/**
 * 그날 받은 자료가 더 바뀌지 않는 끝 날. 세금계산서는 작성일자가 지난달이어도 다음 달 10일까지 발급되고 다음 날 조회되니(월합계, 공급자의 늦은 발급),
 * 11일부터 지난달 끝까지, 그 전에는 지지난달 끝까지다. 나머지 자료는 다 들어온 날과 같다.
 */
function finalThrough(kind: HometaxKind, today: string): string {
  if (kind !== 'sale_invoice' && kind !== 'purchase_invoice') return settledThrough(kind, today);
  return addDays(addMonths(monthStart(today), Number(today.slice(8, 10)) >= 11 ? 0 : -1), -1);
}

/** 받을 차례인가: 앱을 켠 뒤 첫 잠금 풀기이거나, 마지막 성공에서 6시간이 지났을 때 */
export function syncDue(records: readonly SyncRecord[], nowMs: number, firstUnlock: boolean): boolean {
  if (firstUnlock) return true;
  const last = records.filter((r) => r.code === null).map((r) => Date.parse(r.finishedAt)).filter(Number.isFinite);
  return !last.length || nowMs - Math.max(...last) >= SYNC_AGAIN_MS;
}

function uncovered(covered: ReadonlyArray<{ from: string; to: string }>, from: string, to: string): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  let next = from;
  for (const r of [...covered].sort((a, b) => (a.from < b.from ? -1 : 1))) {
    if (r.to < next) continue;
    if (r.from > to) break;
    if (r.from > next) out.push({ from: next, to: addDays(r.from, -1) });
    next = addDays(r.to, 1);
  }
  if (next <= to) out.push({ from: next, to });
  return out;
}

const UNIT_START: Readonly<Record<'month' | 'quarter', (iso: string) => string>> = { month: monthStart, quarter: quarterStart };
const UNIT_MONTHS = { month: 1, quarter: 3 } as const;

/**
 * 받을 구간들. 지난 12개월에서 성공한 받기가 더 바뀌지 않는 자료로 덮지 못한 날(finalThrough 밖)을 모두 화면 단위로 잘라 이른 날부터 받는다.
 * 실패한 구간과 덜 들어온 달, 분기, 아직 늦은 발급이 들어올 수 있는 달의 세금계산서는 덮음으로 치지 않으니 뒤 구간이 성공했어도 다음 받기가 다시 받는다(ADR-072 결정 3).
 */
export function syncPlan(records: readonly SyncRecord[], today: string): SyncStep[] {
  const out: SyncStep[] = [];
  const earliest = addDays(addMonths(today, -FIRST_MONTHS), 1);
  for (const kind of SYNC_KINDS) {
    const covered = records.filter((r) => r.kind === kind && r.code === null).map((r) => ({ from: r.from, to: min(r.to, finalThrough(kind, kstDayOf(r.finishedAt))) }));
    const unit = SYNC_UNIT[kind];
    const starts = new Set<string>();
    for (const gap of uncovered(covered, earliest, today)) {
      let from = unit === 'range' ? gap.from : UNIT_START[unit](gap.from);
      while (from <= gap.to) {
        const to = min(addDays(addMonths(from, unit === 'range' ? CHUNK_MONTHS : UNIT_MONTHS[unit]), -1), unit === 'range' ? gap.to : today);
        if (!starts.has(from)) out.push({ kind, from, to });
        starts.add(from);
        from = addDays(to, 1);
      }
    }
  }
  return out;
}
