import fs from 'node:fs';
import path from 'node:path';
import type { PackageFiles, SelectorEntry, Step } from '@sax/engine/core';
import { AMEND_HOMETAX, AMEND_READY, AMEND_WHATS } from '../../packages/chat-core/src/amend.ts';

/**
 * 수정세금계산서 패키지 hometax.invoice.amend(ADR-058 결정 1, 6). 로그인, 발급 확인, 인증, 서명, 완료 창, 확정 조회는
 * 발급 패키지(hometax.invoice.issue)와 같은 화면이라 그 스텝과 셀렉터를 그대로 가져온다. 수정발급 1, 2단계는 2026-11-24,
 * 3단계 작성 화면과 수정 미리보기 창은 2026-11-25 맥북 실측이다(사유 다섯 가지, 발급하기는 누르지 않았다).
 * 손으로 고치지 말고 이 파일을 고친 뒤 `node --conditions=development scripts/gen-amend-playbook.ts`로 다시 만든다.
 */
export const AMEND_ID = 'hometax.invoice.amend';
export const AMEND_VERSION = '1.1.0';
const VERIFIED = '2026-11-24';
const FORM_VERIFIED = '2026-11-25';
/** 수정발급 1단계 주소(실측). 처음에는 메뉴를 눌러 들어가고, 이 주소는 발급 확인이 끝나지 않았을 때 다시 열 때만 쓴다. */
const AMEND_URL = 'https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=46&tm2lIdx=4601010000&tm3lIdx=4601010400';

const H01_DIR = path.resolve(import.meta.dirname, '../../packages/engine/playbooks/hometax.invoice.issue');
const LOGIN_STEPS = ['s0', 's2', 's3', 's4', 's4a', 's4b', 's4c', 's8', 's8a', 's8b', 's4d', 's4e', 's4f', 's4g', 's4h', 's5', 's6', 's7', 's7a', 's7b', 's7c', 's7d', 's7e', 's7f', 's7g'];
const STRINGS = ['login.loggedIn', 'hometax.login.successMarker', 'form.amountShown', 'counterpart.bizNoOk', 'cert.passwordPrompt', 'cert.pickOne', 'login.certNoticeWindow', 'login.simpleAuth', 'popup.hide', 'popup.hide.idPrefix', 'popup.hide.cookie', 'popup.window.close', 'card.window', 'card.ok', 'card.wrong', 'card.locked'];

/** 1차에 여는 사유(내국신용장은 2차). 사유 값은 카드에서 사장님이 누른 것만 온다. */
export const AMEND_RUN_WHATS = AMEND_WHATS.filter((w) => AMEND_READY[w]);

const REASON_BUTTON: Record<string, { key: string; id: string }> = {
  wrong_entry: { key: 'hometax.amend.reason.wrongEntry', id: 'textbox973' },
  duplicate: { key: 'hometax.amend.reason.duplicate', id: 'textbox948' },
  local_lc: { key: 'hometax.amend.reason.localLc', id: 'textbox964' },
  amount_changed: { key: 'hometax.amend.reason.amountChanged', id: 'textbox952' },
  deal_cancelled: { key: 'hometax.amend.reason.dealCancelled', id: 'textbox956' },
  returned: { key: 'hometax.amend.reason.returned', id: 'textbox960' },
};

const FORM = 'hometax.invoice.form.root';
const ent = (css: string, role: string, extra: Partial<SelectorEntry> & { namePattern?: string } = {}, verified = VERIFIED): SelectorEntry => ({
  candidates: [{ kind: 'css', value: css }], role, namePattern: '^.{0,60}$', frame: 'main', landmark: FORM, commits: false, lastVerified: verified, ...extra,
} as SelectorEntry);
const typed = { inputType: 'text', expect: { visible: true, enabled: true, editable: true } } as const;

