import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { ShellRuns } from '../apps/desktop/src/shell-runs.ts';
import { agentPorts, AGENT_HISTORY_LIMIT, draftCard, issuedRows, type AgentRuns } from '../apps/desktop/src/agent-wiring.ts';
import type { Counterparty, RunView } from '../apps/desktop/src/shell-model.ts';

const CP: Counterparty = { id: 'cpA', name: 'A상사', bizNo: '1234567890', rep: '김', email: 'a@x.kr', item: '컨설팅', status: 'active', checkedOn: '2026-11-01', lastIssuedOn: null };
const run = (o: Partial<RunView> = {}): RunView =>
  ({ id: 'run-1', status: 'draft', counterparty: { id: 'cpA', name: 'A상사', bizNo: '1234567890', first: false }, email: { value: CP.email, first: false }, amount: 1_000_000, supply: 1_000_000, tax: 100_000, vat: 'separate', vatGuessed: true, item: '컨설팅', itemGuessed: true, writeDate: '2026-11-12', ...o }) as RunView;

describe('issuedRows: 원장 이력 → 발급 행', () => {
  it('세금계산서 발급(hometax.invoice.issue)이고 승인번호 있는 실행만(민원증명 제외), 날짜는 끝난 시각의 KST, 합계는 공급가+세액, 승인번호·문서함 PDF·메일 상태를 싣는다', () => {
    const rows = issuedRows([
      { playbookId: 'hometax.invoice.issue', approvalNo: '20261031-1', documentId: 'doc-1', mailConfirmed: false, counterpartyId: 'cpA', counterpartyName: 'A상사', supply: 1_000_000, tax: 100_000, startedAt: '2026-10-31T15:00:00Z', finishedAt: '2026-10-31T15:30:00Z' },
      { playbookId: 'hometax.invoice.issue', approvalNo: null, counterpartyId: 'cpB', counterpartyName: 'B상사', supply: 500_000, tax: 50_000, startedAt: '2026-10-20T01:00:00Z', finishedAt: '2026-10-20T01:10:00Z' },
      { playbookId: 'hometax.invoice.issue', approvalNo: '20261020-2', mailConfirmed: true, counterpartyId: null, counterpartyName: null, supply: null, tax: null, startedAt: '2026-10-20T01:00:00Z', finishedAt: null },
      { playbookId: 'hometax.cert.biz_registration', approvalNo: '318-2026-2-1', counterpartyId: null, counterpartyName: null, supply: null, tax: null, startedAt: '2026-10-21T01:00:00Z', finishedAt: '2026-10-21T01:05:00Z' },
    ]);
    assert.deepEqual(rows, [
      { counterpartyId: 'cpA', counterparty: 'A상사', date: '2026-11-01', total: 1_100_000, approvalNo: '20261031-1', documentId: 'doc-1', mail: 'unconfirmed', issueDate: null, supply: 1_000_000, tax: 100_000, item: null, amend: null },
      { counterpartyId: null, counterparty: '이름 모름', date: '2026-10-20', total: null, approvalNo: '20261020-2', documentId: null, mail: 'sent', issueDate: null, supply: null, tax: null, item: null, amend: null },
    ]);
  });
  it('모양이 다르면 빈 목록', () => {
    assert.deepEqual(issuedRows(null), []);
    assert.deepEqual(issuedRows({ rows: [] }), []);
  });
});

describe('draftCard', () => {
  it('추정 부가세는 null(모델에 정하지 않았다고 보인다), 빈 품목은 null', () => {
    assert.deepEqual(draftCard(run()), { runId: 'run-1', counterpartyId: 'cpA', amount: 1_000_000, vat: null, item: '컨설팅', status: 'draft' });
    assert.deepEqual(draftCard(run({ vatGuessed: false, vat: 'included', item: ' ' })), { runId: 'run-1', counterpartyId: 'cpA', amount: 1_000_000, vat: 'included', item: null, status: 'draft' });
  });
});

