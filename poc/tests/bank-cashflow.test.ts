import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { ColumnCipher, openDatabase, ProfileRepo, syntheticBizNo, type Db } from '@sax/db';
import { analyzeCashFlow, analyzeReport, BankService, categorizeTxn, hometaxReportSink, itemKey, rangesCover, reportLines, settledThrough, type CashFlowMonth, type CashFlowResult, type CfInput, type CfInvoice, type CfTxn, type ReportResult } from '@sax/engine';
import { BANK_COMMANDS, BANK_READ_QUERIES } from '@sax/engine/protocol';

const tx = (id: string, day: string, direction: 'in' | 'out', amount: number, label: string, o: Partial<CfTxn> = {}): CfTxn => ({ id, accountId: 'a1', day, direction, amount, label, counterOwn: false, settled: 0, human: null, ...o });
const inv = (id: string, o: Partial<CfInvoice>): CfInvoice => ({ id, kind: 'sale', counterpartyKey: 'A', cpName: 'A상사', writtenOn: '2026-10-01', total: 1_000_000, remaining: 1_000_000, dueOn: '2026-10-31', state: 'open', settledOn: null, ...o });
const acct = (o: Partial<CfInput['accounts'][number]> = {}) => ({ id: 'a1', last4: '1111', bank: '국민', ranges: [{ from: '2026-01-01', to: '2026-11-15' }], coverTo: '2026-11-15', balance: 5_000_000, balanceDay: '2026-11-15', ...o });
const base = (o: Partial<CfInput> = {}): CfInput => ({
  today: '2026-11-16', month: '2026-11', accounts: [acct()], txns: [], invoices: [], cashSales: [], cardTxns: [], receipts: [], payroll: [], payees: [], rules: [], cardRanges: [], ...o,
});

describe('현금흐름 갈래(11 §3.3, 순수 함수)', () => {
  const none = new Map();
  it('사전: 세금·4대보험, 카드대금(출금)·카드매출 정산(입금), 이자. 나머지는 기타', () => {
    assert.equal(categorizeTxn(tx('1', '2026-11-10', 'out', 300_000, '국민건강보험 지역'), false, none, []), 'tax');
    assert.equal(categorizeTxn(tx('2', '2026-11-10', 'out', 800_000, '삼성카드 결제'), false, none, []), 'card_payment');
    assert.equal(categorizeTxn(tx('3', '2026-11-10', 'in', 420_000, '신한카드 가맹점'), false, none, []), 'card_sales');
    assert.equal(categorizeTxn(tx('4', '2026-11-10', 'in', 77, '결산이자'), false, none, []), 'interest');
    assert.equal(categorizeTxn(tx('5', '2026-11-10', 'out', 50_000, '김밥천국'), false, none, []), 'other');
  });
  it('사람이 정한 것이 먼저, 기억한 규칙, 내 계좌 사이, 급여(직원 이름 + 실지급액, 그달·전달)', () => {
    assert.equal(categorizeTxn(tx('1', '2026-11-10', 'out', 300_000, '국세', { human: 'unrelated' }), false, none, []), 'unrelated');
    assert.equal(categorizeTxn(tx('2', '2026-11-10', 'out', 90_000, '쿠팡'), false, new Map([['out|쿠팡', 'other' as const]]), []), 'other');
    assert.equal(categorizeTxn(tx('3', '2026-11-10', 'out', 90_000, '대표 개인'), false, new Map([['out|대표개인', 'unrelated' as const]]), []), 'unrelated');
    assert.equal(categorizeTxn(tx('4', '2026-11-10', 'out', 1_000_000, '아무개', { counterOwn: true }), false, none, []), 'own_transfer');
    const payees = [{ nameNorm: '이직원', month: '2026-10', net: 2_345_670 }];
    assert.equal(categorizeTxn(tx('5', '2026-11-05', 'out', 2_345_670, '이직원'), false, none, payees), 'payroll');
    assert.equal(categorizeTxn(tx('6', '2026-11-05', 'out', 2_345_000, '이직원'), false, none, payees), 'other', '금액이 다르면 급여로 보지 않는다');
    assert.equal(categorizeTxn(tx('7', '2026-11-05', 'out', 2_345_670, '이직원 10월급여', { payer: '이직원' }), false, none, payees), 'payroll', '적요가 붙어도 받는 분 이름으로 맞춘다');
  });
  it('홈택스 자료가 다 들어온 날(2026-11-25 실측 안내): 세금계산서와 현금영수증은 어제, 카드는 15일쯤 지난달, 판매대행은 분기 다음 달 17일쯤', () => {
    assert.equal(settledThrough('cash_receipt_in', '2026-11-01'), '2026-10-31');
    assert.equal(settledThrough('sale_invoice', '2026-11-25'), '2026-11-24');
    assert.equal(settledThrough('business_card', '2026-11-15'), '2026-09-30');
    assert.equal(settledThrough('business_card', '2026-11-16'), '2026-10-31');
    assert.equal(settledThrough('card_sales', '2026-11-17'), '2026-06-30', '3분기 판매대행 자료가 아직이다');
    assert.equal(settledThrough('card_sales', '2026-11-18'), '2026-09-30');
    assert.equal(settledThrough('card_sales', '2026-12-20'), '2026-09-30', '4분기는 다음 해 2월 18일부터');
  });
  it('구간 합이 빈틈없이 덮는가', () => {
    assert.equal(rangesCover([{ from: '2026-10-01', to: '2026-10-15' }, { from: '2026-10-16', to: '2026-10-31' }], '2026-10-01', '2026-10-31'), true);
    assert.equal(rangesCover([{ from: '2026-10-01', to: '2026-10-14' }, { from: '2026-10-16', to: '2026-10-31' }], '2026-10-01', '2026-10-31'), false);
    assert.equal(rangesCover([], '2026-10-01', '2026-10-31'), false);
  });
});

