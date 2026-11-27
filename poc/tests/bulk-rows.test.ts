import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bulkRoute, issueRowsFrom, type IssueRow } from '../apps/desktop/src/bulk-issue.ts';
import { makeBatch, rowIssues } from '../apps/desktop/static/shell/bulk-model.js';
import { bulkPlan, type BulkStartRow } from '../packages/engine/src/bulk-run.ts';
import { BULK_ROWS_PER_RUN, isBulkRows } from '../packages/engine/src/core/bulk.ts';
import { businessKey } from '../packages/engine/src/h01/playbook.ts';
import { RunEnd } from '../packages/engine/src/run-end.ts';

const TODAY = '2026-11-24';
const BUYER = '1234567891';
const SUPPLIER = { bizNo: '2148651233', displayName: '가나다컴퍼니', repName: '김가나' };

const row = (i: number, x: Partial<IssueRow> = {}): IssueRow => ({ key: `r${i}`, name: `거래처${i}`, bizNo: BUYER, cpId: null, date: TODAY, item: '용역', supply: 1000 + i, vat: Math.floor((1000 + i) / 10), taxable: true, ...x });
const issue = (rows: unknown[]) => issueRowsFrom(JSON.stringify(rows), TODAY);
const start = (i: number, x: Partial<BulkStartRow> = {}): BulkStartRow => ({ buyer: { bizNo: BUYER, name: `거래처${i}`, repName: '박대표' }, writeDate: TODAY, item: '용역', supply: 1000 + i, tax: Math.floor((1000 + i) / 10), ...x });
const plan = (rows: unknown) => bulkPlan(SUPPLIER, rows, TODAY, businessKey);
const code = (f: () => unknown) => {
  try {
    f();
    return 'ok';
  } catch (e) {
    return e instanceof RunEnd ? e.code : `${(e as Error).name}`;
  }
};

