import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readRegularFile, type EventLog } from '@sax/platform';
import {
  DOWNLOAD_ARM_TTL_MS, ORIGINAL_VIEWER_WAIT_MS, PDF_MAX_BYTES, type DownloadArmParams, type DownloadArmResult, type DownloadFailReason, type PdfOriginalParams, type PdfPrintParams,
  type PdfPrintResult,
} from '../protocol.ts';
import type { TargetState } from '../relay/relay.ts';

type Json = Record<string, unknown>;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const GUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
/** fileId: 128비트 무작위 hex. staging 파일 이름은 `<fileId>.pdf`. */
export const PDF_FILE_ID_RE = /^[0-9a-f]{32}$/;
const STAGED_NAME_RE = /^[0-9a-f]{32}\.pdf$/;
const IO_CHUNK = 1024 * 1024;
/**
 * 받는 중인 다운로드가 이만큼 아무 진행 이벤트 없이 멈추면 취소하고 canceled로 끝낸다. 끝 이벤트가 끝내 오지 않으면
 * 그 다운로드가 "받는 중"으로 남아 금고 세션 동안 다음 무장이 모두 already_armed가 된다. 진행 이벤트마다 다시 센다.
 */
export const DOWNLOAD_STALL_MS = 60_000;
/**
 * staging을 다시 쓰는 간격(누적 약 46초). 다운로드가 끝난 뒤와, 정리가 파일을 못 지웠을 때 돈다. Windows는 Chrome이 막 놓은 파일을
 * 백신 검사 등으로 몇 초씩 잡고 있고(EBUSY·EPERM), 끝난 파일을 끝 이벤트 뒤에 놓기도 해 한 번 쓸어서는 남는다(WIN-REALDEVICE §10.1).
 */
export const STAGING_RESWEEP_MS: readonly number[] = [500, 1_500, 4_000, 10_000, 30_000];

/** staging 정리의 파일 삭제. 시험이 Windows 잠금을 흉내 내려고 바꾼다. */
export type StagingRemove = (file: string) => Promise<void>;
const removeStaged: StagingRemove = (file) => fs.rm(file, { force: true, recursive: true, maxRetries: process.platform === 'win32' ? 10 : 0, retryDelay: 100 });

/**
 * staging에서 금고가 쓴 `<32hex>.pdf` 말고 모두 지운다(Chrome 중간 파일 `*.crdownload`, 끝난 guid 파일, 그 밖의 것).
 * `stop()`이 참이 되면 그 자리에서 멈춘다(받는 중인 다운로드의 중간 파일은 건드리지 않는다). 이름은 돌려주지 않는다(개수만, ⑦).
 */
export async function sweepStagingDir(staging: string, o: { remove?: StagingRemove; stop?: () => boolean } = {}): Promise<{ removed: number; left: number; stopped: boolean }> {
  const remove = o.remove ?? removeStaged;
  const names = await fs.readdir(staging).catch(() => [] as string[]);
  let removed = 0;
  let left = 0;
  for (const name of names) {
    if (STAGED_NAME_RE.test(name)) continue;
    if (o.stop?.()) return { removed, left, stopped: true };
    const ok = await remove(path.join(staging, name)).then(() => true, () => false);
    if (ok) removed++;
    else left++;
  }
  return { removed, left, stopped: false };
}

/** staging 안 fileId의 파일 경로(엔진 문서 가져오기도 이것으로 찾는다). 모양이 틀린 id는 거부한다. */
export function stagedPdfPath(staging: string, fileId: string): string {
  if (!PDF_FILE_ID_RE.test(fileId)) throw new Error('bad_file_id');
  return path.join(staging, `${fileId}.pdf`);
}

/**
 * PDF 형식 검사(MIME은 내용으로 정한다: 서버 Content-Type·파일 이름은 믿지 않는다).
 * 첫 바이트가 `%PDF-1.`·`%PDF-2.`이고, 끝 1024바이트 안에 `%%EOF`가 있어야 한다(잘린 파일 거부).
 */
