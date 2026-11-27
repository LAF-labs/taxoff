import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { MAX_ITEMS, formFromRun, invoiceFormHtml, invoiceTotals, parseInvoiceForm, receiptOf, type InvoiceForm } from '../apps/desktop/src/invoice-form.ts';
import { InvoiceFiles, invoiceFonts, invoicePdf, mailInvoice, mailRequest } from '../apps/desktop/src/invoice-pdf.ts';
import type { InvoiceMailRequest } from '../apps/desktop/src/remote-ports.ts';

const STATIC = path.join(import.meta.dirname, '../apps/desktop/static');

const run = {
  counterparty: { name: 'A상사', bizNo: '2345678901' },
  email: { value: 'tax@a.example' },
  item: '컨설팅',
  supply: 3_300_000,
  tax: 330_000,
  writeDate: '2026-11-23',
  result: { approvalNo: '20261123-41000012-00000123' },
};
const me = { bizNo: '1234567890', name: '가나다컴퍼니', rep: '홍길동', address: '서울 강남구', bizType: '서비스', bizItem: '컨설팅', email: 'ceo@g.example' };

const form = (o: Partial<InvoiceForm> = {}): InvoiceForm => ({
  approvalNo: '202611234100001200000123',
  issueDate: '2026-11-23',
  supplier: { bizNo: '1234567890', name: '가나다컴퍼니', email: 'ceo@g.example' },
  buyer: { bizNo: '2345678901', name: 'A상사', email: 'tax@a.example' },
  items: [{ name: '컨설팅', qty: 1, unitPrice: 3_000_000, supply: 3_000_000, tax: 300_000 }],
  receipt: '청구',
  ...o,
});

describe('앱이 만드는 세금계산서 PDF: 양식 값', () => {
  it('홈택스 되읽기 값이 실행 값보다 먼저고, 장부 값으로 빈 칸을 채운다', () => {
    const rb = new Map([['itemName', '경영 컨설팅'], ['supplyAmount', '3,000,000'], ['taxAmount', '300000'], ['receiptType', '영수'], ['counterpartName', 'A상사(주)'], ['supplierRepName', '홍대표'], ['supplierEmailId', 'boss'], ['supplierEmailDomain', 'g.example'], ['itemCount', '3']]);
    const f = formFromRun(run, rb, me, { repName: '김철수', address: '성남시', bizType: '제조', bizItem: '식품' })!;
    assert.deepEqual(f.items, [{ name: '경영 컨설팅', qty: 3, unitPrice: 1_000_000, supply: 3_000_000, tax: 300_000 }]);
    assert.equal(f.receipt, '영수');
    assert.equal(f.buyer.name, 'A상사(주)');
    assert.equal(f.buyer.rep, '김철수');
    assert.equal(f.buyer.bizType, '제조');
    assert.equal(f.supplier.rep, '홍대표');
    assert.equal(f.supplier.email, 'boss@g.example');
    assert.equal(f.supplier.address, '서울 강남구');
  });

  it('승인번호가 없으면 만들지 않는다', () => {
    assert.equal(formFromRun({ ...run, result: null }, undefined, me, null), null);
  });

  it('표준 양식 칸이 다 있고, 값은 이스케이프한다', () => {
    const f = formFromRun({ ...run, item: '<script>x</script>' }, undefined, me, null)!;
    const html = invoiceFormHtml(f);
    for (const k of ['전자세금계산서', '승인번호', '공급자', '공급받는자', '등록번호', '종사업장', '작성일자', '공급가액', '세액', '수정사유', '합계금액', '이 금액을 (청구) 함', '123-45-67890', '3,630,000', '택스오프가 홈택스 발급 내용으로 만든 사본이에요'])
      assert.ok(html.includes(k), k);
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('수정전자세금계산서'));
    assert.equal(receiptOf('01'), '영수');
    assert.equal(receiptOf(''), '청구');
  });

  it('여러 품목: 줄마다 월일, 합계는 품목 합, 16줄까지(넘으면 거절), 7줄부터 촘촘하게', () => {
    const items = Array.from({ length: MAX_ITEMS }, (_, i) => ({ date: `2026-11-${String(i + 1).padStart(2, '0')}`, name: `품목${i + 1}`, qty: 2, unitPrice: 500, supply: 1000, tax: 100 }));
    const f = form({ items });
    assert.deepEqual(invoiceTotals(f), { supply: 16_000, tax: 1_600, total: 17_600 });
    const html = invoiceFormHtml(f);
    for (let i = 1; i <= MAX_ITEMS; i++) assert.ok(html.includes(`>품목${i}<`), `품목${i}`);
    assert.ok(html.includes('class="f items dense"'));
    assert.ok(html.includes('>17,600<'));
    assert.throws(() => invoiceFormHtml(form({ items: [...items, items[0]!] })), /invoice_too_many_items/);
    assert.throws(() => invoiceFormHtml(form({ items: [] })), /invoice_no_items/);
  });

  it('큰 금액은 자르지 않고 글자를 줄인다, 승인번호는 8-8-8로 보인다', () => {
    const html = invoiceFormHtml(form({ items: [{ name: '설비', qty: 1, unitPrice: 98_765_432_100_000, supply: 98_765_432_100_000, tax: 9_876_543_210_000 }] }));
    assert.ok(html.includes('<td class="n xs">98,765,432,100,000</td>'));
    assert.ok(html.includes('108,641,975,310,000'));
    assert.ok(html.includes('20261123-41000012-00000123'));
  });

  it('수정세금계산서(ADR-058): 제목, 수정사유, 비고의 당초 승인번호, 음수 금액', () => {
    const html = invoiceFormHtml(form({ amend: { reason: '계약의 해제', originalApprovalNo: '202611014100001200000001' }, items: [{ name: '컨설팅', supply: -3_000_000, tax: -300_000 }] }));
    for (const k of ['수정전자세금계산서', '>계약의 해제<', '당초 승인번호 20261101-41000012-00000001', '-3,300,000']) assert.ok(html.includes(k), k);
  });

  it('글꼴을 넘기면 PDF에 심을 @font-face가 들어간다(앱에 든 Noto Sans KR, 한글 11,172자)', async () => {
    const fonts = await invoiceFonts(STATIC);
    assert.ok(fonts.regular.length > 100_000 && fonts.bold.length > 100_000);
    const html = invoiceFormHtml(form(), { fonts });
    assert.ok(html.includes('font-family:"SAX Invoice";font-weight:400;src:url(data:font/woff2;base64,'));
    assert.ok(html.includes('font-weight:700;src:url(data:font/woff2;base64,'));
    await fs.access(path.join(STATIC, 'fonts', 'OFL.txt'));
  });

  it('저장한 양식 값은 모양을 검사해 다시 읽는다', () => {
    assert.deepEqual(parseInvoiceForm(JSON.parse(JSON.stringify(form()))), form());
    assert.equal(parseInvoiceForm({ ...form(), items: [] }), null);
    assert.equal(parseInvoiceForm({ ...form(), receipt: 'x' }), null);
    assert.equal(parseInvoiceForm(null), null);
  });
});

