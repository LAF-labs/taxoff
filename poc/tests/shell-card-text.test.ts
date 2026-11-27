// 카드 글자에 null, undefined, NaN이 새지 않는지 본다(대표 지적 11-26: 발급을 중지하면 카드에 "null"이 보였다).
// 실제 셸 렌더러(static/shell/shell-views.js)를 작은 가짜 DOM에서 그린다. 발급 카드가 지나는 상태(작성, 준비, 승인 대기, 내 차례,
// 중지, 실패, 확인 필요, 완료)를 ShellRuns로 실제로 만들고, 그 상태마다 값 하나씩을 null이나 undefined로 비워 다시 그린다.
// 비운 값은 그 줄이나 조각이 빠져야 한다(shell-views.js shown, joinShown, kvPair, kv).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { buildGateRequest } from '@sax/engine/gate';
import { interpret, type Counterparty } from '../apps/desktop/src/shell-mock.ts';
import { NOTE, ShellRuns } from '../apps/desktop/src/shell-runs.ts';

class FakeNode {}
class FakeText extends FakeNode {
  text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  get textContent(): string {
    return this.text;
  }
  set textContent(v: string) {
    this.text = v;
  }
}
class FakeEl extends FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  hidden = false;
  private cls = new Set<string>();
  classList = {
    add: (...c: string[]) => c.forEach((x) => this.cls.add(x)),
    remove: (...c: string[]) => c.forEach((x) => this.cls.delete(x)),
    contains: (c: string) => this.cls.has(c),
    toggle: (c: string, on?: boolean) => ((on ?? !this.cls.has(c)) ? this.cls.add(c) : this.cls.delete(c)),
  };
  tagName: string;
  constructor(tagName: string) {
    super();
    this.tagName = tagName;
  }
  set className(v: string) {
    this.cls = new Set(String(v).split(/\s+/).filter(Boolean));
  }
  get className(): string {
    return [...this.cls].join(' ');
  }
  setAttribute(k: string, v: unknown): void {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string): string | null {
    return this.attrs[k] ?? null;
  }
  removeAttribute(k: string): void {
    delete this.attrs[k];
  }
  addEventListener(): void {}
  append(...kids: unknown[]): void {
    for (const c of kids) this.children.push(c instanceof FakeNode ? c : new FakeText(String(c)));
  }
  replaceChildren(...kids: unknown[]): void {
    this.children = [];
    this.append(...kids);
  }
  get lastElementChild(): FakeEl | null {
    return ([...this.children].reverse().find((c) => c instanceof FakeEl) as FakeEl | undefined) ?? null;
  }
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  querySelector(): null {
    return null;
  }
  get textContent(): string {
    return this.children.map((c) => (c as FakeText | FakeEl).textContent).join('');
  }
  set textContent(v: string) {
    this.children = [new FakeText(String(v))];
  }
}
Object.assign(globalThis, { Node: FakeNode, document: { createElement: (t: string) => new FakeEl(t), createElementNS: (_: string, t: string) => new FakeEl(t), createTextNode: (t: string) => new FakeText(t) } });
const V = await import('../apps/desktop/static/shell/shell-views.js');