export function checkPdfBytes(bytes: Uint8Array, maxBytes = PDF_MAX_BYTES): 'ok' | 'empty' | 'too_large' | 'not_pdf' {
  if (bytes.length === 0) return 'empty';
  if (bytes.length > maxBytes) return 'too_large';
  const head = Buffer.from(bytes.subarray(0, 8)).toString('latin1');
  if (!/^%PDF-[12]\.\d/.test(head)) return 'not_pdf';
  const tail = Buffer.from(bytes.subarray(Math.max(0, bytes.length - 1024))).toString('latin1');
  if (!tail.includes('%%EOF')) return 'not_pdf';
  return 'ok';
}

/**
 * 원본 서류 뷰어(ADR-062). 홈택스 민원증명 [출력] → 「예」가 여는 ClipReport4 뷰어 창이다. 그 창은 이미 노출된 포털 탭이 연 팝업이라
 * 포털 도메인(*.hometax.go.kr) 검사를 통과했고, 여기서는 경로만 본다.
 */
export function isOriginalViewer(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.hostname === '127.0.0.1' ? u.pathname === '/serp/clipreport.do' : false;
  } catch {
    return false;
  }
}

/**
 * 뷰어 창에서 원본 PDF를 받는 고정 스크립트. 뷰어가 인쇄 때 보내는 요청(ClipID=R08, 실측 2026-11-24)과 같은 것을 같은 창에서 보낸다.
 * 리포트 키와 쪽수는 뷰어의 m_reportHashMap(ClipReport4 clipreport.js에서는 함수 객체, 값은 Report: m_uid, getTotalPageCount())에서 읽는다. 결과는 {ok, b64} 또는 {ok:false, reason}. 바이트 상한은 인자.
 */
export const ORIGINAL_VIEWER_SCRIPT = `(async (maxBytes, waitMs) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const KEY = /^[\x21-\x7e]{16,64}$/;
  const report = () => {
    const m = window.m_reportHashMap;
    if (!m || (typeof m !== 'object' && typeof m !== 'function')) return null;
    for (const k of Object.keys(m)) {
      const v = m[k];
      if (!v || typeof v !== 'object') continue;
      const uid = [v.m_uid, k].find((x) => typeof x === 'string' && KEY.test(x));
      if (!uid) continue;
      let pages = Number(v.m_pageCount);
      try {
        if (typeof v.getTotalPageCount === 'function') pages = Number(v.getTotalPageCount());
      } catch {}
      return { uid, pages: Number.isSafeInteger(pages) && pages >= 1 && pages <= 500 ? pages : 0 };
    }
    return null;
  };
  let r = null;
  for (const until = Date.now() + waitMs; !(r = report()) || !r.pages; ) {
    if (Date.now() > until) break;
    await sleep(250);
  }
  if (!r) return { ok: false, reason: 'viewer_not_ready' };
  const body = new URLSearchParams({
    ClipID: 'R08', uid: r.uid, clipUID: r.uid, print: 'print', isPDFPrintImage: 'false', isPDFPrintBarcodeAWT: 'false', path: '/serp',
    optionValue: JSON.stringify({ drawDashedLineDirectly: true, startNum: 1, endNum: r.pages || 1 }), isChromePrintFitToPage: 'false', s_time: String(Date.now()),
  });
  let res;
  try {
    res = await fetch('/serp/ClipReport4/ClipAndMarkAny.jsp', { method: 'POST', body, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    return { ok: false, reason: 'viewer_failed' };
  }
  if (!res.ok) return { ok: false, reason: 'viewer_failed' };
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > maxBytes) return { ok: false, reason: 'too_large' };
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { ok: true, b64: btoa(bin), pagesKnown: r.pages > 0 };
})`;

