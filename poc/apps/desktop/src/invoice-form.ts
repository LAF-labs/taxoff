import { formatBizNo } from '@sax/db';

/**
 * 앱이 직접 만드는 세금계산서 PDF의 값. 화면을 찍지 않고 발급 데이터만 쓴다.
 * 건별 발급, 수정세금계산서(ADR-058), 대량발급이 모두 이 모양 하나로 PDF를 만든다.
 */
export interface InvoiceForm {
  approvalNo: string;
  issueDate: string;
  supplier: Party;
  buyer: Party;
  items: InvoiceItem[];
  remark?: string;
  receipt: '영수' | '청구';
  /** 수정세금계산서면 제목이 바뀌고 수정사유 칸과 비고의 당초 승인번호가 찬다. */
  amend?: { reason: string; originalApprovalNo?: string | null } | null;
}

export interface InvoiceItem {
  /** 비우면 작성일자의 월일을 쓴다. */
  date?: string | null;
  name: string;
  spec?: string | null;
  qty?: number | null;
  unitPrice?: number | null;
  supply: number;
  tax: number;
  note?: string | null;
}

export interface Party {
  bizNo: string;
  subNo?: string | null;
  name: string;
  rep?: string | null;
  address?: string | null;
  bizType?: string | null;
  bizItem?: string | null;
  email?: string | null;
}

/** 홈택스 전자세금계산서 한 장의 품목 줄 상한. */
export const MAX_ITEMS = 16;
const MIN_ROWS = 4;

/** PDF 맨 아래 한 줄. 원본은 국세청 전송분이라 '같다'고 보증하지 않는다(대표 11-23). */
export const COPY_NOTE = '택스오프가 홈택스 발급 내용으로 만든 사본이에요. 원본은 홈택스에서 승인번호로 조회할 수 있어요.';

const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const num = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '');
const qtyText = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('ko-KR', { maximumFractionDigits: 2 }) : '');
const digits = (v: string) => v.replace(/-/g, '');
const biz = (v: string) => (/^\d{10}$/.test(digits(v)) ? formatBizNo(digits(v)) : v);
const approval = (v: string) => (/^\d{24}$/.test(digits(v)) ? `${digits(v).slice(0, 8)}-${digits(v).slice(8, 16)}-${digits(v).slice(16)}` : v);

/** 금액 칸: 자리가 많으면 글자를 줄여 칸 안에 넣는다(1조 원대까지). */
function amount(n: number | null | undefined, o: { bold?: boolean; wide?: boolean } = {}): string {
  const t = num(n);
  const [sm, xs] = o.wide ? [19, 23] : [13, 17];
  const size = t.length > xs ? ' xs' : t.length > sm ? ' sm' : '';
  return `<td class="n${size}${o.bold ? ' strong' : ''}">${t}</td>`;
}

function ymd(v: string): { date: string; mm: string; dd: string } {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v.trim());
  return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, mm: m[2]!, dd: m[3]! } : { date: v, mm: '', dd: '' };
}

function fontFaces(fonts: InvoiceFonts | undefined): string {
  if (!fonts) return '';
  return [
    `@font-face{font-family:"SAX Invoice";font-weight:400;src:url(data:font/woff2;base64,${fonts.regular}) format("woff2")}`,
    `@font-face{font-family:"SAX Invoice";font-weight:700;src:url(data:font/woff2;base64,${fonts.bold}) format("woff2")}`,
  ].join('');
}

const STYLE = `@page{size:A4;margin:0}
*{box-sizing:border-box}
html,body{margin:0;background:#fff;color:#111}
body{font-family:"SAX Invoice","Apple SD Gothic Neo","Malgun Gothic","Noto Sans KR",sans-serif;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.page{width:210mm;padding:14mm 12mm 12mm;display:flex;flex-direction:column;gap:8px}
.f{border-collapse:collapse;width:100%;table-layout:fixed}
.f th,.f td{border:0.75pt solid #333;padding:4px 5px;font-size:11px;line-height:15px;vertical-align:middle;word-break:keep-all;overflow-wrap:anywhere}
.f th{font-weight:700;text-align:center;background:#f4f4f4;white-space:nowrap}
.s th,.s .side{color:#b3261e;background:#fdf1f0;border-color:#b3261e}
.s td{border-color:#b3261e}
.b th,.b .side{color:#1f4e9e;background:#eef3fb;border-color:#1f4e9e}
.b td{border-color:#1f4e9e}
.side{writing-mode:vertical-rl;text-orientation:upright;letter-spacing:3px;font-weight:700;text-align:center}
.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.n.sm{font-size:9.5px}
.n.xs{font-size:8.5px;letter-spacing:-0.2px}
.strong{font-weight:700}
.c{text-align:center}
.no{letter-spacing:0.3px;white-space:nowrap}
.pair{display:grid;grid-template-columns:1fr 1fr}
.pair .b{margin-left:-1px}
.items tr{height:24px}
.items.dense th,.items.dense td{font-size:10px;line-height:13px;padding:2px 4px}
.items.dense tr{height:20px}
.note{margin:2px 0 0;font-size:10.5px;line-height:16px;color:#333}
.f td.title{font-size:24px;line-height:32px;font-weight:700;letter-spacing:6px;text-align:center;padding:10px}
.f td.title.amend{font-size:22px;letter-spacing:3px}`;

