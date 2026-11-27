import fs from 'node:fs';
import path from 'node:path';
import type { PackageFiles, SelectorEntry, Step } from '@sax/engine/core';

/**
 * 대량 발급 패키지 hometax.invoice.bulk(ADR-059, ADR-063). 홈택스 일괄발급 화면(UTEETBAA77)에서 금고가 만든 엑셀을 넣고,
 * 변환 목록을 줄마다 대조하고, 확인창의 건수와 합계를 대조한 뒤 한 번 서명한다. 50줄이 한 실행이고 묶음 전체가 같이 성공하거나 실패한다.
 * 로그인, 인증 유형 창, 인증서 서명 창은 발급 패키지(hometax.invoice.issue)와 같은 화면이라 그 스텝과 셀렉터를 가져온다.
 * 일괄발급 화면 id는 2026-11-24 맥북 실측(/mnt/project-files/hometax-ref/bulk-probe.md, 값은 가림)이다.
 * 손으로 고치지 말고 이 파일을 고친 뒤 `node --conditions=development scripts/gen-bulk-playbook.ts`로 다시 만든다.
 */
export const BULK_ID = 'hometax.invoice.bulk';
export const BULK_VERSION = '1.0.0';
/**
 * 확정 조회 패키지(일괄발급용). 공용 hometax.invoice.lookup은 쪽 크기 10에 총 건수를 읽지 않아 하루 10건을 넘으면 결론을 못 낸다.
 * 이 패키지는 받는 곳 번호로 거르고(selectbox5 사업자등록번호 + txprDscmNoA) 쪽 크기 50으로 조회한 뒤 총 건수(txtTotal)로 다 읽었는지 본다.
 * 화면 id와 동작은 2026-11-24 맥북 실측(/mnt/project-files/hometax-ref/list-probe.md).
 */
export const BUYER_LOOKUP_ID = 'hometax.invoice.buyer_lookup';
export const BUYER_LOOKUP_VERSION = '1.0.0';
const LIST_URL = 'https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=46&tm2lIdx=4609000000&tm3lIdx=4609050100';
const VERIFIED = '2026-11-24';
/** 일괄발급 화면 주소(실측). 처음에는 메뉴를 눌러 들어가고(직접 주소 이동은 로그아웃을 일으킨다), 이 주소는 다시 열 때만 쓴다. */
const BULK_URL = 'https://hometax.go.kr/websquare/websquare.html?w2xPath=/ui/pp/index_pp.xml&tmIdx=46&tm2lIdx=4601010000&tm3lIdx=4601010500';

const H01_DIR = path.resolve(import.meta.dirname, '../../packages/engine/playbooks/hometax.invoice.issue');
const LOGIN_STEPS = ['s0', 's2', 's3', 's4', 's4a', 's4b', 's4c', 's8', 's8a', 's8b', 's4d', 's4e', 's4f', 's4g', 's4h', 's5', 's6', 's7', 's7a', 's7b', 's7c', 's7d', 's7e', 's7f', 's7g'];
const STRINGS = ['login.loggedIn', 'hometax.login.successMarker', 'cert.passwordPrompt', 'cert.pickOne', 'login.certNoticeWindow', 'login.simpleAuth', 'popup.hide', 'popup.hide.idPrefix', 'popup.hide.cookie', 'popup.window.close'];
/** 발급 패키지에서 가져오는 서명 셀렉터(인증 유형 창 UTEETZZA08과 인증서 창은 건별발급과 같은 공통 팝업, bulk-probe.md). */
const SIGN_KEYS = ['hometax.invoice.auth.cert', 'hometax.invoice.auth.simpleAuth', 'hometax.invoice.sign.certTable', 'hometax.invoice.sign.confirm', 'hometax.common.processing'];

const FORM = 'hometax.invoice.form.root';
const P = '#mf_txppWframe_';
const ent = (css: string, role: string, extra: Partial<SelectorEntry> & Record<string, unknown> = {}): SelectorEntry => ({
  candidates: [{ kind: 'css', value: css }], role, namePattern: '^$', frame: 'main', landmark: FORM, commits: false, lastVerified: VERIFIED, ...extra,
} as SelectorEntry);

