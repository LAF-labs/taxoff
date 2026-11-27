import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apiRung, BizVerifier, VaultBulkPort, VaultReportPort, type ReportSinkItem, type BulkStartRow, connectRunBrowser, DataService, FakeIssueApi, fixturePortal, hometaxAutoRung, hometaxManualRung, IssueLadder, parseIssueKey, RunService, ulid, type GatePortMessage, type IrPackage, type IssueKey, type LadderEvent, type LadderState, type RunEvent } from '@sax/engine';
import { FIXTURE_PORTAL, fixtureOriginGrant, loadPackage, type LoadedPackage, type LoaderContext, type PackageFiles, type PdfPort } from '@sax/engine/core';
import { BUNDLE_ALLOWLIST } from '@sax/model';
import { Ledger, openDatabase, type Db as Database, type LedgerRow } from '@sax/db';
import { Egress } from '@sax/net';
import { FileEventLog } from '@sax/platform';
import { bundleOutcomes, loadPkg, signPackage, testKeys } from './core-fixtures.ts';
import { startHarness } from './harness.ts';
import { kstToday, startHometaxFake, type FakeInvoice, type FakeKnobs, type HometaxFake } from './hometax-fake.ts';
import type { FakeReportData } from './hometax-fake-report.ts';
import { amendStart, type AmendValues } from '@sax/chat-core';

export const AMEND_ORIGINAL: FakeInvoice = {
  etan: '20261117-10000001-00000001', wrtDt: kstToday(), dmnrTxprDscmNo: '214-86-51233', tnmNm: '에이상사', rprsFnm: '이대표', lsatNm: '유지보수',
  totaAmtStr: '3,630,000', sumSplCftStr: '3,300,000', sumTxamtStr: '330,000', dmnrEmail: 'tax@asangsa.example', visibleAt: 0,
};

export const REAL_ORIGIN = 'https://hometax.go.kr';
export const REAL_TEET = 'teet.hometax.go.kr';
export const PACKAGE_IDS = ['hometax.invoice.lookup', 'hometax.invoice.email_status', 'hometax.invoice.issue'] as const;

export function fixtureFiles(files: PackageFiles, origin: string, teetHost: string): PackageFiles {
  const text = JSON.stringify(files)
    .replaceAll(`"${REAL_ORIGIN}`, `"${origin}`)
    .replaceAll(`"host":"${REAL_TEET}"`, `"host":"${teetHost}"`)
    // 월 리포트 조회 화면 요청 호스트(tecr, teht)도 가짜 홈택스는 한 곳에서 받는다
    .replaceAll('"host":"tecr.hometax.go.kr"', `"host":"${teetHost}"`)
    .replaceAll('"host":"teht.hometax.go.kr"', `"host":"${teetHost}"`);
  const out = JSON.parse(text) as PackageFiles;
  out.manifest.domains = ['127.0.0.1'];
  out.manifest.portal = out.playbook.portal = out.selectors.portal = FIXTURE_PORTAL;
  return out;
}

export function loadReal(origin: string, teetHost: string, patchIssue?: (files: PackageFiles) => void, playbookId = 'hometax.invoice.issue'): { pkg: LoadedPackage; lookups: Map<string, LoadedPackage> } {
  const keys = testKeys();
  const two = keys.pkg.slice(0, 2);
  const ctx = (installedLookups: ReadonlyMap<string, LoadedPackage>): LoaderContext => ({
    roots: keys.roots, revoked: new Set(), bundleAllowlist: BUNDLE_ALLOWLIST, bundles: bundleOutcomes(), installedLookups,
    storedVersion: null, installedDigest: null, hold: false, policyFresh: true, now: Date.now(),
  });
  const lookups = new Map<string, LoadedPackage>();
  const wanted = new Set<string>([...PACKAGE_IDS.slice(0, 2), ...loadPkg(playbookId).manifest.lookupsUsed.map((l) => l.id)]);
  for (const id of wanted) {
    const r = loadPackage(signPackage(fixtureFiles(loadPkg(id), origin, teetHost), two), ctx(new Map()));
    if (!r.ok) throw new Error(`조회 패키지 ${id}: ${r.code} ${JSON.stringify(r.violations)}`);
    lookups.set(id, r.pkg);
  }
  const files = fixtureFiles(loadPkg(playbookId), origin, teetHost);
  patchIssue?.(files);
  const r = loadPackage(signPackage(files, two, files.manifest.lookupsUsed.map((l) => lookups.get(l.id)?.manifestDigest ?? '0'.repeat(64))), ctx(lookups));
  if (!r.ok) throw new Error(`발급 패키지: ${r.code} ${JSON.stringify(r.violations)}`);
  return { pkg: r.pkg, lookups };
}

