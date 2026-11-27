import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { attestSelfCheck, gateSelfCheck, type AttestRequest, type GateRequest } from '@sax/engine/gate';
import { actionText, ISSUED_OR_UNKNOWN, kstToday, summarize } from './approval-gate.ts';
import type { AttestAnswerResult, AttestWithdrawn, EngineHost, GateAnswerResult } from './engine-host.ts';
import { certDocByCode, type CertCode } from './cert-docs.ts';
import { AMEND_TEXT, cleanItem, splitVat, type Vat } from '@sax/chat-core';
import { dayOffset, SIGN_LABEL, emptyPending, hm, parseAmount, pastGate, RUN_STATUS_NEXT, type Counterparty, type Doc, type Drafts, type Pending, type RunStatus, type RunView, type StepState } from './shell-model.ts';
import { emailOk } from './onboarding.ts';
import type { ResumeItem } from './run-resume.ts';
import type { DraftExtraValues } from './agent-chat.ts';
import { amendCardNew, amendCardPlan, amendCardToday, amendCardUpdate, amendCardWith, type AmendValues, type AmendView, type AmendWhat, amendCardOriginal as amendOriginal, type AmendPatch, type AmendSaid, type AmendSource } from '@sax/chat-core';
import { issueDateRule } from '@sax/engine';


export const REPLACING_NOTE = '앞 준비를 멈추고 이 값으로 준비해요';
export const REPLACED_NOTE = '고친 값으로 바꿔서 멈췄어요. 보낸 것은 없어요.';
export const QUEUED_NOTE = '앞 건이 끝나면 시작해요';

const VERIFY_NOW = '발급 목록 확인 중, 1~2분 걸려요';
export const verifyNow = (attempt?: number) => (attempt && attempt > 1 ? `발급 목록 다시 확인 중(${attempt}번째)` : VERIFY_NOW);

const PHASES = ['login', 'form', 'input', 'readback', 'gate', 'sign', 'verify', 'mail'] as const;
type Phase = (typeof PHASES)[number];
export const STEP_LABELS: Readonly<Record<RunView['doc'], readonly string[]>> = {
  'H-01': ['홈택스 로그인', '세금계산서 화면 열기', '내용 넣기', '넣은 내용 확인', '사장님 승인', '인증서로 서명', '발급됐는지 확인', '메일 보낸 것 확인'],
  cert: ['홈택스 로그인', '신청 화면 열기', '신청 내용 넣기', '넣은 내용 확인', '사장님 승인', '발급 신청', '발급됐는지 확인'],
};
export const STEP_NOW: Readonly<Record<RunView['doc'], readonly (string | null)[]>> = {
  'H-01': [null, '세금계산서 화면 여는 중', '홈택스에 넣는 중', '넣은 값 확인 중', '승인 기다리는 중', null, VERIFY_NOW, '메일 간 것 확인 중'],
  cert: [null, '신청 화면 여는 중', '신청 내용 넣는 중', '넣은 값 확인 중', '승인 기다리는 중', '발급 신청 중', '발급 확인 중'],
};
const i6 = () => PHASES.indexOf('verify');
const stepsOf = (doc: RunView['doc']) => STEP_LABELS[doc].map((label) => ({ label, state: 'todo' as StepState }));

export const REGATE_NOTE = {
  paused: '멈췄던 작업을 이어서 하려면 새로 승인해야 해요. 앞의 승인은 쓰지 않아요.',
  date_changed: '준비한 날과 오늘(한국 시간) 날짜가 달라요. 작성일자를 다시 확인하고 새로 승인해 주세요.',
  value_changed: '홈택스 값을 다시 읽었어요. 바뀐 값으로 새로 승인해야 해요. 앞의 승인은 쓰지 않아요.',
} as const;
type RegateReason = keyof typeof REGATE_NOTE;
const isRegate = (x: unknown): x is RegateReason => typeof x === 'string' && Object.hasOwn(REGATE_NOTE, x);

const HANDOFF_HINT = '마치면 [다 했어요], 직접 발급했으면 [직접 발급함]을 눌러 주세요.';
export const HANDOFF_LOGIN = { text: '홈택스 창에서 로그인해 주세요', note: '로그인을 마치면 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' };
export const HANDOFF_SIGN = { text: '홈택스 창에서 인증 방법을 고르고 인증서 비밀번호를 직접 넣어 주세요. 끝나면 자동으로 이어집니다', note: '자동으로 넘어가지 않으면 [다 했어요]를 눌러 주세요.' };
export const HANDOFF_SIGN_TTL = { text: HANDOFF_SIGN.text, note: '앱의 비밀번호 창은 시간이 지나 닫혔어요. 홈택스 창에서 직접 넣어 주세요. 자동으로 넘어가지 않으면 [다 했어요]를 눌러 주세요.' };
export const SIGN_BY_AUTH: Record<string, { now: string; text: string }> = {
  [SIGN_LABEL.cert]: { now: '인증서로 서명하고 있어요', text: HANDOFF_SIGN.text },
  [SIGN_LABEL.simple_auth]: { now: '휴대폰에서 간편인증 요청을 승인해 주세요', text: '홈택스 창에서 간편인증을 고르고 휴대폰에서 승인해 주세요. 끝나면 자동으로 이어집니다' },
};
export const LOGIN_NOW = '홈택스 로그인 중';
export const SIGN_NOW_DEFAULT = '홈택스 창에서 인증을 마쳐 주세요';
const signFor = (auth: string | undefined) => (auth && Object.hasOwn(SIGN_BY_AUTH, auth) ? SIGN_BY_AUTH[auth]! : null);
const HANDOFF_BY_CODE: Record<string, { text: string; note: string }> = {
  'portal.captcha': { text: '홈택스 창에서 자동입력방지 문자를 넣고 로그인해 주세요', note: '마치면 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' },
  'cert.pick_needed': { text: '홈택스 창의 인증서 목록에서 쓸 인증서를 한 번 눌러 주세요', note: '고른 뒤 [이어서]를 눌러 주세요. 비밀번호는 앱이 넣어요. 다음부터는 이 인증서를 자동으로 골라요.' },
  'login.simple_auth': { text: '공동인증서로 로그인하지 못했어요. 아래 홈택스 화면에서 간편인증으로 로그인해 주세요', note: '이름/휴대폰 번호를 넣고 휴대폰에서 인증을 승인한 뒤 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' },
  'portal.mfa_pending': { text: '홈택스 창에서 추가 인증을 마치고 로그인해 주세요', note: '마치면 [이어서]를 눌러 주세요. 30분 안에 마치지 않으면 멈춰요.' },
  'portal.unexpected_page': { text: '홈택스 창의 화면을 확인해 주세요', note: '앱이 이 화면을 알아보지 못했어요. 홈택스 창에서 이 단계를 마친 뒤 [다 했어요], 직접 발급하셨다면 [직접 발급함]을 눌러 주세요.' },
  'step.assert_failed': { text: '홈택스 창의 화면을 확인해 주세요', note: '앱이 이 화면을 알아보지 못했어요. 홈택스 창에서 이 단계를 마친 뒤 [다 했어요], 직접 발급하셨다면 [직접 발급함]을 눌러 주세요.' },
  'issue.locked_elsewhere': { text: '다른 PC에서 발급 중이에요', note: '그 발급이 끝난 뒤 [이어서]를 눌러 주세요. 이 PC에서는 아무것도 발급하지 않았어요.' },
  'issue.lock_unavailable': { text: '다른 PC와 겹치는지 확인하지 못했어요', note: '인터넷 연결을 확인한 뒤 [이어서]를 눌러 주세요. 아무것도 발급하지 않았어요.' },
  'issue.lock_lost': { text: '다른 PC와 겹치는지 다시 확인해야 해요', note: '발급 버튼을 누르지 않았어요. [이어서]를 누르면 다시 확인한 뒤 승인을 받아요.' },
  'commit.precheck_failed': { text: '다른 PC와 겹치는지 다시 확인해야 해요', note: '발급 버튼을 누르지 않았어요. [이어서]를 누르면 다시 확인한 뒤 승인을 받아요.' },
};
const RESUME_ONLY: ReadonlySet<string> = new Set(['issue.locked_elsewhere', 'issue.lock_unavailable', 'issue.lock_lost', 'commit.precheck_failed']);
export function handoffTurn(phase: Phase, code: string | undefined, auth?: string, labels: readonly string[] = STEP_LABELS['H-01']): { kind: 'login' | 'sign' | 'other'; text: string; note: string } {
  if (phase === 'sign') return { kind: 'sign', ...(code === 'human.ttl_expired' ? HANDOFF_SIGN_TTL : HANDOFF_SIGN), ...(signFor(auth) ? { text: signFor(auth)!.text } : {}) };
  const byCode = code ? HANDOFF_BY_CODE[code] : undefined;
  if (byCode) return { kind: phase === 'login' || RESUME_ONLY.has(code!) ? 'login' : 'other', ...byCode };
  if (phase === 'login') return { kind: 'login', ...HANDOFF_LOGIN };
  return { kind: 'other', text: `'${labels[PHASES.indexOf(phase)] ?? ''}'는 홈택스 창에서 직접 해 주세요`, note: code && NOTE[code] && !/아무것도 발급하지 않았어요/.test(NOTE[code]!) ? NOTE[code]! : HANDOFF_HINT };
}

type EngineEvent =
  | { runId: string; type: 'phase'; phase: Phase; state: 'now' | 'done' | 'attention'; code?: string; attempt?: number }
  | { runId: string; type: 'regate'; reason: RegateReason }
  | { runId: string; type: 'handoff'; phase: Phase; code?: string }
  | { runId: string; type: 'waiting'; reqId: string }
  | { runId: string; type: 'issued'; approvalNo: string }
  | { runId: string; type: 'end'; status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string; maintenanceUntil?: string; until?: string }
  | { runId: string; type: 'secret'; state: 'open' | 'closed'; stepId?: string; why?: string }
  | { runId: string; type: 'notice'; stepId?: string; key?: string; text?: string; ok?: boolean }
  | { runId: string; type: 'state'; state: RunState; code?: string; portalNotice?: string };

export const RUN_STATES = ['running', 'waiting_gate', 'waiting_human', 'recovering', 'handed_off', 'paused', 'interrupted', 'in_doubt'] as const;
export type RunState = (typeof RUN_STATES)[number];

const SCREEN_UNKNOWN_REDO = '홈택스 화면을 알아보지 못했어요. [다시 준비]를 눌러 보거나 홈택스에서 직접 발급해 주세요. 아무것도 발급하지 않았어요.';
const UNKNOWN_SCREEN = '예상한 홈택스 화면이 아니에요. 전용 Chrome 창에 뜬 안내를 확인해 주세요. 아무것도 발급하지 않았어요.';

