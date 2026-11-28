import * as pdfjs from 'sax-docparse://app/pdfjs/pdf.min.mjs';
import { assessTextLayer, cleanDocumentForOcr, cleanFormForOcr, cleanForOcr, cleanPhotoForOcr, IMAGE_LIMITS, imageInfo, itemsToLines, ocrScale, readCertInfo, readSheetBytes, SANDBOX_ERRORS, tidyText } from 'sax-docparse://app/lib/index.js';

const BASE = 'sax-docparse://app/';
const PDFJS = `${BASE}pdfjs/`;
const OCR_DPI = 300;
const OCR_MAX_SIDE = 3500;

class JobError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function tesseractWorker(model = 'tessdata') {
  return Tesseract.createWorker('kor', 1, {
    workerPath: `${BASE}worker.min.js`,
    corePath: `${BASE}core`,
    langPath: model === 'best_int' ? `${BASE}lang-best-int` : `${BASE}lang`,
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
  });
}

const KNOWN_ERRORS = new Set(SANDBOX_ERRORS);

async function ocrImageJob({ bytes, mode, model }) {
  const info = imageInfo(bytes);
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new JobError('image_decode_failed');
  }
  const scale = ocrScale(bmp.width, bmp.height, mode, IMAGE_LIMITS.ocrMaxSide);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (mode === 'photo') cleanPhotoForOcr(img.data, img.width, img.height);
  else cleanDocumentForOcr(img.data, img.width, img.height);
  ctx.putImageData(img, 0, 0);
  const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  if (!png) throw new JobError('render_failed');
  const worker = await tesseractWorker(model);
  try {
    const { data: r } = await worker.recognize(png, {}, { text: true, blocks: true });
    const lines = [];
    for (const b of r.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) {
      const t = String(l.text || '').replace(/\s+$/, '');
      if (t && lines.length < 1000) lines.push({ text: t.slice(0, 2000), confidence: Math.max(0, Math.min(100, Number(l.confidence || 0))) });
    }
    const text = lines.length ? lines.map((l) => l.text).join('\n') : String(r.text || '');
    return { text: text.slice(0, 50000), confidence: Math.max(0, Math.min(100, Number(r.confidence || 0))), lines, width: info.width, height: info.height, exif: info.exif };
  } finally {
    await worker.terminate();
  }
}

async function ocrImage({ bytes }) {
  const worker = await tesseractWorker();
  try {
    const { data: r } = await worker.recognize(new Blob([bytes]));
    return { text: String(r.text || ''), confidence: Number(r.confidence || 0) };
  } finally {
    await worker.terminate();
  }
}

// 종이 계산서(ADR-073): 사진이나 PDF 첫 쪽을 여기서 풀어 긴 변 paperMaxSide 이하로 다시 그린다. 바깥(main, OS 글자 읽기)은 원본 파일을 열지 않는다
async function paperCanvas({ bytes, format }) {
  const max = IMAGE_LIMITS.paperMaxSide;
  const canvas = document.createElement('canvas');
  if (format === 'pdf') {
    const { worker, failed } = pdfWorker();
    pdfjs.GlobalWorkerOptions.workerPort = worker;
    let task = null;
    try {
      task = pdfjs.getDocument(pdfParams(bytes));
      const doc = await Promise.race([task.promise, failed]);
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: Math.min(OCR_DPI / 72, max / Math.max(base.width, base.height)) });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport, intent: 'print' }).promise;
      page.cleanup();
      return { canvas, ctx };
    } catch (e) {
      throw pdfError(e);
    } finally {
      await task?.destroy().catch(() => {});
      worker.terminate();
    }
  }
  imageInfo(bytes);
  let bmp;
  try {
    bmp = await createImageBitmap(new Blob([bytes]));
  } catch {
    throw new JobError('image_decode_failed');
  }
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height, 1));
  canvas.width = Math.max(1, Math.round(bmp.width * scale));
  canvas.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  return { canvas, ctx };
}

async function paperRaster(data) {
  const { canvas, ctx } = await paperCanvas(data);
  const { width, height } = canvas;
  const px = ctx.getImageData(0, 0, width, height).data;
  canvas.width = 0;
  canvas.height = 0;
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    rgb[j] = px[i];
    rgb[j + 1] = px[i + 1];
    rgb[j + 2] = px[i + 2];
  }
  return { width, height, rgb };
}

async function paperWords(data) {
  const { canvas, ctx } = await paperCanvas(data);
  const { width, height } = canvas;
  const img = ctx.getImageData(0, 0, width, height);
  cleanFormForOcr(img.data, width, height);
  ctx.putImageData(img, 0, 0);
  const png = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  if (!png) throw new JobError('render_failed');
  const worker = await tesseractWorker();
  try {
    const { data: r } = await worker.recognize(png, {}, { blocks: true });
    const words = [];
    for (const b of r.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) for (const w of l.words ?? []) {
      const t = String(w.text || '').trim();
      const bb = w.bbox;
      if (!t || !bb || words.length >= 4000) continue;
      const x = Math.max(0, Math.min(width, bb.x0));
      const y = Math.max(0, Math.min(height, bb.y0));
      words.push({ text: t.slice(0, 200), x, y, w: Math.max(0, Math.min(width, bb.x1) - x), h: Math.max(0, Math.min(height, bb.y1) - y) });
    }
    return { width, height, words };
  } finally {
    await worker.terminate();
  }
}

