// 받을 돈(09 D-09) 화면: 못 받은 돈 · 받은 돈 · 확인할 입금 · 내 계좌. 거래처 상세의 계좌·입금자 이름 칸, 대화 답 카드.
// 값(거래처·금액·입금자명)은 main이 엔진 로컬 조회로 준 것을 그대로 그린다. 계산·판정은 하지 않는다(엔진 몫).
// 모든 고치기는 한 번 누르면 되고, 10초 동안 [되돌리기]가 뜬다(그 뒤에도 건 상세 기록에서 되돌린다, 09 §7.5).
// 결과·오류는 토스트 대신 이 화면 안 글로 남긴다(대표 2026-11-13). 한 덩어리에 주요 단추는 하나, 줄마다 붙는 단추는 조용한 단추다(v2.0).
import { btn, emptyState, h, icon, note, num, replyOptions } from './shell-views.js';
import { accountInput, amountInput, amountOf, checkFields, dateInput, field, keys, LIMITS, selectInput, textInput } from './fields.js';

const won = (n) => `${num(n)}원`;
const md = (iso) => (iso ? `${Number(iso.slice(5, 7))}월 ${Number(iso.slice(8, 10))}일` : '—');
const BANKS = ['국민', '신한', '우리', '하나', '농협', '기업', '카카오뱅크', '토스뱅크', '케이뱅크', '새마을금고', '우체국', '수협', '부산', '아이엠뱅크', '경남', '광주', '전북', '제주', 'SC제일', '씨티', '신협', '기타'];
const ROLE_LABEL = { date: '거래일(시)', time: '시간', in: '입금', out: '출금', amount: '금액(한 칸)', kind: '입출 구분', balance: '잔액', payer: '입금자/보낸분', memo: '적요', counter_account: '상대 계좌' };
const METHOD_LABEL = { account: '계좌', cash: '현금', other_account: '다른 계좌', offset: '상계', other: '기타', fee: '수수료' };
const ERR = {
  consent_required: '먼저 안내를 읽고 동의해 주세요.',
  duplicate_account: '이미 등록한 계좌예요.',
  bad_account_number: '계좌번호를 숫자로 6~20자리 넣어 주세요.',
  bad_bank: '은행을 골라 주세요.',
  preview_expired: '미리보기가 끝났어요. 파일을 다시 올려 주세요.',
  no_rows: '읽은 줄이 없어요. 열을 확인해 주세요.',
  unsupported_format: '엑셀(xlsx/xls)이나 CSV 파일을 올려 주세요.',
  password_required: '암호가 걸린 파일이에요. 은행에서 암호 없이 다시 내려받아 주세요.',
  profile_not_found: '내 사업장을 먼저 등록해 주세요.',
  already_undone: '이미 되돌렸어요.',
  mixed_counterparties: '한 입금은 한 거래처 건에만 붙일 수 있어요.',
  alias_conflict: '다른 거래처가 이미 쓰는 입금자 이름이에요.',
  txn_used_elsewhere: '그 입금이 이미 다른 건에 붙어 있어 되돌릴 수 없어요.',
  receivable_settled: '그 건은 이미 다 받아서 되돌릴 수 없어요.',
  nothing_to_attach: '붙일 금액이 없어요.',
  account_not_found: '계좌를 골라 주세요.',
  bad_amount: '받은 금액을 확인해 주세요. 남은 돈보다 많을 수 없어요.',
  bad_date: '날짜를 다시 골라 주세요.',
  bad_alias: '이름을 두 글자 이상 넣어 주세요.',
  bad_holder: '예금주 이름을 확인해 주세요.',
  'source.not_linked': '이 계좌는 자동 연결이 안 돼 있어요. 거래내역 파일을 올려 주세요.',
  'source.not_available': '자동 연결을 지금 쓸 수 없어요. 거래내역 파일을 올려 주세요.',
};
/** 원천 연결 상태(원천 이름은 쓰지 않는다) */
const ACTION_LABEL = { attach: '입금을 연결했어요', detach: '연결을 끊었어요', reject: '이 건이 아니라고 했어요', mark_received: '받았다고 적었어요', close_fee: '차액을 수수료로 닫았어요', promise: '기다리는 날을 정했어요', exclude: '지웠어요', undo: '되돌렸어요' };
const LINK_LABEL = { file_only: '파일로 올려요', auto_connected: '자동으로 가져와요', auto_error: '다시 연결이 필요해요' };
const SOURCE_ERR = {
  'source.login_failed': '은행 로그인이 안 됐어요. 인증서를 확인해 주세요.',
  'source.cert_expired': '인증서 기간이 끝났어요. 새 인증서로 다시 연결해 주세요.',
  'source.needs_user': '은행에서 확인이 필요해요. 다시 연결해 주세요.',
  'source.rate_limited': '잠시 뒤에 다시 해 주세요.',
  'source.unsupported_bank': '이 은행은 아직 자동 조회를 못 해요. 파일을 올려 주세요.',
};
const sourceErrText = (code) => SOURCE_ERR[code] ?? '최신화하지 못했어요. 이미 넣은 거래내역은 그대로예요. 다시 해 주세요.';
/** 원천의 하루 상한(오류 아님) */
const DAILY_TEXT = '오늘은 다 가져왔어요. 내일 다시 가져올 수 있어요.';
/** 방금 가져와서 이번엔 은행에 묻지 않았다(오류 아님). retryAt까지 남은 분 */
const soonText = (retryAt) => {
  const min = Math.max(1, Math.ceil((Date.parse(retryAt) - Date.now()) / 60_000));
  return Number.isFinite(min) ? `방금 가져왔어요. ${min}분 뒤에 다시 가져올 수 있어요.` : '방금 가져왔어요. 잠시 뒤에 다시 가져올 수 있어요.';
};
const LOAD_FAIL = '받을 돈을 불러오지 못했어요.';
const REFRESH_STEP = { requested: '요청함', waiting: '은행 응답 기다리는 중', running: '받는 중' };

function statusText(v) {
  if (v.status === 'received') return v.via === 'auto' ? '입금 확인' : v.offAccount ? `직접 받음(${METHOD_LABEL[v.offAccount] ?? '기타'})` : '직접 받음';
  return { unpaid: '못 받음', unknown: '입금 확인 전', partial: '일부 받음', waiting: '아직 기다려요', excluded: '지움' }[v.status];
}
const dueText = (v) => (v.dueIn === null ? '기한 없음' : v.dueIn < 0 ? `${-v.dueIn}일 지났어요` : v.dueIn === 0 ? '오늘까지' : v.dueIn <= 7 ? `${v.dueIn}일 남았어요` : `${md(v.dueOn)}까지`);
const initial = (name) => (name ?? '?').replace(/^(\(주\)|주식회사)\s*/, '').slice(0, 1);

/** main이 거절한 까닭이 칸 하나의 것이면 그 칸(data-field) 아래에 쓴다. 나머지는 폼 끝 한 줄. */
const ERR_FIELD = { bad_amount: 'amount', bad_date: 'on', bad_account_number: 'number', duplicate_account: 'number', bad_bank: 'bank', bad_alias: 'alias', bad_holder: 'holder' };
/** 화면 안 알림 한 줄(되돌리기 띠와 같은 모양): 아이콘 · 글(+ 작은 글) · 단추 0~2개. bad = 확인 필요 */
const bar = (text, { bad = false, extra = null, action = null, ic = null, attrs = {} } = {}) =>
  h('div', { class: `sx-note${bad ? ' is-attention' : ''}`, role: bad ? 'alert' : 'status', ...attrs }, icon(ic ?? (bad ? 'warn' : 'info')), h('div', {}, text, extra ? h('div', { class: 'sx-meta' }, extra) : null), action);
/**
 * 폼 안에서 하나 고르기(v2.0: select 대신 답 후보 줄). 고른 줄은 실선 + 체크, 다시 눌러 바꿀 수 있다(저장 전이라 굳히지 않는다).
 * opts = [[값, 글]]. 많으면(거래처 수십 곳) 줄이 화면을 덮으므로 그때만 select를 쓴다.
 */
const PICK_MAX = 6;
const pickRows = (opts, value, onPick, attrs = {}) =>
  h(
    'div',
    { class: 'sx-replies bank-pick', role: 'radiogroup', ...attrs },
    ...opts.map(([k, label]) =>
      h('button', { type: 'button', class: `sx-reply${k === value ? ' is-picked' : ''}`, role: 'radio', 'aria-checked': String(k === value), 'data-pick': k, onclick: () => onPick(k) }, h('span', {}, label), k === value ? icon('check') : null),
    ),
  );

