import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BulkRepo } from '@sax/db';
import type { BulkStartRow } from '@sax/engine';
import { realDryRun, type Outcome } from './h01-real-dryrun.ts';
import { kstToday } from './hometax-fake.ts';

/** 검사 숫자가 맞는 가짜 사업자번호(앞 9자리 + 검사 숫자). */
function bizNo(head9: string): string {
  const w = [1, 3, 7, 1, 3, 7, 1, 3, 5];
  const d = [...head9].map(Number);
  let sum = d.reduce((n, x, i) => n + x * w[i]!, 0);
  sum += Math.floor((d[8]! * 5) / 10);
  return head9 + String((10 - (sum % 10)) % 10);
}

const rows = (n: number): BulkStartRow[] => Array.from({ length: n }, (_, i) => ({
  buyer: { bizNo: bizNo(`2148651${String(10 + i).padStart(2, '0')}`), name: `거래처${i + 1}`, repName: `대표${i + 1}`, email: `tax${i + 1}@buyer.example` },
  writeDate: kstToday(), item: '유지보수', supply: 100_000 + i * 1_000, tax: 10_000 + i * 100,
}));

const show = (o: Outcome) => `end=${JSON.stringify(o.end)} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;
const commits = (o: Outcome) => o.actions.filter((a) => /^ATEETBAA004C1[356]$/.test(a));

describe('대량 발급 패키지: 가짜 홈택스 일괄발급 건조 실행(ADR-059 시험 목록, ADR-063)', () => {
  it('11건: 금고가 만든 파일 올리기 → 변환 목록 줄마다 대조 → 승인 한 번 → 확인창 건수와 합계 대조 → 서명 한 번 → 승인번호 11개', async () => {
    let repo: Array<{ state: string; approvalNo: string | null }> = [];
    const o = await realDryRun({ loggedIn: true, bulk: { rows: rows(11) }, maxMs: 120_000, afterRun: (db) => (repo = new BulkRepo(db).byRun('r1') as never) });
    assert.equal(o.end?.status, 'success', show(o));
    assert.deepEqual(o.fx.bulkUploads(), [11]);
    assert.deepEqual(commits(o), ['ATEETBAA004C15', 'ATEETBAA004C16', 'ATEETBAA004C13']);
    assert.equal(o.fx.state.invoices.length, 11);
    assert.equal(o.fx.state.certUses.filter((u) => u.mode === 'sign').length, 1, '서명은 묶음에 한 번');
    const nos = (o.end as { approvalNos?: string[] }).approvalNos ?? [];
    assert.deepEqual(nos, o.fx.state.invoices.map((i) => i.etan));
    assert.deepEqual(repo.map((r) => [r.state, r.approvalNo]), nos.map((n) => ['committed', n]));
  });

  it('줄 확인창(폐업)을 취소하면 그 줄이 빠져 본 확인창의 건수가 달라지고, 본 확인창도 취소해 아무것도 발급하지 않는다', async () => {
    const o = await realDryRun({ loggedIn: true, knobs: { bulkClosedRow: 3 }, bulk: { rows: rows(11) }, maxMs: 120_000 });
    assert.equal(o.end?.status, 'failed', show(o));
    assert.equal(o.end?.code, 'bulk.not_issued', show(o));
    assert.deepEqual(commits(o), []);
    assert.equal(o.fx.state.invoices.length, 0);
    assert.ok(o.journal.includes('submit.confirm_declined'), show(o));
  });

  it('변환 목록 금액이 승인할 줄과 1원이라도 다르면 승인 전에 멈춘다', async () => {
    const o = await realDryRun({ loggedIn: true, knobs: { bulkTamperRow: 2 }, bulk: { rows: rows(11) }, maxMs: 60_000 });
    assert.equal(o.end?.status, 'failed', show(o));
    assert.equal(o.gate, false);
    assert.deepEqual(commits(o), []);
  });
});
