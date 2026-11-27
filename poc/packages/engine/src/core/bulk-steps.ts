import { checkGrid, isBulkParty, isBulkRows, type BulkGridRow } from './bulk.ts';
import type { Handler, Handlers, Outcome } from './steps.ts';
import { readRef } from './scope.ts';

/**
 * upload·grid_check 스텝(IR rev v1.4.0, ADR-063). 파일 만들기, 파일 칸 넣기, 목록 읽기는 금고가 한다(엔진은 경로도 바이트도 모른다).
 * 포트 결과의 reason은 금고 코드 모양(소문자, 밑줄)만 받아 `bulk.<reason>`으로 실패한다.
 */
export interface BulkPort {
  upload(r: { runId: string; stepId: string; sheet: 'hometax_bulk_v1'; spec: { supplier: unknown; rows: unknown } }): Promise<{ ok: true; rows: number; sha256: string } | { ok: false; reason: string; row?: number }>;
  readGrid(r: { runId: string; stepId: string }): Promise<{ ok: true; rows: BulkGridRow[] } | { ok: false; reason: string }>;
}

const REASON = /^[a-z_]{1,40}$/;
const fail = (code: string): Outcome => ({ t: 'fail', code });
const NEXT: Outcome = { t: 'next' };
/** 변환 목록은 홈택스가 서버 조회(ATEETBAA004R01) 뒤 채운다. 읽은 목록이 아직 비었거나 줄 수가 모자라면 이만큼 다시 본다. */
export const GRID_SETTLE_MS = 15_000;

export function bulkHandlers(port: BulkPort, runId: string): Handlers {
  const upload: Handler<'upload'> = async (s, env) => {
    const rows = readRef(env.scope, s.rows);
    const supplier = readRef(env.scope, s.supplier);
    if (!isBulkRows(rows) || !isBulkParty(supplier)) return fail('bulk.bad_inputs');
    const r = await port.upload({ runId, stepId: s.id, sheet: s.sheet, spec: { supplier, rows } }).catch(() => ({ ok: false as const, reason: 'port_error' }));
    if (!r.ok) {
      env.journal?.('bulk.upload_refused', { stepId: s.id, reason: REASON.test(r.reason) ? r.reason : 'unknown', ...('row' in r && r.row ? { row: r.row } : {}) });
      return fail(`bulk.${REASON.test(r.reason) ? r.reason : 'upload_failed'}`);
    }
    if (r.rows !== rows.length) return fail('bulk.upload_count_mismatch');
    env.journal?.('bulk.uploaded', { stepId: s.id, rows: r.rows, sha256: r.sha256 });
    return NEXT;
  };

  const gridCheck: Handler<'grid_check'> = async (s, env) => {
    const rows = readRef(env.scope, s.rows);
    const supplier = readRef(env.scope, s.supplier);
    if (!isBulkRows(rows) || !isBulkParty(supplier)) return fail('bulk.bad_inputs');
    const deadline = env.clock.now() + (s.timeoutMs ?? GRID_SETTLE_MS);
    for (;;) {
      const g = await port.readGrid({ runId, stepId: s.id }).catch(() => ({ ok: false as const, reason: 'port_error' }));
      const v = g.ok ? checkGrid(rows, supplier, g.rows, s.expect) : null;
      if (v?.ok) {
        if (s.bind && v.approvalNos) env.scope.vars.set(s.bind, v.approvalNos.join(','));
        env.journal?.('bulk.grid_ok', { stepId: s.id, expect: s.expect, rows: rows.length });
        return NEXT;
      }
      const settling = !g.ok ? g.reason === 'grid_unreadable' : v!.code === 'bulk.grid_count_mismatch' || (s.expect === 'issued' && v!.code === 'bulk.approval_missing');
      if (!settling || env.clock.now() >= deadline || env.stopRequested?.()) {
        const code = g.ok ? v!.code : `bulk.${REASON.test(g.reason) ? g.reason : 'grid_unreadable'}`;
        env.journal?.('bulk.grid_failed', { stepId: s.id, expect: s.expect, code, ...(v && !v.ok && v.row ? { row: v.row } : {}), ...(v && !v.ok && v.field ? { field: v.field } : {}), ...(g.ok ? { got: g.rows.length } : {}) });
        return fail(code);
      }
      await env.clock.sleep(Math.min(500, Math.max(0, deadline - env.clock.now())));
    }
  };

  return { upload, grid_check: gridCheck };
}