export interface PdfSaverOptions {
  staging: string;
  log: EventLog;
  send: <T = Json>(method: string, params: Json, sessionId?: string) => Promise<T>;
  exposed: (targetId: string) => TargetState | undefined;
  /** 노출된 targetId가 연 팝업 중 노출된 것(먼저 연 것부터). pdf.original이 뷰어 창을 찾는다. */
  popupsOf?: (openerId: string) => TargetState[];
  viewerWaitMs?: number;
  scrub?: (t: TargetState) => Promise<boolean>;
  emit: (name: 'download.completed' | 'download.failed', data: Record<string, unknown>) => void;
  maxBytes?: number;
  armTtlMs?: number;
  stallMs?: number;
  resweepMs?: readonly number[];
  remove?: StagingRemove;
}

interface Armed {
  runId: string;
  targetId: string;
  timer: NodeJS.Timeout;
}

interface Active {
  targetId: string;
  tooLarge: boolean;
  stall: NodeJS.Timeout;
}

export class PdfSaver {
  private readonly o: PdfSaverOptions;
  private readonly max: number;
  private armed: Armed | null = null;
  private readonly active = new Map<string, Active>();
  private readonly rejected = new Set<string>();
  private printing = false;
  private closed = false;
  private sweeping: Promise<void> = Promise.resolve();
  private events: Promise<void> = Promise.resolve();
  private resweep: { timer: NodeJS.Timeout | null; step: number } = { timer: null, step: 0 };

  constructor(o: PdfSaverOptions) {
    this.o = o;
    this.max = o.maxBytes ?? PDF_MAX_BYTES;
  }

  async init(): Promise<void> {
    await this.ensureStaging();
    await this.o.send('Browser.setDownloadBehavior', { behavior: 'allowAndName', downloadPath: this.o.staging, eventsEnabled: true });
  }

  shutdown(): void {
    this.closed = true;
    this.rejected.clear();
    if (this.armed) clearTimeout(this.armed.timer);
    this.armed = null;
    for (const d of this.active.values()) clearTimeout(d.stall);
    this.active.clear();
    if (this.resweep.timer) clearTimeout(this.resweep.timer);
    this.resweep.timer = null;
  }