const BAD_PACKAGE = '홈택스 작업 정보가 올바르지 않아 시작하지 않았어요. 앱 업데이트 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.';
export const NOTE: Record<string, string> = {
  policy_downgrade: '앱이 홈택스 자동 실행을 멈춰서 이 건도 여기서 멈췄어요. 이어서 하려면 새로 승인해야 해요.',
  'run.paused': '이 건을 멈췄어요. 이어서 하려면 새로 승인해야 해요.',
  'browser.closed': '브라우저가 닫혔어요. 아무것도 발급하지 않았어요. [다시 시작]을 누르면 같은 내용으로 다시 준비해요.',
  'lookup.popup_cleanup_timeout': '홈택스 조회 창을 정리하지 못해 멈췄어요. 아무것도 발급하지 않았어요. 다시 준비해 주세요.',
  'lookup.popup_expose_failed': '홈택스 조회 창을 연결하지 못했어요. 창이 열리는지 확인해 주세요.',
  'login.session_assumed': '가짜 페이지라 로그인을 건너뛰었어요',
  'run.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.stopped': '발급 전에 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'gate.expired': '승인을 기다리다 시간이 지나 멈췄어요. 홈택스에는 아무것도 발급되지 않았어요.',
  'assert.supplier_mismatch': '홈택스에 로그인한 사업자가 이 프로필과 달라서 멈췄어요. 아무것도 발급하지 않았어요.',
  'assert.fields_missing': '홈택스 화면에 비어 있는 칸이 있어 멈췄어요. 아무것도 발급하지 않았어요.',
  pre_dispatch_mismatch: '승인한 뒤 홈택스 화면 값이 바뀌어 발급 버튼을 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'step.identity_mismatch': '홈택스 화면이 예상과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'step.target_not_found': UNKNOWN_SCREEN,
  'checkpoint.expect_failed': UNKNOWN_SCREEN,
  'portal.unexpected_page': SCREEN_UNKNOWN_REDO,
  'step.assert_failed': SCREEN_UNKNOWN_REDO,
  'step.timeout': '홈택스 로그인을 기다리다 시간이 지났어요. 홈택스 창에서 로그인을 마친 뒤 [다시 준비]를 눌러 주세요. 아무것도 발급하지 않았어요.',
  'step.selector_miss': SCREEN_UNKNOWN_REDO,
  'sign.password_wrong': '인증서 비밀번호가 맞지 않았어요. 발급되지 않았는지 홈택스 발급목록에서 확인해 주세요. 다시 발급하기 전에 꼭 확인해 주세요.',
  'sign.password_retry_limit': '비밀번호가 여러 번 틀렸어요. 인증서가 잠기지 않게 멈췄어요. 홈택스에서 직접 확인해 주세요.',
  'human.ttl_expired': '인증서 비밀번호 창이 시간이 지나 닫혔어요. [다시 준비]를 누르면 다시 열어요. 아무것도 발급하지 않았어요.',
  'run.handoff_timeout': '홈택스 창에서 할 일을 30분 동안 기다렸지만 끝나지 않아 멈췄어요.',
  'chrome.not_installed': 'Chrome이 설치돼 있어야 해요. Chrome을 설치한 뒤 [다시 준비]를 눌러 주세요. 아무것도 발급하지 않았어요.',
  'portal.unobservable': '홈택스 화면을 확인하지 못해 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'portal.personal_login_required': '이 서류는 개인사업자 로그인으로는 뗄 수 없어요. 홈택스에서 로그아웃하고 대표자 개인 인증서로 다시 로그인해 주세요. 아무것도 발급하지 않았어요.',
  'assert.bulk_count_mismatch': '홈택스가 읽은 건수가 올린 건수와 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'bulk.not_issued': '홈택스가 일괄발급을 받지 않았어요. 아무것도 발급하지 않았어요.',
  'bulk.grid_count_mismatch': '홈택스가 읽은 건수가 올린 파일과 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'bulk.grid_mismatch': '홈택스가 읽은 값이 올린 파일과 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'bulk.row_unchecked': '홈택스 목록에서 빠진 줄이 있어 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'bulk.upload_refused': '홈택스에 파일을 올리지 못했어요. 아무것도 발급하지 않았어요.',
  'bulk.upload_count_mismatch': '홈택스에 올린 파일의 건수가 맞지 않아 멈췄어요. 아무것도 발급하지 않았어요.',
  'bulk.grid_failed': '홈택스 목록을 읽지 못해 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'report.no_sink': '홈택스 자료를 받아 둘 곳이 아직 없어 시작하지 않았어요.',
  'report.bad_plan': '받을 기간이 맞지 않아 시작하지 않았어요.',
  'report.nothing_read': '홈택스에서 자료를 하나도 받지 못했어요. 다음에 다시 받을게요.',
  'report.sink_failed': '받은 홈택스 자료를 저장하지 못해 멈췄어요.',
  'assert.total_mismatch': '홈택스 화면의 공급가액과 세액을 더한 값이 합계와 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'assert.original_mismatch': '홈택스의 원래 계산서가 앱이 아는 것과 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'assert.cancel_mismatch': '홈택스가 만든 취소 금액이 원래 계산서와 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'amend.original_not_found': '홈택스에서 원래 계산서를 찾지 못했어요. 아무것도 발급하지 않았어요.',
  'amend.reason_unsupported': '이 사유는 아직 고칠 수 없어요. 아무것도 발급하지 않았어요.',
  'assert.input_mismatch': '홈택스 화면 값이 준비한 거래처 사업자번호/공급가액/세액/이메일과 달라 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'counterpart.bizno_rejected': '홈택스가 이 거래처 사업자번호를 정상으로 확인해 주지 않았어요. 아래 홈택스 안내를 확인해 주세요. 아무것도 발급하지 않았어요.',
  'assert.issue_date_mismatch': '홈택스 작성일자가 오늘(한국 시간)과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'vault.leak_suspected': '보안 점검에서 이상이 보여 멈췄어요. 아무것도 발급하지 않았어요. 앱을 다시 시작해 주세요.',
  'step.readback_mismatch': '홈택스 화면 값을 확실히 읽지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'verify.baseline_missing': '홈택스 발급목록을 미리 확인하지 못했어요.',
  'issue.locked_elsewhere': '다른 PC에서 발급 중이에요. 끝나면 이어서 할게요.',
  'issue.lock_unavailable': '다른 PC와 겹치는지 확인하지 못해 승인을 열지 않았어요. 아무것도 발급하지 않았어요.',
  'issue.lock_lost': '다른 PC와 겹치는지 다시 확인하지 못해 발급 버튼을 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'commit.precheck_failed': '다른 PC와 겹치는지 다시 확인하지 못해 발급 버튼을 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'verify.not_committed': "직전 시도는 '발급 안 됨'으로 판정되었어요. 홈택스 발급목록을 직접 확인한 뒤 다시 준비해 주세요.",
  'verify.not_committed_repeat': '두 번 눌러도 홈택스에서 발급/신청이 되지 않아 더 반복하지 않고 멈췄어요. 홈택스 목록에 새 건이 없는지 확인한 뒤 다시 준비해 주세요.',
  'verify.unknown': '발급 요청은 보냈지만 발급목록에서 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  in_doubt: '발급 단계에서 멈춰 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  'rehearsal.gate_reached': '예행을 마쳤어요. 승인 직전까지 갔고 발급하지 않았어요.',
  'rehearsal.handoff': '예행은 사람이 할 일이 생기면 기다리지 않고 멈춰요. 발급하지 않았어요.',
  'mail.not_confirmed': '발급은 완료되었어요. 메일 발송은 홈택스 메일발송목록에서 확인해 주세요.',
  selector_placeholder: '홈택스 화면 정보(셀렉터)가 아직 확정되지 않아 시작하지 않았어요.',
  'answer.rejected': '승인을 엔진에 전달하지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'bar.load_failed': '승인 바를 띄우지 못해 멈췄어요. 아무것도 발급하지 않았어요.',
  'post_commit.error': '발급은 확정됐지만 그 뒤 단계에서 오류가 났어요. 다시 실행하지 말고 홈택스 발급목록에서 확인해 주세요.',
  'engine.exit_before_approval': '엔진이 멈춰 승인 전에 끝났어요. 홈택스에는 아무것도 발급되지 않았어요. 앱을 다시 시작해 주세요.',
  'engine.exit': '엔진이 발급 도중에 멈춰 발급됐는지 모릅니다. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  'portal.blocked': '홈택스에서 차단/경고 신호(안내 화면, 요청 거부 응답)가 보여 바로 멈췄어요. 그 뒤로 앱은 홈택스에서 아무 동작도 하지 않았고 아무것도 발급하지 않았어요. 홈택스에 직접 접속해 상태를 확인해 주세요.',
  'portal.blocked_in_doubt': '발급 확인 중에 홈택스에서 차단/경고 신호가 보여 멈췄어요. 발급됐는지 확인하지 못했어요. 홈택스 발급목록을 직접 확인해 주세요. 다시 실행하면 중복 발급될 수 있어요.',
  'save_pdf.failed': '발급은 완료되었어요. 발급한 세금계산서 PDF는 받지 못했어요. 홈택스 발급목록에서 확인/인쇄할 수 있어요. 다시 발급하지 마세요.',
  'portal.blocked_after_commit': '발급은 확정됐지만 그 뒤 홈택스에서 차단/경고 신호가 보여 멈췄어요. 다음 발급을 이어가기 전에 홈택스에 직접 접속해 상태를 확인해 주세요.',
  'policy.cooldown': '홈택스 차단/경고 신호가 보여 24시간 동안 홈택스 실행을 쉬어요. 아무것도 발급하지 않았어요.',
  'portal.mfa_pending': '홈택스가 추가 인증을 요구해 멈췄어요. 아무것도 발급하지 않았어요. 홈택스에서 직접 인증한 뒤 다시 준비해 주세요.',
  'portal.extra_auth_repeat': '홈택스 추가 인증이 반복돼 앱이 스스로 멈췄어요(차단 신호는 아니에요). 홈택스에서 직접 인증을 마친 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  'portal.maintenance': '홈택스가 점검 중이에요. 점검이 끝나면 [다시 시작]을 눌러 주세요. 아무것도 발급하지 않았어요.',
  'portal.captcha': '홈택스가 문자 입력(자동입력방지)을 요구했어요. 홈택스 창에서 직접 입력한 뒤 [다시 준비]를 눌러 주세요. 아무것도 발급하지 않았어요.',
  'portal.busy': '홈택스 접속 대기열이 떠서 멈췄어요. 아무것도 발급하지 않았어요. 혼잡이 풀린 뒤 다시 준비해 주세요.',
  'policy.runs_per_day': '오늘 홈택스 실행 횟수 상한에 닿아 시작하지 않았어요.',
  'policy.irreversible_per_day': '오늘 홈택스 발급 건수 상한에 닿아 멈췄어요. 아무것도 발급하지 않았어요. 내일 다시 할 수 있어요.',
  'policy.runs_per_session': '이번 홈택스 로그인으로 할 수 있는 실행 횟수를 다 써서 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.logins_per_day': '오늘 홈택스 로그인 횟수 상한에 닿아 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.actuations_per_run': '한 번의 실행에서 할 수 있는 동작 수를 넘겨 멈췄어요. 아무것도 발급하지 않았어요.',
  'policy.wall_clock': '실행 시간 상한을 넘겨 멈췄어요. 아무것도 발급하지 않았어요.',
  profile_missing: '사업자 정보(사업자번호)가 등록되지 않아 시작하지 않았어요. 대화에서 [사업자 등록 마치기]로 등록해 주세요. 아무것도 발급하지 않았어요.',
  counterparty_missing: '거래처 정보를 찾지 못해 시작하지 않았어요. 거래처 화면에서 확인한 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  bad_amount: '금액을 확인하지 못해 시작하지 않았어요. 카드에서 금액을 고친 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  bad_issue_date: '작성일자를 확인하지 못해 시작하지 않았어요. 카드에서 작성일자를 오늘이나 지난 날로 고친 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  item_missing: '품목이 비어 있어 시작하지 않았어요. 아무것도 발급하지 않았어요. 거래처 화면에서 [저장 품목]을 넣거나, 대화에서 같은 요청을 다시 하면 품목을 물어볼게요.',
  'input.missing': '발급에 필요한 값이 비어 있어 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  'cert.input_invalid': '증명서 신청 값(용도/제출처)이 홈택스 작업 정보의 선택지와 맞지 않아 시작하지 않았어요. 앱을 업데이트한 뒤 다시 해 주세요. 아무것도 발급하지 않았어요.',
  'cert.input_unknown': '홈택스 작업 정보가 받지 않는 신청 값이 있어 시작하지 않았어요. 앱을 업데이트한 뒤 다시 해 주세요. 아무것도 발급하지 않았어요.',
  'cert.unknown_doc': '이 증명서를 떼는 홈택스 작업 정보가 없어 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  busy: '다른 작업이 진행 중이라 시작하지 않았어요. 그 작업이 끝난 뒤 다시 준비해 주세요.',
  already_issuing: '이미 발급을 시작한 건이라 다시 시작하지 않았어요.',
  'amend.bad_what': '사유를 다시 골라 주세요. 아무것도 발급하지 않았어요.',
  'amend.not_amendable': '이 계산서는 승인번호가 없어 고칠 수 없어요. 아무것도 발급하지 않았어요.',
  'amend.already_cancelled': '이미 취소한 계산서예요. 아무것도 발급하지 않았어요.',
  'amend.already_replaced': '이미 고친 계산서예요. 아무것도 발급하지 않았어요.',
  bad_run_id: '이 카드를 시작하지 못했어요. 대화에서 다시 요청해 주세요. 아무것도 발급하지 않았어요.',
  forbidden_channel: '허용되지 않은 경로로 들어온 요청이라 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  'ledger.intent_not_new': '같은 발급 요청을 이미 기록해 다시 시작하지 않았어요. 홈택스 발급목록을 확인해 주세요.',
  'issue.bad_key': '이 발급 요청을 알아보지 못해 시작하지 않았어요. 대화에서 다시 요청해 주세요. 아무것도 발급하지 않았어요.',
  'ledger.issue_committed': '이 세금계산서는 이미 발급됐어요. 다시 발급하지 않았어요.',
  'ledger.issue_open': '이 세금계산서가 발급됐는지 아직 확인 중이라 다시 시작하지 않았어요. 홈택스 발급목록을 확인해 주세요.',
  'login.not_implemented': '고른 발급 인증으로는 아직 홈택스에 로그인할 수 없어요. 내 사업장 화면의 발급 인증 [바꾸기]에서 다른 인증을 골라 주세요. 아무것도 발급하지 않았어요.',
  'package.not_loaded': '홈택스 작업 정보를 아직 받지 못해 시작하지 않았어요. 인터넷 연결을 확인하고 잠시 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  'package.load_failed': '홈택스 작업 정보를 확인하지 못해 시작하지 않았어요. 잠시 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  'package.app_old': '이 앱 판이 낮아 홈택스 작업 정보를 쓸 수 없어 시작하지 않았어요. 앱을 업데이트한 뒤 다시 준비해 주세요. 아무것도 발급하지 않았어요.',
  'policy.portal_mode_denied': '지금은 서버 설정으로 이 작업을 자동으로 할 수 없어 시작하지 않았어요. 아무것도 발급하지 않았어요.',
  'token.invalid': '실행 확인 값이 맞지 않아 멈췄어요. 아무것도 발급하지 않았어요. 다시 준비해 주세요.',
  'step.commit_shadow': '발급 버튼 주변 화면이 예상과 달라 누르지 않았어요. 아무것도 발급하지 않았어요.',
  'step.fill_mismatch': '홈택스 칸에 넣은 값이 준비한 값과 달라 멈췄어요. 아무것도 발급하지 않았어요.',
  'ir.bad_edge': BAD_PACKAGE,
  'ir.bad_ref': BAD_PACKAGE,
  'ir.no_end': BAD_PACKAGE,
  'ir.gate_without_readback': BAD_PACKAGE,
  'wait.timeout': '홈택스 화면이 제때 뜨지 않아 멈췄어요. 아무것도 발급하지 않았어요. 잠시 뒤 다시 준비해 주세요.',
};
export const STOP_AFTER_SIGN_NOTE = '중지를 받았어요. 서명이 됐는지 홈택스 발급목록에서 확인한 뒤 끝낼게요. 다시 발급하지 마세요.';
function refused(res: unknown): void {
  if (res && typeof res === 'object' && (res as { ok?: unknown }).ok === false) {
    const c = (res as { code?: unknown }).code;
    throw new Error(typeof c === 'string' && /^[a-z_]+(\.[a-z_]+)*$/.test(c) ? c : 'refused');
  }
}