function party(cls: 's' | 'b', label: string, p: Party): string {
  return `<table class="f ${cls}"><colgroup><col style="width:24px"><col style="width:56px"><col><col style="width:58px"><col style="width:28%"></colgroup>
<tr><td class="side" rowspan="5">${label}</td><th>등록번호</th><td class="no">${esc(biz(p.bizNo))}</td><th>종사업장</th><td class="c">${esc(p.subNo)}</td></tr>
<tr><th>상호</th><td>${esc(p.name)}</td><th>성명</th><td>${esc(p.rep)}</td></tr>
<tr><th>사업장</th><td colspan="3">${esc(p.address)}</td></tr>
<tr><th>업태</th><td>${esc(p.bizType)}</td><th>종목</th><td>${esc(p.bizItem)}</td></tr>
<tr><th>이메일</th><td colspan="3">${esc(p.email)}</td></tr></table>`;
}

export interface InvoiceFonts {
  regular: string;
  bold: string;
}

/** 합계: 품목 합이 곧 계산서 합이다. */
export function invoiceTotals(f: InvoiceForm): { supply: number; tax: number; total: number } {
  const supply = f.items.reduce((a, x) => a + x.supply, 0);
  const tax = f.items.reduce((a, x) => a + x.tax, 0);
  return { supply, tax, total: supply + tax };
}

