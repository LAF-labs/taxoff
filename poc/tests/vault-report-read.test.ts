import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { connectRunBrowser, type RunBrowser } from '@sax/engine';
import { startHarness, type Harness } from './harness.ts';
import { kstToday, startHometaxFake, type HometaxFake } from './hometax-fake.ts';
import type { FakeReportData } from './hometax-fake-report.ts';

/** 지난달(한국 날짜 기준) yyyy-mm. 시험 자료는 이 달과 그 앞 달에 둔다. */
const today = kstToday();
const shift = (ym: string, n: number) => {
  const t = new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};
const M = shift(today.slice(0, 7), -1);
const PREV = shift(M, -1);
const last = (ym: string) => `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
const day = (ym: string, d: number) => `${ym}-${String(d).padStart(2, '0')}`;
const q = (ym: string) => Math.floor((Number(ym.slice(5, 7)) - 1) / 3);
const QSTART = `${M.slice(0, 4)}-${String(q(M) * 3 + 1).padStart(2, '0')}-01`;
const QEND = last(`${M.slice(0, 4)}-${String(q(M) * 3 + 3).padStart(2, '0')}`);
const CARD = '9410123456781234';

const n = (k: number, d = 8) => String(k).padStart(d, '0');
function data(): Partial<FakeReportData> {
  return {
    // 매입 세금계산서 60건(50줄 쪽 2개) + 앞 달 1건(기간 밖)
    purchases: [...Array.from({ length: 60 }, (_, i) => ({
      etan: `${M.replace('-', '')}01-${n(41000000 + i)}-${n(i + 1)}`, wrtDt: day(M, (i % 28) + 1), splrTxprDscmNo: '214-86-51233', tnmNm: `공급처${i + 1}`, rprsFnm: '박공급', lsatNm: ' 원두 ',
      totaAmtStr: (110_000 + i).toLocaleString('en-US'), sumSplCftStr: '100,000', sumTxamtStr: (10_000 + i).toLocaleString('en-US'),
    })), { etan: `${PREV.replace('-', '')}01-41999999-00000099`, wrtDt: day(PREV, 3), splrTxprDscmNo: '214-86-51233', tnmNm: '앞달', rprsFnm: '박', lsatNm: '', totaAmtStr: '11,000', sumSplCftStr: '10,000', sumTxamtStr: '1,000' }],
    cashIn: [
      { pblClCd: '사업자', trsDtm: `${day(M, 3)} 10:11:12`, splCft: '9091', vaTxamt: '909', tip: '0', totaTrsAmt: '10000', aprvNo: 'J12345678', spstCnfrPartNo: '1234', trsClNm: '승인거래', cshptUsgClNm: '소비자소득공제용', cshptTrsTypeNm: '일반거래' },
      { pblClCd: '사업자', trsDtm: `${day(M, 4)} 09:00:00`, splCft: '9091', vaTxamt: '909', tip: '0', totaTrsAmt: '10000', aprvNo: 'J12345679', spstCnfrPartNo: '1234', trsClNm: '취소거래', cshptUsgClNm: '소비자소득공제용', cshptTrsTypeNm: '일반거래' },
      { pblClCd: '사업자', trsDtm: `${day(PREV, 4)} 09:00:00`, splCft: '1', vaTxamt: '0', tip: '0', totaTrsAmt: '1', aprvNo: 'J99999999', spstCnfrPartNo: '1234', trsClNm: '승인거래', cshptUsgClNm: '', cshptTrsTypeNm: '' },
    ],
    // 현금영수증 매입 23건(10줄 쪽 3개)
    cashOut: Array.from({ length: 23 }, (_, i) => ({
      trsDtTime: `${day(M, (i % 28) + 1)} 12:00:00`, cardOwnrNm: '가나다컴퍼니', mrntTxprDscmNoEncCntn: '220-81-62517', mrntTxprNm: `가게${i + 1}`, splCft: '4545', vaTxamt: '455', tip: '0', totaTrsAmt: '5000',
      aprvNo: i % 2 ? `K${n(i + 1)}` : `1${n(i + 1)}`, spstCnfrPartNo: '5678', trsClNm: '승인거래', trsDt: day(M, (i % 28) + 1).replace(/-/g, ''), prhTxamtDdcClNm: i % 3 ? '공제' : '불공제',
    })),
    // 사업용 카드 45건(20줄 쪽 3개). 카드번호는 16자리 전체가 온다(실측)
    bizCard: Array.from({ length: 45 }, (_, i) => ({
      chk: '0', aprvDt: day(M, (i % 28) + 1), crcmClNm: '가나카드', busnCrdCardNoEncCntn: `${CARD.slice(0, 4)}-${CARD.slice(4, 8)}-${CARD.slice(8, 12)}-${CARD.slice(12)}`, mrntTxprDscmNoEncCntn: '107-81-52174', mrntTxprNm: `식당${i + 1}`,
      splCft: '20000', vaTxamt: '2000', tip: '0', totaTrsAmt: i === 7 ? '-22000' : '22000', bmanClNm: '일반과세자', ddcYnNm: i % 4 ? '공제' : '불공제', busnCrdcTrsBrkdSn: `K${n(i + 1, 11)} `,
    })),
    cardSales: {
      card: [{ stlYm: M.replace('-', ''), mateKndNm: '신용카드 자료', stlScnt: '12', totaStlAmt: '1320000', etcSls: '0', purcEuCardSls: '0', tip: '0' }],
      pg: [{ stlYm: M.replace('-', ''), sumStlScnt: '3', sumTipExclAmt: '-33000', crdcAmt: '-33000', etcAmt: '0', txprNm: '가나페이먼츠' }],
    },
  };
}

describe('금고 report.readScreen: 홈택스 월 리포트 조회 화면 읽기(ADR-068 결정 6, 가짜 홈택스)', () => {
  let h: Harness;
  let fx: HometaxFake;
  let rb: RunBrowser;
  const read = (screen: string, from: string, to: string) => h.client.rpc<Record<string, unknown>>('report.readScreen', { runId: 'r1', targetId: rb.targetId, screen, period: { from, to } });

  before(async () => {
    fx = await startHometaxFake({ loggedIn: true, renderDelayMs: 150, xhrDelayMs: 40, report: data() });
    h = await startHarness();
    rb = await connectRunBrowser(h.client);
    await rb.page.goto(`${fx.origin}/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml`);
  });
  after(async () => {
    await rb?.browser.close().catch(() => {});
    await h?.close();
    await fx?.close();
  });

  it('매입 세금계산서: 메뉴로 들어가 매입을 고르고 거르기를 전체로 돌린 뒤 50줄 쪽 2개를 다 읽는다', async () => {
    const r = await read('purchase_invoice', `${M}-01`, last(M));
    assert.equal(r.ok, true, JSON.stringify(r));
    const rows = r.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 60);
    assert.equal(new Set(rows.map((x) => x.approvalNo)).size, 60);
    const one = rows.find((x) => x.supplierName === '공급처1')!;
    assert.deepEqual(one, {
      approvalNo: `${M.replace('-', '')}01${n(41000000)}${n(1)}`, writtenOn: day(M, 1), total: 110_000, supply: 100_000, tax: 10_000, item: '원두',
      buyerBizNo: '1234567891', supplierBizNo: '2148651233', supplierName: '공급처1', supplierRep: '박공급',
    });
    assert.ok(fx.requests().some((x) => x.actionId === 'ATEETBDA001R01'));
  });

  it('현금영수증 매출: 월별 탭 → 년월 → 조회. 취소거래는 canceled로 표시하고 다른 달은 받지 않는다', async () => {
    const r = await read('cash_receipt_in', `${M}-01`, last(M));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.rows, [
      { day: day(M, 3), approvalNo: 'J12345678', amount: 10_000, supply: 9091, tax: 909, canceled: false },
      { day: day(M, 4), approvalNo: 'J12345679', amount: 10_000, supply: 9091, tax: 909, canceled: true },
    ]);
  });

  it('현금영수증 매입: 10줄 쪽 3개를 넘기며 23건, 가맹점 번호와 공제 여부', async () => {
    const r = await read('cash_receipt_out', `${M}-01`, last(M));
    assert.equal(r.ok, true, JSON.stringify(r));
    const rows = r.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 23);
    assert.equal(new Set(rows.map((x) => x.approvalNo)).size, 23);
    assert.deepEqual(rows.find((x) => x.cpName === '가게2'), { day: day(M, 2), approvalNo: `K${n(2)}`, amount: 5000, supply: 4545, tax: 455, canceled: false, cpBizNo: '2208162517', cpName: '가게2', deductible: true });
  });

  it('사업용 카드: 월별 라디오 → 년월 → 조회, 20줄 쪽 3개. 카드번호는 끝 4자리만 금고 밖으로 나가고 [변경하기]는 누르지 않는다', async () => {
    const r = await read('business_card', `${M}-01`, last(M));
    assert.equal(r.ok, true, JSON.stringify(r));
    const rows = r.rows as Array<Record<string, unknown>>;
    assert.equal(rows.length, 45);
    assert.ok(rows.every((x) => x.cardLast4 === '1234'));
    assert.ok(!JSON.stringify(r).includes(CARD.slice(4, 12)), '카드번호 가운데 자리가 결과에 없다');
    const neg = rows.find((x) => x.merchant === '식당8')!;
    assert.equal(neg.amount, 22000);
    assert.equal(neg.canceled, true);
    assert.equal(rows.find((x) => x.merchant === '식당1')!.approvalNo, `K${n(1, 11)}`);
    assert.ok(!fx.requests().some((x) => x.actionId === 'ATECRCCA001C01'), '공제여부 저장 요청 없음');
  });

  it('카드 매출자료: 화면이 기본값으로 먼저 조회한 표를 받지 않고, 고른 분기로 다시 조회해 카드사와 판매대행 달 합계를 읽는다', async () => {
    const r = await read('card_sales', QSTART, QEND);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.rows, [
      { month: M, issuer: '신용카드 자료', count: 12, amount: 1_320_000 },
      { month: M, issuer: '가나페이먼츠', count: 3, amount: -33_000 },
    ]);
  });

  it('매출 세금계산서: 같은 목록조회 화면에서 매출을 고른다(0건)', async () => {
    const r = await read('sale_invoice', `${M}-01`, last(M));
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.rows, []);
  });

  it('화면 단위에 안 맞는 기간은 화면에 들어가지 않고 거부한다', async () => {
    const before = fx.requests().length;
    assert.equal((await read('cash_receipt_in', `${PREV}-20`, `${M}-10`)).reason, 'bad_period');
    assert.equal((await read('card_sales', `${PREV}-01`, last(shift(M, 3)))).reason, 'bad_period');
    assert.equal((await read('purchase_invoice', `${PREV}-01`, last(shift(M, 2)))).reason, 'bad_period');
    assert.equal((await read('nope', `${M}-01`, last(M))).reason, 'bad_screen');
    assert.equal(fx.requests().length, before);
  });

  it('조회에서 다른 안내(점검, 세션 만료)가 뜨면 portal_alert로 실패한다. 결과 없음 안내는 0건이다', async () => {
    fx.knobs.reportAlert = { menu: '4605010100', text: '세션이 만료되었습니다. 다시 로그인하세요.' };
    try {
      assert.equal((await read('cash_receipt_out', `${M}-01`, last(M))).reason, 'portal_alert');
    } finally {
      fx.knobs.reportAlert = null;
    }
    fx.knobs.reportEmptyAlert = true;
    try {
      const r = await read('cash_receipt_in', `${shift(PREV, -1)}-01`, last(shift(PREV, -1)));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.deepEqual(r.rows, []);
    } finally {
      fx.knobs.reportEmptyAlert = false;
    }
  });

  it('화면이 다 그려진 뒤 초기화가 기간 칸을 기본값으로 되돌려도, 요청이 잠잠해진 뒤 기간을 넣고 그대로인지 보고 조회한다(11/25 실측)', async () => {
    fx.knobs.reportLateInit = true;
    try {
      const r = await read('purchase_invoice', `${M}-01`, last(M));
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal((r.rows as unknown[]).length, 60);
    } finally {
      fx.knobs.reportLateInit = false;
    }
  });

  it('쪽 링크를 눌러도 쪽이 바뀌지 않으면 같은 쪽을 두 번 받지 않고 page_not_moved로 멈춘다', async () => {
    fx.knobs.reportPagerStuck = true;
    try {
      assert.equal((await read('cash_receipt_out', `${M}-01`, last(M))).reason, 'page_not_moved');
    } finally {
      fx.knobs.reportPagerStuck = false;
    }
  });
});
