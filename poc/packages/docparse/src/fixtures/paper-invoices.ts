/**
 * 합성 종이 세금계산서와 계산서(사람이 찍은 사진 대신, ADR-073 글자 읽기 실측용). 사업자번호는 체크섬만 맞춘 가짜이고 상호와 주소도 지어낸 것이다.
 * 양식은 국세청 고시 세금계산서 양식의 칸 배치를 따른다(공급자 왼쪽, 공급받는자 오른쪽, 작성일자와 공급가액 줄, 품목 표, 합계금액과 영수/청구).
 */
import { fakeBizNo, fmtBiz } from './receipts.ts';

export interface SyntheticPaperParty {
  bizNo: string;
  name: string;
  ceo: string;
  address: string;
  type: string;
  item: string;
}

export interface SyntheticPaperInvoice {
  id: string;
  docKind: 'tax_invoice' | 'invoice';
  /** 공급자 보관용(빨강)이면 매출, 공급받는자 보관용(파랑)이면 매입 */
  copy: 'supplier' | 'buyer';
  /** printed: 숫자를 한 칸에 인쇄, grid: 공급가액과 세액을 자리마다 한 칸씩 */
  digits: 'printed' | 'grid';
  writtenOn: string;
  supplier: SyntheticPaperParty;
  buyer: SyntheticPaperParty;
  items: Array<{ month: number; day: number; name: string; spec: string; qty: number; unitPrice: number; supply: number; vat: number }>;
  supplyAmount: number;
  vatAmount: number;
  total: number;
  receiptOrClaim: 'receipt' | 'claim';
}

const party = (seed: number, name: string, ceo: string, address: string, type: string, item: string): SyntheticPaperParty => ({ bizNo: fmtBiz(fakeBizNo(seed)), name, ceo, address, type, item });

