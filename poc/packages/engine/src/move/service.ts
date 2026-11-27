import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS, type ColumnCipher, type Db } from '@sax/db';
import { MOVED, MOVED_SETTING, type MoveRef, type MovedTable } from './tables.ts';

export const MOVE_SCHEMA = Math.max(...MIGRATIONS.map((m) => m.version));
export const MOVE_FILES_MAX_BYTES = 500 * 1024 * 1024;
const RECEIVED_KEY = 'pc_move.received';
const REC = { header: 1, file: 2, rows: 3, end: 9 } as const;
const ROWS_PER_RECORD = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COUNTER = '$counter';

type Row = Record<string, unknown>;

export class MoveError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new MoveError(code);
};

export interface MoveBundle {
  file: string;
  schema: number;
  bytes: number;
  sha256: string;
  counts: Record<string, number>;
}

export type MoveImportResult = { state: 'stored'; counts: Record<string, number> } | { state: 'refused'; reason: 'schema_newer' | 'bad_bundle' | 'import_failed' };

interface Header {
  v: 1;
  schema: number;
  profiles: Row[];
}

export interface MoveServiceOptions {
  vaultDir: string;
  stagingDir: string;
  accountHmac: (digits: string) => string;
  now?: () => Date;
}

const digitsOnly = (v: string) => v.replace(/\D/g, '');

export class MoveService {
  private readonly db: Db;
  private readonly cipher: ColumnCipher;
  private readonly o: MoveServiceOptions;

  constructor(db: Db, cipher: ColumnCipher, o: MoveServiceOptions) {
    this.db = db;
    this.cipher = cipher;
    this.o = o;
  }

  async handle(method: string, p: Row = {}): Promise<unknown> {
    switch (method) {
      case 'move.export':
        return this.export();
      case 'move.import':
        return this.import(this.stagedFile(p.file));
      case 'move.discard':
        await fs.promises.rm(this.stagedFile(p.file), { force: true });
        return { ok: true };
      case 'db.query.move.received':
        return { at: this.received() };
      default:
        return fail('move.unknown_method');
    }
  }

  received(): string | null {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(RECEIVED_KEY) as string | undefined;
    return v ? (JSON.parse(v) as { at: string }).at : null;
  }

  private stagedFile(f: unknown): string {
    if (typeof f !== 'string' || path.dirname(path.resolve(f)) !== path.resolve(this.o.stagingDir) || !/^move-[0-9a-f]{16}\.bin$/.test(path.basename(f))) return fail('move.bad_file');
    return path.resolve(f);
  }

  newStagedFile(): string {
    return path.join(this.o.stagingDir, `move-${randomBytes(8).toString('hex')}.bin`);
  }

  async export(): Promise<MoveBundle> {
    const snap = this.snapshot();
    await fs.promises.mkdir(this.o.stagingDir, { recursive: true, mode: 0o700 });
    const file = this.newStagedFile();
    const fh = await fs.promises.open(file, 'wx', 0o600);
    const hash = createHash('sha256');
    let bytes = 0;
    const put = async (kind: number, payload: Uint8Array) => {
      const head = Buffer.alloc(5);
      head[0] = kind;
      head.writeUInt32BE(payload.length, 1);
      for (const b of [head, payload]) {
        await fh.write(b);
        hash.update(b);
        bytes += b.length;
      }
    };
    const json = (v: unknown) => Buffer.from(JSON.stringify(v), 'utf8');
    try {
      await put(REC.header, json({ v: 1, schema: MOVE_SCHEMA, profiles: snap.profiles } satisfies Header));
      for (const d of snap.files) await put(REC.file, Buffer.concat([Buffer.from(d.id, 'ascii'), await fs.promises.readFile(d.path)]));
      for (const [table, rows] of snap.rows) for (let i = 0; i < rows.length; i += ROWS_PER_RECORD) await put(REC.rows, json({ t: table, rows: rows.slice(i, i + ROWS_PER_RECORD) }));
      await put(REC.end, json({ counts: snap.counts }));
      await fh.sync();
    } catch (e) {
      await fh.close();
      await fs.promises.rm(file, { force: true });
      throw e;
    }
    await fh.close();
    return { file, schema: MOVE_SCHEMA, bytes, sha256: hash.digest('hex'), counts: snap.counts };
  }