describe('agentPorts', () => {
  const setup = (missing = false) => {
    const calls: unknown[][] = [];
    const created: RunView[] = [];
    const runs: AgentRuns = {
      list: () => [run(), run({ id: 'run-2', status: 'waiting' }), run({ id: 'run-3', status: 'waiting', approvedPending: true }), run({ id: 'run-4', status: 'issuing' })],
      counterparties: [CP],
      createDraft: (...a) => (calls.push(['create', ...a]), run({ id: 'run-9' })),
      updateDraft: (...a) => (calls.push(['update', ...a]), run()),
      discardDraft: (...a) => (calls.push(['discard', ...a]), run({ discarded: true })),
      stop: async (...a) => (calls.push(['stop', ...a]), run({ status: 'stopped' })),
    };
    const ports = agentPorts({
      rpc: async (m, p) => (calls.push(['rpc', m, p]), m === 'db.query.runs.history' ? [] : { kind: 'reply' }),
      profileId: () => 'pf-1',
      runs,
      setupMissing: () => missing,
      onCreated: (r) => created.push(r),
      onProgress: () => {},
      pastIssued: () => [{ counterpartyId: 'cpA', counterparty: 'A상사', date: '2026-10-03', total: 550_000 }],
      now: () => Date.parse('2026-11-12T03:00:00Z'),
    });
    return { ports, calls, created };
  };

  it('초안 포트는 목록·미등록·만들기·고치기·버리기뿐이다(준비·발급 없음)', () => {
    const { ports } = setup();
    assert.deepEqual(Object.keys(ports.drafts).sort(), ['create', 'discard', 'list', 'setupMissing', 'update']);
    assert.deepEqual(ports.drafts.list().map((d) => d.runId), ['run-1', 'run-2'], '초안과 승인 전 카드만 간다(승인했거나 발급 중인 건은 빠진다)');
  });

  it('버리기: 초안은 지우고, 승인 카드가 떠 있는 건은 [중지]처럼 멈춘다. 승인한 건은 거절한다', async () => {
    const { ports, calls } = setup();
    await ports.drafts.discard('run-1');
    await ports.drafts.discard('run-2');
    await assert.rejects(async () => ports.drafts.discard('run-3'), /not_draft/);
    await assert.rejects(async () => ports.drafts.discard('run-4'), /not_draft/);
    assert.deepEqual(calls, [['discard', 'run-1'], ['stop', 'run-2']]);
  });

  it('만들기: 장부 거래처로 초안을 만들고 onCreated에 알린다. 사업장이 빠졌으면 만들지 않는다', () => {
    const a = setup();
    assert.deepEqual(a.ports.drafts.create('cpA', 1_100_000, null, '컨설팅'), {
      runId: 'run-9',
      card: { counterpartyId: 'cpA', amount: 1_000_000, vat: 'separate', vatGuessed: true, writeDate: '2026-11-12', quantity: null, unitPrice: null, canPrepare: true },
    });
    assert.deepEqual(a.calls, [['create', CP, 1_100_000, null, '컨설팅']]);
    assert.deepEqual(a.created.map((r) => r.id), ['run-9']);
    assert.throws(() => a.ports.drafts.create('cpZ', 1, null, null), /no_counterparty/);
    const b = setup(true);
    assert.deepEqual(b.ports.drafts.create('cpA', 1_100_000, null, '컨설팅'), { setup: true });
    assert.deepEqual(b.calls, []);
  });

  it('step은 엔진 chat.step, 발급 행은 원장(상한 200) + 지난 발급, 오늘은 KST, 받을 돈은 #284 전까지 null', async () => {
    const { ports, calls } = setup();
    await ports.step({ continue: { outputs: [] } });
    assert.deepEqual(calls.at(-1), ['rpc', 'chat.step', { continue: { outputs: [] } }]);
    assert.deepEqual(await ports.issued(), [{ counterpartyId: 'cpA', counterparty: 'A상사', date: '2026-10-03', total: 550_000 }]);
    assert.deepEqual(calls.at(-1), ['rpc', 'db.query.runs.history', { limit: AGENT_HISTORY_LIMIT }]);
    assert.equal(ports.today(), '2026-11-12');
    assert.equal(await ports.receivables(), null);
    assert.deepEqual(ports.counterparties(), [{ id: 'cpA', name: 'A상사', item: '컨설팅', bizNo: '1234567890' }]);
  });
});

describe('ShellRuns.discardDraft(draft_discard)', () => {
  class FakeHost extends EventEmitter {
    async control(): Promise<unknown> {
      return {};
    }
    async rpc(): Promise<unknown> {
      return {};
    }
  }
  it('초안만 버린다: 목록에서 빠지고 "취소함" 카드로 한 번 알린다. 버린 뒤에는 고치거나 다시 버릴 수 없다', () => {
    const runs = new ShellRuns(new FakeHost() as never, { counterparties: () => [CP], auth: () => '' });
    const r = runs.createDraft(CP, 1_000_000, null, '컨설팅');
    const seen: RunView[] = [];
    runs.on('update', (x: RunView) => seen.push(x));
    const shown = runs.discardDraft(r.id);
    assert.equal(shown.discarded, true);
    assert.deepEqual(seen.map((x) => [x.id, x.discarded]), [[r.id, true]]);
    assert.equal(runs.get(r.id), undefined);
    assert.deepEqual(runs.list(), []);
    assert.throws(() => runs.discardDraft(r.id), /not_draft/);
    assert.throws(() => runs.updateDraft(r.id, { vat: 'included' }), /not_draft/);
  });
});
