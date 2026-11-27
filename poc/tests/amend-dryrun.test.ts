import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { AmendRepo } from '@sax/db';
import { realDryRun, AMEND_ORIGINAL, type Outcome } from './h01-real-dryrun.ts';
import { kstToday } from './hometax-fake.ts';

const show = (o: Outcome) => `end=${JSON.stringify(o.end)} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;
const commits = (o: Outcome) => o.actions.filter((a) => /^ATEETBAA002C0[458]$/.test(a));
const amends = (o: Outcome) => o.fx.state.invoices.filter((i) => i.amendOf === AMEND_ORIGINAL.etan);

describe('수정세금계산서 패키지: 가짜 홈택스 건조 실행(ADR-058 결정 6, 9)', () => {
  it('금액 바뀜(330만 → 300만): 메뉴 → 승인번호 → 사유 → [감소] → 작성 → 미리보기 대조 → 게이트 → 서명 → 목록에서 음(-) 1장 확정', async () => {
    let rows: unknown[] = [];
    const o = await realDryRun({ loggedIn: true, amend: { what: 'amount_changed', values: { supply: 3_000_000, tax: 300_000 } }, afterRun: (db) => (rows = new AmendRepo(db).all()) });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(commits(o), ['ATEETBAA002C04', 'ATEETBAA002C05', 'ATEETBAA002C08']);
    const m = amends(o);
    assert.deepEqual(m.map((i) => [i.sumSplCftStr, i.sumTxamtStr, i.wrtDt]), [['-300,000', '-30,000', kstToday()]]);
    assert.equal(o.end?.approvalNo, m[0]!.etan);
    assert.ok(o.steps.includes('s50e') && !o.steps.includes('s50c'), '감소를 누른다');
    assert.deepEqual((rows as Array<{ state: string; supply: number }>).map((r) => [r.state, r.supply]), [['committed', -300_000]]);
  });

  it('잘못 적음(공급가액 330만 → 300만): 당초분 취소 1장(홈택스 자동) + 새 계산서 1장, 취소분 합계도 대조한다', async () => {
    const o = await realDryRun({ loggedIn: true, amend: { what: 'wrong_entry', values: { supply: 3_000_000, tax: 300_000 } } });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(amends(o).map((i) => i.totaAmtStr), ['-3,630,000', '3,300,000']);
    assert.ok(o.steps.includes('s72d'), '취소분 합계 대조');
  });

  it('두 번 발급: 값 입력 없이 당초 작성일자로 전액 음수 1장', async () => {
    const o = await realDryRun({ loggedIn: true, amend: { what: 'duplicate' } });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(amends(o).map((i) => [i.totaAmtStr, i.wrtDt]), [['-3,630,000', AMEND_ORIGINAL.wrtDt]]);
  });

  it('거래 취소: 확인 창 → 해제일 → 전액 음수. 같은 원본을 또 취소하려 하면 시작에서 막는다', async () => {
    const o = await realDryRun({ loggedIn: true, amend: { what: 'deal_cancelled' } });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(amends(o).map((i) => [i.totaAmtStr, i.wrtDt]), [['-3,630,000', kstToday()]]);
    await assert.rejects(realDryRun({ loggedIn: true, amend: { what: 'duplicate', prior: (db) => {
      new AmendRepo(db).open({ runId: 'r0', intentId: 'i0', originalApprovalNo: AMEND_ORIGINAL.etan, what: 'deal_cancelled', blockKey: 'full_cancel', issueDate: kstToday(), supply: -3_300_000, tax: -330_000, item: '유지보수', cpBizNo: '2148651233' });
    } } }), /amend\.already_cancelled/);
  });

  it('반품(50만): 남는 금액으로 음수 1장', async () => {
    const o = await realDryRun({ loggedIn: true, amend: { what: 'returned', values: { supply: 2_800_000, tax: 280_000 } } });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(amends(o).map((i) => i.totaAmtStr), ['-550,000']);
  });

  it('당초 작성일이 오래돼도(두 번 발급은 당초 작성일로 쓴다) 목록을 발급일자로 찾아 확정한다', async () => {
    let rows: Array<{ state: string }> = [];
    const o = await realDryRun({ loggedIn: true, amend: { what: 'duplicate', original: { wrtDt: '2026-10-02' } }, afterRun: (db) => (rows = new AmendRepo(db).all() as never) });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(amends(o).map((i) => [i.totaAmtStr, i.wrtDt]), [['-3,630,000', '2026-10-02']]);
    assert.deepEqual(rows.map((r) => r.state), ['committed']);
  });

  it('홈택스 작성 화면의 당초 공급받는자 번호가 장부와 다르면 멈추고 게이트, 커밋 요청이 없다', async () => {
    const o = await realDryRun({ loggedIn: true, amend: { what: 'returned', values: { supply: 2_800_000, tax: 280_000 }, original: { dmnrTxprDscmNo: '214-86-51234' } } });
    assert.deepEqual([o.end?.status, o.end?.code, o.gate], ['failed', 'assert.original_mismatch', false], show(o));
    assert.deepEqual(commits(o), []);
  });
});