function amendEntries(): Record<string, SelectorEntry> {
  const P = '#mf_txppWframe_';
  const out: Record<string, SelectorEntry> = {
    'hometax.menu.amend': ent('#menuAtag_4601010400', 'link', { landmark: 'hometax.page.root', namePattern: '^(전자\\(세금\\)계산서 수정발급)?$', inputType: 'button', reviewNote: { by: 'amend-package', reason: '상단 메뉴 링크(직접 주소 이동은 로그아웃을 일으킨다, 2026-11-24 실측)' } } as never),
    'hometax.amend.aprvNo': ent(`${P}edtAprvNo1`, 'textbox', { namePattern: '^(승인번호를 입력해 주세요\\.)?$', ...typed }),
    'hometax.amend.aprvConfirm': ent(`${P}grp1030`, 'link', { namePattern: '^(확인)?$', inputType: 'button', reviewNote: { by: 'amend-package', reason: '승인번호로 당초분을 찾는다(조회, 커밋 요청 없음). 승인번호가 비면 조회 화면 UTEETBAA27로 간다' } } as never),
  };
  for (const [what, b] of Object.entries(REASON_BUTTON)) {
    out[b.key] = ent(`${P}${b.id}`, 'link', { namePattern: '^(발급하기)?$', inputType: 'button', reviewNote: { by: 'amend-package', reason: `수정발급 사유 [발급하기](${AMEND_HOMETAX[what as keyof typeof AMEND_HOMETAX]}). 작성 화면을 연다(커밋 요청 없음)` } } as never);
  }
  const form = (css: string, role: string, extra: Partial<SelectorEntry> = {}) => ent(css, role, extra, FORM_VERIFIED);
  const shown = { inputType: 'text', expect: { visible: true, enabled: true } } as const;
  // 사유 안내 창(공급가액 변동의 증가와 감소, 계약의 해제의 확인)은 같은 창 mdfRsnMsgPopup이다.
  const NOTICE = 'hometax.amend.notice.root';
  const W = `${P}mdfRsnMsgPopup_wframe_`;
  Object.assign(out, {
    [NOTICE]: form(`${P}mdfRsnMsgPopup`, 'generic', { namePattern: '^$', landmark: NOTICE, expect: { visible: true } }),
    'hometax.amend.change.increase': form(`${W}trigger23`, 'button', { landmark: NOTICE, namePattern: '^(증가)?$', inputType: 'button' }),
    'hometax.amend.change.decrease': form(`${W}trigger24`, 'button', { landmark: NOTICE, namePattern: '^(감소)?$', inputType: 'button' }),
    'hometax.amend.cancel.confirm': form(`${W}trigger20`, 'button', { landmark: NOTICE, namePattern: '^(확인)?$', inputType: 'button', reviewNote: { by: 'amend-package', reason: '계약의 해제 안내 창 [확인]. 작성 화면을 연다(커밋 요청 없음)' } }),
    // 작성 화면 위쪽(당초분): 당초 승인번호와 공급받는자 번호는 글로만 보인다.
    'hometax.amend.form.originalApprovalNo': form(`${P}edtTfstAprvNo`, 'generic', { namePattern: '^.{0,40}$' }),
    'hometax.amend.form.originalBizNo': form(`${P}edtDmnrBsnoDispTop`, 'generic', { namePattern: '^.{0,20}$', fieldKey: 'originalCounterpartBizNo' }),
    'hometax.amend.form.cancelTotal': form(`${P}edtTotaAmtTop`, 'generic', { namePattern: '^.{0,30}$', fieldKey: 'cancelTotalAmount', inputType: 'number' }),
    'hometax.amend.form.writeDate': form(`${P}calWrtDtTop_input`, 'textbox', { namePattern: '^(날짜 입력)?$', ...shown }),
    // 기재사항 착오 정정의 아래쪽(새로 작성하는 계산서). 위쪽은 당초분 취소로 홈택스가 채우고 잠근다.
    'hometax.amend.new.counterpartBizNo': form(`${P}edtDmnrTxprNoBot`, 'textbox', shown),
    'hometax.amend.new.bizNoConfirm': form(`${P}btnDmnrBsnoCnfrBot`, 'button', { namePattern: '^(확인)?$', inputType: 'button', reviewNote: { by: 'amend-package', reason: '새 계산서 공급받는자 등록번호 확인(조회, 커밋 요청 없음)' } } as never),
    'hometax.amend.new.writeDate': form(`${P}calWrtDtBot_input`, 'textbox', { namePattern: '^(날짜 입력)?$', ...shown }),
    'hometax.amend.new.item1.day': form(`${P}genEtxivLsatBot_0_edtLsatSplDdBot`, 'textbox', shown),
    'hometax.amend.new.item1.name': form(`${P}genEtxivLsatBot_0_edtLsatNmBot`, 'textbox', shown),
    'hometax.amend.new.item1.supply': form(`${P}genEtxivLsatBot_0_edtLsatSplCftBot`, 'textbox', { ...shown, inputType: 'number' }),
    'hometax.amend.new.total': form(`${P}edtTotaAmtBot`, 'generic', { namePattern: '^.{0,30}$' }),
  });
  return out;
}