  private snapshot(): { profiles: Row[]; files: Array<{ id: string; path: string }>; rows: Array<[string, Row[]]>; counts: Record<string, number> } {
    return this.db.transaction(() => {
      const profiles = this.db.prepare('SELECT * FROM profiles').all() as Row[];
      const numbers = new Map<string, string>();
      for (const t of ['bank_accounts', 'cp_bank_accounts']) {
        for (const r of this.db.prepare(`SELECT id, number_enc FROM ${t}`).all() as Row[]) {
          const d = this.cipher.open(r.number_enc as Uint8Array, `${t}.number_enc:${String(r.id)}`);
          numbers.set(this.o.accountHmac(d), d);
        }
      }
      const docs = this.db.prepare('SELECT id, path, bytes FROM documents ORDER BY created_at DESC').all() as Array<{ id: string; path: string; bytes: number }>;
      const files: Array<{ id: string; path: string }> = [];
      let total = 0;
      let left = 0;
      for (const d of docs) {
        const size = fileSize(d.path);
        if (size === null || size !== d.bytes || total + size > MOVE_FILES_MAX_BYTES || !UUID.test(d.id)) {
          left++;
          continue;
        }
        total += size;
        files.push({ id: d.id, path: d.path });
      }
      const sent = new Set(files.map((f) => f.id));
      const rows: Array<[string, Row[]]> = [];
      const counts: Record<string, number> = {};
      for (const t of MOVED) {
        const sql = `SELECT * FROM ${t.table}${t.where ? ` WHERE ${t.where}` : ''}${t.order ? ` ORDER BY ${t.order}` : ''}`;
        let list = (this.db.prepare(sql).all() as Row[]).map((r) => this.outRow(t, r, numbers));
        if (t.table === 'documents') list = list.filter((r) => sent.has(String(r.id)));
        rows.push([t.table, list]);
        if (list.length) counts[t.table] = list.length;
      }
      const settings = (this.db.prepare('SELECT key, value_json FROM settings').all() as Row[]).filter((r) => MOVED_SETTING.test(String(r.key)));
      rows.push(['settings', settings]);
      if (settings.length) counts.settings = settings.length;
      if (left) counts.documents_left = left;
      return { profiles, files, rows, counts };
    })();
  }

  private outRow(t: MovedTable, r: Row, numbers: Map<string, string>): Row {
    const out: Row = { ...r };
    for (const c of t.sealed ?? []) if (out[c] != null) out[c] = this.cipher.open(out[c] as Uint8Array, `${t.table}.${c}:${String(r.id)}`);
    if (t.accountHmac) delete out[t.accountHmac.col];
    if (t.counterHmac) {
      out[COUNTER] = out[t.counterHmac] ? (numbers.get(String(out[t.counterHmac])) ?? null) : null;
      delete out[t.counterHmac];
    }
    for (const c of t.clear ?? []) out[c] = null;
    for (const [k, v] of Object.entries(out)) if (v instanceof Uint8Array) fail(`move.blob_column:${t.table}.${k}`);
    return out;
  }

  async import(file: string): Promise<MoveImportResult> {
    const dir = path.join(this.o.stagingDir, `in-${randomBytes(8).toString('hex')}`);
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    try {
      const read = await this.readBundle(file, dir);
      if (read === 'schema_newer' || read === 'bad_bundle') return { state: 'refused', reason: read };
      try {
        return { state: 'stored', counts: this.apply(read.header, read.rows, dir) };
      } catch {
        return { state: 'refused', reason: 'import_failed' };
      }
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
      await fs.promises.rm(file, { force: true });
    }
  }