export const HANDOFF_END_NOTE = '앱이 홈택스에서 이 단계를 이어 가지 못해 멈췄어요. 아무것도 발급하지 않았어요.';
export const HANDOFF_END_NEXT = '[다시 준비]로 처음부터 다시 하거나, [홈택스에서 직접 발급]으로 옆 패널의 값을 보고 직접 발급할 수 있어요.';
export const UNKNOWN_STOP_NOTE = '멈췄어요. 아무것도 발급하지 않았어요. 다시 준비해 보고, 같은 일이 반복되면 앱을 다시 시작해 주세요.';
const BLOCK_CODES = new Set(['portal.blocked', 'policy.cooldown']);
const IN_DOUBT_NOTE = new Set(['verify.unknown', 'engine.exit']);
export const CERT_NOTE: Record<string, string> = {
  'package.not_loaded': '이 증명서를 떼는 홈택스 작업 정보가 아직 이 PC에 없어 시작하지 않았어요. 앱을 업데이트하면 뗄 수 있어요. 아무것도 발급하지 않았어요.',
  'save_pdf.failed': '발급은 완료되었어요. 증명서 PDF는 받지 못했어요. 홈택스 민원증명 발급 내역에서 다시 출력할 수 있어요.',
};
/** 수정세금계산서 시작 거절(엔진 startAmend가 막는 조건 amend.<막는 것>, ADR-058). 문장은 카드와 같은 chat-core 문장이다. */
for (const [k, t] of Object.entries(AMEND_TEXT)) {
  if (t && !['increase_is_new', 'deadline', 'vat_filed'].includes(k) && !NOTE[`amend.${k}`]) NOTE[`amend.${k}`] = `${t} 아무것도 발급하지 않았어요.`;
}
const note = (code?: string, r?: RunView) => (code && ((r?.cert && CERT_NOTE[code]) || NOTE[code])) || UNKNOWN_STOP_NOTE;

const DUP_NOTE = {
  committed: '이 거래와 같은 건이 이미 발급돼 있어요(승인번호 있음). 한 번 더 발급하면 같은 계산서가 2건이 돼요.',
  unknown: '같은 건이 발급됐는지 아직 확인하지 못했어요. 홈택스 발급목록을 먼저 확인해 주세요.',
  notCommitted: '이전 시도는 발급되지 않았어요. 다시 발급하기 전에 홈택스 발급목록을 한 번 확인해 주세요.',
  other: '같은 거래처/금액/날짜/품목의 기록이 있어요. 같은 건을 두 번 발급하는 것이 아닌지 확인해 주세요.',
} as const;

function dupWarnings(req: GateRequest, text: Record<keyof typeof DUP_NOTE, string> = DUP_NOTE): string[] {
  const f = new Map<string, string>(req.fields.map((x) => [x.fieldKey, x.value]));
  const states = (f.get('$dup.businessKey') ?? '').split(',');
  const out: string[] = [];
  if (states.includes('committed')) out.push(text.committed);
  if (states.some((s) => s !== 'committed' && ISSUED_OR_UNKNOWN.includes(s))) out.push(text.unknown);
  if (f.get('$dup.priorNotCommitted') === 'true') out.push(text.notCommitted);
  if (!out.length && f.has('$dup.businessKey')) out.push(text.other);
  return out;
}
const CERT_DUP_NOTE: Record<keyof typeof DUP_NOTE, string> = {
  committed: '오늘 같은 서류를 같은 용도로 이미 뗐어요. 한 번 더 떼면 같은 증명서가 하나 더 생겨요.',
  unknown: '오늘 같은 서류가 발급됐는지 아직 확인하지 못했어요. 홈택스 민원증명 발급 내역을 먼저 확인해 주세요.',
  notCommitted: '이전 시도는 발급되지 않았어요.',
  other: '오늘 같은 서류를 같은 용도로 뗀 기록이 있어요.',
};

const EXTENSION_REFUSED_TEXT = 'Chrome 확장이 감지돼 안전을 위해 멈췄어요. 다시 시도해 주세요.';

export function vaultNotice(name: string, data: unknown): { runId?: string; text: string; retry?: 'extension'; quiet?: true } | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (name === 'secret.expired') return { runId: typeof d.runId === 'string' ? d.runId : undefined, text: '비밀번호를 5분 안에 쓰지 않아 지웠어요. 필요하면 다시 물어요', quiet: true };
  if (name === 'secret_window.leak_suspected') return { text: NOTE['vault.leak_suspected']! };
  if (name === 'secret_window.refused') {
    if (d.reason === 'google_signin_detected') return { text: '전용 Chrome에 Google 계정이 로그인돼 있어 비밀번호 창을 열지 않았어요. 전용 Chrome에서 로그아웃한 뒤 다시 준비해 주세요.' };
    if (d.reason === 'extension_not_allowed') return { text: EXTENSION_REFUSED_TEXT, retry: 'extension' };
    return { text: '전용 Chrome 설정이 바뀌어 비밀번호 창을 열지 않았어요. 앱을 다시 시작해 주세요.' };
  }
  return null;
}

export function fatalText(code: string): string | null {
  if (code === 'vault: db.key_missing' || code === 'vault: vault.keystore_mismatch') return '이 PC의 자격 증명 관리자에서 앱 열쇠를 찾지 못했어요. 기록을 지키려고 앱을 열지 않았어요.';
  if (code.startsWith('engine.env_tampered')) return '개발용 환경 변수가 켜져 있어 앱을 열지 않았어요.';
  return null;
}

const NOTICE_LABEL: Record<string, string> = { 'counterpart.bizNoOk': '사업자번호 확인' };
const cleanNotice = (s: string) => s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
const maintenanceNote = (hm: string) => `홈택스가 점검 중이에요(~${hm}). 끝나면 자동으로 다시 할게요. 아무것도 발급하지 않았어요.`;
const MAINTENANCE_UNKNOWN_NOTE = NOTE['portal.maintenance']!;
const MAINTENANCE_RESTARTED_NOTE = '홈택스 점검이 끝나 다시 시작했어요';
const MAINTENANCE_RESTART_FAILED_NOTE = '홈택스 점검이 끝났지만 바로 시작하지 못했어요. [발급하기]를 눌러 주세요.';
const portalNoticeText = (s: string) => `홈택스 안내: “${s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ').trim().slice(0, 200)}”`;

export const ATTEST_NOTE = {
  ready: '이 안내를 연 동안 대화 아래에 황토색 확인 카드가 떠요. 홈택스 발급목록에 이 건이 없을 때만 누르세요.',
  manual: '지금은 앱이 발급목록을 조회할 수 없어요. 홈택스 발급목록을 직접 확인한 뒤 황토색 확인 바로 답해 주세요.',
  sent: '발급목록에 없다는 확인을 기록했어요. 다시 발급하려면 새로 승인해야 해요.',
  stale: '이 건의 확인 요청이 끝났거나 바뀌어서 받지 않았어요. 아무것도 기록하지 않았어요.',
  expired: '확인 바를 누른 뒤 시간이 지나 받지 않았어요. 아무것도 기록하지 않았어요.',
  not_sent: '앱 엔진이 멈춰 확인을 보내지 못했어요. 아무것도 기록하지 않았어요.',
  unknown: '확인이 기록됐는지 알 수 없어요. 앱을 다시 연 뒤 이 건을 다시 확인해 주세요.',
} as const;

const TIMED_OUT: ReadonlySet<string> = new Set(['gate.expired', 'run.handoff_timeout']);
export const REHEARSAL_NEXT = "실제 발급에서는 앱이 여기서 기다려 드려요. 다시 해 보려면 도구 메뉴에서 '홈택스 예행(발급 안 함)'을 누르세요.";
export const REHEARSAL = { name: '일호유통', bizNo: '6495800524', item: '예행', supply: 1 } as const;

const RACED = new Set(['stopped', 'gate_expired', 'no_open_gate', 'not_open']);

export type RunHost = Pick<EngineHost, 'on' | 'control' | 'rpc'>;
const attestShapeOk = (req: AttestRequest | null | undefined): boolean => {
  try {
    return !!req && req.v === 1 && typeof req.runId === 'string' && typeof req.attestReqId === 'string' && Array.isArray(req.fields) && attestSelfCheck(req) === null;
  } catch {
    return false;
  }
};

interface ShellRunsSource {
  counterparties(): Counterparty[];
  auth(): string;
  chromeReady?(): boolean;
  issueDateFill?(): boolean;
  log?(name: string, data: Record<string, string>): void;
  prepare?(id: string): Promise<unknown>;
}

const MAINTENANCE_CODE = 'portal.maintenance';
const MAINTENANCE_GRACE_MS = 2 * 60_000;
const MAINTENANCE_BUSY_RETRY_MS = 60_000;
const MAINTENANCE_MAX_MS = 12 * 3_600_000;
const KST_MS = 9 * 3_600_000;

export function invoiceDraftError(r: RunView, today = dayOffset(0)): string | null {
  if (!cleanItem(r.item)) return 'item_required';
  if (!(r.supply + r.tax > 0)) return 'amount_zero';
  if (r.issueDateHeld) return 'issue_date.not_supported';
  if (r.writeDateSet && r.writeDate !== today) {
    const rule = issueDateRule(r.writeDate, today);
    if (rule !== 'ok' && rule !== 'late') return 'issue_date.out_of_range';
  }
  return emailOk(r.email.value) ? null : 'bad_email';
}

