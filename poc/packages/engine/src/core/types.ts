
export const PORTALS = ['hometax', 'gov24', 'wetax', 'sminfo', 'insure4', 'iros', 'public_api'] as const;
export type Portal = (typeof PORTALS)[number];
/**
 * 패키지(manifest·IR·셀렉터 사전)의 portal. `fixture`는 엔진 시험용 가짜 페이지(127.0.0.1·[::1])만이다(ADR-039).
 * 정책(portalMap)·실행 한도는 Portal만 받는다. fixture는 정적 검증(V-25)·제품 로더·레지스트리가 각각 거부한다.
 */
export const FIXTURE_PORTAL = 'fixture';
export const PACKAGE_PORTALS = [...PORTALS, FIXTURE_PORTAL] as const;
export type PackagePortal = (typeof PACKAGE_PORTALS)[number];
export type Effect = 'issue_document' | 'send' | 'sign' | 'pay';
export type ProfileKind = 'personal' | 'business';
/**
 * 패키지 형식의 비밀 종류·서명 방식. 보안카드(security_card)는 지원 안 함(대표 결정 2026-11-19)이지만, 게시본 H-01 2.3.8이
 * 그 갈래(signFlow security_card·card 정의·security_card 셀렉터 칸)를 담고 있어 형식에는 남긴다. 엔진은 읽기만 하고 실행하지 않는다
 * (run/controller.ts SIGN_ACTION). 그 갈래를 뺀 H-01을 다시 게시한 뒤 스키마와 함께 뺀다.
 */
export type SecretKind = 'cert_password' | 'portal_password' | 'security_card';
export type SecretPurpose = 'login' | 'sign';
export type SignMethod = 'cert' | 'simple_auth' | 'security_card';

export type Cond =
  | { exists: string }
  | { textMatches: { target: string; patternRef: string } }
  | { varEquals: { name: string; value: unknown } }
  | { varSet: string }
  | { inputPresent: string }
  | { inputEquals: { name: string; value: string } }
  | { inputVerified: string }
  | { profileHas: string }
  | { artifact: string }
  | { sumEquals: { parts: string[]; total: string } }
  | { readbackEquals: { fieldKey: string; ref: string; ifAbsent?: 'empty' | 'skip' } }
  | { readbackEmpty: string }
  | { fieldsFilled: { fields: string[] } }
  | { all: Cond[] }
  | { any: Cond[] }
  | { not: Cond };

export type OnFailThen = 'recover' | 'handoff' | 'abort' | 'human:secret' | `checkpoint:${string}`;
export interface OnFail {
  retry?: number;
  then?: OnFailThen;
}
export type OutcomeTarget = string;

export type From = { selector: string } | { regex: { target: string; patternRef: string } } | { a11y: { target: string } };

export interface FailSignal {
  css: string;
  text: string;
}

export interface Lookup {
  playbook: string;
  match: Record<string, string>;
  window: 'issueDate' | 'today' | 'last7d';
  baseline: 'pre_gate_snapshot' | 'none';
  notCommittedPolicy: { minElapsedMs: number; lookups: number };
  bind?: { approvalNo?: string };
  rowVerdict?: { column: string; sent: string; notSent: string };
  maxMs?: number;
}

export type SignFlowAction = 'human:secret' | 'secret_fill:security_card' | 'wait:push';
export interface SignFlow {
  method: SignMethod | '$profile.signMethod';
  steps?: Partial<Record<SignMethod, SignFlowAction[]>>;
  rowLabel?: string;
  confirmTarget?: string;
  openTargets?: string[];
  methodTargets?: Partial<Record<SignMethod, string>>;
  readyTarget?: string;
  doneTarget?: string;
  certPick?: { target: string; by: string };
  card?: { window: string; fields: Array<{ target: string; rowFrom: string }>; confirmTarget: string };
  maxWaitMs: number;
}

interface StepBase {
  id: string;
  label?: string;
  pace?: 'normal' | 'slow';
  timeoutMs?: number;
  onFail?: OnFail;
  loopGuard?: { max: number };
  code?: string;
}