describe('여러 건 발급 경계값(ADR-059, ADR-063)', () => {
  it('main 다시 검사: 공급가액 0원은 부가세가 있어도 받지 않는다(엔진 bulkPlan과 같은 규칙)', () => {
    assert.equal(issue([row(1, { supply: 0, vat: 0 })]).ok, false);
    assert.deepEqual(issue([row(1, { supply: 0, vat: 100 })]), { ok: false, code: 'bulk.bad_row' });
    assert.equal(code(() => plan([start(1, { supply: 0, tax: 100 })])), 'bulk.bad_amount:1');
    assert.equal(issue([row(1, { supply: 1, vat: 0 })]).ok, true, '1원은 받는다');
  });

  it('main 다시 검사: 음수, 원 아래, 면세 부가세, 빈 품목, 앞날, 없는 날짜, 같은 key', () => {
    for (const x of [{ supply: -1 }, { vat: -1 }, { supply: 1.5 }, { taxable: false, vat: 1 }, { item: '  ' }, { name: '' }, { bizNo: '1234567890' }, { date: '2026-11-25' }, { date: '2026-02-30' }, { date: '2026-13-40' }, { date: '' }]) {
      assert.deepEqual(issue([row(1, x)]), { ok: false, code: 'bulk.bad_row' }, JSON.stringify(x));
    }
    assert.deepEqual(issue([row(1), row(1)]), { ok: false, code: 'bulk.bad_row' });
    assert.deepEqual(issue([]), { ok: false, code: 'bulk.no_rows' });
    assert.deepEqual(issueRowsFrom('[', TODAY), { ok: false, code: 'bulk.bad_rows' });
  });

  it('main 다시 검사: 5000건까지 받고 5001건은 받지 않는다', () => {
    const rows = Array.from({ length: 5001 }, (_, i) => row(i));
    const ok = issue(rows.slice(0, 5000));
    assert.equal(ok.ok && ok.rows.length, 5000);
    assert.deepEqual(issue(rows), { ok: false, code: 'bulk.too_many' });
  });

  it('홈택스 길: 오늘 과세 10건까지는 건별, 11건이나 지난날, 면세, 부가세가 10%가 아니면 일괄발급', () => {
    const ten = Array.from({ length: 10 }, (_, i) => row(i));
    assert.equal(bulkRoute(ten, TODAY), 'each');
    assert.equal(bulkRoute([...ten, row(10)], TODAY), 'sheet');
    assert.equal(bulkRoute([row(1, { date: '2026-11-23' })], TODAY), 'sheet');
    assert.equal(bulkRoute([row(1, { taxable: false, vat: 0 })], TODAY), 'sheet');
    assert.equal(bulkRoute([row(1, { vat: 0 })], TODAY), 'sheet');
  });

  it('엔진 한 묶음: 50건까지, 51건과 빈 묶음은 시작하지 않는다', () => {
    assert.equal(BULK_ROWS_PER_RUN, 50);
    const fifty = Array.from({ length: 50 }, (_, i) => start(i));
    const p = plan(fifty);
    assert.deepEqual([p.count, p.rows.length, p.first], ['50', 50, '거래처0']);
    assert.equal(p.total, fifty.reduce((n, r) => n + r.supply + r.tax, 0).toLocaleString('en-US'));
    assert.equal(code(() => plan([...fifty, start(50)])), 'bulk.bad_rows');
    assert.equal(code(() => plan([])), 'bulk.bad_rows');
    assert.equal(isBulkRows(p.rows), true);
    assert.equal(isBulkRows([...p.rows, p.rows[0]]), false);
  });

  it('엔진 한 묶음: 줄 번호를 붙여 막는다(0원, 음수, 없는 날짜, 기한 지남, 같은 줄, 공급자 자신)', () => {
    assert.equal(code(() => plan([start(1), start(2, { supply: 0 })])), 'bulk.bad_amount:2');
    assert.equal(code(() => plan([start(1, { tax: -1 })])), 'bulk.bad_amount:1');
    assert.equal(code(() => plan([start(1, { supply: 1.5 })])), 'bulk.bad_amount:1');
    assert.equal(code(() => plan([start(1, { writeDate: '2026-02-30' })])), 'bulk.bad_date:1');
    assert.equal(code(() => plan([start(1, { writeDate: '2026-13-40' })])), 'bulk.bad_date:1', '없는 달도 RangeError가 아니라 bad_date');
    assert.equal(code(() => plan([start(1, { writeDate: '2026-11-25' })])), 'bulk.bad_date:1');
    assert.equal(code(() => plan([start(1, { writeDate: '2026-09-01' })])), 'bulk.issue_late:1');
    assert.equal(code(() => plan([start(1, { item: ' ' })])), 'bulk.item_missing:1');
    assert.equal(code(() => plan([start(1), start(1)])), 'bulk.duplicate_rows');
    assert.equal(code(() => plan([start(1, { buyer: { bizNo: SUPPLIER.bizNo, name: '나', repName: '나' } })])), 'bulk.bad_bizno:1');
    assert.equal(code(() => plan([start(1, { buyer: { bizNo: BUYER, name: '가'.repeat(36), repName: '박' } })])), 'bulk.too_long:1', '상호 70바이트 넘으면 자르지 않고 막는다');
  });

  it('목록 화면: 공급가액 0원은 부가세가 있어도 고쳐야 넣는 건이다', () => {
    const cps = [{ id: 'cp1', name: '거래처1', bizNo: BUYER, item: '용역' }];
    const base = { key: 'r1', line: 2, name: '거래처1', fileBizNo: BUYER, bizNo: BUYER, cpId: null, date: TODAY, item: '용역', taxable: true, fileIssues: [] as string[] };
    assert.deepEqual(rowIssues({ ...base, supply: 0, vat: 100 }, cps, TODAY), ['amount_zero']);
    assert.deepEqual(rowIssues({ ...base, supply: 0, vat: 0 }, cps, TODAY), ['amount_zero']);
    assert.deepEqual(rowIssues({ ...base, supply: -1, vat: 0 }, cps, TODAY), ['amount_negative']);
    assert.deepEqual(rowIssues({ ...base, supply: null, vat: null }, cps, TODAY), ['amount_missing']);
    const b = makeBatch([{ key: 'r1', line: 2, name: '거래처1', bizNo: BUYER, date: TODAY, item: '용역', supply: 0, vat: 100, taxable: true, fileIssues: [] }], cps, TODAY, 'b1');
    assert.equal(b.rows[0].on, false, '체크가 꺼진 채로 시작한다');
  });
});
