import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parsePaperInvoice, type OcrBox, type PaperRead } from '@sax/remote';

/**
 * 종이 세금계산서와 계산서 글자 읽기(ADR-073). 순서:
 * 1. 샌드박스가 원본(사진, PDF 첫 쪽)을 풀어 RGB 화소로 다시 그린다(ADR-014: 원본은 샌드박스만 연다).
 * 2. main이 그 화소로 BMP를 직접 만들어 OS에 들어 있는 글자 읽기에 넘긴다. macOS는 Vision, Windows는 Windows.Media.Ocr(한국어).
 * 3. OS 읽기가 없거나 실패하면 샌드박스의 tesseract로 읽는다.
 * 4. 글자 상자를 폰과 같은 규칙(@sax/remote parsePaperInvoice)으로 칸에 채운다. 결과는 후보이고, 사장님이 확인한 값만 장부에 들어간다.
 * 그림과 글은 PC 밖으로 나가지 않는다.
 */

export type PaperEngine = 'mac_vision' | 'win_ocr' | 'tesseract';

export interface PaperOcrResult {
  engine: PaperEngine;
  read: PaperRead | null;
  words: number;
  ms: number;
  /** 읽은 글자 상자(실측 e2e가 칸 규칙을 고칠 때 본다). 로그에는 남기지 않는다 */
  boxes: OcrBox[];
}

type Log = (name: string, data: Record<string, unknown>) => void;

/** 샌드박스 일(데스크톱은 docparse.ts paperRasterInSandbox, paperWordsInSandbox) */
export interface PaperSandbox {
  raster(bytes: Uint8Array, format: 'image' | 'pdf'): Promise<{ width: number; height: number; rgb: Uint8Array }>;
  words(bytes: Uint8Array, format: 'image' | 'pdf'): Promise<{ width: number; height: number; words: Array<{ text: string; x: number; y: number; w: number; h: number }> }>;
}

/** 24비트 BMP(BI_RGB, 아래 줄부터, 줄마다 4바이트 맞춤). 머리는 main이 쓴다: OS 그림 풀개는 우리가 만든 단순 BMP만 연다 */
export function bmp(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = (width * 3 + 3) & ~3;
  const size = 54 + stride * height;
  const b = Buffer.alloc(size);
  b.write('BM', 0, 'ascii');
  b.writeUInt32LE(size, 2);
  b.writeUInt32LE(54, 10);
  b.writeUInt32LE(40, 14);
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  b.writeUInt16LE(1, 26);
  b.writeUInt16LE(24, 28);
  b.writeUInt32LE(stride * height, 34);
  b.writeInt32LE(11811, 38);
  b.writeInt32LE(11811, 42);
  for (let y = 0; y < height; y++) {
    const row = 54 + (height - 1 - y) * stride;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 3;
      const d = row + x * 3;
      b[d] = rgb[s + 2]!;
      b[d + 1] = rgb[s + 1]!;
      b[d + 2] = rgb[s]!;
    }
  }
  return b;
}

// macOS Vision(JXA). 상자는 0~1 비율이고 원점이 왼쪽 아래라 위아래를 뒤집는다. 한국어는 macOS 13부터 읽는다.
// Vision은 줄이나 표의 이웃 칸 몇 개를 한 관찰로 낸다. 낱말마다 상자(boundingBoxForRange)를 받아 나누고, 못 받거나 낱말 상자가 관찰 상자와 같으면 통째로 낸다(칸 규칙이 글자 폭으로 나눈다)
const MAC_VISION = `ObjC.import('Foundation');
ObjC.import('Vision');
function run(argv) {
  const req = $.VNRecognizeTextRequest.alloc.init;
  req.setRecognitionLevel(0);
  req.setUsesLanguageCorrection(false);
  req.setRecognitionLanguages($(['ko-KR', 'en-US']));
  const handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  if (!handler.performRequestsError($([req]), null)) return JSON.stringify({ error: 'vision_failed' });
  const res = req.results;
  const words = [];
  const flip = (q) => ({ x: q.origin.x, y: 1 - q.origin.y - q.size.height, w: q.size.width, h: q.size.height });
  for (let i = 0; i < res.count && words.length < 4000; i++) {
    const o = res.objectAtIndex(i);
    const c = o.topCandidates(1).firstObject;
    if (c.isNil()) continue;
    const s = c.string.js;
    const whole = Object.assign({ t: s, g: i }, flip(o.boundingBox));
    const parts = [];
    if (/\\S\\s+\\S/.test(s)) {
      try {
        const re = /\\S+/g;
        for (let m = re.exec(s); m; m = re.exec(s)) {
          const r = c.boundingBoxForRangeError($.NSMakeRange(m.index, m[0].length), null);
          if (!r || r.isNil()) throw new Error('nil');
          parts.push(Object.assign({ t: m[0], g: i }, flip(r.boundingBox)));
        }
      } catch (e) {
        parts.length = 0;
      }
    }
    if (parts.length > 1 && parts.some((p) => Math.abs(p.x - whole.x) > 1e-4 || Math.abs(p.w - whole.w) > 1e-4)) for (const p of parts) words.push(p);
    else words.push(whole);
  }
  return JSON.stringify({ norm: true, words: words });
}`;