  private async readBundle(file: string, dir: string): Promise<{ header: Header; rows: Map<string, Row[]> } | 'schema_newer' | 'bad_bundle'> {
    const fh = await fs.promises.open(file, 'r');
    try {
      const size = (await fh.stat()).size;
      let pos = 0;
      const take = async (n: number): Promise<Buffer> => {
        if (pos + n > size) throw new MoveError('move.truncated');
        const b = Buffer.alloc(n);
        await fh.read(b, 0, n, pos);
        pos += n;
        return b;
      };
      let header: Header | null = null;
      const rows = new Map<string, Row[]>();
      for (;;) {
        const head = await take(5);
        const body = await take(head.readUInt32BE(1));
        const kind = head[0];
        if (kind === REC.header) {
          const h = JSON.parse(body.toString('utf8')) as Header;
          if (h.v !== 1 || !Number.isSafeInteger(h.schema) || !Array.isArray(h.profiles)) return 'bad_bundle';
          if (h.schema > MOVE_SCHEMA) return 'schema_newer';
          header = h;
        } else if (!header) {
          return 'bad_bundle';
        } else if (kind === REC.file) {
          const id = body.subarray(0, 36).toString('ascii');
          if (!UUID.test(id)) return 'bad_bundle';
          await fs.promises.writeFile(path.join(dir, id), body.subarray(36), { mode: 0o600 });
        } else if (kind === REC.rows) {
          const r = JSON.parse(body.toString('utf8')) as { t: string; rows: Row[] };
          if (typeof r.t !== 'string' || !Array.isArray(r.rows)) return 'bad_bundle';
          rows.set(r.t, [...(rows.get(r.t) ?? []), ...r.rows]);
        } else if (kind === REC.end) {
          return pos === size ? { header, rows } : 'bad_bundle';
        } else {
          return 'bad_bundle';
        }
      }
    } catch {
      return 'bad_bundle';
    } finally {
      await fh.close();
    }
  }

  private apply(header: Header, rows: Map<string, Row[]>, staged: string): Record<string, number> {
    const placed: Array<{ from: string; to: string }> = [];
    try {
      return this.db.transaction(() => {
        const maps = new Map<MoveRef, Map<unknown, unknown>>();
        const mapOf = (r: MoveRef) => maps.get(r) ?? maps.set(r, new Map()).get(r)!;
        const inserted = new Map<MoveRef, Set<unknown>>();
        const counts: Record<string, number> = {};
        const profiles = this.mapProfiles(header.profiles, counts);
        for (const [from, to] of profiles) mapOf('profile').set(from, to);
        for (const t of MOVED) {
          const n = this.applyTable(t, rows.get(t.table) ?? [], { mapOf, inserted, staged, placed });
          if (n) counts[t.table] = n;
        }
        const set = this.db.prepare('INSERT OR IGNORE INTO settings (key, value_json) VALUES (?, ?)');
        let s = 0;
        for (const r of rows.get('settings') ?? []) {
          const m = MOVED_SETTING.exec(String(r.key));
          const pid = m ? profiles.get(m[1]!) : undefined;
          if (m && pid) s += set.run(`profile.${pid}.${m[2]}`, String(r.value_json)).changes;
        }
        if (s) counts.settings = s;
        this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(RECEIVED_KEY, JSON.stringify({ at: (this.o.now?.() ?? new Date()).toISOString() }));
        return counts;
      })();
    } catch (e) {
      for (const p of placed.reverse()) {
        try {
          fs.renameSync(p.to, p.from);
        } catch {
          fs.rmSync(p.to, { force: true });
        }
      }
      throw e;
    }
  }