/**
 * 수정 미리보기 창(mdfIsnPreviewPopup)의 칸. 건별발급 미리보기(isnPreviewPopup)와 창 id와 칸 앞머리(wfNN_)가 다르다.
 * 기재사항 착오 정정은 두 장(위 wf01~wf06 당초분 취소, 아래 wf11~wf16 새 계산서)을 같이 보여 주고, 되읽기와 확정 조회는 새 계산서를 본다.
 * 그래서 아래 칸을 먼저 찾고 위 칸을 읽는다. 다른 사유에서 아래 칸은 비어 있어 보이지 않으므로(크기 0) '보이는 것만' 조건으로 건너뛴다.
 * 비어 있을 수 있는 칸(대표자, 주소, 이메일)은 이 방법을 쓰면 위 칸마저 못 찾으므로 위 칸만 읽는다. 잘못 적음에서 이 셋은 당초분 취소 장의 값이다.
 */
const PREVIEW: Record<string, readonly [top: string, bot: string | null]> = {
  'hometax.invoice.preview.supplierBizNo': ['wf01_edtSplrTxprNoTop', 'wf11_edtSplrTxprNoBot'],
  'hometax.invoice.preview.supplierName': ['wf01_edtSplrTnmNmTop', 'wf11_edtSplrTnmNmBot'],
  'hometax.invoice.preview.counterpartBizNo': ['wf02_edtDmnrTxprNoTop', 'wf12_edtDmnrTxprNoBot'],
  'hometax.invoice.preview.counterpartName': ['wf02_edtDmnrTnmNmTop', 'wf12_edtDmnrTnmNmBot'],
  'hometax.invoice.preview.counterpartRepName': ['wf02_edtDmnrRprsFnmTop', null],
  'hometax.invoice.preview.counterpartAddress': ['wf02_edtDmnrPfbAdrTop', null],
  'hometax.invoice.preview.counterpartEmail': ['wf02_edtDmnrEmlAdr1Top', null],
  'hometax.invoice.preview.issueDate': ['wf04_edtWrtDtTop', 'wf14_edtWrtDtBot'],
  'hometax.invoice.preview.supplyAmount': ['wf04_edtSumSplCftTop', 'wf14_edtSumSplCftBot'],
  'hometax.invoice.preview.taxAmount': ['wf04_edtSumTxamtTop', 'wf14_edtSumTxamtBot'],
  'hometax.invoice.preview.totalAmount': ['wf06_edtTotaAmtTop', 'wf16_edtTotaAmtBot'],
  'hometax.invoice.preview.receiptType': ['wf06_edtRecApeClCdTop', 'wf16_edtRecApeClCdBot'],
  'hometax.invoice.preview.itemName': ['wf05_genLsat2000Top_0_edtLsatNmTop', 'wf15_genLsat2000Bot_0_edtLsatNmBot'],
  'hometax.invoice.preview.issueButton': ['btnProcessView', null],
};