export function syntheticPaperInvoices(): SyntheticPaperInvoice[] {
  const me = party(11, '하늘상회', '김하늘', '서울특별시 마포구 하늘로 12', '소매', '커피');
  const a = party(23, '대한식자재', '이대한', '경기도 고양시 덕양구 식자재로 5', '도매', '식자재');
  const b = party(37, '동네빵집', '박동네', '서울특별시 은평구 빵길 3', '제조', '제과');
  const items1 = [{ month: 10, day: 28, name: '원두', spec: '1kg', qty: 10, unitPrice: 25_000, supply: 250_000, vat: 25_000 }, { month: 10, day: 28, name: '우유', spec: '1L', qty: 20, unitPrice: 2_500, supply: 50_000, vat: 5_000 }];
  const items2 = [{ month: 10, day: 7, name: '원두 납품', spec: '500g', qty: 40, unitPrice: 15_000, supply: 600_000, vat: 60_000 }];
  const items3 = [{ month: 10, day: 15, name: '밀가루', spec: '20kg', qty: 3, unitPrice: 42_000, supply: 126_000, vat: 0 }];
  return [
    { id: 'buy-printed', docKind: 'tax_invoice', copy: 'buyer', digits: 'printed', writtenOn: '2026-10-28', supplier: a, buyer: me, items: items1, supplyAmount: 300_000, vatAmount: 30_000, total: 330_000, receiptOrClaim: 'claim' },
    { id: 'buy-grid', docKind: 'tax_invoice', copy: 'buyer', digits: 'grid', writtenOn: '2026-10-28', supplier: a, buyer: me, items: items1, supplyAmount: 300_000, vatAmount: 30_000, total: 330_000, receiptOrClaim: 'receipt' },
    { id: 'sale-printed', docKind: 'tax_invoice', copy: 'supplier', digits: 'printed', writtenOn: '2026-10-07', supplier: me, buyer: b, items: items2, supplyAmount: 600_000, vatAmount: 60_000, total: 660_000, receiptOrClaim: 'claim' },
    { id: 'exempt-buy', docKind: 'invoice', copy: 'buyer', digits: 'printed', writtenOn: '2026-10-15', supplier: a, buyer: me, items: items3, supplyAmount: 126_000, vatAmount: 0, total: 126_000, receiptOrClaim: 'receipt' },
  ];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const n = (v: number) => v.toLocaleString('ko-KR');

/** 사진처럼 보이게 기울이기(tilt, 도)와 바랜 종이(faded)를 고를 수 있다 */
export function paperInvoiceHtml(p: SyntheticPaperInvoice, o: { tilt?: number; faded?: boolean } = {}): string {
  const ink = p.copy === 'supplier' ? '#c43c3c' : '#2f5fb3';
  const title = p.docKind === 'tax_invoice' ? '세 금 계 산 서' : '계 산 서';
  const copy = p.copy === 'supplier' ? '(공급자 보관용)' : '(공급받는자 보관용)';
  const side = (label: string, q: SyntheticPaperParty) => `
    <td class="v" rowspan="4">${label}</td>
    <td class="k">등록번호</td><td class="d" colspan="3">${q.bizNo}</td>`;
  const side2 = (q: SyntheticPaperParty) => `<td class="k">상호(법인명)</td><td class="d">${esc(q.name)}</td><td class="k">성명</td><td class="d">${esc(q.ceo)}</td>`;
  const side3 = (q: SyntheticPaperParty) => `<td class="k">사업장주소</td><td class="d" colspan="3">${esc(q.address)}</td>`;
  const side4 = (q: SyntheticPaperParty) => `<td class="k">업태</td><td class="d">${esc(q.type)}</td><td class="k">종목</td><td class="d">${esc(q.item)}</td>`;
  const amount = (v: number) => (p.digits === 'grid' ? `<span class="grid">${String(v).split('').map((c) => `<i>${c}</i>`).join('')}</span>` : n(v));
  const [y, m, d] = p.writtenOn.split('-').map(Number) as [number, number, number];
  const vatCols = p.docKind === 'tax_invoice';
  const color = o.faded ? '#444' : '#111';
  return `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#ddd8cc}
.f{width:1060px;margin:30px auto;padding:22px;background:#fbf9f2;color:${color};font:17px/1.35 'Apple SD Gothic Neo','Malgun Gothic','Noto Sans KR',sans-serif;transform:rotate(${o.tilt ?? 0}deg)}
table{width:100%;border-collapse:collapse}
td{border:1.5px solid ${ink};padding:7px 8px;vertical-align:middle}
.k,.v,.h{color:${ink};white-space:nowrap}
.v{width:22px;text-align:center;writing-mode:vertical-rl;letter-spacing:6px}
.h{text-align:center}
.t{font-size:30px;letter-spacing:6px;color:${ink};text-align:center;padding:10px}
.num{text-align:right}
.grid i{display:inline-block;width:18px;border-left:1px solid ${ink};text-align:center;font-style:normal}
.mark{color:${ink}}
</style><div class="f">
<table><tr><td class="t" colspan="3">${title} <span style="font-size:18px">${copy}</span></td><td class="k">책번호</td><td>12 권 7 호</td><td class="k">일련번호</td><td>0034</td></tr></table>
<table>
<tr>${side('공급자', p.supplier)}${side('공급받는자', p.buyer)}</tr>
<tr>${side2(p.supplier)}${side2(p.buyer)}</tr>
<tr>${side3(p.supplier)}${side3(p.buyer)}</tr>
<tr>${side4(p.supplier)}${side4(p.buyer)}</tr>
</table>
<table>
<tr><td class="h" colspan="3">작성</td><td class="h">공급가액</td>${vatCols ? '<td class="h">세액</td>' : ''}<td class="h">비고</td></tr>
<tr><td class="h">${y}</td><td class="h">${m}</td><td class="h">${d}</td><td class="num">${amount(p.supplyAmount)}</td>${vatCols ? `<td class="num">${amount(p.vatAmount)}</td>` : ''}<td></td></tr>
</table>
<table>
<tr><td class="h">월</td><td class="h">일</td><td class="h">품목</td><td class="h">규격</td><td class="h">수량</td><td class="h">단가</td><td class="h">공급가액</td>${vatCols ? '<td class="h">세액</td>' : ''}<td class="h">비고</td></tr>
${p.items.map((it) => `<tr><td class="h">${it.month}</td><td class="h">${it.day}</td><td>${esc(it.name)}</td><td>${esc(it.spec)}</td><td class="num">${it.qty}</td><td class="num">${n(it.unitPrice)}</td><td class="num">${n(it.supply)}</td>${vatCols ? `<td class="num">${n(it.vat)}</td>` : ''}<td></td></tr>`).join('')}
<tr><td>&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td>${vatCols ? '<td></td>' : ''}<td></td></tr>
</table>
<table>
<tr><td class="h">합계금액</td><td class="h">현금</td><td class="h">수표</td><td class="h">어음</td><td class="h">외상미수금</td><td class="h" rowspan="2">이 금액을 <span class="mark">${p.receiptOrClaim === 'receipt' ? '영수' : '청구'}</span> 함</td></tr>
<tr><td class="num">${n(p.total)}</td><td></td><td></td><td></td><td class="num">${p.receiptOrClaim === 'claim' ? n(p.total) : ''}</td></tr>
</table></div>`;
}
