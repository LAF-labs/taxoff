import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { buildGateRequest } from '@sax/engine/gate';
import { eventOf } from '../apps/desktop/src/phone-issue.ts';
import { interpret, type Counterparty } from '../apps/desktop/src/shell-model.ts';
import { ShellRuns } from '../apps/desktop/src/shell-runs.ts';

const CPS: Counterparty[] = [{ id: 'cp-c', name: 'C테크', bizNo: '4182577343', rep: '최다라', email: 'billing@ctech.example', item: '교육 용역', status: '계속사업자', checkedOn: '', lastIssuedOn: null }];
const APPROVAL = '20261123-10000000-12345678';

class FakeHost extends EventEmitter {
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(): Promise<unknown> {
    return {};
  }
}

async function approvedRun() {
  const host = new FakeHost();
  const runs = new ShellRuns(host, { counterparties: () => CPS, auth: () => '공동인증서' });
  const d = interpret('C테크에 40만원 세금계산서', null, 'business', runs);
  assert.ok(d.kind === 'draft');
  await runs.prepare(d.run.id);
  const readback = {
    supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '4182577343', counterpartName: 'C테크', counterpartEmail: 'billing@ctech.example',
    itemName: '교육 용역', itemCount: '1', supplyAmount: '400000', taxAmount: '40000', totalAmount: '440000', issueDate: '2026-11-05', remark: '', receiptType: '영수',
  };
  host.emit('gate', buildGateRequest({ runId: d.run.id, gateStepId: 's20', readback, reserved: [], packageDigest: '0'.repeat(64), authorizes: ['s21'], intentId: 'i-1', waitMs: 1000 }));
  runs.approved(d.run.id);
  host.emit('run', { runId: d.run.id, type: 'phase', phase: 'sign', state: 'now' });
  return { host, runs, id: d.run.id };
}

describe('발급 확정 즉시 완료: PDF·메일 확인을 기다리지 않는다', () => {
  it('issued가 오면 승인번호와 함께 완료가 되고, 엔진이 끝날 때까지 새 실행은 막는다', async () => {
    const { host, runs, id } = await approvedRun();
    assert.equal(runs.get(id)!.status, 'issuing');
    host.emit('run', { runId: id, type: 'issued', approvalNo: APPROVAL });
    const r = runs.get(id)!;
    assert.equal(r.status, 'done');
    assert.equal(r.result?.approvalNo, APPROVAL);
    assert.equal(r.settling, true);
    assert.equal(runs.anyActive(), true, '엔진이 마저 도는 동안은 바쁨');
    assert.deepEqual(r.warnings ?? [], [], '메일 미확인 경고를 미리 띄우지 않는다');
    const ev = eventOf(r, 'p-run', 'cmd', 1);
    assert.equal(ev.event, 'end');
    assert.equal(ev.result?.approvalNo, APPROVAL);
    assert.equal(ev.result!.emailSent, true, '메일은 홈택스가 발급과 함께 보낸다');

    host.emit('run', { runId: id, type: 'end', status: 'success', approvalNo: APPROVAL, mailConfirmed: true });
    const done = runs.get(id)!;
    assert.equal(done.status, 'done');
    assert.equal(done.settling, false);
    assert.equal(done.result?.mailConfirmed, true);
    assert.equal(done.result?.noFile, false);
    assert.equal(runs.anyActive(), false);
  });

  it('확정 뒤 뒷정리가 실패로 끝나도 완료는 그대로다', async () => {
    const { host, runs, id } = await approvedRun();
    host.emit('run', { runId: id, type: 'issued', approvalNo: APPROVAL });
    host.emit('run', { runId: id, type: 'end', status: 'failed', code: 'engine.error' });
    const r = runs.get(id)!;
    assert.equal(r.status, 'done');
    assert.equal(r.result?.approvalNo, APPROVAL);
    assert.equal(runs.anyActive(), false);
  });

  it('issued 없이 끝나면 예전과 같다', async () => {
    const { host, runs, id } = await approvedRun();
    host.emit('run', { runId: id, type: 'end', status: 'success', approvalNo: APPROVAL, mailConfirmed: false });
    const r = runs.get(id)!;
    assert.equal(r.status, 'done');
    assert.equal(r.result?.mailConfirmed, false);
  });
});