function bulkEntries(): Record<string, SelectorEntry> {
  return {
    'hometax.menu.bulk': ent('#menuAtag_4601010500', 'link', {
      landmark: 'hometax.page.root', namePattern: '^(전자\\(세금\\)계산서 일괄발급)?$', inputType: 'button',
      reviewNote: { by: 'bulk-package', reason: '상단 메뉴 링크(직접 주소 이동은 로그아웃을 일으킨다, 2026-11-24 실측)' },
    }),
    'hometax.bulk.grid': ent(`${P}grdBndlEtxivIsn`, 'grid', { expect: { visible: true }, reviewNote: { by: 'bulk-package', reason: '변환 목록 표. 값은 금고 bulk.readGrid가 표 API로 읽는다(DOM은 보이는 줄만 그린다)' } }),
    'hometax.bulk.convert': ent(`${P}trigger37`, 'button', {
      namePattern: '^(엑셀 ?파일 ?변환하기)?$', inputType: 'button',
      reviewNote: { by: 'bulk-package', reason: '[엑셀파일 변환하기]. 올린 파일을 목록으로 바꾸고 TIN, 폐업일을 조회한다(ATEETBAA004R01, 커밋 요청 없음)' },
    }),
    'hometax.bulk.count': ent(`${P}textboxTot`, 'generic', { fieldKey: 'bulkCount', expect: { visible: true }, reviewNote: { by: 'bulk-package', reason: '「총 건수 : N」. 되읽기는 마지막 \':\' 뒤 숫자만 본다' } }),
    'hometax.bulk.issue': ent(`${P}btnBndlEtxivIsnAllTop`, 'button', {
      namePattern: '^(일괄발급 ?\\(50건\\))?$', inputType: 'button', commits: true, commitEffect: 'issue_document',
      reviewNote: { by: 'bulk-package', reason: '[일괄발급(50건)]. 확인창 수락 뒤 C15(XML) → 서명 → C16(발급) → C13(메일)' },
    }),
  };
}

const read = (f: string) => JSON.parse(fs.readFileSync(path.join(H01_DIR, f), 'utf8'));
const click = (id: string, target: string): Step => ({ id, type: 'click', target } as Step);
const waitSel = (id: string, value: string, extra: Record<string, unknown> = {}): Step => ({ id, type: 'wait', for: 'selector', value, timeoutMs: 30000, ...extra } as Step);
const idle = (id: string): Step => ({ id, type: 'wait', for: 'gone', value: 'hometax.common.processing', timeoutMs: 30000 } as Step);