export type GotoStep = StepBase & { type: 'goto'; url: string };
export type ClickStep = StepBase & { type: 'click'; target: string };
/** ifAbsent 'keep'(IR rev v1.3.8): 선택 입력이 비었으면 칸을 건드리지 않는다(포털이 채운 값, 예: 등록번호 [확인] 뒤 대표자 성명). */
export type FillStep = StepBase & { type: 'fill'; target: string; value: string; keyEvents?: boolean; ifAbsent?: 'fail' | 'clear' | 'keep' };
export type SelectStep = StepBase & { type: 'select'; target: string; option: string };
export type PressStep = StepBase & { type: 'press'; key: 'Enter' | 'Tab' | 'Escape' | 'ArrowDown' | 'ArrowUp'; target?: string };
/**
 * wait. for 'dialog'(IR rev v1.3.5): 마지막 동작 뒤 뜬 네이티브 대화상자(alert 등)를 기다리고, 그 문구가 value(strings 패턴, ^…$)에 맞아야 통과.
 * 다른 문구면 step.dialog_mismatch(재시도 없이 onFail), 시간 안에 안 뜨면 step.timeout. 대화상자는 엔진 정책대로 이미 닫혔다(alert = 확인).
 */
export type WaitStep = StepBase & { type: 'wait'; for: 'selector' | 'navigation' | 'text' | 'idle' | 'dialog' | 'gone'; value?: string };
/**
 * pick(IR rev v1.3.6): rows 항목(목록) 안에서 행 하나를 고른다(홈택스 인증서 창의 인증서 목록).
 * - use 'selected': 지금 선택된 행(사람이 고른 행). 정확히 하나여야 한다.
 * - 그 밖: 행이 하나면 그 행, 여럿이면 by 값(정규화)과 이름 칸 글이 같은 행이 정확히 하나일 때. 못 고르면 ifNone으로 간다(없으면 pick.none 실패).
 * 고른 행이 선택돼 있지 않으면 누르고, 선택 표지(rows.selected)가 그 행으로 바뀌는지 확인한다(사후 조건).
 * remember: 고른 행의 이름을 프로필 칸에 저장한다(다음 실행의 by). 성공하면 then(있으면)으로, 없으면 다음 스텝.
 * rows.button이 있으면(IR rev v1.3.9) 행을 고르는 대신 by와 같은 행의 단추를 누른다.
 */
export type PickStep = StepBase & { type: 'pick'; target: string; by?: string; use?: 'selected'; remember?: 'certName'; ifNone?: OutcomeTarget; then?: string };
export type AssertStep = StepBase & { type: 'assert'; cond: Cond };
export type ExtractStep = StepBase & { type: 'extract'; name: string; from: From; readback?: boolean };
export type DecideStep = StepBase & { type: 'decide'; bundle: string; scope: string; on: Record<string, OutcomeTarget> };
export type CheckpointStep = StepBase & { type: 'checkpoint'; name: string; expect: Cond; url?: string; sessionRequired?: boolean; reentry?: 'reuse' | 'reload' };
/** optional(IR rev v1.3.8): fields 뒤에 되읽되 못 읽으면 $readback에 넣지 않고 넘어간다(실패 없음, 대조 없음). */
export type ReadbackStep = StepBase & { type: 'readback'; fields: string[]; optional?: string[] };
export type GateStep = StepBase & { type: 'gate'; card: string; authorizes: string[]; waitMs?: number };
export type HumanStep = StepBase & { type: 'human'; kind: 'captcha' | 'otp' | 'secret' | 'manual'; prompt: string; region?: string; target?: string; inputSpec?: { pattern?: string; maxLength?: number }; ttlMs: number };
export type HumanCommitStep = StepBase & { type: 'human_commit'; prompt: string; intent: '$intent.id'; verify: string; followUpOf?: string };
export type SecretFillStep = StepBase & { type: 'secret_fill'; target: string; secret: SecretKind; rowFrom?: string };
export type SignStep = StepBase & { type: 'sign'; method: SignMethod | '$profile.signMethod'; then?: Array<'human:secret' | 'secret_fill:security_card'>; card?: SignFlow['card'] };
/**
 * expectConfirmVars(IR rev v1.4.0, ADR-063): expectConfirm 패턴 안의 `{이름}`을 무장할 때 그 참조 값(정규식 이스케이프)으로 바꾼다.
 * 홈택스 일괄발급 확인창 「(총 건수: n, 총 합계금액: x)」을 묶음 값과 맞춰야 수락한다(다르면 닫고 아무것도 보내지 않는다).
 */
