import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { EventLog } from '@sax/platform';
import type { TargetState } from '../relay/relay.ts';
import { buildSheet, checkSheet } from './hometax-sheet.ts';

type Json = Record<string, unknown>;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UPLOAD_NAME_RE = /^[0-9a-f]{32}\.xlsx$/;
/** 올린 파일을 지우는 때. 홈택스는 [엑셀파일 변환하기]를 누를 때 파일을 읽으니 변환이 끝날 만큼은 둔다. run.end에서도 지운다. */
export const UPLOAD_KEEP_MS = 10 * 60_000;

/**
 * 일괄발급 화면 표시(ADR-063). 금고는 이 화면에서만 파일 칸을 채우고 표를 읽는다. 홈택스(일괄 작성 UTEETBAA77)는
 * WebSquare 표 `mf_txppWframe_grdBndlEtxivIsn`가 있는 문서다(2026-11-24 실측). 시험용 가짜 홈택스도 같은 id를 쓴다.
 */
export const BULK_GRID_ID = 'mf_txppWframe_grdBndlEtxivIsn';

/** 변환 목록에서 읽는 열(실측 열 id). 값은 글자 모양만 검사해 넘긴다. */
export const GRID_COLUMNS = ['chk', 'wrtDt', 'dmnrTxprDscmNo', 'dmnrTnmNm', 'dmnrRprsFnm', 'splCft', 'txamt', 'apprvNo', 'recApeClCd', 'splrTxprDscmNo'] as const;
export const GRID_ROWS_MAX = 100;

/**
 * 표 읽기 고정 스크립트. 화면 함수($p)로 행 수와 칸 값을 읽는다(칸 DOM은 빈 행까지 미리 그려져 있어 건수와 다르다, 실측).
 * 반환: {ok:true, total, rows:[{chk, disabled, ...열}]} 또는 {ok:false, reason}. 스크립트는 엔진과 패키지가 바꿀 수 없다.
 */
export const GRID_READ_SCRIPT = `((gridId, cols, maxRows) => {
  try {
    if (!document.getElementById(gridId)) return { ok: false, reason: 'not_bulk_screen' };
    const g = window.$p && typeof window.$p.getComponentById === 'function' ? window.$p.getComponentById(gridId) : null;
    if (!g || typeof g.getRowCount !== 'function' || typeof g.getCellData !== 'function') return { ok: false, reason: 'grid_unreadable' };
    const n = Number(g.getRowCount());
    if (!Number.isSafeInteger(n) || n < 0 || n > maxRows) return { ok: false, reason: 'grid_too_many' };
    const checked = new Set(typeof g.getCheckedIndex === 'function' ? [].concat(g.getCheckedIndex('chk') || []).map(Number) : []);
    const rows = [];
    for (let r = 0; r < n; r++) {
      const row = { checked: checked.has(r), disabled: false };
      for (const c of cols) { const v = g.getCellData(r, c); row[c] = v === null || v === undefined ? '' : String(v).slice(0, 120); }
      const box = document.getElementById('G_' + gridId + '___checkbox_chk_' + r);
      row.disabled = !!(box && box.disabled);
      rows.push(row);
    }
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, reason: 'grid_unreadable' };
  }
})`;

export interface BulkSheetOptions {
  dir: string;
  log: EventLog;
  send: <T = Json>(method: string, params: Json, sessionId?: string) => Promise<T>;
  exposed: (targetId: string) => TargetState | undefined;
  keepMs?: number;
}

export type BulkUploadResult = { ok: true; rows: number; sha256: string } | { ok: false; reason: string; row?: number };
export type GridRow = { checked: boolean; disabled: boolean } & Record<(typeof GRID_COLUMNS)[number], string>;
export type BulkGridResult = { ok: true; rows: GridRow[] } | { ok: false; reason: string };

// eslint-disable-next-line no-control-regex -- 표 칸에 제어 문자가 있으면 읽지 않는다
const CELL = /^[^\u0000-\u001f\u007f]{0,120}$/;

/**
 * 홈택스 일괄발급 파일 넣기와 변환 목록 읽기(ADR-063). 엔진의 `DOM.setFileInputFiles`는 중계가 계속 거부한다(D05 §3.3).
 * 금고는 엔진이 넘긴 묶음을 다시 검사해 고정 모양 xlsx를 자기 폴더에 만들고, 그 파일 하나만 일괄발급 화면의 파일 칸에 넣는다.
 * 사용자 파일이나 다른 경로는 넣지 않는다.
 */
export class BulkSheet {
  private readonly o: BulkSheetOptions;
  private readonly files = new Map<string, { file: string; timer: NodeJS.Timeout }>();
  private busy = false;

  constructor(o: BulkSheetOptions) {
    this.o = o;
  }

  async init(): Promise<void> {
    await fs.mkdir(this.o.dir, { recursive: true, mode: 0o700 });
    for (const name of await fs.readdir(this.o.dir).catch(() => [] as string[])) {
      if (UPLOAD_NAME_RE.test(name)) await fs.rm(path.join(this.o.dir, name), { force: true }).catch(() => {});
    }
  }