export function maintenanceUntil(v: unknown, now: number): number | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  let at: number;
  const hm = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (hm) {
    const h = Number(hm[1]);
    const m = Number(hm[2]);
    if (h > 24 || m > 59) return null;
    const day = Math.floor((now + KST_MS) / 86_400_000) * 86_400_000 - KST_MS;
    at = day + (h * 60 + m) * 60_000;
    if (at <= now) at += 86_400_000;
  } else at = Date.parse(v);
  if (!Number.isFinite(at) || at - now > MAINTENANCE_MAX_MS || now - at > MAINTENANCE_MAX_MS) return null;
  return at;
}
const kstHm = (at: number) => new Date(at + KST_MS).toISOString().slice(11, 16);

const issuedDoc = (r: RunView): Doc => r.cert
  ? { id: `d-${r.id}`, name: r.cert.name, kind: '증명서', docName: r.cert.name, profile: 'business', issuedOn: dayOffset(0), issuedAt: hm(), expiresOn: null, source: '앱이 발급', noFile: true, purpose: r.cert.inputs.purpose }
  : { id: `d-${r.id}`, name: `세금계산서 ${r.counterparty.name}`, kind: '세금계산서', docName: '전자세금계산서', profile: 'business', issuedOn: dayOffset(0), issuedAt: hm(), expiresOn: null, source: '앱이 발급', noFile: true };

const BATCH_APPROVAL_MAX_MS = 30 * 60_000;
const RUN_HALT = /^(portal\.blocked|portal\.maintenance|policy\.|vault\.|engine\.|package\.|ir\.|ledger\.|token\.invalid|verify\.unknown|in_doubt|profile_missing|busy$)/;
/** 묶음 승인 상한. 대량 발급 ADR-059 결정 1: 10건까지는 건별 화면을 이어서 낸다(홈택스 직접 입력 일괄발급 10건, 로그인 한 번 15건 안). */
export const BATCH_MAX = 10;
const BATCH_BUSY_RETRY_MS = 15_000;
const BATCH_BUSY_TRIES = 8;
const BATCH_SKIPPED_NOTE = '이 건은 시작하지 못해 건너뛰었어요. 값을 고친 뒤 [발급하기]를 누르면 승인 카드를 다시 띄워요. 아무것도 발급하지 않았어요.';
export const BATCH_AUTO_NOTE = '묶음 승인으로 이어서 발급해요. 2초 안에 [중지]하면 발급하지 않아요';
const BATCH_REASK_NOTE = '이 건은 승인 카드에서 따로 승인해 주세요(홈택스 값이 처음 승인 때와 다르거나 처음 거래/처음 보내는 주소예요)';
export const BATCH_CHANGED_NOTE = '승인 카드를 띄운 뒤 묶음 값이 바뀌어 묶음 승인으로 받지 않았어요. 남은 건은 하나씩 승인해 주세요.';
interface BatchOffer {
  batchId: string;
  count: number;
  lines: Array<{ name: string; total: number }>;
  keys: Map<string, string>;
}
interface Batch {
  id: string;
  runIds: string[];
  approval: { at: number; keys: Map<string, string> } | null;
  halted: boolean;
}
const RESUMED_NOTE = '앱이 다시 켜져 멈췄던 건을 이어서 해요';
export const CERT_RETRY_NOTE = '공동인증서로 한 번 더 로그인해요';
const CERT_LOGIN_FAILED = 'login.simple_auth';
export const SIMPLE_SENT = 'login.simple_sent';
const SIMPLE_AUTH_MS = 5 * 60_000;
const SIMPLE_APP_LABEL: Readonly<Record<string, string>> = { kakao: '카카오톡', naver: '네이버', toss: '토스', pass: 'PASS 앱', kb: 'KB국민은행 앱', shinhan: '신한 앱', woori: '우리은행 앱', hana: '하나은행 앱', nh: 'NH 앱', ibk: 'IBK 앱', kakaobank: '카카오뱅크', samsung: '삼성패스', banksalad: '뱅크샐러드' };
export const CERT_FAILED_TWICE = { text: '공동인증서 로그인이 두 번 안 됐어요', note: '인증서로 다시 하거나 간편인증으로 로그인해 주세요.' };
/** 승인 전에 화면이 늦거나 예상과 달라 멈춘 코드. 같은 내용으로 한 번 다시 하면 대개 지나간다. 입력값 문제·사람이 멈춤·차단·점검은 아니다. */
const TRANSIENT_END = /^(step\.(timeout|selector_miss|target_not_found|port_error|assert_failed|loop_guard)|wait\.timeout|checkpoint\.expect_failed|portal\.(unexpected_page|unknown_screen|unobservable|busy)|verify\.baseline_missing|run\.handoff_timeout)$/;
export const AUTO_RETRY_NOTE = '화면이 늦어 한 번 더 하고 있어요';
const WAKE_RESUMED_NOTE = 'PC가 잠들었다 깨어나 다시 시작했어요';
const WAKE_RESUME_MS = 5 * 60_000;
const draftKey = (r: RunView) => JSON.stringify([r.counterparty.bizNo, String(r.supply), String(r.tax), String(r.total), r.item, r.email.value, r.writeDate]);
const gateKey = (f: Map<string, string>) => JSON.stringify([f.get('counterpartBizNo'), f.get('supplyAmount'), f.get('taxAmount'), f.get('totalAmount'), f.get('itemName'), f.get('counterpartEmail') ?? '', f.get('issueDate')]);

export class ShellRuns extends EventEmitter implements Drafts {
  private readonly runs = new Map<string, RunView>();
  /** 승인 카드에 온 홈택스 되읽기 값(세금계산서). 발급 뒤 앱이 PDF를 만들 때 쓴다. 화면에는 보내지 않는다. */
  private readonly readbacks = new Map<string, ReadonlyMap<string, string>>();
  private readonly endCodes = new Map<string, string>();
  private readonly starting = new Set<string>();
  private readonly certRetry = new Set<string>();
  private readonly stopEarly = new Set<string>();
  private readonly liveInDoubt = new Set<string>();
  private readonly paused = new Set<string>();
  private readonly attests = new Map<string, AttestRequest>();
  /** [다시 준비]로 이어 만든 카드: 앞 카드 id → 새 카드 id. */
  private readonly nextOf = new Map<string, string>();
  private readonly host: RunHost;
  private readonly src: ShellRunsSource;
  private readonly clock: () => number;
  readonly pending: Pending = emptyPending();

  constructor(host: RunHost, src: ShellRunsSource, clock: () => number = Date.now) {
    super();
    this.host = host;
    this.src = src;
    this.clock = clock;
    host.on('run', (e: EngineEvent) => this.onEngine(e));
    host.on('gate', (req: GateRequest) => this.onGate(req));
    host.on('gate-closed', (e: { runId: string; reqId: string; reason: string }) => this.emit('gate-closed', e.runId, e.reqId, e.reason));
    host.on('attest', (req: AttestRequest) => this.onAttest(req));
    host.on('attest-withdrawn', (w: AttestWithdrawn) => this.onAttestWithdrawn(w));
    host.on('exit', (who: string) => {
      if (who === 'engine') this.engineGone();
    });
  }

  private onAttest(req: AttestRequest): void {
    if (!attestShapeOk(req)) return;
    const r = this.runs.get(req.runId);
    if (!r || !r.inDoubt) return;
    this.attests.set(r.id, req);
    r.attest = { state: 'ready', note: req.manualCheck === true ? ATTEST_NOTE.manual : ATTEST_NOTE.ready };
    this.emit('update', r);
    this.emit('attest-ready', r.id);
  }

  private onAttestWithdrawn(w: AttestWithdrawn): void {
    const cur = this.attests.get(w?.runId);
    if (!cur || cur.attestReqId !== w.attestReqId) return;
    this.attests.delete(w.runId);
    const r = this.runs.get(w.runId);
    if (r?.attest?.state === 'ready') {
      r.attest = null;
      this.emit('update', r);
    }
    this.emit('attest-withdrawn', w.runId, w.attestReqId, w.reason);
  }

  attestFor(runId: string): AttestRequest | null {
    return this.attests.get(runId) ?? null;
  }

  attestUsed(runId: string, attestReqId: string): void {
    if (this.attests.get(runId)?.attestReqId === attestReqId) this.attests.delete(runId);
  }

  onAttestAnswer(runId: string, a: AttestAnswerResult): void {
    const r = this.runs.get(runId);
    if (!r) return;
    const note = a.ok ? ATTEST_NOTE.sent : a.verdict === 'not_sent' ? ATTEST_NOTE.not_sent : a.verdict === 'unknown' ? ATTEST_NOTE.unknown : a.code === 'attest.expired' ? ATTEST_NOTE.expired : ATTEST_NOTE.stale;
    r.attest = { state: a.ok ? 'sent' : 'refused', note };
    this.emit('update', r);
  }

