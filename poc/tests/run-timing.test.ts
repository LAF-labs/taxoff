import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RunTiming } from '../packages/engine/src/run-timing.ts';

describe('RunTiming: 실행 시간 분해', () => {
  it('단계 시간, 정책 지연, 사람 대기, 승인·확정 시각을 따로 센다', () => {
    let now = 1_000;
    const t = new RunTiming(() => now);
    t.phase('login', 'now');
    now += 2_000;
    t.phase('form', 'now');
    t.paced(1_200);
    t.paced(900);
    t.paced(0);
    now += 5_000;
    t.phase('gate', 'now');
    t.journal('gate.requested');
    t.human(true);
    now += 7_000;
    t.journal('gate.approved');
    now += 3_000;
    t.journal('ledger.committed');
    t.journal('ledger.committed');
    now += 500;
    const f = t.fields('run-1', { status: 'success', playbook: 'hometax.invoice.issue' });
    assert.deepEqual(f, {
      runId: 'run-1', playbook: 'hometax.invoice.issue', status: 'success', end: '', total_ms: 17_500, human_ms: 7_000, pace_ms: 2_100, pace_n: 2,
      login_ms: 2_000, form_ms: 5_000, gate_ms: 10_500, at_gate_ms: 7_000, at_approved_ms: 14_000, at_committed_ms: 17_000,
    });
  });

  it('사람 차례가 다음 단계로 닫히고, 끝날 때 열려 있던 것도 센다', () => {
    let now = 0;
    const t = new RunTiming(() => now);
    t.phase('login', 'now');
    t.human(true);
    now += 4_000;
    t.phase('login', 'done');
    t.human(true);
    now += 1_000;
    t.step('step.started', 's13a');
    now += 2_100;
    t.step('step.finished', 's13a');
    t.step('step.started', 's18');
    now += 300;
    t.step('step.finished', 's18');
    now -= 2_400;
    const f = t.fields('run-2', { status: 'stopped', code: 'run.stopped', playbook: 'p' });
    assert.equal(f.human_ms, 5_000);
    assert.equal(f.login_ms, 4_000);
    assert.equal(f.end, 'run.stopped');
    assert.equal(f.slow, 's13a:2100_s18:300');
  });
});
