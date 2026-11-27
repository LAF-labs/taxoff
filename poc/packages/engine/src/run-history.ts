import { AmendRepo, type ColumnCipher, type Db } from '@sax/db';

/**
 * 실행 입력 요약(runs.inputs_json_enc). 값이라 봉인한다. 이메일은 두지 않는다(카드를 다시 그리는 데 필요한 것만).
 * 작성일자와 품목은 수정세금계산서가 당초분을 보이고 홈택스 당초분과 대조하는 데 쓴다(ADR-058). 예전 행에는 없다.
 */
export interface RunInputsSummary {
  counterpartyId: string;
  supply: number;
  tax: number;
  issueDate?: string | null;
  item?: string | null;
  /** 수정세금계산서 실행이면 당초분 승인번호(ADR-058 결정 7: 수정분은 새 승인번호의 새 줄이다). */
  amendOf?: string | null;
}

/** 당초분 하나에 걸린 수정 상태(ADR-058 결정 7). adjusted는 금액 바뀜, 반품 수정분의 합(음수)이다. */
export interface RunHistoryAmend {
  cancelled: boolean;
  replaced: boolean;
  adjusted: { supply: number; tax: number };
}

export interface RunHistoryRow {
  runId: string;
  playbookId: string;
  status: string;
  code: string | null;
  startedAt: string;
  finishedAt: string | null;
  ledger: string | null;
  approvalNo: string | null;
  mailConfirmed: boolean | null;
  documentId: string | null;
  gated: boolean;
  counterpartyId: string | null;
  counterpartyName: string | null;
  supply: number | null;
  tax: number | null;
  issueDate: string | null;
  item: string | null;
  amendOf: string | null;
  /** 이 발급분을 당초분으로 한 수정이 있으면 그 상태(실패한 것은 뺀다). */
  amend: RunHistoryAmend | null;
  certInputs: Readonly<Record<string, string>> | null;
}

const aad = (runId: string) => `runs.inputs_json_enc|${runId}`;

/** 실행 입력 요약을 봉인해 runs 행에 둔다. 행이 없으면 아무것도 하지 않는다. */
export function recordRunInputs(db: Db, cipher: ColumnCipher, runId: string, s: RunInputsSummary): void {
  if (typeof s.counterpartyId !== 'string' || !Number.isSafeInteger(s.supply) || !Number.isSafeInteger(s.tax)) return;
  const issueDate = typeof s.issueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.issueDate) ? s.issueDate : undefined;
  const item = typeof s.item === 'string' && s.item.trim() ? s.item.trim().slice(0, 100) : undefined;
  const amendOf = typeof s.amendOf === 'string' && /^\d{8}-\d{8}-\d{8}$/.test(s.amendOf) ? s.amendOf : undefined;
  const blob = cipher.seal(JSON.stringify({ v: 1, counterpartyId: s.counterpartyId, supply: s.supply, tax: s.tax, ...(issueDate ? { issueDate } : {}), ...(item ? { item } : {}), ...(amendOf ? { amendOf } : {}) }), aad(runId));
  db.prepare('UPDATE runs SET inputs_json_enc = ? WHERE id = ?').run(blob, runId);
}

const CERT_MAX_KEYS = 16;
const CERT_MAX_LEN = 100;

/**
 * 민원증명 실행 입력 요약을 봉인해 runs 행에 둔다(H-01 요약과 같은 칸·같은 AAD 규칙, kind cert). 값은 패키지 선언의 선택값(용도·제출처·주민번호 공개 여부 등)이고
 * 주민번호 같은 비밀 값은 선언에 없다. 모양이 다르면 아무것도 쓰지 않는다.
 */
export function recordCertInputs(db: Db, cipher: ColumnCipher, runId: string, inputs: Readonly<Record<string, string>>): void {
  const e = Object.entries(inputs);
  if (e.length > CERT_MAX_KEYS || e.some(([k, v]) => !/^[A-Za-z0-9_]{1,40}$/.test(k) || typeof v !== 'string' || v.length > CERT_MAX_LEN)) return;
  const blob = cipher.seal(JSON.stringify({ v: 1, kind: 'cert', inputs: Object.fromEntries(e) }), aad(runId));
  db.prepare('UPDATE runs SET inputs_json_enc = ? WHERE id = ?').run(blob, runId);
}

type Opened = { kind: 'invoice'; s: RunInputsSummary } | { kind: 'cert'; inputs: Record<string, string> } | null;

function openInputs(cipher: ColumnCipher | null, runId: string, blob: unknown): Opened {
  if (!cipher || !(blob instanceof Uint8Array) || blob.length === 0) return null;
  try {
    const o = JSON.parse(cipher.open(blob, aad(runId))) as Partial<RunInputsSummary> & { v?: number; kind?: unknown; inputs?: unknown };
    if (o.v !== 1) return null;
    if (o.kind === 'cert') {
      const x = o.inputs;
      if (!x || typeof x !== 'object' || Array.isArray(x) || Object.values(x).some((v) => typeof v !== 'string')) return null;
      return { kind: 'cert', inputs: x as Record<string, string> };
    }
    if (typeof o.counterpartyId !== 'string' || !Number.isSafeInteger(o.supply) || !Number.isSafeInteger(o.tax)) return null;
    const issueDate = typeof o.issueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(o.issueDate) ? o.issueDate : null;
    const item = typeof o.item === 'string' ? o.item : null;
    const amendOf = typeof o.amendOf === 'string' ? o.amendOf : null;
    return { kind: 'invoice', s: { counterpartyId: o.counterpartyId, supply: o.supply!, tax: o.tax!, issueDate, item, amendOf } };
  } catch {
    return null;
  }
}