/** 표준 전자세금계산서 양식(공급자 빨강, 공급받는자 파랑) 한 장. 값은 모두 이스케이프한다. */
export function invoiceFormHtml(f: InvoiceForm, opts: { extra?: string; fonts?: InvoiceFonts } = {}): string {
  if (!f.items.length) throw new Error('invoice_no_items');
  if (f.items.length > MAX_ITEMS) throw new Error('invoice_too_many_items');
  const d = ymd(f.issueDate);
  const t = invoiceTotals(f);
  const title = f.amend ? '수정전자세금계산서' : '전자세금계산서';
  const remark = [f.amend?.originalApprovalNo ? `당초 승인번호 ${approval(f.amend.originalApprovalNo)}` : '', f.remark ?? ''].filter(Boolean).join(' ');
  const rows = f.items.map((x) => {
    const xd = x.date ? ymd(x.date) : d;
    return `<tr><td class="c">${esc(xd.mm)}</td><td class="c">${esc(xd.dd)}</td><td>${esc(x.name)}</td><td>${esc(x.spec)}</td><td class="n">${qtyText(x.qty)}</td>${amount(x.unitPrice)}${amount(x.supply)}${amount(x.tax)}<td>${esc(x.note)}</td></tr>`;
  });
  for (let i = rows.length; i < MIN_ROWS; i++) rows.push('<tr><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>${title} ${esc(approval(f.approvalNo))}</title><style>${fontFaces(opts.fonts)}${STYLE}</style><body><div class="page">
<table class="f"><colgroup><col style="width:50%"><col style="width:14%"><col style="width:36%"></colgroup>
<tr><td class="title${f.amend ? ' amend' : ''}" rowspan="2">${title}</td><th>승인번호</th><td class="no c">${esc(approval(f.approvalNo))}</td></tr>
<tr><th>관리번호</th><td></td></tr></table>
<div class="pair">${party('s', '공급자', f.supplier)}${party('b', '공급받는자', f.buyer)}</div>
<table class="f"><colgroup><col style="width:18%"><col style="width:26%"><col style="width:24%"><col style="width:32%"></colgroup>
<tr><th>작성일자</th><th>공급가액</th><th>세액</th><th>수정사유</th></tr>
<tr><td class="c">${esc(d.date)}</td>${amount(t.supply, { wide: true })}${amount(t.tax, { wide: true })}<td class="c">${esc(f.amend?.reason)}</td></tr>
<tr><th>비고</th><td colspan="3">${esc(remark)}</td></tr></table>
<table class="f items${f.items.length > 6 ? ' dense' : ''}"><colgroup><col style="width:26px"><col style="width:26px"><col><col style="width:52px"><col style="width:44px"><col style="width:92px"><col style="width:112px"><col style="width:100px"><col style="width:52px"></colgroup>
<tr><th>월</th><th>일</th><th>품목</th><th>규격</th><th>수량</th><th>단가</th><th>공급가액</th><th>세액</th><th>비고</th></tr>
${rows.join('\n')}</table>
<table class="f"><colgroup><col style="width:24%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:13%"><col style="width:24%"></colgroup>
<tr><th>합계금액</th><th>현금</th><th>수표</th><th>어음</th><th>외상미수금</th><td rowspan="2" class="c" style="font-size:13px">이 금액을 (${f.receipt}) 함</td></tr>
<tr>${amount(t.total, { bold: true, wide: true })}<td></td><td></td><td></td><td></td></tr></table>
<p class="note">${COPY_NOTE}</p>
</div>${opts.extra ?? ''}</body></html>`;
}

/** 홈택스 영수/청구 값 → 양식 문구. 모르면 청구(외상미수금)로 둔다. */
export const receiptOf = (v: string | null | undefined): '영수' | '청구' => (v === '영수' || v === '01' ? '영수' : '청구');

/** 발급 끝난 실행 → 양식 값. 홈택스 되읽기 값이 먼저고, 없는 칸만 실행 값/장부로 채운다. */
export function formFromRun(
  run: { counterparty: { name: string; bizNo: string }; email: { value: string }; item: string; supply: number; tax: number; writeDate: string; result: { approvalNo: string } | null },
  rb: ReadonlyMap<string, string> | undefined,
  me: { bizNo?: string; name: string; rep?: string; address?: string; bizType?: string; bizItem?: string; email?: string },
  cp: { repName?: string | null; address?: string | null; bizType?: string | null; bizItem?: string | null } | null,
): InvoiceForm | null {
  if (!run.result?.approvalNo) return null;
  const g = (k: string) => (rb?.get(k) ?? '').trim();
  const n = (k: string, v: number) => (g(k) !== '' && Number.isFinite(Number(g(k).replace(/,/g, ''))) ? Number(g(k).replace(/,/g, '')) : v);
  const supply = n('supplyAmount', run.supply);
  const tax = n('taxAmount', run.tax);
  const qty = n('itemCount', 1) > 0 ? n('itemCount', 1) : 1;
  const supplierEmail = g('supplierEmailId') && g('supplierEmailDomain') ? `${g('supplierEmailId')}@${g('supplierEmailDomain')}` : me.email ?? null;
  return {
    approvalNo: run.result.approvalNo,
    issueDate: g('issueDate') || run.writeDate,
    items: [{ name: g('itemName') || run.item, qty, unitPrice: qty > 0 ? supply / qty : null, supply, tax }],
    remark: g('remark'),
    receipt: receiptOf(g('receiptType')),
    supplier: { bizNo: g('supplierBizNo') || me.bizNo || '', name: g('supplierName') || me.name, rep: g('supplierRepName') || me.rep || null, address: g('supplierAddress') || me.address || null, bizType: g('supplierBizType') || me.bizType || null, bizItem: g('supplierBizItem') || me.bizItem || null, email: supplierEmail },
    buyer: { bizNo: g('counterpartBizNo') || run.counterparty.bizNo, name: g('counterpartName') || run.counterparty.name, rep: g('counterpartRepName') || cp?.repName || null, address: g('counterpartAddress') || cp?.address || null, bizType: cp?.bizType ?? null, bizItem: cp?.bizItem ?? null, email: g('counterpartEmail') || run.email.value },
  };
}

/** 저장해 둔 양식 값을 다시 읽을 때 쓰는 검사. 모양이 틀리면 null(다시 만들지 않는다). */
export function parseInvoiceForm(v: unknown): InvoiceForm | null {
  const o = v as Partial<InvoiceForm> | null;
  const str = (x: unknown) => typeof x === 'string';
  const fin = (x: unknown) => typeof x === 'number' && Number.isFinite(x);
  const party = (p: unknown) => !!p && typeof p === 'object' && str((p as Party).bizNo) && str((p as Party).name);
  if (!o || typeof o !== 'object' || !str(o.approvalNo) || !str(o.issueDate) || !party(o.supplier) || !party(o.buyer)) return null;
  if (o.receipt !== '영수' && o.receipt !== '청구') return null;
  if (!Array.isArray(o.items) || !o.items.length || o.items.length > MAX_ITEMS || !o.items.every((x) => x && str(x.name) && fin(x.supply) && fin(x.tax))) return null;
  return o as InvoiceForm;
}