  private refuse(reason: string, row?: number): BulkUploadResult {
    this.o.log.event('vault.bulk_refused', { reason, ...(row ? { row } : {}) });
    return { ok: false, reason, ...(row ? { row } : {}) };
  }

  private target(p: Json): TargetState | string {
    if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId) || typeof p.targetId !== 'string' || !TARGET_ID_RE.test(p.targetId)) return 'bad_params';
    const t = this.o.exposed(p.targetId);
    if (!t) return 'target_not_exposed';
    if (t.win) return 'secret_window_open';
    return t;
  }

  /** `bulk.upload {runId, targetId, sheet:{supplier, rows}}`. */
  async upload(p: Json): Promise<BulkUploadResult> {
    const t = this.target(p);
    if (typeof t === 'string') return this.refuse(t);
    const c = checkSheet(p.sheet);
    if (!c.ok) return this.refuse(c.code, c.row);
    if (this.busy) return this.refuse('busy');
    this.busy = true;
    try {
      const sid = t.vaultSession;
      const doc = await this.o.send<{ root?: { nodeId?: number } }>('DOM.getDocument', { depth: 0 }, sid);
      const root = doc.root?.nodeId;
      if (typeof root !== 'number') return this.refuse('not_bulk_screen');
      const grid = await this.o.send<{ nodeId?: number }>('DOM.querySelector', { nodeId: root, selector: `#${BULK_GRID_ID}` }, sid);
      if (!grid.nodeId) return this.refuse('not_bulk_screen');
      const inputs = await this.o.send<{ nodeIds?: number[] }>('DOM.querySelectorAll', { nodeId: root, selector: 'input[type=file]' }, sid);
      if (inputs.nodeIds?.length !== 1) return this.refuse(inputs.nodeIds?.length ? 'file_input_ambiguous' : 'file_input_missing');
      const bytes = buildSheet(c.spec);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const file = path.join(this.o.dir, `${randomBytes(16).toString('hex')}.xlsx`);
      await fs.writeFile(file, bytes, { mode: 0o600, flag: 'wx' });
      this.keep(String(p.runId), file);
      await this.o.send('DOM.setFileInputFiles', { files: [file], nodeId: inputs.nodeIds[0] }, sid);
      this.o.log.event('vault.bulk_uploaded', { rows: c.spec.rows.length, bytes: bytes.length });
      return { ok: true, rows: c.spec.rows.length, sha256 };
    } catch {
      return this.refuse('upload_failed');
    } finally {
      this.busy = false;
    }
  }

  /** `bulk.readGrid {runId, targetId}`: 변환 목록(체크, 비활성, 열 값). */
  async readGrid(p: Json): Promise<BulkGridResult> {
    const t = this.target(p);
    if (typeof t === 'string') return { ok: false, reason: t };
    let out: { ok?: unknown; rows?: unknown; reason?: unknown } | undefined;
    try {
      const r = await this.o.send<{ result?: { value?: typeof out }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression: `${GRID_READ_SCRIPT}(${JSON.stringify(BULK_GRID_ID)}, ${JSON.stringify(GRID_COLUMNS)}, ${GRID_ROWS_MAX})`, returnByValue: true, userGesture: false, timeout: 10_000,
      }, t.vaultSession);
      out = r.exceptionDetails ? undefined : r.result?.value;
    } catch {
      out = undefined;
    }
    if (!out || out.ok !== true || !Array.isArray(out.rows)) {
      const reason = typeof out?.reason === 'string' && /^[a-z_]{1,40}$/.test(out.reason) ? out.reason : 'grid_unreadable';
      return { ok: false, reason };
    }
    const rows: GridRow[] = [];
    for (const x of out.rows as Json[]) {
      const row = { checked: x.checked === true, disabled: x.disabled === true } as GridRow;
      for (const c of GRID_COLUMNS) {
        const v = typeof x[c] === 'string' ? (x[c] as string) : '';
        if (!CELL.test(v)) return { ok: false, reason: 'grid_unreadable' };
        row[c] = v;
      }
      rows.push(row);
    }
    return { ok: true, rows };
  }

  private keep(runId: string, file: string): void {
    const timer = setTimeout(() => void this.drop(runId, file), this.o.keepMs ?? UPLOAD_KEEP_MS);
    timer.unref?.();
    this.files.set(`${runId}|${file}`, { file, timer });
  }

  private async drop(runId: string, file: string): Promise<void> {
    const k = `${runId}|${file}`;
    const f = this.files.get(k);
    if (f) clearTimeout(f.timer);
    this.files.delete(k);
    await fs.rm(file, { force: true }).catch(() => {});
  }

  /** run.end: 그 실행이 올린 파일을 지운다. */
  async endRun(runId: string): Promise<void> {
    for (const [k, f] of [...this.files]) if (k.startsWith(`${runId}|`)) await this.drop(runId, f.file);
  }

  shutdown(): void {
    for (const f of this.files.values()) {
      clearTimeout(f.timer);
      void fs.rm(f.file, { force: true }).catch(() => {});
    }
    this.files.clear();
  }
}
