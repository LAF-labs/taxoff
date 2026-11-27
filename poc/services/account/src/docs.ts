import fs from 'node:fs/promises';
import path from 'node:path';
import { S3Client, fail, json, validator, type Ctx, type Router, type Sql } from '@sax/svc-shared';
import { DOCS } from './constants.ts';

/**
 * 문서함 계정 사본(ADR-064). 서버는 문서 기록 암호문과 조각 암호문을 맡아 둘 뿐이고 열 열쇠가 없다.
 * 기록과 상태는 DB `docs`, 조각은 비공개 객체 저장소에 둔다. 올리기는 시작 → 조각 → 기록(이때 보인다) 순서다.
 */

/** 조각 암호문 저장소. key는 이 모듈이 만든 `<account>/<doc>/<순번>`뿐이다. */
export interface DocBlobs {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
}

const KEY = /^[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{22}\/(?:[0-9]|1[0-5])$/;
const checkKey = (k: string): string => {
  if (!KEY.test(k)) throw new Error('docs_blob_key');
  return k;
};

export class MemoryDocBlobs implements DocBlobs {
  readonly files = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array): Promise<void> {
    this.files.set(checkKey(key), Uint8Array.from(bytes));
  }
  async get(key: string): Promise<Uint8Array | null> {
    return this.files.get(checkKey(key)) ?? null;
  }
  async delete(key: string): Promise<void> {
    this.files.delete(checkKey(key));
  }
}

/** 개발용 디렉터리 저장소(쓰기는 임시 파일 → rename). 운영은 S3다. */
export class DirDocBlobs implements DocBlobs {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = path.resolve(dir);
  }
  private file(key: string): string {
    return path.join(this.dir, ...checkKey(key).split('/'));
  }
  async put(key: string, bytes: Uint8Array): Promise<void> {
    const f = this.file(key);
    await fs.mkdir(path.dirname(f), { recursive: true, mode: 0o700 });
    const tmp = `${f}.tmp-${process.pid}`;
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    await fs.rename(tmp, f);
  }
  async get(key: string): Promise<Uint8Array | null> {
    try {
      return new Uint8Array(await fs.readFile(this.file(key)));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await fs.rm(this.file(key), { force: true });
  }
}

export class S3DocBlobs implements DocBlobs {
  private readonly s3: S3Client;
  constructor(s3: S3Client) {
    this.s3 = s3;
  }
  put(key: string, bytes: Uint8Array): Promise<void> {
    return this.s3.putBytes(checkKey(key), bytes, { 'content-type': 'application/octet-stream' });
  }
  async get(key: string): Promise<Uint8Array | null> {
    const b = await this.s3.getBytes(checkKey(key), DOCS.chunkMaxBytes);
    return b ? new Uint8Array(b) : null;
  }
  delete(key: string): Promise<void> {
    return this.s3.deleteKey(checkKey(key));
  }
}

/** env → 조각 저장소. DOCS_S3_ENDPOINT가 있으면 S3, DOCS_DIR이면 디렉터리, 둘 다 없으면 null(문서함 경로는 404). */
export function docBlobsFromEnv(env: NodeJS.ProcessEnv): DocBlobs | null {
  if (env.DOCS_S3_ENDPOINT) {
    return new S3DocBlobs(
      new S3Client({ endpoint: env.DOCS_S3_ENDPOINT, region: env.DOCS_S3_REGION ?? '', bucket: env.DOCS_S3_BUCKET ?? '', accessKeyId: env.DOCS_S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.DOCS_S3_SECRET_ACCESS_KEY ?? '' }),
    );
  }
  return env.DOCS_DIR ? new DirDocBlobs(env.DOCS_DIR) : null;
}

export interface DocCaller {
  accountId: string;
  deviceId: string;
  role: 'desktop' | 'mobile';
}
export interface DocOut {
  docId: string;
  seq: number;
  state: 'ready' | 'deleted';
  rev: number;
  epoch: number;
  deviceId: string;
  chunks: number;
  record: string | null;
}
interface DocRow {
  doc_id: string;
  seq: number | null;
  state: 'uploading' | 'ready' | 'deleted';
  rev: number;
  epoch: number;
  device_id: string;
  record: string | null;
  chunks: number;
  got: number;
  blob_bytes: number;
  expires_at: number | null;
}

const allBits = (n: number) => 2 ** n - 1;
const blobKey = (accountId: string, docId: string, i: number) => `${accountId}/${docId}/${i}`;
/** 마지막 조각을 뺀 조각은 모두 꽉 찬 크기다. 조각 수와 합이 맞는지 본다. */
const sizeFits = (chunks: number, blobBytes: number) =>
  chunks >= 1 && chunks <= DOCS.maxChunks && blobBytes > (chunks - 1) * DOCS.chunkMaxBytes + DOCS.chunkOverhead && blobBytes <= chunks * DOCS.chunkMaxBytes;
