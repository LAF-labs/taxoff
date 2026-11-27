import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { it } from 'node:test';
import { openDatabase } from '@sax/db';
import { MOVED, STAYS } from '@sax/engine';

it('ADR-055 결정 2: 스키마의 모든 테이블이 옮김 또는 안 옮김 한쪽에만 적혀 있고, 적은 칸은 실제로 있다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-move-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), randomBytes(32));
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all() as string[];
    const moved = new Set(MOVED.map((t) => t.table));
    for (const t of tables) assert.ok(moved.has(t) !== Object.hasOwn(STAYS, t), `${t}: 옮김과 안 옮김 중 정확히 한쪽에 적는다`);
    for (const t of [...moved, ...Object.keys(STAYS)]) assert.ok(tables.includes(t), `${t}: 스키마에 없다`);
    for (const t of MOVED) {
      const cols = new Set((db.prepare(`PRAGMA table_info(${t.table})`).all() as Array<{ name: string }>).map((c) => c.name));
      const named = [...Object.keys(t.refs ?? {}), ...t.match.flat(), ...(t.sealed ?? []), ...(t.clear ?? []), ...Object.keys(t.reset ?? {}), ...(t.docIdsJson ?? []), ...(t.as ? [t.as.col] : []), ...(t.owner ? [t.owner] : []), ...(t.counterHmac ? [t.counterHmac] : []), ...(t.accountHmac ? [t.accountHmac.col, t.accountHmac.from] : []), ...(t.autoSeq ? [t.autoSeq.col, ...t.autoSeq.self] : [])];
      for (const c of named) assert.ok(cols.has(c), `${t.table}.${c}: 칸이 없다`);
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
