import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { invoiceRoleOfHeader, parseAmountKo, parseInvoiceBatch, parseInvoiceDate, parseInvoiceText } from '@sax/docparse';
import { encodeEucKr, writeXlsx, type FixtureCell } from '@sax/docparse/fixtures';
import { readSheetBytes } from '@sax/docparse/sandbox';

const TODAY = '2026-11-24';

/** 검증 숫자가 맞는 가상 사업자번호 */
function biz(seed: number): string {
  const nine = String(100000000 + seed * 7919).slice(0, 9);
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(nine[i]) * w[i]!;
  sum += Math.floor((Number(nine[8]) * 5) / 10);
  return nine + String((10 - (sum % 10)) % 10);
}
const dash = (b: string) => `${b.slice(0, 3)}-${b.slice(3, 5)}-${b.slice(5)}`;

const xlsx = async (rows: FixtureCell[][], name = '매출') => readSheetBytes(await writeXlsx([{ name, rows }]));

describe('여러 건 발급 표 읽기(ADR-059)', () => {
  it('금액과 날짜 칸: 한글 단위, 괄호 음수, 연도 없는 날짜', () => {
    assert.equal(parseAmountKo('2,400,000원'), 2400000);
    assert.equal(parseAmountKo('330만원'), 3300000);
    assert.equal(parseAmountKo('1억 2천만'), 120000000);
    assert.equal(parseAmountKo('1.5억'), 150000000);
    assert.equal(parseAmountKo('3백만'), 3000000);
    assert.equal(parseAmountKo('만 3천'), null);
    assert.equal(parseAmountKo('(3,000)'), -3000);
    assert.equal(parseAmountKo('자재 납품'), null);
    assert.equal(parseAmountKo('만'), null);
    assert.equal(parseInvoiceDate('11/24', TODAY), '2026-11-24');
    assert.equal(parseInvoiceDate('11월 3일', TODAY), '2026-11-03');
    assert.equal(parseInvoiceDate(20261120, TODAY), '2026-11-20');
    assert.equal(parseInvoiceDate('2026.11.20', TODAY), '2026-11-20');
    assert.equal(parseInvoiceDate('모름', TODAY), null);
  });

  it('흔한 엑셀: 제목 줄 아래 머리글, 날짜 서식, 합계 줄은 뺀다', async () => {
    const out = await xlsx([
      ['11월 매출 내역'],
      [],
      ['거래처명', '사업자등록번호', '작성일자', '품목', '공급가액', '세액', '합계금액', '이메일'],
      ['한빛물산', dash(biz(1)), { date: '2026-11-24' }, '자재 납품', 2400000, 240000, 2640000, 'a@example.com'],
      ['가람건설', biz(2), { date: '2026-11-20' }, '11월 기성', 182000000, 18200000, 200200000, null],
      ['합계', null, null, null, 184400000, 18440000, 202840000],
    ]);
    const p = parseInvoiceBatch(out, { today: TODAY });
    assert.equal(p.rows.length, 2);
    assert.deepEqual(p.rows.map((r) => r.issues), [[], []]);
    assert.deepEqual(p.rows[0], {
      line: 4, bizNo: biz(1), subBizNo: null, name: '한빛물산', ceo: null, email: 'a@example.com', address: null, bizType: null, bizItem: null, date: '2026-11-24', dateSource: 'cell', taxType: 'taxable',
      supply: 2400000, vat: 240000, total: 2640000, lines: [{ item: '자재 납품', spec: null, qty: null, unitPrice: null, supply: 2400000, vat: 240000, memo: null }], memo: null, issues: [],
    });
    assert.equal(p.amountBasis, 'supply');
    assert.deepEqual(p.totals, { count: 2, ready: 2, parties: 2, supply: 184400000, vat: 18440000, total: 202840000 });
    assert.deepEqual(p.period, { from: '2026-11-20', to: '2026-11-24' });
    assert.equal(p.mapping?.headerRow, 2);
  });

  it('합계만 있는 표는 공급가액과 세액으로 나누고, 금액 하나뿐이면 공급가액으로 보고 알린다', async () => {
    const a = parseInvoiceBatch(await xlsx([['상호', '청구금액(VAT포함)'], ['나래소프트', 990000], ['다온식품', '13,695,000원']]), { today: TODAY });
    assert.deepEqual(a.rows.map((r) => [r.supply, r.vat, r.total, r.date, r.dateSource]), [[900000, 90000, 990000, TODAY, 'default'], [12450000, 1245000, 13695000, TODAY, 'default']]);
    assert.equal(a.amountBasis, 'total');
    const b = parseInvoiceBatch(await xlsx([['업체', '금액'], ['나래소프트', '90만원']]), { today: TODAY });
    assert.deepEqual([b.rows[0]!.supply, b.rows[0]!.vat, b.rows[0]!.total], [900000, 90000, 990000]);
    assert.equal(b.amountBasis, 'assumed_supply');
    assert.ok(b.warnings.includes('amount_basis_assumed'));
  });

  it('수량과 단가만 있으면 곱해서 공급가액, 영세율은 세액 0', async () => {
    const p = parseInvoiceBatch(await xlsx([['거래처', '품명', '규격', '수량', '단가', '과세구분'], ['동서기계', '베어링', 'B-12', 40, 920000, '과세'], ['마루전자', '수출 부품', null, 3, 2450000, '영세율']]), { today: TODAY });
    assert.deepEqual(p.rows.map((r) => [r.supply, r.vat, r.taxType]), [[36800000, 3680000, 'taxable'], [7350000, 0, 'zero']]);
    assert.deepEqual(p.rows[0]!.lines[0], { item: '베어링', spec: 'B-12', qty: 40, unitPrice: 920000, supply: 36800000, vat: 3680000, memo: null });
  });

  it('확인할 건: 틀린 사업자번호, 빈 금액, 안 맞는 합계, 미래 날짜, 같은 줄 두 번', async () => {
    const p = parseInvoiceBatch(await xlsx([
      ['거래처', '사업자번호', '일자', '품목', '공급가액', '부가세', '합계'],
      ['대한테크', dash(biz(1).slice(0, 9) + String((Number(biz(1)[9]) + 1) % 10)), '2026-11-24', '유지보수', 3000000, 300000, 3300000],
      ['세진유통', biz(3), '2026-11-24', '물류 대행', 5200000, 520000, 5720000],
      ['세진유통', biz(3), '2026-11-24', '물류 대행', 5200000, 520000, 5720000],
      ['우림상사', biz(4), '2026-11-24', '자재 납품', null, null, null],
      ['보람인쇄', biz(5), '2026-11-24', '인쇄물', 1800000, 180000, 1990000],
      ['미래포장', biz(6), '2026-12-01', '포장재', 2150000, 215000, 2365000],
      ['새솔기획', biz(7), '날짜 미정', '기획', 4000000, 400000, 4400000],
      [null, null, '2026-11-24', '이름 없음', 100000, 10000, 110000],
    ]), { today: TODAY });
    assert.deepEqual(p.rows.map((r) => r.issues), [['bizno_invalid'], [], ['duplicate_in_file'], ['amount_missing'], ['amount_mismatch'], ['date_future'], ['date_invalid'], ['party_filled_down']]);
    assert.equal(p.totals.ready, 1);
    assert.equal(p.totals.total, 5720000);
  });

  it('병합 칸으로 거래처가 첫 줄에만 있으면 아래 줄에 내려 채우고 확인할 건으로 둔다', async () => {
    const p = parseInvoiceBatch(await xlsx([['거래처', '품목', '공급가액'], ['한빛물산', '자재', 1000000], [null, '운반비', 200000]]), { today: TODAY });
    assert.deepEqual(p.rows.map((r) => [r.name, r.supply, r.issues]), [['한빛물산', 1000000, []], ['한빛물산', 200000, ['party_filled_down']]]);
  });

  it('홈택스 일괄 양식: 공급자 칸은 읽지 않고 공급받는자와 품목 줄을 읽는다', async () => {
    const head = ['종류', '작성일자', '공급자등록번호', '공급자상호', '공급자성명', '공급받는자등록번호', '공급받는자종사업장번호', '공급받는자상호', '공급받는자성명', '공급받는자이메일1', '공급가액', '세액', '비고', '일자1', '품목1', '규격1', '수량1', '단가1', '공급가액1', '세액1', '품목비고1', '일자2', '품목2', '규격2', '수량2', '단가2', '공급가액2', '세액2', '품목비고2', '영수청구'];
    const p = parseInvoiceBatch(await xlsx([
      head,
      ['01', '20261124', biz(9), '우리가게', '김가상', biz(1), '0001', '한빛물산', '이대표', 'han@example.com', 2400000, 240000, '11월분', '24', '자재', 'A', 2, 1000000, 2000000, 200000, null, '24', '운반비', null, 1, 400000, 400000, 40000, null, '02'],
      ['02', '20261124', biz(9), '우리가게', '김가상', biz(2), null, '가람건설', '박대표', null, 5000000, 0, null, '24', '수출 자재', null, null, null, 5000000, 0, null, null, null, null, null, null, null, null, null, '02'],
    ]), { today: TODAY });
    assert.deepEqual(p.rows.map((r) => r.issues), [[], []]);
    const a = p.rows[0]!;
    assert.deepEqual([a.bizNo, a.subBizNo, a.name, a.ceo, a.email, a.date, a.supply, a.vat, a.total, a.memo, a.taxType], [biz(1), '0001', '한빛물산', '이대표', 'han@example.com', '2026-11-24', 2400000, 240000, 2640000, '11월분', 'taxable']);
    assert.deepEqual(a.lines.map((l) => [l.item, l.qty, l.unitPrice, l.supply, l.vat]), [['자재', 2, 1000000, 2000000, 200000], ['운반비', 1, 400000, 400000, 40000]]);
    assert.deepEqual([p.rows[1]!.taxType, p.rows[1]!.vat, p.rows[1]!.total], ['zero', 0, 5000000]);
  });

  it('머리글이 없는 표는 칸 내용으로 열을 짐작한다', async () => {
    const p = parseInvoiceBatch(await xlsx([
      ['한빛물산', dash(biz(1)), '2026-11-24', '자재 납품', 2400000, 240000, 2640000],
      ['가람건설', dash(biz(2)), '2026-11-20', '11월 기성', 182000000, 18200000, 200200000],
      ['나래소프트', dash(biz(3)), '2026-11-24', '월 구독', 900000, 90000, 990000],
    ]), { today: TODAY });
    assert.ok(p.warnings.includes('header_inferred'));
    assert.equal(p.mapping?.headerRow, -1);
    assert.deepEqual(p.rows.map((r) => [r.name, r.bizNo, r.date, r.lines[0]?.item, r.supply, r.vat, r.total, r.issues.length]), [
      ['한빛물산', biz(1), '2026-11-24', '자재 납품', 2400000, 240000, 2640000, 0],
      ['가람건설', biz(2), '2026-11-20', '11월 기성', 182000000, 18200000, 200200000, 0],
      ['나래소프트', biz(3), '2026-11-24', '월 구독', 900000, 90000, 990000, 0],
    ]);
  });

  it('모르는 머리글은 머리글 줄로 보고 건너뛴다', async () => {
    const p = parseInvoiceBatch(await xlsx([['A사 목록', '얼마'], ['한빛물산', 2400000], ['가람건설', 182000000]]), { today: TODAY });
    assert.deepEqual(p.rows.map((r) => [r.name, r.supply]), [['한빛물산', 2400000], ['가람건설', 182000000]]);
    assert.equal(p.mapping?.headerRow, 0);
  });

  it('사람이나 모델이 고른 열(mapping)을 그대로 쓴다', async () => {
    const out = await xlsx([['A', 'B', 'C'], ['2,640,000', '한빛물산', '메모'], ['990,000', '나래소프트', null]]);
    const p = parseInvoiceBatch(out, { today: TODAY, mapping: { sheet: '매출', headerRow: 0, columns: { name: 1, total: 0 } } });
    assert.deepEqual(p.rows.map((r) => [r.name, r.supply, r.vat, r.total]), [['한빛물산', 2400000, 240000, 2640000], ['나래소프트', 900000, 90000, 990000]]);
  });

  it('CSV(EUC-KR)와 읽을 열이 없는 표', async () => {
    const csv = encodeEucKr(['거래처,사업자번호,공급가액,세액', `라온디자인,${dash(biz(8))},"4,000,000","400,000"`].join('\r\n'));
    const p = parseInvoiceBatch(await readSheetBytes(csv), { today: TODAY });
    assert.deepEqual([p.rows[0]!.name, p.rows[0]!.bizNo, p.rows[0]!.total], ['라온디자인', biz(8), 4400000]);
    assert.ok(p.warnings.includes('encoding_euc_kr'));
    const none = parseInvoiceBatch(await xlsx([['메모'], ['안녕하세요'], ['내일 봬요']]), { today: TODAY });
    assert.ok(none.warnings.includes('header_not_found'));
    assert.equal(none.rows.length, 0);
    assert.deepEqual(none.sample[0], ['메모']);
  });

  it('붙여 넣은 글: 엑셀 복사(탭), 마크다운 표, 빈칸으로 띄운 줄, 쉼표', () => {
    const tab = parseInvoiceText(`거래처\t공급가액\t세액\n한빛물산\t2,400,000\t240,000\n가람건설\t182,000,000\t18,200,000`, { today: TODAY });
    assert.deepEqual(tab.rows.map((r) => [r.name, r.total]), [['한빛물산', 2640000], ['가람건설', 200200000]]);
    const md = parseInvoiceText(`| 거래처 | 합계 |\n|---|---|\n| 한빛물산 | 2,640,000 |\n| 나래소프트 | 990,000 |`, { today: TODAY });
    assert.deepEqual(md.rows.map((r) => [r.name, r.supply, r.total]), [['한빛물산', 2400000, 2640000], ['나래소프트', 900000, 990000]]);
    const loose = parseInvoiceText(`한빛물산 ${dash(biz(1))} 11/24 자재 납품 2,400,000\n가람 건설 ${dash(biz(2))} 11/20 11월 기성 1억 8200만\n나래소프트 ${dash(biz(3))} 11/24 월 구독 90만원`, { today: TODAY });
    assert.deepEqual(loose.rows.map((r) => [r.name, r.bizNo, r.date, r.lines[0]?.item, r.supply, r.issues.length]), [
      ['한빛물산', biz(1), '2026-11-24', '자재 납품', 2400000, 0],
      ['가람 건설', biz(2), '2026-11-20', '11월 기성', 182000000, 0],
      ['나래소프트', biz(3), '2026-11-24', '월 구독', 900000, 0],
    ]);
    const comma = parseInvoiceText(`한빛물산, 3,300,000\n대한테크, 5,500,000`, { today: TODAY });
    assert.deepEqual(comma.rows.map((r) => [r.name, r.supply]), [['한빛물산', 3300000], ['대한테크', 5500000]]);
  });

  it('300줄 파일', async () => {
    const rows: FixtureCell[][] = [['거래처', '사업자번호', '작성일', '품목', '공급가액']];
    for (let i = 0; i < 300; i++) rows.push([`거래처${i}`, biz(100 + i), '2026-11-24', '월 임대료', 1000000 + i * 1000]);
    const p = parseInvoiceBatch(await xlsx(rows), { today: TODAY });
    assert.equal(p.totals.ready, 300);
    assert.equal(p.totals.parties, 300);
    assert.equal(p.totals.supply, 300 * 1000000 + (299 * 300 / 2) * 1000);
  });

  it('열 고르기 기본값', () => {
    assert.equal(invoiceRoleOfHeader('공급받는자 등록번호'), 'biz_no');
    assert.equal(invoiceRoleOfHeader('공급자 등록번호'), null);
    assert.equal(invoiceRoleOfHeader('금액(부가세 별도)'), 'supply');
    assert.equal(invoiceRoleOfHeader('금액(VAT 포함)'), 'total');
    assert.equal(invoiceRoleOfHeader('거래처 담당자'), null);
  });
  it('경계값: 0원, 음수, 빈 칸, 공백만 있는 줄, 없는 날짜, 5000줄 상한', () => {
    const p = parseInvoiceText([
      '거래처\t사업자등록번호\t작성일자\t품목\t공급가액\t세액\t합계',
      `영원상사\t${biz(1)}\t2026-11-20\t자재\t0\t0\t0`,
      `세액만\t${biz(2)}\t2026-11-20\t자재\t0\t100\t100`,
      `반품상사\t${biz(3)}\t2026-11-20\t자재\t-1,000\t-100\t-1,100`,
      `빈금액\t${biz(4)}\t2026-11-20\t자재\t\t\t`,
      `줄표금액\t${biz(5)}\t2026-11-20\t자재\t-\t-\t-`,
      `날짜없음\t${biz(6)}\t\t자재\t1000\t100\t1100`,
      `없는날\t${biz(7)}\t2026-13-40\t자재\t1000\t100\t1100`,
      '   \t   \t  \t  \t \t \t ',
    ].join('\n'), { today: TODAY });
    assert.deepEqual(p.rows.map((r) => [r.name, r.supply, r.vat, r.issues]), [
      ['영원상사', 0, 0, ['amount_zero']],
      ['세액만', 0, 100, ['amount_zero', 'vat_unusual']],
      ['반품상사', -1000, -100, ['amount_negative']],
      ['빈금액', null, null, ['amount_missing']],
      ['줄표금액', null, null, ['amount_missing']],
      ['날짜없음', 1000, 100, []],
      ['없는날', 1000, 100, ['date_invalid']],
    ]);
    assert.deepEqual([p.rows[5]!.date, p.rows[5]!.dateSource], [TODAY, 'default'], '빈 날짜는 오늘');
    assert.deepEqual([p.totals.count, p.totals.ready, p.totals.total], [7, 1, 1100], '확인할 건은 합계에 넣지 않는다');

    const many = Array.from({ length: 5001 }, (_, i) => `한빛물산\t${1000 + i}`);
    const big = parseInvoiceText(['거래처\t공급가액', ...many].join('\n'), { today: TODAY });
    assert.equal(big.rows.length, 5000);
    assert.ok(big.warnings.includes('sheet_truncated'));
  });
});
