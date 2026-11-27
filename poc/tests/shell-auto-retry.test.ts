import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { interpret, type Counterparty } from '../apps/desktop/src/shell-model.ts';
import { AUTO_RETRY_NOTE, ShellRuns } from '../apps/desktop/src/shell-runs.ts';

const CPS: Counterparty[] = [{ id: 'cp-c', name: 'C테크', bizNo: '4182577343', rep: '최다라', email: 'billing@ctech.example', item: '교육 용역', status: '계속사업자', checkedOn: '', lastIssuedOn: null }];

class FakeHost extends EventEmitter {
  readonly calls: Array<[string, unknown]> = [];
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push([method, params]);
    return {};
  }
}
const tick = () => new Promise((r) => setTimeout(r, 20));

async function started() {
  const host = new FakeHost();
  const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '공동인증서' });
  const d = interpret('C테크에 40만원 세금계산서', null, 'business', runs);
  assert.ok(d.kind === 'draft');
  await runs.prepare(d.run.id);
  return { host, runs, id: d.run.id };
}

describe('승인 전 일시 오류: 같은 내용으로 자동 1회 다시', () => {
  it('화면이 늦어 끝나면 새 실행을 스스로 시작하고, 거기서 또 끝나면 다시 하지 않는다', async () => {
    const { host, runs, id } = await started();
    host.emit('run', { runId: id, type: 'end', status: 'failed', code: 'step.timeout' });
    await tick();
    const again = runs.list().find((r) => r.autoRetryOf === id);
    assert.ok(again, '다시 한 실행이 생긴다');
    assert.equal(again.info, AUTO_RETRY_NOTE);
    assert.equal(again.notices, undefined, '다시 하는 것은 문제가 아니라 주의 면에 넣지 않는다');
    assert.equal(again.total, runs.get(id)!.total);
    assert.equal(host.calls.filter(([m]) => m === 'run.start').length, 2);
    host.emit('run', { runId: again.id, type: 'end', status: 'failed', code: 'step.timeout' });
    await tick();
    assert.equal(runs.list().filter((r) => r.autoRetryOf).length, 1, '두 번째 실패는 다시 하지 않는다');
    assert.equal(runs.get(again.id)!.status, 'attention');
  });

  it('입력값 문제, 사람이 멈춤, 확인 필요는 다시 하지 않는다', async () => {
    for (const e of [
      { status: 'failed', code: 'counterpart.bizno_rejected' },
      { status: 'stopped', code: 'run.stopped' },
      { status: 'in_doubt', code: 'verify.unknown' },
      { status: 'failed', code: 'portal.blocked' },
    ]) {
      const { host, runs, id } = await started();
      host.emit('run', { runId: id, type: 'end', ...e });
      await tick();
      assert.equal(runs.list().some((r) => r.autoRetryOf), false, e.code);
    }
  });
});