/** 한 실행의 입력 요약과 시작 시각(run.reverify가 조회 match를 되살린다). 행이 없거나 열지 못하면 null. */
export function runInputsOf(db: Db, cipher: ColumnCipher, runId: string): (RunInputsSummary & { startedAt: string }) | null {
  const r = db.prepare('SELECT started_at, inputs_json_enc FROM runs WHERE id = ?').get(runId) as { started_at: string; inputs_json_enc: unknown } | undefined;
  const s = r ? openInputs(cipher, runId, r.inputs_json_enc) : null;
  return s?.kind === 'invoice' && r ? { ...s.s, startedAt: String(r.started_at) } : null;
}

export const RUN_HISTORY_MAX = 200;

/** 최근 실행부터 limit건(기본 50, 상한 200). 예행(run.rehearsal)은 발급 이력이 아니라서 뺀다. */
export function runHistory(db: Db, cipher: ColumnCipher | null, limit = 50): RunHistoryRow[] {
  const n = Math.max(1, Math.min(RUN_HISTORY_MAX, Number.isInteger(limit) ? limit : 50));
  const runs = db
    .prepare(`SELECT id, playbook_id, status, started_at, finished_at, inputs_json_enc FROM runs WHERE id NOT IN (SELECT run_id FROM run_events WHERE type = 'run.rehearsal') ORDER BY started_at DESC, rowid DESC LIMIT ?`)
    .all(n) as Array<Record<string, unknown>>;
  const ended = db.prepare(`SELECT payload_json FROM run_events WHERE run_id = ? AND type = 'run.ended' ORDER BY seq DESC LIMIT 1`).pluck();
  const gated = db.prepare(`SELECT 1 FROM run_events WHERE run_id = ? AND type = 'gate.requested' LIMIT 1`).pluck();
  const ledger = db.prepare('SELECT state, verify_ref FROM irreversible_log WHERE run_id = ? ORDER BY armed_at DESC, attempt DESC, rowid DESC LIMIT 1');
  const doc = db.prepare('SELECT id FROM documents WHERE run_id = ? ORDER BY created_at DESC LIMIT 1').pluck();
  const cpName = db.prepare('SELECT name FROM counterparties WHERE id = ?').pluck();
  const amends = new Map<string, RunHistoryAmend>();
  for (const a of new AmendRepo(db).all()) {
    const m = amends.get(a.originalApprovalNo) ?? { cancelled: false, replaced: false, adjusted: { supply: 0, tax: 0 } };
    if (a.blockKey === 'full_cancel') m.cancelled = true;
    else if (a.blockKey === 'replace') m.replaced = true;
    else m.adjusted = { supply: m.adjusted.supply + a.supply, tax: m.adjusted.tax + a.tax };
    amends.set(a.originalApprovalNo, m);
  }
  return runs.map((r) => {
    const runId = String(r.id);
    let code: string | null = null;
    let mailConfirmed: boolean | null = null;
    const p = ended.get(runId);
    if (typeof p === 'string') {
      try {
        const e = JSON.parse(p) as { code?: unknown; mailConfirmed?: unknown };
        code = typeof e.code === 'string' && e.code ? e.code : null;
        mailConfirmed = typeof e.mailConfirmed === 'boolean' ? e.mailConfirmed : null;
      } catch {
        code = null;
      }
    }
    const l = ledger.get(runId) as { state: string; verify_ref: string | null } | undefined;
    const opened = openInputs(cipher, runId, r.inputs_json_enc);
    const inputs = opened?.kind === 'invoice' ? opened.s : null;
    const name = inputs ? cpName.get(inputs.counterpartyId) : undefined;
    const d = doc.get(runId);
    const approvalNo = l?.state === 'committed' && l.verify_ref ? l.verify_ref : null;
    return {
      runId,
      playbookId: String(r.playbook_id),
      status: String(r.status),
      code,
      startedAt: String(r.started_at),
      finishedAt: r.finished_at ? String(r.finished_at) : null,
      ledger: l?.state ?? null,
      approvalNo,
      mailConfirmed,
      documentId: typeof d === 'string' ? d : null,
      gated: gated.get(runId) !== undefined,
      counterpartyId: inputs?.counterpartyId ?? null,
      counterpartyName: typeof name === 'string' ? name : null,
      supply: inputs?.supply ?? null,
      tax: inputs?.tax ?? null,
      issueDate: inputs?.issueDate ?? null,
      item: inputs?.item ?? null,
      amendOf: inputs?.amendOf ?? null,
      amend: approvalNo ? (amends.get(approvalNo) ?? null) : null,
      certInputs: opened?.kind === 'cert' ? opened.inputs : null,
    };
  });
}