export function bulkPackage(): PackageFiles {
  const h01 = { playbook: read('playbook.json'), selectors: read('selectors.json'), strings: read('strings.ko.json'), manifest: read('manifest.json') };
  const byId = (id: string): Step => {
    const s = (h01.playbook.steps as Step[]).find((x) => x.id === id);
    if (!s) throw new Error(`H-01에 스텝이 없다: ${id}`);
    return structuredClone(s);
  };
  const first = '$inputs.rows[0]';
  const steps: Step[] = [
    ...LOGIN_STEPS.map(byId),
    click('s10', 'hometax.menu.bulk'),
    waitSel('s10a', 'hometax.bulk.grid'),
    { id: 's11', type: 'checkpoint', name: 'bulk', expect: { exists: 'hometax.bulk.grid' }, url: BULK_URL, sessionRequired: true, reentry: 'reload' } as Step,
    idle('s11a'),
    // 금고가 검사한 줄로 홈택스 양식 파일을 만들어 화면의 파일 칸 하나에 넣는다(엔진은 파일을 다루지 않는다, ADR-063).
    { id: 's12', type: 'upload', sheet: 'hometax_bulk_v1', rows: '$inputs.rows', supplier: '$inputs.supplier', onFail: { retry: 0, then: 'abort' } } as Step,
    click('s13', 'hometax.bulk.convert'),
    idle('s13a'),
    // 변환 목록을 줄마다 대조한다(건수, 공급자, 받는 곳 번호와 상호와 대표자, 작성일, 금액, 영수/청구). 하나라도 다르면 멈춘다.
    { id: 's14', type: 'grid_check', rows: '$inputs.rows', supplier: '$inputs.supplier', expect: 'converted', onFail: { retry: 0, then: 'abort' } } as Step,
    { id: 's15', type: 'readback', fields: ['bulkCount'] } as Step,
    { id: 's15a', type: 'assert', cond: { readbackEquals: { fieldKey: 'bulkCount', ref: '$inputs.confirmCount' } }, code: 'assert.bulk_count_mismatch', onFail: { retry: 0, then: 'abort' } } as Step,
    { id: 's20', type: 'gate', card: 'bulk.confirm', authorizes: ['s21'], waitMs: 600000 } as Step,
    {
      id: 's21', type: 'submit', target: 'hometax.bulk.issue', intent: '$intent.id', verify: 's30',
      // 확인창의 건수와 합계가 승인한 묶음과 같을 때만 수락한다. 줄마다 뜨는 기한 경과, 폐업 확인창은 패턴이 달라 취소되고(그 줄이 빠진다)
      // 그러면 건수가 달라져 이 확인창도 취소된다(발급하지 않는다).
      expectConfirm: 'bulk.confirmIssue', expectConfirmVars: { count: '$inputs.confirmCount', total: '$inputs.confirmTotal' },
      signFlow: {
        method: '$profile.signMethod',
        methodTargets: { cert: 'hometax.invoice.auth.cert', simple_auth: 'hometax.invoice.auth.simpleAuth' },
        steps: { cert: ['human:secret'], simple_auth: ['wait:push'] },
        readyTarget: 'hometax.invoice.sign.certTable', maxWaitMs: 180000, confirmTarget: 'hometax.invoice.sign.confirm',
        certPick: { target: 'hometax.invoice.sign.certTable', by: '$profile.certName' },
      },
      onFail: { retry: 0, then: 'handoff' },
    } as Step,
    {
      id: 's30', type: 'verify',
      lookup: {
        playbook: BUYER_LOOKUP_ID,
        match: { counterpartBizNo: `${first}.buyer.bizNo`, issueDate: `${first}.writeDate`, supplyAmount: `${first}.supply`, taxAmount: `${first}.tax` },
        window: 'issueDate', baseline: 'pre_gate_snapshot', notCommittedPolicy: { minElapsedMs: 60000, lookups: 2 }, bind: { approvalNo: 'approvalNo' },
      },
      on: { committed: 's31', not_committed: 's33', unknown: 'handoff' }, onFail: { retry: 0, then: 'handoff' },
    } as Step,
    // 묶음은 같이 성공한다(bulk-probe.md). 승인번호는 홈택스가 목록 줄마다 채운 값을 읽는다.
    { id: 's31', type: 'grid_check', rows: '$inputs.rows', supplier: '$inputs.supplier', expect: 'issued', bind: 'approvalNos', onFail: { retry: 0, then: 'handoff' } } as Step,
    { id: 's32', type: 'end', status: 'success' } as Step,
    // 확인창의 건수나 합계가 달라 취소했거나 홈택스가 묶음 전체를 거절했다. 조회가 발급 없음을 확인했으니 다시 올리지 않고 멈춘다.
    { id: 's33', type: 'end', status: 'failed', code: 'bulk.not_issued' } as Step,
  ];
  const added = bulkEntries();
  const keys = new Set<string>([...Object.keys(added), ...SIGN_KEYS]);
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
    else if (typeof x === 'string' && Object.hasOwn(h01.selectors.entries, x)) keys.add(x);
  };
  walk(steps);
  walk(h01.playbook.closeLayers.targets);
  walk(h01.playbook.closeWindows);
  const all = { ...h01.selectors.entries, ...added } as Record<string, SelectorEntry>;
  for (const k of [...keys]) for (let l = all[k]!.landmark; l && !keys.has(l); l = all[l]?.landmark) keys.add(l);
  const entries = Object.fromEntries([...keys].sort().map((k) => [k, all[k]!]));
  const strings: Record<string, string> = {
    'bulk.title': '전자세금계산서 일괄발급',
    'bulk.confirm': '세금계산서를 한 번에 발급할까요?',
    'bulk.confirmIssue': '^전자세금계산서를 일괄발급하시겠습니까\\? ?발급한 전자세금계산서는 삭제가 불가능합니다\\. ?\\(총 건수 ?: ?{count}, ?총 합계금액 ?: ?{total}\\)(?: .*)?$',
    ...Object.fromEntries(STRINGS.map((k) => {
      if (!Object.hasOwn(h01.strings, k)) throw new Error(`H-01에 글이 없다: ${k}`);
      return [k, h01.strings[k]];
    })),
  };
  const playbook = {
    ir: 2, id: BULK_ID, version: BULK_VERSION, portal: 'hometax', profileKinds: ['business'], effects: ['issue_document', 'send'],
    inputs: {
      rows: { type: 'invoice_rows', required: true },
      supplier: { type: 'party', required: true },
      confirmCount: { type: 'string', required: true },
      confirmTotal: { type: 'string', required: true },
    },
    preconditions: [{ profileHas: 'signMethod' }],
    recovery: h01.playbook.recovery,
    steps,
    postconditions: [{ varSet: 'approvalNos' }],
    pacing: h01.playbook.pacing,
    closeWindows: h01.playbook.closeWindows,
    closeLayers: { ...h01.playbook.closeLayers, until: 's12' },
  };
  const manifest = {
    ...h01.manifest, id: BULK_ID, version: BULK_VERSION, title: 'bulk.title', createdAt: `${VERIFIED}T00:00:00+09:00`,
    lookupsUsed: [{ id: BUYER_LOOKUP_ID, version: BUYER_LOOKUP_VERSION, digest: '0'.repeat(64) }],
  };
  const host = 'teet.hometax.go.kr';
  const commit = (actionId: string) => ({ match: { method: 'POST', host, pathPattern: '^/wqAction\\.do$', actionParam: { name: 'actionId', value: actionId } }, effect: 'issue_document', maxRequests: 1, encoding: 'opaque' });
  return {
    manifest, playbook, strings,
    selectors: {
      portal: 'hometax', entries,
      commitEndpoints: [commit('ATEETBAA004C15'), commit('ATEETBAA004C16'), commit('ATEETBAA004C13')],
      knownEndpoints: [...h01.selectors.knownEndpoints, { method: 'POST', host, pathPattern: '^/websquare/excelToGrid2\\.wq$' }],
    },
  } as unknown as PackageFiles;
}