  private mapProfiles(old: Row[], counts: Record<string, number>): Map<string, string> {
    const out = new Map<string, string>();
    const cols = this.columns('profiles');
    for (const p of old) {
      const mine = this.db.prepare('SELECT id, biz_no FROM profiles WHERE kind = ?').get(p.kind) as { id: string; biz_no: string | null } | undefined;
      if (!mine) {
        const r: Row = { ...p, slot_token: null, biz_bound_at: null };
        const keys = Object.keys(r).filter((k) => cols.has(k));
        this.db.prepare(`INSERT INTO profiles (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => r[k]));
        out.set(String(p.id), String(p.id));
        continue;
      }
      const a = p.biz_no ? digitsOnly(String(p.biz_no)) : '';
      const b = mine.biz_no ? digitsOnly(mine.biz_no) : '';
      if (a && b && a !== b) counts.profiles_skipped = (counts.profiles_skipped ?? 0) + 1;
      else out.set(String(p.id), mine.id);
    }
    return out;
  }

  private columns(table: string): Map<string, { notnull: boolean }> {
    return new Map((this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; notnull: number; pk: number }>).map((c) => [c.name, { notnull: c.notnull === 1 || c.pk > 0 }]));
  }

  private applyTable(
    t: MovedTable,
    rows: Row[],
    ctx: { mapOf: (r: MoveRef) => Map<unknown, unknown>; inserted: Map<MoveRef, Set<unknown>>; staged: string; placed: Array<{ from: string; to: string }> },
  ): number {
    const cols = this.columns(t.table);
    const seqMap = new Map<unknown, unknown>();
    let n = 0;
    next: for (const src of rows) {
      const r: Row = { ...src };
      for (const [col, ref] of Object.entries(t.refs ?? {})) {
        if (r[col] == null) continue;
        const to = ctx.mapOf(ref).get(r[col]);
        if (to !== undefined) r[col] = to;
        else if (cols.get(col)?.notnull) continue next;
        else r[col] = null;
      }
      if (t.owner && r[t.owner] != null && !ctx.inserted.get(t.refs![t.owner]!)?.has(r[t.owner])) continue;
      for (const c of t.clear ?? []) r[c] = null;
      Object.assign(r, t.reset ?? {});
      for (const c of t.docIdsJson ?? []) {
        const ids = typeof r[c] === 'string' ? (JSON.parse(r[c] as string) as unknown[]) : [];
        r[c] = JSON.stringify(ids.map((id) => ctx.mapOf('document').get(id)).filter((id) => id !== undefined));
      }
      if (t.accountHmac) r[t.accountHmac.col] = this.o.accountHmac(String(r[t.accountHmac.from]));
      if (t.counterHmac) {
        const d = r[COUNTER];
        r[t.counterHmac] = typeof d === 'string' ? this.o.accountHmac(d) : null;
        delete r[COUNTER];
      }
      for (const c of t.sealed ?? []) if (r[c] != null) r[c] = this.cipher.seal(String(r[c]), `${t.table}.${c}:${String(r.id)}`);
      let oldSeq: unknown;
      if (t.autoSeq) {
        oldSeq = r[t.autoSeq.col];
        delete r[t.autoSeq.col];
        for (const s of t.autoSeq.self) r[s] = r[s] == null ? null : (seqMap.get(r[s]) ?? null);
      }
      const found = this.existing(t, r);
      if (found !== undefined) {
        if (t.as) ctx.mapOf(t.as.ref).set(src[t.as.col], found);
        continue;
      }
      if (t.table === 'documents') {
        const from = path.join(ctx.staged, String(r.id));
        if (!fs.existsSync(from)) continue;
        const to = freeName(this.o.vaultDir, String(r.path).split(/[\\/]/).pop() || `${String(r.id)}.bin`);
        fs.mkdirSync(this.o.vaultDir, { recursive: true, mode: 0o700 });
        fs.renameSync(from, to);
        ctx.placed.push({ from, to });
        r.path = to;
      }
      const keys = Object.keys(r).filter((k) => cols.has(k));
      const info = this.db.prepare(`INSERT OR IGNORE INTO ${t.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map((k) => r[k]));
      if (!info.changes) continue;
      n++;
      if (t.autoSeq) seqMap.set(oldSeq, info.lastInsertRowid);
      if (t.as) {
        ctx.mapOf(t.as.ref).set(src[t.as.col], r[t.as.col]);
        (ctx.inserted.get(t.as.ref) ?? ctx.inserted.set(t.as.ref, new Set()).get(t.as.ref)!).add(r[t.as.col]);
      }
    }
    return n;
  }

  private existing(t: MovedTable, r: Row): unknown {
    for (const key of t.match) {
      if (key.some((k) => r[k] == null)) continue;
      const hit = this.db.prepare(`SELECT ${t.as?.col ?? 'rowid'} AS v FROM ${t.table} WHERE ${key.map((k) => `${k} = ?`).join(' AND ')} LIMIT 1`).get(...key.map((k) => r[k])) as { v: unknown } | undefined;
      if (hit) return hit.v;
    }
    return undefined;
  }
}

function fileSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function freeName(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 0; ; i++) {
    const p = path.join(dir, i ? `${stem}_${i + 1}${ext}` : name);
    if (!fs.existsSync(p)) return p;
  }
}