export type SubmitStep = StepBase & { type: 'submit'; target: string; intent: '$intent.id'; verify: string; expectConfirm?: string; expectConfirmVars?: Record<string, string>; signFlow?: SignFlow };
export type VerifyStep = StepBase & { type: 'verify'; lookup: Lookup; failSignals?: FailSignal[]; on: { committed: OutcomeTarget; not_committed: OutcomeTarget; unknown: OutcomeTarget } };
export type CaptureStep = StepBase & { type: 'capture'; name: string; from: From };
export type SavePdfStep = StepBase & { type: 'save_pdf'; strategy: 'original' | 'print' | 'page_pdf' | 'wallet'; docType: string; nameTemplate?: string };
export type SendEmailStep = StepBase & { type: 'send_email'; via: 'portal' | 'local'; to: string; attach?: string; intent?: '$intent.id'; followUpOf: string; verify: string };
export type BranchStep = StepBase & { type: 'branch'; on: Cond; cases: Record<string, string>; default: OutcomeTarget };
export type RepeatStep = StepBase & { type: 'repeat'; max: number; until: Cond; steps: Step[] };
export type HandoffStep = StepBase & { type: 'handoff'; reason: string; resumeAt: string };
export type EndStep = StepBase & { type: 'end'; status: 'success' | 'completed_with_issues' | 'failed' };
/**
 * upload(IR rev v1.4.0, ADR-063): 금고가 rows·supplier 입력으로 포털 양식 파일(sheet)을 만들어 그 화면의 파일 칸 하나에 넣는다.
 * 엔진은 파일 경로도 바이트도 다루지 않는다(엔진의 DOM.setFileInputFiles는 중계가 계속 거부한다, D05 §3.3).
 */
export type UploadStep = StepBase & { type: 'upload'; sheet: 'hometax_bulk_v1'; rows: string; supplier: string };
/**
 * grid_check(IR rev v1.4.0, ADR-063): 금고가 고정 스크립트로 읽은 포털 목록(일괄발급 변환 목록)을 rows 입력과 줄마다 맞춘다.
 * converted: 줄 수, 순서, 거래처 번호·상호, 작성일, 금액, 영수/청구가 같고 모든 줄이 선택돼 있다.
 * issued: 모든 줄에 승인번호가 있다. bind가 있으면 승인번호 목록(쉼표)을 그 변수에 둔다.
 */
export type GridCheckStep = StepBase & { type: 'grid_check'; rows: string; supplier: string; expect: 'converted' | 'issued'; bind?: string };
/**
 * report_sync(IR rev v1.4.1, ADR-068 결정 6): 받기 계획(plan 입력, 자료 종류와 기간 목록)의 구간마다 금고가 고정 스크립트로 홈택스 조회 화면을 읽고(`report.readScreen`),
 * 읽은 줄이나 실패 코드를 받는 곳(sink)에 넘긴다. 읽기만 하고 화면을 고르는 셀렉터도 없다(메뉴, 기간, 표 id는 금고 표에 있다). 구간 하나의 실패는 다음 구간을 막지 않는다.
 */
export type ReportSyncStep = StepBase & { type: 'report_sync'; plan: string };

