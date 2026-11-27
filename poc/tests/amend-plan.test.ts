import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AMEND_GROUPS, AMEND_LABEL, amendEditAmount, amendNotice, amendPlan, amendStart, amendTitle, type AmendOriginal } from '@sax/chat-core';

const TODAY = '2026-11-24';
const ORIG: AmendOriginal = {
  approvalNo: '20261117-10000001-00000001', issueDate: '2026-11-17', issuedOn: '2026-11-17',
  counterpartBizNo: '1234567890', counterpartName: '대한테크', item: '유지보수', supply: 3_300_000, tax: 330_000,
};

describe('수정세금계산서 계산(ADR-058)', () => {
  it('카드 두 묶음 여섯 줄은 캔버스 순서와 글이다', () => {
    assert.deepEqual(AMEND_GROUPS.map((g) => g.map((w) => AMEND_LABEL[w])), [
      ['잘못 적었어요', '두 번 발급했어요', '내국신용장이 나왔어요'],
      ['금액이 바뀌었어요', '거래가 취소됐어요', '물건을 돌려받았어요'],
    ]);
  });

  it('잘못 적음: 원래 값 그대로면 발급하기가 켜지지 않고, 공급가액만 고치면 취소 1장 + 새 계산서 1장', () => {
    const v0 = amendStart(ORIG, 'wrong_entry', TODAY);
    assert.deepEqual(v0, { issueDate: '2026-11-17', supply: 3_300_000, tax: 330_000, item: '유지보수', counterpartBizNo: '1234567890' });
    assert.deepEqual(amendPlan(ORIG, 'wrong_entry', v0, TODAY).blocks, ['no_change']);
    const v = amendEditAmount(v0, 'supply', 3_000_000);
    const p = amendPlan(ORIG, 'wrong_entry', v, TODAY);
    assert.equal(p.ready, true, JSON.stringify(p.blocks));
    assert.deepEqual(p.sheets, [
      { kind: 'cancel', issueDate: '2026-11-17', supply: -3_300_000, tax: -330_000, total: -3_630_000 },
      { kind: 'new', issueDate: '2026-11-17', supply: 3_000_000, tax: 300_000, total: 3_300_000 },
    ]);
    assert.equal(p.main.kind, 'new');
    assert.deepEqual([p.before.total, p.after.total], [3_630_000, 3_300_000]);
  });

  it('잘못 적음: 작성일을 발급한 날보다 뒤로 고치면 막는다', () => {
    const p = amendPlan(ORIG, 'wrong_entry', { ...amendStart(ORIG, 'wrong_entry', TODAY), issueDate: '2026-11-20' }, TODAY);
    assert.deepEqual(p.blocks, ['date_after_issued']);
    assert.equal(amendNotice(p), '발급한 날보다 뒤로는 고칠 수 없어요.');
  });

  it('금액 세 칸 연동: 공급가액 → 부가세 10%와 합계, 부가세만 → 공급가액 그대로, 합계 → 맞는 공급가액', () => {
    const v = amendStart(ORIG, 'amount_changed', TODAY);
    assert.deepEqual(amendEditAmount(v, 'supply', 1_234_567), { ...v, supply: 1_234_567, tax: 123_456 });
    const t = amendEditAmount(v, 'tax', 300_000);
    assert.deepEqual([t.supply, t.tax], [3_300_000, 300_000]);
    const s = amendEditAmount(v, 'total', 3_300_000);
    assert.deepEqual([s.supply, s.tax], [3_000_000, 300_000]);
    assert.equal(amendEditAmount(v, 'total', -5), v, '음수는 받지 않는다');
  });

  it('금액 바뀜: 고친 뒤 금액으로 차액 1장(음수), 바뀐 날은 오늘', () => {
    const v = amendEditAmount(amendStart(ORIG, 'amount_changed', TODAY), 'total', 3_300_000);
    const p = amendPlan(ORIG, 'amount_changed', v, TODAY);
    assert.deepEqual(p.sheets, [{ kind: 'change', issueDate: TODAY, supply: -300_000, tax: -30_000, total: -330_000 }]);
    assert.deepEqual([p.ready, p.notes], [true, []]);
  });

  it('금액 바뀜: 늘면 새 계산서 안내 한 줄(막지 않음), 같으면 발급하기 꺼짐', () => {
    const up = amendPlan(ORIG, 'amount_changed', amendEditAmount(amendStart(ORIG, 'amount_changed', TODAY), 'supply', 4_000_000), TODAY);
    assert.deepEqual([up.ready, up.notes, amendNotice(up)], [true, ['increase_is_new'], '더 판 것이면 새 계산서로 발급해요.']);
    const same = amendPlan(ORIG, 'amount_changed', amendStart(ORIG, 'amount_changed', TODAY), TODAY);
    assert.deepEqual([same.ready, same.blocks], [false, ['same_amount']]);
  });

  it('반품: 남는 금액으로 음수 1장. 이미 줄인 금액이 있으면 지금 남은 값에서 센다, 남은 것보다 많으면 막는다', () => {
    const o = { ...ORIG, supply: 1_230_000, tax: 123_000 };
    const p = amendPlan(o, 'returned', amendEditAmount(amendStart(o, 'returned', TODAY), 'supply', 730_000), TODAY);
    assert.deepEqual(p.sheets[0], { kind: 'change', issueDate: TODAY, supply: -500_000, tax: -50_000, total: -550_000 });
    const adj = { ...o, adjusted: { supply: -500_000, tax: -50_000 } };
    assert.deepEqual(amendStart(adj, 'returned', TODAY).supply, 730_000, '기존은 지금 남은 값');
    const over = amendPlan(adj, 'returned', { ...amendStart(adj, 'returned', TODAY), supply: -1, tax: 0 }, TODAY);
    assert.ok(over.blocks.includes('bad_amount'));
    const more = amendPlan(o, 'returned', amendEditAmount(amendStart(o, 'returned', TODAY), 'supply', 2_000_000), TODAY);
    assert.deepEqual(more.blocks, ['not_less']);
  });

  it('두 번 발급: 당초 작성일자로 전액 음수 1장, 값을 묻지 않는다', () => {
    const p = amendPlan(ORIG, 'duplicate', amendStart(ORIG, 'duplicate', TODAY), TODAY);
    assert.deepEqual(p.sheets, [{ kind: 'cancel', issueDate: '2026-11-17', supply: -3_300_000, tax: -330_000, total: -3_630_000 }]);
    assert.equal(p.ready, true);
    assert.equal(amendTitle('대한테크', 'duplicate'), '대한테크 세금계산서 취소');
  });

  it('거래 취소: 취소된 날로 지금 남은 금액 전액 음수. 원래 작성일보다 앞선 날, 미래는 막는다', () => {
    const p = amendPlan(ORIG, 'deal_cancelled', amendStart(ORIG, 'deal_cancelled', TODAY), TODAY);
    assert.deepEqual(p.sheets, [{ kind: 'cancel', issueDate: TODAY, supply: -3_300_000, tax: -330_000, total: -3_630_000 }]);
    const early = amendPlan(ORIG, 'deal_cancelled', { ...amendStart(ORIG, 'deal_cancelled', TODAY), issueDate: '2026-11-10' }, TODAY);
    assert.deepEqual(early.blocks, ['date_before_original']);
    const late = amendPlan(ORIG, 'deal_cancelled', { ...amendStart(ORIG, 'deal_cancelled', TODAY), issueDate: '2026-11-25' }, TODAY);
    assert.deepEqual(late.blocks, ['date_future']);
  });

  it('내국신용장은 아직 못 해요(다른 사유로 돌리지 않는다). 이미 취소한 것은 막는다', () => {
    assert.deepEqual(amendPlan(ORIG, 'local_lc', amendStart(ORIG, 'local_lc', TODAY), TODAY).blocks, ['not_yet']);
    assert.deepEqual(amendPlan({ ...ORIG, cancelled: true }, 'returned', amendEditAmount(amendStart(ORIG, 'returned', TODAY), 'supply', 1), TODAY).blocks, ['already_cancelled']);
  });

  it('기한: 사유가 생긴 다음 달 10일이 지나면 알리기만 한다. 당초분 신고 기한이 지난 잘못 적음은 완료 문장', () => {
    const o = { ...ORIG, issueDate: '2026-03-02', issuedOn: '2026-03-02' };
    const p = amendPlan(o, 'returned', amendEditAmount({ ...amendStart(o, 'returned', TODAY), issueDate: '2026-04-01' }, 'supply', 1_000_000), TODAY);
    assert.deepEqual([p.ready, p.notes], [true, ['deadline']]);
    const w = amendPlan(o, 'wrong_entry', amendEditAmount(amendStart(o, 'wrong_entry', TODAY), 'supply', 1_000_000), TODAY);
    assert.equal(w.vatFiled, true);
    assert.equal(amendPlan(ORIG, 'wrong_entry', amendEditAmount(amendStart(ORIG, 'wrong_entry', TODAY), 'supply', 1), TODAY).vatFiled, false);
  });

  it('말에서 읽은 값은 미리 채운다(사유는 채우지 않는다)', () => {
    const v = amendStart(ORIG, 'amount_changed', TODAY, { supply: 3_000_000, issueDate: '2026-11-20' });
    assert.deepEqual([v.supply, v.tax, v.issueDate], [3_000_000, 300_000, '2026-11-20']);
    assert.equal(amendStart(ORIG, 'duplicate', TODAY, { issueDate: '2026-11-20', supply: 1 }).issueDate, '2026-11-17', '두 번 발급은 당초 작성일자');
  });
  it('경계값: 0원, 음수, 원 아래, 상한, 없는 날짜', () => {
    const blocks = (what: Parameters<typeof amendStart>[1], v: Partial<ReturnType<typeof amendStart>>, o: AmendOriginal = ORIG) => amendPlan(o, what, { ...amendStart(o, what, TODAY), ...v }, TODAY).blocks;
    assert.deepEqual(blocks('wrong_entry', { supply: 0, tax: 0 }), ['bad_amount'], '잘못 적음의 새 계산서는 0원이 안 된다');
    assert.deepEqual(blocks('wrong_entry', { supply: -1, tax: 0 }), ['bad_amount']);
    assert.deepEqual(blocks('wrong_entry', { supply: 1.5 }), ['bad_amount']);
    assert.deepEqual(blocks('wrong_entry', { supply: 1e12 + 1 }), ['bad_amount']);
    assert.deepEqual(blocks('amount_changed', { tax: -1 }), ['bad_amount', 'nothing_left']);
    assert.deepEqual(blocks('wrong_entry', { issueDate: '2026-11-00', supply: 1 }), ['date_future']);
    assert.deepEqual(blocks('wrong_entry', { issueDate: '', supply: 1 }), ['date_future']);
    assert.deepEqual(blocks('wrong_entry', { issueDate: '2026-02-30', supply: 1 }, { ...ORIG, issueDate: '2026-01-10', issuedOn: '2026-03-01' }), ['date_future']);
    assert.deepEqual(blocks('deal_cancelled', { issueDate: '2026-02-30' }, { ...ORIG, issueDate: '2026-02-01' }), ['date_future']);
    assert.deepEqual(blocks('returned', { issueDate: '2026-13-01', supply: 1 }), ['date_future']);
  });

  it('경계값: 0원까지 줄이기는 한 장, 이미 다 줄인 원본의 취소와 금액 바뀜은 막는다', () => {
    const toZero = amendPlan(ORIG, 'amount_changed', { ...amendStart(ORIG, 'amount_changed', TODAY), supply: 0, tax: 0 }, TODAY);
    assert.deepEqual([toZero.ready, toZero.sheets], [true, [{ kind: 'change', issueDate: TODAY, supply: -3_300_000, tax: -330_000, total: -3_630_000 }]]);
    const returnedAll = amendPlan(ORIG, 'returned', { ...amendStart(ORIG, 'returned', TODAY), supply: 0, tax: 0 }, TODAY);
    assert.equal(returnedAll.ready, true);
    const gone = { ...ORIG, adjusted: { supply: -3_300_000, tax: -330_000 } };
    assert.deepEqual(amendPlan(gone, 'deal_cancelled', amendStart(gone, 'deal_cancelled', TODAY), TODAY).blocks, ['nothing_left']);
    assert.deepEqual(amendPlan(gone, 'amount_changed', amendStart(gone, 'amount_changed', TODAY), TODAY).blocks, ['same_amount']);
    assert.deepEqual(amendPlan(gone, 'returned', amendStart(gone, 'returned', TODAY), TODAY).blocks, ['not_less']);
  });

  it('경계값: 두 번 발급과 잘못 적음은 앞선 수정분이 있어도 당초분 전액, 거래 취소는 지금 남은 값', () => {
    const adj = { ...ORIG, adjusted: { supply: -300_000, tax: -30_000 } };
    assert.deepEqual(amendPlan(adj, 'duplicate', amendStart(adj, 'duplicate', TODAY), TODAY).sheets[0]!.total, -3_630_000);
    assert.deepEqual(amendPlan(adj, 'deal_cancelled', amendStart(adj, 'deal_cancelled', TODAY), TODAY).sheets[0]!.total, -3_300_000);
    assert.deepEqual(amendPlan({ ...ORIG, cancelled: true }, 'duplicate', amendStart(ORIG, 'duplicate', TODAY), TODAY).blocks, ['already_cancelled']);
    assert.deepEqual(amendPlan({ ...ORIG, replaced: true }, 'wrong_entry', amendEditAmount(amendStart(ORIG, 'wrong_entry', TODAY), 'supply', 1), TODAY).blocks, ['already_replaced']);
  });

  it('경계값: 빈 품목, 틀린 거래처 번호, 같은 날 거래 취소', () => {
    const w = amendStart(ORIG, 'wrong_entry', TODAY);
    assert.deepEqual(amendPlan(ORIG, 'wrong_entry', { ...w, item: '   ' }, TODAY).blocks, ['bad_item']);
    assert.deepEqual(amendPlan(ORIG, 'wrong_entry', { ...w, counterpartBizNo: '123456789' }, TODAY).blocks, ['bad_bizno']);
    assert.equal(amendPlan(ORIG, 'deal_cancelled', { ...amendStart(ORIG, 'deal_cancelled', TODAY), issueDate: ORIG.issueDate }, TODAY).ready, true, '원래 작성일과 같은 날은 된다');
    assert.deepEqual(amendStart(ORIG, 'amount_changed', TODAY, { supply: -5 }).supply, 3_300_000, '음수로 말한 금액은 채우지 않는다');
    assert.deepEqual([amendEditAmount(w, 'total', 1).supply, amendEditAmount(w, 'total', 1).tax], [1, 0]);
    assert.equal(amendEditAmount(w, 'supply', 1.5), w, '원 아래는 받지 않는다');
  });
});