  async print(p: Partial<PdfPrintParams>): Promise<PdfPrintResult> {
    if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId) || typeof p.targetId !== 'string' || !TARGET_ID_RE.test(p.targetId)) return this.refuse('bad_params');
    if (p.landscape !== undefined && typeof p.landscape !== 'boolean') return this.refuse('bad_params');
    const t = this.o.exposed(p.targetId);
    if (!t) return this.refuse('target_not_exposed');
    if (t.win?.phase === 'tainted') await this.o.scrub?.(t);
    if (t.win) return this.refuse('secret_window_open');
    if (this.printing) return this.refuse('busy');
    this.printing = true;
    try {
      let bytes: Uint8Array | 'too_large';
      try {
        bytes = await this.printStream(t.vaultSession, p.landscape === true);
      } catch {
        return this.refuse('print_failed');
      }
      if (bytes === 'too_large') return this.refuse('too_large');
      if (t.win) return this.refuse('secret_window_open');
      const verdict = checkPdfBytes(bytes, this.max);
      if (verdict !== 'ok') return this.refuse(verdict === 'empty' ? 'not_pdf' : verdict);
      const fileId = await this.writeStaged(bytes);
      this.o.log.event('vault.pdf_saved', { via: 'print', bytes: bytes.length });
      this.o.emit('download.completed', { fileId });
      return { ok: true, fileId };
    } finally {
      this.printing = false;
      this.sweepStaging();
    }
  }

  /** 원본 서류 뷰어 창에서 포털이 만든 원본 PDF를 받는다(pdf.original, ADR-062). 받은 뒤 뷰어 창은 닫는다. */
  async original(p: Partial<PdfOriginalParams>): Promise<PdfPrintResult> {
    if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId) || typeof p.targetId !== 'string' || !TARGET_ID_RE.test(p.targetId)) return this.refuse('bad_params', 'original');
    if (!this.o.exposed(p.targetId)) return this.refuse('target_not_exposed', 'original');
    if (this.printing) return this.refuse('busy', 'original');
    this.printing = true;
    try {
      const waitMs = this.o.viewerWaitMs ?? ORIGINAL_VIEWER_WAIT_MS;
      const until = Date.now() + waitMs;
      let v: TargetState | undefined;
      for (;;) {
        v = (this.o.popupsOf?.(p.targetId) ?? []).filter((t) => isOriginalViewer(t.url)).at(-1);
        if (v || Date.now() >= until || this.closed) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!v) return this.refuse('viewer_not_found', 'original');
      if (v.win) return this.refuse('secret_window_open', 'original');
      const left = Math.max(1_000, until - Date.now());
      let out: { ok?: unknown; b64?: unknown; reason?: unknown; pagesKnown?: unknown } | undefined;
      try {
        const r = await this.o.send<{ result?: { value?: typeof out }; exceptionDetails?: unknown }>('Runtime.evaluate', {
          expression: `${ORIGINAL_VIEWER_SCRIPT}(${this.max}, ${left})`, awaitPromise: true, returnByValue: true, userGesture: false, timeout: left + 60_000,
        }, v.vaultSession);
        out = r.exceptionDetails ? undefined : r.result?.value;
      } catch {
        out = undefined;
      }
      if (!out || out.ok !== true || typeof out.b64 !== 'string') {
        const reason = out?.reason === 'viewer_not_ready' || out?.reason === 'too_large' ? out.reason : 'viewer_failed';
        return this.refuse(reason, 'original');
      }
      const bytes = new Uint8Array(Buffer.from(out.b64, 'base64'));
      const verdict = checkPdfBytes(bytes, this.max);
      if (verdict !== 'ok') return this.refuse(verdict === 'empty' ? 'not_pdf' : verdict, 'original');
      const fileId = await this.writeStaged(bytes);
      this.o.log.event('vault.pdf_saved', { via: 'original', bytes: bytes.length, pages: out.pagesKnown === true ? 'known' : 'unknown' });
      this.o.emit('download.completed', { fileId });
      await this.o.send('Target.closeTarget', { targetId: v.targetId }).catch(() => {});
      return { ok: true, fileId };
    } finally {
      this.printing = false;
      this.sweepStaging();
    }
  }

  private async printStream(sid: string, landscape: boolean): Promise<Uint8Array | 'too_large'> {
    const { stream } = await this.o.send<{ stream?: string }>('Page.printToPDF', {
      printBackground: true, preferCSSPageSize: true, landscape, transferMode: 'ReturnAsStream',
    }, sid);
    if (typeof stream !== 'string') throw new Error('no stream');
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for (;;) {
        const r = await this.o.send<{ data: string; eof: boolean; base64Encoded?: boolean }>('IO.read', { handle: stream, size: IO_CHUNK }, sid);
        const c = Buffer.from(r.data ?? '', r.base64Encoded ? 'base64' : 'latin1');
        n += c.length;
        if (n > this.max) return 'too_large';
        chunks.push(c);
        if (r.eof) break;
      }
    } finally {
      await this.o.send('IO.close', { handle: stream }, sid).catch(() => {});
    }
    return new Uint8Array(Buffer.concat(chunks, n));
  }

  arm(p: Partial<DownloadArmParams>): DownloadArmResult {
    if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId) || typeof p.targetId !== 'string' || !TARGET_ID_RE.test(p.targetId)) return this.armRefuse('bad_params');
    if (!this.o.exposed(p.targetId)) return this.armRefuse('target_not_exposed');
    if (this.armed || this.active.size) return this.armRefuse('already_armed');
    const timer = setTimeout(() => {
      if (this.armed?.timer !== timer) return;
      this.armed = null;
      this.fail('expired');
    }, this.o.armTtlMs ?? DOWNLOAD_ARM_TTL_MS);
    timer.unref?.();
    this.armed = { runId: p.runId, targetId: p.targetId, timer };
    this.o.log.event('vault.download_armed');
    return { armed: true };
  }

  disarm(): void {
    if (this.armed) clearTimeout(this.armed.timer);
    this.armed = null;
  }

  onBrowserEvent(method: string, p: Json): Promise<void> {
    const run = this.events.then(() => this.handleBrowserEvent(method, p));
    this.events = run.catch(() => {});
    return run;
  }

  private async handleBrowserEvent(method: string, p: Json): Promise<void> {
    if (this.closed) return;
    const guid = typeof p.guid === 'string' && GUID_RE.test(p.guid) ? p.guid : null;
    if (!guid) return;
    if (method === 'Browser.downloadWillBegin') {
      const a = this.armed;
      const ok = a !== null && (await this.frameInTarget(a.targetId, String(p.frameId ?? '')));
      if (!ok || this.armed !== a || !a) {
        this.o.log.event('vault.download_unexpected');
        this.rejected.add(guid);
        await this.cancel(guid);
        return;
      }
      clearTimeout(a.timer);
      this.armed = null;
      this.active.set(guid, { targetId: a.targetId, tooLarge: false, stall: this.stallTimer(guid) });
      return;
    }
    if (method !== 'Browser.downloadProgress') return;
    if (this.rejected.has(guid)) {
      if (p.state === 'canceled' || p.state === 'completed') {
        this.rejected.delete(guid);
        await this.removeGuidFiles(guid);
      }
      return;
    }
    const d = this.active.get(guid);
    if (!d) return;
    const state = p.state;
    clearTimeout(d.stall);
    if (state === 'inProgress') {
      d.stall = this.stallTimer(guid);
      const total = Number(p.totalBytes ?? 0);
      const got = Number(p.receivedBytes ?? 0);
      if (!d.tooLarge && (total > this.max || got > this.max)) {
        d.tooLarge = true;
        await this.o.send('Browser.cancelDownload', { guid }).catch(() => {});
      }
      return;
    }
    if (state === 'canceled') {
      this.active.delete(guid);
      await this.removeGuidFiles(guid);
      this.fail(d.tooLarge ? 'too_large' : 'canceled');
      return;
    }
    if (state === 'completed') {
      this.active.delete(guid);
      if (d.tooLarge) {
        await this.removeGuidFiles(guid);
        this.fail('too_large');
        return;
      }
      await this.finishDownload(guid);
    }
  }

  private stallTimer(guid: string): NodeJS.Timeout {
    const timer = setTimeout(() => {
      if (this.active.get(guid)?.stall !== timer) return;
      this.active.delete(guid);
      this.rejected.add(guid);
      this.o.log.event('vault.download_stalled');
      this.fail('canceled');
      void this.cancel(guid);
    }, this.o.stallMs ?? DOWNLOAD_STALL_MS);
    timer.unref?.();
    return timer;
  }

  private async finishDownload(guid: string): Promise<void> {
    const src = path.join(this.o.staging, guid);
    const r = await readRegularFile(src, this.max);
    if (!r.ok) {
      await this.removeGuidFiles(guid);
      this.fail(r.reason === 'too_large' ? 'too_large' : 'unreadable');
      return;
    }
    const bytes = r.bytes;
    await this.removeGuidFiles(guid);
    const verdict = checkPdfBytes(bytes, this.max);
    if (verdict !== 'ok') {
      this.fail(verdict === 'empty' ? 'not_pdf' : verdict);
      return;
    }
    const fileId = await this.writeStaged(bytes);
    this.o.log.event('vault.pdf_saved', { via: 'download', bytes: bytes.length });
    this.o.emit('download.completed', { fileId });
  }

  private async frameInTarget(targetId: string, frameId: string): Promise<boolean> {
    const t = this.o.exposed(targetId);
    if (!t || !frameId) return false;
    if (frameId === t.targetId || frameId === t.mainFrameId) return true;
    const tree = await this.o.send<{ frameTree: Json }>('Page.getFrameTree', {}, t.vaultSession).catch(() => null);
    const walk = (n: Json | undefined): boolean => {
      if (!n) return false;
      if ((n.frame as Json | undefined)?.id === frameId) return true;
      return ((n.childFrames as Json[] | undefined) ?? []).some(walk);
    };
    return walk(tree?.frameTree);
  }

  private async cancel(guid: string): Promise<void> {
    await this.o.send('Browser.cancelDownload', { guid }).catch(() => {});
    await this.removeGuidFiles(guid);
  }

  private async removeGuidFiles(guid: string): Promise<void> {
    const remove = this.o.remove ?? ((f: string) => fs.rm(f, { force: true, recursive: true, maxRetries: process.platform === 'win32' ? 5 : 0, retryDelay: 50 }));
    for (const name of [guid, `${guid}.crdownload`]) await remove(path.join(this.o.staging, name)).catch(() => {});
    this.sweepStaging();
  }

  private sweepStaging(again = false): void {
    if (!again) {
      if (this.resweep.timer) clearTimeout(this.resweep.timer);
      this.resweep = { timer: null, step: 0 };
    }
    this.sweeping = this.sweeping.then(async () => {
      if (this.closed || this.active.size) return;
      const r = await sweepStagingDir(this.o.staging, { remove: this.o.remove, stop: () => this.closed || this.active.size > 0 });
      if (r.removed || r.left) this.o.log.event('vault.staging_swept', { removed: r.removed, left: r.left });
      if (r.stopped) return;
      if (!again || r.removed || r.left) this.scheduleResweep();
    });
  }

  private scheduleResweep(): void {
    const delays = this.o.resweepMs ?? STAGING_RESWEEP_MS;
    if (this.closed || this.resweep.timer || this.resweep.step >= delays.length) return;
    const timer = setTimeout(() => {
      if (this.resweep.timer !== timer) return;
      this.resweep.timer = null;
      this.sweepStaging(true);
    }, delays[this.resweep.step++]);
    timer.unref?.();
    this.resweep.timer = timer;
  }

  async settled(): Promise<void> {
    await this.sweeping;
  }

  private async ensureStaging(): Promise<void> {
    await fs.mkdir(this.o.staging, { recursive: true, mode: 0o700 });
    const st = await fs.lstat(this.o.staging);
    if (!st.isDirectory()) throw new Error('staging not a directory');
  }

  private async writeStaged(bytes: Uint8Array): Promise<string> {
    await this.ensureStaging();
    const fileId = randomBytes(16).toString('hex');
    const file = stagedPdfPath(this.o.staging, fileId);
    const fh = await fs.open(file, 'wx', 0o600);
    try {
      await fh.writeFile(bytes);
      if (process.platform !== 'win32') await fh.chmod(0o600);
    } finally {
      await fh.close();
    }
    return fileId;
  }

  private refuse(reason: Exclude<PdfPrintResult, { ok: true }>['reason'], via: 'print' | 'original' = 'print'): PdfPrintResult {
    this.o.log.event('vault.pdf_refused', { via, reason });
    return { ok: false, reason };
  }

  private armRefuse(reason: Exclude<DownloadArmResult, { armed: true }>['reason']): DownloadArmResult {
    this.o.log.event('vault.download_arm_refused', { reason });
    return { armed: false, reason };
  }

  private fail(reason: DownloadFailReason): void {
    this.o.log.event('vault.pdf_refused', { via: 'download', reason });
    this.o.emit('download.failed', { reason });
  }
}