function previewEntries(h01: Record<string, SelectorEntry>): Record<string, SelectorEntry> {
  const P = '#mf_txppWframe_';
  const Q = `${P}mdfIsnPreviewPopup_wframe_`;
  const out: Record<string, SelectorEntry> = {
    'hometax.invoice.preview.root': { ...h01['hometax.invoice.preview.root']!, candidates: [{ kind: 'css', value: `${P}mdfIsnPreviewPopup` }], lastVerified: FORM_VERIFIED },
    // 두 장이면 품목 줄도 두 장 것을 센다(당초분 취소 1줄 + 새 계산서 줄).
    'hometax.invoice.preview.itemCount': { ...h01['hometax.invoice.preview.itemCount']!, candidates: [{ kind: 'css', value: `${P}mdfIsnPreviewPopup_wframe` }], countOf: '[id$="_edtLsatNmTop"], [id$="_edtLsatNmBot"]', lastVerified: FORM_VERIFIED },
    'hometax.amend.preview.reason': ent(`${Q}wf04_edtMdfRsnTop`, 'generic', { namePattern: '^$', landmark: 'hometax.invoice.preview.root', fieldKey: 'amendReason', inputType: 'text' }, FORM_VERIFIED),
  };
  for (const [k, [top, bot]] of Object.entries(PREVIEW)) {
    const e = { ...h01[k]! };
    delete e.readbackOf;
    // 공급받는자 번호: 발급은 작성 칸을 되읽고 미리보기를 표시로 대조하지만, 수정 작성 화면은 번호가 글(잘못 적음은 아래 칸)이라 미리보기를 되읽는다.
    const fieldKey = k === 'hometax.invoice.preview.counterpartBizNo' ? 'counterpartBizNo' : e.fieldKey;
    out[k] = {
      ...e, ...(fieldKey ? { fieldKey } : {}), lastVerified: FORM_VERIFIED, ...(bot ? { expect: { visible: true } } : {}),
      candidates: [...(bot ? [{ kind: 'css' as const, value: `${Q}${bot}` }] : []), { kind: 'css' as const, value: `${Q}${top}` }],
    };
  }
  return out;
}

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(H01_DIR, f), 'utf8'));