const chunkLen = (row: Pick<DocRow, 'chunks' | 'blob_bytes'>, i: number) => (i < row.chunks - 1 ? DOCS.chunkMaxBytes : Number(row.blob_bytes) - (row.chunks - 1) * DOCS.chunkMaxBytes);

export class DocBox {
  private readonly db: Sql;
  private readonly blobs: DocBlobs;
  readonly now: () => number;
  constructor(o: { db: Sql; blobs: DocBlobs; now: () => number }) {
    this.db = o.db;
    this.blobs = o.blobs;
    this.now = o.now;
  }

  private async row(q: Sql, accountId: string, docId: string, lock = false): Promise<DocRow | undefined> {
    return q.one<DocRow>(`SELECT doc_id, seq, state, rev, epoch, device_id, record, chunks, got, blob_bytes, expires_at FROM docs WHERE account_id = $1 AND doc_id = $2${lock ? q.forUpdate : ''}`, [accountId, docId]);
  }

  private async nextSeq(q: Sql, accountId: string): Promise<number> {
    const head = await q.one<{ next_seq: number }>(`SELECT next_seq FROM doc_heads WHERE account_id = $1${q.forUpdate}`, [accountId]);
    const seq = Number(head?.next_seq ?? 1);
    if (head) await q.run('UPDATE doc_heads SET next_seq = $1 WHERE account_id = $2', [seq + 1, accountId]);
    else await q.run('INSERT INTO doc_heads (account_id, next_seq) VALUES ($1, $2)', [accountId, seq + 1]);
    return seq;
  }

  private async dropBlobs(accountId: string, docId: string, from: number, to: number): Promise<void> {
    for (let i = from; i < to; i++) await this.blobs.delete(blobKey(accountId, docId, i));
  }

  /** 올리기 시작. 서버가 계정 열쇠를 열 수 있는 동안(맡긴 열쇠가 남은 계정)은 받지 않는다(ADR-064 결정 9). */
  async start(c: DocCaller, docId: string, b: { chunks: number; blobBytes: number }): Promise<{ expiresAt: number }> {
    if (c.role !== 'desktop') fail('account.scope_denied');
    if (!sizeFits(b.chunks, b.blobBytes)) fail('request.param_rejected');
    const now = this.now();
    const expiresAt = now + DOCS.uploadTtlMs;
    const shrink = await this.db.tx(async (q) => {
      await q.one(`SELECT id FROM accounts WHERE id = $1${q.forUpdate}`, [c.accountId]);
      if (await q.one('SELECT 1 AS x FROM key_escrow WHERE account_id = $1', [c.accountId])) fail('account.docs_escrow_on');
      const cur = await this.row(q, c.accountId, docId, true);
      if (cur && (cur.state !== 'uploading' || cur.device_id !== c.deviceId)) fail('account.doc_state');
      const use = await q.one<{ n: number; bytes: number | null }>("SELECT COUNT(*) AS n, SUM(blob_bytes) AS bytes FROM docs WHERE account_id = $1 AND state != 'deleted' AND doc_id != $2", [c.accountId, docId]);
      if (Number(use?.n ?? 0) >= DOCS.maxDocs || Number(use?.bytes ?? 0) + b.blobBytes > DOCS.maxAccountBytes) fail('account.docs_full');
      if (cur) {
        await q.run('UPDATE docs SET chunks = $1, got = 0, blob_bytes = $2, expires_at = $3 WHERE account_id = $4 AND doc_id = $5', [b.chunks, b.blobBytes, expiresAt, c.accountId, docId]);
        return cur.chunks > b.chunks ? cur.chunks : 0;
      }
      await q.run("INSERT INTO docs (account_id, doc_id, seq, state, rev, epoch, device_id, record, chunks, got, blob_bytes, expires_at) VALUES ($1, $2, NULL, 'uploading', 0, 0, $3, NULL, $4, 0, $5, $6)", [
        c.accountId, docId, c.deviceId, b.chunks, b.blobBytes, expiresAt,
      ]);
      return 0;
    });
    if (shrink) await this.dropBlobs(c.accountId, docId, b.chunks, shrink);
    return { expiresAt };
  }

  async putChunk(c: DocCaller, docId: string, i: number, bytes: Uint8Array): Promise<void> {
    if (c.role !== 'desktop') fail('account.scope_denied');
    const cur = await this.row(this.db, c.accountId, docId);
    if (!cur) fail('account.doc_not_found');
    if (cur.state !== 'uploading' || cur.device_id !== c.deviceId || i >= cur.chunks) fail('account.doc_state');
    if (bytes.length !== chunkLen(cur, i)) fail('request.param_rejected');
    await this.blobs.put(blobKey(c.accountId, docId, i), bytes);
    const n = await this.db.run("UPDATE docs SET got = got | $1 WHERE account_id = $2 AND doc_id = $3 AND state = 'uploading' AND device_id = $4 AND chunks = $5", [
      2 ** i, c.accountId, docId, c.deviceId, cur.chunks,
    ]);
    if (!n) fail('account.doc_state');
  }

