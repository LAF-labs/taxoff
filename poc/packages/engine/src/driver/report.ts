import type { ReportPort } from '../core/report-steps.ts';

type Json = Record<string, unknown>;

/** 금고 클라이언트에서 이 포트가 쓰는 부분(VaultClient). */
export interface ReportVault {
  rpc<T>(method: string, params?: Json): Promise<T>;
}

const REASON = /^[a-z_]{1,40}$/;
/** 화면 하나 읽기의 상한. 금고는 화면 열기, 조회, 쪽 넘김마다 30초까지 기다리고 쪽은 120개까지라 넉넉히 둔다. 넘으면 그 구간은 timeout 실패다. */
export const REPORT_RPC_TIMEOUT_MS = 5 * 60_000;
const ROWS_MAX = 5_000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => (t = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(t));
}

/** 홈택스 조회 화면 읽기 금고 포트(ADR-068 결정 6). 엔진은 자료 종류와 기간만 넘기고 줄 모양은 받는 곳(BankService)이 다시 검사한다. */
export class VaultReportPort implements ReportPort {
  private readonly vault: ReportVault;
  private readonly targetId: () => string;
  private readonly timeoutMs: number;

  constructor(i: { vault: ReportVault; targetId(): string; timeoutMs?: number }) {
    this.vault = i.vault;
    this.targetId = i.targetId;
    this.timeoutMs = i.timeoutMs ?? REPORT_RPC_TIMEOUT_MS;
  }

  async read(r: Parameters<ReportPort['read']>[0]): ReturnType<ReportPort['read']> {
    const res = await withTimeout(this.vault.rpc<Json>('report.readScreen', { runId: r.runId, targetId: this.targetId(), screen: r.kind, period: { from: r.from, to: r.to } }), this.timeoutMs, { ok: false, reason: 'timeout' } as Json);
    if (res.ok === true && Array.isArray(res.rows) && res.rows.length <= ROWS_MAX && res.screen === r.kind && res.rows.every((x) => !!x && typeof x === 'object' && !Array.isArray(x))) {
      return { ok: true, rows: res.rows as Array<Record<string, unknown>> };
    }
    return { ok: false, reason: res.ok === true ? 'bad_result' : typeof res.reason === 'string' && REASON.test(res.reason) ? res.reason : 'read_failed' };
  }
}
