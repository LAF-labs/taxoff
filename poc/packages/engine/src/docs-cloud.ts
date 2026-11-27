import type { Db } from '@sax/db';
import type { DocumentService } from './documents.ts';

/**
 * 문서함 계정 사본의 장부 쪽(ADR-064). 봉인·서명·서버 호출은 main의 doc-sync.ts가 하고, 여기는 보관함 줄의 올림 상태만 적는다.
 * documents 표의 칸을 그대로 쓴다: blob_id = 계정 사본의 doc_id, backup_state, index_rev_max = 올린 기록 판, kek_ver = 기록을 봉인한 세대.
 *   blob_id 없음                      → 아직 안 올림(올릴 차례)
 *   blob_id 있음, pending             → 올리는 중(같은 doc_id로 이어서 올린다)
 *   blob_id 있음, uploaded            → 계정에 있다
 *   blob_id 있음, none                → 다른 PC가 계정 사본을 지웠다(다시 올리지 않는다, PC 파일은 둔다)
 */

const DOC_ID = /^[A-Za-z0-9_-]{22}$/;
const UUID = /^[0-9a-f-]{36}$/;
const CURSOR_KEY = 'docs.cloud.cursor';
const OFF_KEY = 'docs.cloud.off';

export class DocCloudError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new DocCloudError(code);
};

export interface DocCloudRow {
  id: string;
  name: string;
  docType: string;
  issuedOn: string | null;
  expiresOn: string | null;
  bytes: number;
  sha256: string;
  origin: 'app' | 'import';
  docId: string | null;
  state: 'none' | 'pending' | 'uploaded' | 'failed';
  rev: number;
  epoch: number | null;
}

type Params = Record<string, unknown>;

/** mark가 받는 새 상태마다, 그 상태로 바꿀 수 있는 지금 상태. */
const MARK_FROM: Record<'pending' | 'uploaded' | 'failed', readonly DocCloudRow['state'][]> = {
  pending: ['none', 'pending', 'failed'],
  failed: ['none', 'pending', 'failed'],
  uploaded: ['none', 'pending', 'failed', 'uploaded'],
};
const int = (v: unknown, min: number, max: number): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;

export class DocCloudService {
  private readonly db: Db;
  private readonly documents: DocumentService;
  constructor(db: Db, documents: DocumentService) {
    this.db = db;
    this.documents = documents;
  }

  handle(method: string, p: Params | undefined): unknown {
    const q = p ?? {};
    switch (method) {
      case 'db.query.docs.cloud':
        return this.state();
      case 'docs.mark':
        return this.mark(q);
      case 'docs.cursor':
        return this.setCursor(q.cursor);
      case 'docs.restore':
        return this.restore(q);
      case 'docs.forget':
        return this.forget(q.docId);
      default:
        return fail('docs.unknown_method');
    }
  }

  private setting(key: string): unknown {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
    return v === undefined ? undefined : (JSON.parse(v) as unknown);
  }

  state(): { off: boolean; cursor: number; docs: DocCloudRow[] } {
    const rows = this.db
      .prepare('SELECT id, doc_type, display_name, issued_at, expires_at, bytes, sha256, meta_json, run_id, blob_id, backup_state, index_rev_max, kek_ver FROM documents ORDER BY created_at')
      .all() as Array<Record<string, unknown>>;
    const docs = rows.map((r): DocCloudRow => {
      let origin: 'app' | 'import' = r.run_id ? 'app' : 'import';
      try {
        if ((JSON.parse(String(r.meta_json ?? '{}')) as { origin?: unknown }).origin === 'app') origin = 'app';
      } catch {
        /* 옛 줄: run_id로만 가른다 */
      }
      return {
        id: String(r.id), name: String(r.display_name ?? '서류'), docType: String(r.doc_type), issuedOn: (r.issued_at as string | null) ?? null, expiresOn: (r.expires_at as string | null) ?? null,
        bytes: Number(r.bytes), sha256: String(r.sha256), origin, docId: (r.blob_id as string | null) ?? null, state: r.backup_state as DocCloudRow['state'], rev: Number(r.index_rev_max ?? 0),
        epoch: r.kek_ver === null || r.kek_ver === undefined ? null : Number(r.kek_ver),
      };
    });
    const cursor = this.setting(CURSOR_KEY);
    return { off: this.setting(OFF_KEY) === true, cursor: int(cursor, 0, Number.MAX_SAFE_INTEGER) ? cursor : 0, docs };
  }