/** 받는 곳 번호로 거른 발급 목록 조회(kind lookup). 입력은 verify.match(counterpartBizNo, issueDate, supplyAmount, taxAmount)다. */
export function buyerLookupPackage(): PackageFiles {
  const base = (f: string) => JSON.parse(fs.readFileSync(path.resolve(H01_DIR, '../hometax.invoice.lookup', f), 'utf8'));
  const lk = { manifest: base('manifest.json'), selectors: base('selectors.json'), strings: base('strings.ko.json'), playbook: base('playbook.json') };
  const L = 'hometax.lookup.root';
  const e = (css: string, role: string, extra: Record<string, unknown> = {}) => ({ candidates: [{ kind: 'css', value: css }], role, namePattern: '^$', frame: 'main', landmark: L, commits: false, lastVerified: VERIFIED, ...extra });
  const entries = {
    'hometax.page.root': lk.selectors.entries['hometax.page.root'],
    [L]: e('#mf_txppWframe', 'generic', { landmark: 'hometax.page.root' }),
    'hometax.lookup.searchButton': { ...lk.selectors.entries['hometax.lookup.searchButton'], landmark: L },
    'hometax.lookup.rows': lk.selectors.entries['hometax.lookup.rows'],
    'hometax.lookup.buyerKind': e(`${P}selectbox5`, 'combobox', { namePattern: '^.{0,30}$', inputType: 'select', allowedConstants: ['사업자등록번호'] }),
    'hometax.lookup.buyerNo': e(`${P}txprDscmNoA`, 'textbox', { namePattern: '^.{0,30}$', inputType: 'text', expect: { visible: true, enabled: true, editable: true } }),
    'hometax.lookup.pageSize': e(`${P}selectbox90`, 'combobox', { namePattern: '^(조회건수 선택)?$', inputType: 'select', allowedConstants: ['50'] }),
    'hometax.lookup.count': e(`${P}txtTotal`, 'generic'),
  };
  const playbook = {
    ...lk.playbook, id: BUYER_LOOKUP_ID, version: BUYER_LOOKUP_VERSION,
    // 받는 곳 번호 없이는 거르지 못해 쪽을 넘칠 수 있다. 필수로 둔다(verify.match가 늘 준다).
    inputs: { ...lk.playbook.inputs, counterpartBizNo: { type: 'string', required: true } },
    steps: [
      { id: 's0', type: 'goto', url: LIST_URL },
      { id: 's1', type: 'wait', for: 'selector', value: 'hometax.lookup.searchButton', timeoutMs: 30000 },
      // 번호 칸은 종류를 「사업자등록번호」로 고른 뒤에 켜진다. 키보드 입력이라 하이픈 없는 10자리가 그대로 들어간다(실측).
      { id: 's2', type: 'select', target: 'hometax.lookup.buyerKind', option: '사업자등록번호' },
      { id: 's3', type: 'fill', target: 'hometax.lookup.buyerNo', value: '$inputs.counterpartBizNo', keyEvents: true },
      // 쪽 크기는 조회 전에 고르면 첫 조회부터 그 크기다(실측).
      { id: 's4', type: 'select', target: 'hometax.lookup.pageSize', option: '50' },
      { id: 's5', type: 'click', target: 'hometax.lookup.searchButton' },
      { id: 's6', type: 'wait', for: 'idle', timeoutMs: 30000 },
      { id: 's7', type: 'extract', name: 'rows', from: { a11y: { target: 'hometax.lookup.rows' } } },
      { id: 's8', type: 'extract', name: 'count', from: { regex: { target: 'hometax.lookup.count', patternRef: 'lookup.countPattern' } } },
      { id: 's9', type: 'end', status: 'success' },
    ],
  };
  const strings: Record<string, string> = { ...lk.strings, 'lookup.title': '발급 목록조회(받는 곳)', 'lookup.table.pageSize': '50', 'lookup.countPattern': '^([0-9,]+)$' };
  const manifest = { ...lk.manifest, id: BUYER_LOOKUP_ID, version: BUYER_LOOKUP_VERSION, createdAt: `${VERIFIED}T00:00:00+09:00` };
  return { manifest, playbook, strings, selectors: { ...lk.selectors, entries } } as unknown as PackageFiles;
}