const jump = (id: string, to: string): Step => ({ id, type: 'branch', on: { inputPresent: 'originalApprovalNo' }, cases: { true: to }, default: to } as Step);
const when = (id: string, what: string, to: string, otherwise: string): Step => ({ id, type: 'branch', on: { inputEquals: { name: 'what', value: what } }, cases: { true: to }, default: otherwise } as Step);
const fill = (id: string, target: string, value: string): Step => ({ id, type: 'fill', target, value, keyEvents: true } as Step);
const click = (id: string, target: string): Step => ({ id, type: 'click', target } as Step);
const waitSel = (id: string, value: string, extra: Record<string, unknown> = {}): Step => ({ id, type: 'wait', for: 'selector', value, timeoutMs: 30000, ...extra } as Step);
const idle = (id: string): Step => ({ id, type: 'wait', for: 'gone', value: 'hometax.common.processing', timeoutMs: 30000 } as Step);
export function amendPackage(): PackageFiles {
  const h01 = { playbook: read('playbook.json'), selectors: read('selectors.json'), strings: read('strings.ko.json'), manifest: read('manifest.json') };
  const byId = (id: string): Step => {
    const s = (h01.playbook.steps as Step[]).find((x) => x.id === id);
    if (!s) throw new Error(`H-01에 스텝이 없다: ${id}`);
    return structuredClone(s);
  };
  const reasonClick = (what: string, id: string): Step => click(id, REASON_BUTTON[what]!.key);
  const totalShown = (id: string, target: string): Step => ({ id, type: 'repeat', max: 10, until: { textMatches: { target, patternRef: 'form.amountShown' } }, steps: [{ id: `${id.slice(0, -1)}z`, type: 'wait', for: 'idle', timeoutMs: 3000 }], onFail: { retry: 0, then: 'handoff' } } as Step);
  const steps: Step[] = [
    ...LOGIN_STEPS.map(byId),
    click('s10', 'hometax.menu.amend'),
    waitSel('s10a', 'hometax.amend.aprvNo'),
    { id: 's11', type: 'checkpoint', name: 'amend', expect: { exists: 'hometax.amend.aprvNo' }, url: AMEND_URL, sessionRequired: true, reentry: 'reload' } as Step,
    idle('s11a'),
    fill('s12', 'hometax.amend.aprvNo', '$inputs.originalApprovalNo'),
    click('s13', 'hometax.amend.aprvConfirm'),
    waitSel('s13a', REASON_BUTTON.wrong_entry!.key, { code: 'amend.original_not_found', onFail: { retry: 0, then: 'abort' } }),
    idle('s13b'),
    when('s14', 'wrong_entry', 's40', 's14a'),
    when('s14a', 'duplicate', 's45', 's14b'),
    when('s14b', 'amount_changed', 's50', 's14c'),
    when('s14c', 'deal_cancelled', 's55', 's14d'),
    when('s14d', 'returned', 's60', 's14e'),
    { id: 's14e', type: 'end', status: 'failed', code: 'amend.reason_unsupported' } as Step,
    // ② 사유 [발급하기]와 뜨는 창
    reasonClick('wrong_entry', 's40'), jump('s40a', 's16'),
    reasonClick('duplicate', 's45'), jump('s45a', 's16'),
    reasonClick('amount_changed', 's50'),
    waitSel('s50a', 'hometax.amend.notice.root', { timeoutMs: 15000 }),
    { id: 's50b', type: 'branch', on: { inputEquals: { name: 'direction', value: 'increase' } }, cases: { true: 's50c' }, default: 's50e' } as Step,
    click('s50c', 'hometax.amend.change.increase'), jump('s50d', 's16'),
    click('s50e', 'hometax.amend.change.decrease'), jump('s50f', 's16'),
    reasonClick('deal_cancelled', 's55'),
    waitSel('s55a', 'hometax.amend.notice.root', { timeoutMs: 15000 }),
    click('s55b', 'hometax.amend.cancel.confirm'), jump('s55c', 's16'),
    reasonClick('returned', 's60'), jump('s60a', 's16'),
    // ③ 작성 화면: 당초분 되읽기(되읽기 1). 당초 승인번호와 작성일자는 비고 글에 들어 있어 미리보기에서 대조한다.
    waitSel('s16', 'hometax.amend.form.originalApprovalNo'),
    idle('s16a'),
    // 작성 화면은 들어온 뒤 공급자 정보를 늦게 채운다(건별발급과 같다). 값을 넣지 않는 사유(두 번 발급)는 바로 미리보기로 가므로 공급자 등록번호가 뜰 때까지 기다린다.
    { id: 's16d', type: 'wait', for: 'text', value: 'form.supplierInBody', timeoutMs: 30000 } as Step,
    { id: 's16b', type: 'readback', fields: ['originalCounterpartBizNo'] } as Step,
    { id: 's16c', type: 'assert', code: 'assert.original_mismatch', onFail: { retry: 0, then: 'abort' }, cond: { readbackEquals: { fieldKey: 'originalCounterpartBizNo', ref: '$inputs.originalBizNo' } } } as Step,
    when('s17', 'wrong_entry', 's70', 's17a'),
    when('s17a', 'amount_changed', 's75', 's17b'),
    when('s17b', 'returned', 's75', 's17c'),
    when('s17c', 'deal_cancelled', 's80', 's18'),
    // 잘못 적음: 아래 칸(새로 작성하는 계산서, 당초 값으로 채워져 있다)을 카드 값으로 다시 쓴다. 위 칸(당초분 취소)은 홈택스가 채우고 잠근다.
    fill('s70', 'hometax.amend.new.counterpartBizNo', '$inputs.counterpart.bizNo'),
    click('s70a', 'hometax.amend.new.bizNoConfirm'),
    { ...byId('s13a'), id: 's70b' } as Step,
    idle('s70c'),
    fill('s71', 'hometax.amend.new.writeDate', '$inputs.issueDate'),
    fill('s71a', 'hometax.amend.new.item1.day', '$inputs.issueDay'),
    fill('s71b', 'hometax.amend.new.item1.name', '$inputs.items[0].name'),
    fill('s72', 'hometax.amend.new.item1.supply', '$inputs.amounts.supply'),
    { id: 's72a', type: 'press', key: 'Tab', target: 'hometax.amend.new.item1.supply' } as Step,
    totalShown('s72b', 'hometax.amend.new.total'),
    { id: 's72c', type: 'readback', fields: ['cancelTotalAmount'] } as Step,
    { id: 's72d', type: 'assert', cond: { readbackEquals: { fieldKey: 'cancelTotalAmount', ref: '$inputs.cancelTotal' } }, code: 'assert.cancel_mismatch', onFail: { retry: 0, then: 'abort' } } as Step,
    jump('s72e', 's18'),
    // 금액 바뀜, 반품: 사유가 생긴 날과 늘거나 줄어든 금액(부호 포함, 공급가액 칸은 비어 있고 품목은 '기타')
    fill('s75', 'hometax.amend.form.writeDate', '$inputs.issueDate'),
    fill('s75a', 'hometax.invoice.form.item1.day', '$inputs.issueDay'),
    fill('s75b', 'hometax.invoice.form.item1.name', '$inputs.items[0].name'),
    fill('s75c', 'hometax.invoice.form.item1.supply', '$inputs.amounts.supply'),
    { id: 's75d', type: 'press', key: 'Tab', target: 'hometax.invoice.form.item1.supply' } as Step,
    totalShown('s75e', 'hometax.invoice.form.total'),
    jump('s75f', 's18'),
    // 거래 취소: 계약 해제일만. 금액(전액 음수)과 비고(당초 작성일자, 승인번호)는 홈택스가 채운다.
    fill('s80', 'hometax.amend.form.writeDate', '$inputs.issueDate'),
    fill('s80a', 'hometax.invoice.form.item1.day', '$inputs.issueDay'),
    // [발급미리보기]와 되읽기 2
    byId('s18'), byId('s18a'), byId('s18b'),
    { id: 's19b', type: 'readback', fields: ['amendReason', 'supplierBizNo', 'supplierName', 'counterpartBizNo', 'counterpartName', 'counterpartEmail', 'itemName', 'itemCount', 'supplyAmount', 'taxAmount', 'totalAmount', 'issueDate', 'remark', 'receiptType', 'counterpartRepName', 'counterpartAddress'] } as Step,
    byId('s19c'), byId('s19d'),
    {
      id: 's19f', type: 'assert', code: 'assert.input_mismatch', onFail: { retry: 0, then: 'abort' },
      cond: { all: [
        { readbackEquals: { fieldKey: 'counterpartBizNo', ref: '$inputs.counterpart.bizNo' } },
        { readbackEquals: { fieldKey: 'supplyAmount', ref: '$inputs.amounts.supply' } },
        { readbackEquals: { fieldKey: 'taxAmount', ref: '$inputs.amounts.tax' } },
        { readbackEquals: { fieldKey: 'remark', ref: '$inputs.remark' } },
        { readbackEquals: { fieldKey: 'amendReason', ref: '$inputs.reasonName' } },
        { readbackEquals: { fieldKey: 'counterpartEmail', ref: '$inputs.email', ifAbsent: 'empty' } },
      ] },
    } as Step,
    { id: 's19e', type: 'assert', cond: { readbackEquals: { fieldKey: 'issueDate', ref: '$inputs.issueDate' } }, code: 'assert.issue_date_mismatch', onFail: { retry: 0, then: 'abort' } } as Step,
    { id: 's20', type: 'gate', card: 'amend.confirm', authorizes: ['s21'], waitMs: 600000 } as Step,
    byId('s21'),
    {
      id: 's30', type: 'verify',
      lookup: {
        playbook: 'hometax.invoice.lookup',
        match: { counterpartBizNo: '$readback.counterpartBizNo', issueDate: '$readback.issueDate', supplyAmount: '$readback.supplyAmount', taxAmount: '$readback.taxAmount' },
        window: 'issueDate', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60000, lookups: 2 }, bind: { approvalNo: 'approvalNo' },
      },
      on: { committed: 's32', not_committed: 'handoff', unknown: 'handoff' }, onFail: { retry: 0, then: 'handoff' },
    } as Step,
    byId('s32'),
    { id: 's34', type: 'end', status: 'success' } as Step,
  ];
  const added = amendEntries();
  const keys = new Set<string>(Object.keys(added));
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    else if (typeof x === 'string' && Object.hasOwn(h01.selectors.entries, x)) keys.add(x);
  };
  walk(steps);
  walk(h01.playbook.closeLayers.targets);
  walk(h01.playbook.closeWindows);
  // 되읽기 13칸이 읽는 미리보기 칸(fieldKey로 찾는다)
  for (const [k, e] of Object.entries(h01.selectors.entries as Record<string, SelectorEntry>)) if (e.fieldKey || e.readbackOf) keys.add(k);
  const preview = previewEntries(h01.selectors.entries);
  for (const k of Object.keys(preview)) keys.add(k);
  // 수정 작성 화면에는 건별발급의 공급받는자 번호 칸이 없다(위쪽은 글, 잘못 적음은 아래 칸). 같은 fieldKey가 두 곳이면 되읽기가 칸을 못 고른다.
  keys.delete('hometax.invoice.form.counterpartBizNo');
  const all = { ...h01.selectors.entries, ...added, ...preview } as Record<string, SelectorEntry>;
  // 비고는 홈택스가 당초 승인번호(사유에 따라 당초 작성일자도)로 채우고 잠근다. 읽기만 한다.
  all['hometax.invoice.form.remark'] = { ...all['hometax.invoice.form.remark']!, expect: { visible: true } } as SelectorEntry;
  // 금액 바뀜, 반품의 공급가액 칸은 음(-) 부호를 받는 일반 칸이다(되읽기 없이 채우기만).
  all['hometax.invoice.form.item1.supply'] = { ...all['hometax.invoice.form.item1.supply']!, expect: { visible: true, enabled: true } } as SelectorEntry;
  const stale = [...keys].filter((k) => JSON.stringify(all[k]!.candidates).includes('_isnPreviewPopup'));
  if (stale.length) throw new Error(`건별발급 미리보기 칸이 남았다: ${stale.join(', ')}`);
  for (const k of [...keys]) for (let l = all[k]!.landmark; l && !keys.has(l); l = all[l]?.landmark) keys.add(l);
  const entries = Object.fromEntries([...keys].sort().map((k) => [k, all[k]!]));
  const strings: Record<string, string> = {
    'amend.title': '전자세금계산서 수정발급',
    'amend.confirm': '수정세금계산서를 발급할까요?',
    'form.supplierInBody': '등록번호\\s*[0-9]{3}-[0-9]{2}-[0-9]{5}',
    ...Object.fromEntries(STRINGS.map((k) => {
      if (!Object.hasOwn(h01.strings, k)) throw new Error(`H-01에 글이 없다: ${k}`);
      return [k, h01.strings[k]];
    })),
  };
  const playbook = {
    ir: 2, id: AMEND_ID, version: AMEND_VERSION, portal: 'hometax', profileKinds: ['business'], effects: ['issue_document', 'send'],
    inputs: {
      originalApprovalNo: { type: 'string', required: true },
      what: { type: 'enum', required: true, values: AMEND_RUN_WHATS },
      reasonName: { type: 'string', required: true },
      direction: { type: 'enum', required: true, values: ['increase', 'decrease'] },
      originalBizNo: { type: 'string', required: true },
      remark: { type: 'string', required: true },
      cancelTotal: { type: 'string', required: true },
      counterpart: { type: 'counterparty', required: true },
      amounts: { type: 'amounts', required: true },
      items: { type: 'line_items', required: true, minItems: 1 },
      issueDate: { type: 'date', required: true },
      issueDay: { type: 'string', required: true },
      email: { type: 'email', required: false },
    },
    preconditions: [{ profileHas: 'signMethod' }],
    recovery: h01.playbook.recovery,
    steps,
    postconditions: [{ varSet: 'approvalNo' }, { artifact: 'pdf' }],
    pacing: h01.playbook.pacing,
    closeWindows: h01.playbook.closeWindows,
    closeLayers: { ...h01.playbook.closeLayers, until: 's16' },
  };
  const manifest = {
    ...h01.manifest, id: AMEND_ID, version: AMEND_VERSION, title: 'amend.title', createdAt: `${FORM_VERIFIED}T00:00:00+09:00`,
    lookupsUsed: (h01.manifest.lookupsUsed as Array<{ id: string }>).filter((l) => l.id === 'hometax.invoice.lookup'),
  };
  return {
    manifest, playbook, strings,
    selectors: { portal: 'hometax', entries, commitEndpoints: h01.selectors.commitEndpoints, knownEndpoints: h01.selectors.knownEndpoints },
  } as unknown as PackageFiles;
}