  private engineGone(): void {
    for (const id of this.attests.keys()) {
      const r = this.runs.get(id);
      if (r?.attest?.state === 'ready') {
        r.attest = null;
        this.emit('update', r);
      }
    }
    this.attests.clear();
    for (const id of [...this.liveInDoubt, ...this.paused]) void this.host.control('run.end', { runId: id }).catch(() => {});
    this.liveInDoubt.clear();
    this.paused.clear();
    for (const r of this.runs.values()) {
      if (!['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)) continue;
      const unsure = r.status === 'issuing' || r.approvedPending === true || r.handoff?.afterGate === true;
      this.end(r, unsure ? { status: 'in_doubt', code: 'engine.exit' } : { status: 'failed', code: 'engine.exit_before_approval' });
    }
  }

  get counterparties(): Counterparty[] {
    return this.src.counterparties();
  }

  readback(id: string): ReadonlyMap<string, string> | undefined {
    return this.readbacks.get(id);
  }

  get(id: string): RunView | undefined {
    return this.runs.get(id);
  }

  list(): RunView[] {
    return [...this.runs.values()];
  }

  rehearsalDraft(cp: Counterparty): RunView {
    const d = this.createDraft(cp, REHEARSAL.supply, 'separate', REHEARSAL.item);
    d.email = { value: '', first: false };
    d.rehearsal = true;
    return d;
  }

  createDraft(cp: Counterparty, amount: number, vat: Vat | null, item?: string | null, extra: DraftExtraValues = {}): RunView {
    const s = splitVat(amount, vat ?? 'separate');
    const run: RunView = {
      id: `run-${randomUUID().slice(0, 8)}`,
      doc: 'H-01',
      cert: null,
      status: 'draft',
      createdAt: hm(),
      counterparty: { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: false },
      email: { value: cp.email, first: false },
      amount,
      vat: vat ?? 'separate',
      vatGuessed: vat === null,
      ...s,
      item: cleanItem(item ?? '') ?? cleanItem(cp.item ?? '') ?? '',
      itemGuessed: !cleanItem(item ?? ''),
      writeDate: extra.writeDate ?? dayOffset(0),
      ...(extra.writeDate ? { writeDateSet: true } : {}),
      ...(extra.quantity && extra.unitPrice ? { quantity: extra.quantity, unitPrice: extra.unitPrice } : {}),
      auth: this.src.auth(),
      steps: stepsOf('H-01'),
      turn: null,
      confirmed: false,
      result: null,
      warnings: [],
    };
    this.markDup(run);
    this.markDate(run);
    this.runs.set(run.id, run);
    return run;
  }

  /** 수정세금계산서 카드를 만든다(ADR-058). 사유는 사장님이 카드에서 고른다. 고르기 전에는 금액이 0이다. */
  createAmend(originals: readonly AmendSource[], said: AmendSaid): RunView {
    const card = amendCardNew(originals, said, dayOffset(0));
    const first = card.originals[0]!;
    const cp = this.src.counterparties().find((c) => c.id === first.counterpartyId);
    const run: RunView = {
      id: `run-${randomUUID().slice(0, 8)}`,
      doc: 'H-01',
      cert: null,
      status: 'draft',
      createdAt: hm(),
      counterparty: { id: first.counterpartyId, name: first.counterpartName, bizNo: first.counterpartBizNo, first: false },
      email: { value: cp?.email ?? '', first: false },
      amount: 0,
      vat: 'separate',
      vatGuessed: false,
      supply: 0,
      tax: 0,
      total: 0,
      item: first.item,
      itemGuessed: false,
      writeDate: dayOffset(0),
      auth: this.src.auth(),
      steps: stepsOf('H-01'),
      turn: null,
      confirmed: false,
      result: null,
      warnings: [],
      amend: card,
    };
    this.syncAmend(run);
    this.runs.set(run.id, run);
    return run;
  }

  /** 폰이 고른 수정(ADR-058 결정 8): 당초분 하나와 사유, 고친 뒤 값으로 카드를 만든다. */
  createAmendFrom(src: AmendSource, what: AmendWhat, values: AmendValues): RunView {
    const r = this.createAmend([src], {});
    r.amend = amendCardWith(r.amend!, what, values, dayOffset(0));
    this.syncAmend(r);
    return r;
  }

  updateAmend(id: string, patch: AmendPatch): RunView {
    const r = this.mustDraft(id);
    if (!r.amend) throw new Error('not_draft');
    r.amend = amendCardUpdate(r.amend, patch, dayOffset(0));
    this.syncAmend(r);
    this.emit('update', r);
    return r;
  }

  /** 금액 칸을 치는 동안 쓸 계산(저장하지 않는다). 맞지 않는 값이면 null. 공급가액, 부가세, 합계가 서로 따라 바뀐 값을 돌려준다. */
  previewAmend(id: string, patch: { field: 'supply' | 'tax' | 'total'; value: number }): AmendView['amounts'] {
    const r = this.mustDraft(id);
    if (!r.amend) throw new Error('not_draft');
    try {
      return amendCardUpdate(r.amend, patch, dayOffset(0)).view.amounts;
    } catch {
      return null;
    }
  }

  /** 카드에서 고른 계산서와 나가는 장(잘못 적음이면 새 계산서)을 실행 값으로 옮긴다. 진행 카드와 발급 기록이 이 값을 보인다. */
  private syncAmend(r: RunView): void {
    const c = r.amend!;
    const o = amendOriginal(c);
    if (o) {
      const cp = this.src.counterparties().find((x) => x.id === o.counterpartyId);
      r.counterparty = { id: o.counterpartyId, name: o.counterpartName, bizNo: c.what === 'wrong_entry' && c.values ? c.values.counterpartBizNo : o.counterpartBizNo, first: false };
      r.email = { value: cp?.email ?? '', first: false };
      r.item = c.what === 'wrong_entry' && c.values ? c.values.item : o.item;
    }
    const plan = amendCardPlan(c);
    const main = plan?.main;
    r.supply = main?.supply ?? 0;
    r.tax = main?.tax ?? 0;
    r.total = main?.total ?? 0;
    r.amount = r.total;
    r.writeDate = main?.issueDate ?? dayOffset(0);
  }

  private async startAmend(r: RunView, rehearsal: Record<string, unknown>): Promise<void> {
    const c = r.amend!;
    const o = amendOriginal(c);
    if (!o || !c.what || !c.values) throw new Error('amend.bad_what');
    await this.host.rpc('run.startAmend', {
      runId: r.id,
      original: { approvalNo: o.approvalNo, issueDate: o.issueDate, issuedOn: o.issuedOn ?? null, counterpartyId: o.counterpartyId, supply: o.supply, tax: o.tax, item: o.item },
      what: c.what,
      values: c.values,
      ...rehearsal,
    });
  }

  createCertDraft(code: CertCode, inputs: Record<string, string>, o: { rehearsal?: boolean } = {}): RunView {
    const def = certDocByCode(code);
    if (!def) throw new Error('cert.unknown_doc');
    const run: RunView = {
      id: `run-${randomUUID().slice(0, 8)}`,
      doc: 'cert',
      cert: { code: def.code, playbookId: def.playbookId, name: def.name, docType: def.docType, inputs: { ...inputs } },
      status: 'draft',
      createdAt: hm(),
      counterparty: { id: '', name: '', bizNo: '', first: false },
      email: { value: '', first: false },
      amount: 0,
      vat: 'separate',
      vatGuessed: false,
      supply: 0,
      tax: 0,
      total: 0,
      item: '',
      itemGuessed: false,
      writeDate: dayOffset(0),
      auth: this.src.auth(),
      steps: stepsOf('cert'),
      turn: null,
      confirmed: false,
      result: null,
      warnings: [],
      ...(o.rehearsal ? { rehearsal: true } : {}),
    };
    this.runs.set(run.id, run);
    return run;
  }

  startCert(code: CertCode, inputs: Record<string, string>, o: { rehearsal?: boolean } = {}): Promise<RunView> {
    return this.prepare(this.createCertDraft(code, inputs, o).id);
  }

  private markDate(r: RunView): void {
    const today = dayOffset(0);
    const set = !!r.writeDateSet && r.writeDate !== today;
    r.issueDateLate = set && issueDateRule(r.writeDate, today) === 'late';
    r.issueDateHeld = set && !this.src.issueDateFill?.();
  }

  private markDup(r: RunView): void {
    const today = dayOffset(0);
    r.dupToday = [...this.runs.values()].some((x) => x.id !== r.id && (x.status === 'done' || x.inDoubt === true) && x.writeDate === today && x.counterparty.id === r.counterparty.id && x.total === r.total);
  }

  updateDraft(id: string, patch: { vat?: Vat; amount?: number; amountText?: string; item?: string; email?: string; counterpartyId?: string } & DraftExtraValues): RunView {
    if (patch.amountText !== undefined) {
      const t = patch.amountText.trim();
      const v = parseAmount(/^[\d,]+$/.test(t) ? `${t}원` : t);
      if (v === null) throw new Error('bad_amount');
      patch = { ...patch, amount: v };
    }
    const r = this.mustDraft(id);
    if (r.cert) throw new Error('not_draft');
    if (patch.counterpartyId !== undefined && patch.counterpartyId !== r.counterparty.id) {
      const cp = this.src.counterparties().find((c) => c.id === patch.counterpartyId);
      if (!cp) throw new Error('no_counterparty');
      r.counterparty = { id: cp.id, name: cp.name, bizNo: cp.bizNo, first: false };
      r.email = { value: cp.email, first: false };
      if (r.itemGuessed || !cleanItem(r.item)) {
        r.item = cleanItem(cp.item ?? '') ?? '';
        r.itemGuessed = true;
      }
    }
    if (patch.vat) {
      r.vat = patch.vat;
      r.vatGuessed = false;
    }
    if (patch.amount !== undefined) {
      if (!Number.isInteger(patch.amount) || patch.amount <= 0 || patch.amount > 1e12) throw new Error('bad_amount');
      r.amount = patch.amount;
      if (patch.quantity && patch.unitPrice && patch.quantity * patch.unitPrice === patch.amount) {
        r.quantity = patch.quantity;
        r.unitPrice = patch.unitPrice;
      } else {
        delete r.quantity;
        delete r.unitPrice;
      }
    }
    if (patch.writeDate !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.writeDate)) throw new Error('bad_issue_date');
      r.writeDate = patch.writeDate;
      if (patch.writeDate === dayOffset(0)) delete r.writeDateSet;
      else r.writeDateSet = true;
    }
    if (patch.item !== undefined) {
      const v = cleanItem(patch.item);
      if (!v) throw new Error('item_required');
      r.item = v;
      r.itemGuessed = false;
    }
    if (patch.email !== undefined) {
      const v = patch.email.trim().slice(0, 320);
      if (!emailOk(v)) throw new Error('bad_email');
      r.email = { ...r.email, value: v };
    }
    Object.assign(r, splitVat(r.amount, r.vat));
    this.markDup(r);
    this.markDate(r);
    this.emit('update', r);
    return r;
  }

  discardDraft(id: string): RunView {
    const r = this.mustDraft(id);
    this.runs.delete(id);
    const shown = { ...r, discarded: true };
    this.emit('update', shown);
    return shown;
  }

  private mustDraft(id: string): RunView {
    const r = this.runs.get(id);
    if (!r || r.status !== 'draft') throw new Error('not_draft');
    return r;
  }

  private busy(): boolean {
    return [...this.runs.values()].some((x) => ['preparing', 'turn', 'waiting', 'issuing'].includes(x.status) || x.settling === true);
  }

  activeRun(): RunView | null {
    return [...this.runs.values()].find((x) => this.isActive(x.id)) ?? null;
  }

  replaceable(id: string): boolean {
    const r = this.runs.get(id);
    if (!r || !['preparing', 'turn', 'waiting'].includes(r.status) || r.cert || r.batch || r.rehearsal) return false;
    return !(r.approvedPending === true || r.handoff?.afterGate === true || this.stopEarly.has(id));
  }

  anyActive(): boolean {
    return this.busy();
  }