export type Step =
  | GotoStep | ClickStep | FillStep | SelectStep | PressStep | WaitStep | AssertStep | ExtractStep | DecideStep | CheckpointStep
  | ReadbackStep | GateStep | HumanStep | HumanCommitStep | SecretFillStep | SignStep | SubmitStep | VerifyStep | CaptureStep
  | SavePdfStep | SendEmailStep | BranchStep | RepeatStep | HandoffStep | EndStep | PickStep | UploadStep | GridCheckStep | ReportSyncStep;
export type StepType = Step['type'];
export type StepOf<T extends StepType> = Extract<Step, { type: T }>;

export const STEP_TYPES = [
  'goto', 'click', 'fill', 'select', 'press', 'wait', 'assert', 'extract', 'decide', 'checkpoint', 'readback', 'gate', 'human',
  'human_commit', 'secret_fill', 'sign', 'submit', 'verify', 'capture', 'save_pdf', 'send_email', 'branch', 'repeat', 'handoff', 'end', 'pick',
  'upload', 'grid_check', 'report_sync',
] as const satisfies readonly StepType[];

export interface InputDecl {
  type: 'counterparty' | 'amounts' | 'line_items' | 'date' | 'email' | 'enum' | 'string' | 'number' | 'boolean' | 'secret_ref' | 'invoice_rows' | 'party' | 'report_plan';
  required?: boolean;
  default?: unknown;
  minItems?: number;
  values?: string[];
}

export interface PlaybookIR {
  ir: 2;
  id: string;
  version: string;
  portal: PackagePortal;
  profileKinds: ProfileKind[];
  effects: Effect[];
  inputs: Record<string, InputDecl>;
  preconditions?: Cond[];
  steps: Step[];
  postconditions: Cond[];
  recovery?: { default?: OnFail };
  pacing?: { profile?: 'interactive' | 'daemon' };
  closeWindows?: string[];
  closeLayers?: { targets: string[]; until: string };
}

export type Candidate = { kind: 'role'; role: string; name: string } | { kind: 'css'; value: string } | { kind: 'label'; value: string };

export interface SelectorEntry {
  candidates: Candidate[];
  expect?: { visible?: boolean; enabled?: boolean; editable?: boolean };
  role: string;
  namePattern: string;
  frame: string;
  landmark: string;
  commits: boolean;
  commitEffect?: Effect;
  inputType?: 'text' | 'password' | 'number' | 'email' | 'date' | 'checkbox' | 'radio' | 'select' | 'textarea' | 'button' | 'link' | 'other';
  secretKind?: SecretKind;
  secretPurpose?: SecretPurpose;
  closeAffordance?: boolean;
  navigationOnly?: boolean;
  fieldKey?: string;
  readbackOf?: string;
  countOf?: string;
  /**
   * rows.button(IR rev v1.3.9): 행마다 있는 단추(CSS, 행 안). 있으면 pick은 by와 이름 칸이 같은 행을 반드시 찾고(행이 하나여도) 그 행의 단추를 누른다.
   * 선택 표지(selected)는 보지 않는다(홈택스 민원신청 처리결과 조회의 행별 [출력], ADR-062).
   */
  rows?: { item: string; name: string; selected?: string; button?: string };
  allowedConstants?: string[];
  reviewNote?: { by: string; reason: string };
  lastVerified: string;
}

export interface EndpointMatch {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  host?: string;
  pathPattern: string;
  actionParam?: { name: string; value: string };
}
export interface CommitEndpoint {
  match: EndpointMatch;
  effect: Effect;
  maxRequests: number;
  encoding?: 'form' | 'json' | 'xml' | 'opaque';
  bodyFieldMap?: Record<string, string>;
}

export interface SelectorDict {
  portal: PackagePortal;
  entries: Record<string, SelectorEntry>;
  commitEndpoints: CommitEndpoint[];
  knownEndpoints: EndpointMatch[];
}

/** 비밀 칸(V-20): secretKind가 있거나 inputType이 password인 항목. */
export const isSecretEntry = (e: Pick<SelectorEntry, 'secretKind' | 'inputType'> | undefined): boolean => !!e && (e.secretKind !== undefined || e.inputType === 'password');