describe('현금흐름 지표(11 §3.4, 순수 함수)', () => {
  it('현금 기준: 받을 돈·낼 돈에 붙은 금액 + 나머지 갈래, 내 계좌 사이·사업과 무관은 뺀다', () => {
    const r = analyzeCashFlow(base({
      accounts: [acct(), acct({ id: 'a2', last4: '2222', bank: '신한' })],
      txns: [
        tx('i1', '2026-11-03', 'in', 3_300_000, '김철수', { settled: 3_300_000 }),
        tx('i2', '2026-11-04', 'in', 500_000, '모르는분'),
        tx('o1', '2026-11-05', 'out', 1_100_000, '에스자재', { settled: 1_000_000 }),
        tx('o2', '2026-11-06', 'out', 2_000_000, '내 신한', {}),
        tx('i3', '2026-11-06', 'in', 2_000_000, '내 국민', { accountId: 'a2' }),
        tx('o3', '2026-11-07', 'out', 40_000, '개인 용돈', { human: 'unrelated' }),
        tx('o4', '2026-10-31', 'out', 99_999, '지난달'),
      ],
    }));
    const m = r.month;
    assert.equal(m.complete, true);
    assert.deepEqual(m.cash.in, { total: 3_800_000, by: { receivable: 3_300_000, other: 500_000 }, n: { receivable: 1, other: 1 } });
    assert.deepEqual(m.cash.out, { total: 1_100_000, by: { payable: 1_000_000, other: 100_000 }, n: { payable: 1, other: 1 } });
    assert.equal(m.cash.net, 2_700_000);
    assert.equal(m.cash.excluded, 4_040_000, '내 계좌 사이 2,000,000 × 2 + 무관 40,000');
    assert.deepEqual([m.unknown.inTotal, m.unknown.outTotal, m.unknown.topIds[0]], [500_000, 100_000, 'i2']);
  });

  it('모르는 것은 0으로 세지 않는다: 그달을 덮지 못한 계좌, 현금매출 입력 안 함, 카드 조회 안 함, 회수율', () => {
    const r = analyzeCashFlow(base({
      month: '2026-10',
      accounts: [acct(), acct({ id: 'a2', last4: '2222', bank: '신한', ranges: [{ from: '2026-10-10', to: '2026-11-15' }] })],
      invoices: [inv('s1', { writtenOn: '2026-10-05', remaining: 0, state: 'settled', settledOn: '2026-10-25' })],
    }));
    assert.equal(r.month.complete, false);
    assert.deepEqual(r.month.missing.map((x) => x.last4), ['2222']);
    assert.equal(r.month.accrual.cashSales, null);
    assert.equal(r.month.accrual.card, null);
    assert.equal(r.month.accrual.payroll, null);
    assert.equal(r.month.collectionRate, null, '거래내역이 그달부터 덮지 못하면 회수율을 내지 않는다');
    const ok = analyzeCashFlow(base({ month: '2026-10', invoices: [inv('s1', { writtenOn: '2026-10-05', remaining: 0, state: 'settled', settledOn: '2026-10-25' }), inv('s2', { writtenOn: '2026-10-20' })] }));
    assert.equal(ok.month.collectionRate, 0.5);
    const none = analyzeCashFlow(base({ accounts: [] }));
    assert.deepEqual([none.month.hasAccounts, none.month.complete], [false, false]);
  });

  it('발생 기준: 세금계산서·현금매출·카드·영수증(카드와 짝이면 한 번만)·급여, 빼기로 한 건은 넣지 않는다', () => {
    const r = analyzeCashFlow(base({
      month: '2026-10',
      invoices: [inv('s1', { writtenOn: '2026-10-05', total: 2_200_000 }), inv('s2', { writtenOn: '2026-10-06', total: 9_999, state: 'excluded' }), inv('p1', { kind: 'purchase', writtenOn: '2026-10-07', total: 550_000 })],
      cashSales: [{ day: '2026-10-02', amount: 120_000 }, { day: '2026-10-03', amount: 80_000 }],
      cardRanges: [{ from: '2026-10-01', to: '2026-10-20' }, { from: '2026-10-21', to: '2026-11-10' }],
      cardTxns: [{ day: '2026-10-10', amount: 33_000, merchantBizNo: '1234567890', canceled: false }, { day: '2026-10-12', amount: 10_000, merchantBizNo: null, canceled: false }, { day: '2026-10-13', amount: 10_000, merchantBizNo: null, canceled: true }],
      receipts: [{ day: '2026-10-11', amount: 33_000, merchantBizNo: '1234567890' }, { day: '2026-10-15', amount: 7_000, merchantBizNo: null }],
      payroll: [{ month: '2026-10', gross: 3_000_000, net: 2_700_000 }],
    }));
    assert.deepEqual(r.month.accrual, { salesInvoices: 2_200_000, cashSales: 200_000, purchaseInvoices: 550_000, invoicesKnown: { sale: false, purchase: false }, card: 33_000, receipts: 7_000, payroll: 3_000_000, cashReceiptsIn: null, cashReceiptsOut: null, cardSales: null });
  });

  it('지금 모습: 잔액, 앞으로 30일(기한 정해진 것만, 기한 지난 받을 돈은 넣지 않음), 묵은 받을 돈', () => {
    const r = analyzeCashFlow(base({
      invoices: [
        inv('s1', { dueOn: '2026-11-30', remaining: 400_000 }),
        inv('s2', { dueOn: '2026-10-01', remaining: 300_000 }),
        inv('s3', { dueOn: '2026-07-01', remaining: 200_000 }),
        inv('s4', { dueOn: null, remaining: 100_000 }),
        inv('s5', { state: 'unknown', remaining: 50_000 }),
        inv('p1', { kind: 'purchase', dueOn: '2026-12-01', remaining: 600_000 }),
        inv('p2', { kind: 'purchase', dueOn: '2026-11-01', remaining: 70_000 }),
        inv('p3', { kind: 'purchase', dueOn: '2027-02-01', remaining: 999 }),
        inv('p4', { kind: 'purchase', dueOn: null, remaining: 1 }),
      ],
    }));
    assert.deepEqual(r.snapshot.balance.total, 5_000_000);
    assert.deepEqual(r.snapshot.next30, { payOut: 600_000, payOverdue: 70_000, payIn: 400_000, noDuePay: 1, noDueRecv: 1 });
    assert.deepEqual(r.snapshot.aging, { notDue: 500_000, d0_30: 0, d31_60: 300_000, d61_90: 0, d90p: 200_000, unknown: 50_000 });
  });

  it('회수일: 금액 가중 평균, 거래처별(3건 이상), 최근 3건이 15일 넘게 늦어지면 알림', () => {
    const done = (id: string, w: string, s: string, total = 1_000_000) => inv(id, { writtenOn: w, settledOn: s, state: 'settled', remaining: 0, total });
    const r = analyzeCashFlow(base({
      invoices: [
        done('1', '2026-04-01', '2026-05-01'), done('2', '2026-05-01', '2026-05-31'), done('3', '2026-06-01', '2026-07-01'),
        done('4', '2026-07-01', '2026-08-20'), done('5', '2026-08-01', '2026-09-20'), done('6', '2026-09-01', '2026-10-21'),
        done('b1', '2026-09-01', '2026-09-11', 3_000_000), inv('b2', { counterpartyKey: 'B', cpName: '비상사', writtenOn: '2026-10-01', settledOn: '2026-10-11', state: 'settled', remaining: 0 }),
      ].map((v) => (v.id.startsWith('b') ? { ...v, counterpartyKey: 'B', cpName: '비상사' } : v)),
    }));
    const a = r.snapshot.collectDays.byCounterparty.find((c) => c.key === 'A')!;
    assert.deepEqual([a.count, a.priorDays, a.recentDays], [6, 30, 50]);
    assert.ok(!r.snapshot.collectDays.byCounterparty.some((c) => c.key === 'B'), '2건뿐인 거래처는 보이지 않는다');
    assert.equal(r.snapshot.collectDays.overall, Math.round((30 * 1e6 * 3 + 50 * 1e6 * 3 + 10 * 3e6 + 10 * 1e6) / 10e6));
    assert.ok(r.alerts.some((x) => x.kind === 'slowdown' && x.counterpartyKey === 'A' && x.recentDays === 50));
  });

  it('쏠림: 지난 3개월 매출 5건 이상일 때만, 1곳이 50%를 넘으면 분기 알림', () => {
    const few = analyzeCashFlow(base({ invoices: [inv('1', { writtenOn: '2026-11-01' })] }));
    assert.equal(few.snapshot.concentration.top1, null);
    const many = analyzeCashFlow(base({
      invoices: [
        inv('1', { writtenOn: '2026-09-05', total: 3_000_000 }), inv('2', { writtenOn: '2026-10-05', total: 3_000_000 }), inv('3', { writtenOn: '2026-11-05', total: 1_000_000 }),
        inv('4', { writtenOn: '2026-10-07', counterpartyKey: 'B', cpName: '비', total: 2_000_000 }), inv('5', { writtenOn: '2026-10-08', counterpartyKey: 'C', cpName: '씨', total: 1_000_000 }),
        inv('old', { writtenOn: '2026-08-31', counterpartyKey: 'D', total: 9_000_000 }),
      ],
    }));
    assert.deepEqual(many.snapshot.concentration.top1, { key: 'A', cpName: 'A상사', share: 0.7 });
    assert.equal(many.snapshot.concentration.top3Share, 1);
    assert.ok(many.alerts.some((x) => x.kind === 'concentration' && x.id === 'concentration:2026Q4'));
  });

  it('잔액 부족 알림: 잔액 + 들어올 돈 < 나갈 돈. 거래내역이 오래됐거나 잔액을 모르는 계좌가 있으면 내지 않는다', () => {
    const invoices = [inv('p1', { kind: 'purchase', dueOn: '2026-11-25', remaining: 6_000_000 }), inv('s1', { dueOn: '2026-11-20', remaining: 500_000 })];
    const r = analyzeCashFlow(base({ invoices }));
    assert.deepEqual(r.alerts.filter((x) => x.kind === 'shortfall'), [{ id: 'shortfall:2026-11-16', kind: 'shortfall', gap: 500_000 }]);
    const stale = analyzeCashFlow(base({ invoices, accounts: [acct({ ranges: [{ from: '2026-01-01', to: '2026-11-01' }], coverTo: '2026-11-01' })] }));
    assert.ok(!stale.alerts.some((x) => x.kind === 'shortfall'));
    const noBal = analyzeCashFlow(base({ invoices, accounts: [acct(), acct({ id: 'a2', balance: null, balanceDay: null })] }));
    assert.ok(!noBal.alerts.some((x) => x.kind === 'shortfall'));
  });

  it('모르는 입금이 그달 입금의 20%를 넘으면 알림(그달을 다 덮었을 때만)', () => {
    const txns = [tx('i1', '2026-11-03', 'in', 1_000_000, 'a', { settled: 1_000_000 }), tx('i2', '2026-11-04', 'in', 400_000, '모름')];
    assert.ok(analyzeCashFlow(base({ txns })).alerts.some((x) => x.kind === 'unknown_in' && x.share === 0.286));
    const part = analyzeCashFlow(base({ txns, accounts: [acct({ ranges: [{ from: '2026-11-03', to: '2026-11-15' }] })] }));
    assert.ok(!part.alerts.some((x) => x.kind === 'unknown_in'));
  });
});

