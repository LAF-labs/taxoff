import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { Counterparty as DbCounterparty, PortalProfileKey, Profile as DbProfile } from '@sax/db';
import type { Vat } from '@sax/chat-core';
import type { EnginePortal } from '@sax/engine/protocol';
import type { Channel, Revocation, TrustRoot } from '@sax/updater';
import type { Egress } from '@sax/net';
import { CAP, makeShareKeyBody, shareEpoch, wsRelayClient, type DesktopKeys, type DesktopPairResult, type MoveResult, type PaperInvoice, type RelayClient } from '@sax/remote';
import { PcMoveHost, type PcMoveBundle } from './pc-move.ts';
import { appPaths, defaultAppRoot, FileEventLog } from '@sax/platform';
import { findInstalledChrome, pageAddress, SESSION_IDLE_REPORT_MS } from '@sax/vault';
import { execFile } from 'node:child_process';
import { app, autoUpdater as nativeUpdater, BrowserWindow, clipboard, dialog, ipcMain, Menu, Notification, powerMonitor, powerSaveBlocker, protocol, safeStorage, session, ShareMenu, shell as desktop } from 'electron';
import { deviceModel } from './device-model.ts';
import { runVersion } from './run-version.ts';
import { AccountantPack, isPackMonth, packAsk } from './accountant-pack.ts';
import { prepareExistingExports } from './private-exports.ts';
import { ACTION_TEXT, actionText, issueLocalApproval, kstToday, verifyLocalApproval, verifyLocalAttestation, type LocalApproval } from './approval-gate.ts';
import { CERT_DOCS_SHOWN, certInputsFor, type CertDocDef } from './cert-docs.ts';
import { buildBoard, type Board, type IssuedInvoice } from './board.ts';
import { BankHost, bankShellHandlers, type PickKind } from './bank-host.ts';
import { bulkTemplate, TEMPLATE_NAME } from './bulk-template.ts';
import { bulkRoute, issueRowsFrom, mappingFrom, readBulkFile, readBulkText, statusMap, statusTargets, type BizStatusCode, type BulkRead, type IssueRow } from './bulk-issue.ts';
import { CONSENT_CONFIG, OnboardingFlow, onboardingTodos, type BizFields } from './onboarding.ts';
import { EngineOnboardingStore, onboardingPorts, type OnboardingExternal } from './onboarding-store.ts';
import { listNpkiCerts } from './npki-certs.ts';
import { openBillingCheckout, openExternalKey } from './external-links.ts';
import { CLOUD_ORIGIN } from '@sax/net';
import { securityBlocks, securityStatus, startSecurityProgram, type SecurityStatus } from './security-programs.ts';
import { APPROVAL_SCHEME, ApprovalBar } from './approval-bar.ts';
import { startDaemonHost, type DaemonHost, type ShowNotification } from './daemon-host.ts';
import { startUpdateHost, updatePolicy, type UpdateHost } from './update-host.ts';
import type { AppUpdaterLike, ProviderBase } from './update-electron.ts';
import { certInfoInSandbox, DOCPARSE_SCHEME, ocrImageInSandbox, parsePdfInSandbox, readSheetInSandbox } from './docparse.ts';
import { EngineHost } from './engine-host.ts';
import type { FixtureMode } from './fixture-mode.ts';
import { GestureClock, isGestureKey, isTypingKey, RateWindow } from './gesture.ts';
import { appHeaders, assertNoDebugSwitches, hardenApp, hardenSession, hardenWindow, SECRET_CSP } from './harden.ts';
import { dispatchShell, IPC, type ShellEvent, type ShellHandlers } from './ipc.ts';
import { SECRET_LABELS, SecretWindowCoordinator, type SecretInputBind as OneShotInputBind } from './secret-labels.ts';
import { openVaultInputWindow } from './secret-window.ts';
import { bankAutoHandlers, CODEF_WINDOW_TITLE, codefPageHtml, parseCodefNeeded, type CodefNeeded } from './bank-auto.ts';
import { barBounds, browserPanelWidth, SHELL, WINDOW_MIN } from './shell-layout.ts';
import { EmbeddedBrowser, keepDrawingWhenHidden } from './embedded-browser.ts';
import { engineIntentResolver, INTENT_UNAVAILABLE_TEXT, MODEL_CONSENT_FIRST_TEXT, routed, type IntentResolver } from './intent-route.ts';
import { CHAT_ERROR_TEXT, engineChatResponder, suggestChips, type ChatResponder } from './chat-reply.ts';
import { answersPending, parseAmount, emptyDocStore, NO_AUTH, SETUP_LABEL, setupMissing, setupText, type SetupItem, SIGN_LABEL, interpret, parseRegex, QUICK, REMINDER_DAY_DEFAULT, sentFromGateway, type Counterparty, type DocStore, type G24Doc, type Parsed, type Profile, type RunView, type SentTo, EMPTY_REQUEST_TEXT } from './shell-model.ts';
import { engineDocsProvider, type DocsProvider } from './shell-docs.ts';
import { AMEND_PLAYBOOK, readPastRuns, type PastRun } from './run-history.ts';
import { pendingWork, RunResumeStore } from './run-resume.ts';
import { BATCH_AUTO_NOTE, BATCH_CHANGED_NOTE, fatalText, REHEARSAL, ShellRuns, vaultNotice, QUEUED_NOTE, REPLACED_NOTE, REPLACING_NOTE, SAME_NOTE } from './shell-runs.ts';
import { AgentChat, type AgentPhase } from './agent-chat.ts';
import { agentPorts } from './agent-wiring.ts';
import type { DocPhoneRow, ReportResult, StepParams, StepResult } from '@sax/engine';
import { bundleCss, tokensCss } from './shell-tokens.ts';
import { cancelPick, importPdf, pickFileBytes } from './vault-import.ts';
import { readBizCert, type BizCertReadPorts } from './bizcert-read.ts';
import { CounterpartyBook } from './counterparty-book.ts';
import { nameMissing, ProfileEditLog, ProfileEditor } from './profile-edit.ts';
import { DesktopAccount, PendingCodeFile, RemoteIdentityFile, type AccountView } from './remote-account.ts';
import { GatewayAuthHost } from './gateway-auth.ts';
import { IssueLockHost } from './issue-lock-host.ts';
import type { AccountClient, BillingView, CloudPorts, DeviceAuth, PcLinkVault, VaultKeysFactory } from './remote-ports.ts';
import { PairingHost, type PairView } from './remote-pairing.ts';
import { buildPhoneCopy } from './phone-copy.ts';
import { ApprovalLog, PhoneGate } from './phone-gate.ts';
import { PhoneWaker } from './phone-wake.ts';
import { CmdLog, PhoneIssue } from './phone-issue.ts';
import { DESKTOP_CAPS, PhoneLink, PhoneStore, type PhoneSessionHook, type PhoneView, type TokenSeal } from './phone-link.ts';
import { APPROVE_CAPS, phoneSession, SESSION_CAPS } from './phone-session.ts';
import { DocPush } from './doc-push.ts';
import { LockHost, lockEmailOffFile, type UnlockCloud } from './lock-host.ts';
import { ReportSync } from './report-sync.ts';
import { DeviceManager, type DeviceView } from './remote-devices.ts';
import { engineShareStore, ShareSync } from './share-sync.ts';
import { PcLinkHost } from './remote-pclink.ts';
import { phoneReceiver } from './phone-receive.ts';
import { closeAction, shouldStartPhones, shouldStayAwake, StayAwake } from './phone-presence.ts';
import type { VaultDesktopKeys } from './remote-keys.ts';
import { qrSvgDataUrl } from './remote-qr.ts';
import { formFromRun, type InvoiceForm } from './invoice-form.ts';
import { InvoiceFiles, invoicePdf, mailInvoice, type InvoiceMailResult } from './invoice-pdf.ts';
import { htmlToPdf } from './pdf-render.ts';
import { reportDoc, reportFileName, reportPdfHtml, saveReportPdf } from './report-pdf.ts';

const STATIC = path.join(import.meta.dirname, '../static');
const SHELL_SCHEME = 'sax-shell';
const NO_BUSINESS: Profile = { kind: 'business', name: '내 사업장', email: '', auth: '' };

const NO_PERSONAL: Profile = { kind: 'personal', name: '개인', email: '', auth: '', placeholder: true };
const SHELL_URL = `${SHELL_SCHEME}://shell/shell.html`;