export interface Signature {
  keyId: string;
  alg: 'ed25519';
  sig: string;
}

export interface Manifest {
  id: string;
  version: string;
  kind: 'playbook' | 'lookup';
  portal: PackagePortal;
  title: string;
  profileKinds: ProfileKind[];
  engineRange: string;
  domains: string[];
  effects: Effect[];
  bundlesUsed: Array<{ id: string; ver: number; digest: string }>;
  lookupsUsed: Array<{ id: string; version: string; digest: string }>;
  contentDigests: { playbook: string; selectors: string; strings: string };
  createdAt: string;
  signatures: Signature[];
}

export type Strings = Record<string, string>;

/** 검증 단위: 한 패키지의 네 파일. 조회 하위 패키지는 lookups로 같이 받는다(V-22). */
export interface PackageFiles {
  manifest: Manifest;
  playbook: PlaybookIR;
  selectors: SelectorDict;
  strings: Strings;
}

export interface Hotfix {
  appliesTo: { id: string; version: string; packageDigest: string };
  version: number;
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  entries: Record<string, { candidates: Candidate[] }>;
  commitEndpointsAdd?: CommitEndpoint[];
  reason?: string;
  signatures: Signature[];
}

export type PortalMode = 'postprocess' | 'assisted' | 'auto';
export type CaptchaRelay = 'allowed' | 'disabled_until_permission' | 'disabled';
export type PortalMap<T> = Partial<Record<Portal, T>> & Record<'hometax' | 'gov24' | 'sminfo' | 'insure4', T>;

export interface PacePolicy {
  stepDelayMs: [number, number];
  keyEventDelayMs: number;
  afterNavSettleMs: [number, number];
  slowFactor: number;
}
export interface PortalLimits {
  runsPerDayPerProfile: number;
  irreversiblePerDayPerProfile: number;
  runsPerLoginSession: number;
  navigationsPerMin: number;
  loginsPerDay: number;
  loginFailuresPerDay?: number;
  concurrent: 1;
}

export interface Policy {
  version: string;
  monotonic: number;
  keyEpoch: number;
  issuedAt: string;
  expiresAt: string;
  timestamp: Signature;
  pace: { interactive: PacePolicy; daemon: PacePolicy };
  limits: PortalMap<PortalLimits>;
  retries: { stepMax: number; backoff: 'equal_jitter'; baseMs: number; capMs: number };
  run: { maxActuationsPerRun: number; maxWallClockMs: number; commitWindowMs: number; l2MaxAttempts: number };
  cooldown: {
    onBlockSignalHours: number;
    onCaptchaBurst: { windowMin: number; count: number; action: 'slow+notify' | 'pause' };
    positiveDetectionsForCooldown: number;
    blockSignalsAdd?: { urlPatterns?: string[]; phrases?: string[] };
  };
  daemon: { windowJitterMin: number; gapBetweenRunsMin: [number, number]; startupGraceMin: number; retryAfterMin: number; autoAllowed: false };
  portalMode: PortalMap<PortalMode>;
  captchaRelay: PortalMap<CaptchaRelay>;
  /** webdriverSelfCheck: 자기 점검을 켠다. 기대값은 표식이 없는 것(ADR-010). */
  browser: { remoteDebuggingPort: 'forbidden'; webdriverSelfCheck: true };
  verify: { minElapsedMs: number; lookups: number; maxMs?: number };
  remote: { irreversiblePerDay: number; newCounterpartyRequiresLocal: true; notifyOnIrreversible: Array<'desktop' | 'email'>; minProtocolVersion: number; disabledFeatures: string[] };
  queue: { maxIntentsPerPair: number; ttlHours: number };
  signatures: Signature[];
}

/** 규칙 번호(V-01~24, V-03a~l·V-03c′·V-03j′·V-03j″, SV-01~06, HF-*, LD-*) 하나와 위치. 값은 담지 않는다. */
export interface Violation {
  rule: string;
  step?: string;
  target?: string;
  message: string;
}
