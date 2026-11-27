import type { BulkPort } from '../core/bulk-steps.ts';
import type { BulkGridRow } from '../core/bulk.ts';

type Json = Record<string, unknown>;

/** 금고 클라이언트에서 이 포트가 쓰는 부분(VaultClient). */
export interface BulkVault {
  rpc<T>(method: string, params?: Json): Promise<T>;
}

const REASON = /^[a-z_]{1,40}$/;
/** 파일 넣기는 금고가 xlsx를 만들고 칸에 넣는 데까지라 오래 걸리지 않는다. 넘으면 실패로 본다(올라갔는지는 grid_check가 본다). */
export const BULK_RPC_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const timeout = new Promise<T>((resolve) => (t = setTimeout(() => resolve(fallback), ms)));
  return Promise.race([p.catch(() => fallback), timeout]).finally(() => clearTimeout(t));
}

/** 홈택스 일괄발급 금고 포트(ADR-063). 엔진은 묶음 값만 넘기고 결과 모양만 받는다. */
export class VaultBulkPort implements BulkPort {
  private readonly vault: BulkVault;
  private readonly targetId: () => string;

  constructor(i: { vault: BulkVault; targetId(): string }) {
    this.vault = i.vault;
    this.targetId = i.targetId;
  }

  async upload(r: Parameters<BulkPort['upload']>[0]): ReturnType<BulkPort['upload']> {
    const res = await withTimeout(this.vault.rpc<Json>('bulk.upload', { runId: r.runId, targetId: this.targetId(), sheet: r.spec }), BULK_RPC_TIMEOUT_MS, { ok: false, reason: 'timeout' } as Json);
    if (res.ok === true && Number.isSafeInteger(res.rows) && typeof res.sha256 === 'string' && /^[0-9a-f]{64}$/.test(res.sha256)) return { ok: true, rows: res.rows as number, sha256: res.sha256 };
    const reason = typeof res.reason === 'string' && REASON.test(res.reason) ? res.reason : 'upload_failed';
    return { ok: false, reason, ...(Number.isSafeInteger(res.row) ? { row: res.row as number } : {}) };
  }

  async readGrid(r: Parameters<BulkPort['readGrid']>[0]): ReturnType<BulkPort['readGrid']> {
    const res = await withTimeout(this.vault.rpc<Json>('bulk.readGrid', { runId: r.runId, targetId: this.targetId() }), BULK_RPC_TIMEOUT_MS, { ok: false, reason: 'timeout' } as Json);
    if (res.ok === true && Array.isArray(res.rows)) return { ok: true, rows: res.rows as BulkGridRow[] };
    return { ok: false, reason: typeof res.reason === 'string' && REASON.test(res.reason) ? res.reason : 'grid_unreadable' };
  }
}