export function registerShellSchemes(): void {
  hardenApp(app, [`${SHELL_SCHEME}:`, `${APPROVAL_SCHEME}:`, `${DOCPARSE_SCHEME}:`]);
  keepDrawingWhenHidden(app);
  protocol.registerSchemesAsPrivileged([
    { scheme: SHELL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: APPROVAL_SCHEME, privileges: { standard: true, secure: true } },
    { scheme: DOCPARSE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

const DOC_CODES = new Set([
  'bad_request', 'busy', 'profile_required', 'not_pdf', 'input_size', 'read_failed', 'invalid_pdf', 'timeout', 'memory_limit', 'session_failed', 'renderer_gone',
  'pick_expired', 'password_too_long', 'schema', 'issued_in_future', 'expires_before_issued', 'expires_after_legal_max', 'invalid_issued_on', 'invalid_expires_on',
  'not_found', 'invalid_doc_type', 'file_missing', 'open_failed', 'seen_required', 'stale',
  'worker_failed', 'parse_failed', 'render_failed', 'ocr_failed', 'bad_extract',
  'gesture_required', 'throttled', 'pick_password_tries',
]);

function docsError(e: unknown): Error {
  const code = (e as { code?: unknown }).code ?? (e as Error).message;
  if (typeof code === 'string' && DOC_CODES.has(code)) return new Error(code);
  console.error('docs failed', typeof code === 'string' ? code.split(':')[0] : (e as Error).name);
  return new Error('failed');
}

const FILES: Record<string, string> = {
  '/shell.html': 'text/html; charset=utf-8',
  '/shell.css': 'text/css',
  '/shell.js': 'text/javascript',
  '/shell-views.js': 'text/javascript',
  '/fields.js': 'text/javascript',
  '/shell-g24.js': 'text/javascript',
  '/shell-onboarding.js': 'text/javascript',
  '/shell-account.js': 'text/javascript',
  '/shell-biz.js': 'text/javascript',
  '/shell-bank.js': 'text/javascript',
  '/shell-billing.js': 'text/javascript',
  '/shell-devices.js': 'text/javascript',
  '/shell-pack.js': 'text/javascript',
  '/shell-report.js': 'text/javascript',
  '/shell-pair.js': 'text/javascript',
  '/secret.css': 'text/css',
  '/codef-secret.js': 'text/javascript',
  '/recovery.js': 'text/javascript',
  '/recovery.css': 'text/css',
  '/shell-lock.js': 'text/javascript',
  '/shell-bank-auto.js': 'text/javascript',
  '/shell-bulk.js': 'text/javascript',
  '/bulk-model.js': 'text/javascript',
  '/shell-ui.js': 'text/javascript',
};

let codefPage: () => string | null = () => null;

/** 맥 보안칩 도우미(packages/vault/native/mac). 앱 묶음(touchid.app)이라 Touch ID 창에 택스오프 이름과 아이콘이 뜬다. 패키지된 앱은 Resources 안, 개발 실행은 build.sh로 만든 것. 없으면 Touch ID를 쓰지 않는다. */
function touchIdHelper(packaged: boolean): string | null {
  if (process.platform !== 'darwin') return null;
  const bundle = packaged ? path.join(process.resourcesPath, 'touchid.app') : path.join(import.meta.dirname, '../../../packages/vault/native/mac/build/touchid.app');
  const p = path.join(bundle, 'Contents/MacOS/touchid');
  return fsSync.existsSync(p) ? p : null;
}

function serve(): void {
  protocol.handle(SHELL_SCHEME, async (req) => {
    const p = new URL(req.url).pathname;
    if (p === '/tokens.css') return new Response(tokensCss(), { headers: appHeaders('text/css') });
    if (p === '/codef-secret.html') {
      const html = codefPage();
      return html ? new Response(html, { headers: appHeaders('text/html; charset=utf-8', SECRET_CSP) }) : new Response('', { status: 404 });
    }
    if (p === '/recovery-show.html' || p === '/recovery-enter.html') return new Response(await fs.readFile(path.join(STATIC, 'shell', p.slice(1))), { headers: appHeaders('text/html; charset=utf-8', SECRET_CSP) });
    if (p === '/bundle.css') return new Response(bundleCss(), { headers: appHeaders('text/css') });
    const type = FILES[p];
    if (!type) return new Response('', { status: 404 });
    return new Response(await fs.readFile(path.join(STATIC, 'shell', p.slice(1))), { headers: appHeaders(type) });
  });
  session.defaultSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${SHELL_SCHEME}://`) && !d.url.startsWith('devtools://') }));
  hardenSession(session.defaultSession);
}

export interface ShellOptions {
  daemon?: boolean;
  /** 여러 건 발급 양식을 저장할 폴더(시험용). 주면 폴더를 열지 않는다. */
  downloadsDir?: string;
  width?: number;
  height?: number;
  show?: boolean;
  engine?: { root?: string; portal: EnginePortal };
  headful?: boolean;
  docs?: DocsProvider;
  preparePerMin?: number;
  chromeReady?: () => boolean;
  externalChrome?: boolean;
  billingOpen?: (url: string, accountOrigin: string) => Promise<void>;
  security?: { status(): SecurityStatus; install?(key: string): Promise<void>; start?(): boolean };
  dev?: ShellDev;
  buildBadges?: string[];
  onboarding?: boolean;
  update?: UpdateWiring;
  remote?: RemoteWiring;
  bankPick?: (kind: PickKind) => Promise<Uint8Array | null>;
  intent?: IntentResolver;
  chat?: ChatResponder;
  agent?: {
    step(p: StepParams): Promise<StepResult>;
    route?(p: Record<string, unknown>): Promise<unknown>;
    history?(p: Record<string, unknown>): Promise<unknown>;
  };
}

const CHAT_REACTIONS_ON = true;

export interface RemoteWiring {
  cloud: CloudPorts | null;
  keys: VaultKeysFactory | null;
  deviceName?: string;
  relayClient?: RelayClient;
  pairing?: boolean;
}

export interface UpdateWiring {
  channel: Channel;
  origin: string;
  egress: Pick<Egress, 'getRegistry' | 'getRegistryBytes'>;
  trust?: TrustRoot;
  loopback?: boolean;
  relaunch?: boolean;
  testBuild: boolean;
  setting?: { requireTransparency?: unknown } | null;
  updater?: AppUpdaterLike;
}

/** 시험용 가짜 홈택스(ADR-039)로 띄울 때 넘기는 연결. 화면에 보일 견본 데이터는 두지 않는다. */
export interface ShellDev {
  startFixture(opts: { headful?: boolean }): Promise<FixtureMode>;
  onboarding(): OnboardingExternal;
  cpCert: BizFields;
}

export interface Shell {
  win: BrowserWindow;
  bar: ApprovalBar;
  runs: ShellRuns;
  store: DocStore;
  host: EngineHost;
  fixture: FixtureMode | null;
  ready: Promise<void>;
  methods: string[];
  secretAsk(): { reqId: string; kind: string; runId: string } | null;
  close(): Promise<void>;
}


const SHELL_BIZ_KEY: Record<PortalProfileKey, NonNullable<Profile['fromHometax']>[number]> = { displayName: 'name', repName: 'rep', bizType: 'bizType', bizItem: 'bizItem', address: 'address', email: 'email' };

function profileView(p: DbProfile): Profile {
  const unnamed = p.kind === 'business' && nameMissing(p);
  const fromHometax = p.fromPortal.map((k) => SHELL_BIZ_KEY[k]);
  return { kind: p.kind, name: unnamed ? NO_BUSINESS.name : p.displayName, ...(unnamed ? { nameMissing: true } : {}), ...(fromHometax.length ? { fromHometax } : {}), bizNo: p.bizNo ?? undefined, rep: p.repName ?? undefined, bizType: p.bizType ?? undefined, bizItem: p.bizItem ?? undefined, address: p.address ?? undefined, email: p.email ?? '', auth: p.signMethod ? SIGN_LABEL[p.signMethod] : NO_AUTH };
}

function counterpartyView(c: DbCounterparty, items: Record<string, string>, saved?: string): Counterparty {
  return {
    id: c.id,
    name: c.name,
    bizNo: c.bizNo,
    rep: c.repName ?? '',
    email: c.email ?? '',
    item: saved || (items[c.bizNo] ?? ''),
    status: c.verifiedStatus ?? '확인 전',
    checkedOn: c.verifiedAt?.slice(0, 10) ?? '',
    lastIssuedOn: c.lastUsedAt?.slice(0, 10) ?? null,
    ...(c.phoneAddedAt ? { phoneAdded: true } : {}),
  };
}

export async function startShell(opts: ShellOptions = {}): Promise<Shell> {
  assertNoDebugSwitches(app);
  serve();
  const key = new Uint8Array(randomBytes(32));
  const store: DocStore = emptyDocStore();
  if (!opts.engine && !opts.dev) throw new Error('shell.no_portal');
  const fixture = opts.engine ? null : await opts.dev!.startFixture({ headful: opts.headful });
  const made: { host?: EngineHost } = {};
  try {
    return await wireShell(opts, fixture, key, store, made);
  } catch (e) {
    await made.host?.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
    throw e;
  }
}

const LINK_POLL_MS = 4_000;
const WARM_WAIT_NOTE = '홈택스에 로그인하고 있어요';
const REVERIFY_WAIT_NOTE = '지난 발급을 홈택스에서 확인하고 있어요';

async function wireShell(opts: ShellOptions, fixture: FixtureMode | null, key: Uint8Array, store: DocStore, made: { host?: EngineHost }): Promise<Shell> {
  const dev = fixture ? opts.dev! : null;
  const root = fixture?.root ?? opts.engine?.root;
  const paths = appPaths(root ?? defaultAppRoot());
  const ownPdfDir = path.join(paths.userData, 'issued-pdf');
  const packDir = path.join(paths.userData, '세무사 꾸러미');
  const log = new FileEventLog(paths.logs, 'main');
  const exportCleanupFailed = (entry: string, error: NodeJS.ErrnoException) =>
    log.diag('main.export_cleanup_failed', { error: error.code }, { path: path.relative(paths.userData, entry) });
  await Promise.all([prepareExistingExports(ownPdfDir, exportCleanupFailed), prepareExistingExports(packDir, exportCleanupFailed)]);
  const embedded = opts.externalChrome !== true;
  const touchId = touchIdHelper(app.isPackaged);
  const host = new EngineHost({ vault: fixture ? fixture.vault : 'process', root, portal: fixture?.portal ?? opts.engine!.portal, log, appVersion: runVersion(app.isPackaged, process.env, () => app.getVersion()), embeddedBrowser: embedded, vaultArgs: touchId ? [`--touchid=${touchId}`] : [] });
  made.host = host;
  let business: Profile | null = null;
  let businessId: string | null = null;
  let cps: Counterparty[] = [];
  const refresh = async () => {
    const ps = (await host.rpc('db.query.profiles.list')) as DbProfile[];
    const b = ps.find((p) => p.kind === 'business');
    business = b ? profileView(b) : null;
    businessId = b?.id ?? null;
    const lastDoc = (name: string) => store.docs.filter((d) => d.kind === '세금계산서' && d.name.replace(/^세금계산서 (?:\u00b7 )?/, '') === name).reduce<string | null>((m, d) => (d.issuedOn && (!m || d.issuedOn > m) ? d.issuedOn : m), null);
    const rows = (await host.rpc('db.query.counterparties.list')) as DbCounterparty[];
    const firsts = await Promise.all(rows.map((c) => host.rpc('counterparty.getItems', { id: c.id }).then((r) => (Array.isArray(r) ? (r[0] as { name?: string } | undefined)?.name : undefined), () => undefined)));
    cps = rows.map((c, i) => counterpartyView(c, fixture?.itemHints ?? {}, firsts[i])).map((c) => ({ ...c, lastIssuedOn: c.lastIssuedOn ?? lastDoc(c.name) }));
    runs.syncAuth();
  };
  const bank = new BankHost({
    rpc: (m, p) => host.rpc(m, p ?? {}),
    profileId: async () => ((await host.rpc('db.query.profiles.list')) as DbProfile[]).find((p) => p.kind === 'business')?.id ?? null,
    pick: (kind) =>
      opts.bankPick
        ? opts.bankPick(kind)
        : pickFileBytes([{ name: kind === 'statement' ? '은행 거래내역(엑셀/CSV)' : '홈택스 발급 목록(엑셀)', extensions: ['xlsx', 'xls', 'csv', 'htm', 'html'] }], win),
    readSheet: async (bytes) => {
      const r = await readSheetInSandbox(bytes);
      return { format: r.format, encoding: r.encoding, sheets: r.sheets, flags: r.flags };
    },
    log: (n, d) => log.event(n, d),
  });
  /** 이번에 켠 뒤 마지막으로 저장한 리포트 PDF. 화면은 경로를 받지 않고 [열기] [폴더에서 보기]만 부른다 */
  let reportSaved: string | null = null;
  const profiles = () => ({ business: business ?? NO_BUSINESS, personal: NO_PERSONAL });
  const chromeReady = opts.chromeReady ?? (() => embedded || findInstalledChrome() !== null);
  const securityNow = opts.security ? () => opts.security!.status() : () => securityStatus();
  const securityMissing = () => profile === 'business' && profiles().business.auth === SIGN_LABEL.cert && securityBlocks(securityNow());
  const runs = new ShellRuns(host, { counterparties: () => cps, auth: () => profiles().business.auth, chromeReady, log: (n, d) => log.event(n, d), prepare: (id: string): Promise<unknown> => prepareNow(id) });
  let profile: Profile['kind'] = 'business';
  const docs = opts.docs ?? engineDocsProvider((m, p) => host.rpc(m, p), (params, engine) => importPdf(params, engine, win));
  const listDocs = async () => {
    try {
      const vault = await docs.list();
      for (const d of vault) if (d.runId) docRun.set(d.id, d.runId);
      const mem = new Map(store.docs.map((d) => [d.id, d]));
      const named = vault.map((d) => {
        const m = d.runId ? mem.get(`d-${d.runId}`) : undefined;
        return m ? { ...d, name: m.name, purpose: m.purpose, issuedAt: d.issuedAt ?? m.issuedAt } : d;
      });
      const runs = new Set(vault.flatMap((d) => (d.runId ? [`d-${d.runId}`] : [])));
      return [...named, ...store.docs.filter((d) => !runs.has(d.id))];
    } catch (e) {
      throw docsError(e);
    }
  };
  const docsCall =
    (fn: (p: Record<string, unknown>) => unknown) =>
    async (p: Record<string, unknown>): Promise<unknown> => {
      try {
        const r = await fn(p);
        pushBoard();
        return r;
      } catch (e) {
        throw docsError(e);
      }
    };
  let importing = false;
  /** 세금계산서 PDF는 홈택스 화면을 찍은 것 대신 앱이 표준 양식으로 만든 파일을 먼저 연다(대표 11-23). */
  const invoiceFiles = new InvoiceFiles(ownPdfDir);
  const docRun = new Map<string, string>();
  /** 앱이 만든 PDF가 지워졌어도 저장해 둔 양식 값이 있으면 다시 그린다(홈택스 화면 인쇄로 돌아가지 않는다). */
  const ownFile = async (id: string): Promise<string | null> => {
    const runId = docRun.get(id) ?? (id.startsWith('d-') ? id.slice(2) : null);
    if (!runId) return null;
    if (await invoiceFiles.exists(runId)) return invoiceFiles.pdf(runId);
    const form = await invoiceFiles.form(runId);
    return form ? invoiceFiles.save(runId, form, await invoicePdf(form, STATIC, htmlToPdf)) : null;
  };
  const docFile = async (id: string) => store.files.get(id) ?? (await ownFile(id)) ?? (await docs.filePath(id));

  const win = new BrowserWindow({
    width: Math.max(opts.width ?? 1280, WINDOW_MIN.width),
    height: Math.max(opts.height ?? 820, WINDOW_MIN.height),
    useContentSize: true,
    minWidth: WINDOW_MIN.width,
    minHeight: WINDOW_MIN.height,
    show: opts.show ?? true,
    title: fixture ? '소버린 AX (PoC 데모, 가짜 홈택스 페이지)' : '소버린 AX',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 15 } } : {}),
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      disableDialogs: true,
      spellcheck: false,
      devTools: !app.isPackaged,
      preload: path.join(STATIC, 'preload-shell.cjs'),
    },
  });
  win.on('page-title-updated', (e) => e.preventDefault());
  const wc = win.webContents;
  hardenWindow(win);
  const gesture = new GestureClock();
  const typing = new GestureClock();
  const panelInput = new GestureClock();
  wc.on('before-mouse-event', (_e, m) => {
    panelInput.note(performance.now());
    if (m.type === 'mouseUp') {
      gesture.note(performance.now());
      typing.note(performance.now());
    }
  });
  wc.on('before-input-event', (_e, i) => {
    if (i.type === 'keyDown' || i.type === 'keyUp') panelInput.note(performance.now());
    if (isGestureKey(i)) gesture.note(performance.now());
    if (isTypingKey(i)) typing.note(performance.now());
  });
  const prepareRate = new RateWindow(opts.preparePerMin ?? 6, 60_000);
  const openRate = new RateWindow(5, 60_000);
  const needGesture = (ms: number) => {
    if (!gesture.within(performance.now(), ms)) throw new Error('gesture_required');
  };
  const needTyping = (ms: number) => {
    if (!typing.within(performance.now(), ms)) throw new Error('gesture_required');
  };

  let browserAvailable = false;
  let browserShown = false;
  let browserWant: number | null = null;
  const panelNow = (): number => {
    if (!embedded || !browserAvailable || win.isDestroyed()) return SHELL.panel;
    return browserPanelWidth(win.getContentSize()[0]!, browserWant, browserShown, bar.active);
  };
  let phoneIssue: PhoneIssue | null = null;
  let phoneGate: PhoneGate | null = null;
  const REMOTE_APPROVED_NOTE = '폰에서 승인했어요. 2초 안에 [중지]하면 발급하지 않아요';
  const bar: ApprovalBar = new ApprovalBar(win, key, (w, h, wide, height) => barBounds(w, h, wide, height, panelNow()), { log });
  const send = (ev: ShellEvent) => {
    if (!win.isDestroyed()) wc.send(IPC.event, ev);
  };
  let pageNow: { url: string; title: string } | null = null;
  const eb = embedded
    ? new EmbeddedBrowser({
        win,
        post: (m) => host.browserPost(m),
        log,
        onPage: (p) => {
          if (pageNow?.url === p?.url && pageNow?.title === p?.title) return;
          pageNow = p;
          const addr = p?.url ? pageAddress(p.url) : '';
          if (mirrorRun && addr) send({ type: 'screen', runId: mirrorRun, url: addr, title: p!.title.slice(0, 120) });
        },
      })
    : null;
  host.on('browser', (m: unknown) => eb?.feed(m));
  win.once('closed', () => eb?.closeAll('window'));
  if (eb) {
    win.on('hide', () => log.event('main.window_hide', { visible: win.isVisible(), minimized: win.isMinimized() }));
    win.on('show', () => log.event('main.window_show', { visible: win.isVisible(), minimized: win.isMinimized() }));
  }
  const issuedInvoices = (): IssuedInvoice[] => {
    return store.docs.filter((d) => d.kind === '세금계산서' && d.issuedOn).map((d) => ({ who: d.name.replace(/^세금계산서 (?:\u00b7 )?/, ''), date: d.issuedOn!, total: null }));
  };
  let boardDay = '';
  const boardNow = async (): Promise<Board> => {
    const today = kstToday(Date.now());
    const docsNow = await listDocs().catch((e: unknown) => {
      boardDay = '';
      throw e;
    });
    boardDay = today;
    const money = profile === 'business' ? await bank.boardCards() : [];
    return buildBoard({
      today,
      reminderDay: REMINDER_DAY_DEFAULT,
      issued: issuedInvoices(),
      runs: runs.list().flatMap((r) => (r.cert ? [] : [{ id: r.id, status: r.status, who: r.counterparty.name, inDoubt: r.inDoubt === true }])),
      docs: docsNow.map((d) => ({ id: d.id, name: d.name, expiresOn: d.expiresOn, needsUser: !!d.vault?.needsUser })),
      bundle: null,
      cardFetchedOn: null,
      cardEnabled: false,
      setup: [...onboardingTodos(onb?.state ?? null).filter((t) => t.id !== 'counterparties' || !cps.length), ...(profile === 'business' && !chromeReady() ? [{ id: 'chrome', label: SETUP_LABEL.chrome, view: 'chrome' as const }] : []), ...(securityMissing() ? [{ id: 'security', label: SETUP_LABEL.security, view: 'security' as const }] : [])],
      money,
    });
  };
  let boardQueued = false;
  let boardGen = 0;
  const pushBoard = () => {
    if (boardQueued) return;
    boardQueued = true;
    setImmediate(() => {
      boardQueued = false;
      const gen = ++boardGen;
      void boardNow().then(
        (board) => gen === boardGen && send({ type: 'board', board }),
        (e: Error) => log.event('main.board_failed', { error: e.message.slice(0, 80) }),
      );
    });
  };
  const bootBoard = () => {
    boardGen++;
    return boardNow();
  };
  const boardDayTimer = setInterval(() => {
    if (kstToday(Date.now()) !== boardDay) pushBoard();
  }, 60_000);
  boardDayTimer.unref();
  bar.on('shown', (e: { band: boolean; height: number }) => {
    send({ type: 'bar', active: true, band: e.band, height: e.height });
    if (embedded && browserAvailable) sendBrowserState();
  });
  bar.on('layout', (e: { band: boolean; height: number }) => send({ type: 'bar-layout', band: e.band, height: e.height }));
  bar.on('hidden', (reason: string) => {
    send({ type: 'bar', active: false, reason });
    if (embedded && browserAvailable) sendBrowserState();
  });
  const settled = new Map<string, string>();
  runs.on('update', (run) => {
    send({ type: 'run', run });
    if (['waiting', 'done', 'stopped', 'attention'].includes(run.status) && settled.get(run.id) !== run.status) {
      settled.set(run.id, run.status);
      void refresh().then(pushBoard, () => {});
    }
    pushBoard();
  });
  const makeOwnPdf = async (run: RunView) => {
    const cp = ((await host.rpc('db.query.counterparties.list')) as Array<{ bizNo: string; repName: string | null; address: string | null }>).find((c) => c.bizNo === run.counterparty.bizNo) ?? null;
    const b = profiles().business;
    const form = formFromRun(run, runs.readback(run.id), { bizNo: b.bizNo, name: b.name, rep: b.rep, address: b.address, bizType: b.bizType, bizItem: b.bizItem, email: b.email }, cp);
    if (!form) return;
    const pdf = await invoicePdf(form, STATIC, htmlToPdf);
    await invoiceFiles.save(run.id, form, pdf);
    const kept = store.docs.find((d) => d.id === `d-${run.id}`);
    if (kept) Object.assign(kept, { noFile: false, runId: run.id });
    if (run.result?.noFile) {
      run.result.noFile = false;
      run.warnings = run.warnings.filter((w) => !/PDF는 받지 못했어요/.test(w));
      send({ type: 'run', run });
    }
    log.event('main.own_pdf_saved', {});
    void sendInvoiceMail(run, form, pdf).catch((e) => log.event('main.invoice_mail_failed', { error: (e as Error).message.slice(0, 120) }));
  };
  /** 거래처에 PDF를 붙여 택스오프 메일로 보낸다(대표 결정 2026-11-24). 잠깐 안 된 것이면 30초, 5분 뒤 두 번 더 해 본다. */
  const mailDeps = () => ({
    files: invoiceFiles,
    client: opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null,
    device: async () => {
      await accountInit();
      return account.device();
    },
    log: (n: string, d: Record<string, string | number | boolean>) => log.event(n, d),
  });
  const MAIL_FAILED = '거래처에 PDF 메일을 못 보냈어요';
  const sendInvoiceMail = async (run: RunView, form: InvoiceForm, pdf: Uint8Array) => {
    for (const wait of [0, 30_000, 300_000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait).unref?.());
      const r = await mailInvoice(mailDeps(), run.id, form, pdf);
      if (r === 'failed') break;
      if (r !== 'retry') return;
    }
    run.warnings = [...run.warnings, MAIL_FAILED];
    send({ type: 'run', run });
  };
  /** [다시 보내기]: 저장해 둔 양식과 PDF로 한 번 보낸다. 보내면 실패 안내를 거둔다. */
  const resendInvoiceMail = async (id: string): Promise<{ result: InvoiceMailResult }> => {
    const run = runs.get(id);
    const form = await invoiceFiles.form(id);
    const pdf = form && (await invoiceFiles.exists(id)) ? new Uint8Array(await fs.readFile(await invoiceFiles.pdf(id))) : null;
    if (!run || !form || !pdf) throw new Error('mail_unavailable');
    const result = await mailInvoice(mailDeps(), id, form, pdf);
    if ((result === 'sent' || result === 'already') && run.warnings.includes(MAIL_FAILED)) {
      run.warnings = run.warnings.filter((w) => w !== MAIL_FAILED);
      send({ type: 'run', run });
    }
    return { result };
  };
  runs.on('doc', (doc) => {
    store.docs.unshift(doc);
    const run = runs.get(doc.id.slice(2));
    if (run && !run.cert && run.result?.approvalNo) void makeOwnPdf(run).catch((e) => log.event('main.own_pdf_failed', { error: (e as Error).message.slice(0, 120) }));
    send({ type: 'doc', doc });
    pushBoard();
    void refresh().catch(() => {});
  });
  runs.on('gate-closed', (runId: string, reqId: string, reason: string) => {
    phoneGate?.close(runId, reqId, reason === 'expired' ? 'expired' : 'stopped');
    bar.close(reason, reqId);
  });

  const secrets = new SecretWindowCoordinator((runId) => runs.isActive(runId));
  let runChromePid = 0;
  const appToFront = () => {
    if (win.isDestroyed()) return;
    app.focus({ steal: true });
    win.moveTop();
    win.focus();
  };
  let frontWatch: NodeJS.Timeout | null = null;
  let frontBusy = false;
  const frontPid = (cb: (pid: number) => void) =>
    execFile('lsappinfo', ['front'], { timeout: 1_000 }, (e, asn) => {
      if (e || !String(asn).trim()) return cb(0);
      execFile('lsappinfo', ['info', '-only', 'pid', String(asn).trim()], { timeout: 1_000 }, (e2, out) => {
        const m = !e2 && /"pid"\s*=\s*(\d+)/i.exec(String(out));
        cb(m ? Number(m[1]) : 0);
      });
    });
  const watchChromeFront = (on: boolean) => {
    if (process.platform !== 'darwin') return;
    if (!on) {
      if (frontWatch) clearInterval(frontWatch);
      frontWatch = null;
      return;
    }
    if (frontWatch) return;
    frontWatch = setInterval(() => {
      if (frontBusy || !runChromePid) return;
      frontBusy = true;
      frontPid((pid) => {
        frontBusy = false;
        if (pid && pid === runChromePid) {
          appToFront();
          log.event('main.chrome_front_refocus', { guard: true });
        }
      });
    }, 400);
  };
  let mainClosing = false;
  win.once('close', () => {
    mainClosing = true;
  });
  let secretAsk: { reqId: string; bind: OneShotInputBind } | null = null;
  const closeSecret = () => {
    if (!secretAsk) return;
    send({ type: 'secretAsk', reqId: secretAsk.reqId, state: 'closed' });
    secretAsk = null;
    secrets.closed();
  };
  const openSecret = (data: unknown): void => {
    if (mainClosing || win.isDestroyed()) return log.event('main.secret_needed_ignored');
    const r = secrets.request(data);
    if (!r) return log.event(secrets.open ? 'main.secret_needed_queued' : 'main.secret_needed_ignored');
    const bind: OneShotInputBind = { runId: r.runId, kind: r.kind, scope: r.scope };
    secretAsk = { reqId: randomUUID().slice(0, 18), bind };
    const label = SECRET_LABELS[r.kind];
    const note = r.kind === 'cert_password' ? '처음 한 번만 넣으면 이 Mac 금고에 두고 다음부터 묻지 않아요.' : '이번 실행에서 한 번만 쓰고 저장하지 않아요.';
    send({ type: 'secretAsk', reqId: secretAsk.reqId, state: 'open', runId: r.runId, kind: r.kind, label, note });
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    app.focus({ steal: true });
    win.focus();
    log.event('main.secret_ask_shown', { kind: r.kind });
  };
  const vaultSecretSend = (bind: Parameters<typeof host.secretInputPort>[0], method: 'secret.provide' | 'secret.store', params: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> =>
    new Promise((resolve) => {
      let port: ReturnType<typeof host.secretInputPort> | null = null;
      const done = (v: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        try {
          port?.close();
        } catch {
          // 이미 닫힘
        }
        resolve(v);
      };
      const timer = setTimeout(() => done({ ok: false, error: 'timeout' }), 10_000);
      try {
        port = host.secretInputPort(bind);
        port.on('message', (e: { data: unknown }) => {
          const d = e.data as { error?: unknown } | null;
          done(d && typeof d.error === 'string' ? { ok: false, error: d.error.slice(0, 40) } : { ok: true });
        });
        port.start();
        port.postMessage({ t: 'rpc', id: 1, method, params });
      } catch (e) {
        done({ ok: false, error: (e as Error).message.slice(0, 40) });
      }
    });
  const saveCertMemory = async (value: unknown): Promise<{ remembered: boolean }> => {
    if (typeof value !== 'string' || !value) throw new Error('bad_value');
    const bytes = new TextEncoder().encode(value);
    const r = await vaultSecretSend({ mode: 'store', kind: 'cert_password', scope: 'business', notice: { version: 'cert-settings-2026-11-14' } }, 'secret.store', { entries: [{ field: 'pw', bytes }] });
    bytes.fill(0);
    log.event('main.cert_memory_saved', { ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    if (!r.ok) throw new Error('vault_refused');
    return { remembered: true };
  };
  const answerSecret = async (p: { reqId?: unknown; value?: unknown; cancel?: unknown }): Promise<{ ok: true }> => {
    const ask = secretAsk;
    if (!ask || p.reqId !== ask.reqId) throw new Error('not_requested');
    if (p.cancel === true) {
      secretAsk = null;
      send({ type: 'secretAsk', reqId: ask.reqId, state: 'closed' });
      const next = secrets.closed();
      log.event('main.secret_ask_cancelled', { kind: ask.bind.kind });
      if (next) openSecret(next);
      return { ok: true };
    }
    if (typeof p.value !== 'string' || !p.value) throw new Error('bad_value');
    const bytes = new TextEncoder().encode(p.value);
    const r = await vaultSecretSend(ask.bind, 'secret.provide', { kind: ask.bind.kind, scope: ask.bind.scope, bytes });
    bytes.fill(0);
    log.event('main.secret_ask_answered', { kind: ask.bind.kind, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    if (!r.ok) throw new Error('vault_refused');
    if (secretAsk === ask) secretAsk = null;
    send({ type: 'secretAsk', reqId: ask.reqId, state: 'done' });
    const next = secrets.closed();
    if (next) openSecret(next);
    return { ok: true };
  };
  let codefWin: { win: BrowserWindow; req: CodefNeeded } | null = null;
  codefPage = () => {
    if (!codefWin) log.event('main.secret_window_blank', { step: 'no_request' });
    return codefWin ? codefPageHtml(codefWin.req, { profileName: profiles()[codefWin.req.scope].name, certLabel: bankAuto.chosenLabel(), bankName: bankAuto.chosenBank() }) : null;
  };
  const openCodef = (req: CodefNeeded): void => {
    if (mainClosing || win.isDestroyed() || codefWin) {
      void host.control('codef.windowClosed', { reqId: req.reqId }).catch(() => {});
      return log.event('main.codef_window_ignored');
    }
    let port: ReturnType<typeof host.secretInputPort> | null = null;
    try {
      port = host.secretInputPort(req);
      const w = openVaultInputWindow(win, port, `${SHELL_SCHEME}://shell/codef-secret.html`, CODEF_WINDOW_TITLE, 340, (n, d) => log.event(n, d));
      codefWin = { win: w, req };
      w.on('closed', () => {
        if (codefWin?.win === w) codefWin = null;
        void host.control('codef.windowClosed', { reqId: req.reqId }).catch(() => {});
      });
    } catch (e) {
      port?.close();
      void host.control('codef.windowClosed', { reqId: req.reqId }).catch(() => {});
      log.event('main.codef_window_failed', { error: (e as Error).message.slice(0, 120) });
    }
  };
  const unlockCloud = (): UnlockCloud | null => {
    const c = opts.remote?.cloud?.account;
    const d = account.device();
    const email = account.view().email;
    if (!c || !d || !email) return null;
    return {
      email,
      putShare: (se) => c.putUnlockShare(d.auth, se),
      deleteShare: () => c.deleteUnlockShare(d.auth),
      startEmail: () => c.startUnlockEmail(d.auth),
      finishEmail: (x) => c.finishUnlockEmail(d.auth, x),
      putRecovery: (blob) => c.putRecovery(d.auth, blob),
      recovery: () => c.recovery(d.auth),
    };
  };
  // 월 리포트 홈택스 자동 받기(ADR-068 결정 6). 아래에서 만든다. 그 전에 금고가 열리면 기억했다가 만든 뒤 바로 받는다
  let reportSync: ReportSync | null = null;
  let screenOpenedEarly = false;
  let bankUnlocks = 0;
  const lockHost = new LockHost({
    control: (m, p) => host.control(m, p ?? {}),
    phones: () => (phoneLink?.list() ?? []).map((p) => ({ pairId: p.pairId, deviceId: p.deviceId, name: p.name, platform: p.platform, online: p.online, lastSeenAt: p.lastSeenAt, off: phoneLink?.uxOff(p.pairId) ?? false })),
    uxOwner: (pairId, body) => phoneLink?.uxOwner(pairId, body) ?? null,
    wake: (pairId) => phoneWaker.wake(pairId, 'unlock'),
    cloud: unlockCloud,
    platform: process.platform,
    push: (view) => {
      send({ type: 'lock', lock: view, settings: lockHost.settingsView() });
      if (view.locked) void lockHost.greet();
    },
    recoveryWindow: (mode, reqId) => openRecoveryWindow(mode, reqId),
    log: (n, d) => log.event(n, d ?? {}),
    screenOpened: () => {
      // 앱을 켠 뒤 처음 풀 때는 통장도 언제나 받는다(대표 11-28: 켤 때마다 한 번). 홈택스 받기(ReportSync)와 같은 규칙.
      void bank.call<{ started: number }>('bank.autoRefresh', { firstOpen: ++bankUnlocks === 1 }).then((r) => log.event('main.bank_auto_refresh', { started: r.started }), (e: Error) => log.event('main.bank_auto_refresh', { error: e.message.slice(0, 40) }));
      if (reportSync) void reportSync.screenOpened();
      else screenOpenedEarly = true;
    },
    visible: () => !win.isDestroyed() && win.isVisible() && !win.isMinimized(),
    emailOff: lockEmailOffFile(path.join(appPaths(root ?? defaultAppRoot()).userData, 'lock-email-off')),
  });
  // 잠금 화면은 창이 보일 때 바로 Touch ID를 묻는다(숨은 창 뒤에서 뜨지 않게). 창이 숨었다 다시 보이면 또 묻는다.
  win.on('show', () => void lockHost.greet());
  win.on('restore', () => void lockHost.greet());
  win.on('hide', () => lockHost.hidden());
  win.on('minimize', () => lockHost.hidden());
  let markLock: (p: Promise<void>) => void = () => {};
  const lockReady = new Promise<void>((r) => (markLock = (p) => void p.finally(r)));
  let recoveryWin: BrowserWindow | null = null;
  const openRecoveryWindow = (mode: 'recovery_show' | 'recovery_enter', reqId: string): Promise<void> =>
    new Promise((resolve) => {
      if (mainClosing || win.isDestroyed() || recoveryWin) return resolve();
      let port: ReturnType<typeof host.secretInputPort> | null = null;
      try {
        port = host.secretInputPort({ mode, reqId } as never);
        const w = openVaultInputWindow(win, port, `${SHELL_SCHEME}://shell/recovery-${mode === 'recovery_show' ? 'show' : 'enter'}.html`, '금고', mode === 'recovery_show' ? 250 : 230, (n, d) => log.event(n, d));
        recoveryWin = w;
        w.on('closed', () => {
          if (recoveryWin === w) recoveryWin = null;
          resolve();
        });
      } catch (e) {
        port?.close();
        log.event('main.recovery_window_failed', { error: (e as Error).message.slice(0, 120) });
        resolve();
      }
    });
  host.on('codef', (data: unknown) => send({ type: 'bankAuto', event: data }));
  host.on('vault-event', (name: string, data: unknown) => {
    if (name === 'vault.state') return void lockHost.onVaultState().catch(() => log.event('main.lock_state_failed'));
    if (name === 'lock.recovery') return void lockHost.onRecoveryReady((data ?? {}) as { reqId?: unknown; blob?: unknown });
    if (name === 'screen.frame' || name === 'screen.paused') {
      if (!mirrorRun) return;
      const d = (data ?? {}) as { data?: unknown; w?: unknown; h?: unknown; url?: unknown; paused?: unknown };
      if (name === 'screen.paused') return send({ type: 'screen', runId: mirrorRun, paused: d.paused === true });
      if (typeof d.data !== 'string' || d.data.length > 2_000_000) return;
      return send({ type: 'screen', runId: mirrorRun, frame: `data:image/jpeg;base64,${d.data}`, w: Number(d.w) || 0, h: Number(d.h) || 0, url: typeof d.url === 'string' ? d.url.slice(0, 200) : '' });
    }
    if (name === 'browser.blocked') {
      const on = (data as { blocked?: unknown } | null)?.blocked === true;
      eb?.setBlocked(on);
      if (mirrorRun) send({ type: 'screen', runId: mirrorRun, paused: on });
      return;
    }
    if (name === 'browser.launched') {
      const pid = Number((data as { pid?: unknown } | null)?.pid);
      if (Number.isSafeInteger(pid) && pid > 0) runChromePid = pid;
      watchChromeFront(true);
      appToFront();
      for (const ms of [250, 600, 1_000, 1_600, 2_400]) setTimeout(appToFront, ms);
      log.event('main.chrome_front_refocus', { popup: (data as { popup?: unknown } | null)?.popup === true });
      return;
    }
    if (name === 'browser.closed') {
      log.event('main.browser_closed', { reason: (data as { reason?: unknown } | null)?.reason === 'chrome' ? 'chrome' : 'tab' });
      if (mirrorRun) send({ type: 'screen', runId: mirrorRun, gone: true });
      if ((data as { reason?: unknown } | null)?.reason === 'chrome') {
        runChromePid = 0;
        watchChromeFront(false);
      }
      runs.browserClosed();
      return;
    }
    const cr = name === 'secret.needed' ? parseCodefNeeded(data) : null;
    if (cr) return openCodef(cr);
    if (name === 'secret.needed') return openSecret(data);
    const n = vaultNotice(name, data);
    if (n?.quiet) runs.say(n.runId, n.text);
    else if (n) runs.notice(n.runId, n.text, n.retry);
  });
  runs.on('update', (run: { id: string }) => {
    if (secrets.open?.runId === run.id && !runs.isActive(run.id)) closeSecret();
  });
  host.on('exit', (who: string) => {
    if (who === 'engine') bar.close('engine_exit');
  });
  runs.on('gate', (runId: string, req) => {
    if (runs.get(runId)?.rehearsal) {
      log.event('main.rehearsal_gate_refused', { runId });
      return void runs.stop(runId).catch(() => {});
    }
    const sendApproval = async (approval: LocalApproval, note?: string) => {
      phoneGate?.close(runId, req.reqId, 'pc');
      runs.approved(runId, note);
      await saveResume().catch(() => {});
      const r = await host.answerGate(approval);
      if (!r.ok) log.event('main.gate_answer_not_ok', { code: r.code ?? '', verdict: r.verdict });
      await runs.onAnswer(runId, r);
    };
    if (runs.batchAutoApprove(runId, req)) return void sendApproval(issueLocalApproval(key, req, 'click+batch'), BATCH_AUTO_NOTE);
    const gr = runs.get(runId);
    void phoneGate
      ?.offer(runId, req, {
        approve: async () => {
          bar.close('remote_approved', req.reqId);
          const name = runs.get(runId)?.counterparty.name ?? '';
          runNotify('gate', runId, '폰에서 승인했어요', `세금계산서${name ? ` ${name}` : ''} 발급을 시작해요`);
          await sendApproval(issueLocalApproval(key, req, 'remote+px'), REMOTE_APPROVED_NOTE);
        },
        deny: async () => {
          phoneIssue?.deniedByPhone(runId);
          await runs.stop(runId).catch((e: Error) => log.event('main.phone_deny_stop_failed', { error: e.message.slice(0, 80) }));
        },
      })
      .catch((e: Error) => log.event('main.phone_gate_offer_failed', { error: e.message.slice(0, 80) }));
    const offer = runs.batchOffer(runId);
    const manyShown = !!offer && actionText(req) === ACTION_TEXT;
    if (gr) runNotify('gate', runId, '승인이 필요해요', manyShown ? `세금계산서 ${offer.count}건, ${gr.counterparty.name} 외 ${offer.count - 1}건` : `세금계산서 ${gr.counterparty.name} ${wonText(gr.total)}`);
    void bar.open(req, gr?.auth, offer, runs.get(runId)?.cert?.name).then(async (o) => {
      if (o.decision === 'approve') {
        if (!verifyLocalApproval(key, o.approval)) return runs.abortGate(runId, 'answer.rejected');
        if (offer && o.batch === offer.count && !runs.batchApproved(runId, offer)) send({ type: 'say', text: BATCH_CHANGED_NOTE });
        await sendApproval(o.approval);
      } else if (o.reason === 'stopped') {
        await runs.stop(runId).catch((e: Error) => log.event('main.card_stop_failed', { error: e.message.slice(0, 80) }));
      } else if (o.reason === 'load_failed') await runs.abortGate(runId, 'bar.load_failed');
      else if (o.reason === 'busy') log.event('main.gate_while_open');
    });
  });

  let incidentOpen: string | null = null;
  const showAttest = (runId: string) => {
    const req = runs.attestFor(runId);
    if (!req || incidentOpen !== runId || bar.visible) return;
    void bar.openAttest(req).then(async (o) => {
      if (o.decision !== 'attest') {
        if (o.reason === 'load_failed') log.event('main.attest_bar_load_failed');
        if (o.reason === 'dismissed' && incidentOpen === runId) incidentOpen = null;
        return;
      }
      if (!verifyLocalAttestation(key, o.attestation) || o.attestation.attestReqId !== req.attestReqId) return log.event('main.attest_self_check_failed');
      runs.attestUsed(runId, req.attestReqId);
      const r = await host.answerAttest(o.attestation);
      if (!r.ok) log.event('main.attest_answer_not_ok', { code: String(r.code ?? ''), verdict: r.verdict });
      runs.onAttestAnswer(runId, r);
    });
  };
  const incidents = {
    open(id: string): { ready: boolean } {
      if (!runs.get(id)?.inDoubt) throw new Error('not_in_doubt');
      if (incidentOpen && incidentOpen !== id) bar.closeAttest('card_switched', { runId: incidentOpen });
      incidentOpen = id;
      showAttest(id);
      return { ready: !!runs.attestFor(id) };
    },
    close(id: string): { ok: true } {
      if (incidentOpen === id) incidentOpen = null;
      bar.closeAttest('card_closed', { runId: id });
      return { ok: true };
    },
  };
  runs.on('attest-ready', (runId: string) => showAttest(runId));
  runs.on('attest-withdrawn', (_runId: string, attestReqId: string, reason: string) => bar.closeAttest(`withdrawn.${reason}`, { attestReqId }));
  bar.on('hidden', (_reason: string, kind: string) => {
    if (kind === 'gate' && incidentOpen) setTimeout(() => incidentOpen && showAttest(incidentOpen), 0);
  });

  const g24Doc = (v: unknown): G24Doc => {
    if (v !== '주민등록표 등본' && v !== '주민등록표 초본') throw new Error('bad_doc');
    return v;
  };
  let daemon: DaemonHost | null = null;
  const liveNotices = new Set<Notification>();
  const showOsNotification: ShowNotification = (t, onClick) => {
    if (!Notification.isSupported()) throw new Error('notify_unsupported');
    const n = new Notification({ title: t.title, body: t.body });
    liveNotices.add(n);
    n.on('click', () => {
      liveNotices.delete(n);
      onClick();
    });
    n.on('close', () => liveNotices.delete(n));
    n.show();
  };
  const runNotify = (kind: 'gate' | 'turn' | 'end', runId: string, title: string, body: string) => {
    if (win.isDestroyed() || (win.isFocused() && win.isVisible() && !win.isMinimized())) return;
    try {
      showOsNotification({ title, body: body.slice(0, 120) }, () => {
        if (win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        send({ type: 'open', to: 'run', id: runId });
      });
      log.event('main.run_notify', { kind });
    } catch (e) {
      log.event('main.run_notify_failed', { error: (e as Error).message.slice(0, 60) });
    }
  };
  const resumeStore = new RunResumeStore({ save: (value) => host.rpc('resume.save', { value }), take: () => host.rpc('resume.take', {}) });
  const resumeWork = () =>
    pendingWork(
      runs.list(),
      (r) => runs.batchWaiting(r),
      (id) => cps.find((c) => c.id === id)?.email,
    );
  const saveResume = () => resumeStore.save(resumeWork(), Date.now());
  runs.on('update', () => void saveResume());
  let restored = false;
  const restoreRuns = async () => {
    if (restored) return;
    restored = true;
    const work = await resumeStore.take(Date.now());
    const items = work.items.filter((it) => !runs.get(it.from));
    const approved = work.approved.filter((a) => !runs.get(a.from));
    void saveResume();
    for (const a of approved) send({ type: 'say', text: `앞에서 승인한 ${a.name} ${wonText(a.total)} 건은 앱이 꺼져 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 확인해 주세요. 다시 발급하지 마세요.` });
    if (approved.length) log.event('main.resume_approved_notice', { count: approved.length });
    if (!items.length) return;
    const first = runs.restore(items);
    pushBoard();
    if (!first || (onb && !onb.done)) return;
    try {
      await needLogin();
    } catch {
      return log.event('main.restore_prepare_skipped', { why: 'login' });
    }
    prepareNow(first.id).catch((e: Error) => log.event('main.restore_prepare_failed', { code: e.message.slice(0, 60) }));
  };
  const wonText = (n: number) => `${Number(n).toLocaleString('ko-KR')}원`;
  /**
   * 앱이 들고 있던 홈택스 로그인이 연장 중에 풀렸으면 같은 인증서로 다른 곳(사장님 브라우저 등)이 로그인한 것이다.
   * 그때는 미리 로그인으로 되찾지 않고 다음 발급이 시작될 때까지 기다린다. 되찾으면 그쪽이 이중 로그인으로 끊긴다(11-25).
   */
  let hometaxHeld = false;
  let hometaxYielded = false;
  const runLast = new Map<string, string>();
  const settlingRuns = new Set<string>();
  runs.on('update', (r: RunView) => {
    const prev = runLast.get(r.id);
    runLast.set(r.id, r.status);
    if (r.status === 'preparing' && prev !== 'preparing') hometaxYielded = false;
    if (r.settling) settlingRuns.add(r.id);
    else if (settlingRuns.delete(r.id)) setTimeout(() => void prewarmForm('run_end'), 3_000).unref();
    if (prev === r.status || r.discarded) return;
    const what = `세금계산서 ${r.counterparty.name} ${wonText(r.total)}`;
    if (r.status === 'turn') return runNotify('turn', r.id, '홈택스에서 할 일이 있어요', r.turn?.text ?? what);
    if (!['done', 'attention', 'stopped'].includes(r.status) || !prev || prev === 'draft') return;
    if (!r.inDoubt) setTimeout(() => void prewarmForm('run_end'), 3_000).unref();
    if (r.batch) {
      const all = runs.batchRuns(r.batch.id);
      if (runs.batchOpen(r.batch.id)) return;
      const done = all.filter((x) => x.status === 'done').length;
      return runNotify('end', all[0]!.id, done === all.length ? `${all.length}건 모두 발급했어요` : `${all.length}건 중 ${done}건 발급했어요`, all.map((x) => `${x.counterparty.name} ${x.status === 'done' ? '발급' : x.status === 'draft' ? '남음' : '멈춤'}`).join(', '));
    }
    if (r.rehearsal) return runNotify('end', r.id, '예행을 마쳤어요', '승인 직전까지 갔고 발급하지 않았어요');
    if (r.status === 'done') return runNotify('end', r.id, '발급했어요', `${what}${r.result?.approvalNo ? `, 승인번호 ${r.result.approvalNo}` : ''}`);
    runNotify('end', r.id, r.status === 'attention' ? '확인이 필요해요' : '멈췄어요', `${what}, ${r.stoppedNote ?? ''}`);
  });
  let updater: UpdateHost | null = null;
  let screenLocked = false;
  const UPDATE_AWAY_SEC = 30 * 60;
  const UPDATE_QUIT_GRACE_MS = 2 * 60_000;
  const REGISTRY_EVERY_MS = 15 * 60_000;
  const HOMETAX_KEEPALIVE_MS = 10 * 60_000;
  let registryAt = 0;
  /** 레지스트리 동기화가 알려 준, 이 PC에 받아 둔 제품 플레이북. 첫 동기화 전에는 모른다(null). */
  let installedPkgs: ReadonlySet<string> | null = null;
  const amendReady = (): boolean => !!fixture || installedPkgs?.has(AMEND_PLAYBOOK) === true;
  let registryInflight: Promise<void> | null = null;
  const registrySync = (why: string): Promise<void> => {
    if (fixture) return Promise.resolve();
    return (registryInflight ??= host
      .rpc('registry.sync', {})
      .then(
        (r) => {
          registryAt = Date.now();
          const x = (r ?? {}) as { index?: unknown; policy?: unknown; packages?: Record<string, unknown>; installed?: unknown };
          if (Array.isArray(x.installed)) installedPkgs = new Set(x.installed.filter((v): v is string => typeof v === 'string'));
          log.event('main.registry_sync', { why, index: String(x.index ?? ''), policy: String(x.policy ?? ''), h01: String(x.packages?.['hometax.invoice.issue'] ?? '') });
        },
        (e: unknown) => log.event('main.registry_sync', { why, result: String((e as Error)?.message ?? 'failed').slice(0, 60) }),
      )
      .finally(() => (registryInflight = null)));
  };
  const registryFresh = async (): Promise<void> => {
    if (fixture || Date.now() - registryAt < REGISTRY_EVERY_MS) return;
    let t: NodeJS.Timeout | undefined;
    await Promise.race([registrySync('run'), new Promise<void>((r) => (t = setTimeout(r, 10_000)))]);
    clearTimeout(t);
  };
  const registryTimer = setInterval(() => void registrySync('timer'), REGISTRY_EVERY_MS);
  registryTimer.unref();
  const keepHometax = async (why: string) => {
    if (!eb || runs.list().some((r) => r.status === 'preparing' || r.status === 'issuing' || r.settling === true || r.approvedPending === true || r.handoff?.afterGate === true)) return;
    const result = await eb.keepSession().catch(() => 'error');
    if (result === 'extended') hometaxHeld = true;
    if (result !== 'none') log.event('main.hometax_keepalive', { why, result });
    if (result !== 'none') void prewarmForm(why);
    else void warmLogin(why);
  };
  const WARM_GAP_MS = 30 * 60_000;
  const WARM_PER_DAY = 4;
  let warming: Promise<void> | null = null;
  const warmed = { at: 0, day: '', n: 0 };
  /**
   * 미리 로그인: 인증서 비밀번호를 기억하고 있을 때만, 쉬는 동안 홈택스에 로그인해 발급 화면까지 가 둔다(대표 결정 2026-11-23).
   * 간편인증은 폰 승인이 필요해서 하지 않는다. 30분에 한 번, 하루 네 번까지.
   */
  const warmLogin = async (why: string): Promise<void> => {
    if (hometaxYielded) return;
    if (fixture || !eb || warming || profile !== 'business' || profiles().business.auth !== SIGN_LABEL.cert) return;
    if (setupMissing(profiles().business).length > 0 || !chromeReady() || securityMissing()) return;
    if (runs.anyActive() || reverifying || screenLocked || reportSync?.running) return;
    const now = Date.now();
    const day = new Date(now).toDateString();
    if (warmed.day !== day) Object.assign(warmed, { day, n: 0 });
    if (now - warmed.at < WARM_GAP_MS || warmed.n >= WARM_PER_DAY) return;
    if (!(await certMemory.has())) return;
    if (runs.anyActive() || warming) return;
    Object.assign(warmed, { at: now, n: warmed.n + 1 });
    const runId = `warm-${now.toString(36)}`;
    warming = new Promise<void>((resolve) => {
      const done = (result: string) => {
        clearTimeout(cap);
        host.removeListener('run', on);
        void host.control('run.end', { runId }).catch(() => {});
        warming = null;
        if (result !== 'warm.ready') warmed.at = 0;
        else hometaxHeld = true;
        log.event('main.warm_login', { why, result: result.slice(0, 60) });
        resolve();
      };
      const cap = setTimeout(() => done('timeout'), 120_000);
      const on = (e: { type?: string; runId?: string; status?: string; code?: string }) => {
        if (e.runId === runId && e.type === 'end') done(e.code ?? e.status ?? 'end');
      };
      host.on('run', on);
      host
        .control('run.begin', { runId, trigger: 'local' })
        .then(() => host.rpc('run.warm', { runId }))
        .catch((e: Error) => done(String(e?.message ?? 'failed')));
    });
  };
  let prewarmDay = '';
  const prewarmForm = async (why: string) => {
    if (fixture || runs.list().some((r) => ['preparing', 'waiting', 'issuing', 'turn'].includes(r.status) || r.settling === true || r.approvedPending === true || r.handoff?.afterGate === true)) return;
    const day = new Date().toDateString();
    const r = (await host.rpc('run.prewarm', { force: prewarmDay !== '' && prewarmDay !== day }).catch(() => null)) as { result?: string } | null;
    const result = String(r?.result ?? 'error');
    if (result === 'ok' || result === 'already') prewarmDay = day;
    if (result !== 'already' && result !== 'no_page' && result !== 'busy') log.event('main.prewarm', { why, result });
    if (result === 'logged_out' && hometaxHeld) {
      hometaxHeld = false;
      hometaxYielded = true;
      log.event('main.warm_login_yield', { why });
      return;
    }
    if (result === 'logged_out' || result === 'no_page' || result === 'elsewhere') void warmLogin(why);
  };
  const keepTimer = setInterval(() => void keepHometax('timer'), HOMETAX_KEEPALIVE_MS);
  keepTimer.unref();
  setTimeout(() => void keepHometax('start'), 8_000).unref();
  const onResume = () => {
    hometaxHeld = false;
    void keepHometax('resume');
    void registrySync('resume');
    daemon?.requestReload();
    void updater?.check();
  };
  let onb: OnboardingFlow | null = null;
  let onbShow = true;
  const onbStore = new EngineOnboardingStore((m, p) => host.rpc(m, p));
  const legacyOnbFile = path.join(appPaths(root ?? defaultAppRoot()).userData, 'onboarding-state.json');
  const bizCertPorts: BizCertReadPorts = {
    pick: () => pickFileBytes([{ name: '사업자등록증(PDF/사진)', extensions: ['pdf', 'png', 'jpg', 'jpeg'] }], win),
    pdfText: async (b, o) => (await parsePdfInSandbox(b, { ocrPages: 1, forceOcr: o.forceOcr })).text,
    imageText: async (b) => (await ocrImageInSandbox(b, { mode: 'document' })).text,
    parse: (text) => host.rpc('bizcert.parse', { text }),
    log: (n, d) => log.event(n, d),
  };
  const certNames = new Map<string, string>();
  const onbExternal: OnboardingExternal = fixture
    ? dev!.onboarding()
    : {
        recognizeBizCert: () => readBizCert(bizCertPorts),
        checkBizNo: async () => ({ status: 'unknown', label: '조회하지 못했어요', taxType: null, source: '국세청 조회' }),
        consentConfig: async () => structuredClone(CONSENT_CONFIG),
        findCerts: () => listNpkiCerts((m, p) => host.control(m, p), (der) => certInfoInSandbox(der), { today: kstToday(Date.now()), log: (n, d) => log.event(n, d), names: certNames }),
        certName: async (id) => {
          if (!certNames.has(id)) await onbExternal.findCerts();
          return certNames.get(id) || null;
        },
      };
  const onbPorts = onboardingPorts(onbExternal, onbStore, refresh);
  const bankAuto = bankAutoHandlers({ engine: (m, p) => host.rpc(m, p), certs: () => onbExternal.findCerts(), preferredCertId: () => onb?.state.certId ?? null, log: (n, d) => log.event(n, d) });
  const cpBook = new CounterpartyBook(
    (m, p) => host.rpc(m, p),
    fixture
      ? async () => ({ ...dev!.cpCert })
      : async () => {
          let picked = false;
          const pick = async () => {
            const b = await bizCertPorts.pick();
            picked = b !== null;
            return b;
          };
          return (await readBizCert({ ...bizCertPorts, pick })) ?? (picked ? 'unreadable' : null);
        },
  );
  const editLog = new ProfileEditLog(appPaths(root ?? defaultAppRoot()).userData);
  const editor = new ProfileEditor({
    list: async () => (await host.rpc('db.query.profiles.list')) as DbProfile[],
    upsert: async (row) => (await host.rpc('profile.upsert', row)) as DbProfile,
    checkBizNo: (n) => onbExternal.checkBizNo(n),
    saved: async (biz, changed) => {
      try {
        if (onb?.done) await onb.syncBiz(biz);
      } finally {
        if (changed.length) editLog.add({ at: new Date().toISOString(), kind: 'business', fields: changed });
        log.event('main.profile_edit', { fields: changed.join('.') || 'none' });
        await refresh();
        pushBoard();
      }
    },
  });
  const readOwnCert = async (): Promise<BizFields | 'unreadable' | null> => {
    if (fixture) return onbExternal.recognizeBizCert();
    let picked = false;
    const pick = async () => {
      const b = await bizCertPorts.pick();
      picked = b !== null;
      return b;
    };
    return (await readBizCert({ ...bizCertPorts, pick })) ?? (picked ? 'unreadable' : null);
  };
  let readingCert = false;
  const keepItem = async (runId: string) => {
    const r = runs.get(runId);
    if (!r || r.rehearsal || r.itemGuessed || !r.item) return;
    const cp = cps.find((c) => c.id === r.counterparty.id);
    if (!cp || cp.item) return;
    try {
      await cpBook.setFirstItem(cp.id, r.item);
      await refresh();
      runs.say(r.id, `이 품목을 ${cp.name} 저장 품목으로 남겼어요`);
      log.event('main.item_kept', { result: 'ok' });
    } catch (e) {
      log.event('main.item_kept', { result: (e as Error).message === 'bad_item_name' ? 'bad_item_name' : 'failed' });
    }
  };
  const intent: IntentResolver = opts.intent ?? engineIntentResolver((m, p) => host.rpc(m, p));
  const chatReply: ChatResponder = opts.chat ?? engineChatResponder((m, p) => host.rpc(m, p));
  /** 이번 주 대화 사용량({percent, resetAt}). 렌더러 처리기는 엔진 RPC를 직접 부르지 않는다(h01). */
  const chatUsage = () => host.rpc('chat.usage', {});
  let agentCreated: RunView[] = [];
  const agentReads = agentPorts({
    rpc: (m, p) => (m === 'chat.step' && opts.agent ? opts.agent.step(p as unknown as StepParams) : m === 'chat.route' && opts.agent?.route ? opts.agent.route(p) : m === 'db.query.runs.history' && opts.agent?.history ? opts.agent.history(p) : host.rpc(m, p)),
    route: CHAT_REACTIONS_ON && (!opts.agent || !!opts.agent.route),
    onReaction: (reaction) => send({ type: 'chat-reaction', reaction }),
    profileId: () => businessId,
    runs,
    setupMissing: () => setupMissing(profiles().business).length > 0 || !chromeReady(),
    onCreated: (run) => agentCreated.push(run),
    receivables: () => bank.receivables(),
    payables: () => bank.payables(),
    invoices: (kind, month) => bank.invoices(kind, month),
    cashFlow: (month) => bank.cashFlowValues(month),
    vat: () => bank.vat(),
    pastIssued: () => [],
    onProgress: (phase: AgentPhase) => send({ type: 'chat-progress', phase }),
    openScreen: (screen: string) => send({ type: 'open-screen', screen }),
    amendReady,
  });
  const agent = new AgentChat(agentReads);
  const finishReply = (reply: ReturnType<typeof interpret>, via: 'model' | 'offline', note: string | null, sent: SentTo[]) => {
    if (reply.kind === 'draft') {
      reply.run.interp = via;
      reply.run.sent = sent;
      pushBoard();
      if (sendByUser) autoPrepare(reply.run.id);
    }
    return { ...reply, via, note, sent };
  };
  // 대량 발급(ADR-059): 거래처 휴폐업 조회와 거래처 맞추기. 조회한 상태는 10분 동안 다시 묻지 않는다.
  const statusSeen = new Map<string, { code: BizStatusCode | '01'; at: number }>();
  const bizStatus = async (bizNos: string[]): Promise<Record<string, BizStatusCode>> => {
    const now = Date.now();
    const want = [...new Set(bizNos)].filter((b) => !(now - (statusSeen.get(b)?.at ?? -Infinity) < 10 * 60_000));
    if (want.length) {
      try {
        const r = (await host.rpc('bizverify.statusMany', { bizNos: want })) as { statuses?: unknown; code?: string | null };
        const got = statusMap(r);
        const answered = new Set(Array.isArray(r?.statuses) ? (r.statuses as Array<{ bizNo?: unknown }>).map((x) => String(x?.bizNo ?? '')) : []);
        for (const b of want) if (answered.has(b)) statusSeen.set(b, { code: got[b] ?? '01', at: now });
        if (r?.code) log.event('bulk.status_partial', { code: String(r.code).slice(0, 40), asked: want.length, answered: answered.size });
      } catch (e) {
        log.event('bulk.status_failed', { code: (e as Error).message.slice(0, 60), asked: want.length });
      }
    }
    const out: Record<string, BizStatusCode> = {};
    for (const b of bizNos) {
      const c = statusSeen.get(b)?.code;
      if (c === '02' || c === '03' || c === '') out[b] = c;
    }
    return out;
  };
  const bulkCounterparty = async (row: IssueRow): Promise<Counterparty> => {
    const known = (row.cpId && cps.find((c) => c.id === row.cpId && c.bizNo === row.bizNo)) || cps.find((c) => c.bizNo === row.bizNo);
    if (known) return known;
    await cpBook.save({ name: row.name, bizNo: row.bizNo });
    await refresh();
    const made = cps.find((c) => c.bizNo === row.bizNo);
    if (!made) throw new Error('bulk.counterparty_failed');
    log.event('bulk.counterparty_added', {});
    return made;
  };
  const startBulkSheet = async (rows: IssueRow[]): Promise<unknown> => {
    log.event('bulk.sheet_not_ready', { rows: rows.length });
    throw new Error('bulk.sheet_not_ready');
  };
  let sendByUser = false;
  const autoPrepare = (id: string) => {
    const r = runs.get(id);
    if (!r || r.status !== 'draft' || (!r.cert && !String(r.item ?? '').trim())) return;
    setImmediate(() => {
      log.event('main.prepare_auto', {});
      if (queueIfBusy(id)) return;
      prepareNow(id).catch((e: Error) => log.event('main.prepare_auto_failed', { code: e.message.slice(0, 60) }));
    });
  };
  let nextUp: string | null = null;
  const queueIfBusy = (id: string): boolean => {
    const active = runs.activeRun();
    const d = runs.get(id);
    if (!active || !d || active.id === id) return false;
    if (!active.cert && !d.cert && active.counterparty.id === d.counterparty.id && active.supply === d.supply && active.item === d.item && active.vat === d.vat && active.email.value === d.email.value) {
      log.event('main.prepare_same', {});
      runs.say(id, SAME_NOTE);
      return true;
    }
    if (nextUp && nextUp !== id) {
      runs.unsay(nextUp, QUEUED_NOTE);
      runs.markStarting(nextUp, false);
    }
    nextUp = id;
    runs.markStarting(id, true);
    if (runs.replaceable(active.id) && active.counterparty.id === d.counterparty.id) {
      log.event('main.prepare_replace', {});
      runs.say(id, REPLACING_NOTE);
      runs.stop(active.id).then(
        () => {
          const prev = runs.get(active.id);
          if (prev) prev.replaced = true;
          runs.say(active.id, REPLACED_NOTE);
        },
        (e: Error) => log.event('main.prepare_replace_failed', { code: e.message.slice(0, 60) }),
      );
    } else {
      log.event('main.prepare_queued', {});
      runs.say(id, QUEUED_NOTE);
    }
    return true;
  };
  runs.on('update', () => {
    if (!nextUp || runs.anyActive()) return;
    const id = nextUp;
    nextUp = null;
    runs.unsay(id, QUEUED_NOTE);
    runs.unsay(id, REPLACING_NOTE);
    if (runs.get(id)?.status !== 'draft') return;
    setImmediate(() => prepareNow(id).catch((e: Error) => log.event('main.prepare_next_failed', { code: e.message.slice(0, 60) })));
  });
  // 준비가 시작을 기다리는 동안(미리 로그인·지난 발급 확인) 같은 건의 [준비]를 다시 눌러도 횟수를 쓰지 않고 그 준비를 이어 준다(대표 지적 2026-11-24).
  const preparing = new Map<string, Promise<unknown>>();
  const prepareNow = (id: string): Promise<unknown> => {
    const going = preparing.get(id);
    if (going) return going;
    const p = prepareOnce(id).finally(() => {
      preparing.delete(id);
      runs.markStarting(id, false);
    });
    preparing.set(id, p);
    return p;
  };
  const prepareOnce = async (id: string) => {
    const now = performance.now();
    if (!prepareRate.take(now)) {
      log.event('main.prepare_throttled', { why: 'rate' });
      throw new Error(`throttled.rate:${Math.max(1, Math.ceil(prepareRate.waitMs(now) / 1000))}`);
    }
    const waitReverify = async () => {
      while (reverifying) {
        runs.say(id, REVERIFY_WAIT_NOTE);
        await reverifying;
        runs.unsay(id, REVERIFY_WAIT_NOTE);
      }
    };
    runs.markStarting(id, true);
    await waitReverify();
    await registryFresh();
    await waitReverify();
    if (warming) {
      runs.say(id, WARM_WAIT_NOTE);
      await warming;
      runs.unsay(id, WARM_WAIT_NOTE);
    }
    // 뒤에서 도는 리포트 받기는 사람이 시작한 일에 자리를 비켜 준다(안 그러면 엔진이 busy로 거절한다, 2026-11-26 대표 지적)
    if (reportSync?.running) {
      log.event('main.report_yield', {});
      await reportSync.stop();
    }
    const r = await runs.prepare(id);
    await keepItem(id);
    return r;
  };
  const linkVaultOf = (k: DesktopKeys): PcLinkVault => {
    const v = (k as Partial<VaultDesktopKeys>).link;
    if (!v) throw Object.assign(new Error('keys'), { code: 'account.keys_unavailable' });
    return v;
  };
  let remoteKeys: Promise<DesktopKeys> | null = null;
  const keysOf = (): Promise<DesktopKeys> => {
    const f = opts.remote?.keys;
    if (!f) return Promise.reject(Object.assign(new Error('keys'), { code: 'account.keys_unavailable' }));
    remoteKeys ??= f((m, p) => host.control(m, p)).catch((e: unknown) => {
      remoteKeys = null;
      throw e;
    });
    return remoteKeys;
  };
  const account = new DesktopAccount({
    client: opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null,
    keys: keysOf,
    identity: new RemoteIdentityFile(appPaths(root ?? defaultAppRoot()).userData),
    pending: new PendingCodeFile(appPaths(root ?? defaultAppRoot()).userData),
    platform: process.platform === 'darwin' ? 'macos' : 'windows',
    deviceName: opts.remote?.deviceName ?? (process.platform === 'darwin' ? 'Mac PC' : 'Windows PC'),
    model: deviceModel,
    pairing: opts.remote?.pairing !== false,
    linkVault: async () => linkVaultOf(await keysOf()),
    resetKeys: () => {
      remoteKeys = null;
    },
    onRekey: () => void host.rpc('share.resend').catch(() => undefined),
    log: (n, d) => log.event(n, d),
  });
  let linkTimer: ReturnType<typeof setInterval> | null = null;
  let keyDeposited = false;
  const depositKey = (v: AccountView): void => {
    if (v.step === 'signed_out') keyDeposited = false;
    if (keyDeposited || v.step !== 'signed_in') return;
    keyDeposited = true;
    void account.depositKey().then((r) => {
      if (r !== 'stored' && r !== 'already' && r !== 'request.not_found' && r !== 'skipped') keyDeposited = false;
      if (r === 'account.cert_invalid') send({ type: 'account', account: account.view() });
    });
  };
  const watchLink = <T extends AccountView>(v: T): T => {
    depositKey(v);
    const dev = account.device();
    if (dev) void lockHost.identity(dev.deviceId);
    if (shouldStartPhones({ signedIn: !!account.device(), running: !!phoneLink })) {
      void Promise.resolve(phones()?.start())
        .then(() => syncAwake())
        .catch((e: Error) => log.event('main.phone_link', { step: 'start', result: e.message.slice(0, 40) }));
    }
    const linking = v.step.startsWith('link_');
    if (linking && !linkTimer) {
      linkTimer = setInterval(() => {
        void account.linkPoll().then((changed) => {
          const now = account.view();
          if (changed) send({ type: 'account', account: now });
          if (!now.step.startsWith('link_')) watchLink(now);
        });
      }, LINK_POLL_MS);
      linkTimer.unref?.();
    } else if (!linking && linkTimer) {
      clearInterval(linkTimer);
      linkTimer = null;
    }
    return v;
  };
  let accountReady: Promise<unknown> | null = null;
  const accountInit = () => (accountReady ??= account.init().then((v) => (depositKey(v), v)));
  let gwSeq = 0;
  let gwLog: Array<[number, string]> = [];
  const gwIssuedSince = (n: number) => gwLog.filter(([i]) => i > n).map(([, p]) => p);
  const gwAuth = new GatewayAuthHost({
    device: async () => {
      await accountInit().catch(() => null);
      return account.device();
    },
    log: (n, d) => log.event(n, d),
    onIssued: (path) => {
      gwLog = [...gwLog.slice(-199), [++gwSeq, path]];
    },
    modelAllowed: () => modelOk(),
  });
  host.setGatewayAuth((m) => gwAuth.handle(m));
  const issueLock = new IssueLockHost({
    client: opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null,
    device: async () => {
      await accountInit();
      return account.device();
    },
    log: (n, d) => log.event(n, d),
  });
  host.setIssueLock((m) => issueLock.handle(m));
  host.on('exit', () => void issueLock.release());
  let pairHost: PairingHost | null = null;
  const pairedThisRun: DesktopPairResult[] = [];
  let pairShielded = false;
  const pairShield = (v: PairView) => {
    const on = v.step === 'waiting_phone' || v.step === 'awaiting_sas' || v.step === 'checking';
    if (on === pairShielded || win.isDestroyed()) return;
    pairShielded = on;
    win.setContentProtection(on);
  };
  const pairPush = (v: PairView) => {
    pairShield(v);
    send({ type: 'pair', pair: v });
  };
  const pairing = (): PairingHost => {
    if (pairHost) return pairHost;
    const cloud = opts.remote?.cloud;
    const device = account.device();
    if (opts.remote?.pairing === false) throw new Error('pair_unavailable');
    if (!cloud || !device) throw new Error(device ? 'pair_unavailable' : 'account_required');
    pairHost = new PairingHost({
      account: cloud.account,
      relayHttp: cloud.relay,
      relay: opts.remote?.relayClient ?? wsRelayClient({ host: cloud.relayHost, open: cloud.openSocket, insecureLocal: cloud.insecureLocal }),
      relayHost: cloud.relayHost,
      device,
      keys: keysOf,
      qr: qrSvgDataUrl,
      desktopName: opts.remote?.deviceName ?? (process.platform === 'darwin' ? 'Mac PC' : 'Windows PC'),
      log: (n, d) => log.event(n, d),
      onView: pairPush,
      resyncDevices: () => reconcileDevices(),
      knownPhone: (id) => !!phones()?.list().some((x) => x.deviceId === id),
      onPaired: (r) => {
        pairedThisRun.push(r);
        const link = phones();
        if (!link) log.event('main.phone_link', { step: 'add', result: account.device() ? 'no_cloud' : 'signed_out' });
        void link?.add(r).catch((e: Error) => log.event('main.phone_link', { step: 'add', result: e.message.slice(0, 40) }));
        send({ type: 'account', account: account.view() });
      },
    });
    return pairHost;
  };
  const pairReset = () => {
    pairHost?.cancel();
    pairHost = null;
  };
  const billingCall = async <T>(f: (c: AccountClient, auth: DeviceAuth) => Promise<T>): Promise<T> => {
    await accountInit().catch(() => null);
    const cloud = opts.remote?.cloud;
    const device = account.device();
    if (!cloud || !device) throw new Error('account_required');
    try {
      return await f(cloud.account, device.auth);
    } catch (e) {
      if ((e as { code?: string }).code !== 'account.unauthorized') throw e;
      device.clearToken();
      return f(cloud.account, device.auth);
    }
  };
  const tokenSeal: TokenSeal = {
    seal: (b) => (safeStorage.isEncryptionAvailable() ? `ss1:${safeStorage.encryptString(Buffer.from(b).toString('base64')).toString('base64')}` : `b64:${Buffer.from(b).toString('base64')}`),
    open: (v) => new Uint8Array(Buffer.from(v.startsWith('ss1:') ? safeStorage.decryptString(Buffer.from(v.slice(4), 'base64')) : v.startsWith('b64:') ? v.slice(4) : '', 'base64')),
  };
  let phoneLink: PhoneLink | null = null;
  let phoneSess: PhoneSessionHook | null = null;
  const docPush = new DocPush({
    source: {
      list: async () => (await host.rpc('db.query.docs.phone', {})) as DocPhoneRow[],
      read: async (id) => fs.readFile(((await host.rpc('document.file', { id })) as { path: string }).path),
    },
    log: (n, d) => log.event(n, d),
  });
  // 큐로 온 발급은 거래처 목록을 읽은 뒤에 시작한다. 켜자마자 큐를 비우면 목록이 비어 counterparty_unknown으로 버려진다.
  let markBooted: () => void = () => {};
  const booted = new Promise<void>((r) => (markBooted = r));
  const phoneIssueOf = (): PhoneIssue => {
    phoneIssue ??= new PhoneIssue({
      approver: (pairId) => phoneGateOf().canApprove(pairId),
      approveCode: (id) => phoneGate?.codeOf(id),
      counterparty: (ref) => cps.find((c) => c.id === ref) ?? null,
      // 폰이 넣거나 고친 거래처(ADR-066). 장부를 다시 읽고 PC 화면 목록도 새로 그린다.
      putCounterparty: async (sv) => {
        const r = await cpBook.saveFromPhone(sv);
        if (typeof r === 'string') return r;
        await refresh();
        send({ type: 'docs-reload' });
        log.event('phone.counterparty_saved', { added: r.added });
        return r.id;
      },
      createDraft: (cp, supply, item) => runs.createDraft(cp, supply, 'separate', item),
      createAmend: async (req) => {
        const row = (await agentReads.issued()).find((x) => x.approvalNo === req.original && !x.amendOf);
        const cp = row?.counterpartyId ? cps.find((c) => c.id === row.counterpartyId) : undefined;
        if (!row || !cp || typeof row.supply !== 'number' || typeof row.tax !== 'number') return null;
        const a = row.amend ?? null;
        const src = {
          approvalNo: req.original, issueDate: row.issueDate ?? row.date, issuedOn: row.date, counterpartyId: cp.id, counterpartName: cp.name, counterpartBizNo: cp.bizNo,
          item: row.item ?? cp.item ?? '', supply: row.supply, tax: row.tax, adjusted: a?.adjusted ?? null, cancelled: a?.cancelled ?? false, replaced: a?.replaced ?? false,
        };
        return runs.createAmendFrom(src, req.what, req.values);
      },
      prepare: (id) => prepareNow(id),
      anyActive: () => runs.anyActive(),
      retryCert: (id) => runs.retryCert(id),
      simpleAuth: (id, op, d) => runs.simpleAuth(id, op, d),
      get: (id) => runs.get(id),
      onDraft: () => pushBoard(),
      cmds: new CmdLog(path.join(appPaths(root ?? defaultAppRoot()).userData, 'remote-cmds.json')),
      log: (n, d) => log.event(n, d ?? {}),
      wake: (pairId, kind) => void phoneWaker.wake(pairId, kind),
    });
    return phoneIssue;
  };
  const wakeClient = opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null;
  const phoneWaker = new PhoneWaker({
    deviceOf: (pairId) => phoneLink?.deviceOf(pairId) ?? null,
    call: wakeClient
      ? async (deviceId, kind) => {
          const d = account.device();
          if (!d) throw Object.assign(new Error('account'), { code: 'account.signed_out' });
          try {
            return await wakeClient.wakePhone(d.auth, deviceId, kind);
          } catch (e) {
            if ((e as { code?: unknown }).code !== 'account.unauthorized' && (e as { code?: unknown }).code !== 'push.unauthorized') throw e;
            d.clearToken();
            return wakeClient.wakePhone(d.auth, deviceId, kind);
          }
        }
      : null,
    log: (n, d) => log.event(n, d),
  });
  const phoneGateOf = (): PhoneGate => {
    phoneGate ??= new PhoneGate({
      px: (pairId) => phoneLink?.px(pairId) ?? null,
      tracked: (id) => phoneIssue?.trackedOf(id) ?? null,
      poke: (id) => phoneIssue?.poke(id),
      wake: (pairId, kind) => void phoneWaker.wake(pairId, kind),
      attached: (pairId) => phoneWaker.forget(pairId),
      approvals: new ApprovalLog(path.join(appPaths(root ?? defaultAppRoot()).userData, 'remote-approvals.json')),
      phoneAdded: (bizNo) => cps.some((c) => c.phoneAdded === true && c.bizNo.replace(/\D/g, '') === bizNo.replace(/\D/g, '')),
      log: (n, d) => log.event(n, d ?? {}),
    });
    return phoneGate;
  };
  runs.on('restart', (x: { from: string; to: string }) => phoneIssue?.relink(x.from, x.to));
  runs.on('update', (run) => {
    phoneIssue?.update(run);
    if (run.status !== 'waiting') phoneGate?.close(run.id, undefined, run.status === 'issuing' || run.status === 'done' ? 'pc' : 'stopped');
  });
  const phones = (): PhoneLink | null => {
    if (phoneLink) return phoneLink;
    const cloud = opts.remote?.cloud;
    if (fixture || !cloud?.mailboxQueue || !account.device()) return null;
    const auth = (htm: 'GET' | 'POST' | 'PUT' | 'DELETE', htu: string) => {
      const d = account.device();
      if (!d) return Promise.reject(Object.assign(new Error('account'), { code: 'account.signed_out' }));
      return d.auth(htm, htu);
    };
    const live = wsRelayClient({ host: cloud.relayHost, open: cloud.openSocket, insecureLocal: cloud.insecureLocal, deviceAuth: (htm, htu) => auth(htm, htu) });
    phoneLink = new PhoneLink({
      store: new PhoneStore(path.join(appPaths(root ?? defaultAppRoot()).userData, 'remote-phones.json')),
      seal: tokenSeal,
      keys: async () => {
        const k = (await keysOf()) as Partial<VaultDesktopKeys> & DesktopKeys;
        if (!k.hpkeOpen || !k.qdPublic) throw Object.assign(new Error('keys'), { code: 'account.keys_unavailable' });
        return { noise: k.noise, vd: k.vd, hpkeOpen: k.hpkeOpen, qdPublic: k.qdPublic };
      },
      joinMailbox: opts.remote?.relayClient ? undefined : (id, tok) => live.joinMailbox(id, tok, 'desktop'),
      queue: (id, tok) => cloud.mailboxQueue!(id, tok, auth),
      deleteMailbox: (id, w, peer) => cloud.relay.deleteMailbox(auth, id, w, peer),
      receiver: () =>
        phoneReceiver((m, p) => host.rpc(m, p), {
          onReceipt: () => pushBoard(),
          onCash: () => pushBoard(),
          log: (n, d) => log.event(n, d),
        }),
      // 폰이 PC가 꺼져 있을 때 맡긴 발급: 켜지자마자 시작한다. 진행은 폰이 다시 붙을 때 이어 받는다(attach).
      queuedCmd: async (pairId, body) => {
        await booted;
        await phoneIssueOf().handle(pairId, { send: () => undefined }, body);
      },
      deviceListVersion: () => account.device()?.deviceList.listVersion ?? 0,
      shareKeys: async (deviceId) => {
        const d = account.device();
        const vault = ((await keysOf()) as Partial<VaultDesktopKeys>).share;
        if (!d || !vault || !d.deviceList.entries.some((e) => e.entry.device_id === deviceId && e.entry.role === 'mobile')) return null;
        const keys: Uint8Array[] = [];
        try {
          let signPub: Uint8Array = new Uint8Array(0);
          for (let e = 0; e <= shareEpoch(d.deviceList); e++) {
            const r = await vault.key(e);
            keys.push(r.key);
            signPub = r.signPub;
          }
          return makeShareKeyBody({ signPub, keys });
        } finally {
          for (const k of keys) k.fill(0);
        }
      },
      appVersion: runVersion(app.isPackaged, process.env, () => app.getVersion()),
      // 수정 발급 패키지가 없으면 폰에 amend.v1을 알리지 않는다(폰에 [고치기]와 수정 카드가 뜨지 않는다)
      capabilities: () => [...DESKTOP_CAPS, ...SESSION_CAPS.filter((c) => c !== CAP.amend || amendReady()), ...APPROVE_CAPS],
      session: (phoneSess = phoneSession({
        issue: phoneIssueOf(),
        copy: (pairId, want) =>
          buildPhoneCopy({
            counterparties: () => cps,
            runs: () => runs.list(),
            bank: (m, p) => bank.call(m, p ?? {}),
            approval: async () => ({ approver: !!phoneLink?.px(pairId), left: await phoneGateOf().leftToday() }),
            ...(want.issued ? { issued: () => agentReads.issued(), today: () => kstToday(Date.now()), amend: !!want.amend } : {}),
            report: want.report,
            reportV2: want.reportV2,
            biz: () => {
              const b = profiles().business;
              return b.nameMissing ? null : { name: b.name, bizNo: b.bizNo ?? null };
            },
            log: (n, d) => log.event(n, d),
          }),
        approve: { gate: phoneGateOf(), enroll: (pairId, body) => (phoneLink ? phoneLink.enrollPx(pairId, body) : Promise.resolve({ state: 'rejected' as const, pxId: '0'.repeat(16) })) },
        docs: docPush,
        lock: {
          attach: (pairId, s) => lockHost.attach(pairId, s),
          detach: (pairId) => lockHost.detach(pairId),
          enroll: (pairId, body) => (phoneLink?.uxOff(pairId) ? Promise.resolve({ state: 'off' as const }) : lockHost.enroll(pairId, body)),
          grant: (pairId, body) => lockHost.grant(pairId, body),
          remote: (pairId) => lockHost.remote(pairId),
        },
        log: (n, d) => log.event(n, d ?? {}),
      })),
      log: (n, d) => log.event(n, d ?? {}),
      onChange: () => {
        send({ type: 'account', account: account.view() });
        syncAwake();
      },
    });
    return phoneLink;
  };
  let deviceMgr: DeviceManager | null = null;
  const withApproval = (devices: DeviceView[]): Array<DeviceView & { approval?: PhoneView['approver']; live?: 'on' | 'off' | 'relink' }> => {
    const phones = phoneLink?.list() ?? [];
    return devices.map((d) => {
      if (d.role !== 'mobile') return d;
      const x = phones.find((ph) => ph.deviceId === d.deviceId);
      return x ? { ...d, approval: x.approver, live: x.online ? 'on' : x.relink ? 'relink' : 'off' } : d;
    });
  };
  const devicesOf = (): DeviceManager => {
    const client = opts.remote?.cloud?.account;
    if (!client || !account.device()) throw new Error('account_required');
    return (deviceMgr ??= new DeviceManager({
      client,
      session: () => account.device(),
      aik: async () => (await keysOf()).aik,
      dropPhone: async (id) => {
        await phones()?.removeDevice(id);
        await lockHost.removePhone(id);
      },
      log: (n, d) => log.event(n, d),
    }));
  };
  let pcLinkHost: PcLinkHost | null = null;
  const pcLinkHostOf = (): PcLinkHost => {
    const client = opts.remote?.cloud?.account;
    const mgr = devicesOf();
    if (!client) throw new Error('account_required');
    return (pcLinkHost ??= new PcLinkHost({
      client,
      exclusive: (f) => mgr.exclusive(f),
      aik: async () => (await keysOf()).aik,
      vault: async () => linkVaultOf(await keysOf()),
      log: (n, d) => log.event(n, d),
    }));
  };
  const reconcileDevices = async (): Promise<void> => {
    try {
      if ((await devicesOf().reconcile()) > 0) {
        send({ type: 'account', account: account.view() });
        void phoneLink?.pushShareKeys();
      }
    } catch (e) {
      log.event('main.device_sync', { result: typeof (e as { code?: unknown }).code === 'string' ? ((e as { code: string }).code) : 'skipped' });
    }
  };
  const shareSync = new ShareSync({
    client: opts.remote?.keys ? (opts.remote.cloud?.account ?? null) : null,
    device: async () => {
      await accountInit();
      return account.device();
    },
    vault: async () => {
      const v = ((await keysOf()) as Partial<VaultDesktopKeys>).share;
      if (!v) throw Object.assign(new Error('keys'), { code: 'account.keys_unavailable' });
      return v;
    },
    store: engineShareStore((m, p) => host.rpc(m, p)),
    collect: () => host.rpc('share.collect'),
    refreshDeviceList: async () => {
      if ((await devicesOf().reconcile()) > 0) {
        send({ type: 'account', account: account.view() });
        void phoneLink?.pushShareKeys();
      }
    },
    log: (n, d) => log.event(n, d),
  });
  const syncShare = async (): Promise<void> => {
    const r = await shareSync.sync();
    if (r.parties > 0) {
      await refresh();
      pushBoard();
    }
  };
  const SHARE_EVERY_MS = 10 * 60_000;
  const shareTimer = setInterval(() => void syncShare().catch(() => undefined), SHARE_EVERY_MS);
  shareTimer.unref?.();
  const moveCloud = opts.remote?.keys ? opts.remote.cloud : undefined;
  const moveStaging = path.join(paths.staging, 'move');
  const pcMove = moveCloud
    ? new PcMoveHost({
        client: moveCloud.account,
        relayHttp: moveCloud.relay,
        relay: opts.remote?.relayClient ?? wsRelayClient({ host: moveCloud.relayHost, open: moveCloud.openSocket, insecureLocal: moveCloud.insecureLocal }),
        device: async () => {
          await accountInit();
          return account.device();
        },
        noise: async () => (await keysOf()).noise,
        engine: {
          exportBundle: async () => (await host.rpc('move.export')) as PcMoveBundle,
          importBundle: async (file) => (await host.rpc('move.import', { file })) as MoveResult,
          discard: async (file) => void (await host.rpc('move.discard', { file })),
          received: async () => ((await host.rpc('db.query.move.received')) as { at: string | null }).at,
          newFile: () => path.join(moveStaging, `move-${randomBytes(8).toString('hex')}.bin`),
        },
        onView: (move) => send({ type: 'move', move }),
        log: (n, d) => log.event(n, d),
      })
    : null;
  let moveTimer: ReturnType<typeof setTimeout> | null = null;
  const moveLoop = (): void => {
    if (!pcMove) return;
    void pcMove.tick().finally(() => {
      moveTimer = setTimeout(moveLoop, pcMove.pollMs());
      moveTimer.unref?.();
    });
  };
  const stayAwake = new StayAwake(powerSaveBlocker, (on) => log.event('main.phone_stay_awake', { on }));
  const pairedPhones = () => phoneLink?.list().length ?? 0;
  const syncAwake = () => stayAwake.set(shouldStayAwake({ phones: pairedPhones(), onBattery: powerMonitor.isOnBatteryPower() }));
  let quitting = false;
  let backgroundNoted = false;
  const onBeforeQuit = (e?: { preventDefault?: () => void }) => {
    if (!quitting) log.event('main.quit', { active: runs.anyActive() });
    quitting = true;
    if (typeof e?.preventDefault !== 'function' || !updater?.ready() || !updater.installOnQuit()) return;
    e.preventDefault();
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.hide();
    setTimeout(() => app.exit(0), UPDATE_QUIT_GRACE_MS).unref();
  };
  app.on('before-quit', onBeforeQuit);
  if (process.platform === 'darwin') nativeUpdater.on('before-quit-for-update', onBeforeQuit);
  win.on('close', (e) => {
    const act = closeAction({ phones: pairedPhones(), quitting, platform: process.platform });
    if (act === 'quit') return;
    e.preventDefault();
    if (act === 'hide') win.hide();
    else win.minimize();
    log.event('main.window_background', { act });
    if (!backgroundNoted) {
      backgroundNoted = true;
      try {
        showOsNotification({ title: '소버린 AX가 계속 켜져 있어요', body: '폰에서 보낸 영수증을 바로 받으려고 창만 내렸어요. 끝내려면 메뉴 [창 > 소버린 AX 끝내기]를 누르세요.' }, () => onActivate());
      } catch {
        /* 알림을 못 띄우는 OS */
      }
    }
  });
  const onActivate = () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
  };
  app.on('activate', onActivate);
  const onPowerSource = () => syncAwake();
  powerMonitor.on('on-ac', onPowerSource);
  powerMonitor.on('on-battery', onPowerSource);
  void accountInit()
    .then(() => phones()?.start())
    .then(() => syncAwake())
    .then(() => reconcileDevices())
    .then(() => syncShare())
    .catch(() => undefined)
    .then(() => moveLoop());
  const onbView = async () => (onb && onbShow ? await onb.view() : null);
  const termsOk = () => !onb || onb.state.consents.terms?.choice === 'agreed';
  const modelOk = () => !onb || onb.modelAllowed();
  const loginRequired = !fixture;
  const signedIn = async () => {
    await accountInit().catch(() => null);
    return account.view().step === 'signed_in';
  };
  const needLogin = async () => {
    if (loginRequired && !(await signedIn())) throw new Error('account_required');
  };
  const setupGate = (parsed: Parsed) => {
    if (profile !== 'business') return null;
    if (!(parsed.intent === 'invoice' || parsed.intent === 'cert' || answersPending(parsed, runs))) return null;
    const needsChrome = !chromeReady();
    const needsSecurity = securityMissing();
    const missing: SetupItem[] = [...setupMissing(profiles().business), ...(needsChrome ? (['chrome'] as const) : []), ...(needsSecurity ? (['security'] as const) : [])];
    if (!missing.length) return null;
    runs.pending.asked = null;
    return { kind: 'setup' as const, text: setupText(parsed.intent === 'cert' ? 'cert' : 'invoice', missing), missing: missing.map((id) => ({ id, label: SETUP_LABEL[id] })) };
  };

  const bankAutoH = bankAuto.handlers;
  const pastNow = (): Promise<PastRun[]> => readPastRuns((m, p) => host.rpc(m, p), (n, d) => log.event(n, d));
  const pack = new AccountantPack({
    past: () => readPastRuns((m, p) => host.rpc(m, p), (n, d) => log.event(n, d), 200),
    docs: () => listDocs(),
    docFile,
    receivables: () => bank.receivables(),
    invoices: (kind, month) => bank.invoices(kind, month),
    otherPurchases: async (month) => {
      const r = (await bank.call('db.query.bank.report', { month, months: 1 })) as ReportResult;
      return { card: r.purchase.card, cashReceipts: r.purchase.cashReceipts };
    },
    businessName: () => (businessId ? profiles().business.name || null : null),
    businessBizNo: () => (businessId ? profiles().business.bizNo || null : null),
    paperInvoices: async (month) => {
      if (!businessId) return [];
      const [y, m] = [Number(month.slice(0, 4)), Number(month.slice(5, 7))];
      const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
      const out: Array<{ docId: string; paper: PaperInvoice; file: string | null }> = [];
      for (const mm of [month, next]) {
        const r = (await host.rpc('db.query.receipt.list', { profileId: businessId, month: mm }).catch(() => null)) as { receipts?: Array<{ docId: string; phoneOcr?: { paperInvoice?: PaperInvoice } | null }> } | null;
        for (const x of r?.receipts ?? []) {
          const paper = x.phoneOcr?.paperInvoice;
          if (!paper || out.some((o) => o.docId === x.docId)) continue;
          out.push({ docId: x.docId, paper, file: await docFile(x.docId).catch(() => null) });
        }
      }
      return out;
    },
    outRoot: packDir,
  });
  const packMonth = (m: unknown) => {
    if (!isPackMonth(m)) throw new Error('bad_request');
    return m;
  };
  const packZip = async (m: unknown) => {
    const f = pack.zipPath(packMonth(m));
    if (!(await fs.stat(f).then((x) => x.isFile(), () => false))) throw new Error('pack_missing');
    return f;
  };

  // 수정세금계산서가 끝나면 당초분 줄의 상태(취소됨, 고침, 줄임)와 수정분 줄이 바뀐다. 발급 기록을 다시 읽어 보낸다(ADR-058 결정 7).
  const amendDone = new Set<string>();
  runs.on('update', (r: RunView) => {
    if (!r.amend || r.status !== 'done' || amendDone.has(r.id)) return;
    amendDone.add(r.id);
    void pastNow().then((past) => send({ type: 'past', past }), (e: Error) => log.event('main.past_failed', { error: e.message.slice(0, 60) }));
  });
  let reverifying: Promise<void> | null = null;
  const reverify = (exclude: string | null) => {
    if (reverifying || runs.anyActive()) return;
    reverifying = (async () => {
      const read = () => readPastRuns((m, p) => host.rpc(m, p), (n, d) => log.event(n, d));
      if (!(await read()).some((p) => p.kind === 'unsure' && p.runId !== exclude)) return;
      const r = (await host.rpc('run.reverify', exclude ? { exclude } : {})) as { ok?: boolean; code?: string; checked?: number; committed?: number; unknown?: number; skipped?: number };
      log.event('main.reverify', { ok: r?.ok === true, code: r?.code ?? '', checked: r?.checked ?? 0, committed: r?.committed ?? 0, unknown: r?.unknown ?? 0, skipped: r?.skipped ?? 0 });
      if (!r?.committed) return;
      const past = await pastNow();
      for (const p of past) if (p.kind === 'issued' && p.approvalNo) runs.reverified(p.runId, p.approvalNo);
      send({ type: 'past', past });
      pushBoard();
    })()
      .catch((e: Error) => log.event('main.reverify_failed', { error: e.message.slice(0, 60) }))
      .finally(() => (reverifying = null));
  };
  // 장부 변경 알림(ADR-068 결정 5): 쓰기가 여럿 몰려도 0.5초에 한 번만 돈 화면을 다시 그리고 폰 사본을 다시 보낸다.
  // 발급이 끝난 것도 장부 변경이다(원장 줄은 다음 계산 때 받을 돈으로 옮겨진다).
  let ledgerTimer: ReturnType<typeof setTimeout> | null = null;
  const ledgerChanged = () => {
    if (ledgerTimer) return;
    ledgerTimer = setTimeout(() => {
      ledgerTimer = null;
      send({ type: 'ledger' });
      void phoneSess?.refreshCopy?.();
      void docPush.refresh();
    }, 500);
    ledgerTimer.unref?.();
  };
  host.on('ledger', ledgerChanged);
  host.on('run', (e: { type?: string; runId?: string }) => {
    if (e.type === 'end') ledgerChanged();
    if (e.type === 'end') setTimeout(() => reverify(typeof e.runId === 'string' ? e.runId : null), 3_000);
    if (e.type === 'end') setTimeout(() => void syncShare().catch(() => undefined), 15_000).unref?.();
  });

  let mirrorRun: string | null = null;

  const CHROME_BEHIND = { width: 1280, height: 900 };
  function sendBrowserState(focus = false) {
    send({ type: 'browser', shown: browserShown, available: browserAvailable, runId: mirrorRun, ...(embedded ? { embedded: true, width: panelNow() } : {}), ...(focus ? { focus: true } : {}) });
  }
  const placeBehind = async (): Promise<boolean> => {
    if (embedded) {
      browserAvailable = true;
      return true;
    }
    if (win.isDestroyed()) return false;
    const c = win.getContentBounds();
    const r = (await host.control('browser.place', { x: c.x, y: c.y, ...CHROME_BEHIND, front: false }).catch(() => null)) as { placed?: unknown } | null;
    if (r?.placed !== true) return false;
    browserAvailable = true;
    if (process.platform === 'darwin') app.focus({ steal: true });
    win.moveTop();
    win.focus();
    log.event('main.chrome_placed', { front: false, width: CHROME_BEHIND.width });
    return true;
  };
  const setPanelBig = (big: boolean, focus = false) => {
    if (browserShown === big && !focus) return;
    browserShown = big;
    sendBrowserState(focus);
    if (embedded) bar.layoutChanged();
    if (focus) eb?.focus();
  };
  const showChatView = (chat: boolean) => bar.setAway(!chat);
  const resizeBrowser = (width: number) => {
    if (!embedded || !browserAvailable) return { width: panelNow() };
    browserWant = Math.round(width);
    browserShown = false;
    sendBrowserState();
    bar.layoutChanged();
    return { width: panelNow() };
  };
  const placeBrowser = (r: { x: number; y: number; width: number; height: number } | null) => {
    if (!eb) return {};
    if (!r || !browserAvailable || win.isDestroyed()) return eb.setSlot(null), {};
    const [cw, ch] = win.getContentSize() as [number, number];
    const left = cw - panelNow();
    const x = Math.max(left, Math.round(r.x));
    const y = Math.max(SHELL.titlebar, Math.round(r.y));
    const right = Math.min(cw, Math.round(r.x + r.width));
    const bottom = Math.min(ch, Math.round(r.y + r.height));
    eb.setSlot(right - x >= 80 && bottom - y >= 80 ? { x, y, width: right - x, height: bottom - y } : null);
    return {};
  };
  win.on('resize', () => {
    if (embedded && browserAvailable) sendBrowserState();
  });
  const panelBrowserInput = async (p: Record<string, unknown>) => {
    if (!mirrorRun || embedded) return { ok: false };
    if (!panelInput.within(performance.now(), 1_000)) throw new Error('gesture_required');
    const r = (await host.control('screen.input', p).catch(() => null)) as { ok?: unknown } | null;
    return { ok: r?.ok === true };
  };
  const businessRow = async () => ((await host.rpc('db.query.profiles.list', {})) as DbProfile[]).find((x) => x.kind === 'business');
  const certNameStatus = async () => {
    const name = (await businessRow())?.certName ?? null;
    return { set: !!name, owner: name ? name.replace(/\(\)[0-9A-Za-z]*$/, '').trim().slice(0, 60) : null };
  };
  const clearCertName = async () => {
    const p = await businessRow();
    if (p?.certName) await host.rpc('profile.setCertName', { id: p.id, name: null });
    log.event('main.cert_name_cleared', { had: p?.certName ? 1 : 0 });
    return { set: false, owner: null };
  };
  const showRunBrowser = async (id: string) => {
    if (!runs.isActive(id)) throw new Error('not_running');
    setPanelBig(true, true);
    return { focused: true };
  };
  const toggleBrowser = async (show: boolean) => {
    setPanelBig(show, show);
    return { shown: show };
  };
  let followTimer: NodeJS.Timeout | null = null;
  const follow = () => {
    if (!browserAvailable || !mirrorRun || embedded) return;
    if (followTimer) clearTimeout(followTimer);
    followTimer = setTimeout(() => {
      followTimer = null;
      void placeBehind();
    }, 120);
  };
  win.on('move', follow);
  win.on('resize', follow);
  const mirrorTick = setInterval(() => {
    if (embedded) return;
    const r = mirrorRun ? runs.get(mirrorRun) : undefined;
    if (r && runs.isActive(r.id) && r.status !== 'draft') void host.control('screen.start').catch(() => {});
  }, 1_000);
  mirrorTick.unref();
  runs.on('update', (r: RunView) => {
    const live = (runs.isActive(r.id) && r.status !== 'draft') || (r.starting === true && !runs.activeRun());
    if (live && mirrorRun !== r.id) {
      mirrorRun = r.id;
      browserAvailable = true;
      sendBrowserState();
      if (embedded) bar.layoutChanged();
      else void host.control('screen.start').catch(() => {});
    } else if (!live && mirrorRun === r.id) {
      mirrorRun = null;
      browserAvailable = false;
      browserShown = false;
      sendBrowserState();
      send({ type: 'screen', runId: r.id, ended: true });
      if (embedded) {
        eb?.setSlot(null);
        bar.layoutChanged();
      } else void host.control('screen.stop').catch(() => {});
    }
  });
  const chromeSpot = new Map<string, string>();
  runs.on('update', (r: RunView) => {
    if (!runs.isActive(r.id) || r.status === 'draft') {
      chromeSpot.delete(r.id);
      return;
    }
    const turn = r.status === 'turn' ? `turn:${r.handoff?.phase ?? ''}` : r.status === 'issuing' && !r.cert && r.steps[5]?.state === 'now' ? 'sign' : null;
    const want = turn ?? 'back';
    if (chromeSpot.get(r.id) === want) return;
    if (want === 'back' && chromeSpot.has(r.id)) {
      if (chromeSpot.get(r.id) !== 'back') chromeSpot.set(r.id, 'away');
      return;
    }
    chromeSpot.set(r.id, want);
    if (turn) {
      setPanelBig(true, true);
      return;
    }
    void (async () => {
      for (let i = 0; i < 40 && chromeSpot.get(r.id) === 'back' && runs.isActive(r.id); i++) {
        if (await placeBehind()) return;
        await new Promise((res) => setTimeout(res, 500));
      }
    })();
  });

  const CERT_SLOT = { kind: 'cert_password', scope: 'business' } as const;
  const certMemory = {
    has: async () => (await host.control('secret.has', CERT_SLOT).catch(() => false)) === true,
    forget: async (why: string) => {
      const r = await host.control('secret.forget', CERT_SLOT).catch(() => false);
      log.event('main.cert_memory_forget', { why, removed: r === true });
    },
  };
  host.on('run', (e: { type?: string; code?: string }) => {
    if ((e.type === 'handoff' || e.type === 'end') && (e.code === 'sign.password_wrong' || e.code === 'sign.password_retry_limit')) void certMemory.forget(e.code);
  });
  reportSync = new ReportSync({
    ready: () => host.ready,
    rpc: (m, p) => host.rpc(m, p),
    control: (m, p) => host.control(m, p),
    onRun: (cb) => {
      host.on('run', cb);
      return () => host.removeListener('run', cb);
    },
    profileId: async () => ((await host.rpc('db.query.profiles.list')) as DbProfile[]).find((p) => p.kind === 'business')?.id ?? null,
    // 미리 로그인과 같은 조건: 공동인증서 비밀번호를 기억하고 있고 홈택스에 들어갈 준비가 됐을 때만(간편인증은 폰 승인이 있어야 한다)
    canLogin: async () => !fixture && profile === 'business' && profiles().business.auth === SIGN_LABEL.cert && setupMissing(profiles().business).length === 0 && chromeReady() && !securityMissing() && (await certMemory.has()),
    busy: () => runs.anyActive() || !!warming || !!reverifying || screenLocked,
    log: (n, d) => log.event(n, d ?? {}),
  });
  if (screenOpenedEarly) void reportSync.screenOpened();
  const handlers: ShellHandlers = {
    'bankAuto.status': () => bankAutoH['bankAuto.status'](),
    'bankAuto.certs': () => bankAutoH['bankAuto.certs'](),
    'bankAuto.consent': (p) => {
      needGesture(3_000);
      return bankAutoH['bankAuto.consent'](p);
    },
    'bankAuto.connect': async (p) => {
      needGesture(3_000);
      await needLogin();
      return bankAutoH['bankAuto.connect'](p);
    },
    'bankAuto.choose': (p) => {
      needGesture(3_000);
      return bankAutoH['bankAuto.choose'](p);
    },
    'bankAuto.sms': (p) => {
      needGesture(3_000);
      return bankAutoH['bankAuto.sms'](p);
    },
    'bankAuto.refresh': async () => {
      needGesture(3_000);
      await needLogin();
      return bankAutoH['bankAuto.refresh']();
    },
    'bankAuto.cancel': () => bankAutoH['bankAuto.cancel'](),
    'bankAuto.disconnect': () => {
      needGesture(3_000);
      return bankAutoH['bankAuto.disconnect']();
    },
    'shell.bootstrap': async () => (setTimeout(() => void restoreRuns(), 1_000).unref(), {
      board: await bootBoard(),
      layout: SHELL,
      profiles: profiles(),
      profile,
      counterparties: cps,
      docs: await listDocs(),
      timeline: [],
      quick: QUICK.filter((q) => q.label === '세금계산서 발급' || q.cert || q.soon),
      platform: process.platform,
      loginRequired,
      build: opts.buildBadges ?? [],
      update: updater?.ready() === true,
      past: await pastNow(),
      onboarding: await onbView(),
      profileEdits: editLog.list(),
      authReopen: !!onb,
    }),
    'profile.set': (p) => {
      if (p.kind !== 'business' && p.kind !== 'personal') throw new Error('bad_profile');
      profile = p.kind;
      return { profile };
    },
    'request.send': async (p) => {
      sendByUser = gesture.within(performance.now(), 2_000);
      const vat = p.vat === 'separate' || p.vat === 'included' ? (p.vat as Vat) : null;
      if (!termsOk()) throw new Error('onboarding_terms');
      await needLogin();
      const text = String(p.text ?? '').slice(0, 2000);
      const t0 = performance.now();
      const local = parseRegex(text, runs.counterparties);
      if (profile === 'business' && local.cert) return setupGate(local) ?? finishReply(interpret(text, vat, profile, runs, local), 'offline', null, []);
      const packFor = profile === 'business' ? packAsk(text, kstToday(Date.now())) : null;
      if (packFor) return { kind: 'pack', pack: await pack.make(packFor), via: 'l0', note: null, sent: [] };
      const g24Ask = local.intent === 'resident_copy' || local.intent === 'resident_abstract';
      if (profile === 'business' && (!fixture || opts.agent) && !g24Ask) {
        if (!text.trim()) return { kind: 'say', text: EMPTY_REQUEST_TEXT, via: 'model', note: null, sent: [] };
        if (!modelOk()) return { kind: 'say', text: MODEL_CONSENT_FIRST_TEXT, via: 'model', note: null, sent: [] };
        const mark = gwSeq;
        agentCreated = [];
        const r = await agent.turn(text);
        const sent = sentFromGateway(gwIssuedSince(mark));
        for (const run of agentCreated) {
          run.interp = 'model';
          run.sent = sent;
        }
        if (agentCreated.length) pushBoard();
        const batched = runs.makeBatch(agentCreated.map((x) => x.id));
        if (sendByUser) for (const run of batched ? agentCreated.filter((x) => x.batch?.index === 0) : agentCreated) autoPrepare(run.id);
        log.event('main.agent', r.kind === 'agent' ? { result: 'ok', filtered: r.filtered ?? 'none', show: r.show.length, ask: r.ask?.kind ?? 'none', ms: Math.round(performance.now() - t0) } : r.kind === 'reaction' ? { result: 'reaction', reaction: r.reaction, ms: Math.round(performance.now() - t0) } : { result: r.code, ms: Math.round(performance.now() - t0) });
        if (r.kind === 'unavailable') return { kind: 'unavailable', text: r.text, retry: r.retry, via: 'model', note: null, sent };
        if (r.kind === 'reaction') return { kind: 'reaction', reaction: r.reaction, via: 'model', note: null, sent };
        type Shown = { type: 'card'; run: RunView } | Extract<(typeof r.show)[number], { type: 'table' }>;
        const show = r.show.flatMap((x): Shown[] => {
          if (x.type !== 'card') return [x];
          const run = runs.get(x.runId);
          return run ? [{ type: 'card', run }] : [];
        });
        const missing: SetupItem[] = r.setup ? [...setupMissing(profiles().business), ...(chromeReady() ? [] : (['chrome'] as const)), ...(securityMissing() ? (['security'] as const) : [])] : [];
        return { kind: 'agent', text: r.text, show, ask: r.ask, filtered: r.filtered, setup: missing.map((id) => ({ id, label: SETUP_LABEL[id] })), unknown: r.unknown ?? null, via: 'model', note: null, sent };
      }
      if (fixture && !opts.intent) return setupGate(local) ?? finishReply(interpret(text, vat, profile, runs, local), 'offline', null, []);
      if (!text.trim()) return { kind: 'say', text: EMPTY_REQUEST_TEXT, via: 'model', note: null, sent: [] };
      if (!modelOk()) return { kind: 'say', text: MODEL_CONSENT_FIRST_TEXT, via: 'model', note: null, sent: [] };
      const mark = gwSeq;
      const r = await intent.resolve(text);
      log.event('main.interpret', { path: r.route ? `engine.${r.route.via}` : `unavailable.${r.fallback ?? 'none'}`, outcome: r.route?.outcome ?? 'unavailable', ms: Math.round(performance.now() - t0) });
      if (!r.route) return { kind: 'unavailable', text: INTENT_UNAVAILABLE_TEXT, retry: true, via: 'model', note: null, sent: sentFromGateway(gwIssuedSince(mark)) };
      const via = 'model';
      if (r.route.outcome === 'unknown' && !answersPending(local, runs, text)) {
        const c = await chatReply.respond(text);
        const sent = sentFromGateway(gwIssuedSince(mark));
        log.event('main.chat', 'reply' in c ? { result: 'ok', kind: c.reply.kind, filtered: c.reply.filtered ?? 'none', suggest: c.reply.suggest.length } : { result: c.error });
        if ('error' in c) return { kind: 'unavailable', ...CHAT_ERROR_TEXT[c.error], via, note: null, sent };
        runs.pending.asked = null;
        return { kind: 'chat', text: c.reply.reply, suggest: suggestChips(c.reply.suggest), filtered: c.reply.filtered, via, note: null, sent };
      }
      const sent = sentFromGateway(gwIssuedSince(mark));
      const to = routed(r.route, local);
      if ('say' in to) {
        runs.pending.asked = null;
        return { kind: 'say', text: to.say, via, note: null, sent };
      }
      const gate = setupGate(to.parsed);
      if (gate) return { ...gate, via, note: to.note, sent };
      return finishReply(interpret(text, vat, profile, runs, to.parsed), via, to.note, sent);
    },
    'run.redraft': (p) => {
      const d = runs.redraft(String(p.id));
      pushBoard();
      return d;
    },
    'draft.update': (p) =>
      runs.updateDraft(String(p.id), {
        vat: p.vat === 'separate' || p.vat === 'included' ? p.vat : undefined,
        amount: typeof p.amount === 'number' ? p.amount : undefined,
        amountText: typeof p.amountText === 'string' ? p.amountText.slice(0, 100) : undefined,
        item: typeof p.item === 'string' ? p.item : undefined,
        email: typeof p.email === 'string' ? p.email : undefined,
        counterpartyId: typeof p.counterpartyId === 'string' ? p.counterpartyId : undefined,
      }),
    'amend.preview': (p) => {
      const raw = String(p.value ?? '').trim();
      const v = /^[\d,]+$/.test(raw) ? Number(raw.replace(/,/g, '')) : parseAmount(raw);
      if (v === null || !Number.isSafeInteger(v)) return null;
      return runs.previewAmend(String(p.id), { field: p.field as 'supply' | 'tax' | 'total', value: v });
    },
    'amend.update': (p) => {
      const id = String(p.id);
      if (typeof p.pick === 'number') return runs.updateAmend(id, { pick: p.pick });
      if (typeof p.what === 'string') return runs.updateAmend(id, { what: p.what });
      if (p.repick === true) return runs.updateAmend(id, { repick: true });
      if (typeof p.field !== 'string') throw new Error('bad_params');
      const raw = String(p.value ?? '').trim();
      if (p.field === 'supply' || p.field === 'tax' || p.field === 'total') {
        const v = /^[\d,]+$/.test(raw) ? Number(raw.replace(/,/g, '')) : parseAmount(raw);
        if (v === null || !Number.isSafeInteger(v)) throw new Error('bad_amount');
        return runs.updateAmend(id, { field: p.field, value: v });
      }
      return runs.updateAmend(id, { field: p.field as 'issueDate' | 'counterpartBizNo' | 'item', value: raw });
    },
    'run.prepare': async (p) => {
      needGesture(2_000);
      const id = String(p.id);
      if (queueIfBusy(id)) return runs.get(id);
      return prepareNow(id);
    },
    'run.stop': (p) => runs.stop(String(p.id)),
    'run.resendMail': (p) => {
      needGesture(3_000);
      return resendInvoiceMail(String(p.id));
    },
    'run.retryCert': (p) => {
      needGesture(3_000);
      return runs.retryCert(String(p.id));
    },
    'run.simpleDone': (p) => {
      needGesture(3_000);
      return runs.simpleAuth(String(p.id), 'complete');
    },
    'run.resume': (p) => {
      needGesture(3_000);
      return runs.resume(String(p.id));
    },
    'run.manualDone': (p) => {
      needGesture(3_000);
      return runs.manualDone(String(p.id));
    },
    'run.showBrowser': async (p) => {
      needGesture(3_000);
      return showRunBrowser(String(p.id));
    },
    'browser.toggle': async (p) => {
      needGesture(3_000);
      return toggleBrowser(p.show === true);
    },
    'browser.input': (p) => panelBrowserInput(p as Record<string, unknown>),
    'browser.slot': (p) => placeBrowser(p.none === true ? null : { x: Number(p.x), y: Number(p.y), width: Number(p.width), height: Number(p.height) }),
    'browser.resize': (p) => resizeBrowser(Number(p.width)),
    'shell.view': (p) => (showChatView(p.chat === true), {}),
    'incident.open': (p) => {
      needGesture(3_000);
      return incidents.open(String(p.id));
    },
    'incident.close': (p) => incidents.close(String(p.id)),
    'bulk.read': async (p) => {
      const today = kstToday(Date.now());
      let r: BulkRead;
      if (typeof p.data === 'string') {
        const mapping = typeof p.mapping === 'string' ? mappingFrom(p.mapping) : null;
        if (typeof p.mapping === 'string' && !mapping) throw new Error('bad_request');
        r = await readBulkFile(p.data, { readSheet: readSheetInSandbox, today: () => today }, mapping);
      } else if (typeof p.text === 'string') r = readBulkText(p.text, today);
      else throw new Error('bad_request');
      if (r.kind === 'rows') r.status = await bizStatus(statusTargets(r.rows, cps));
      log.event('bulk.read', { source: typeof p.data === 'string' ? 'file' : 'text', kind: r.kind, rows: r.kind === 'rows' ? r.rows.length : 0, reason: r.kind === 'none' ? r.reason : undefined, mapped: typeof p.mapping === 'string' ? 'yes' : undefined, closed: r.kind === 'rows' ? Object.keys(r.status ?? {}).length : undefined });
      return r;
    },
    'bulk.template': async () => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      const dir = opts.downloadsDir ?? app.getPath('downloads');
      const stem = TEMPLATE_NAME.replace(/\.xlsx$/, '');
      let file = path.join(dir, TEMPLATE_NAME);
      for (let i = 2; i < 100; i++) {
        try {
          await fs.writeFile(file, await bulkTemplate(), { flag: 'wx' });
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw new Error('save_failed', { cause: e });
          file = path.join(dir, `${stem} (${i}).xlsx`);
        }
      }
      log.event('bulk.template', {});
      if (!opts.downloadsDir) desktop.showItemInFolder(file);
      return { name: path.basename(file) };
    },
    'bulk.issue': async (p) => {
      needGesture(3_000);
      if (!termsOk()) throw new Error('onboarding_terms');
      await needLogin();
      const today = kstToday(Date.now());
      const parsed = issueRowsFrom(String(p.rows ?? ''), today);
      if (!parsed.ok) {
        log.event('bulk.issue_refused', { code: parsed.code });
        throw new Error(parsed.code);
      }
      const rows = parsed.rows;
      const status = await bizStatus(rows.map((r) => r.bizNo));
      const blocked = rows.filter((r) => status[r.bizNo] === '03' || status[r.bizNo] === '');
      if (blocked.length) {
        log.event('bulk.issue_status', { blocked: blocked.length });
        return { kind: 'status', status };
      }
      const route = bulkRoute(rows, today);
      log.event('bulk.issue', { route, rows: rows.length });
      if (route === 'sheet') return startBulkSheet(rows);
      const made: Array<{ key: string; runId: string }> = [];
      for (const row of rows) {
        const cp = await bulkCounterparty(row);
        const d = runs.createDraft(cp, row.supply, 'separate', row.item, { writeDate: row.date });
        made.push({ key: row.key, runId: d.id });
      }
      pushBoard();
      const batched = runs.makeBatch(made.map((m) => m.runId));
      const first = batched ? runs.batchRuns(batched)[0] : runs.get(made[0]!.runId);
      if (!batched && first) runs.emit('update', first);
      if (first) autoPrepare(first.id);
      return { kind: 'started', route, runs: made, batchId: batched };
    },
    'docs.list': () => listDocs(),
    'issued.list': () => pastNow(),
    'pack.make': (p) => pack.make(packMonth(p.month)),
    'pack.reveal': async (p) => {
      needGesture(3_000);
      desktop.showItemInFolder(await packZip(p.month));
      return {};
    },
    'pack.share': async (p) => {
      needGesture(3_000);
      const file = await packZip(p.month);
      if (process.platform !== 'darwin') {
        desktop.showItemInFolder(file);
        return { via: 'folder' };
      }
      new ShareMenu({ filePaths: [file] }).popup({ window: win });
      return { via: 'share' };
    },
    'docs.import': docsCall(async (p) => {
      if (p.pick !== true && typeof p.pickId !== 'string') throw new Error('bad_request');
      if (typeof p.pickId !== 'string') needGesture(3_000);
      if (importing) throw new Error('busy');
      importing = true;
      try {
        const r = await docs.importPdf({ pickId: p.pickId, password: p.password });
        if (r?.status === 'imported') void docPush.refresh();
        return r;
      } finally {
        importing = false;
      }
    }),
    'docs.importCancel': (p) => {
      cancelPick(p.pickId);
      return {};
    },
    'docs.update': docsCall(async (p) => {
      const patch = (p.patch ?? {}) as Record<string, unknown>;
      const seen = (p.seen ?? {}) as Record<string, unknown>;
      const d = await docs.update(String(p.id), { docType: patch.docType, issuedOn: patch.issuedOn, expiresOn: patch.expiresOn }, { docType: seen.docType, issuedOn: seen.issuedOn, expiresOn: seen.expiresOn });
      void docPush.refresh();
      return d;
    }),
    'docs.open': docsCall(async (p) => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      const file = await docFile(String(p.id));
      if (path.extname(file).toLowerCase() !== '.pdf') throw new Error('open_failed');
      if (await desktop.openPath(file)) throw new Error('open_failed');
      return {};
    }),
    'docs.reveal': docsCall(async (p) => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      desktop.showItemInFolder(await docFile(String(p.id)));
      return {};
    }),
    'counterparty.save': async (p) => {
      const saved = await cpBook.save(p);
      if (fixture) delete fixture.itemHints[saved.bizNo];
      try {
        await cpBook.setFirstItem(saved.id, p.item);
      } finally {
        await refresh();
      }
      return { id: saved.id, counterparties: cps };
    },
    'counterparty.readCert': () => {
      needGesture(3_000);
      return cpBook.readCert();
    },
    'counterparties.list': async () => {
      await refresh();
      return cps;
    },
    'profiles.list': async () => {
      await refresh();
      return profiles();
    },
    'g24.candidates': () => [],
    'g24.save': (p) => store.g24Save(String(p.id), g24Doc(p.doc)),
    'account.view': async () => {
      await accountInit();
      return account.view();
    },
    'account.sendCode': async (p) => {
      needGesture(3_000);
      await accountInit();
      return account.sendCode(String(p.email));
    },
    'account.verify': async (p) => {
      needTyping(3_000);
      await accountInit();
      return watchLink(await account.verify(String(p.code)));
    },
    'account.back': async () => {
      await accountInit();
      return account.back();
    },
    'account.signOut': async () => {
      needGesture(3_000);
      await accountInit();
      if (runs.anyActive()) throw new Error('run_active');
      pairReset();
      phoneLink?.stop();
      phoneLink = null;
      syncAwake();
      const v = watchLink(await account.signOut());
      pushBoard();
      return v;
    },
    'billing.view': async () => billingCall((c, a) => c.billing(a)),
    'chat.usage': async () => chatUsage(),
    'billing.subscribe': async () => {
      needGesture(3_000);
      const { checkoutUrl } = await billingCall<{ checkoutUrl: string }>((c, a) => c.billingCheckout(a));
      await (opts.billingOpen ?? openBillingCheckout)(checkoutUrl, opts.remote?.cloud?.accountOrigin ?? CLOUD_ORIGIN);
      log.event('main.billing_checkout_opened');
      return {};
    },
    'billing.cancel': async () => {
      needGesture(3_000);
      await billingCall((c, a) => c.billingCancel(a));
      log.event('main.billing_canceled');
      return billingCall((c, a) => c.billing(a));
    },
    'billing.refund': async () => {
      needGesture(3_000);
      const r = await billingCall<{ amountKrw: number }>((c, a) => c.billingRefund(a));
      log.event('main.billing_refunded');
      return { ...(await billingCall<BillingView>((c, a) => c.billing(a))), refundedKrw: r.amountKrw };
    },
    'account.deletion': async () => {
      await accountInit();
      const d = account.device();
      if (!d) throw new Error('account_signed_out');
      return d.deletion();
    },
    'account.delete': async () => {
      needGesture(3_000);
      await accountInit();
      const d = account.device();
      if (!d) throw new Error('account_signed_out');
      const r = await d.requestDelete();
      log.event('main.account_delete_request', { result: 'ok' });
      return r;
    },
    'account.deleteCancel': async () => {
      needGesture(3_000);
      await accountInit();
      const d = account.device();
      if (!d) throw new Error('account_signed_out');
      await d.cancelDelete();
      log.event('main.account_delete_cancel', { result: 'ok' });
      return { deleteAfter: null };
    },
    'pair.open': async () => {
      needGesture(3_000);
      await accountInit();
      await reconcileDevices();
      return pairing().start();
    },
    'pair.view': async () => pairHost?.view() ?? { step: 'idle', qr: null, expiresAt: null, phoneName: null, triesLeft: null, error: null },
    'pair.submit': async (p) => {
      needTyping(3_000);
      return pairing().submitSas(String(p.code).slice(0, 6));
    },
    'pair.retry': async () => {
      needGesture(3_000);
      await accountInit();
      await reconcileDevices();
      const h = pairing();
      h.cancel();
      return h.start();
    },
    'pair.cancel': async () => pairHost?.dismiss() ?? { step: 'idle', qr: null, expiresAt: null, phoneName: null, triesLeft: null, error: null },
    'lock.view': async () => {
      await lockReady;
      return lockHost.view();
    },
    'lock.openLocal': async () => {
      needGesture(2_000);
      await lockHost.openLocal();
      return lockHost.view();
    },
    'lock.askPhone': async () => {
      needGesture(2_000);
      await lockHost.askPhone();
      return lockHost.view();
    },
    'lock.step': async (p) => {
      lockHost.setStep(p.step);
      return lockHost.view();
    },
    'lock.emailStart': async () => {
      needGesture(3_000);
      await lockHost.startEmail();
      return lockHost.view();
    },
    'lock.emailCode': async (p) => {
      needGesture(3_000);
      await lockHost.finishEmail(p.code);
      return lockHost.view();
    },
    'lock.recoveryEnter': async () => {
      needGesture(3_000);
      await lockHost.enterRecovery();
      return lockHost.view();
    },
    'lock.now': async () => {
      try {
        needGesture(3_000);
      } catch (e) {
        log.event('main.lock_now', { result: 'gesture_required' });
        throw e;
      }
      await lockHost.lockNow();
      const v = lockHost.view();
      log.event('main.lock_now', { result: v.locked ? 'locked' : lockHost.open ? 'not_guarded' : 'closed' });
      return v;
    },
    'lock.settings': async () => {
      await lockHost.refresh();
      return lockHost.settingsView();
    },
    'lock.setLocal': async (p) => {
      needGesture(3_000);
      await lockHost.setLocal(p.on);
      return lockHost.settingsView();
    },
    'lock.setPhone': async (p) => {
      needGesture(3_000);
      const ph = phoneLink?.list().find((x) => x.pairId === p.pairId);
      if (!ph) throw new Error('not_found');
      await phoneLink!.setUxOff(p.pairId, !p.on);
      if (!p.on) await lockHost.removePhone(ph.deviceId);
      return lockHost.settingsView();
    },
    'lock.setEmail': async (p) => {
      needGesture(3_000);
      await lockHost.setEmail(p.on);
      return lockHost.settingsView();
    },
    'lock.recoveryMake': async () => {
      needGesture(3_000);
      await lockHost.makeRecovery();
      return lockHost.settingsView();
    },
    'devices.list': async () => {
      await accountInit();
      return { devices: withApproval(await devicesOf().list()) };
    },
    'devices.px': async (p) => {
      needGesture(3_000);
      await accountInit();
      const id = String(p.deviceId);
      const pairs = (phoneLink?.list() ?? []).filter((x) => x.deviceId === id);
      if (!pairs.length) throw new Error('device.not_phone');
      for (const x of pairs) await (p.on === true ? phoneLink!.allowPx(x.pairId) : phoneLink!.revokePx(x.pairId));
      return { devices: withApproval(await devicesOf().list()) };
    },
    'devices.unlink': async (p) => {
      needGesture(3_000);
      await accountInit();
      const devices = await devicesOf().unlink(String(p.deviceId));
      send({ type: 'account', account: account.view() });
      syncAwake();
      void phoneLink?.pushShareKeys();
      return { devices };
    },
    'devices.leave': async () => {
      needGesture(3_000);
      await accountInit();
      if (runs.anyActive()) throw new Error('run_active');
      await devicesOf().leave();
      pairReset();
      phoneLink?.stop();
      phoneLink = null;
      deviceMgr = null;
      pcLinkHost = null;
      syncAwake();
      const v = watchLink(await account.signOut());
      pushBoard();
      return v;
    },
    'account.linkAccept': async () => {
      needGesture(3_000);
      await accountInit();
      const v = watchLink(await account.linkAccept());
      if (v.step === 'signed_in') pushBoard();
      return v;
    },
    'account.linkCancel': async () => {
      needGesture(3_000);
      await accountInit();
      return watchLink(await account.linkCancel());
    },
    'pclink.list': async () => {
      await accountInit();
      return { requests: await pcLinkHostOf().list() };
    },
    'pclink.begin': async (p) => {
      needGesture(3_000);
      await accountInit();
      return { requests: await pcLinkHostOf().begin(String(p.deviceId)) };
    },
    'pclink.confirm': async (p) => {
      needGesture(3_000);
      await accountInit();
      const r = await pcLinkHostOf().confirm(String(p.deviceId), String(p.code));
      if (r.ok) send({ type: 'account', account: account.view() });
      return r;
    },
    'pclink.reject': async (p) => {
      needGesture(3_000);
      await accountInit();
      return { requests: await pcLinkHostOf().reject(String(p.deviceId)) };
    },
    'onboarding.reply': async (p) => {
      needGesture(3_000);
      if (!onb) throw new Error('onboarding_done');
      if (p.step !== 'terms') await needLogin();
      const r = await onb.answer({ step: p.step, choice: p.choice, fields: p.fields, certId: p.certId, tasks: p.tasks } as Parameters<OnboardingFlow['answer']>[0]);
      if (onb.done) pushBoard();
      return { onboarding: await onbView(), fill: r.fill ?? null, profiles: profiles() };
    },
    'certMemory.status': async () => ({ remembered: await certMemory.has() }),
    'certName.status': () => certNameStatus(),
    'certName.clear': async () => {
      needGesture(3_000);
      return clearCertName();
    },
    'certMemory.forget': async () => {
      needGesture(3_000);
      await certMemory.forget('user');
      return { remembered: await certMemory.has() };
    },
    'certMemory.save': async (p) => {
      needGesture(3_000);
      return saveCertMemory((p as { value?: unknown }).value);
    },
    'secret.answer': (p) => {
      needGesture(3_000);
      return answerSecret(p as { reqId?: unknown; value?: unknown; cancel?: unknown });
    },
    'security.check': async () => {
      const st = securityNow();
      pushBoard();
      return st;
    },
    'security.install': async () => {
      needGesture(3_000);
      const st = securityNow();
      if (!st.installKey) throw new Error('no_installer');
      await (opts.security?.install ?? openExternalKey)(st.installKey);
      log.event('main.security_install_open', { platform: process.platform === 'darwin' ? 1 : 0 });
      return { opened: true };
    },
    'legal.open': async (p) => {
      needGesture(3_000);
      await openExternalKey(p.doc === 'privacy' ? 'legal.privacy' : 'legal.terms');
      return { opened: true };
    },
    'security.start': async () => {
      needGesture(3_000);
      const ok = opts.security?.start ? opts.security.start() : startSecurityProgram();
      for (let i = 0; i < 20 && ok && securityBlocks(securityNow()); i++) await new Promise((r) => setTimeout(r, 250));
      const st = securityNow();
      pushBoard();
      return st;
    },
    'chrome.check': async () => {
      const ready = chromeReady();
      pushBoard();
      return { ready };
    },
    'onboarding.reopen': async (p) => {
      needGesture(3_000);
      await needLogin();
      if (!onb) throw new Error('onboarding_unavailable');
      await onb.reopen(p.item as 'biz' | 'auth');
      onbShow = true;
      pushBoard();
      return { onboarding: await onbView(), profiles: profiles() };
    },
    'profile.edit': async (p) => {
      needGesture(3_000);
      await needLogin();
      if (onb && !onb.done) throw new Error('onboarding_open');
      const r = await editor.save((p.fields ?? {}) as Record<string, unknown>, p.confirmUnverified === true);
      return { ...r, profiles: profiles(), edits: editLog.list() };
    },
    ...bankShellHandlers(bank, () => pushBoard()),
    'bank.pickStatement': () => {
      needGesture(3_000);
      return bank.pickStatement();
    },
    'bank.refresh': (p) => {
      needGesture(3_000);
      return bank.call('bank.refresh', { accountId: p.accountId });
    },
    // 월 리포트 PDF(ADR-068 결정 11). 화면을 찍지 않고 같은 리포트 값으로 그려 다운로드 폴더에 둔다
    'bank.reportPdf': async (p) => {
      needGesture(3_000);
      if (!openRate.take(performance.now())) throw new Error('throttled');
      const r = (await bank.call('db.query.bank.report', { month: p.month, months: p.months })) as ReportResult;
      const b = profiles().business;
      const md = (iso: string | null) => (iso ? `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일까지` : null);
      const doc = reportDoc(r, { name: b.name, bizNo: b.bizNo ?? null, bankTo: r.bank.hasAccounts ? md(r.through.bank) : null, hometaxTo: md(r.through.hometax) }, Date.now());
      const html = await reportPdfHtml(doc, STATIC);
      reportSaved = await saveReportPdf(opts.downloadsDir ?? app.getPath('downloads'), reportFileName(r.month, r.months), html, htmlToPdf);
      log.event('bank.report_pdf', { months: r.months });
      return { name: path.basename(reportSaved) };
    },
    // 리포트 [최신화]: 사람이 눌러 지금 받는다. 끝나면 장부 알림으로 화면이 다시 읽는다
    'bank.reportSync': async () => {
      needGesture(3_000);
      return { result: await reportSync!.start('human') };
    },
    'bank.reportFile': async (p) => {
      needGesture(3_000);
      if (!reportSaved) throw new Error('not_found');
      const file = reportSaved;
      if (!(await fs.access(file).then(() => true, () => false))) throw new Error('not_found');
      if (p.how === 'reveal') desktop.showItemInFolder(file);
      else if (await desktop.openPath(file)) throw new Error('open_failed');
      return {};
    },
    'bank.pickInvoices': async () => {
      needGesture(3_000);
      const r = await bank.pickInvoices();
      pushBoard();
      return r;
    },
    'profile.readCert': async () => {
      needGesture(3_000);
      await needLogin();
      if (readingCert) throw new Error('busy');
      readingCert = true;
      try {
        const f = await readOwnCert();
        if (f === null) return { found: false, reason: 'cancelled' };
        if (f === 'unreadable') return { found: false, reason: 'unreadable' };
        return { found: true, fields: f };
      } finally {
        readingCert = false;
      }
    },
    'move.view': () => pcMove?.view() ?? { step: 'none' },
    'update.view': () => ({ ready: updater?.ready() === true, waits: updater?.installWaits() === true }),
    'update.install': () => {
      needGesture(3_000);
      return { result: updater?.requestInstall() ?? 'none' };
    },
    'clipboard.copy': (p) => {
      clipboard.writeText(String(p.text ?? '').slice(0, 200));
      return {};
    },
  };

  ipcMain.handle('sax', async (e, req: { method?: unknown; params?: unknown }) => {
    if (e.sender !== wc || e.senderFrame?.url !== SHELL_URL) throw new Error('forbidden');
    return dispatchShell(e.senderFrame, SHELL_URL, handlers, req);
  });

  const startAppUpdater = async (w: UpdateWiring): Promise<UpdateHost | null> => {
    try {
      const { electronInstaller } = await import('./update-electron.ts');
      const { egressUpdateSources } = await import('./update-sources.ts');
      const eu = (await import('electron-updater')).default;
      const u = w.updater ?? (eu.autoUpdater as unknown as AppUpdaterLike);
      const trust = w.trust ?? ((await host.rpc('db.query.registry.pins', {})) as TrustRoot);
      const revocation = async (): Promise<Revocation> => {
        const r = (await host.rpc('db.query.registry.revocation', {})) as { keyIds?: unknown; fresh?: unknown } | null;
        return { keyIds: new Set(Array.isArray(r?.keyIds) ? r.keyIds.filter((k): k is string => typeof k === 'string') : []), fresh: r?.fresh === true };
      };
      const h = startUpdateHost({
        sources: egressUpdateSources({ egress: w.egress, trust, revocation }),
        installer: electronInstaller(u, { origin: w.origin, channel: w.channel, Provider: eu.Provider as unknown as ProviderBase, loopback: w.loopback, relaunch: w.relaunch }),
        channel: w.channel,
        installedVersion: app.getVersion(),
        stateFile: path.join(appPaths(root ?? defaultAppRoot()).userData, 'updater-state.json'),
        policy: updatePolicy({ testBuild: w.testBuild, setting: w.setting, log: (n, d) => log.event(n, d) }),
        idle: () => {
          const list = runs.list();
          return {
            runActive: list.some((r) => runs.isActive(r.id)),
            commitZone: bar.visible || list.some((r) => r.status === 'issuing' || r.inDoubt === true),
            daemonRunning: false,
          };
        },
        onStale: () => {
          try {
            showOsNotification({ title: '소버린 AX', body: '14일 동안 업데이트를 확인하지 못했어요. 인터넷 연결을 확인해 주세요.' }, () => {});
          } catch {
            // 알림을 못 띄우는 환경이면 로그(main.update_stale_notice)만 남는다
          }
        },
        onReady: () => send({ type: 'update', ready: true }),
        away: () => !win.isDestroyed() && !win.isFocused() && (screenLocked || powerMonitor.getSystemIdleTime() >= UPDATE_AWAY_SEC),
        log: (n, d) => log.event(n, d),
      });
      void registrySync('update').finally(() => void h.check());
      return h;
    } catch (e) {
      log.event('main.update_start_failed', { error: (e as Error).message.slice(0, 80) });
      return null;
    }
  };
  const reportIdle = () => void host.control('session.idle', { idleSec: powerMonitor.getSystemIdleTime() }).catch(() => {});
  const idleTimer = setInterval(reportIdle, SESSION_IDLE_REPORT_MS);
  idleTimer.unref();
  const SESSION_KINDS = ['lock-screen', 'unlock-screen', 'suspend', 'resume'] as const;
  const onSession = SESSION_KINDS.map((kind) => {
    const fn = () => {
      void host.control('session.event', { kind }).catch(() => {});
      if (kind === 'lock-screen') screenLocked = true;
      else if (kind === 'unlock-screen') screenLocked = false;
      if (kind === 'unlock-screen' || kind === 'resume') reportIdle();
      if (kind === 'resume') phoneLink?.wake('resume');
      else if (kind === 'unlock-screen') phoneLink?.wake('unlock');
      if (kind === 'unlock-screen') setTimeout(() => void keepHometax('unlock'), 20_000).unref();
      if (kind === 'resume') {
        runs.woke();
        if (fixture || opts.daemon === false) void keepHometax('resume');
      }
    };
    powerMonitor.on(kind as 'resume', fn);
    return { kind, fn };
  });
  const ready = (async () => {
    try {
      await host.ready;
      reportIdle();
    } catch (e) {
      const text = fatalText((e as Error).message);
      if (text) dialog.showErrorBox('소버린 AX', text);
      throw e;
    }
    if (fixture) await fixture.seed(host);
    markLock(lockHost.refresh().then(() => undefined, () => log.event('main.lock_state_failed')));
    void accountInit()
      .catch(() => null)
      .then(() => {
        const dev = account.device();
        return dev ? lockHost.identity(dev.deviceId) : undefined;
      });
    void registrySync('boot');
    await refresh();
    markBooted();
    if (opts.onboarding) onb = new OnboardingFlow(onbPorts);
    else if (!fixture) {
      const saved = (await onbStore.load()) ?? (await onbStore.importLegacyFile(legacyOnbFile));
      if (saved) {
        onb = new OnboardingFlow(onbPorts, saved);
        onbShow = !onb.done;
      } else if (!business) onb = new OnboardingFlow(onbPorts);
    }
    await win.loadURL(SHELL_URL);
    if (!fixture && opts.daemon !== false) {
      daemon = startDaemonHost({
        rpc: (m, p) => host.rpc(m, p),
        show: showOsNotification,
        onDelivered: () => pushBoard(),
        onOpen: () => {
          if (win.isDestroyed()) return;
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        },
        stateFile: path.join(appPaths(root ?? defaultAppRoot()).userData, 'daemon-state.json'),
        log: (n, d) => log.event(n, d),
      });
      powerMonitor.on('resume', onResume);
    }
    if (!fixture && app.isPackaged && opts.update) updater = await startAppUpdater(opts.update);
  })();
  const rehearse = async () => {
    try {
      if (runs.anyActive()) throw new Error('busy');
      const find = () => cps.find((c) => c.bizNo.replace(/\D/g, '') === REHEARSAL.bizNo);
      if (!find()) {
        await cpBook.save({ name: REHEARSAL.name, bizNo: REHEARSAL.bizNo });
        await refresh();
      }
      const cp = find();
      if (!cp) throw new Error('no_counterparty');
      const d = runs.rehearsalDraft(cp);
      pushBoard();
      log.event('main.rehearsal_started', { runId: d.id });
      await prepareNow(d.id);
    } catch (e) {
      log.event('main.rehearsal_failed', { error: (e as Error).message.slice(0, 60) });
    }
  };
  const stopRehearsals = () => {
    for (const r of runs.list()) {
      if (!r.rehearsal || !runs.isActive(r.id)) continue;
      log.event('main.rehearsal_stop', { runId: r.id });
      void runs.stop(r.id).catch((e: Error) => log.event('main.rehearsal_stop_failed', { error: e.message.slice(0, 60) }));
    }
  };
  const certRehearse = async (doc: CertDocDef) => {
    try {
      if (runs.anyActive()) throw new Error('busy');
      const d = runs.createCertDraft(doc.code, certInputsFor(doc, '', kstToday(Date.now())), { rehearsal: true });
      pushBoard();
      log.event('main.rehearsal_started', { runId: d.id, playbook: doc.playbookId });
      await prepareNow(d.id);
    } catch (e) {
      log.event('main.rehearsal_failed', { error: (e as Error).message.slice(0, 60) });
    }
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      {
        label: '도구',
        submenu: [
          { id: 'rehearsal', label: '홈택스 예행(발급 안 함)', click: () => void rehearse() },
          { label: '민원증명 예행(발급 안 함)', submenu: CERT_DOCS_SHOWN.map((d) => ({ id: `certRehearsal.${d.code}`, label: d.label, click: () => void certRehearse(d) })) },
          { id: 'rehearsalStop', label: '예행 중지', click: () => stopRehearsals() },
        ],
      },
      { label: '창', submenu: [{ role: 'minimize' }, { role: 'close' }, { type: 'separator' }, { label: '소버린 AX 끝내기', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() }] },
    ]),
  );
  const close = async () => {
    clearInterval(boardDayTimer);
    clearInterval(registryTimer);
    clearInterval(shareTimer);
    if (moveTimer) clearTimeout(moveTimer);
    clearInterval(keepTimer);
    if (linkTimer) clearInterval(linkTimer);
    daemon?.stop();
    powerMonitor.removeListener('resume', onResume);
    clearInterval(idleTimer);
    for (const { kind, fn } of onSession) powerMonitor.removeListener(kind as 'resume', fn);
    updater?.stop();
    pairHost?.cancel();
    for (const r of pairedThisRun) r.channel.close();
    phoneLink?.stop();
    stayAwake.set(false);
    app.removeListener('before-quit', onBeforeQuit);
    if (process.platform === 'darwin') nativeUpdater.removeListener('before-quit-for-update', onBeforeQuit);
    app.removeListener('activate', onActivate);
    powerMonitor.removeListener('on-ac', onPowerSource);
    powerMonitor.removeListener('on-battery', onPowerSource);
    watchChromeFront(false);
    closeSecret();
    await host.shutdown().catch(() => {});
    await fixture?.close().catch(() => {});
  };
  return { win, bar, runs, store, host, fixture, ready, methods: Object.keys(handlers), secretAsk: () => (secretAsk ? { reqId: secretAsk.reqId, kind: secretAsk.bind.kind, runId: secretAsk.bind.runId } : null), close };
}