const PDF: PdfPort = {
  print: async () => ({ ok: true, fileId: 'a'.repeat(32) }),
  original: async () => ({ ok: false, reason: 'unused' }),
  armDownload: async () => ({ armed: false, reason: 'n/a' }),
  awaitDownload: async () => ({ ok: false, reason: 'n/a' }),
  disarmDownload: async () => {},
  store: async () => ({ ok: true, documentId: 'doc-1' }),
};

export interface Scenario {
  knobs?: Partial<FakeKnobs>;
  loggedIn?: boolean;
  signMethod?: 'cert' | 'simple_auth';
  bizNo?: string;
  email?: string | null;
  supply?: number;
  human?: (fx: HometaxFake) => void;
  approve?: boolean;
  maxMs?: number;
  verifyMaxMs?: number;
  secret?: IrPackage['secret'];
  patchIssue?: (files: PackageFiles) => void;
  ladder?: LadderScenario;
  page?: (real: () => Promise<import('playwright-core').Page>) => () => Promise<import('playwright-core').Page>;
  handoffCapMs?: number;
  locate?: IrPackage['locate'];
  beforeRun?: (db: Database) => void;
  afterRun?: (db: Database) => void;
  answerTurns?: boolean;
  /** 수정세금계산서(ADR-058): 가짜 홈택스에 당초분을 심고 startAmend로 돈다. */
  amend?: { what: string; values?: Partial<AmendValues>; original?: Partial<FakeInvoice>; prior?: (db: Database, cp: string) => void };
  /** 대량 발급(ADR-059, ADR-063): 홈택스 일괄발급 화면으로 startBulk 한 묶음을 돈다. */
  bulk?: { rows: BulkStartRow[] };
  /** 월 리포트 홈택스 자동 받기(ADR-068 결정 6): 가짜 홈택스 조회 화면 자료와 받기 계획. 받는 곳이 받은 구간은 report.items에 모인다. */
  report?: { data: Partial<FakeReportData>; plan: Array<{ kind: string; from: string; to: string }>; items?: ReportSinkItem[] };
}

export interface LadderScenario {
  manual?: 'issued' | 'cannot';
  api?: FakeIssueApi;
  consent?: 'granted' | 'declined';
  again?: boolean;
}

export interface LadderOutcome {
  issueKey: IssueKey;
  state: LadderState | null;
  seen: string[];
  rows: LedgerRow[];
  again?: LadderState;
  actionsAfterAgain?: number;
}

export interface Outcome {
  end: (RunEvent & { status?: string; code?: string; approvalNo?: string; mailConfirmed?: boolean }) | undefined;
  journal: string[];
  /** 실행이 낸 이벤트 종류(순서대로). 완료 알림(issued)이 끝(end)보다 먼저 나오는지 볼 때 쓴다. */
  eventTypes: string[];
  steps: string[];
  gate: boolean;
  fx: HometaxFake;
  actions: string[];
  ladder?: LadderOutcome;
}

