import type { Db } from './open.ts';

export type BulkRowState = 'running' | 'committed' | 'failed' | 'in_doubt';

/**
 * 홈택스 일괄발급 한 묶음의 줄(ADR-063). 장부(irreversible_log)는 묶음 하나를 의도 하나로 적고, 줄마다의 사업 키와 승인번호는 여기 둔다.
 * 건별 발급 게이트와 다음 묶음은 이 표로도 같은 계산서를 이미 냈는지 본다($dup.businessKey).
 */
export interface BulkRowRecord {
  runId: string;
  rowNo: number;
  intentId: string;
  businessKey: string;
  cpBizNo: string;
  issueDate: string;
  supply: number;
  tax: number;
  item: string;
  state: BulkRowState;
  approvalNo: string | null;
}

export class BulkRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  open(rows: ReadonlyArray<Omit<BulkRowRecord, 'state' | 'approvalNo'>>, now = new Date().toISOString()): void {
    const ins = this.db.prepare(`INSERT INTO invoice_bulk_rows (run_id, row_no, intent_id, business_key, cp_biz_no, issue_date, supply, tax, item, state, approval_no, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?)`);
    this.db.transaction(() => {
      for (const r of rows) ins.run(r.runId, r.rowNo, r.intentId, r.businessKey, r.cpBizNo, r.issueDate, r.supply, r.tax, r.item, now, now);
    })();
  }

  /** 묶음 끝. 확정이면 줄 순서대로 승인번호(없으면 그대로 둔다). */
  finish(runId: string, state: Exclude<BulkRowState, 'running'>, approvalNos: readonly string[] | null, now = new Date().toISOString()): void {
    const up = this.db.prepare(`UPDATE invoice_bulk_rows SET state = ?, approval_no = COALESCE(?, approval_no), updated_at = ? WHERE run_id = ? AND row_no = ? AND state IN ('running','in_doubt')`);
    this.db.transaction(() => {
      for (const r of this.byRun(runId)) up.run(state, approvalNos?.[r.rowNo - 1] ?? null, now, runId, r.rowNo);
    })();
  }

  byRun(runId: string): BulkRowRecord[] {
    return (this.db.prepare('SELECT * FROM invoice_bulk_rows WHERE run_id = ? ORDER BY row_no').all(runId) as Raw[]).map(row);
  }

  /** 사업 키 하나의 상태들(실패는 뺀다). 건별 게이트의 $dup.businessKey와 같은 뜻이다. */
  states(businessKey: string): BulkRowState[] {
    return (this.db.prepare(`SELECT state FROM invoice_bulk_rows WHERE business_key = ? AND state <> 'failed' ORDER BY created_at`).all(businessKey) as Array<{ state: BulkRowState }>).map((r) => r.state);
  }
}

interface Raw {
  run_id: string; row_no: number; intent_id: string; business_key: string; cp_biz_no: string; issue_date: string; supply: number; tax: number; item: string;
  state: BulkRowState; approval_no: string | null;
}
const row = (r: Raw): BulkRowRecord => ({
  runId: r.run_id, rowNo: r.row_no, intentId: r.intent_id, businessKey: r.business_key, cpBizNo: r.cp_biz_no, issueDate: r.issue_date,
  supply: r.supply, tax: r.tax, item: r.item, state: r.state, approvalNo: r.approval_no,
});