  /**
   * 올림 상태를 적는다. docId null은 처음부터 다시(새 doc_id로) 올린다는 뜻이다.
   * 한 번 계정에 올라간 줄(uploaded)은 pending이나 failed로 되돌리지 않는다. none으로 되돌리기는 forget만 한다.
   */
  mark(q: Params): { ok: true } {
    if (typeof q.id !== 'string' || !UUID.test(q.id)) fail('docs.bad_request');
    const state = q.state;
    if (state !== 'pending' && state !== 'uploaded' && state !== 'failed') return fail('docs.bad_request');
    const docId = q.docId === null ? null : typeof q.docId === 'string' && DOC_ID.test(q.docId) ? q.docId : fail('docs.bad_request');
    const rev = q.rev === undefined ? null : int(q.rev, 0, 1_000_000) ? q.rev : fail('docs.bad_request');
    const epoch = q.epoch === undefined ? null : int(q.epoch, 0, 64) ? q.epoch : fail('docs.bad_request');
    const from = MARK_FROM[state];
    const n = this.db
      .prepare(`UPDATE documents SET blob_id = ?, backup_state = ?, index_rev_max = COALESCE(?, index_rev_max), kek_ver = COALESCE(?, kek_ver) WHERE id = ? AND backup_state IN (${from.map(() => '?').join(',')})`)
      .run(docId, state, rev, epoch, q.id, ...from).changes;
    if (n) return { ok: true };
    const cur = this.db.prepare('SELECT backup_state FROM documents WHERE id = ?').get(q.id) as { backup_state: string } | undefined;
    return fail(cur ? 'docs.state_conflict' : 'docs.not_found');
  }

  setCursor(cursor: unknown): { cursor: number } {
    if (!int(cursor, 0, Number.MAX_SAFE_INTEGER)) fail('docs.bad_request');
    this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(CURSOR_KEY, JSON.stringify(cursor));
    return { cursor: cursor as number };
  }

  /** 다른 PC가 올린 문서를 받아 보관함에 넣고, 그 계정 사본과 잇는다. 같은 내용이 이미 있으면 그 줄을 잇기만 한다. */
  async restore(q: Params): Promise<{ id: string; created: boolean }> {
    if (typeof q.docId !== 'string' || !DOC_ID.test(q.docId) || !int(q.rev, 1, 1_000_000) || !int(q.epoch, 0, 64)) return fail('docs.bad_request');
    if (q.origin !== 'app' && q.origin !== 'import') return fail('docs.bad_request');
    const r = await this.documents.restore(q.bytes, {
      docType: String(q.docType), displayName: String(q.name), issuedOn: (q.issuedOn as string | null) ?? null, expiresOn: (q.expiresOn as string | null) ?? null, origin: q.origin,
    });
    const cur = this.db.prepare('SELECT blob_id, backup_state FROM documents WHERE id = ?').get(r.id) as { blob_id: string | null; backup_state: string } | undefined;
    if (cur && (!cur.blob_id || cur.backup_state !== 'uploaded')) this.mark({ id: r.id, state: 'uploaded', docId: q.docId, rev: q.rev, epoch: q.epoch });
    return r;
  }

  /** 다른 PC가 계정 사본을 지웠다. 이 PC의 파일은 그대로 두고, 다시 올리지 않게 적는다. */
  forget(docId: unknown): { changed: number } {
    if (typeof docId !== 'string' || !DOC_ID.test(docId)) return fail('docs.bad_request');
    return { changed: this.db.prepare("UPDATE documents SET backup_state = 'none' WHERE blob_id = ?").run(docId).changes };
  }
}