export function createBankScreen({ call, toast, rerender: draw, errText, counterparties, openCounterparty, railHead, bankAuto }) {
  const s = {
    tab: 'unpaid',
    data: null,
    loading: false,
    sel: null, // 고른 건 id
    detail: null,
    form: null, // { kind: 'received'|'promise'|'exclude', ... }
    formErr: null, // { where: 'form'|'account'|'import', text } 폼 안에 보이는 까닭
    notice: null, // { text, extra?, bad?, load?, retry?: [단추 글, 할 일] } 화면 위 알림 한 줄
    preview: null, // 거래내역 미리보기(main)
    cols: null, // 열 고르기(사람이 고친 것)
    previewAccount: null,
    adding: null, // 계좌 추가 입력 { bank, number, alias }
    confirmDel: null, // [지우기]를 한 번 누른 계좌 id(그 줄이 확인 줄로 바뀐다)
    offer: null, // 별칭 제안 { name, counterpartyId, cpName }
    assign: null, // [이 거래처 입금으로] 연 입금 { id, cp, remember }
    undo: null, // { seq, text, until }
    busy: false,
    invoiceResult: null,
    refreshing: {}, // 계좌 id → 최신화 진행(엔진 RefreshJob)
    connect: false, // 이 화면 안에서 은행 자동 연결을 하는 중
    q: '', // 거래처 찾기
    filter: 'open', // 목록 거르기: open | overdue | review | done
    view: 'list', // 보기: cal(달력) | list(목록)
    month: null, // 달력 달(YYYY-MM)
    day: null, // 달력에서 고른 날
    menu: false, // [파일 올리기] 메뉴
    logFor: null, // 기록을 펼친 건 id
    pickOther: null, // [다른 입금 고르기]를 연 건 id
    side: 'recv', // recv(받을 돈) | pay(낼 돈)
    cp: null, // 목록에서 고른 거래처 열쇠
    cpAll: false, // 거래처 표를 다 펼쳤는지
  };
  /** 거래처 상세(cpSection)는 받을 돈 화면 밖이라 토스트로 알린다 */
  const say = (e) => toast(ERR[errText(e)] ?? '처리하지 못했어요. 다시 해 주세요.');
  const errMsg = (e) => ERR[errText(e)] ?? '처리하지 못했어요. 다시 해 주세요.';
  const tell = (text, o = {}) => (s.notice = { text, ...o });
  /** 실패는 그 폼 안(where)의 그 칸 아래, 칸을 모르면 폼 끝 한 줄, 폼이 없으면 화면 위 알림 한 줄로 */
  const fail = (e, where) => (where ? (s.formErr = { where, text: errMsg(e), field: ERR_FIELD[errText(e)] ?? null }) : tell(errMsg(e), { bad: true }));
  const formMsg = (where) => (s.formErr?.where === where && !s.formErr.field ? h('p', { class: 'form-msg is-bad', role: 'alert' }, s.formErr.text) : null);
  /** 그 폼 그 칸의 까닭(field의 error) */
  const errAt = (where, f) => (s.formErr?.where === where && s.formErr.field === f ? s.formErr.text : null);

  /** 다시 그리면 DOM을 새로 만든다. 입력 중이던 칸(data-field)의 포커스와 커서를 지킨다([최신화] 진행이 1.5초마다 다시 그려도 칸에서 튕기지 않게) */
  const rerender = () => {
    const a = document.activeElement;
    const f = a?.closest?.('[data-view="bank"]') ? a.dataset.field : null;
    const at = f && typeof a.selectionStart === 'number' ? [a.selectionStart, a.selectionEnd] : null;
    draw();
    if (!f) return;
    const b = document.querySelector(`[data-view="bank"] [data-field="${f}"]`);
    if (!b || b === a) return;
    b.focus();
    if (at) {
      try {
        b.setSelectionRange(...at);
      } catch {
        // 커서를 못 두는 칸(날짜 등)은 포커스만
      }
    }
  };
  const focusLater = (sel) => setTimeout(() => document.querySelector(`[data-view="bank"] ${sel}`)?.focus(), 0);

  async function load() {
    s.loading = true;
    try {
      s.data = await call('bank.overview');
      if (s.notice?.load) s.notice = null;
      for (const a of s.data?.accounts ?? []) if (a.refresh && !['done', 'failed'].includes(a.refresh.state) && !s.refreshing[a.id]) watchRefresh(a.id, a.refresh);
      if (s.sel) s.detail = await call('bank.receivable', { id: s.sel }).catch(() => null);
    } catch (e) {
      tell(ERR[errText(e)] ?? LOAD_FAIL, { bad: true, load: true, retry: ['다시 시도', refresh] });
    } finally {
      s.loading = false;
    }
  }
  const refresh = async () => {
    await load();
    rerender();
  };
  /** 고치기 하나: 부르고 → 되돌리기 띠(10초) → 다시 읽기. 성공하면 main 응답(없으면 true), 실패하면 null. where = 실패 까닭을 보일 폼 */
  async function act(method, params, text, where) {
    if (s.busy) return null;
    s.busy = true;
    if (s.notice?.bad) s.notice = null;
    s.formErr = null;
    let out = null;
    try {
      const r = await call(method, params);
      const seq = r?.seq ?? r?.seqs?.[0];
      if (seq !== undefined && text) {
        s.undo = { seq, seqs: r.seqs ?? [seq], text, until: Date.now() + 10_000 };
        setTimeout(() => {
          if (s.undo && Date.now() >= s.undo.until) {
            s.undo = null;
            rerender();
          }
        }, 10_200);
      }
      out = r ?? true;
    } catch (e) {
      fail(e, where);
    } finally {
      s.busy = false;
    }
    await refresh();
    return out;
  }
  async function undoNow() {
    const u = s.undo;
    s.undo = null;
    if (!u) return;
    try {
      for (const seq of [...u.seqs].reverse()) await call('bank.undo', { seq });
      toast('되돌렸어요');
    } catch (e) {
      fail(e);
    }
    await refresh();
  }

  // ---- 파일 올리기 ----

  /** 미리보기가 끝났으면 올린 파일을 버리고 다시 올리게 한다 */
  const lostPreview = () => {
    s.preview = null;
    s.tab = 'unpaid';
    tell(ERR.preview_expired, { bad: true, retry: ['파일 다시 올리기', pickStatement] });
  };
  async function pickStatement() {
    try {
      const p = await call('bank.pickStatement');
      if (!p) return;
      s.preview = p;
      s.cols = { ...p.mapping };
      s.previewAccount = p.suggestedAccountId ?? s.data?.accounts?.[0]?.id ?? null;
      s.tab = 'import';
      s.formErr = null;
      if (s.notice?.bad) s.notice = null;
    } catch (e) {
      fail(e);
    }
    rerender();
  }
  async function repreview() {
    try {
      s.preview = await call('bank.previewStatement', { token: s.preview.token, columns: s.cols });
      s.formErr = null;
    } catch (e) {
      if (errText(e) === 'preview_expired') lostPreview();
      else fail(e, 'import');
    }
    rerender();
  }
  async function commitStatement() {
    if (!s.previewAccount) {
      s.formErr = { where: 'import', text: '어느 계좌의 거래내역인지 골라 주세요.' };
      return rerender();
    }
    s.busy = true;
    s.formErr = null;
    rerender();
    try {
      const r = await call('bank.commitStatement', { token: s.preview.token, accountId: s.previewAccount, columns: s.cols });
      s.preview = null;
      s.tab = 'unpaid';
      s.view = 'list';
      s.filter = r.match.review || r.match.unknown ? 'review' : 'open';
      // 넣은 결과는 화면에 남는 요약 한 줄(토스트로 사라지지 않게)
      tell(`거래내역 ${r.newCount}줄을 넣었어요.`, { extra: [r.duplicateCount ? `이미 있던 ${r.duplicateCount}줄은 건너뛰었어요` : null, r.match.auto ? `앱이 ${r.match.auto}건을 맞췄어요` : null, r.match.review + r.match.unknown ? `확인할 입금이 ${r.match.review + r.match.unknown}건 있어요` : null].filter(Boolean).join('. ') || null });
    } catch (e) {
      if (errText(e) === 'preview_expired') lostPreview();
      else fail(e, 'import');
    } finally {
      s.busy = false;
    }
    await refresh();
  }
  async function pickInvoices() {
    try {
      const r = await call('bank.pickInvoices');
      if (!r) return;
      s.invoiceResult = r;
      if (!r.ok) tell('발급 목록 칸(작성일자/승인번호/합계금액)을 찾지 못했어요. 홈택스 [내려받기] 파일인지 확인해 주세요.', { bad: true });
      else tell(`세금계산서 ${r.rows}건을 읽었어요.`, { extra: [`새로 ${r.created}건을 더했어요`, r.merged ? `${r.merged}건은 이미 있었어요` : null, r.purchase ? `매입 ${r.purchase}건은 아직 받지 않아요` : null].filter(Boolean).join('. ') });
    } catch (e) {
      fail(e);
    }
    await refresh();
  }

  // ---- 그리기 ----


  /** 받을 돈(매출) / 낼 돈(매입) 한 쪽의 값과 말. 낼 돈은 엔진 overview.payables(같은 모양) */
  const side = () => {
    const d = s.data ?? {};
    if (s.side === 'pay') {
      const p = d.payables ?? {};
      return { pay: true, unpaid: p.unpaid ?? [], done: p.paid ?? [], review: [], recent: p.recent ?? [], doneWord: '낸 돈', mark: '지급 처리', flow: '출금 내역', none: '아직 나간 돈이 없어요.', allDone: '낼 돈이 없어요.' };
    }
    return { pay: false, unpaid: d.unpaid ?? [], done: d.received ?? [], review: d.review ?? [], recent: d.recent ?? [], doneWord: '받은 돈', mark: '수금 처리', flow: '입금 내역', none: '아직 들어온 돈이 없어요.', allDone: '못 받은 돈이 없어요.' };
  };
  /** 거래처 묶음 열쇠(거래처를 모르면 이름으로) */
  const cpKey = (v) => v.counterpartyId ?? `name:${v.cpName ?? ''}`;
  /** 못 받은 건을 거래처로 묶는다. 건은 엔진이 기한 이른 순으로 주므로 첫 건이 가장 늦은 건 */
  const groups = (list) => {
    const m = new Map();
    for (const v of list) {
      const k = cpKey(v);
      const g = m.get(k) ?? { key: k, name: v.cpName ?? '거래처 미상', items: [], remaining: 0 };
      g.items.push(v);
      g.remaining += v.remaining;
      m.set(k, g);
    }
    return [...m.values()];
  };
  /** 만 원 단위 짧은 금액(달력 칸) */
  const man = (n) => (n >= 1e8 ? `${(Math.round(n / 1e7) / 10).toString()}억` : n >= 1e4 ? `${num(Math.round(n / 1e4))}만` : num(n));
  /** 연결된 금액(입금에서 아직 안 붙은 것을 뺀 것) */
  const used = (t) => t.amount - (t.unallocated ?? 0);

  /** 머리: [받을 돈] [낼 돈] + 보기(달력, 목록) + [새로고침](자동 계좌) + [파일 올리기] 메뉴 */
  function head() {
    const d = s.data;
    const accounts = d?.accounts ?? [];
    const auto = accounts.find((x) => x.linkState === 'auto_connected') ?? accounts.find((x) => x.linkState === 'auto_error');
    const job = auto ? s.refreshing[auto.id] : null;
    const sum = d?.summary;
    const closeMenu = () => ((s.menu = false), rerender());
    const run = (fn) => () => ((s.menu = false), void fn());
    const menu = h(
      'div',
      { class: 'bank-menu', role: 'menu', hidden: s.menu ? null : '', onkeydown: keys(null, closeMenu) },
      accounts.length ? h('button', { type: 'button', role: 'menuitem', 'data-act': 'bank-statement', onclick: run(pickStatement) }, h('b', {}, '은행 거래내역 파일'), h('small', {}, '엑셀이나 CSV')) : null,
      h('button', { type: 'button', role: 'menuitem', 'data-act': 'bank-invoices', onclick: run(pickInvoices) }, h('b', {}, '홈택스 발급목록 파일'), h('small', {}, '앱 밖에서 발급한 세금계산서')),
      h('div', { class: 'bank-menu-sep' }),
      h('button', { type: 'button', role: 'menuitem', 'data-bank-tab': 'accounts', onclick: () => ((s.menu = false), (s.tab = 'accounts'), (s.sel = null), (s.detail = null), rerender()) }, h('b', {}, '계좌 관리')),
    );
    const right = !d
      ? []
      : [
          sum?.stale ? (sum.latestDay ? h('span', { class: 'bank-sync is-attention', 'data-bank-basis': '' }, `${md(sum.latestDay)}까지만 반영`) : h('span', { class: 'sx-chip', 'data-bank-basis': '' }, '거래내역 없음')) : null,
          auto?.canRefresh ? btn(job ? '가져오는 중' : '새로고침', () => startRefresh(auto.id), '', { 'data-act': 'bank-refresh', disabled: job ? '' : null, title: `${auto.bank} ${auto.last4}${sum?.latestDay ? `, ${md(sum.latestDay)}까지 반영` : ''}` }) : !sum?.hasAccounts ? btn('계좌 연결', openConnect, 'sx-btn-primary', { 'data-act': 'bank-go-accounts' }) : null,
          h('div', { class: 'bank-menu-wrap' }, btn('파일 올리기', () => ((s.menu = !s.menu), rerender()), 'sx-btn-quiet', { 'aria-haspopup': 'menu', 'aria-expanded': String(s.menu), 'data-act': 'bank-file-menu' }), menu),
        ];
    if (s.tab === 'unpaid' && d) right.unshift(viewSwitch());
    const pickSide = (k) => () => ((s.side = k), (s.cp = null), (s.sel = null), (s.detail = null), (s.form = null), (s.filter = 'open'), (s.day = null), rerender());
    const title = d
      ? h('span', { class: 'bank-sides', role: 'tablist', 'aria-label': '돈 종류' }, ...[['recv', '받을 돈'], ['pay', '낼 돈']].map(([k, label]) => h('button', { type: 'button', role: 'tab', class: s.side === k ? 'is-on' : null, 'aria-selected': String(s.side === k), 'data-bank-side': k, onclick: pickSide(k) }, label)))
      : '받을 돈';
    if (railHead) return railHead(title, '', ...right);
    return h('div', { class: 'rs-head' }, h('h1', { class: 'title-screen' }, title), h('div', { class: 'rs-right' }, ...right));
  }

  /** 줄 아래 작은 글: 상태와 기한을 한 마디로 */
  const invSub = (v) => {
    if (v.status === 'received') return statusText(v);
    if (v.status === 'unknown') return '입금 확인 전';
    if (v.status === 'waiting' && v.promisedOn) return `${md(v.promisedOn)} 예정`;
    if (v.status === 'partial') return v.overdue ? `일부, ${-v.dueIn}일 지남` : '일부 받음';
    return v.overdue ? `${-v.dueIn}일 지남` : v.dueIn === 0 ? '오늘까지' : v.dueOn ? `${md(v.dueOn)}까지` : '기한 없음';
  };

  /** 보기 바꾸기(달력, 목록) */
  const viewSwitch = () =>
    h(
      'div',
      { class: 'bank-seg', role: 'group', 'aria-label': '보기' },
      ['cal', 'list'].map((k) => h('button', { type: 'button', class: s.view === k ? 'is-on' : null, 'aria-pressed': String(s.view === k), 'data-bank-view': k, onclick: () => ((s.view = k), rerender()) }, k === 'cal' ? '달력' : '목록')),
    );

  /** 맨 위 큰 숫자(면 없이). figs = [[이름, 값, 색 class]] */
  const figures = (figs, lead = null) =>
    h('div', { class: 'bank-figs', 'data-bank-figs': '' }, lead, ...figs.map(([k, v, cls, attrs]) => h('div', { class: `bank-fig${cls ? ` ${cls}` : ''}`, ...(attrs ?? {}) }, h('span', { class: 'bank-fig-k' }, k), h('span', { class: 'bank-fig-v' }, v))));

  /** 이번 달(오늘 기준) 연결된 돈 */
  const monthUsed = (recent, ym) => recent.filter((t) => t.day.startsWith(ym)).reduce((a, t) => a + used(t), 0);

  // ---- 목록 보기: 숫자 셋 → 왼쪽 거래처, 오른쪽 고른 거래처(또는 고른 건) ----

  function listView() {
    const d = s.data;
    const sd = side();
    const today = d?.summary?.today ?? new Date().toISOString().slice(0, 10);
    const all = groups(sd.unpaid);
    const late = all.filter((g) => g.items.some((v) => v.overdue));
    const q = s.q.trim().toLowerCase();
    const base = s.filter === 'overdue' ? late : all;
    const list = q ? base.filter((g) => g.name.toLowerCase().includes(q)) : base;
    const rest = (xs) => xs.reduce((t, v) => t + v.remaining, 0);
    const pick = (f) => () => ((s.filter = f), (s.cp = null), (s.sel = null), (s.detail = null), (s.form = null), rerender());
    const chip = (f, label, n, tab) => h('button', { type: 'button', class: s.filter === f ? 'is-on' : null, 'aria-pressed': String(s.filter === f), 'data-bank-tab': tab, onclick: pick(f) }, label, h('span', {}, ` ${n}`));
    const overdue = rest(sd.unpaid.filter((v) => v.overdue));
    const figs = figures([
      ['남은 돈', won(rest(sd.unpaid))],
      ['그중 기한 지남', won(overdue), overdue > 0 ? 'is-attention' : '', { 'data-bank-overdue': '' }],
      [`이번 달 ${sd.doneWord}`, won(monthUsed(sd.recent, today.slice(0, 7)))],
    ]);
    // 아무도 안 골랐으면 맨 위(가장 늦은) 거래처를 보여 준다
    const on = s.cp ?? list[0]?.key ?? null;
    const openCp = (g) => {
      s.cp = g.key;
      s.cpAll = false;
      // 건이 하나면 거래처 단계를 건너뛰고 그 건을 바로 연다
      if (g.items.length === 1) void select(g.items[0].id, true);
      else {
        s.sel = null;
        s.detail = null;
        s.form = null;
        rerender();
      }
    };
    const left = h(
      'section',
      { class: 'bank-list', 'aria-label': '거래처' },
      h(
        'div',
        { class: 'bank-chips', role: 'group', 'aria-label': '거르기' },
        chip('open', '전체', all.length, 'unpaid'),
        chip('overdue', '기한 지남', late.length, null),
        sd.review.length ? chip('review', '맞춰 볼 입금', sd.review.length, 'review') : null,
        !sd.pay && sd.done.length ? h('button', { type: 'button', 'data-bank-tab': 'received', onclick: () => ((s.tab = 'received'), (s.sel = null), (s.detail = null), rerender()) }, '받은 계산서', h('span', {}, ` ${sd.done.length}`)) : null,
      ),
      s.filter === 'review' ? null : h('input', { class: 'bank-find', type: 'search', placeholder: '거래처 찾기', 'aria-label': '거래처 찾기', value: s.q, 'data-field': 'bank-find', oninput: (e) => ((s.q = e.target.value), rerender()) }),
      s.filter === 'review'
        ? reviewList()
        : list.length
          ? h(
              'div',
              { class: 'bank-items', role: 'list' },
              ...list.map((g) => {
                const worst = g.items[0];
                return h(
                  'button',
                  { type: 'button', role: 'listitem', class: `bank-item${on === g.key ? ' is-on' : ''}`, 'aria-pressed': String(on === g.key), 'data-bank-cust': g.key, 'data-bank-row': g.items.length === 1 ? worst.id : null, 'data-bank-status': worst.status, onclick: () => openCp(g) },
                  h('span', { class: 'bank-item-name' }, g.name),
                  h('span', { class: 'bank-item-amt' }, won(g.remaining)),
                  h('span', { class: `bank-item-sub${worst.overdue ? ' is-attention' : ''}` }, invSub(worst)),
                  h('span', { class: 'bank-item-n' }, `${g.items.length}건`),
                );
              }),
            )
          : h('p', { class: 'bank-none bank-items-empty' }, q ? `'${s.q}' 거래처가 없어요.` : sd.allDone),
    );
    let right = null;
    if (s.filter !== 'review' && list.length) {
      const g = all.find((x) => x.key === on);
      right = s.sel ? detailCard(g && g.items.length > 1 ? g : null) : g ? cpCard(g, sd) : null;
    }
    return [figs, h('div', { class: 'bank-split2' }, left, right)];
  }

  /** 고른 거래처: 이름 → 남은 돈, 받은(낸) 돈 → 계산서 표(누르면 그 건) */
  function cpCard(g, sd) {
    const doneHere = sd.done.filter((v) => cpKey(v) === g.key).reduce((t, v) => t + v.total, 0) + g.items.reduce((t, v) => t + (v.received ?? 0), 0);
    const shown = s.cpAll ? g.items : g.items.slice(0, 8);
    return h(
      'section',
      { class: 'bank-card', 'data-bank-cpcard': g.key, 'aria-label': g.name },
      h('h2', { class: 'bank-card-name' }, g.name),
      h('div', { class: 'bank-figs is-small' }, h('div', { class: 'bank-fig' }, h('span', { class: 'bank-fig-k' }, '남은 돈'), h('span', { class: 'bank-fig-v' }, won(g.remaining))), h('div', { class: 'bank-fig' }, h('span', { class: 'bank-fig-k' }, sd.doneWord), h('span', { class: 'bank-fig-v' }, won(doneHere)))),
      h(
        'div',
        { class: 'bank-tbl', role: 'table', 'aria-label': '계산서' },
        h('div', { class: 'bank-tr is-hd', role: 'row' }, ...['발행일', '품목', '남은 돈', '상태'].map((c) => h('span', { role: 'columnheader' }, c))),
        ...shown.map((v) =>
          h(
            'button',
            { type: 'button', class: 'bank-tr', role: 'row', 'data-bank-row': v.id, 'data-bank-status': v.status, onclick: () => select(v.id, true) },
            h('span', { role: 'cell' }, md(v.writtenOn)),
            h('span', { role: 'cell', class: 'bank-tr-item' }, v.item ?? ''),
            h('span', { role: 'cell', class: 'bank-tr-amt' }, won(v.remaining)),
            h('span', { role: 'cell', class: v.overdue ? 'is-attention' : null }, invSub(v)),
          ),
        ),
      ),
      g.items.length > shown.length ? btn(`나머지 ${g.items.length - shown.length}건 보기`, () => ((s.cpAll = true), rerender()), 'sx-btn-quiet bank-more', { 'data-act': 'bank-cp-all' }) : null,
    );
  }

  // ---- 달력 보기: 숫자 셋 → 달력(하루에 들어온 돈, 받기로 한 돈) + 고른 날 ----

  function calView() {
    const d = s.data;
    const sd = side();
    const today = d?.summary?.today ?? new Date().toISOString().slice(0, 10);
    const ym = s.month ?? today.slice(0, 7);
    const [y, m] = ym.split('-').map(Number);
    const shift = (n) => () => {
      const t = new Date(Date.UTC(y, m - 1 + n, 1));
      s.month = t.toISOString().slice(0, 7);
      s.day = null;
      rerender();
    };
    const dueOf = (v) => v.promisedOn ?? v.dueOn;
    const flows = sd.recent.filter((t) => used(t) > 0);
    const inMap = new Map();
    const dueMap = new Map();
    for (const t of flows) if (t.day.startsWith(ym)) inMap.set(t.day, (inMap.get(t.day) ?? 0) + used(t));
    for (const v of sd.unpaid) {
      const k = dueOf(v);
      if (k?.startsWith(ym)) dueMap.set(k, (dueMap.get(k) ?? 0) + v.remaining);
    }
    const monthDue = sd.unpaid.filter((v) => dueOf(v)?.startsWith(ym)).reduce((t, v) => t + v.remaining, 0);
    const lead0 = h('div', { class: 'bank-month' }, btn('<', shift(-1), 'sx-btn-quiet bank-mnav', { 'aria-label': '이전 달' }), h('h2', {}, `${m}월`), btn('>', shift(1), 'sx-btn-quiet bank-mnav', { 'aria-label': '다음 달' }));
    const figs = figures(
      [
        [`${m}월에 ${sd.pay ? '낼' : '받을'} 돈`, won(monthDue)],
        [sd.doneWord, won([...inMap.values()].reduce((a, b) => a + b, 0))],
        ['기한 지남', won(sd.unpaid.filter((v) => v.overdue).reduce((t, v) => t + v.remaining, 0)), 'is-attention', { 'data-bank-overdue': '' }],
      ],
      lead0,
    );
    const first = new Date(Date.UTC(y, m - 1, 1));
    const lead = (first.getUTCDay() + 6) % 7;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const pickDay = s.day ?? (today.startsWith(ym) ? today : null);
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(h('div', { class: 'bank-day is-out' }));
    for (let n = 1; n <= days; n++) {
      const iso = `${ym}-${String(n).padStart(2, '0')}`;
      cells.push(
        h(
          'button',
          { type: 'button', class: `bank-day${iso === today ? ' is-today' : ''}${pickDay === iso ? ' is-on' : ''}`, 'data-bank-day': iso, 'aria-pressed': String(pickDay === iso), onclick: () => ((s.day = iso), rerender()) },
          h('span', { class: 'bank-day-n' }, String(n)),
          inMap.get(iso) ? h('span', { class: 'bank-day-v is-in' }, `+${man(inMap.get(iso))}`) : null,
          dueMap.get(iso) ? h('span', { class: `bank-day-v${iso < today ? ' is-attention' : ''}` }, man(dueMap.get(iso))) : null,
        ),
      );
    }
    while (cells.length % 7) cells.push(h('div', { class: 'bank-day is-out' }));
    const toCp = (v) => () => {
      s.view = 'list';
      s.filter = 'open';
      s.q = '';
      s.cp = cpKey(v);
      s.cpAll = false;
      const g = groups(sd.unpaid).find((x) => x.key === s.cp);
      if (g?.items.length === 1) void select(g.items[0].id, true);
      else {
        s.sel = null;
        s.detail = null;
        rerender();
      }
    };
    const dueList = pickDay ? sd.unpaid.filter((v) => dueOf(v) === pickDay) : [];
    const inList = pickDay ? flows.filter((t) => t.day === pickDay) : [];
    const past = pickDay && pickDay < today;
    const sideRow = (name, amt, attrs = {}, onclick = null) => h(onclick ? 'button' : 'div', { ...(onclick ? { type: 'button', onclick } : {}), class: 'bank-side-row', ...attrs }, h('span', {}, name), h('span', { class: 'bank-side-amt' }, amt));
    const dueWord = past ? (sd.pay ? '못 냄' : '못 받음') : sd.pay ? '낼 돈' : '받을 돈';
    return [
      figs,
      h(
        'div',
        { class: 'bank-calwrap' },
        h(
          'section',
          { class: 'bank-cal', 'aria-label': `${m}월 달력` },
          h('div', { class: 'bank-cal-hd' }, ...['월', '화', '수', '목', '금', '토', '일'].map((w) => h('span', {}, w))),
          h('div', { class: 'bank-cal-grid' }, ...cells),
          h('div', { class: 'bank-cal-key' }, h('span', { class: 'is-in' }, `+ ${sd.pay ? '나간' : '들어온'} 돈`), h('span', {}, `${sd.pay ? '낼' : '받을'} 돈`), h('span', { class: 'is-attention' }, `기한 지난 돈`)),
        ),
        h(
          'aside',
          { class: 'bank-side', 'aria-label': pickDay ? md(pickDay) : '날짜' },
          h('h2', {}, pickDay ? md(pickDay) : '날짜를 골라 주세요'),
          dueList.length ? [h('h3', { class: past ? 'is-attention' : null }, dueWord, h('span', {}, ` ${won(dueList.reduce((t, v) => t + v.remaining, 0))}`)), ...dueList.map((v) => sideRow(v.cpName ?? '거래처 미상', won(v.remaining), { 'data-bank-side-row': v.id }, toCp(v)))] : null,
          inList.length ? [h('h3', { class: 'is-in' }, sd.pay ? '나감' : '들어옴', h('span', {}, ` +${won(inList.reduce((t, x) => t + used(x), 0))}`)), ...inList.map((t) => sideRow(t.payer ?? '이름 없음', `+${won(used(t))}`, { class: 'bank-side-row is-in' }))] : null,
          pickDay && !dueList.length && !inList.length ? h('p', { class: 'bank-none' }, '이날은 없어요.') : null,
        ),
      ),
    ];
  }

  function noticeBar() {
    const n = s.notice;
    if (!n) return null;
    const [label, fn] = n.retry ?? ['닫기', null];
    const onclick = async () => {
      s.notice = null;
      if (fn) await fn();
      else rerender();
    };
    return bar(n.text, { bad: n.bad, extra: n.extra, ic: n.ic, action: btn(label, onclick, 'sx-btn-quiet', { 'data-act': fn ? 'bank-retry' : 'bank-notice-close' }), attrs: { 'data-bank-notice': n.bad ? 'bad' : 'info' } });
  }

  function undoBar() {
    if (!s.undo || Date.now() >= s.undo.until) return null;
    return bar(s.undo.text, { ic: 'check', action: btn('되돌리기', undoNow, 'sx-btn-quiet', { 'data-act': 'bank-undo' }), attrs: { 'data-bank-undo': '' } });
  }

  function offerBar() {
    const o = s.offer;
    if (!o) return null;
    const close = () => ((s.offer = null), rerender());
    if (o.conflict) return bar(`'${o.name}'는 다른 거래처 입금자 이름이기도 해서 기억하지 않았어요.`, { action: btn('닫기', close, 'sx-btn-quiet'), attrs: { 'data-bank-offer': '' } });
    return bar(`다음부터 '${o.name}' 입금은 ${o.cpName ?? '이 거래처'}로 볼까요?`, {
      attrs: { 'data-bank-offer': '' },
      action: [
        btn('기억하기', async () => {
          s.offer = null;
          if (await act('bank.addAlias', { counterpartyId: o.counterpartyId, name: o.name, learned: true })) toast('기억했어요');
        }, 'sx-btn-primary', { 'data-act': 'bank-alias-remember' }),
        btn('이번만', close, 'sx-btn-quiet', { 'data-act': 'bank-alias-once' }),
      ],
    });
  }

  /** 건 목록: 한 면 안의 줄. 왼쪽은 거래처와 발행일, 오른쪽은 남은 돈과 언제까지. 고른 줄 바로 아래에 그 건이 펼쳐진다 */
  function recvList(list, empty) {
    if (!list.length) return h('div', { class: 'empty' }, empty);
    return h('div', { class: 'bank-rows', role: 'list' }, ...recvRows(list));
  }
  /** 건 줄. nested = 거래처 머리 줄 아래의 건(거래처 이름 대신 발행일과 품목을 앞에) */
  function recvRows(list, nested = false) {
    return list.flatMap((v) => {
        const on = s.sel === v.id;
        const done = v.status === 'received';
        const sub = done
          ? h('span', { class: 'bank-row-sub is-done' }, statusText(v))
          : v.status === 'waiting' && v.promisedOn
            ? h('span', { class: 'bank-row-sub' }, `${md(v.promisedOn)}에 주기로 했어요`)
            : v.status === 'excluded' || v.status === 'unknown'
              ? h('span', { class: 'bank-row-sub' }, statusText(v))
              : h('span', { class: `bank-row-sub${v.overdue ? ' is-attention' : ''}` }, dueText(v));
        const row = h(
          'div',
          {
            class: `bank-row${on ? ' is-on' : ''}${nested ? ' is-sub' : ''}`,
            role: 'listitem',
            tabindex: '0',
            'aria-expanded': String(on),
            'data-bank-row': v.id,
            'data-bank-status': v.status,
            onclick: () => select(v.id),
            onkeydown: (e) => {
              if ((e.key !== 'Enter' && e.key !== ' ') || e.isComposing) return;
              e.preventDefault();
              void select(v.id);
            },
          },
          nested ? h('span', { 'aria-hidden': 'true' }) : h('span', { class: `bank-av${v.overdue ? ' is-attention' : done ? ' is-done' : ''}`, 'aria-hidden': 'true' }, initial(v.cpName)),
          h(
            'span',
            { class: 'bank-row-main' },
            h('span', { class: 'bank-row-name' }, nested ? `${md(v.writtenOn)} 발행${v.item ? `  ${v.item}` : ''}` : (v.cpName ?? '거래처 미상')),
            nested && v.status !== 'partial' ? null : h('span', { class: 'bank-row-meta' }, v.status === 'partial' ? `${won(v.total)} 중 ${won(v.received)} 받았어요` : `${md(v.writtenOn)} 발행${v.item ? `  ${v.item}` : ''}`),
          ),
          h('span', { class: 'bank-row-end' }, h('span', { class: 'bank-row-amt' }, won(done ? v.total : v.remaining)), sub),
        );
        return on ? [row, detailCard()] : [row];
      });
  }

  /** 건 하나 열기. keep = 같은 건을 다시 눌러도 닫지 않는다(거래처 표에서 연다) */
  async function select(id, keep = false) {
    s.sel = s.sel === id && !keep ? null : id;
    s.form = null;
    s.formErr = null;
    s.detail = null;
    if (s.sel) s.detail = await call('bank.receivable', { id: s.sel }).catch(() => (tell('이 건을 열지 못했어요.', { bad: true, retry: ['다시 시도', () => ((s.sel = null), select(id))] }), null));
    rerender();
  }

  /** 건 하나. g = 거래처 표에서 열었으면 그 거래처(위에 돌아가기) */
  function detailCard(g = null) {
    const d = s.detail;
    if (!d) return null;
    const v = d.receivable;
    const open = v.status !== 'received' && v.status !== 'excluded';
    const allocs = d.allocs.filter((a) => !a.removedAt);
    const form = s.form;
    const today = new Date().toISOString().slice(0, 10);
    const close = () => ((s.form = null), (s.formErr = null), rerender());
    /** 폼을 열면 그 폼만 보인다(한 번에 한 가지). sel = 처음 포커스할 칸 */
    const openForm = (f, sel) => {
      s.form = f;
      s.formErr = null;
      rerender();
      focusLater(`[data-bank-form] ${sel}`);
    };
    /** 폼 저장: 성공하면 닫고, 실패하면 폼 안에 까닭을 남긴다 */
    const done = (run) => async () => {
      if (await run()) {
        s.form = null;
        rerender();
      }
    };
    const formActs = (label, submit, attrs = {}) => h('div', { class: 'sx-actions' }, btn(label, submit, 'sx-btn-primary', attrs), btn('그만두기', close, 'sx-btn-quiet'));
    let formEl = null;
    if (form?.kind === 'received') {
      // 칸 검사(금액 0·빈 값, 덜 넣은 날짜)를 먼저 하고, 맞으면 main에 보낸다
      const submit = done(() => checkFields(formEl) && act('bank.markReceived', { receivableId: v.id, method: form.method, amount: form.amount, on: form.on }, '받았다고 적었어요', 'form'));
      const pw = side().pay;
      formEl = h(
        'div',
        { class: 'cp-form bank-mark-form', 'data-bank-form': 'received', onkeydown: keys(submit, close) },
        h('h3', {}, pw ? '얼마 냈어요?' : '얼마 받았어요?'),
        h(
          'div',
          { class: 'bank-mark-grid' },
          field({ label: '금액', error: errAt('form', 'amount'), input: amountInput({ value: form.amount, compact: true, 'data-field': 'amount', oninput: (e) => (form.amount = amountOf(e.target)) }) }),
          field({ label: pw ? '낸 날' : '받은 날', error: errAt('form', 'on'), input: dateInput({ value: form.on, required: true, compact: true, 'data-field': 'on', oninput: (e) => (form.on = e.target.value) }) }),
        ),
        pickRows(['cash', 'other_account', 'offset', 'other'].map((m) => [m, METHOD_LABEL[m]]), form.method, (m) => ((form.method = m), rerender()), { 'data-field': 'method', 'aria-label': pw ? '낸 방법' : '받은 방법' }),
        formMsg('form'),
        formActs(pw ? '냈어요' : '받았어요', submit, { 'data-act': 'bank-mark-save' }),
      );
    } else if (form?.kind === 'promise') {
      const submit = done(() => checkFields(formEl) && act('bank.setPromised', { receivableId: v.id, on: form.on }, '기다리는 날을 정했어요', 'form'));
      formEl = h(
        'div',
        { class: 'cp-form', 'data-bank-form': 'promise', onkeydown: keys(submit, close) },
        field({ label: '언제 받기로 했어요?', error: errAt('form', 'on'), input: dateInput({ value: form.on, required: true, compact: true, 'data-field': 'promise-on', oninput: (e) => (form.on = e.target.value) }) }),
        formMsg('form'),
        formActs('정하기', submit),
      );
    } else if (form?.kind === 'exclude') {
      const submit = done(() => act('bank.exclude', { receivableId: v.id, reason: form.reason }, '지웠어요', 'form'));
      formEl = h(
        'div',
        { class: 'cp-form', 'data-bank-form': 'exclude', onkeydown: keys(submit, close) },
        h('div', { class: 'sx-field' }, h('span', { class: 'sx-field-label', id: 'bank-reason-label' }, '지우는 까닭'), pickRows(['받지 않기로 함', '거래 취소', '기타'].map((r) => [r, r]), form.reason, (r) => ((form.reason = r), rerender()), { 'data-field': 'reason', 'aria-labelledby': 'bank-reason-label' })),
        formMsg('form'),
        formActs('지우기', submit),
        h('p', { class: 'sx-meta' }, '세무 처리(대손 등)는 앱이 판단하지 않아요. 세무사와 상의하세요.'),
      );
    }
    if (!d || d.receivable.id !== s.sel) return null;
    // 볼타 "계산서와 입금 내역": 품목과 남은 돈 → 발행일과 기한 → 받은 만큼 찬 막대 → 입금 내역(연결된 것, 앱이 맞다고 본 것) → 버튼 셋
    const sd = side();
    const flowName = (t) => t.payer ?? '이름 없음';
    const depRow = (date, name, amt, end, attrs = {}) => h('div', { class: 'bank-dep2', ...attrs }, h('span', { class: 'bank-dep2-day' }, date), h('span', { class: 'bank-dep2-name' }, name), h('span', { class: 'bank-dep2-amt' }, won(amt)), end);
    const sugg = sd.review.flatMap((t) => t.candidates.filter((c) => c.receivableIds.includes(v.id)).map((c) => ({ t, c })));
    const suggIds = new Set(sugg.map((x) => x.t.id));
    const others = open ? d.attachable.filter((t) => !suggIds.has(t.id)).slice(0, 5) : [];
    const picking = s.pickOther === v.id;
    const logRows = s.logFor === v.id ? d.events.map((e) => h('div', { class: 'bank-log-row' }, h('span', {}, md(e.at.slice(0, 10))), h('span', {}, `${e.actor === 'auto' ? '앱이' : '사장님이'} ${ACTION_LABEL[e.action] ?? '고쳤어요'}`), e.undoOf === null && !e.undone && e.action !== 'undo' ? btn('되돌리기', () => act('bank.undo', { seq: e.seq }, '되돌렸어요'), 'sx-btn-quiet', { 'data-act': 'bank-event-undo' }) : null)) : [];
    const due = v.status === 'received' ? statusText(v) : v.promisedOn ? `${md(v.promisedOn)} 예정` : v.overdue ? `${-v.dueIn}일 지남` : v.dueOn ? `${md(v.dueOn)}까지` : '기한 없음';
    const got = v.total - v.remaining;
    const paidBar = got > 0 && v.status !== 'received'
      ? h('div', { class: 'bank-paid', 'data-bank-paid': '' }, h('progress', { class: 'bank-paid-bar', max: String(v.total), value: String(got), 'aria-label': sd.pay ? '낸 만큼' : '받은 만큼' }), h('div', { class: 'bank-paid-k' }, h('span', {}, h('b', {}, won(got)), sd.pay ? ' 냄' : ' 받음'), h('span', {}, `합계 ${won(v.total)}`)))
      : null;
    const x = (a) => h('button', { type: 'button', class: 'bank-dep2-x', 'aria-label': '연결 끊기', title: '연결 끊기', 'data-act': 'bank-detach', onclick: () => act('bank.detach', { allocId: a.id }, '연결을 끊었어요') }, icon('close'));
    const rows = [
      ...allocs.map((a) => depRow(md(a.txn ? a.txn.day : a.receivedOn), a.txn ? flowName(a.txn) : `${METHOD_LABEL[a.method] ?? '직접'}${sd.pay ? '으로 냄' : '으로 받음'}`, a.amount, x(a), { 'data-bank-alloc': a.id })),
      ...sugg.map(({ t, c }) =>
        h(
          'div',
          { class: 'bank-dep2 is-sugg', title: c.reason },
          h('span', { class: 'bank-dep2-day' }, md(t.day)),
          h('span', { class: 'bank-dep2-name' }, flowName(t), h('small', {}, sd.pay ? '이 출금 같아요' : '이 입금 같아요')),
          h('span', { class: 'bank-dep2-acts' }, h('span', { class: 'bank-dep2-amt' }, won(t.unallocated)), btn('맞아요', () => accept(t, c), 'sx-btn-primary', { 'data-act': 'bank-accept' }), c.receivableIds.length === 1 ? btn('아니요', () => act('bank.reject', { txnId: t.id, receivableId: v.id }, '이 건이 아니라고 했어요'), 'sx-btn-quiet', { 'data-act': 'bank-reject' }) : null),
        ),
      ),
    ];
    const headTitle = g ? (v.item || `${md(v.writtenOn)} 계산서`) : (v.cpName ?? '거래처 미상');
    const subLeft = g || !v.item ? `${md(v.writtenOn)} 발행` : `${md(v.writtenOn)} 발행, ${v.item}`;
    return h(
      'section',
      { class: 'bank-card bank-inv', 'data-bank-detail': v.id, 'aria-label': `${v.cpName ?? '거래처 미상'} 계산서` },
      g ? h('button', { type: 'button', class: 'bank-card-back', 'data-act': 'bank-cp-back', onclick: () => ((s.sel = null), (s.detail = null), (s.form = null), rerender()) }, `< ${g.name}`) : null,
      h(
        'div',
        { class: 'bank-inv-hd' },
        h('div', { class: 'bank-card-hd' }, h('h2', {}, headTitle), h('span', { class: 'bank-card-amt' }, won(v.status === 'received' ? v.total : v.remaining))),
        h('div', { class: 'bank-card-sub' }, h('span', {}, subLeft), h('span', { class: v.overdue && v.status !== 'received' ? 'is-attention' : null }, due)),
      ),
      paidBar,
      rows.length || others.length
        ? h(
            'div',
            { class: 'bank-deps' },
            rows.length ? h('h3', {}, sd.flow) : null,
            ...rows,
            others.length && !picking ? h('button', { type: 'button', class: 'bank-link', 'data-act': 'bank-pick-other', onclick: () => ((s.pickOther = v.id), rerender()) }, sd.pay ? '다른 출금 고르기' : '다른 입금 고르기') : null,
            picking ? others.map((t) => depRow(md(t.day), flowName(t), t.unallocated, btn('연결', () => attach(t, v), 'sx-btn-quiet', { 'data-act': 'bank-attach' }), { 'data-bank-attach': t.id })) : null,
          )
        : null,
      formEl
        ? h('div', { class: 'bank-card-form' }, formEl)
        : h(
            'div',
            { class: 'bank-card-acts' },
            open ? btn(sd.pay ? '냈어요' : '받았어요', () => openForm({ kind: 'received', method: 'cash', amount: v.remaining, on: today }, '[data-field="amount"]'), '', { 'data-act': 'bank-mark' }) : null,
            open ? btn('아직 기다려요', () => openForm({ kind: 'promise', on: v.promisedOn ?? today }, '[data-field="promise-on"]'), 'sx-btn-quiet', { 'data-act': 'bank-promise' }) : null,
            open && v.remaining > 0 && v.remaining <= 1000 && v.received > 0 ? btn('차액은 수수료', () => act('bank.closeFee', { receivableId: v.id }, '차액을 수수료로 닫았어요'), 'sx-btn-quiet', { 'data-act': 'bank-close-fee' }) : null,
            v.status === 'excluded' ? btn('되살리기', () => act('bank.exclude', { receivableId: v.id, reason: null }, '되살렸어요')) : null,
            h('span', { class: 'bank-grow' }),
            d.events.length ? btn(s.logFor === v.id ? '기록 닫기' : '기록', () => ((s.logFor = s.logFor === v.id ? null : v.id), rerender()), 'sx-btn-quiet bank-dim', { 'data-act': 'bank-log' }) : null,
            open ? btn('지우기', () => openForm({ kind: 'exclude', reason: '받지 않기로 함' }, '[data-field="reason"] .is-picked'), 'sx-btn-quiet bank-dim', { 'data-act': 'bank-exclude' }) : null,
          ),
      logRows.length ? h('div', { class: 'bank-log' }, ...logRows) : null,
    );
  }

  async function attach(t, v) {
    const r = await act('bank.attach', { txnId: t.id, receivableId: v.id }, '입금을 연결했어요');
    if (r?.aliasOffer) s.offer = { ...r.aliasOffer, cpName: v.cpName };
    rerender();
  }

  async function accept(t, c, closeFee = false) {
    const r = await act('bank.accept', { txnId: t.id, ids: c.receivableIds.join(','), closeFee }, `${c.cpName ?? '거래처'} 건에 붙였어요`);
    if (r?.aliasOffer) s.offer = { ...r.aliasOffer, cpName: c.cpName };
    rerender();
  }

  function reviewList(list = s.data?.review ?? []) {
    if (!list.length) return h('div', { class: 'empty' }, '확인할 입금이 없어요.');
    return h(
      'div',
      { class: 'bank-rows bank-review', 'data-bank-review': '' },
      ...list.map((t) => {
        const cps = counterparties();
        const g = s.assign?.id === t.id ? s.assign : null;
        const cancel = () => ((s.assign = null), rerender());
        const save = async () => {
          const { cp: counterpartyId, remember } = g;
          s.assign = null;
          const r = await act('bank.assignTxn', { txnId: t.id, counterpartyId, remember: !!t.payer && remember }, '거래처를 정했어요');
          if (r?.conflict) s.offer = { name: t.payer, conflict: true };
          rerender();
        };
        // 후보가 있으면 [맞아요] 줄 끝에 조용히, 없으면 이 줄이 할 일이다
        const otherActs = (quiet) => [
          cps.length
            ? btn('거래처 고르기', () => {
                s.assign = { id: t.id, cp: cps[0].id, remember: true };
                rerender();
                focusLater(`[data-bank-assign="${CSS.escape(t.id)}"] [data-field="cp"]${cps.length > PICK_MAX ? '' : ' .is-picked'}`);
              }, quiet ? 'sx-btn-quiet' : 'sx-btn-primary', { 'data-act': 'bank-assign' })
            : null,
          btn('상관없음', () => act('bank.ignoreTxn', { txnId: t.id, reason: 'unrelated' }, '상관없는 입금으로 뺐어요'), 'sx-btn-quiet', { 'data-act': 'bank-ignore' }),
        ];
        return h(
          'article',
          { class: 'bank-txn', 'data-bank-txn': t.id },
          h(
            'div',
            { class: 'bank-txn-hd' },
            h('span', { class: 'bank-av', 'aria-hidden': 'true' }, initial(t.payer)),
            h('span', { class: 'bank-row-main' }, h('h2', { class: 'bank-row-name' }, t.payer ?? '이름 없는 입금'), h('span', { class: 'bank-row-meta' }, md(t.day))),
            h('span', { class: 'bank-row-amt' }, won(t.unallocated)),
          ),
          t.candidates.length
            ? h(
                'ul',
                { class: 'bank-cands' },
                ...t.candidates.map((c, i) =>
                  h(
                    'li',
                    { 'data-bank-cand': c.receivableIds.join(',') },
                    h('div', { class: 'bank-cand-q', title: c.reason }, `${c.cpName ?? '거래처'} ${md(c.writtenOn)} 건이 맞나요?`),
                    // 카드의 주요 단추는 첫 후보의 [맞아요] 하나
                    h(
                      'div',
                      { class: 'sx-actions' },
                      btn('맞아요', () => accept(t, c), i === 0 ? 'sx-btn-primary' : '', { 'data-act': 'bank-accept' }),
                      c.fit === 'fee' ? btn('맞아요(차액 수수료)', () => accept(t, c, true), 'sx-btn-quiet', { 'data-act': 'bank-accept-fee' }) : null,
                      c.receivableIds.length === 1 ? btn('아니요', () => act('bank.reject', { txnId: t.id, receivableId: c.receivableIds[0] }, '이 건이 아니라고 했어요'), 'sx-btn-quiet', { 'data-act': 'bank-reject' }) : null,
                    ),
                  ),
                ),
              )
            : null,
          g
            ? h(
                'div',
                { class: 'cp-form', 'data-bank-assign': t.id, onkeydown: keys(null, cancel) },
                cps.length > PICK_MAX
                  ? field({ label: '거래처', input: selectInput(cps.map((c) => [c.id, c.name]), { value: g.cp, compact: true, 'data-field': 'cp', onchange: (e) => (g.cp = e.target.value) }) })
                  : h('div', { class: 'sx-field' }, h('span', { class: 'sx-field-label', id: `bank-assign-${t.id}` }, '어느 거래처 입금인가요?'), pickRows(cps.map((c) => [c.id, c.name]), g.cp, (k) => ((g.cp = k), rerender()), { 'data-field': 'cp', 'aria-labelledby': `bank-assign-${t.id}` })),
                t.payer ? h('label', { class: 'auth-row' }, h('input', { type: 'checkbox', 'data-field': 'remember', checked: g.remember, onchange: (e) => (g.remember = e.target.checked) }), h('span', { class: 'sx-body-sm' }, `다음부터 '${t.payer}' 입금은 이 거래처로`)) : null,
                h('div', { class: 'sx-actions' }, btn('저장', save, 'sx-btn-primary', { 'data-act': 'bank-assign-save' }), btn('취소', cancel, 'sx-btn-quiet')),
              )
            : t.candidates.length
              ? null
              : h('div', { class: 'sx-actions' }, otherActs(false)),
        );
      }),
    );
  }
  function openConnect() {
    if (!bankAuto) return goAccounts();
    s.connect = true;
    s.tab = 'unpaid';
    rerender();
    void bankAuto.start();
  }

  /** [최신화]: 원천 → 넣기 → 맞추기. 진행을 1.5초마다 본다. 결과는 화면 위 알림 한 줄 */
  async function startRefresh(id) {
    if (s.refreshing[id]) return;
    try {
      const job = await call('bank.refresh', { accountId: id });
      watchRefresh(id, job);
    } catch (e) {
      fail(e);
      rerender();
    }
  }
  function watchRefresh(id, job) {
    s.refreshing[id] = job;
    rerender();
    const tick = async () => {
      const j = await call('bank.refreshStatus', { accountId: id }).catch(() => null);
      if (!j || j.state === 'done' || j.state === 'failed') {
        delete s.refreshing[id];
        if (j?.state === 'done') tell(j.result?.newCount ? `새 거래 ${j.result.newCount}줄을 넣었어요.` : '새 거래가 없어요.', { extra: j.result?.match?.auto ? `자동으로 맞춘 입금 ${j.result.match.auto}건` : null });
        else if (j?.state === 'failed') {
          if (j.code === 'source.too_soon') tell(soonText(j.retryAt));
          else if (j.code === 'source.daily_limit') tell(DAILY_TEXT);
          else tell(sourceErrText(j.code), { bad: true, retry: ['다시 시도', () => startRefresh(id)] });
        }
        await refresh();
        return;
      }
      s.refreshing[id] = j;
      rerender();
      setTimeout(tick, 1500);
    };
    setTimeout(tick, 1500);
  }
  /** [계좌 추가]: 눌렀을 때만 폼(처음이면 동의 카드)을 연다 */
  const openAdd = () => {
    s.adding = { bank: '국민', number: '', alias: '' };
    s.formErr = null;
    rerender();
    focusLater('[data-bank-account-form] [data-field="number"]');
  };

  function accountsTab() {
    const list = s.data?.accounts ?? [];
    const a = s.adding;
    const consent = s.data?.consent;
    const cancel = () => ((s.adding = null), (s.formErr = null), rerender());
    const save = async () => {
      if (!checkFields(form)) return;
      const r = await act('bank.addAccount', { bank: a.bank, number: a.number, alias: a.alias || undefined }, undefined, 'account');
      if (r) {
        s.adding = null;
        tell(r.bank ? `${r.bank} 끝 ${r.last4} 계좌를 등록했어요.` : '계좌를 등록했어요.', { ic: 'check', extra: '이제 [거래내역 파일 올리기]로 은행 거래내역을 넣을 수 있어요.' });
      }
      rerender();
    };
    const form = !a
      ? null
      : !consent
        ? h(
            'article',
            { class: 'sx-card', 'data-bank-consent': '', onkeydown: keys(null, cancel) },
            h('h2', { class: 'board-card-title' }, '계좌 거래내역을 이 PC에서만 맞춰요'),
            h('p', { class: 'sx-body-sm' }, '넣으신 거래내역과 계좌번호는 이 PC에 암호화해 저장해요. 우리 서버와 AI 모델로 보내지 않아요.'),
            h('p', { class: 'sx-body-sm' }, '거래내역에는 입금하신 분의 이름처럼 다른 사람의 정보도 들어 있어요. 사업 거래 확인에만 써 주세요.'),
            h('p', { class: 'sx-body-sm' }, '앱은 은행에 로그인하지 않아요(파일을 넣을 때). 돈을 보내거나 이체하지 않아요.'),
            h('p', { class: 'sx-body-sm' }, '언제든 받을 돈 > 내 계좌에서 계좌와 거래내역을 지울 수 있어요.'),
            formMsg('account'),
            h(
              'div',
              { class: 'sx-actions' },
              btn('동의하고 계좌 추가', async () => {
                if (!(await act('bank.consent', {}, undefined, 'account'))) return;
                rerender();
                focusLater('[data-bank-account-form] [data-field="number"]');
              }, 'sx-btn-primary', { 'data-act': 'bank-consent' }),
              btn('그만두기', cancel, 'sx-btn-quiet'),
            ),
          )
        : h(
            'div',
            { class: 'cp-form', 'data-bank-account-form': '', onkeydown: keys(save, cancel) },
            field({ label: '은행', error: errAt('account', 'bank'), input: selectInput(BANKS.map((b) => [b, b]), { value: a.bank, 'data-field': 'bank', onchange: (e) => (a.bank = e.target.value) }) }),
            field({ label: '계좌번호', error: errAt('account', 'number'), input: accountInput({ value: a.number, 'data-field': 'number', oninput: (e) => (a.number = e.target.value) }) }),
            field({ label: '부르는 이름(선택)', error: errAt('account', 'alias'), input: textInput({ value: a.alias, max: LIMITS.accountAlias, spellcheck: 'false', placeholder: '예: 주거래 국민', 'data-field': 'alias', oninput: (e) => (a.alias = e.target.value) }) }),
            formMsg('account'),
            h('div', { class: 'sx-actions' }, btn('저장', save, 'sx-btn-primary', { 'data-act': 'bank-account-save' }), btn('그만두기', cancel, 'sx-btn-quiet')),
          );
    const addBtn = (kind) => btn('파일로 쓸 계좌 추가', openAdd, kind, { 'data-act': 'bank-account-add' });
    /** [지우기]를 한 번 누르면 그 줄이 확인 줄로 바뀐다(창 confirm은 셸 창에서 막혀 있다) */
    const confirmRow = (x) => {
      const no = () => ((s.confirmDel = null), rerender());
      const yes = async () => {
        s.confirmDel = null;
        if (await act('bank.deleteAccount', { id: x.id })) {
          tell(`${x.bank} 끝 ${x.last4} 계좌와 그 거래내역을 지웠어요.`, { ic: 'check' });
          rerender();
        }
      };
      return h(
        'div',
        { class: 'bank-acct-confirm', onkeydown: keys(null, no) },
        h('div', {}, h('div', {}, `${x.bank} 끝 ${x.last4} 계좌와 그 거래내역을 지울까요?`), h('div', { class: 'sx-meta' }, '그 입금으로 받음이 된 건은 못 받음으로 돌아가요.')),
        h('div', { class: 'sx-actions' }, btn('지우기', yes, 'sx-btn-primary', { 'data-act': 'bank-account-delete-yes' }), btn('그만두기', no, 'sx-btn-quiet', { 'data-act': 'bank-account-delete-no' })),
      );
    };
    const row = (x) => {
      const job = s.refreshing[x.id];
      const reveal = async (e) => {
        const cell = e.target.closest('[data-bank-account]').querySelector('[data-bank-number]');
        const r = await call('bank.revealAccount', { id: x.id }).catch(() => null);
        if (!r?.number) return;
        cell.textContent = r.number;
        setTimeout(() => (cell.textContent = `끝 ${x.last4}`), 3000);
      };
      return h(
        'div',
        { class: `bank-acct${s.confirmDel === x.id ? ' is-on' : ''}`, 'data-bank-account': x.id, ...(s.confirmDel === x.id ? { 'data-bank-account-confirm': '' } : {}) },
        h('span', { class: 'bank-av is-bank', 'aria-hidden': 'true' }, x.bank.slice(0, 1)),
        h(
          'span',
          { class: 'bank-row-main' },
          h('span', { class: 'bank-row-name' }, `${x.bank} `, h('span', { class: 'sx-id', 'data-bank-number': x.id }, `끝 ${x.last4}`), x.alias ? h('span', { class: 'bank-acct-alias' }, x.alias) : null),
          h('span', { class: 'bank-row-meta' }, x.lastDay ? `${md(x.lastDay)}까지 ${x.txnCount}줄` : '아직 거래내역이 없어요'),
        ),
        h(
          'span',
          { class: 'bank-acct-end' },
          h('span', { class: `bank-link bank-link-${x.linkState}`, 'data-bank-link': x.linkState, title: x.linkState === 'auto_error' ? sourceErrText(x.linkError) : null }, LINK_LABEL[x.linkState] ?? LINK_LABEL.file_only),
          job
            ? h('span', { class: 'sx-meta', 'data-bank-refresh-state': job.state }, `${REFRESH_STEP[job.state] ?? '받는 중'}${job.jobs ? ` ${job.done ?? 0}/${job.jobs}` : ''}`)
            : x.canRefresh
              ? btn('새로고침', () => startRefresh(x.id), 'sx-btn-quiet', { 'data-act': 'bank-refresh' })
              : null,
          btn('번호 보기', reveal, 'sx-btn-quiet'),
          btn('지우기', () => {
            s.confirmDel = x.id;
            rerender();
            focusLater('[data-act="bank-account-delete-no"]');
          }, 'sx-btn-quiet', { 'data-act': 'bank-account-delete' }),
        ),
        s.confirmDel === x.id ? confirmRow(x) : null,
      );
    };
    return h(
      'div',
      { class: 'bank-tab' },
      list.length ? h('div', { class: 'bank-rows' }, ...list.map(row)) : a ? null : h('div', { class: 'empty' }, h('div', {}, '등록한 계좌가 없어요.'), h('div', { class: 'sx-actions' }, bankAuto ? btn('은행 연결하기', openConnect, 'sx-btn-primary', { 'data-act': 'bank-auto-open' }) : null, addBtn(bankAuto ? 'sx-btn-quiet' : 'sx-btn-primary'))),
      form ?? (list.length ? h('div', { class: 'sx-actions' }, bankAuto ? btn('은행 연결하기', openConnect, '', { 'data-act': 'bank-auto-open' }) : null, addBtn('sx-btn-quiet')) : null),
      h('p', { class: 'sx-meta rs-foot' }, list.some((x) => x.linkState !== 'file_only') ? '자동으로 가져오는 계좌는 [새로 가져오기]로 새 입금을 받아요. 다른 계좌는 은행에서 내려받은 엑셀이나 CSV를 올려 주세요.' : '은행 인터넷뱅킹에서 거래내역을 엑셀이나 CSV로 내려받아 올려 주세요. 파일을 넣을 때 앱은 은행에 접속하지 않아요.'),
    );
  }

  function importTab() {
    const p = s.preview;
    if (!p) return h('div', { class: 'empty' }, '올린 파일이 없어요.');
    const accounts = s.data?.accounts ?? [];
    const cancel = async () => {
      s.preview = null;
      s.tab = 'unpaid';
      s.formErr = null;
      await call('bank.cancelStatement').catch(() => {});
      rerender();
    };
    const roleSel = (i, name) => {
      const cur = Object.entries(s.cols).find(([r, v]) => r !== 'headerRow' && v === i)?.[0] ?? '';
      return h(
        'select',
        {
          class: 'doc-in',
          'data-col': String(i),
          'aria-label': `${name} 열은 무엇인가요`,
          onchange: async (e) => {
            for (const [r, v] of Object.entries(s.cols)) if (v === i && r !== 'headerRow') delete s.cols[r];
            if (e.target.value) s.cols[e.target.value] = i;
            await repreview();
          },
        },
        h('option', { value: '' }, '쓰지 않음'),
        ...Object.entries(ROLE_LABEL).map(([r, label]) => h('option', { value: r, selected: cur === r }, label)),
      );
    };
    return h(
      'article',
      { class: 'sx-card', 'data-bank-preview': '', onkeydown: keys(null, cancel) },
      h('h2', { class: 'board-card-title' }, p.ok ? `${p.bankHint ?? ''} 거래내역 ${p.period.from ? `${md(p.period.from)}~${md(p.period.to)}` : ''}, 입금 ${p.totals.inCount}줄 출금 ${p.totals.outCount}줄` : '열을 알아보지 못했어요. 각 열이 무엇인지 골라 주세요.'),
      p.skipped ? h('p', { class: 'sx-meta' }, `날짜/금액을 읽지 못해 뺀 줄 ${p.skipped}줄`) : null,
      field({ label: '어느 계좌의 거래내역인가요?', input: selectInput(accounts.map((a) => [a.id, `${a.bank} 끝 ${a.last4}${a.alias ? ` ${a.alias}` : ''}`]), { value: s.previewAccount, compact: true, 'data-field': 'account', onchange: (e) => (s.previewAccount = e.target.value) }) }),
      p.accountLast4 && !accounts.some((a) => a.last4 === p.accountLast4) ? note(`파일의 계좌 끝자리(${p.accountLast4})와 같은 등록 계좌가 없어요. 맞는 계좌인지 확인해 주세요.`, true) : null,
      h(
        'div',
        { class: 'list-box' },
        h(
          'table',
          { class: 'list bank-cols' },
          h('thead', {}, h('tr', {}, ...p.headers.map((hd, i) => h('th', {}, h('label', {}, h('div', { class: 'sx-meta' }, hd || `${i + 1}열`), roleSel(i, hd || `${i + 1}열`)))))),
          h('tbody', {}, ...p.sample.map((r) => h('tr', {}, ...p.headers.map((_, i) => h('td', {}, r[i] ?? ''))))),
        ),
      ),
      formMsg('import'),
      h('div', { class: 'sx-actions' }, btn(s.busy ? '넣는 중…' : '넣고 맞추기', commitStatement, 'sx-btn-primary', { 'data-act': 'bank-commit', disabled: !p.ok || s.busy }), btn('그만두기', cancel, 'sx-btn-quiet')),
      h('p', { class: 'sx-meta' }, '파일은 이 PC에서만 읽어요. 내용은 우리 서버와 AI 모델로 보내지 않아요. 고친 열은 다음에 같은 서식 파일에 그대로 써요.'),
    );
  }

  /** 계좌가 없을 때 [계좌 연결하기]: 자동 연결 화면이 없으면 내 계좌 탭의 계좌 추가(파일)로 */
  function goAccounts() {
    s.tab = 'accounts';
    s.sel = null;
    s.detail = null;
    openAdd();
  }

  function view() {
    const d = s.data;
    const sum = d?.summary;
    const unpaid = d?.unpaid ?? [];
    // 이 화면에서 연결을 마치면 연결 카드를 닫고 새 값으로 다시 그린다
    if (s.connect && bankAuto?.state.step === 'connected') {
      s.connect = false;
      void refresh();
    }
    const home = s.tab === 'unpaid';
    const back = h('button', { type: 'button', class: 'bank-back', 'data-bank-tab': 'unpaid', onclick: () => ((s.tab = 'unpaid'), (s.filter = 'open'), (s.sel = null), (s.detail = null), (s.confirmDel = null), rerender()) }, icon('chevron'), '받을 돈');
    const subTitle = { received: '받은 계산서', accounts: '계좌 관리', import: '올린 파일' }[s.tab];
    return h(
      'section',
      { class: 'rail-screen bank-screen', 'data-view': 'bank', 'data-screen': 'D-09' },
      home ? head() : h('div', { class: 'rs-head bank-sub-head' }, back, h('h1', { class: 'title-screen' }, subTitle), h('div', { class: 'rs-right' }, s.tab === 'accounts' && d?.accounts?.length ? btn('거래내역 올리기', pickStatement, 'sx-btn-quiet', { 'data-act': 'bank-statement' }) : null, s.tab === 'accounts' ? btn('발급목록 올리기', pickInvoices, 'sx-btn-quiet', { 'data-act': 'bank-invoices' }) : null)),
      // 처음 불러오기에 실패하면 화면 가운데 [다시 시도] 하나(알림 줄과 같은 말을 두 번 쓰지 않는다)
      d ? noticeBar() : null,
      undoBar(),
      offerBar(),
      !d && !s.preview
        ? s.notice?.load && !s.loading
          ? emptyState(s.notice.text.replace(/\.$/, ''), s.notice.text === LOAD_FAIL ? '이 PC의 앱 엔진이 잠시 답하지 않았어요. 넣어 둔 거래내역과 맞춘 기록은 그대로예요.' : null, btn('다시 시도', () => ((s.notice = null), rerender(), void refresh()), 'sx-btn-primary', { 'data-act': 'bank-retry' }), { role: 'alert', 'data-bank-load': 'error' })
          : emptyState('불러오는 중이에요', null, null, { 'aria-busy': 'true', 'data-bank-load': 'loading' })
        : null,
      d && home
        ? [
            s.connect && bankAuto ? h('div', { class: 'bank-connect' }, bankAuto.view(), btn('닫기', () => ((s.connect = false), rerender()), 'sx-btn-quiet', { 'data-act': 'bank-connect-close' })) : null,
            sum?.stale && sum?.hasAccounts && sum.latestDay && unpaid.length ? note(`${md(sum.latestDay)} 뒤로 들어온 입금은 아직 몰라요. [새로고침]으로 다시 맞춰 볼게요.`, true) : null,
            s.view === 'cal' ? calView() : listView(),
          ]
        : null,
      d && s.tab === 'received' ? recvList(d.received, '아직 받은 돈이 없어요.') : null,
      d && s.tab === 'accounts' ? accountsTab() : null,
      s.tab === 'import' ? importTab() : null,
    );
  }

  // ---- 거래처 상세: 계좌·입금자 이름·결제 조건 ----

  const cpCache = new Map();
  function cpSection(c) {
    const box = h('div', { class: 'cp-bank', 'data-bank-cp': c.id }, h('div', { class: 'sx-panel-sec' }, '계좌와 입금자 이름'));
    // 상세 패널은 보는 자리다. 더하는 폼은 [계좌 더하기]·[입금자 이름 더하기]를 눌렀을 때만 연다(빈 폼을 늘 펼쳐 두지 않는다, v2.0).
    let adding = null; // 'account' | 'alias' | null
    // 거절되어 다시 그려도 넣던 값이 남게 둔다(저장하거나 닫으면 비운다). formErr: { text, field }
    let vals = {};
    let formErr = null;
    let pickingTerms = false;
    const draw = (info) => {
      const accounts = info?.accounts ?? [];
      const aliases = info?.aliases ?? [];
      const terms = info?.terms;
      const termsKey = terms ? (terms.kind === 'days' ? `days:${terms.n}` : terms.kind === 'next_month_day' ? `next_month_day:${terms.d}` : terms.kind) : 'default';
      // 받기로 한 날: 값은 글자, 누르면 그 자리에 답 후보 줄(v2.0, 같은 일에 select를 섞지 않는다). 고르면 곧 저장이다.
      const TERMS = [['default', '작성일 + 30일'], ['days:60', '작성일 + 60일'], ['days:15', '작성일 + 15일'], ['next_month_day:10', '다음 달 10일'], ['month_end', '다음 달 말일'], ['none', '기한 없음']];
      const termsLabel = (TERMS.find(([k]) => k === termsKey) ?? TERMS[0])[1];
      const pickTerms = async (key) => {
        const [kind, n] = key.split(':');
        const ok = await call('bank.setPayTerms', { counterpartyId: c.id, kind, n: n ? Number(n) : undefined }).then(() => true, (e) => (say(e), false));
        pickingTerms = false;
        if (!ok) return draw(info);
        toast('결제 조건을 바꿨어요');
        // 저장한 값을 다시 읽어 캐시와 화면을 함께 맞춘다(처음 읽기 전에 고른 경우도).
        void reload();
      };
      const termsRow = pickingTerms
        ? replyOptions(
            TERMS.map(([k, label]) => ({ label, act: `bank-cp-terms-${k}`, onPick: () => void pickTerms(k), attrs: { 'aria-current': k === termsKey ? 'true' : null } })),
            { 'data-field': 'terms', 'aria-label': '받기로 한 날' },
          )
        : h('div', { class: 'cp-row' }, h('button', { type: 'button', class: 'sx-val-btn', 'data-field': 'terms', 'aria-label': `받기로 한 날 ${termsLabel}, 눌러서 바꾸기`, onclick: () => ((pickingTerms = true), draw(info)) }, termsLabel));
      const close = () => ((adding = null), (formErr = null), (vals = {}), draw(cpCache.get(c.id)));
      const errAt = (f) => (formErr?.field === f ? formErr.text : null);
      const fail = (e, fallback) => {
        const code = errText(e);
        formErr = { text: ERR[code] ?? fallback, field: ERR_FIELD[code] ?? null };
      };
      const formLine = () => (formErr && !formErr.field ? h('p', { class: 'form-msg is-bad', role: 'alert' }, formErr.text) : null);
      const saved = () => ((adding = null), (formErr = null), (vals = {}), reload());
      let form = null;
      if (adding === 'account') {
        const bankSel = selectInput(BANKS.map((b) => [b, b]), { value: vals.bank, name: 'bank', compact: true, 'data-field': 'cp-bank', onchange: (e) => (vals.bank = e.target.value) });
        const num_ = accountInput({ value: vals.number, name: 'account', compact: true, 'data-field': 'cp-number', oninput: (e) => (vals.number = e.target.value) });
        const holder = textInput({ value: vals.holder, max: LIMITS.holder, name: 'holder', compact: true, 'data-field': 'cp-holder', oninput: (e) => (vals.holder = e.target.value) });
        const submit = async () => {
          if (!checkFields([num_, holder])) return;
          const r = await call('bank.addCpAccount', { counterpartyId: c.id, bank: bankSel.value, number: num_.value, holder: holder.value || undefined }).catch((e) => (fail(e, '저장하지 못했어요. 계좌번호를 확인해 주세요.'), null));
          if (!r) return draw(cpCache.get(c.id));
          toast(r.holderOffer ? `저장했어요. 예금주 '${r.holderOffer}' 이름으로 온 입금도 이 거래처로 봐요.` : '저장했어요. 이 PC에만 저장돼요.');
          saved();
        };
        form = h(
          'div',
          { class: 'cp-form', 'data-bank-cp-form': 'account', onkeydown: keys(submit, close) },
          field({ label: '은행', input: bankSel, error: errAt('bank') }),
          field({ label: '계좌번호', input: num_, error: errAt('number') }),
          field({ label: '예금주(선택)', input: holder, error: errAt('holder') }),
          formLine(),
          h('div', { class: 'sx-actions' }, btn('저장', submit, 'sx-btn-primary', { 'data-act': 'bank-cp-account-add' }), btn('그만두기', close, 'sx-btn-quiet')),
          h('p', { class: 'sx-meta' }, '거래처 계좌번호와 예금주는 입금을 알아보는 데만 써요. 이 PC에만 저장돼요.'),
        );
        setTimeout(() => (errAt('holder') ? holder : num_).focus(), 0);
      } else if (adding === 'alias') {
        const alias = textInput({ value: vals.alias, max: LIMITS.payer, required: '입금자 이름을 넣어 주세요.', name: 'alias', compact: true, 'data-field': 'cp-alias', oninput: (e) => (vals.alias = e.target.value) });
        const submit = async () => {
          if (!checkFields([alias])) return;
          const ok = await call('bank.addAlias', { counterpartyId: c.id, name: alias.value }).then(() => true, (e) => (fail(e, '저장하지 못했어요. 이름을 확인해 주세요.'), false));
          if (!ok) return draw(cpCache.get(c.id));
          saved();
        };
        form = h(
          'div',
          { class: 'cp-form', 'data-bank-cp-form': 'alias', onkeydown: keys(submit, close) },
          field({ label: '통장에 찍히는 입금자 이름', input: alias, error: errAt('alias') }),
          formLine(),
          h('div', { class: 'sx-actions' }, btn('저장', submit, 'sx-btn-primary', { 'data-act': 'bank-cp-alias-add' }), btn('그만두기', close, 'sx-btn-quiet')),
        );
        setTimeout(() => alias.focus(), 0);
      }
      const open = (k) => () => ((adding = k), (formErr = null), (vals = {}), draw(cpCache.get(c.id)));
      box.replaceChildren(
        h('div', { class: 'sx-panel-sec' }, '계좌와 입금자 이름'),
        // 계좌·입금자 이름은 선으로 나누지 않고 한 면(cp-list) 안의 줄로 둔다(v2.0 선 대신 면). [지우기]는 줄 가운데에 맞춘다.
        ...(accounts.length || aliases.length
          ? [
              h(
                'div',
                { class: 'cp-list' },
                accounts.map((a) => h('div', { class: 'cp-row', 'data-bank-cp-account': a.id }, h('span', { class: 'cp-row-main' }, `${a.bank ?? ''} 끝 ${a.last4}`), h('span', { class: 'cp-row-meta' }, a.holder ? `예금주 ${a.holder}` : ''), btn('지우기', async () => (await call('bank.deleteCpAccount', { id: a.id }).catch(say), reload()), 'sx-btn-quiet'))),
                aliases.map((a) => h('div', { class: 'cp-row', 'data-bank-alias': a.id }, h('span', { class: 'cp-row-main' }, a.nameRaw), h('span', { class: 'cp-row-meta' }, a.source === 'manual' ? '직접 입력' : a.source === 'learned' ? '확인에서 배움' : '계좌 예금주'), btn('지우기', async () => (await call('bank.deleteAlias', { id: a.id }).catch(say), reload()), 'sx-btn-quiet'))),
              ),
            ]
          : []),
        // replaceChildren(null)은 "null" 글자를 넣는다: 없을 때는 아예 넘기지 않는다.
        ...(!accounts.length && !aliases.length && !form ? [h('p', { class: 'sx-meta' }, '등록한 계좌와 입금자 이름이 없어요.')] : []),
        form ?? h('div', { class: 'sx-actions' }, btn('계좌 더하기', open('account'), '', { 'data-act': 'bank-cp-account-open' }), btn('입금자 이름 더하기', open('alias'), '', { 'data-act': 'bank-cp-alias-open' })),
        h('div', { class: 'sx-panel-sec' }, '받기로 한 날'),
        termsRow,
      );
    };
    const reload = async () => {
      const info = await call('bank.cpBanking', { counterpartyId: c.id }).catch(() => null);
      cpCache.set(c.id, info);
      draw(info);
    };
    draw(cpCache.get(c.id));
    void reload();
    return box;
  }

  return { load, view, cpSection, openCounterparty, state: s, icon };
}