/** 실화면에서 아직 확정하지 못한 것. 발급하기를 누르지 않고는 볼 수 없는 것만 남았다(결정 9). */
export function amendCaptureList(): string {
  return [
    '# hometax.invoice.amend 캡처할 것',
    '',
    '이 파일은 `scripts/gen-amend-playbook.ts`가 만든다. 1, 2단계는 2026-11-24, 3단계 작성 화면과 수정 미리보기 창은 2026-11-25 맥북 실측 id다',
    '(사유 다섯 가지: 기재사항 착오 정정, 착오에 의한 이중발급, 공급가액 변동, 계약의 해제, 환입. 내국신용장 사후 개설은 2차).',
    '아래는 [발급하기]를 눌러야 보이는 것이라 첫 실제 수정발급에서 확인한다.',
    '',
    '| 무엇 | 지금 둔 것 | 확인할 것 |',
    '|---|---|---|',
    '| 미리보기 [발급하기] 뒤 | 건별발급과 같은 확인 창(UTEETZZA89), 인증 유형 창, 서명 창이라고 둠 | 수정발급도 같은 창과 문구인지 |',
    '| 커밋 요청 | 발급과 같은 ATEETBAA002C04, C05, C08이라고 둠 | 수정발급의 실제 actionId(다르면 commitEndpoints를 고친다) |',
    '| 확정 조회 | 발급 목록(기간 구분 발급일자)에 음(-) 금액 줄로 보인다고 둠 | 수정 줄의 금액 모양, 기재사항 착오 정정 2장이 각각 보이는지 |',
    '| 기재사항 착오 정정 아래 칸 [확인] | 건별발급처럼 사업자번호 확인 알림이 뜬다고 둠 | 알림 문구 |',
    '| 기재사항 착오 정정 미리보기 아래 칸 | wf11~wf16 칸(`_edt…Bot`)에 새 계산서 값이 들어 있다고 둠 | 공급자 상호, 이메일, 영수/청구 칸 id |',
    '',
  ].join('\n');
}
