import type { Db } from './open.ts';

export type AmendState = 'running' | 'committed' | 'failed' | 'in_doubt';
export type AmendWhatCode = 'wrong_entry' | 'duplicate' | 'local_lc' | 'amount_changed' | 'deal_cancelled' | 'returned';

/** 수정세금계산서 한 번(ADR-058 결정 7). 금액은 홈택스로 나간 주된 장의 부호 있는 값(잘못 적음이면 새 계산서). 원래 줄은 고치지 않는다. */
export interface AmendRow {
  runId: string;
  intentId: string;
  originalApprovalNo: string;
  what: AmendWhatCode;
  blockKey: 'full_cancel' | 'replace' | null;
  issueDate: string;
  supply: number;
  tax: number;
  item: string;
  cpBizNo: string;
  state: AmendState;
  approvalNo: string | null;
  createdAt: string;
}

export class AmendRepo {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  /** 시작 기록. 한 번만 되는 사유(차단 키)가 이미 진행 중이거나 확정됐으면 false(유일 색인, ADR-036 3.6을 넓힌 것). */
  open(r: Omit<AmendRow, 'state' | 'approvalNo' | 'createdAt'>, now = new Date().toISOString()): boolean {
    try {
      this.db.prepare(`INSERT INTO invoice_amends (run_id, intent_id, original_approval_no, what, block_key, issue_date, supply, tax, item, cp_biz_no, state, approval_no, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, ?, ?)`).run(r.runId, r.intentId, r.originalApprovalNo, r.what, r.blockKey, r.issueDate, r.supply, r.tax, r.item, r.cpBizNo, now, now);
      return true;
    } catch (e) {
      if (/UNIQUE/i.test(String((e as Error)?.message))) return false;
      throw e;
    }
  }

  finish(runId: string, state: Exclude<AmendState, 'running'>, approvalNo: string | null, now = new Date().toISOString()): void {
    this.db.prepare(`UPDATE invoice_amends SET state = ?, approval_no = COALESCE(?, approval_no), updated_at = ? WHERE run_id = ? AND state IN ('running','in_doubt')`).run(state, approvalNo, now, runId);
  }

  /** 원본 하나에 걸린 수정 기록(실패는 뺀다). */
  forOriginal(approvalNo: string): AmendRow[] {
    return (this.db.prepare(`SELECT * FROM invoice_amends WHERE original_approval_no = ? AND state <> 'failed' ORDER BY created_at`).all(approvalNo) as Raw[]).map(row);
  }

  /** 수정 기록 전부(발급 기록, 받을 돈 화면의 상태 한 마디). */
  all(): AmendRow[] {
    return (this.db.prepare(`SELECT * FROM invoice_amends WHERE state <> 'failed' ORDER BY created_at`).all() as Raw[]).map(row);
  }
}

interface Raw {
  run_id: string; intent_id: string; original_approval_no: string; what: AmendWhatCode; block_key: AmendRow['blockKey']; issue_date: string;
  supply: number; tax: number; item: string; cp_biz_no: string; state: AmendState; approval_no: string | null; created_at: string;
}
const row = (r: Raw): AmendRow => ({
  runId: r.run_id, intentId: r.intent_id, originalApprovalNo: r.original_approval_no, what: r.what, blockKey: r.block_key, issueDate: r.issue_date,
  supply: r.supply, tax: r.tax, item: r.item, cpBizNo: r.cp_biz_no, state: r.state, approvalNo: r.approval_no, createdAt: r.created_at,
});
