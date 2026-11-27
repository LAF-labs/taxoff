import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadReal, realDryRun, type Outcome } from './h01-real-dryrun.ts';
import { kstToday } from './hometax-fake.ts';

const today = kstToday();
const ym = (n: number) => {
  const t = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};
const M = ym(-1);
const end = (m: string) => `${m}-${String(new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate()).padStart(2, '0')}`;
const show = (o: Outcome) => `end=${JSON.stringify(o.end)} steps=${o.steps.join(' ')} journal=${o.journal.join(',')}`;
/** 조회 말고 다른 요청(발급, 저장)이 나갔는지. 홈택스 조회 요청 actionId는 끝이 R0n이다. */
const writes = (o: Outcome) => o.actions.filter((a) => !/R0\d$/.test(a) && !a.startsWith('perm:'));

const data = {
  cashOut: Array.from({ length: 12 }, (_, i) => ({ trsDtTime: `${M}-${String(i + 1).padStart(2, '0')} 12:00:00`, mrntTxprDscmNoEncCntn: '220-81-62517', mrntTxprNm: `가게${i + 1}`, splCft: '4545', vaTxamt: '455', tip: '0', totaTrsAmt: '5000', aprvNo: `K${String(i + 1).padStart(8, '0')}`, trsClNm: '승인거래', prhTxamtDdcClNm: '공제' })),
  bizCard: [{ aprvDt: `${M}-05`, busnCrdCardNoEncCntn: '9410-1234-5678-4321', mrntTxprDscmNoEncCntn: '107-81-52174', mrntTxprNm: '식당', splCft: '20000', vaTxamt: '2000', tip: '0', totaTrsAmt: '22000', ddcYnNm: '공제', busnCrdcTrsBrkdSn: 'K00000000001' }],
};

describe('월 리포트 홈택스 자동 받기: hometax.report.sync 건조 실행(ADR-068 결정 6, 가짜 홈택스)', () => {
  it('로그인한 뒤 계획의 구간마다 금고가 조회 화면을 읽어 받는 곳에 넘긴다. 승인 카드, 커밋 요청이 없다', async () => {
    const report = { data, plan: [{ kind: 'cash_receipt_out', from: `${M}-01`, to: end(M) }, { kind: 'business_card', from: `${M}-01`, to: end(M) }, { kind: 'purchase_invoice', from: `${M}-01`, to: end(M) }], items: [] as never[] };
    const o = await realDryRun({ loggedIn: true, report, maxMs: 90_000 });
    assert.equal(o.end?.status, 'success', show(o));
    assert.equal(o.gate, false);
    assert.deepEqual(writes(o), []);
    const items = report.items as Array<{ kind: string; rows?: unknown[]; code?: string }>;
    assert.deepEqual(items.map((x) => [x.kind, x.rows?.length ?? x.code]), [['cash_receipt_out', 12], ['business_card', 1], ['purchase_invoice', 0]]);
    assert.ok(!JSON.stringify(items).includes('1234-5678'), '카드번호는 끝 4자리만');
    assert.ok(o.journal.includes('report.synced'), show(o));
  });

  it('한 구간이 실패해도 다음 구간을 받고, 실패한 구간은 코드로 넘긴다(받는 곳이 덮음으로 치지 않는다)', async () => {
    const report = { data, plan: [{ kind: 'cash_receipt_out', from: `${M}-01`, to: end(M) }, { kind: 'business_card', from: `${M}-01`, to: end(M) }], items: [] as never[] };
    const o = await realDryRun({ loggedIn: true, knobs: { reportAlert: { menu: '4605010100', text: '현재 서비스 점검 중입니다.' } }, report, maxMs: 90_000 });
    assert.equal(o.end?.status, 'success', show(o));
    const items = report.items as Array<{ kind: string; rows?: unknown[]; code?: string }>;
    assert.deepEqual(items.map((x) => [x.kind, x.rows?.length ?? x.code]), [['cash_receipt_out', 'report.portal_alert'], ['business_card', 1]]);
  });

  it('report_sync가 있는 패키지에 효과나 승인 스텝이 있으면 로더가 거부한다(V-27)', () => {
    assert.throws(() => loadReal('http://127.0.0.1:9', '127.0.0.1:9', (f) => {
      f.playbook.effects = ['send'];
      f.manifest.effects = ['send'];
    }, 'hometax.report.sync'), /V-27/);
  });
});
