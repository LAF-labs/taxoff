import type { Handler, Handlers, Outcome } from './steps.ts';
import { readRef } from './scope.ts';

/**
 * report_sync 스텝(IR rev v1.4.1, ADR-068 결정 6). 홈택스 조회 화면 읽기는 금고가 고정 스크립트로 한다(`report.readScreen`).
 * 엔진은 받기 계획을 구간마다 금고에 넘기고, 읽은 줄이나 실패 코드를 받는 곳(sink)에 넘긴다. 받는 곳이 장부에 넣는다(bank/report-sink.ts → BankService.hometaxSync).
 */
export const REPORT_KINDS = ['sale_invoice', 'purchase_invoice', 'cash_receipt_in', 'cash_receipt_out', 'card_sales', 'business_card'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export interface ReportPlanItem {
  kind: ReportKind;
  from: string;
  to: string;
}
/** 한 번의 받기 구간 상한. 처음 받기(지난 12개월)는 세금계산서 4+4, 현금영수증 13+13, 사업용 카드 13, 카드 매출 5로 52개다. */
export const REPORT_PLAN_MAX = 80;

export interface ReportPort {
  read(r: { runId: string; stepId: string; kind: ReportKind; from: string; to: string }): Promise<{ ok: true; rows: Array<Record<string, unknown>> } | { ok: false; reason: string }>;
}
/** 받은 구간 하나. code가 있으면 그 구간은 못 받았다(rows 없음). 받는 곳은 code 있는 구간을 덮음으로 치지 않는다(다음 받기에 다시 받는다). */
export type ReportSinkItem = ReportPlanItem & ({ rows: Array<Record<string, unknown>>; code?: undefined } | { code: string; rows?: undefined });
/**
 * 받는 곳. put은 구간마다, done은 구간을 다 돈 뒤(멈춘 실행도) 한 번 부른다. 사업용 카드처럼 한 실행에서 받은 구간을 모아 한 번에 넣는 받는 곳이 done에서 넣는다.
 */
export interface ReportSink {
  put(runId: string, item: ReportSinkItem): Promise<void> | void;
  done?(runId: string): Promise<void> | void;
}

const ISO = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const REASON = /^[a-z_]{1,40}$/;

export function isReportPlan(v: unknown): v is ReportPlanItem[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > REPORT_PLAN_MAX) return false;
  return v.every((x) => {
    if (!x || typeof x !== 'object') return false;
    const r = x as Record<string, unknown>;
    return (REPORT_KINDS as readonly unknown[]).includes(r.kind) && typeof r.from === 'string' && ISO.test(r.from) && typeof r.to === 'string' && ISO.test(r.to) && r.from <= r.to;
  });
}

/** 금고가 홈택스에 들어가지 못한 사유. 이 사유면 남은 구간도 같은 까닭으로 못 받으니 더 돌지 않고 남은 구간을 같은 코드로 넘긴다. */
const STOP_ALL = new Set(['target_not_exposed', 'secret_window_open', 'menu_missing', 'screen_lost', 'port_error', 'timeout']);

/** 날짜 범위로 조회하는 자료. 한 번에 읽는 줄 상한을 넘으면 구간을 반으로 나눠 하루가 될 때까지 다시 받는다. 달이나 분기를 고르는 화면은 나눌 수 없다. */
const BY_RANGE = new Set<ReportKind>(['sale_invoice', 'purchase_invoice']);
const TOO_MANY = new Set(['too_many_rows', 'too_many_pages']);
const DAY_MS = 86_400_000;
function halves(from: string, to: string): [{ from: string; to: string }, { from: string; to: string }] | null {
  const a = Date.parse(`${from}T00:00:00Z`);
  const days = Math.round((Date.parse(`${to}T00:00:00Z`) - a) / DAY_MS);
  if (days < 1) return null;
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  const mid = a + Math.floor(days / 2) * DAY_MS;
  return [{ from, to: iso(mid) }, { from: iso(mid + DAY_MS), to }];
}

export function reportHandlers(port: ReportPort, sink: ReportSink, runId: string): Handlers {
  const sync: Handler<'report_sync'> = async (s, env) => {
    const plan = readRef(env.scope, s.plan);
    if (!isReportPlan(plan)) return { t: 'fail', code: 'report.bad_plan' } satisfies Outcome;
    let ok = 0;
    let failed = 0;
    let stopAll: string | null = null;
    let got = false;
    const done = async (): Promise<boolean> => {
      try {
        await sink.done?.(runId);
        return true;
      } catch {
        env.journal?.('report.sink_failed', { stepId: s.id, kind: 'done' });
        return false;
      }
    };
    for (const item of plan) {
      const parts: ReportPlanItem[] = [item];
      let itemCode: string | null = null;
      let read = 0;
      while (parts.length) {
        if (env.stopRequested?.()) {
          await done();
          return { t: 'fail', code: 'run.aborted' };
        }
        const part = parts.shift()!;
        let code: string | null = stopAll;
        let rows: Array<Record<string, unknown>> = [];
        if (!code) {
          const r = await port.read({ runId, stepId: s.id, kind: part.kind, from: part.from, to: part.to }).catch(() => ({ ok: false as const, reason: 'port_error' }));
          if (r.ok) rows = r.rows;
          else {
            const reason = REASON.test(r.reason) ? r.reason : 'read_failed';
            const split = TOO_MANY.has(reason) && BY_RANGE.has(part.kind) ? halves(part.from, part.to) : null;
            if (split) {
              env.journal?.('report.read_split', { stepId: s.id, kind: part.kind, from: part.from, to: part.to });
              parts.unshift({ kind: part.kind, ...split[0] }, { kind: part.kind, ...split[1] });
              continue;
            }
            code = `report.${reason}`;
            if (STOP_ALL.has(reason)) stopAll = code;
          }
        }
        try {
          await sink.put(runId, code ? { ...part, code } : { ...part, rows });
        } catch {
          env.journal?.('report.sink_failed', { stepId: s.id, kind: item.kind });
          return { t: 'fail', code: 'report.sink_failed' };
        }
        itemCode ??= code;
        if (!code) got = true;
        read += rows.length;
      }
      // 줄 값은 일지에 남기지 않는다(종류, 기간, 줄 수, 코드만). 나눠 받은 구간도 계획의 한 구간으로 한 번 센다
      env.journal?.(itemCode ? 'report.read_failed' : 'report.read_ok', { stepId: s.id, kind: item.kind, from: item.from, to: item.to, ...(itemCode ? { code: itemCode } : { rows: read }) });
      if (itemCode) failed++;
      else ok++;
    }
    if (!(await done())) return { t: 'fail', code: 'report.sink_failed' };
    env.journal?.('report.synced', { stepId: s.id, ok, failed });
    // 하나도 못 받았으면 실행이 실패로 끝난다(원인은 구간마다 일지와 받는 곳에 남았다). 일부만 받았으면 다음으로 간다.
    return got ? { t: 'next' } : { t: 'fail', code: stopAll ?? 'report.nothing_read' };
  };
  return { report_sync: sync };
}