describe('현금흐름 조회(엔진, 실제 DB)', () => {
  let dir: string;
  let db: Db;
  let pid: string;
  let svc: BankService;
  let acctId: string;
  const now = new Date('2026-11-16T01:00:00Z');
  const call = <T>(m: string, p: Record<string, unknown> = {}) => svc.handle(m, { profileId: pid, ...p }) as Promise<T>;
  const code = (p: Promise<unknown>, c: string) => assert.rejects(p, (e: Error & { code?: string }) => e.code === c, c);
  const me = syntheticBizNo(60);
  const approval = (i: number) => `20261001410000${String(10000000 + i).slice(-8)}00`.slice(0, 24);

  before(async () => {
    dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sax-cf-'));
    db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
    pid = new ProfileRepo(db).upsert({ kind: 'business', displayName: '하늘상회', bizNo: me, corpNo: null, repName: '김하늘', bizType: null, bizItem: null, address: null, email: null, signMethod: null }).id;
    svc = new BankService(db, new ColumnCipher(new Uint8Array(randomBytes(32))), new Uint8Array(randomBytes(32)), { vaultDir: path.join(dir, 'vault'), now: () => now });
    await call('bank.consent', { version: '09-v1' });
    acctId = (await call<{ id: string }>('bank.addAccount', { bank: '국민', number: '123-45-678901' })).id;
  });
  after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('프로토콜: 새 조회·명령도 main 전용 은행 목록에 있다', () => {
    assert.ok((BANK_READ_QUERIES as readonly string[]).includes('db.query.bank.cashflow'));
    assert.ok((BANK_READ_QUERIES as readonly string[]).includes('db.query.bank.cashflowSeries'));
    assert.ok((BANK_COMMANDS as readonly string[]).includes('bank.categorize'));
  });

  it('거래내역·세금계산서·현금매출 → 그달 요약과 지금 모습. 통장 표시 원문은 결과에 없다', async () => {
    await call('bank.importInvoices', { rows: [
      { approvalNo: approval(1), writtenOn: '2026-11-02', supplierBizNo: me, buyerBizNo: syntheticBizNo(61), buyerName: '에이상사', total: 2_200_000 },
      { approvalNo: approval(2), writtenOn: '2026-11-03', supplierBizNo: syntheticBizNo(62), supplierName: '에스자재', buyerBizNo: me, total: 330_000 },
    ] });
    await call('bank.importTxns', { accountId: acctId, period: { from: '2026-11-01', to: '2026-11-15' }, rows: [
      { occurredAt: '2026-11-01 09:00', day: '2026-11-01', direction: 'in', amount: 1_000_000, balance: 1_000_000, payer: '김비밀', memo: null },
      { occurredAt: '2026-11-10 09:00', day: '2026-11-10', direction: 'out', amount: 180_000, balance: 820_000, payer: '국민연금공단', memo: '연금' },
      { occurredAt: '2026-11-11 09:00', day: '2026-11-11', direction: 'out', amount: 55_000, balance: 765_000, payer: '쿠팡', memo: null },
      { occurredAt: '2026-11-12 09:00', day: '2026-11-12', direction: 'out', amount: 66_000, balance: 699_000, payer: '쿠팡', memo: null },
    ] });
    db.prepare(`INSERT INTO cash_sales (profile_id, day, amount, entered_at) VALUES (?, '2026-11-05', 90000, '2026-11-05T10:00:00Z')`).run(pid);
    const r = await call<CashFlowResult>('db.query.bank.cashflow');
    assert.equal(r.month.month, '2026-11');
    assert.deepEqual(r.month.cash.out.by, { tax: 180_000, other: 121_000 });
    assert.equal(r.month.cash.in.total, 1_000_000);
    assert.deepEqual([r.month.accrual.salesInvoices, r.month.accrual.purchaseInvoices, r.month.accrual.cashSales], [2_200_000, 330_000, 90_000]);
    assert.equal(r.snapshot.balance.total, 699_000);
    assert.equal(r.snapshot.next30.payOut, 330_000);
    assert.ok(!JSON.stringify(r).includes('김비밀') && !JSON.stringify(r).includes('쿠팡'), '통장 표시 원문을 내지 않는다');
  });

  it('[갈래 정하기] + 기억: 같은 통장 표시는 다음부터 그 갈래, 되돌리기, 잘못된 값', async () => {
    const coupang = db.prepare(`SELECT id FROM bank_txns WHERE payer = '쿠팡' ORDER BY day`).pluck().all() as string[];
    const r = await call<{ seq: number; remembered: boolean }>('bank.categorize', { txnId: coupang[0], category: 'unrelated', remember: true });
    assert.equal(r.remembered, true);
    let cf = await call<CashFlowResult>('db.query.bank.cashflow');
    assert.deepEqual(cf.month.cash.out.by, { tax: 180_000 }, '두 줄 모두 분석에서 빠진다(한 줄은 규칙으로)');
    assert.equal(cf.month.cash.excluded, 121_000);
    await call('bank.undo', { seq: r.seq });
    cf = await call<CashFlowResult>('db.query.bank.cashflow');
    assert.equal(cf.month.cash.excluded, 121_000, '되돌려도 기억한 규칙은 남는다(규칙은 [갈래 정하기]로 다시 바꾼다)');
    await code(call('bank.categorize', { txnId: coupang[0], category: 'loan' }), 'bad_category');
    await code(call('db.query.bank.cashflow', { month: '2026-13' }), 'bad_month');
    await code(call('db.query.bank.cashflow', { month: '2026-12' }), 'bad_month');
  });

  it('달마다 요약(기본 6개월, 오래된 달이 앞). 거래내역이 없는 달은 complete=false', async () => {
    const s = await call<{ months: CashFlowMonth[] }>('db.query.bank.cashflowSeries');
    assert.deepEqual(s.months.map((m) => m.month), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
    assert.deepEqual(s.months.map((m) => m.complete), [false, false, false, false, false, true]);
    await code(call('db.query.bank.cashflowSeries', { months: 13 }), 'bad_months');
  });

  it('월 리포트(ADR-068): 돈 흐름과 같은 숫자, 홈택스 자료를 받지 않은 칸은 확인 못 함, 겹쳐 받은 카드 내역은 한 번만', async () => {
    const run = (id: string) => db.prepare(`INSERT INTO runs (id, playbook_id, playbook_version, package_digest, profile_id, trigger, status, started_at, inputs_hash) VALUES (?, 'hometax.card.fetch', '1', 'd', ?, 'local', 'done', '2026-11-10T00:00:00Z', 'i')`).run(id, pid);
    // 사업용 카드는 다음 달 15일쯤 지난달 분이 다 들어온다. 11-16(한국)에 받은 10월은 덮고, 11월은 아직 모른다
    for (const [id, at] of [['card-1', '2026-11-15T15:30:00Z'], ['card-2', '2026-11-16T00:30:00Z']] as const) {
      run(id);
      db.prepare(`INSERT INTO card_fetches (run_id, profile_id, range_from, range_to, row_count, completed_at) VALUES (?, ?, '2026-10-01', '2026-11-16', 1, ?)`).run(id, pid, at);
      db.prepare(`INSERT INTO card_txns (id, profile_id, fetch_run_id, seq, used_on, merchant, amount, canceled) VALUES (?, ?, ?, 1, '2026-10-06', '문구점', 44000, 0)`).run(`${id}-t`, pid, id);
    }
    const oct = await call<CashFlowResult>('db.query.bank.cashflow', { month: '2026-10' });
    assert.equal(oct.month.accrual.card, 44_000, '두 번 받은 카드 내역을 두 번 세지 않는다');
    assert.equal((await call<ReportResult>('db.query.bank.report', { month: '2026-10', months: 1 })).purchase.card.amount, 44_000);
    let r = await call<ReportResult>('db.query.bank.report', { month: '2026-11', months: 1 });
    const cf = await call<CashFlowResult>('db.query.bank.cashflow', { month: '2026-11' });
    assert.equal(cf.month.accrual.card, null, '이번 달 카드 자료는 아직 홈택스에 다 들어오지 않았다');
    assert.equal(r.purchase.card.amount, cf.month.accrual.card);
    assert.equal(r.sales.invoices.amount, cf.month.accrual.salesInvoices);
    assert.equal(r.bank.in, cf.month.cash.in.total);
    assert.equal(r.bank.out, cf.month.cash.out.total);
    assert.equal(r.sales.cashReceipts.amount, null, '홈택스 현금영수증을 받지 않았으면 확인 못 함');
    // 홈택스 세금계산서 목록을 받은 적이 없으면 앱 발급분만 안다: 있으면 일부, 없으면 확인 못 함(2026-11-26 실기기, 앱 발급 6건만 매출 전체처럼 보임)
    assert.equal(cf.month.accrual.invoicesKnown.sale, false);
    assert.equal(r.sales.invoices.partial, r.sales.invoices.amount !== null);
    assert.equal(r.sales.total.partial, true);
    assert.ok(r.purchase.invoices.amount === null || r.purchase.invoices.partial);
    assert.ok(r.notes.some((n) => n.kind === 'hometax_stale' && n.lastAt === null));
    assert.deepEqual(r.series.map((m) => [m.month, m.inWindow]).slice(-2), [['2026-10', false], ['2026-11', true]]);

    db.prepare(`INSERT INTO hometax_syncs (id, profile_id, kind, range_from, range_to, row_count, trigger, finished_at) VALUES ('hs1', ?, 'cash_receipt_in', '2026-09-01', '2026-11-16', 1, 'unlock', '2026-11-16T00:00:00Z')`).run(pid);
    db.prepare(`INSERT INTO cash_receipts (id, profile_id, side, day, approval_no, amount, canceled, sync_id) VALUES ('cr1', ?, 'in', '2026-11-07', 'A1', 12000, 0, 'hs1'), ('cr2', ?, 'in', '2026-11-08', 'A2', 5000, 1, 'hs1')`).run(pid, pid);
    r = await call<ReportResult>('db.query.bank.report', { month: '2026-11', months: 3 });
    assert.deepEqual(r.sales.cashReceipts, { amount: 12_000, partial: false }, '취소는 빼고, 받은 구간이 기간을 덮는다');
    assert.ok(!r.notes.some((n) => n.kind === 'hometax_stale'), '오늘 받았으면 묵었다는 줄이 없다');
    assert.equal(r.series.length, 6);
    assert.equal(r.from, '2026-09-01');
    await code(call('db.query.bank.report', { months: 2 }), 'bad_months');
    await code(call('db.query.bank.report', { month: '2026-12' }), 'bad_month');
    assert.ok(!JSON.stringify(r).includes('김비밀') && !JSON.stringify(r).includes('쿠팡'), '통장 표시 원문을 내지 않는다');
  });

  it('홈택스 자동 받기(ADR-068 결정 6, 10): 받을 구간, 자연 키로 넣고 합치기, 실패는 덮음으로 치지 않는다', async () => {
    type Plan = { due: boolean; steps: Array<{ kind: string; from: string; to: string }> };
    type Sync = { rows: number; created: number; merged: number; skipped: number };
    assert.equal((await call<Plan>('db.query.bank.hometaxPlan')).due, false, '1시간 전에 받았고 앱을 켠 뒤 첫 풀기가 아니다');
    let plan = await call<Plan>('db.query.bank.hometaxPlan', { firstUnlock: true });
    assert.equal(plan.due, true);
    assert.deepEqual(plan.steps.filter((x) => x.kind === 'cash_receipt_in'), [{ kind: 'cash_receipt_in', from: '2026-11-01', to: '2026-11-16' }], '오늘 받은 것은 어제까지 덮는다. 홈택스는 달 단위라 이번 달을 다시');
    assert.deepEqual(plan.steps.filter((x) => x.kind === 'sale_invoice').map((x) => [x.from, x.to]), [
      ['2025-11-17', '2026-02-16'], ['2026-02-17', '2026-05-16'], ['2026-05-17', '2026-08-16'], ['2026-08-17', '2026-11-16'],
    ], '처음이면 지난 12개월을 3개월씩');
    assert.deepEqual(plan.steps.filter((x) => x.kind === 'card_sales').map((x) => [x.from, x.to]), [
      ['2025-10-01', '2025-12-31'], ['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30'], ['2026-07-01', '2026-09-30'], ['2026-10-01', '2026-11-16'],
    ], '카드 매출자료는 분기 단위');
    assert.equal(plan.steps.filter((x) => x.kind === 'business_card').length, 13, '사업용 카드는 달 단위, 2025-11부터');
    assert.equal(plan.steps.length, 4 + 4 + 1 + 13 + 5 + 13);

    const sync = (p: Record<string, unknown>) => call<Sync>('bank.hometaxSync', { trigger: 'unlock', from: '2026-08-17', to: '2026-11-16', ...p });
    const sale = { approvalNo: approval(31), writtenOn: '2026-11-09', supplierBizNo: me, buyerBizNo: syntheticBizNo(63), buyerName: '비상사', item: '컨설팅', supply: 1_000_000, tax: 100_000, total: 1_100_000 };
    const wrongList = { approvalNo: approval(32), writtenOn: '2026-11-09', supplierBizNo: syntheticBizNo(64), supplierName: '씨자재', buyerBizNo: me, total: 55_000 };
    const outside = { ...sale, approvalNo: approval(33), writtenOn: '2026-08-01' };
    const first = await sync({ kind: 'sale_invoice', rows: [sale, wrongList, outside] });
    assert.deepEqual([first.rows, first.created, first.merged, first.skipped], [3, 1, 0, 2], '매출 목록에서 나온 매입 줄과 받은 구간 밖 줄은 넣지 않는다');
    const again = await sync({ kind: 'sale_invoice', rows: [{ ...sale, item: '자문' }] });
    assert.deepEqual([again.created, again.merged], [0, 1], '두 번 받아도 늘지 않는다');
    assert.equal(db.prepare('SELECT count(*) FROM receivables WHERE approval_no = ?').pluck().get(approval(31)), 1);

    const cr = (no: string, amount: number) => ({ approvalNo: no, day: '2026-11-10', amount, supply: Math.round(amount / 1.1), tax: amount - Math.round(amount / 1.1), cpBizNo: syntheticBizNo(65), cpName: '문구점' });
    assert.deepEqual(await sync({ kind: 'cash_receipt_out', rows: [cr('B000001', 22_000), cr('B000002', 11_000), cr('x', 5_000)] }).then((x) => [x.created, x.merged, x.skipped]), [2, 0, 1]);
    assert.deepEqual(await sync({ kind: 'cash_receipt_out', rows: [cr('B000001', 33_000)] }).then((x) => [x.created, x.merged]), [0, 1]);
    assert.deepEqual(await sync({ kind: 'card_sales', rows: [{ month: '2026-11', issuer: '신한', count: 3, amount: 150_000 }, { month: '2026-07', issuer: '신한', count: 1, amount: 1 }] }).then((x) => [x.created, x.skipped]), [1, 1], '받은 구간 밖의 달은 넣지 않는다');
    const r = await call<ReportResult>('db.query.bank.report', { month: '2026-11', months: 1 });
    assert.equal(r.sales.cardSales.amount, 150_000);
    assert.equal(r.sales.invoices.amount, 2_200_000 + 1_100_000);
    assert.equal(r.sales.invoices.partial, false, '11월 목록을 어제까지 덮어 받았으니 세금계산서 매출은 다 안다');
    assert.equal(r.purchase.invoices.amount === null || r.purchase.invoices.partial, true, '매입 목록은 받지 않았다');

    await sync({ kind: 'purchase_invoice', code: 'hometax.busy' });
    plan = await call<Plan>('db.query.bank.hometaxPlan', { firstUnlock: true });
    assert.equal(plan.steps.filter((x) => x.kind === 'purchase_invoice').length, 4, '실패한 받기는 덮음으로 치지 않아 다음에 같은 구간을 받는다');
    assert.deepEqual(plan.steps.filter((x) => x.kind === 'sale_invoice').map((x) => x.from), ['2026-11-16']);

    db.prepare(`INSERT INTO runs (id, playbook_id, playbook_version, package_digest, profile_id, trigger, status, started_at, inputs_hash) VALUES ('sync-1', 'hometax.report.sync', '1', 'd', ?, 'local', 'done', '2026-11-16T00:30:00Z', 'i')`).run(pid);
    const card = (usedOn: string, amount: number) => ({ usedOn, merchant: '문구점', merchantBizNo: syntheticBizNo(66), cardLast4: '1234', approvalNo: '30001', amount, supplyAmount: null, vatAmount: null });
    const bc = await sync({ kind: 'business_card', runId: 'sync-1', from: '2026-11-01', rows: [card('2026-11-06', 50_000), card('2026-10-30', 1)] });
    assert.deepEqual([bc.created, bc.skipped], [1, 1]);
    assert.deepEqual(db.prepare(`SELECT fetch_run_id AS run, amount FROM card_txns WHERE used_on BETWEEN '2026-11-01' AND '2026-11-16'`).all(), [{ run: 'sync-1', amount: 50_000 }], '받은 구간의 줄을 새 회차로 바꾼다');
    assert.equal((await call<CashFlowResult>('db.query.bank.cashflow', { month: '2026-11' })).month.accrual.card, null, '이번 달 카드는 다음 달 15일쯤까지 모른다');
    await code(sync({ kind: 'business_card', runId: 'sync-1', rows: [] }), 'already_synced');
    await code(sync({ kind: 'business_card', runId: 'nope', rows: [] }), 'bad_run');
    await code(sync({ kind: 'unknown', rows: [] }), 'bad_kind');
    await code(sync({ kind: 'sale_invoice', to: '2026-11-17', rows: [] }), 'bad_range');
    await code(sync({ kind: 'sale_invoice', trigger: 'daemon', rows: [] }), 'bad_trigger');
    await code(sync({ kind: 'sale_invoice', code: 'Bad Code' }), 'bad_code');
  });

  it('받는 곳(엔진 report_sync → 장부): 사업용 카드는 실행마다 모아 한 번, 가운데 달을 못 받으면 그 앞까지만', async () => {
    db.prepare(`INSERT INTO runs (id, playbook_id, playbook_version, package_digest, profile_id, trigger, status, started_at, inputs_hash) VALUES ('sync-2', 'hometax.report.sync', '1', 'd', ?, 'local', 'done', '2026-11-16T00:40:00Z', 'i')`).run(pid);
    const calls: string[] = [];
    const bank = { handle: (m: string, p: Record<string, unknown>) => (calls.push(`${String(p.kind)} ${String(p.from)} ${String(p.to)} ${p.code ? String(p.code) : `${(p.rows as unknown[]).length}줄`}`), svc.handle(m, p)) };
    const sink = hometaxReportSink({ bank, profileId: () => pid, triggerOf: (id) => (id === 'sync-2' ? 'human' : null) });
    const card = (usedOn: string, amount: number) => ({ usedOn, merchant: '꽃집', merchantBizNo: syntheticBizNo(67), cardLast4: '5678', approvalNo: `4${usedOn.slice(5, 7)}`, amount, supplyAmount: null, vatAmount: null });
    await sink.put('sync-2', { kind: 'business_card', from: '2026-08-01', to: '2026-08-31', rows: [card('2026-08-12', 30_000)] });
    await sink.put('sync-2', { kind: 'business_card', from: '2026-09-01', to: '2026-09-30', rows: [card('2026-09-12', 40_000)] });
    await sink.put('sync-2', { kind: 'business_card', from: '2026-10-01', to: '2026-10-31', code: 'report.period_not_set' });
    await sink.put('sync-2', { kind: 'business_card', from: '2026-11-01', to: '2026-11-16', rows: [card('2026-11-12', 50_000)] });
    await sink.put('sync-2', { kind: 'cash_receipt_in', from: '2026-11-01', to: '2026-11-16', rows: [] });
    assert.deepEqual(calls, ['business_card 2026-10-01 2026-10-31 report.period_not_set', 'cash_receipt_in 2026-11-01 2026-11-16 0줄'], '카드 달은 실패만 바로 남기고 받은 달은 모은다');
    await sink.done!('sync-2');
    assert.equal(calls.at(-1), 'business_card 2026-08-01 2026-09-30 2줄', '10월을 못 받아 9월까지만 넣는다. 11월은 다음 받기에서 다시');
    assert.deepEqual(db.prepare(`SELECT fetch_run_id AS run, used_on AS day, amount FROM card_txns WHERE fetch_run_id = 'sync-2' ORDER BY used_on`).all(), [{ run: 'sync-2', day: '2026-08-12', amount: 30_000 }, { run: 'sync-2', day: '2026-09-12', amount: 40_000 }]);
    assert.deepEqual(db.prepare(`SELECT DISTINCT trigger FROM hometax_syncs WHERE finished_at = ?`).pluck().all(now.toISOString()).includes('human'), true, '누가 시작했는지 남긴다');
    await sink.done!('sync-2');
    assert.equal(calls.length, 3, 'done은 한 번만 넣는다');
    await assert.rejects(Promise.resolve().then(() => sink.put('other', { kind: 'sale_invoice', from: '2026-11-01', to: '2026-11-16', rows: [] })), /report.no_context/, '누가 시작했는지 모르는 실행은 넣지 않는다');
  });
});

describe('월 리포트(ADR-068, 순수 함수)', () => {
  it('기간 합은 달마다 합과 같고, 거래처와 품목은 금액 큰 순, 앱 발급과 앱 밖 발급을 나눈다', async () => {
    const input = {
      ...base({
        txns: [tx('1', '2026-10-03', 'in', 300_000, '모름'), tx('2', '2026-11-03', 'in', 200_000, '모름'), tx('3', '2026-11-04', 'out', 50_000, '국세')],
        invoices: [
          inv('a', { writtenOn: '2026-10-02', total: 1_100_000, remaining: 0, state: 'settled', settledOn: '2026-11-01', item: '유지보수 외 1건', fromLedger: true }),
          inv('b', { writtenOn: '2026-11-02', total: 550_000, remaining: 550_000, item: '유지보수', fromLedger: false }),
          inv('c', { writtenOn: '2026-11-05', total: 330_000, remaining: 330_000, counterpartyKey: 'B', cpName: 'B물산', item: null, fromLedger: true }),
          inv('d', { writtenOn: '2026-11-06', total: 220_000, kind: 'purchase', counterpartyKey: 'S', cpName: 'S자재', item: '자재' }),
          inv('x', { writtenOn: '2026-11-07', total: 999_000, state: 'excluded' }),
        ],
      }),
      hometaxLastAt: '2026-11-15T22:00:00Z',
    };
    const one = analyzeReport(input, '2026-11', 1);
    const three = analyzeReport(input, '2026-11', 3);
    const oct = analyzeCashFlow({ ...input, month: '2026-10' }).month;
    const nov = analyzeCashFlow({ ...input, month: '2026-11' }).month;
    assert.equal(one.sales.invoices.amount, nov.accrual.salesInvoices);
    assert.equal(three.sales.invoices.amount, oct.accrual.salesInvoices + nov.accrual.salesInvoices);
    assert.equal(three.bank.in, oct.cash.in.total + nov.cash.in.total);
    assert.equal(three.bank.net, three.bank.in - three.bank.out);
    assert.deepEqual(three.partners.sale.top.map((p) => [p.name, p.count, p.amount, p.remaining]), [['A상사', 2, 1_650_000, 550_000], ['B물산', 1, 330_000, 330_000]]);
    assert.deepEqual(three.partners.sale.split, { ledger: { count: 2, amount: 1_430_000 }, outside: { count: 1, amount: 550_000 } });
    assert.deepEqual(three.items.sale.top.map((p) => [p.name, p.count, p.amount]), [['유지보수', 2, 1_650_000], [null, 1, 330_000]]);
    assert.deepEqual(one.partners.purchase.top.map((p) => p.name), ['S자재']);
    assert.equal(one.bankLines.out.tax?.amount, 50_000);
    assert.equal(one.bankLines.in.other?.count, 1);
    assert.equal(three.series.filter((m) => m.inWindow).length, 3);
    assert.equal(analyzeReport(input, '2026-11', 12).series.length, 12);
    assert.ok(!one.notes.some((n) => n.kind === 'hometax_stale'), '하루 안에 받았으면 묵지 않았다');
    assert.equal(itemKey('  자재  납품 외 3건 '), '자재 납품');
    assert.equal(itemKey(' '), null);
    // 통장 갈래 목록은 리포트 숫자와 같은 줄로 이룬다(목록 합 = 갈래 금액)
    for (const [side, cat] of [['out', 'tax'], ['in', 'other']] as const) {
      const rows = reportLines(input, '2026-11', 1, side, cat);
      assert.equal(rows.reduce((a, r) => a + r.amount, 0), one.bankLines[side][cat]?.amount);
      assert.equal(rows.length, one.bankLines[side][cat]?.count);
    }
    // 전체 보기는 위 10곳 묶음과 같은 합계다
    const all = analyzeReport(input, '2026-11', 3, Infinity);
    assert.equal(all.partners.sale.rest, null);
    assert.equal(all.partners.sale.top.reduce((a, r) => a + r.amount, 0), three.partners.sale.total);
    assert.deepEqual(one.through, { bank: '2026-11-15', hometax: '2026-11-15' });
    // 거래처 줄은 기간과 상관없이 같은 12달의 달마다 금액과, 다 받은 계산서의 받기까지 날수를 싣는다(폰 거래처 시트)
    const a1 = one.partners.sale.top.find((p) => p.key === 'A')!;
    const a3 = three.partners.sale.top.find((p) => p.key === 'A')!;
    assert.deepEqual(a1.monthly, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1_100_000, 550_000]);
    assert.deepEqual(a3.monthly, a1.monthly);
    assert.equal(a3.days, 30);
    assert.equal(three.partners.sale.top.find((p) => p.key === 'B')!.days, null, '다 받은 것이 없으면 모른다(0일이 아니다)');
    assert.equal(three.items.sale.top[0]!.monthly, undefined, '품목 줄에는 싣지 않는다');
    // 폰 사본: 거래처의 12달과 날수는 기간 넷에서 한 번씩만 싣고 줄은 칸 번호로 가리킨다. 봉투 검증을 통과해 한 프레임에 실린다
    const { copyReport } = await import('../apps/desktop/src/phone-copy.ts');
    const { decodeEnvelope, encodeEnvelope, makeEnvelope, ulid } = await import('@sax/remote');
    const copy = copyReport(new Map(([1, 3, 6, 12] as const).map((w) => [w, analyzeReport(input, '2026-11', w)] as const)), { name: ' 가나상사 ', bizNo: '1234567890' })!;
    // 폰 PDF 머리: 사업장 이름과 번호(번호는 하이픈 모양으로), 잔액 줄은 읽은 날
    assert.deepEqual(copy.biz, { name: '가나상사', bizNo: '123-45-67890' });
    assert.deepEqual(copy.balances.map((b) => b.d ?? null), one.balance.accounts.filter((a) => /^\d{4}$/.test(a.last4)).map((a) => a.day));
    assert.equal(copyReport(new Map([[12, analyzeReport(input, '2026-11', 12)]]), null)!.biz, undefined, '이름이 없으면 싣지 않는다');
    assert.deepEqual(copy.pm, [{ m: a1.monthly, d: 30 }, { m: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 330_000], d: null }, { m: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 220_000], d: null }]);
    for (const w of copy.windows) {
      for (const r of w.ps.rows) assert.deepEqual(copy.pm![r.i!]!.m.at(-1), r.name === 'A상사' ? 550_000 : 330_000);
      assert.ok(w.is.rows.every((r) => r.i === undefined));
    }
    const env = makeEnvelope('phone.copy', { asOf: 1, counterparties: [], report: copy }, { pairId: ulid(), from: 'desktop', seq: 1 });
    assert.deepEqual(decodeEnvelope(encodeEnvelope(env))?.body, env.body);
  });
});