describe('앱이 만드는 세금계산서 PDF: 파일과 거래처 메일', () => {
  const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'sax-inv-'));
  const PDF = new TextEncoder().encode('%PDF-1.4\n%%EOF\n');

  it('PDF와 양식 값은 본인만 읽는 파일로 남고, PDF가 없어지면 양식 값으로 다시 그릴 수 있다', async () => {
    const dir = path.join(await tmp(), 'issued-pdf');
    const files = new InvoiceFiles(dir);
    const html: string[] = [];
    const pdf = await invoicePdf(form(), STATIC, async (h) => (html.push(h), PDF));
    assert.ok(html[0]!.includes('SAX Invoice'));
    const f = await files.save('run-1/../x', form(), pdf);
    assert.equal(path.dirname(f), dir);
    assert.equal(path.basename(f), '전자세금계산서_A상사_20261123.pdf', '파일 이름은 서류명_거래처명_작성일자(대표 11-25)');
    assert.equal(await files.save('run-1/../x', form(), pdf), f, '같은 실행은 같은 파일');
    assert.equal(path.basename(await files.save('run-2', form(), pdf)), '전자세금계산서_A상사_20261123_2.pdf', '같은 거래처 같은 날 두 번째는 _2');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(f)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(dir)).mode & 0o777, 0o700);
    }
    assert.deepEqual(await files.form('run-1/../x'), form());
    assert.equal(await files.exists('run-1/../x'), true);
    assert.equal(await files.form('none'), null);
  });

  it('메일 요청: 받는 주소는 거래처, 본문 연락처는 공급자 주소, 합계는 품목 합, 주소가 없으면 보내지 않는다', () => {
    const r = mailRequest(form(), PDF)!;
    assert.deepEqual({ ...r, pdf: null }, { to: 'tax@a.example', supplierEmail: 'ceo@g.example', supplierName: '가나다컴퍼니', buyerName: 'A상사', approvalNo: '202611234100001200000123', issueDate: '2026-11-23', total: 3_300_000, pdf: null });
    assert.equal(mailRequest(form({ buyer: { bizNo: '2345678901', name: 'A상사', email: '' } }), PDF), null);
    assert.equal(mailRequest(form({ buyer: { bizNo: '2345678901', name: 'A상사', email: 'x@y' } }), PDF), null);
    assert.equal(mailRequest(form({ supplier: { bizNo: '1', name: '나', email: 'TAX@a.example' } }), PDF)!.supplierEmail, null);
  });

  it('메일은 한 번만 보낸다, 토큰 만료면 한 번 새로 받는다, 로그아웃이면 보내지 않는다', async () => {
    const files = new InvoiceFiles(path.join(await tmp(), 'p'));
    const sent: InvoiceMailRequest[] = [];
    let fail: string | null = 'account.unauthorized';
    let cleared = 0;
    const client = {
      sendInvoiceMail: async (_a: unknown, m: InvoiceMailRequest) => {
        if (fail) {
          const code = fail;
          fail = null;
          throw Object.assign(new Error(code), { code });
        }
        sent.push(m);
      },
    };
    const device = async () => ({ auth: async () => ({}), clearToken: () => void cleared++ });
    const logs: string[] = [];
    const d = { files, client, device, log: (n: string) => void logs.push(n) };
    assert.equal(await mailInvoice(d, 'r1', form(), PDF), 'sent');
    assert.equal(cleared, 1);
    assert.equal(sent.length, 1);
    assert.equal(await mailInvoice(d, 'r1', form(), PDF), 'already');
    assert.equal(sent.length, 1);
    fail = 'account.mail_unavailable';
    assert.equal(await mailInvoice(d, 'r2', form(), PDF), 'failed');
    assert.equal(await mailInvoice(d, 'r2', form(), PDF), 'sent');
    assert.equal(await mailInvoice({ ...d, device: async () => null }, 'r3', form(), PDF), 'signed_out');
    assert.equal(await mailInvoice({ ...d, client: null }, 'r3', form(), PDF), 'signed_out');
    assert.equal(await mailInvoice(d, 'r4', form({ buyer: { bizNo: '2', name: 'B' } }), PDF), 'no_address');
    assert.deepEqual(logs, ['main.invoice_mail_sent', 'main.invoice_mail_failed', 'main.invoice_mail_sent']);
  });
});
