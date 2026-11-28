import { checkPaperDraft, type PaperInvoiceDraft } from '@sax/remote';
import type { PackPcOcr } from './accountant-pack.ts';
import { bmp, readPaper, type PaperSandbox } from './paper-ocr.ts';

/**
 * 꾸러미에 종이 증빙 넣기(ADR-073 결정 5). 사장님이 PC에서 고른 사진이나 PDF를 보관함에 넣고, 계산서면 글자를 읽어 칸 후보를 남긴다.
 * 읽은 값이 검산(합계, 세액 10%, 사업자번호 체크섬, 작성일)을 모두 통과하고 내 사업자번호가 한쪽에 있으면 바로 확정해 리포트와 부가세에 넣는다.
 * 아니면 확정하지 않고 꾸러미가 "확인할 것"으로 알린다. 사장님이 화면에서 고친 값만 확정한다(pack.paperSave).
 */

type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;
type Log = (name: string, data: Record<string, string | number | boolean | undefined>) => void;
export type PaperFormat = 'jpg' | 'png' | 'pdf';

/** 파일 머리로 형식을 정한다(고른 파일 이름은 믿지 않는다). 엔진도 같은 머리를 다시 본다 */
export function sniffPaper(b: Uint8Array): PaperFormat | null {
  const at = (sig: number[]) => b.length >= sig.length && sig.every((x, i) => b[i] === x);
  return at([0xff, 0xd8, 0xff]) ? 'jpg' : at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ? 'png' : at([0x25, 0x50, 0x44, 0x46, 0x2d]) ? 'pdf' : null;
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

/** 읽은 후보를 그대로 확정해도 되면 receipt.confirm 값, 아니면 null */
export function draftConfirm(d: PaperInvoiceDraft | null, myBizNo: string | null): Record<string, unknown> | null {
  if (!d || checkPaperDraft(d).some((i) => i.field !== 'direction')) return null;
  const mine = digits(myBizNo);
  const direction = mine.length !== 10 ? null : digits(d.supplier.bizNo) === mine ? 'sales' : digits(d.buyer.bizNo) === mine ? 'purchase' : null;
  const vat = d.vatAmount ?? 0;
  if (!direction || !d.writtenOn || d.supplyAmount === null || d.total === null || d.supplyAmount + vat !== d.total || (d.docKind === 'invoice' && vat !== 0)) return null;
  const other = direction === 'sales' ? d.buyer : d.supplier;
  const otherNo = digits(other.bizNo);
  return {
    issuedOn: d.writtenOn, amount: d.total, merchant: other.name?.trim().slice(0, 100) || null, merchantBizNo: otherNo.length === 10 ? otherNo : null,
    paper: { docKind: d.docKind, direction, supply: d.supplyAmount, vat, approvalNo: d.approvalNo && /^\d{8}-\d{8}-\d{8}$/.test(d.approvalNo) ? d.approvalNo : null },
  };
}

/** 엔진 ocr_json 상한(PC_OCR_MAX, JSON 16,384자) 안에 들게: 넘치면 품목을 뺀다 */
function ocrJson(o: PackPcOcr): PackPcOcr {
  if (JSON.stringify(o).length <= 15_000 || !o.paperDraft) return o;
  return { ...o, paperDraft: { ...o.paperDraft, items: [] } };
}

export async function addPaper(o: {
  bytes: Uint8Array;
  month: string;
  profileId: string;
  myBizNo: string | null;
  sandbox: PaperSandbox;
  rpc: Rpc;
  log: Log;
}): Promise<{ docId: string; duplicate: boolean; confirmed: boolean; month: string }> {
  const format = sniffPaper(o.bytes);
  if (!format) throw new Error('bad_format');
  // readPaper는 원시값(엔진, 낱말 수, ms, 찾음)만 남긴다
  const read = await readPaper(o.bytes, format, { sandbox: o.sandbox, log: o.log as (n: string, d: Record<string, unknown>) => void }).catch((e: unknown) => {
    o.log('pack.paper_read', { result: 'failed', code: String((e as { code?: unknown }).code ?? (e as Error).message ?? 'failed').slice(0, 40) });
    return null;
  });
  const draft = read?.read?.invoice ?? null;
  const ocr = ocrJson({ v: 1, addedFor: o.month, engine: read?.engine ?? null, paperDraft: draft });
  const { docId, duplicate } = (await o.rpc('receipt.pcStore', { profileId: o.profileId, bytes: o.bytes, format, ocr })) as { docId: string; duplicate: boolean };
  const sure = duplicate ? null : draftConfirm(draft, o.myBizNo);
  if (sure) await o.rpc('receipt.confirm', { profileId: o.profileId, docId, ...sure });
  o.log('pack.paper_add', { format, read: draft ? 'invoice' : 'none', confirmed: !!sure, duplicate });
  return { docId, duplicate, confirmed: !!sure, month: draft?.writtenOn && /^\d{4}-\d{2}-\d{2}$/.test(draft.writtenOn) ? draft.writtenOn.slice(0, 7) : o.month };
}

/** 사장님이 상세에서 고친 값(pack.paperSave). 영수증은 날짜, 가게, 금액만 쓴다 */
export interface PaperEdit {
  docId: string;
  kind: 'tax_invoice' | 'invoice' | 'receipt';
  day: string;
  name?: string | null;
  bizNo?: string | null;
  amount: number;
  direction?: 'sales' | 'purchase' | null;
  supply?: number;
  vat?: number;
  /** 읽거나 확정해 둔 승인번호를 그대로 돌려받는다(화면에서 고치지 않는다) */
  approvalNo?: string | null;
}

/**
 * 꾸러미 화면의 종이 증빙 일(넣기, 그림, 고치기, 빼기). 엔진 명령은 여기서만 부른다: 렌더러 처리기 표는 이 함수들만 부른다(H-01).
 * profileId는 부를 때마다 묻는다(사업장이 바뀔 수 있다). 그림은 문서마다 40장까지 기억한다.
 */
export function packPaper(o: {
  rpc: Rpc;
  sandbox: PaperSandbox;
  profileId: () => string;
  myBizNo: () => string | null;
  file: (docId: string) => Promise<string | null>;
  read: (file: string) => Promise<Uint8Array>;
  log: Log;
}) {
  const thumbs = new Map<string, string>();
  return {
    add: (bytes: Uint8Array, month: string) => addPaper({ bytes, month, profileId: o.profileId(), myBizNo: o.myBizNo(), sandbox: o.sandbox, rpc: o.rpc, log: o.log }),
    async thumb(docId: string): Promise<{ src: string }> {
      const hit = thumbs.get(docId);
      if (hit) return { src: hit };
      const file = await o.file(docId);
      if (!file) throw new Error('doc_not_found');
      const src = await paperThumb(await o.read(file), o.sandbox);
      if (thumbs.size >= 40) thumbs.delete(thumbs.keys().next().value!);
      thumbs.set(docId, src);
      return { src };
    },
    save(p: PaperEdit) {
      const base = { profileId: o.profileId(), docId: p.docId, issuedOn: p.day, amount: p.amount, merchant: p.name ?? null, merchantBizNo: p.bizNo ?? null };
      if (p.kind === 'receipt') return o.rpc('receipt.confirm', { ...base, merchantBizNo: null });
      if (!p.direction || p.supply === undefined || p.vat === undefined) throw new Error('bad_request');
      return o.rpc('receipt.confirm', { ...base, paper: { docKind: p.kind, direction: p.direction, supply: p.supply, vat: p.vat, approvalNo: p.approvalNo ?? null } });
    },
    async remove(docId: string) {
      const r = await o.rpc('receipt.remove', { profileId: o.profileId(), docId });
      thumbs.delete(docId);
      return r;
    },
  };
}

/** 상세에 보이는 원본 그림. 샌드박스가 풀어 준 화소를 긴 변 max로 줄여(칸 평균) BMP data URL로 준다 */
export async function paperThumb(bytes: Uint8Array, sandbox: Pick<PaperSandbox, 'raster'>, max = 480): Promise<string> {
  const format = sniffPaper(bytes);
  if (!format) throw new Error('bad_format');
  const r = await sandbox.raster(bytes, format === 'pdf' ? 'pdf' : 'image');
  const scale = Math.min(1, max / Math.max(r.width, r.height));
  const w = Math.max(1, Math.round(r.width * scale));
  const h = Math.max(1, Math.round(r.height * scale));
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * r.height) / h);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * r.height) / h));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * r.width) / w);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * r.width) / w));
      let cr = 0;
      let cg = 0;
      let cb = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * r.width + sx) * 3;
          cr += r.rgb[i]!;
          cg += r.rgb[i + 1]!;
          cb += r.rgb[i + 2]!;
        }
      }
      const n = (y1 - y0) * (x1 - x0);
      const d = (y * w + x) * 3;
      out[d] = Math.round(cr / n);
      out[d + 1] = Math.round(cg / n);
      out[d + 2] = Math.round(cb / n);
    }
  }
  return `data:image/bmp;base64,${bmp(out, w, h).toString('base64')}`;
}