describe('BankHost 대화 포트(낼 돈·돈 흐름 요약)', () => {
  it('payables: 아직 내지 않은 건만, 계좌가 없으면 null. cashFlowBrief: 계좌 끝 4자리·줄 id·거래처 열쇠가 없다', async () => {
    const { BankHost } = await import('../apps/desktop/src/bank-host.ts');
    const overview = { accounts: [{ id: 'a' }], payables: { unpaid: [{ counterpartyId: 'c1', cpName: '에스자재', writtenOn: '2026-11-03', remaining: 330_000, dueOn: '2026-12-03', promisedOn: null }] } };
    const cf = analyzeCashFlow(base({
      accounts: [acct({ last4: '9876' })],
      txns: [tx('secret-id', '2026-11-04', 'in', 400_000, '모름')],
      invoices: [inv('1', { writtenOn: '2026-09-05', total: 3_000_000, counterpartyKey: 'cp-uuid' }), inv('2', { writtenOn: '2026-10-05', counterpartyKey: 'cp-uuid' }), inv('3', { writtenOn: '2026-10-06', counterpartyKey: 'cp-uuid' }), inv('4', { writtenOn: '2026-10-07', counterpartyKey: 'cp-uuid' }), inv('5', { writtenOn: '2026-10-08', counterpartyKey: 'B', total: 10 })],
    }));
    const host = new BankHost({ rpc: async (m) => (m === 'db.query.bank.overview' ? overview : cf), profileId: async () => 'p', pick: async () => null, readSheet: async () => { throw new Error('unused'); }, log: () => {} });
    assert.deepEqual(await host.payables(), [{ counterpartyId: 'c1', counterparty: '에스자재', date: '2026-11-03', total: 330_000, dueOn: '2026-12-03' }]);
    const brief = (await host.cashFlowBrief())!;
    assert.equal(brief.in.total, 400_000);
    assert.equal(brief.topCustomer?.counterparty, 'A상사');
    assert.ok(brief.alerts.some((a) => a.kind === 'concentration'));
    const text = JSON.stringify(brief);
    for (const bad of ['9876', 'secret-id', 'cp-uuid', '모름']) assert.ok(!text.includes(bad), bad);
    const none = new BankHost({ rpc: async () => ({ accounts: [], payables: { unpaid: [] }, month: { hasAccounts: false } }), profileId: async () => 'p', pick: async () => null, readSheet: async () => { throw new Error('unused'); }, log: () => {} });
    assert.equal(await none.payables(), null);
    assert.equal(await none.cashFlowBrief(), null);
  });
});