export const defaultHuman = (fx: HometaxFake) => {
  if (fx.state.stage === 'cert' && Date.now() - fx.state.certAt > 1500) fx.cert('confirm');
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function realDryRun(sc: Scenario = {}): Promise<Outcome> {
  const original = sc.amend ? { ...AMEND_ORIGINAL, ...sc.amend.original } : null;
  const fx = await startHometaxFake({ renderDelayMs: 600, ...sc.knobs, loggedIn: sc.loggedIn ?? false, ...(original ? { invoices: [original] } : {}), ...(sc.report ? { report: sc.report.data } : {}) });
  const teetHost = new URL(fx.teetOrigin).host;
  const h = await startHarness();
  const dir = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'sax-real-'));
  const db = openDatabase(path.join(dir, 'db.sqlite'), new Uint8Array(randomBytes(32)));
  const events: RunEvent[] = [];
  const gm: GatePortMessage[] = [];
  const steps: string[] = [];
  try {
    const { pkg, lookups } = loadReal(fx.origin, teetHost, sc.patchIssue, sc.report ? 'hometax.report.sync' : sc.bulk ? 'hometax.invoice.bulk' : sc.amend ? 'hometax.invoice.amend' : 'hometax.invoice.issue');
    let targetId = '';
    const base = fixturePortal(fx.origin);
    const portal = { ...base, verify: { ...base.verify, maxMs: sc.verifyMaxMs ?? 25_000, intervalMs: 300 } };
    const ir: IrPackage = { pkg, lookupPackages: lookups, fixtureGrant: fixtureOriginGrant(pkg), verifyTiming: { minElapsedMs: 600, lookups: 2, maxMs: sc.verifyMaxMs ?? 25_000 }, pdf: PDF, ...(sc.secret ? { secret: sc.secret } : {}), ...(sc.locate ? { locate: sc.locate } : {}), ...(sc.bulk ? { bulk: new VaultBulkPort({ vault: h.client, targetId: () => targetId }) } : {}), ...(sc.report ? { report: new VaultReportPort({ vault: h.client, targetId: () => targetId }) } : {}) };
    sc.beforeRun?.(db);
    const data = new DataService(db, new BizVerifier(new Egress()));
    data.profiles.upsert({ kind: 'business', displayName: '가나다컴퍼니', bizNo: '1234567891', corpNo: null, repName: '김대표', bizType: null, bizItem: null, address: null, email: null, signMethod: sc.signMethod ?? 'cert' } as never);
    const email = sc.email === undefined ? 'tax@asangsa.example' : sc.email;
    const cp = data.counterparties.create({ bizNo: sc.bizNo ?? '2148651233', name: '에이상사', repName: '이대표', address: '부산광역시 가짜구 1', ...(email ? { email } : {}) }).id;
    const rb = await connectRunBrowser(h.client);
    targetId = rb.targetId;
    const realPage = async () => rb.page;
    const runs = new RunService({
      db, data, ledgerKey: new Uint8Array(randomBytes(32)), portal, log: new FileEventLog(null, 'engine'), page: sc.page ? sc.page(realPage) : realPage,
      postGate: (m: GatePortMessage) => gm.push(m), engine: 'ir', irSource: () => ({ ok: true, ir }), ...(sc.amend ? { amendSource: () => ({ ok: true, ir }) } : {}), ...(sc.bulk ? { bulkSource: () => ({ ok: true, ir }) } : {}), ...(sc.report ? { reportSource: () => ({ ok: true, ir }), reportSink: { put: (_r: string, x: ReportSinkItem) => void (sc.report!.items ??= []).push(x) } } : {}), ...(sc.handoffCapMs !== undefined ? { handoffCapMs: sc.handoffCapMs } : {}),
      trace: (_r: string, t: { name: string; stepId: string; code?: string }) => {
        if (t.name === 'step.finished') steps.push(t.code ? `${t.stepId}!${t.code}` : t.stepId);
      },
    } as never);
    runs.on('event', (e: RunEvent) => events.push(e));
    const draft = { counterpartyId: cp, supply: sc.supply ?? 1000, tax: Math.floor((sc.supply ?? 1000) / 10), itemName: '테스트', ...(email === null ? { email: null } : {}) };
    const lc = sc.ladder;
    const issueKey = parseIssueKey(ulid())!;
    const ledger = new Ledger(db);
    const ladder = lc ? new IssueLadder({ rungs: [hometaxAutoRung(runs), hometaxManualRung(runs, db), apiRung(lc.api ? { popbill: lc.api } : {}, { runs, db })], ledger, log: new FileEventLog(null, 'engine') }) : null;
    const seen: string[] = [];
    ladder?.on('state', (e: LadderEvent) => seen.push(e.state.s));
    const settledStates = new Set(['issued', 'held', 'stopped', 'exhausted']);
    const ended = () => (ladder ? (settledStates.has(ladder.state(issueKey)?.s ?? '') ? true : undefined) : events.find((e) => e.type === 'end'));
    if (sc.amend && original) {
      sc.amend.prior?.(db, cp);
      const num = (x: string) => Number(x.replace(/[^0-9-]/g, ''));
      const o = { approvalNo: original.etan, issueDate: original.wrtDt, issuedOn: original.wrtDt, counterpartyId: cp, supply: num(original.sumSplCftStr), tax: num(original.sumTxamtStr), item: original.lsatNm };
      const what = sc.amend.what as Parameters<typeof amendStart>[1];
      const base = amendStart({ ...o, counterpartBizNo: original.dmnrTxprDscmNo.replace(/-/g, ''), counterpartName: original.tnmNm }, what, kstToday());
      runs.startAmend({ runId: 'r1', original: o, what, values: { ...base, ...sc.amend.values } });
    } else if (sc.bulk) runs.startBulk({ runId: 'r1', rows: sc.bulk.rows });
    else if (sc.report) runs.startReport({ runId: 'r1', plan: sc.report.plan });
    else if (ladder) ladder.request({ issueKey, runId: 'r1', ...draft });
    else runs.start({ runId: 'r1', ...draft } as never);
    const t0 = Date.now();
    let approved = false;
    const human = sc.human ?? defaultHuman;
    const answersTurns = sc.human === undefined || sc.answerTurns === true;
    let answered = 0;
    let signIdleAt = 0;
    while (!ended() && Date.now() - t0 < (sc.maxMs ?? 90_000)) {
      human(fx);
      const turns = events.filter((e) => e.type === 'handoff');
      const turn = turns.length > answered ? (turns.at(-1) as Extract<RunEvent, { type: 'handoff' }>) : null;
      if (turn && answersTurns && (turn.phase === 'login' || turn.phase === 'sign')) {
        if (turn.phase === 'sign') {
          const acted = fx.state.stage !== 'cert' || fx.state.certActedAt > 0;
          if (!acted) signIdleAt = 0;
          else if (!signIdleAt) signIdleAt = Date.now();
          else if (Date.now() - signIdleAt > 1500) {
            answered = turns.length;
            signIdleAt = 0;
            runs.resume('r1');
          }
        } else if (!fx.state.loggedIn) fx.login();
        else {
          answered = turns.length;
          runs.resume('r1');
        }
      }
      const g = gm.find((m) => m.t === 'gate.request');
      if (g && !approved && sc.approve !== false && g.t === 'gate.request') {
        approved = true;
        const q = g.req;
        runs.answer({ v: 2, runId: q.runId, gateStepId: q.gateStepId, reqId: q.reqId, approvalNonce: q.approvalNonce, actionHash: q.actionHash, exp: Date.now() + 120_000, presence: 'click', mac: 'not-verified-in-phase1' });
      }
      const ls = ladder?.state(issueKey);
      if (ls?.s === 'human' && lc?.manual) ladder!.human(issueKey, lc.manual);
      if (ls?.s === 'consent' && lc?.consent) ladder!.consent(issueKey, lc.consent);
      await sleep(100);
    }
    const journal = runs.inspect('r1').journal;
    let lo: LadderOutcome | undefined;
    if (ladder) {
      lo = { issueKey, state: ladder.state(issueKey), seen, rows: ledger.byIssueKey(issueKey) };
      if (lc?.again) {
        lo.again = ladder.request({ issueKey, ...draft });
        await sleep(1500);
        lo.actionsAfterAgain = fx.requests().length;
      }
    }
    try {
      runs.stop('r1');
    } catch {
      /* 끝남 */
    }
    await rb.browser.close().catch(() => {});
    sc.afterRun?.(db);
    return { end: events.find((e) => e.type === 'end') as Outcome['end'], journal, eventTypes: events.map((e) => e.type), steps, ...(lo ? { ladder: lo } : {}), gate: gm.some((m) => m.t === 'gate.request'), fx, actions: fx.requests().map((r) => r.actionId ?? `perm:${r.screenId}`) };
  } finally {
    db.close();
    await h.close();
    await fx.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}
