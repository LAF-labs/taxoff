import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { REPORT_PLAYBOOK, ReportSync, type ReportSyncPorts } from '../apps/desktop/src/report-sync.ts';

type RunEv = { type?: string; runId?: string; status?: string; code?: string };

function harness(o: { due?: boolean; status?: string; login?: 'ready' | 'simple_auth' | 'not_ready'; busy?: boolean; beginFails?: string } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const listeners = new Set<(e: RunEv) => void>();
  const logs: Array<Record<string, unknown>> = [];
  const ports: ReportSyncPorts = {
    ready: async () => undefined,
    rpc: async (m, p) => {
      calls.push([m, p]);
      if (m === 'db.query.bank.hometaxPlan') return p.firstUnlock || o.due ? { due: true, steps: [{ kind: 'sale_invoice', from: '2026-11-01', to: '2026-11-24' }] } : { due: false, steps: [] };
      if (m === 'run.startReport') setTimeout(() => listeners.forEach((l) => l({ type: 'end', runId: String(p.runId), status: o.status ?? 'success' })), 0);
      return {};
    },
    control: async (m, p) => {
      calls.push([m, p]);
      if (m === 'run.begin' && o.beginFails) throw new Error(o.beginFails);
      return {};
    },
    onRun: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    profileId: async () => 'p1',
    login: async () => o.login ?? 'ready',
    busy: () => o.busy ?? false,
    log: (_n, d) => logs.push(d ?? {}),
  };
  return { sync: new ReportSync(ports), calls, logs, listeners };
}

describe('월 리포트 자동 받기 예약(PC, ADR-068 결정 6)', () => {
  it('앱을 켜고 처음 풀면 언제나 받는다: 금고 unlock 실행 → 엔진 받기 → 끝나면 금고 실행을 닫는다', async () => {
    const h = harness();
    assert.equal(await h.sync.screenOpened(), 'done');
    assert.deepEqual(h.calls.map(([m]) => m), ['db.query.bank.hometaxPlan', 'run.begin', 'run.startReport', 'run.end']);
    assert.equal(h.calls[0]![1].firstUnlock, true);
    const begin = h.calls[1]![1];
    assert.deepEqual([begin.trigger, begin.playbook], ['unlock', REPORT_PLAYBOOK]);
    const start = h.calls[2]![1];
    assert.equal(start.runId, begin.runId);
    assert.equal(start.trigger, 'unlock');
    assert.equal(h.calls[3]![1].runId, begin.runId);
    assert.equal(h.listeners.size, 0, '듣기를 끊는다');
  });

  it('두 번째 풀기부터는 6시간 규칙(장부가 판단), 받을 때가 아니면 금고 실행을 열지 않는다', async () => {
    const h = harness();
    await h.sync.screenOpened();
    h.calls.length = 0;
    assert.equal(await h.sync.screenOpened(), 'not_due');
    assert.deepEqual(h.calls.map(([m, p]) => [m, p.firstUnlock]), [['db.query.bank.hometaxPlan', false]]);
  });

  it('[최신화]는 사람이 누른 것: 언제나 받고 금고 실행은 local', async () => {
    const h = harness();
    assert.equal(await h.sync.start('human'), 'done');
    assert.equal(h.calls[0]![1].firstUnlock, true);
    assert.deepEqual([h.calls[1]![1].trigger, h.calls[1]![1].playbook], ['local', undefined]);
    assert.equal(h.calls[2]![1].trigger, 'human');
  });

  it('사람 없이 로그인할 수 없거나 다른 실행이 돌면 묻지도 않는다. 한 번에 하나만', async () => {
    assert.equal(await harness({ login: 'not_ready' }).sync.screenOpened(), 'cant_login');
    const busy = harness({ busy: true });
    assert.equal(await busy.sync.screenOpened(), 'busy');
    assert.equal(busy.calls.length, 0);
    const h = harness();
    const a = h.sync.screenOpened();
    assert.equal(await h.sync.start('human'), 'busy');
    assert.equal(await a, 'done');
  });

  it('금고가 풀기 창이 지났다고 거부하거나 실행이 실패하면 failed로 남기고 금고 실행은 닫는다', async () => {
    const late = harness({ beginFails: 'unlock_expired' });
    assert.equal(await late.sync.screenOpened(), 'failed');
    assert.deepEqual(late.calls.map(([m]) => m), ['db.query.bank.hometaxPlan', 'run.begin', 'run.end']);
    assert.equal(late.logs.at(-1)!.code, 'unlock_expired');
    assert.equal(await harness({ status: 'failed' }).sync.screenOpened(), 'failed');
  });
});