  /**
   * 기록을 올린다. 올리는 중이면 조각이 다 왔을 때 문서를 보이게 하고, 이미 있으면 판(rev)이 오를 때만 바꾼다(세대를 올려 다시 봉인할 때).
   * 서버는 기록을 열지 못하므로 rev와 세대만 본다. 옛 판으로 되돌리기는 받는 기기도 rev로 막는다.
   */
  async putRecord(c: DocCaller, docId: string, b: { rev: number; epoch: number; record: string }): Promise<{ seq: number }> {
    if (c.role !== 'desktop') fail('account.scope_denied');
    return this.db.tx(async (q) => {
      const cur = await this.row(q, c.accountId, docId, true);
      if (!cur) fail('account.doc_not_found');
      if (cur.state === 'deleted') fail('account.doc_state');
      if (cur.state === 'uploading') {
        if (cur.device_id !== c.deviceId || Number(cur.got) !== allBits(cur.chunks)) fail('account.doc_state');
        if (Number(cur.expires_at) <= this.now()) fail('account.doc_state');
      } else if (b.rev <= Number(cur.rev) || b.epoch < Number(cur.epoch)) fail('account.doc_rev_stale');
      const seq = await this.nextSeq(q, c.accountId);
      await q.run("UPDATE docs SET seq = $1, state = 'ready', rev = $2, epoch = $3, device_id = $4, record = $5, got = 0, expires_at = NULL WHERE account_id = $6 AND doc_id = $7", [
        seq, b.rev, b.epoch, c.deviceId, b.record, c.accountId, docId,
      ]);
      return { seq };
    });
  }

  /** after보다 큰 순번의 변경을 순서대로. 지운 문서는 record 없이 state deleted로 온다. */
  async list(accountId: string, after: number): Promise<{ docs: DocOut[]; head: number; more: boolean }> {
    const head = await this.db.one<{ next_seq: number }>('SELECT next_seq FROM doc_heads WHERE account_id = $1', [accountId]);
    if (!head) return { docs: [], head: 0, more: false };
    const got = await this.db.all<DocRow>(
      `SELECT doc_id, seq, state, rev, epoch, device_id, record, chunks, got, blob_bytes, expires_at FROM docs WHERE account_id = $1 AND seq > $2 ORDER BY seq LIMIT ${DOCS.pageRows + 1}`,
      [accountId, after],
    );
    const docs = got.slice(0, DOCS.pageRows).map((r): DocOut => ({
      docId: r.doc_id, seq: Number(r.seq), state: r.state === 'deleted' ? 'deleted' : 'ready', rev: Number(r.rev), epoch: Number(r.epoch), deviceId: r.device_id, chunks: Number(r.chunks), record: r.record,
    }));
    return { docs, head: Number(head.next_seq) - 1, more: got.length > DOCS.pageRows };
  }

  async getChunk(accountId: string, docId: string, i: number): Promise<Uint8Array> {
    const cur = await this.row(this.db, accountId, docId);
    if (!cur || cur.state !== 'ready' || i >= cur.chunks) fail('account.doc_not_found');
    const b = await this.blobs.get(blobKey(accountId, docId, i));
    if (!b || b.length !== chunkLen(cur, i)) fail('account.doc_not_found');
    return b;
  }

  /** 계정 사본을 지운다. 보였던 문서는 기록을 지운 표시(deleted)를 남겨 다른 기기가 목록에서 뺀다. 조각은 바로 지운다. */
  async remove(c: DocCaller, docId: string): Promise<void> {
    if (c.role !== 'desktop') fail('account.scope_denied');
    const cur = await this.db.tx(async (q) => {
      const r = await this.row(q, c.accountId, docId, true);
      if (!r || r.state === 'deleted') return null;
      if (r.state === 'uploading') await q.run('DELETE FROM docs WHERE account_id = $1 AND doc_id = $2', [c.accountId, docId]);
      else {
        const seq = await this.nextSeq(q, c.accountId);
        await q.run("UPDATE docs SET seq = $1, state = 'deleted', record = NULL, device_id = $2, got = 0, blob_bytes = 0 WHERE account_id = $3 AND doc_id = $4", [seq, c.deviceId, c.accountId, docId]);
      }
      return r;
    });
    if (cur) await this.dropBlobs(c.accountId, docId, 0, cur.chunks);
  }