// Windows.Media.Ocr(Windows PowerShell 5.1의 WinRT). 한국어 읽기가 깔려 있지 않으면 no_korean. 상자는 화소다
const WIN_OCR = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' } | Select-Object -First 1
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(); $t.Result }
$lang = New-Object Windows.Globalization.Language 'ko'
if (-not [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported($lang)) { '{"error":"no_korean"}'; exit 0 }
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($lang)
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:SAX_PAPER_BMP)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} finally { $stream.Dispose() }
$g = 0
$words = foreach ($line in $result.Lines) { $g++; foreach ($w in $line.Words) { $r = $w.BoundingRect; [pscustomobject]@{ t = $w.Text; x = $r.X; y = $r.Y; w = $r.Width; h = $r.Height; g = $g } } }
[pscustomobject]@{ norm = $false; words = @($words) } | ConvertTo-Json -Compress -Depth 4`;

const OS_TIMEOUT_MS = 30_000;
const MAX_WORDS = 4000;

function runText(file: string, args: string[], env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: OS_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8', env: env ? { ...process.env, ...env } : process.env }, (err, out) => (err ? reject(err) : resolve(out)));
  });
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** OS 읽기 출력(JSON)을 검사해 0~1 상자로. 모양이 다르거나 비었으면 null(앱 안 읽기로 넘어간다) */
export function boxesFromOs(out: string, width: number, height: number): OcrBox[] | null {
  let v: unknown;
  try {
    v = JSON.parse(out.trim());
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object' || !Array.isArray((v as { words?: unknown }).words)) return null;
  const norm = (v as { norm?: unknown }).norm === true;
  const sx = norm ? 1 : 1 / width;
  const sy = norm ? 1 : 1 / height;
  const boxes: OcrBox[] = [];
  for (const w of (v as { words: unknown[] }).words.slice(0, MAX_WORDS)) {
    if (!w || typeof w !== 'object') continue;
    const { t, x, y, w: ww, h, g } = w as Record<string, unknown>;
    if (typeof t !== 'string' || !finite(x) || !finite(y) || !finite(ww) || !finite(h)) continue;
    const text = t.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 200);
    if (!text) continue;
    // g: 같은 줄(관찰)에서 나온 낱말. 칸 규칙이 값을 이을 때 띄어 쓴다
    boxes.push({ text, x: clamp01(x * sx), y: clamp01(y * sy), w: clamp01(ww * sx), h: clamp01(h * sy), ...(Number.isSafeInteger(g) && (g as number) >= 0 && (g as number) < 100_000 ? { group: g as number } : {}) });
  }
  return boxes.length ? boxes : null;
}

/** OS 글자 읽기. 이 OS에 없거나(리눅스), 한국어가 없거나, 실패하면 null */
export async function osOcr(raster: { width: number; height: number; rgb: Uint8Array }, o: { platform?: NodeJS.Platform; log?: Log } = {}): Promise<{ engine: PaperEngine; boxes: OcrBox[] } | null> {
  const platform = o.platform ?? process.platform;
  if (platform !== 'darwin' && platform !== 'win32') return null;
  const file = path.join(os.tmpdir(), `sax-paper-${randomBytes(8).toString('hex')}.bmp`);
  await fs.writeFile(file, bmp(raster.rgb, raster.width, raster.height), { mode: 0o600 });
  try {
    const out = platform === 'darwin'
      ? await runText('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_VISION, file])
      : await runText(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(WIN_OCR, 'utf16le').toString('base64')], { SAX_PAPER_BMP: file });
    const boxes = boxesFromOs(out, raster.width, raster.height);
    if (!boxes) {
      const error = /"error"\s*:\s*"(\w{1,40})"/.exec(out)?.[1] ?? 'empty';
      o.log?.('paper.os_ocr_none', { platform, error });
      return null;
    }
    return { engine: platform === 'darwin' ? 'mac_vision' : 'win_ocr', boxes };
  } catch (e) {
    o.log?.('paper.os_ocr_failed', { platform, error: ((e as NodeJS.ErrnoException).code ?? (e as Error).name ?? 'error').toString().slice(0, 40), killed: (e as { killed?: boolean }).killed === true });
    return null;
  } finally {
    await fs.rm(file, { force: true });
  }
}

/** 종이 계산서 파일(jpg, png, pdf) → 칸 후보. 원본은 샌드박스만 연다 */
export async function readPaper(bytes: Uint8Array, format: 'jpg' | 'png' | 'pdf', o: { sandbox: PaperSandbox; today?: Date; platform?: NodeJS.Platform; log?: Log }): Promise<PaperOcrResult> {
  const t0 = Date.now();
  const kind = format === 'pdf' ? 'pdf' : 'image';
  const raster = await o.sandbox.raster(bytes, kind);
  const got = await osOcr(raster, o);
  let engine: PaperEngine;
  let boxes: OcrBox[];
  if (got) {
    ({ engine, boxes } = got);
  } else {
    const w = await o.sandbox.words(bytes, kind);
    engine = 'tesseract';
    boxes = w.words.map((x) => ({ text: x.text, x: x.x / w.width, y: x.y / w.height, w: x.w / w.width, h: x.h / w.height }));
  }
  const read = parsePaperInvoice(boxes, o.today ?? new Date());
  const ms = Date.now() - t0;
  o.log?.('paper.read', { engine, words: boxes.length, ms, found: read !== null });
  return { engine, read, words: boxes.length, ms, boxes };
}