  isActive(runId: string): boolean {
    const r = this.runs.get(runId);
    return !!r && ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status);
  }

  browserClosed(): void {
    const now = this.clock();
    this.goneAt = now;
    for (const r of this.runs.values()) {
      const past = pastGate(r);
      if (['preparing', 'turn', 'waiting'].includes(r.status) && !past) {
        r.browserClosed = true;
        this.endCodes.set(r.id, 'browser.closed');
        void this.stop(r.id).catch(() => {});
      } else if (r.status === 'issuing' || (past && this.isActive(r.id))) {
        r.info = '브라우저가 닫혀 발급됐는지 확인하고 있어요';
        this.emit('update', r);
      } else if ((r.status === 'attention' || r.status === 'stopped') && !r.inDoubt && r.redo && r.endedAt !== undefined && now - r.endedAt < 10_000) {
        this.markClosed(r);
        this.emit('update', r);
      }
    }
  }
  private goneAt = Number.NEGATIVE_INFINITY;
  private markClosed(r: RunView): void {
    r.browserClosed = true;
    this.to(r, 'stopped');
    r.stoppedNote = NOTE['browser.closed'];
    r.redo = true;
  }

  private noticeTarget(runId: string | undefined): RunView | undefined {
    const own = runId ? this.runs.get(runId) : undefined;
    const active = [...this.runs.values()].find((x) => this.isActive(x.id));
    return own && this.isActive(own.id) ? own : (active ?? own);
  }

  notice(runId: string | undefined, text: string, retry?: 'extension'): void {
    const r = this.noticeTarget(runId);
    if (!r) return;
    r.notices = [...(r.notices ?? []).filter((t) => t !== text), text];
    if (retry) r.retry = retry;
    this.emit('update', r);
  }

  say(runId: string | undefined, text: string): void {
    const r = (runId ? this.runs.get(runId) : undefined) ?? this.noticeTarget(runId);
    if (!r) return;
    r.info = text;
    this.emit('update', r);
  }

  unsay(runId: string, text: string): void {
    const r = this.runs.get(runId);
    if (r?.info !== text) return;
    r.info = undefined;
    this.emit('update', r);
  }

  markStarting(runId: string, on: boolean): void {
    const r = this.runs.get(runId);
    if (!r || !!r.starting === on) return;
    r.starting = on || undefined;
    this.emit('update', r);
  }

  private readonly batches = new Map<string, Batch>();

  makeBatch(ids: string[]): string | null {
    const rs = ids
      .map((id) => this.runs.get(id))
      .filter((r): r is RunView => !!r && r.status === 'draft' && !r.batch && !r.rehearsal)
      .slice(0, BATCH_MAX);
    if (rs.length < 2) return null;
    const id = `batch-${randomUUID().slice(0, 8)}`;
    this.batches.set(id, { id, runIds: rs.map((r) => r.id), approval: null, halted: false });
    rs.forEach((r, index) => {
      r.batch = { id, index, count: rs.length };
      this.emit('update', r);
    });
    return id;
  }

  private batchFor(runId: string): Batch | undefined {
    const b = this.runs.get(runId)?.batch;
    return b ? this.batches.get(b.id) : undefined;
  }

  batchRuns(batchId: string): RunView[] {
    return (this.batches.get(batchId)?.runIds ?? []).map((id) => this.runs.get(id)).filter((r): r is RunView => !!r);
  }

  private batchQueued(b: Batch, except?: string): RunView[] {
    return this.batchRuns(b.id).filter((x) => x.id !== except && x.status === 'draft' && !x.batch?.skipped);
  }

  batchOpen(batchId: string): boolean {
    const b = this.batches.get(batchId);
    return !!b && (this.batchRuns(batchId).some((x) => this.isActive(x.id)) || (!b.halted && this.batchQueued(b).length > 0));
  }

  batchWaiting(r: RunView): boolean {
    const b = r.batch && this.batches.get(r.batch.id);
    return !!b && r.status === 'draft' && !r.batch!.skipped && !r.batch!.halted && (b.approval?.keys.has(r.id) === true || this.batchRuns(b.id).some((x) => this.isActive(x.id)));
  }

  batchOffer(runId: string): BatchOffer | null {
    const b = this.batchFor(runId);
    if (!b || b.approval || b.halted) return null;
    const rest = this.batchQueued(b, runId);
    if (!rest.length) return null;
    return { batchId: b.id, count: rest.length + 1, lines: rest.map((x) => ({ name: x.counterparty.name, total: x.total })), keys: new Map(rest.map((x) => [x.id, draftKey(x)])) };
  }

  batchApproved(runId: string, offer: BatchOffer): boolean {
    const b = this.batchFor(runId);
    if (!b || b.approval || b.id !== offer.batchId) return false;
    const now = new Map(this.batchQueued(b, runId).map((x) => [x.id, draftKey(x)]));
    const same = now.size === offer.keys.size && [...offer.keys].every(([id, k]) => now.get(id) === k);
    this.src.log?.('main.batch_approved', { count: String(offer.count), same: same ? 'yes' : 'no' });
    if (!same) return false;
    b.approval = { at: this.clock(), keys: new Map(offer.keys) };
    b.halted = false;
    for (const x of this.batchRuns(b.id)) {
      x.batch = { ...x.batch!, approved: true, halted: false };
      this.emit('update', x);
    }
    return true;
  }

  batchAutoApprove(runId: string, req: GateRequest): boolean {
    const b = this.batchFor(runId);
    const key = b?.approval?.keys.get(runId);
    if (!b?.approval || key === undefined) return false;
    b.approval.keys.delete(runId);
    const f = new Map<string, string>(req.fields.map((x) => [x.fieldKey, x.value]));
    const shape = (() => {
      try {
        return req.v === 2 && Array.isArray(req.fields) && gateSelfCheck(req) === null && Array.isArray(summarize(req, kstToday(this.clock())));
      } catch {
        return false;
      }
    })();
    const ok =
      shape &&
      this.clock() - b.approval.at <= BATCH_APPROVAL_MAX_MS &&
      ![...f.keys()].some((k) => k.startsWith('$dup.')) &&
      f.get('$first.bizNo') !== 'true' &&
      f.get('$first.email') !== 'true' &&
      gateKey(f) === key;
    if (!ok) {
      const r = this.runs.get(runId)!;
      this.step(r, 'gate', 'now', BATCH_REASK_NOTE);
      this.emit('update', r);
    }
    this.src.log?.('main.batch_gate', { auto: ok ? 'yes' : 'no' });
    return ok;
  }

  private batchHalt(b: Batch, why: string): void {
    b.approval = null;
    b.halted = true;
    for (const x of this.batchRuns(b.id)) {
      x.batch = { ...x.batch!, approved: false, halted: true };
      this.emit('update', x);
    }
    this.src.log?.('main.batch_halt', { code: why.slice(0, 60) });
  }

  private batchAfter(r: RunView, code: string | undefined): void {
    const b = this.batchFor(r.id);
    if (!b || b.halted) return;
    if (r.status === 'stopped' || r.inDoubt || RUN_HALT.test(code ?? '')) return this.batchHalt(b, code ?? r.status);
    if (!this.batchQueued(b).length) return;
    setImmediate(() => void this.batchNext(b.id));
  }

  private async batchNext(batchId: string, tries = 0): Promise<void> {
    const b = this.batches.get(batchId);
    const next = b && !b.halted && this.batchQueued(b)[0];
    if (!b || !next) return;
    const later = (ms: number) => {
      const t = setTimeout(() => void this.batchNext(batchId, tries + 1), ms);
      t.unref?.();
    };
    if (this.busy()) return tries < BATCH_BUSY_TRIES ? later(BATCH_BUSY_RETRY_MS) : this.batchHalt(b, 'busy');
    try {
      await (this.src.prepare ? this.src.prepare(next.id) : this.prepare(next.id));
    } catch (e) {
      const why = (e as Error).message ?? '';
      const wait = /^throttled\.[a-z]+:(\d+)$/.exec(why);
      if (wait) return tries < BATCH_BUSY_TRIES ? later(Number(wait[1]) * 1000 + 500) : this.batchHalt(b, 'throttled');
      if (why === 'busy') return tries < BATCH_BUSY_TRIES ? later(BATCH_BUSY_RETRY_MS) : this.batchHalt(b, 'busy');
      if (why === 'not_draft' || this.runs.get(next.id)?.status !== 'draft') return;
      b.approval?.keys.delete(next.id);
      next.batch = { ...next.batch!, skipped: true };
      next.notices = [...(next.notices ?? []).filter((x) => x !== BATCH_SKIPPED_NOTE), BATCH_SKIPPED_NOTE];
      this.emit('update', next);
      this.src.log?.('main.batch_skip', { why: why.slice(0, 60) });
      return this.batchNext(batchId, tries);
    }
  }

  restore(items: ResumeItem[]): RunView | null {
    const made: Array<{ d: RunView; it: ResumeItem }> = [];
    for (const it of items) {
      const cp = this.src.counterparties().find((c) => c.id === it.counterpartyId);
      if (!cp) continue;
      const d = this.createDraft(cp, it.amount, it.vat, it.item);
      if (it.email !== undefined && emailOk(it.email)) d.email = { value: it.email, first: false };
      d.resumedFrom = it.from;
      d.info = RESUMED_NOTE;
      made.push({ d, it });
    }
    const groups = new Map<string, RunView[]>();
    for (const { d, it } of [...made].sort((a, b) => (a.it.index ?? 0) - (b.it.index ?? 0))) if (it.batch) groups.set(it.batch, [...(groups.get(it.batch) ?? []), d]);
    for (const g of groups.values()) this.makeBatch(g.map((d) => d.id));
    for (const { d } of made) this.emit('update', d);
    this.src.log?.('main.run_restored', { count: String(made.length), dropped: String(items.length - made.length) });
    return made.find(({ d }) => !d.batch || d.batch.index === 0)?.d ?? null;
  }

  private wokeAt = Number.NEGATIVE_INFINITY;
  woke(): void {
    this.wokeAt = this.clock();
  }

  private wakeAfter(r: RunView, code: string | undefined): void {
    if (this.clock() - this.wokeAt > WAKE_RESUME_MS || r.batch || r.rehearsal || r.maintenance || r.status !== 'attention' || !r.redo || r.inDoubt || RUN_HALT.test(code ?? '') || r.wakeRestart) return;
    setImmediate(() => {
      let d: RunView;
      try {
        d = this.redraft(r.id);
      } catch {
        return;
      }
      d.resumedFrom = r.id;
      d.wakeRestart = true;
      d.info = WAKE_RESUMED_NOTE;
      this.emit('update', d);
      this.src.log?.('main.wake_restart', {});
      void (this.src.prepare ? this.src.prepare(d.id) : this.prepare(d.id)).catch((e: Error) => this.src.log?.('main.wake_restart_failed', { why: e.message.slice(0, 60) }));
    });
  }

  /**
   * 승인 전 일시 오류로 끝나면 같은 내용으로 한 번만 스스로 다시 한다(K-47: 실패하면 같은 방법으로 자동 1회).
   * 승인 뒤·확인 필요(in_doubt)·예행·묶음·증명서·이미 다시 한 실행은 하지 않는다.
   */
  private autoRetryAfter(r: RunView, code: string | undefined): void {
    if (r.status !== 'attention' || !r.redo || r.inDoubt || r.result || r.batch || r.rehearsal || r.cert || r.maintenance) return;
    if (r.autoRetryOf || r.certRetryOf || r.replaced || r.browserClosed || !TRANSIENT_END.test(code ?? '') || this.clock() - this.wokeAt <= WAKE_RESUME_MS) return;
    setImmediate(() => {
      let d: RunView;
      try {
        d = this.redraft(r.id);
      } catch {
        return;
      }
      d.autoRetryOf = r.id;
      d.resumedFrom = r.id;
      d.info = AUTO_RETRY_NOTE;
      this.emit('update', d);
      this.emit('restart', { from: r.id, to: d.id });
      this.src.log?.('main.auto_retry', { code: (code ?? '').slice(0, 60) });
      void (this.src.prepare ? this.src.prepare(d.id) : this.prepare(d.id)).catch((e: Error) => this.src.log?.('main.auto_retry_failed', { why: e.message.slice(0, 60) }));
    });
  }

  async prepare(id: string): Promise<RunView> {
    const r = this.mustDraft(id);
    const invoice = !r.cert && !r.amend;
    if (r.amend) {
      r.amend = amendCardToday(r.amend, dayOffset(0));
      this.syncAmend(r);
      if (!amendCardPlan(r.amend)?.ready) throw new Error('amend.not_ready');
    }
    if (invoice) {
      this.markDate(r);
      const error = invoiceDraftError(r);
      if (error) throw new Error(error);
    }
    if (this.busy()) throw new Error('busy');
    const noChrome = !!this.src.chromeReady && !this.src.chromeReady();
    if (noChrome || r.noChrome) {
      r.noChrome = noChrome;
      this.emit('update', r);
      if (noChrome) throw new Error('chrome.not_installed');
    }
    r.auth = this.src.auth();
    r.starting = undefined;
    this.to(r, 'preparing');
    this.step(r, 'login', 'now', LOGIN_NOW);
    this.emit('update', r);
    this.starting.add(r.id);
    try {
      await this.host.control('run.begin', { runId: r.id, trigger: 'local' });
      if (this.stopEarly.has(r.id)) {
        this.end(r, { status: 'stopped', code: 'run.stopped' });
        return r;
      }
      const rehearsal = r.rehearsal ? { rehearsal: true } : {};
      if (r.amend) await this.startAmend(r, rehearsal);
      else if (r.cert) await this.host.rpc('run.startCert', { runId: r.id, playbookId: r.cert.playbookId, inputs: r.cert.inputs, ...rehearsal });
      else await this.host.rpc('run.start', { runId: r.id, counterpartyId: r.counterparty.id, supply: r.supply, tax: r.tax, itemName: r.item, email: r.email.value || null, ...(r.writeDateSet ? { issueDate: r.writeDate } : {}), ...rehearsal });
      if (this.stopEarly.has(r.id)) await this.host.rpc('run.stop', { runId: r.id }).catch(() => {});
    } catch (e) {
      this.end(r, { status: 'failed', code: (e as Error).message });
    } finally {
      this.starting.delete(r.id);
      this.stopEarly.delete(r.id);
    }
    return r;
  }

  syncAuth(): void {
    const auth = this.src.auth();
    for (const r of this.runs.values()) {
      if (r.status !== 'draft' || r.auth === auth) continue;
      r.auth = auth;
      this.emit('update', r);
    }
  }

  redraft(id: string): RunView {
    // 같은 카드의 [다시 준비]를 또 눌러도 새 카드를 쌓지 않는다. 앞서 만든 카드가 아직 시작 전이거나 도는 중이면 그 카드를 돌려준다.
    const next = this.runs.get(this.nextOf.get(id) ?? '');
    if (next && (next.status === 'draft' || this.isActive(next.id))) return next;
    const r = this.runs.get(id);
    if (r?.cert && (r.status === 'done' || ((r.status === 'attention' || r.status === 'stopped') && !r.inDoubt))) return this.markRestarted(r, this.createCertDraft(r.cert.code, r.cert.inputs));
    if (!r || !r.redo || !(r.status === 'attention' || r.status === 'stopped')) throw new Error('not_redoable');
    if (r.amend) {
      const d = this.createAmend(r.amend.originals, r.amend.said);
      d.amend = amendCardToday({ ...r.amend }, dayOffset(0));
      this.syncAmend(d);
      return this.markRestarted(r, d);
    }
    const cp = this.src.counterparties().find((c) => c.id === r.counterparty.id);
    if (!cp) throw new Error('no_counterparty');
    const d = this.createDraft(cp, r.amount, r.vatGuessed ? null : r.vat, r.itemGuessed ? null : r.item);
    if (emailOk(r.email.value)) d.email = { value: r.email.value, first: false };
    return this.markRestarted(r, d);
  }

  private markRestarted(r: RunView, d: RunView): RunView {
    this.nextOf.set(r.id, d.id);
    if (r.maintenance) {
      r.maintenance.restartedAs = d.id;
      this.clearMaintenanceTimer(r.id);
      this.emit('update', r);
    }
    return d;
  }

  private readonly maintTimers = new Map<string, NodeJS.Timeout>();
  private clearMaintenanceTimer(id: string): void {
    clearTimeout(this.maintTimers.get(id));
    this.maintTimers.delete(id);
  }
  private maintenanceAfter(id: string, ms: number): void {
    this.clearMaintenanceTimer(id);
    const t = setTimeout(() => void this.maintenanceRestart(id), Math.max(0, ms));
    t.unref?.();
    this.maintTimers.set(id, t);
  }

  private maintenanceEnd(r: RunView, untilRaw: string | undefined): void {
    const at = maintenanceUntil(untilRaw, this.clock());
    r.maintenance = { until: at === null ? null : kstHm(at) };
    r.stoppedNote = at === null ? MAINTENANCE_UNKNOWN_NOTE : maintenanceNote(kstHm(at));
    if (at !== null) this.maintenanceAfter(r.id, at - this.clock() + MAINTENANCE_GRACE_MS);
    this.src.log?.('main.maintenance_end', { until: at === null ? 'unknown' : 'known' });
  }

  private async maintenanceRestart(id: string): Promise<void> {
    this.maintTimers.delete(id);
    const r = this.runs.get(id);
    if (!r?.maintenance || r.maintenance.restartedAs || r.status !== 'attention') return;
    if (this.busy()) return this.maintenanceAfter(id, MAINTENANCE_BUSY_RETRY_MS);
    let d: RunView | null = null;
    try {
      d = this.redraft(id);
      d.info = MAINTENANCE_RESTARTED_NOTE;
      this.emit('update', d);
      this.src.log?.('main.maintenance_restart', {});
      await (this.src.prepare ? this.src.prepare(d.id) : this.prepare(d.id));
    } catch (err) {
      const why = (err as Error).message ?? '';
      if (d && d.status === 'draft') {
        d.info = undefined;
        d.notices = [MAINTENANCE_RESTART_FAILED_NOTE];
        this.emit('update', d);
      } else if (!d) {
        r.maintenance = { until: null };
        r.stoppedNote = MAINTENANCE_UNKNOWN_NOTE;
        this.emit('update', r);
      }
      this.src.log?.('main.maintenance_restart_failed', { why: why.slice(0, 60) });
    }
  }

  async retryCert(id: string): Promise<RunView> {
    const r = this.runs.get(id);
    if (!r) throw new Error('no_run');
    if (r.status !== 'turn' || (r.handoff?.code !== CERT_LOGIN_FAILED && r.handoff?.code !== SIMPLE_SENT) || r.handoff.afterGate) throw new Error('not_cert_turn');
    this.certRetry.add(id);
    try {
      return await this.stop(id);
    } catch (e) {
      this.certRetry.delete(id);
      throw e;
    }
  }

  private certRetryAfter(r: RunView): void {
    if (!this.certRetry.delete(r.id) || r.inDoubt || r.result) return;
    r.redo = true;
    r.replaced = true;
    r.stoppedNote = '같은 내용으로 다시 로그인해요. 아무것도 발급하지 않았어요.';
    setImmediate(() => {
      let d: RunView;
      try {
        d = this.redraft(r.id);
      } catch (e) {
        this.src.log?.('main.cert_retry_failed', { why: (e as Error).message.slice(0, 60) });
        return;
      }
      d.certRetryOf = r.id;
      d.resumedFrom = r.id;
      d.info = CERT_RETRY_NOTE;
      this.emit('update', d);
      this.emit('restart', { from: r.id, to: d.id });
      void (this.src.prepare ? this.src.prepare(d.id) : this.prepare(d.id)).catch((e: Error) => this.src.log?.('main.cert_retry_failed', { why: e.message.slice(0, 60) }));
    });
  }

  async stop(id: string): Promise<RunView> {
    const r = this.runs.get(id);
    if (!r) throw new Error('no_run');
    if (r.status === 'draft') {
      this.to(r, 'stopped');
      r.starting = undefined;
      r.info = undefined;
      r.stoppedNote = '취소했어요.';
      this.emit('update', r);
      return r;
    }
    if (!['preparing', 'turn', 'waiting'].includes(r.status)) {
      if (r.status === 'issuing') throw new Error('already_issuing');
      return r;
    }
    if (this.starting.has(id)) {
      this.stopEarly.add(id);
      return r;
    }
    const res = (await this.host.rpc('run.stop', { runId: id })) as { stopped?: unknown } | null;
    if (r.status === 'turn' && r.handoff?.kind === 'sign' && res?.stopped === false) {
      r.notices = [...(r.notices ?? []), STOP_AFTER_SIGN_NOTE];
      this.leaveHandoff(r, 'issuing');
      this.step(r, 'sign', 'todo');
      this.step(r, 'verify', 'now');
      this.emit('update', r);
    }
    return r;
  }

  async resume(id: string): Promise<RunView> {
    const r = this.handedOff(id);
    refused(await this.host.rpc('run.resume', { runId: id }));
    this.leaveHandoff(r, r.handoff!.afterGate ? 'issuing' : 'preparing');
    return r;
  }

  async manualDone(id: string): Promise<RunView> {
    const r = this.handedOff(id);
    if (r.handoff!.kind === 'sign') throw new Error('sign.turn_resume_only');
    refused(await this.host.rpc('run.manualDone', { runId: id }));
    r.confirmed = true;
    for (const p of ['login', 'form', 'input', 'readback', 'gate', 'sign'] as const) if (r.steps[PHASES.indexOf(p)]!.state !== 'done') this.step(r, p, 'done', p === 'sign' ? '직접 발급하셨다고 알려 주셨어요' : undefined);
    this.step(r, 'verify', 'now');
    this.leaveHandoff(r, 'issuing');
    return r;
  }

  async simpleAuth(id: string, op: 'request' | 'complete', d?: { provider: string; name: string; birth: string; phone: string; carrier?: string }): Promise<RunView> {
    const r = this.handedOff(id);
    const code = r.handoff!.code;
    if (code !== CERT_LOGIN_FAILED && code !== SIMPLE_SENT) throw new Error('not_cert_turn');
    const res = (await this.host.rpc('run.simpleAuth', { runId: id, op, ...(op === 'request' && d ? d : {}) })) as { ok?: boolean; code?: string } | null;
    if (!res?.ok) {
      this.src.log?.('main.simple_auth', { op, result: String(res?.code ?? 'failed').slice(0, 40) });
      throw new Error(String(res?.code ?? 'simple.failed'));
    }
    this.src.log?.('main.simple_auth', { op, result: 'ok' });
    if (op === 'complete') {
      this.leaveHandoff(r, 'preparing');
      return r;
    }
    const app = d ? (SIMPLE_APP_LABEL[d.provider] ?? '인증 앱') : '인증 앱';
    r.handoff = { ...r.handoff!, code: SIMPLE_SENT };
    r.simpleAuth = { provider: d?.provider ?? '', deadline: this.clock() + SIMPLE_AUTH_MS };
    r.turn = { text: `${app}에서 승인해 주세요`, note: '5분 안에 승인하면 바로 이어서 발급해요.' };
    this.emit('update', r);
    return r;
  }

  private handedOff(id: string): RunView {
    const r = this.runs.get(id);
    if (!r) throw new Error('no_run');
    if (r.status !== 'turn' || !r.handoff) throw new Error('not_handed_off');
    return r;
  }

  private leaveHandoff(r: RunView, status: 'preparing' | 'issuing'): void {
    const ph = r.handoff!.phase as Phase;
    if (r.steps[PHASES.indexOf(ph)]!.state === 'attention') this.step(r, ph, 'now');
    r.handoff = null;
    r.turn = null;
    r.simpleAuth = undefined;
    this.to(r, status);
    this.emit('update', r);
  }

  approved(runId: string, noteText = '승인했어요. 2초 안에 [중지]하면 발급하지 않아요'): void {
    const r = this.runs.get(runId);
    if (!r || r.status !== 'waiting') return;
    r.approvedPending = true;
    this.step(r, 'gate', 'now', noteText);
    this.emit('update', r);
  }

  async onAnswer(runId: string, r: GateAnswerResult): Promise<void> {
    if (r.ok || r.verdict === 'unknown') return;
    if (r.verdict === 'engine' && RACED.has(r.code ?? '')) return this.answerNotTaken(runId);
    await this.abortGate(runId, 'answer.rejected');
  }

  answerNotTaken(runId: string, note = '승인이 반영되지 않았어요'): void {
    const r = this.runs.get(runId);
    if (!r || r.status !== 'waiting') return;
    r.approvedPending = false;
    this.step(r, 'gate', 'now', note);
    this.emit('update', r);
  }

  async abortGate(runId: string, code: string): Promise<void> {
    if (!this.runs.has(runId)) return;
    this.answerNotTaken(runId, '승인을 전하지 못해 멈추고 있어요');
    this.endCodes.set(runId, code);
    await this.host.rpc('run.stop', { runId }).catch(() => {});
  }

  /** 상태를 바꾸는 유일한 곳. RUN_STATUS_NEXT에 없는 전이는 하지 않고 로그에 남긴다. */
  private to(r: RunView, next: RunStatus): boolean {
    if (!RUN_STATUS_NEXT[r.status].includes(next)) {
      this.src.log?.('main.run_illegal_status', { from: r.status, to: next });
      return false;
    }
    r.status = next;
    return true;
  }

  private step(r: RunView, phase: Phase, state: StepState, noteText?: string): void {
    const i = PHASES.indexOf(phase);
    const label = STEP_LABELS[r.doc][i];
    if (label !== undefined) r.steps[i] = { label, state, note: noteText ?? (state === 'now' ? (STEP_NOW[r.doc][i] ?? undefined) : undefined) };
  }

  private onEngine(e: EngineEvent): void {
    const r = this.runs.get(e.runId);
    if (!r) return;
    if (e.type === 'phase') {
      const n = e.phase === 'sign' && e.state === 'now' ? (r.cert ? undefined : (signFor(r.auth)?.now ?? SIGN_NOW_DEFAULT)) : e.phase === 'login' && e.state === 'now' ? LOGIN_NOW : e.code ? NOTE[e.code] : undefined;
      this.step(r, e.phase, e.state === 'attention' ? 'attention' : e.state, n);
      if (e.phase === 'verify' && Number.isSafeInteger(e.attempt) && e.attempt! > 0) {
        r.verifyAttempt = e.attempt;
        if (!r.cert && r.steps[i6()]?.state === 'now') r.steps[i6()]!.note = verifyNow(e.attempt);
      }
      if (['sign', 'verify', 'mail'].includes(e.phase) && r.status === 'waiting') {
        this.to(r, 'issuing');
        r.approvedPending = false;
        this.step(r, 'gate', 'done');
      }
      this.emit('update', r);
      return;
    }
    if (e.type === 'waiting') return;
    if (e.type === 'state') return this.onState(r, e);
    if (e.type === 'regate') {
      if (!isRegate(e.reason) || !['preparing', 'turn', 'waiting'].includes(r.status)) return;
      r.regate = { reason: e.reason, note: REGATE_NOTE[e.reason] };
      this.emit('update', r);
      return;
    }
    if (e.type === 'handoff') {
      if (!PHASES.includes(e.phase) || !['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)) return;
      const i = PHASES.indexOf(e.phase);
      const afterGate = i > PHASES.indexOf('gate');
      const t = handoffTurn(e.phase, e.code, r.auth, STEP_LABELS[r.doc]);
      this.to(r, 'turn');
      if (!afterGate) r.approvedPending = false;
      r.handoff = { phase: e.phase, afterGate, kind: t.kind, ...(e.code ? { code: e.code } : {}) };
      r.turn = { text: t.text, note: t.note };
      if (e.code === CERT_LOGIN_FAILED && !r.certRetryOf && !r.batch && !r.rehearsal && i < PHASES.indexOf('gate')) {
        this.to(r, 'preparing');
        r.handoff = null;
        r.turn = null;
        this.step(r, e.phase, 'now', '공동인증서로 다시 로그인하는 중');
        this.emit('update', r);
        this.src.log?.('main.cert_retry', { why: 'auto' });
        this.certRetry.add(r.id);
        void this.stop(r.id).catch((x: Error) => {
          this.certRetry.delete(r.id);
          this.src.log?.('main.cert_retry_failed', { why: x.message.slice(0, 60) });
        });
        return;
      }
      if (e.code === CERT_LOGIN_FAILED) {
        r.turn = { text: CERT_FAILED_TWICE.text, note: CERT_FAILED_TWICE.note };
        if (r.info === CERT_RETRY_NOTE) r.info = undefined;
      }
      this.step(r, e.phase, 'attention', t.kind === 'sign' ? '홈택스 창에서 서명 중' : e.code === CERT_LOGIN_FAILED ? undefined : '직접 해 주세요');
      this.emit('update', r);
      return;
    }
    if (e.type === 'issued') {
      if (r.cert || r.rehearsal || !e.approvalNo || !['issuing', 'turn', 'preparing', 'waiting'].includes(r.status)) return;
      this.to(r, 'done');
      r.settling = true;
      r.turn = null;
      r.handoff = null;
      r.approvedPending = false;
      r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'done', note: undefined } : s));
      r.result = { approvalNo: e.approvalNo, mailTo: r.email.value, docId: issuedDoc(r).id, doneAt: hm(), mailConfirmed: false, noFile: true };
      this.emit('update', r);
      return;
    }
    if (e.type === 'secret') {
      if (e.state !== 'open' || !['preparing', 'turn', 'issuing'].includes(r.status)) return;
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      if (now >= 0) r.steps[now] = { ...r.steps[now]!, note: '앱에 뜬 창에 인증서 비밀번호를 넣어 주세요' };
      this.emit('update', r);
      return;
    }
    if (e.type === 'notice') {
      const text = typeof e.text === 'string' ? cleanNotice(e.text) : '';
      if (!text || !['preparing', 'turn', 'waiting', 'issuing'].includes(r.status)) return;
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      const line = { step: now >= 0 ? now : PHASES.indexOf('input'), text: `${NOTICE_LABEL[e.key ?? ''] ?? '홈택스 안내'}: ${text}`, ok: e.ok === true };
      r.portalChecks = [...(r.portalChecks ?? []).filter((c) => c.text !== line.text), line];
      this.emit('update', r);
      return;
    }
    if (e.type !== 'end') return this.src.log?.('main.run_event_ignored', { type: String((e as { type?: unknown }).type).slice(0, 40) });
    this.end(r, e);
  }

  private onState(r: RunView, e: { state: RunState; code?: string; portalNotice?: string }): void {
    const live = this.liveInDoubt.has(r.id) || this.paused.has(r.id);
    if (!RUN_STATES.includes(e.state) || ['draft', 'done', 'stopped'].includes(r.status) || (r.status === 'attention' && !live)) return;
    if (typeof e.portalNotice === 'string' && e.portalNotice.trim()) r.notices = [...new Set([...(r.notices ?? []), portalNoticeText(e.portalNotice)])];
    if (e.state === 'in_doubt') {
      this.liveInDoubt.add(r.id);
      r.turn = null;
      r.approvedPending = false;
      r.handoff = null;
      r.inDoubt = true;
      this.to(r, 'attention');
      r.stoppedNote = note(IN_DOUBT_NOTE.has(e.code ?? '') ? e.code : BLOCK_CODES.has(e.code ?? '') ? 'portal.blocked_in_doubt' : 'in_doubt', r);
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      if (now >= 0) r.steps[now] = { ...r.steps[now]!, state: 'attention', note: undefined };
    } else if (e.state === 'running') {
      if (!this.liveInDoubt.has(r.id) && !this.paused.has(r.id)) return;
      this.liveInDoubt.delete(r.id);
      this.paused.delete(r.id);
      r.inDoubt = false;
      r.attest = null;
      r.stoppedNote = undefined;
      this.to(r, 'preparing');
      r.confirmed = false;
      for (const p of ['gate', 'sign', 'verify', 'mail'] as const) this.step(r, p, 'todo');
    } else if (e.state === 'paused') {
      this.liveInDoubt.delete(r.id);
      this.paused.add(r.id);
      r.inDoubt = false;
      r.turn = null;
      this.to(r, 'attention');
      r.stoppedNote = note(e.code ?? 'run.paused', r);
    } else return;
    this.emit('update', r);
  }

  private end(r: RunView, e: { status: string; code?: string; approvalNo?: string; mailConfirmed?: boolean; portalNotice?: string; maintenanceUntil?: string; until?: string }): void {
    const live = this.liveInDoubt.delete(r.id) || this.paused.delete(r.id);
    const settling = r.settling === true;
    r.settling = false;
    if (!live && !settling && ['draft', 'done', 'stopped', 'attention'].includes(r.status)) return;
    r.info = undefined;
    if (settling && !((e.status === 'success' || e.status === 'completed_with_issues') && e.approvalNo)) {
      void this.host.control('run.end', { runId: r.id }).catch(() => {});
      this.src.log?.('main.run_end', { status: e.status, code: (e.code ?? 'none').slice(0, 80) });
      r.endedAt = this.clock();
      this.emit('update', r);
      return;
    }
    if (live) {
      r.inDoubt = false;
      r.attest = null;
    }
    void this.host.control('run.end', { runId: r.id }).catch(() => {});
    const past = pastGate(r);
    const lastTurn = r.turn;
    r.turn = null;
    r.handoff = null;
    r.approvedPending = false;
    if (typeof e.portalNotice === 'string' && e.portalNotice.trim()) r.notices = [...(r.notices ?? []), portalNoticeText(e.portalNotice)];
    const code = e.status === 'in_doubt' ? (IN_DOUBT_NOTE.has(e.code ?? '') ? e.code : BLOCK_CODES.has(e.code ?? '') ? 'portal.blocked_in_doubt' : 'in_doubt') : (this.endCodes.get(r.id) ?? e.code);
    this.endCodes.delete(r.id);
    this.src.log?.('main.run_end', { status: e.status, code: (code ?? 'none').slice(0, 80) });
    if ((e.status === 'success' || e.status === 'completed_with_issues') && (e.approvalNo || r.cert)) {
      const doc = issuedDoc(r);
      this.to(r, 'done');
      r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'done', note: undefined } : s));
      r.result = { approvalNo: e.approvalNo ?? '', mailTo: r.email.value, docId: doc.id, doneAt: hm(), mailConfirmed: e.mailConfirmed === true, noFile: e.code === 'save_pdf.failed' };
      if (!r.cert && !e.mailConfirmed) {
        this.step(r, 'mail', 'attention', r.email.value ? NOTE['mail.not_confirmed'] : '받는 이메일이 없어 보내지 않았어요');
        if (r.email.value) r.warnings = [NOTE['mail.not_confirmed']!];
      }
      if (e.code === 'portal.blocked_after_commit') r.warnings = [...r.warnings, NOTE['portal.blocked_after_commit']!];
      if (e.code === 'save_pdf.failed') r.warnings = [...r.warnings, note('save_pdf.failed', r)];
      this.emit('doc', doc);
    } else if (e.status === 'stopped' || e.status === 'expired') {
      this.to(r, 'stopped');
      r.stoppedNote = note(code, r);
      if (TIMED_OUT.has(code ?? '') && !past && !r.rehearsal) r.redo = true;
      if (r.rehearsal && code === 'rehearsal.handoff') {
        const at = r.steps.findLast((s) => s.state === 'attention' || s.state === 'now');
        const what = lastTurn?.text ? `(${lastTurn.text.replace(/[.。]$/, '')})` : '';
        r.stoppedNote = `${at ? `'${at.label}' 단계에서 사람이 할 일이 생겨 멈췄어요${what}. 예행은 기다리지 않아서 발급하지 않았어요.` : NOTE['rehearsal.handoff']} ${REHEARSAL_NEXT}`;
      }
    } else {
      this.to(r, 'attention');
      r.stoppedNote = note(code, r);
      if (code === 'package.app_old') r.endCode = code;
      r.inDoubt = e.status === 'in_doubt';
      r.redo = !r.inDoubt && !past;
      if (code === MAINTENANCE_CODE && !r.inDoubt && !past) this.maintenanceEnd(r, e.maintenanceUntil ?? e.until);
      else if (e.status === 'handoff' && !past) {
        r.handoffEnd = true;
        const base = code && NOTE[code] ? NOTE[code]! : HANDOFF_END_NOTE;
        r.stoppedNote = `${base}${/아무것도 발급하지 않았어요/.test(base) ? '' : ' 아무것도 발급하지 않았어요.'} ${HANDOFF_END_NEXT}`;
      }
      const now = r.steps.findLastIndex((s) => s.state === 'now');
      if (now >= 0) r.steps[now] = { ...r.steps[now]!, state: 'attention', note: undefined };
    }
    r.steps = r.steps.map((s) => (s.state === 'now' ? { ...s, state: 'todo', note: undefined } : s));
    r.endedAt = this.clock();
    if (!r.result && !r.inDoubt && !past && (r.browserClosed || this.clock() - this.goneAt < 10_000)) this.markClosed(r);
    this.batchAfter(r, code);
    this.certRetryAfter(r);
    this.emit('update', r);
    this.wakeAfter(r, code);
    this.autoRetryAfter(r, code);
  }

  reverified(runId: string, approvalNo: string): void {
    const r = this.runs.get(runId);
    if (!r || !r.inDoubt || r.status !== 'attention' || this.liveInDoubt.has(r.id)) return;
    r.inDoubt = false;
    r.attest = null;
    this.to(r, 'done');
    r.stoppedNote = undefined;
    r.steps = r.steps.map((s) => (s.state === 'attention' ? { ...s, state: 'done', note: undefined } : s));
    const doc = issuedDoc(r);
    r.result = { approvalNo, mailTo: r.email.value, docId: doc.id, doneAt: hm(), mailConfirmed: false, noFile: true };
    if (r.email.value) r.warnings = [NOTE['mail.not_confirmed']!];
    this.emit('doc', doc);
    this.emit('update', r);
  }

  private onGate(req: GateRequest): void {
    const r = this.runs.get(req.runId);
    if (!r || !['preparing', 'turn'].includes(r.status)) return;
    const f = new Map(req.fields.map((x) => [x.fieldKey, x.value]));
    if (r.cert) {
      const before = `${r.cert.inputs.purpose}|${r.cert.inputs.submitTo}`;
      r.cert = { ...r.cert, inputs: { ...r.cert.inputs, purpose: f.get('certPurpose') ?? '', submitTo: f.get('certSubmitTo') ?? '' } };
      r.readbackDiffers = before !== `${r.cert.inputs.purpose}|${r.cert.inputs.submitTo}`;
      r.warnings = dupWarnings(req, CERT_DUP_NOTE);
      return this.gateOpened(r, req);
    }
    this.readbacks.set(r.id, new Map(req.fields.map((x) => [String(x.fieldKey), String(x.value)])));
    const num = (k: string) => Number(f.get(k as never) ?? NaN);
    const before = { name: r.counterparty.name, bizNo: r.counterparty.bizNo, email: r.email.value, supply: r.supply, tax: r.tax, item: r.item };
    r.counterparty = { ...r.counterparty, name: f.get('counterpartName') ?? '', bizNo: f.get('counterpartBizNo') ?? '', first: f.get('$first.bizNo') === 'true' };
    r.email = { value: f.get('counterpartEmail') ?? '', first: f.get('$first.email') === 'true' };
    r.supply = num('supplyAmount');
    r.tax = num('taxAmount');
    r.total = num('totalAmount');
    r.item = f.get('itemName') ?? '';
    r.writeDate = f.get('issueDate') ?? r.writeDate;
    const after = { name: r.counterparty.name, bizNo: r.counterparty.bizNo, email: r.email.value, supply: r.supply, tax: r.tax, item: r.item };
    r.readbackDiffers = JSON.stringify(before) !== JSON.stringify(after);
    r.warnings = dupWarnings(req);
    this.gateOpened(r, req);
  }

  private gateOpened(r: RunView, req: GateRequest): void {
    r.confirmed = true;
    r.action = actionText(req);
    this.to(r, 'waiting');
    for (const p of ['login', 'form', 'input', 'readback'] as const) if (r.steps[PHASES.indexOf(p)]!.state !== 'done') this.step(r, p, 'done');
    this.step(r, 'gate', 'now', '아래 [승인하고 발급]을 기다려요');
    this.emit('update', r);
    this.emit('gate', r.id, req);
  }
}