/** 화면에 보이거나 읽어 주는 글: 글자 마디와 aria-label, title. */
function shownText(n: FakeNode, out: string[] = []): string[] {
  if (n instanceof FakeText) out.push(n.text);
  else if (n instanceof FakeEl) {
    for (const k of ['aria-label', 'title', 'placeholder']) if (n.attrs[k] !== undefined) out.push(n.attrs[k]!);
    for (const c of n.children) shownText(c, out);
  }
  return out;
}
const LEAK = /\b(null|undefined|NaN)\b|\[object /;

const CPS: Counterparty[] = [{ id: 'cp-c', name: 'C테크', bizNo: '4182577343', rep: '최다라', email: 'billing@ctech.example', item: '교육 용역', status: '계속사업자', checkedOn: '', lastIssuedOn: null }];
const READBACK = {
  supplierBizNo: '1234567891', supplierName: '가나다컴퍼니', counterpartBizNo: '4182577343', counterpartName: 'C테크', counterpartEmail: 'billing@ctech.example',
  itemName: '교육 용역', itemCount: '1', supplyAmount: '400000', taxAmount: '40000', totalAmount: '440000', issueDate: '2026-11-05', remark: '', receiptType: '영수',
};
class FakeHost extends EventEmitter {
  async control(): Promise<unknown> {
    return {};
  }
  async rpc(): Promise<unknown> {
    return {};
  }
}
const tick = () => new Promise((r) => setTimeout(r, 20));
const act = new Proxy({ stepsOpen: new Set<string>(), supplier: () => '가나다컴퍼니' } as Record<string, unknown>, { get: (t, k: string) => (k in t ? t[k] : () => {}) });

async function started() {
  const host = new FakeHost();
  const runs = new ShellRuns(host as never, { counterparties: () => CPS, auth: () => '공동인증서' });
  const d = interpret('C테크에 40만원 세금계산서', null, 'business', runs);
  assert.ok(d.kind === 'draft');
  return { host, runs, id: d.run.id };
}
const gate = (host: FakeHost, id: string) => host.emit('gate', buildGateRequest({ runId: id, gateStepId: 's20', readback: READBACK, reserved: [], packageDigest: '0'.repeat(64), authorizes: ['s21'], intentId: 'i-1', waitMs: 1000 }));

/** 실제 흐름으로 만든 발급 카드 상태들. */
async function samples(): Promise<unknown[]> {
  const out: unknown[] = [];
  const keep = (r: unknown) => out.push(structuredClone(r));
  {
    const { runs, id } = await started();
    keep(runs.get(id));
    await runs.stop(id);
    keep(runs.get(id));
  }
  const ends = [{ status: 'stopped', code: 'gate.stopped' }, { status: 'stopped', code: 'run.stopped' }, { status: 'stopped' }, { status: 'failed', code: 'step.timeout' }, { status: 'handoff', code: 'run.handoff_timeout' }, { status: 'in_doubt', code: 'verify.unknown' }, { status: 'success', approvalNo: '20261126-41000000-12345678' }];
  for (const path of ['preparing', 'gate', 'approved', 'login', 'sign'] as const)
    for (const end of ends) {
      const { host, runs, id } = await started();
      await runs.prepare(id);
      if (path !== 'preparing' && path !== 'login' && path !== 'sign') gate(host, id);
      if (path === 'approved') runs.approved(id);
      if (path === 'login') host.emit('run', { runId: id, type: 'handoff', phase: 'login', code: 'login.simple_auth' });
      if (path === 'sign') host.emit('run', { runId: id, type: 'handoff', phase: 'sign' });
      await tick();
      keep(runs.get(id));
      await runs.stop(id).catch(() => {});
      host.emit('run', { runId: id, type: 'end', ...end });
      await tick();
      for (const r of runs.list()) keep(r);
    }
  for (const code of Object.keys(NOTE)) {
    const { host, runs, id } = await started();
    await runs.prepare(id);
    host.emit('run', { runId: id, type: 'end', status: 'stopped', code });
    await tick();
    keep(runs.get(id));
  }
  return out;
}

function leaks(label: string, run: unknown): string[] {
  const out: string[] = [];
  for (const [name, view] of [['카드', V.taskCard], ['패널', V.runPanel]] as const) {
    const text = shownText(view(run, act) as FakeNode).filter((t) => LEAK.test(t));
    if (text.length) out.push(`${label} ${name}: ${text.join(' | ')}`);
  }
  return out;
}

const EMPTIABLE = ['counterparty.name', 'counterparty.bizNo', 'email.value', 'item', 'writeDate', 'total', 'supply', 'tax', 'createdAt', 'auth', 'stoppedNote', 'info', 'turn.text', 'turn.note', 'result.approvalNo', 'result.mailTo', 'result.doneAt'];
function emptied(run: unknown, path: string, v: null | undefined): unknown | null {
  const r = structuredClone(run) as Record<string, unknown>;
  const ks = path.split('.');
  let x = r;
  for (const k of ks.slice(0, -1)) {
    if (!x[k] || typeof x[k] !== 'object') return null;
    x = x[k] as Record<string, unknown>;
  }
  if (!(ks.at(-1)! in x)) return null;
  x[ks.at(-1)!] = v;
  return r;
}

describe('발급 카드 글자에 빈 값이 새지 않는다', () => {
  it('작성부터 중지, 실패, 완료까지 실제 흐름의 카드와 패널', async () => {
    const all = await samples();
    assert.ok(all.length > 40);
    const found = all.flatMap((r, i) => leaks(`#${i} ${(r as { status: string }).status}`, r));
    assert.deepEqual(found, []);
  });

  it('값 하나가 비어 들어와도 그 줄이나 조각만 빠진다(이름, 금액, 날짜, 시각, 안내)', async () => {
    const all = await samples();
    const found: string[] = [];
    for (const s of all)
      for (const p of EMPTIABLE)
        for (const v of [null, undefined]) {
          const r = emptied(s, p, v);
          if (r) found.push(...leaks(`${(s as { status: string }).status} ${p}=${v}`, r));
        }
    assert.deepEqual([...new Set(found)], []);
  });

  it('공용 처리: 빈 값은 그리지 않는다', () => {
    assert.equal(V.shown(null), null);
    assert.equal(V.shown(undefined), null);
    assert.equal(V.shown(' '), null);
    assert.equal(V.shown(Number.NaN), null);
    assert.equal(V.shown(false), null);
    assert.equal(V.shown(0), 0);
    assert.equal(V.won(null), '');
    assert.equal(V.won(undefined), '');
    assert.equal(V.won(440000), '440,000원');
    assert.equal(V.joinShown('홈택스에서 다시 읽음', null, undefined, ''), '홈택스에서 다시 읽음');
    assert.equal(V.kvPair('작성일', null), null);
    assert.equal(V.writeDateText(null), null);
    const dl = V.kv([['품목', null], ['공급가', '400,000원']]) as FakeNode;
    assert.deepEqual(shownText(dl), ['공급가', '400,000원']);
    assert.equal(V.runTitle({ cert: null, amend: null, counterparty: { name: null } }), '세금계산서');
  });
});