  /** 주기 작업: 기한이 지난 올리기와 탈퇴한 계정의 문서를 조각부터 지운다. */
  async sweep(): Promise<{ removed: number }> {
    const gone = await this.db.all<{ account_id: string; doc_id: string; chunks: number }>(
      `SELECT d.account_id, d.doc_id, d.chunks FROM docs d WHERE (d.state = 'uploading' AND d.expires_at <= $1) OR NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = d.account_id) LIMIT ${DOCS.sweepBatch}`,
      [this.now()],
    );
    for (const g of gone) {
      await this.dropBlobs(g.account_id, g.doc_id, 0, Number(g.chunks));
      await this.db.run('DELETE FROM docs WHERE account_id = $1 AND doc_id = $2', [g.account_id, g.doc_id]);
    }
    await this.db.run('DELETE FROM doc_heads WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = doc_heads.account_id)');
    return { removed: gone.length };
  }
}

const DOC_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{22}$' } as const;
const V = {
  id: validator<{ id: string }>({ type: 'object', additionalProperties: false, required: ['id'], properties: { id: DOC_ID } }),
  start: validator<{ chunks: number; blobBytes: number }>({
    type: 'object', additionalProperties: false, required: ['chunks', 'blobBytes'],
    properties: { chunks: { type: 'integer', minimum: 1, maximum: DOCS.maxChunks }, blobBytes: { type: 'integer', minimum: 41, maximum: DOCS.maxChunks * DOCS.chunkMaxBytes } },
  }),
  chunk: validator<{ data: string }>({
    type: 'object', additionalProperties: false, required: ['data'],
    properties: { data: { type: 'string', minLength: 55, maxLength: Math.ceil((DOCS.chunkMaxBytes * 4) / 3), pattern: '^[A-Za-z0-9_-]+$' } },
  }),
  record: validator<{ rev: number; epoch: number; record: string }>({
    type: 'object', additionalProperties: false, required: ['rev', 'epoch', 'record'],
    properties: {
      rev: { type: 'integer', minimum: 1, maximum: 1_000_000 },
      epoch: { type: 'integer', minimum: 0, maximum: DOCS.maxEpoch },
      record: { type: 'string', minLength: 64, maxLength: DOCS.recordMaxChars, pattern: '^[A-Za-z0-9_-]+$' },
    },
  }),
} as const;

const SEQ = /^(0|[1-9][0-9]{0,15})$/;
const CHUNK_NO = /^(?:[0-9]|1[0-5])$/;

/** 문서함 경로. auth는 기기 범위 토큰(share)과 기기당 한도를 본다(app.ts가 준다). */
export function addDocRoutes(r: Router, o: { docs: DocBox; auth: (ctx: Ctx, kind: 'r' | 'w') => Promise<DocCaller> }): void {
  const { docs } = o;
  const id = (ctx: Ctx) => V.id({ id: ctx.params.id }).id;
  const chunkNo = (ctx: Ctx) => {
    const raw = ctx.params.n ?? '';
    if (!CHUNK_NO.test(raw)) fail('request.param_rejected');
    return Number(raw);
  };
  const noQuery = (ctx: Ctx) => {
    if ([...ctx.query.keys()].length) fail('request.param_rejected');
  };
  r.add('POST', '/v1/docs/:id', async (ctx) => json(200, await docs.start(await o.auth(ctx, 'w'), id(ctx), V.start(ctx.body))));
  r.add(
    'PUT',
    '/v1/docs/:id/chunks/:n',
    async (ctx) => {
      const c = await o.auth(ctx, 'w');
      await docs.putChunk(c, id(ctx), chunkNo(ctx), Buffer.from(V.chunk(ctx.body).data, 'base64url'));
      return json(204, undefined);
    },
    { maxBodyBytes: DOCS.chunkBodyMaxBytes },
  );
  r.add('PUT', '/v1/docs/:id/record', async (ctx) => json(200, await docs.putRecord(await o.auth(ctx, 'w'), id(ctx), V.record(ctx.body))));
  const listFrom = async (ctx: Ctx, raw: string) => {
    const c = await o.auth(ctx, 'r');
    noQuery(ctx);
    if (!SEQ.test(raw)) fail('request.param_rejected');
    return json(200, await docs.list(c.accountId, Number(raw)));
  };
  r.add('GET', '/v1/docs', (ctx) => listFrom(ctx, '0'));
  r.add('GET', '/v1/docs/after/:seq', (ctx) => listFrom(ctx, ctx.params.seq ?? ''));
  r.add('GET', '/v1/docs/:id/chunks/:n', async (ctx) => {
    const c = await o.auth(ctx, 'r');
    noQuery(ctx);
    return json(200, { data: Buffer.from(await docs.getChunk(c.accountId, id(ctx), chunkNo(ctx))).toString('base64url') });
  });
  r.add('DELETE', '/v1/docs/:id', async (ctx) => {
    await docs.remove(await o.auth(ctx, 'w'), id(ctx));
    return json(204, undefined);
  });
}