function pdfWorker() {
  const worker = new Worker(`${PDFJS}pdf.worker.min.mjs`, { type: 'module' });
  const failed = new Promise((_, reject) => worker.addEventListener('error', () => reject(new JobError('worker_failed')), { once: true }));
  failed.catch(() => {});
  return { worker, failed };
}

function pdfError(e) {
  if (e instanceof JobError) return e;
  if (e?.name === 'PasswordException') return new JobError(e.code === pdfjs.PasswordResponses.INCORRECT_PASSWORD ? 'password_incorrect' : 'password_required');
  if (e?.name === 'InvalidPDFException') return new JobError('invalid_pdf');
  return new JobError('parse_failed');
}

function pdfParams(bytes, password) {
  return {
    data: bytes,
    password: typeof password === 'string' ? password : undefined,
    cMapUrl: `${PDFJS}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS}standard_fonts/`,
    wasmUrl: `${PDFJS}wasm/`,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    stopAtErrors: false,
    maxImageSize: 25_000_000,
    isEvalSupported: false,
    enableScripting: false,
  };
}

async function renderForOcr(page) {
  const base = page.getViewport({ scale: 1 });
  const scale = Math.min(OCR_DPI / 72, OCR_MAX_SIDE / Math.max(base.width, base.height));
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport, intent: 'print' }).promise;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  cleanForOcr(img.data, img.width, img.height);
  ctx.putImageData(img, 0, 0);
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  canvas.width = 0;
  canvas.height = 0;
  if (!blob) throw new JobError('render_failed');
  return blob;
}

async function hasInvisibleText(doc, pages) {
  try {
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      page.cleanup();
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] === pdfjs.OPS.setTextRenderingMode && (ops.argsArray[k][0] & 3) === 3) return true;
      }
    }
    return false;
  } catch {
    return true;
  }
}

async function parsePdf({ bytes, maxPages, ocrPages, forceOcr, password }) {
  const t0 = performance.now();
  const { worker, failed } = pdfWorker();
  pdfjs.GlobalWorkerOptions.workerPort = worker;
  let task = null;
  try {
    task = pdfjs.getDocument(pdfParams(bytes, password));
    const doc = await Promise.race([task.promise, failed]);
    const tLoaded = performance.now();
    const pages = Math.min(doc.numPages, maxPages);
    const lines = [];
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const tc = await page.getTextContent();
      lines.push(...itemsToLines(tc.items));
      page.cleanup();
    }
    const layerText = tidyText(lines.join('\n'));
    const tText = performance.now();
    const layer = assessTextLayer(layerText, pages);
    const scanned = layer.ok && (await hasInvisibleText(doc, pages));
    const timing = { loadMs: Math.round(tLoaded - t0), textMs: Math.round(performance.now() - tLoaded), ocrMs: 0 };
    if ((layer.ok && !forceOcr) || ocrPages === 0) return { text: layerText, pages, totalPages: doc.numPages, hasTextLayer: layer.ok, scanned, ocrConfidence: null, timing };
    const ocr = await tesseractWorker();
    try {
      const texts = [];
      let conf = 0;
      const n = Math.min(pages, ocrPages);
      for (let i = 1; i <= n; i++) {
        const page = await doc.getPage(i);
        const png = await renderForOcr(page);
        page.cleanup();
        const { data: r } = await ocr.recognize(png);
        texts.push(String(r.text || ''));
        conf += Number(r.confidence || 0);
      }
      timing.ocrMs = Math.round(performance.now() - tText);
      return { text: tidyText(texts.join('\n')), pages, totalPages: doc.numPages, hasTextLayer: layer.ok, scanned, ocrConfidence: Math.round(conf / n), timing };
    } finally {
      await ocr.terminate();
    }
  } catch (e) {
    throw pdfError(e);
  } finally {
    await task?.destroy().catch(() => {});
    worker.terminate();
  }
}

window.addEventListener('message', (ev) => {
  if (ev.data !== 'docparse-port' || !ev.ports[0]) return;
  const port = ev.ports[0];
  port.onmessage = async ({ data }) => {
    try {
      const kind = data?.kind;
      port.postMessage(kind === 'paperRaster' ? await paperRaster(data) : kind === 'pdf' ? await parsePdf(data) : kind === 'image' ? await ocrImageJob(data) : kind === 'sheet' ? await readSheetBytes(data.bytes) : kind === 'certInfo' ? readCertInfo(data.bytes) : kind === 'paperWords' ? await paperWords(data) : await ocrImage(data));
    } catch (e) {
      const fallback = data?.kind === 'sheet' ? 'sheet_invalid' : data?.kind === 'pdf' ? 'parse_failed' : data?.kind === 'certInfo' ? 'cert_invalid' : data?.kind === 'paperRaster' ? 'render_failed' : 'ocr_failed';
      port.postMessage({ error: typeof e?.code === 'string' && KNOWN_ERRORS.has(e.code) ? e.code : fallback });
    }
  };
});
