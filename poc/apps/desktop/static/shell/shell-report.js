// 월 리포트(ADR-068) 화면: 달 넘기기, 기간(1, 3, 6개월, 1년), 매출 매입 통장, 달마다 막대, 거래처와 품목 순위, 통장 갈래, 계좌 잔액.
// 값은 main이 엔진 리포트 조회(db.query.bank.report)로 준 것을 그대로 그린다. 합계와 판정은 엔진 몫이다.
// 장부가 바뀌면(ledger 알림) 지금 보는 달과 기간으로 다시 읽는다. 사장님이 [새로고침]을 누를 일이 없게 한다(결정 5, 6).
// 마우스를 올리거나 키보드로 옮기면 자세한 값(sx-tip)을 띄운다(결정 12). PDF는 main이 같은 값으로 그린다(결정 11).
import { bigWon, btn, h, icon, kv, num } from './shell-views.js';
import { selectInput, textInput } from './fields.js';
import { actions, listModal, modal, pickModal } from './shell-ui.js';

const won = bigWon;
const WINDOWS = [
  [1, '1개월'],
  [3, '3개월'],
  [6, '6개월'],
  [12, '1년'],
];
const OUT = [
  ['payable', '매입 결제'],
  ['payroll', '급여'],
  ['card_payment', '카드대금'],
  ['tax', '세금과 4대보험'],
  ['other', '기타'],
];
const IN = [
  ['receivable', '받을 돈'],
  ['card_sales', '카드 매출 입금'],
  ['interest', '이자'],
  ['other', '기타'],
];
/** 목록에서 고를 수 있는 갈래. 받을 돈과 낼 돈에 붙은 줄은 받을 돈 화면에서 고친다 */
const PICK = {
  out: [
    ['payroll', '급여'],
    ['card_payment', '카드대금'],
    ['tax', '세금과 4대보험'],
    ['other', '기타'],
    ['own_transfer', '내 계좌 사이'],
    ['unrelated', '사업과 무관'],
  ],
  in: [
    ['card_sales', '카드 매출 입금'],
    ['interest', '이자'],
    ['other', '기타'],
    ['own_transfer', '내 계좌 사이'],
    ['unrelated', '사업과 무관'],
  ],
};
const ERR = { throttled: '잠시 뒤에 다시 눌러 주세요.', not_found: '저장한 파일을 찾지 못했어요. 다시 저장해 주세요.', txn_settled: '받을 돈에 붙은 입금이라 받을 돈 화면에서 고쳐 주세요.' };

const SYNC_ERR = {
  failed: '홈택스 자료를 받지 못했어요. 다시 눌러 주세요.',
  stopped: '홈택스 자료를 받지 못했어요. 다시 눌러 주세요.',
  busy: '다른 일을 하는 중이에요. 끝나면 다시 눌러 주세요.',
  cant_login: '공동인증서 비밀번호를 기억해 두면 받을 수 있어요.',
};

const SIMPLE_APPS = [
  ['kakao', '카카오톡'],
  ['naver', '네이버'],
  ['toss', '토스'],
  ['pass', 'PASS 앱'],
  ['kb', 'KB국민은행 앱'],
  ['shinhan', '신한 앱'],
  ['woori', '우리은행 앱'],
  ['hana', '하나은행 앱'],
  ['nh', 'NH 앱'],
  ['ibk', 'IBK 앱'],
  ['kakaobank', '카카오뱅크'],
  ['samsung', '삼성패스'],
  ['banksalad', '뱅크샐러드'],
];
const SIMPLE_CARRIERS = [
  ['S', 'SKT'],
  ['K', 'KT'],
  ['L', 'LG U+'],
  ['SA', 'SKT 알뜰폰'],
  ['KA', 'KT 알뜰폰'],
  ['LA', 'LG U+ 알뜰폰'],
];
const SIMPLE_ERR = {
  'simple.name': '이름을 다시 확인해 주세요.',
  'simple.birth': '생년월일 8자리를 넣어 주세요.',
  'simple.phone': '휴대폰 번호를 다시 확인해 주세요.',
  'simple.carrier': '통신사를 골라 주세요.',
  throttled: '잠시 뒤에 다시 눌러 주세요.',
};
const simpleApp = (provider) => SIMPLE_APPS.find(([v]) => v === provider)?.[1] ?? '인증 앱';

const SYNC_KIND = {
  sale_invoice: '매출 세금계산서',
  purchase_invoice: '매입 세금계산서',
  cash_receipt_in: '현금영수증 매출',
  cash_receipt_out: '현금영수증 매입',
  card_sales: '카드 매출',
  business_card: '사업용 카드',
};

const monthNo = (m) => Number(m.slice(5, 7));
const syncItem = ({ kind, from, to }) => `${SYNC_KIND[kind] ?? '홈택스 자료'} ${monthNo(from) === monthNo(to) ? monthNo(from) : `${monthNo(from)}~${monthNo(to)}`}월분`;

function syncBar(p) {
  const fill = h('i');
  fill.style.width = `${Math.round((p.done / p.total) * 100)}%`;
  return h('div', { class: 'sx-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(p.total), 'aria-valuenow': String(p.done), 'aria-label': '홈택스 자료 받기' }, fill);
}
const syncCount = (p) => `${num(p.total)}개 중 ${num(p.done)}개`;
const shift = (month, d) => {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};
/** 받은 시각: 오늘이면 "오늘 11:20", 아니면 "11월 27일 11:20" */
const updatedText = (at) => {
  const t = new Date(at);
  const now = new Date();
  const hm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  return t.toDateString() === now.toDateString() ? `오늘 ${hm}` : `${t.getMonth() + 1}월 ${t.getDate()}일 ${hm}`;
};
const dayDiff = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);
const md = (iso) => `${monthNo(iso)}월 ${Number(iso.slice(8, 10))}일`;
/** 말풍선과 모달 제목의 기간 글: "11월", "9월부터 11월" */
/** 달력 기간 이름(대표 11-28). month는 기간 끝 달: "11월", "4분기", "하반기", "2026년" */
const span = (month, months) => (months === 1 ? `${monthNo(month)}월` : months === 3 ? `${monthNo(month) / 3}분기` : months === 6 ? (monthNo(month) <= 6 ? '상반기' : '하반기') : `${month.slice(0, 4)}년`);
/** 머리 제목: "2026년 11월", "2026년 4분기", "2026년 하반기", "2026년" */
const spanTitle = (month, months) => (months === 12 ? `${month.slice(0, 4)}년` : `${month.slice(0, 4)}년 ${span(month, months)}`);
const PREV = { 1: '지난달', 3: '앞 분기', 6: '앞 반기', 12: '작년' };
/** 기간 끝 달(엔진 periodEnd와 같다) */
const periodEnd = (month, months) => (months === 1 ? month : `${month.slice(0, 4)}-${String(Math.ceil(monthNo(month) / months) * months).padStart(2, '0')}`);
const jongOf = (word) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  return c >= 0 && c < 11172 ? c % 28 : 0;
};
const eun = (word) => (jongOf(word) ? '은' : '는');
/** 받침이 있으면 "으로"(ㄹ 받침은 "로") */
const ro = (word) => {
  const c = word.charCodeAt(word.length - 1) - 0xac00;
  const jong = c >= 0 && c < 11172 ? c % 28 : 0;
  return `${word}${jong && jong !== 8 ? '으로' : '로'}`;
};

function tipBox(title, rows) {
  return h(
    'div',
    { class: 'sx-tip', role: 'tooltip' },
    h('div', { class: 'sx-tip-title' }, title),
    h('div', { class: 'sx-tip-rows' }, ...rows.map(([k, v, head]) => h('div', { class: head ? 'is-head' : null }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v ?? '')))),
  );
}

/** 줄에 마우스를 올리거나 키보드로 옮기면 말풍선을 붙이고, 떠나면 뗀다. 말풍선 위치는 CSS(place)가 정한다 */
function hover(el, make, place) {
  let tip = null;
  const on = () => {
    if (tip) return;
    tip = make();
    if (place) tip.classList.add(place);
    el.classList.add('is-hover');
    // 값 줄(dl)은 이름 칸과 값 칸을 함께 덮는다
    if (el.tagName === 'DD') el.previousElementSibling?.classList.add('is-hover');
    el.append(tip);
  };
  const off = () => {
    tip?.remove();
    tip = null;
    el.classList.remove('is-hover');
    if (el.tagName === 'DD') el.previousElementSibling?.classList.remove('is-hover');
  };
  el.tabIndex = 0;
  el.addEventListener('mouseenter', on);
  el.addEventListener('mouseleave', off);
  el.addEventListener('focus', on);
  el.addEventListener('blur', off);
  return el;
}

/** 막대 길이. 화면 CSP가 style 속성을 막아 CSSOM으로 넣는다 */
const sized = (el, prop, v) => ((el.style[prop] = v), el);
const SVG_NS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs, ...kids) => {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...kids);
  return el;
};
const amountText = (l) => (l.amount === null ? '확인 못 함' : won(l.amount));

export function createReportScreen({ call, toast, rerender, errText, goBank, goAuth, goChat }) {
  const s = { month: null, months: 1, data: null, busy: false, failed: false, side: { partners: 'sale', items: 'sale' }, compare: false, saved: null, saving: false, syncing: false, sync: null, needPassword: false, simpleAuth: false, modal: null, seq: 0, auth: { draft: { provider: 'kakao', name: '', birth: '', phone: '', carrier: 'S' }, form: false, busy: false, cancelled: false, key: '', node: null, timer: 0 } };

  async function loadSync() {
    const r = await call('bank.reportSyncState', {}).catch(() => null);
    if (!r) return;
    s.sync = r.sync;
    s.needPassword = r.needPassword === true;
    s.simpleAuth = r.simpleAuth === true;
    rerender();
  }

  function onSync(p) {
    const ended = s.sync && !p;
    s.sync = p;
    if (!p || p.auth?.state === 'sent') s.auth.form = false;
    if (ended) void load();
    rerender();
  }

  async function load() {
    void loadSync();
    const seq = ++s.seq;
    s.busy = !s.data;
    s.failed = false;
    try {
      const r = await call('bank.report', s.month ? { month: s.month, months: s.months } : { months: s.months });
      if (seq !== s.seq) return;
      s.data = r;
      // 이번 기간은 끝 달이 오늘 뒤일 수 있다. 고른 달은 오늘이 든 달로 둔다
      s.month = r.month > r.today.slice(0, 7) ? r.today.slice(0, 7) : r.month;
    } catch {
      if (seq !== s.seq) return;
      s.failed = true;
    } finally {
      if (seq === s.seq) s.busy = false;
      rerender();
    }
    if (s.modal?.kind === 'all') void loadAll();
    if (s.modal?.kind === 'lines') void loadLines();
  }

  const pick = (patch) => {
    Object.assign(s, patch, { saved: null });
    void load();
  };

  async function savePdf() {
    if (s.saving || !s.data) return;
    s.saving = true;
    rerender();
    try {
      s.saved = await call('bank.reportPdf', { month: s.data.month, months: s.data.months });
    } catch (e) {
      toast(ERR[errText(e)] ?? 'PDF로 저장하지 못했어요. 다시 눌러 주세요.');
    } finally {
      s.saving = false;
      rerender();
    }
  }
  // [최신화]: 홈택스 자료를 지금 받는다. 받은 구간마다 장부 알림이 와서 화면이 다시 읽는다
  async function syncNow() {
    if (s.syncing) return;
    s.syncing = true;
    Object.assign(s.auth, { form: false, busy: false, cancelled: false });
    rerender();
    try {
      const r = await call('bank.reportSync', {});
      if (r?.result !== 'done' && r?.result !== 'not_due' && !(r?.result === 'yielded' && s.auth.cancelled)) toast(SYNC_ERR[r?.result] ?? SYNC_ERR.failed);
    } catch (e) {
      toast(ERR[errText(e)] ?? SYNC_ERR.failed);
    } finally {
      s.syncing = false;
      rerender();
      load();
    }
  }

  const stopSync = () => call('bank.reportStop', {}).catch(() => toast('멈추지 못했어요. 다시 눌러 주세요.'));

  // 간편인증 차례(사람이 누른 받기): 정보 입력 → 휴대폰 승인 → 이어 받기. 승인까지 된 정보는 main이 이 PC에 기억한다
  const authStep = () => {
    const a = s.sync?.auth;
    if (!a) return null;
    if (a.state === 'ask' || s.auth.form) return 'form';
    return a.state === 'missed' || (a.deadline && Date.now() >= a.deadline) ? 'missed' : 'sent';
  };
  async function authCall(params, failed) {
    if (s.auth.busy) return false;
    s.auth.busy = true;
    rerender();
    try {
      await call('bank.reportSimpleAuth', params);
      return true;
    } catch (e) {
      toast(SIMPLE_ERR[errText(e)] ?? failed);
      return false;
    } finally {
      s.auth.busy = false;
      rerender();
    }
  }
  async function authRequest() {
    const d = s.auth.draft;
    const ok = await authCall({ op: 'request', provider: d.provider, name: d.name.trim(), birth: d.birth.replace(/\D/g, ''), phone: d.phone.replace(/\D/g, ''), ...(d.provider === 'pass' ? { carrier: d.carrier } : {}) }, '간편인증 요청을 보내지 못했어요. 다시 눌러 주세요.');
    if (ok) s.auth.form = false;
    rerender();
  }
  const authAgain = () => {
    if (s.sync?.auth?.known) return void authCall({ op: 'request' }, '간편인증 요청을 보내지 못했어요. 다시 눌러 주세요.');
    s.auth.form = true;
    rerender();
  };
  const authDone = () => void authCall({ op: 'complete' }, '승인을 확인하지 못했어요. 다시 눌러 주세요.');
  const authCancel = () => {
    s.auth.cancelled = true;
    void stopSync();
  };

  function authModal(step) {
    const a = s.sync.auth;
    const d = s.auth.draft;
    const key = [step, s.auth.busy, a.provider ?? '', step === 'form' ? d.provider : ''].join('|');
    if (s.auth.node && s.auth.key === key) return s.auth.node;
    clearTimeout(s.auth.timer);
    if (step === 'sent' && a.deadline) s.auth.timer = setTimeout(rerender, Math.max(0, a.deadline - Date.now()) + 50);
    const busy = s.auth.busy ? true : null;
    const cancel = btn(step === 'missed' ? '닫기' : '취소', authCancel, 'sx-btn-lg', { 'data-act': 'report-auth-cancel' });
    let node;
    if (step === 'form') {
      const box = (label, input) => h('label', { class: 'modal-field' }, h('span', { class: 'sx-meta' }, label), h('span', { class: 'pw-box' }, input));
      const text = (k, label, placeholder, max, more = {}) => {
        const input = h('input', { type: 'text', class: 'modal-input', autocomplete: 'off', spellcheck: 'false', maxlength: max, placeholder, 'data-auth': k, ...more });
        input.value = d[k];
        input.addEventListener('input', () => (d[k] = input.value));
        input.addEventListener('keydown', (e) => e.key === 'Enter' && void authRequest());
        return box(label, input);
      };
      const pick = (k, options, label) => {
        const sel = h('select', { class: 'modal-input', 'data-auth': k }, ...options.map(([v, t]) => h('option', { value: v, selected: v === d[k] ? true : null }, t)));
        sel.addEventListener('change', () => {
          d[k] = sel.value;
          rerender();
        });
        return box(label, sel);
      };
      node = pickModal(
        { id: 'report-auth', title: '간편인증에 쓸 정보를 넣어 주세요', attrs: { tabindex: null, 'data-report-auth': 'form' } },
        h(
          'div',
          { class: 'modal-fields' },
          pick('provider', SIMPLE_APPS, '인증 앱'),
          d.provider === 'pass' ? pick('carrier', SIMPLE_CARRIERS, '통신사') : null,
          text('name', '이름', '홍길동', 20, d.name ? {} : { 'data-focus': '' }),
          text('birth', '생년월일', '19800101', 8, { inputmode: 'numeric' }),
          text('phone', '휴대폰 번호', '01012345678', 13, { inputmode: 'numeric' }),
        ),
        actions(btn('인증 요청', () => void authRequest(), 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-auth-request', disabled: busy }), cancel),
      );
    } else if (step === 'sent') {
      node = modal({
        id: 'report-auth',
        title: `${simpleApp(a.provider)}에서 간편인증을 승인해 주세요`,
        body: ['5분 안에 승인하면 홈택스 자료를 받아요.'],
        acts: actions(btn('승인했어요', authDone, 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-auth-done', disabled: busy }), cancel),
        attrs: { 'data-report-auth': 'sent' },
      });
    } else {
      node = modal({
        id: 'report-auth',
        title: '승인을 확인하지 못했어요',
        body: [a.known ? `다시 요청하면 ${simpleApp(a.provider)}에 새 알림을 보내요.` : '넣은 정보를 확인하고 다시 요청해 주세요.'],
        acts: actions(btn('다시 요청', authAgain, 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-auth-again', disabled: busy }), cancel),
        attrs: { 'data-report-auth': 'missed' },
      });
    }
    s.auth.key = key;
    s.auth.node = node;
    return node;
  }

  const fileAct = (how) => call('bank.reportFile', { how }).catch((e) => toast(ERR[errText(e)] ?? '열지 못했어요. 다시 눌러 주세요.'));

  // 전체 보기(거래처, 품목)
  async function loadAll() {
    const m = s.modal;
    try {
      const r = await call('bank.reportAll', { month: s.data.month, months: s.data.months });
      if (s.modal !== m) return;
      m.data = r;
    } catch {
      if (s.modal === m) m.failed = true;
    }
    rerender();
  }
  // 통장 갈래 줄
  async function loadLines() {
    const m = s.modal;
    try {
      const r = await call('bank.reportLines', { month: s.data.month, months: s.data.months, side: m.side, category: m.category });
      if (s.modal !== m) return;
      m.rows = r.rows;
    } catch {
      if (s.modal === m) m.failed = true;
    }
    rerender();
  }
  const open = (m) => {
    s.modal = m;
    rerender();
    void (m.kind === 'all' ? loadAll() : loadLines());
  };
  const close = () => {
    s.modal = null;
    rerender();
  };

  async function saveLines() {
    const m = s.modal;
    const changed = Object.entries(m.picks);
    if (!changed.length) return close();
    m.busy = true;
    rerender();
    try {
      for (const [txnId, category] of changed) await call('bank.categorize', { txnId, category });
      s.modal = null;
      await load();
    } catch (e) {
      m.busy = false;
      toast(ERR[errText(e)] ?? '저장하지 못했어요. 다시 눌러 주세요.');
      rerender();
    }
  }

  // ── 화면 ──
  const period = (d) => span(d.month, d.months);

  function head(d) {
    const today = d?.today ?? null;
    const month = s.month ?? today?.slice(0, 7);
    const end = month ? periodEnd(month, s.months) : null;
    const last = !today || end >= today.slice(0, 7);
    const unit = s.months === 1 ? '달' : s.months === 3 ? '분기' : s.months === 6 ? '반기' : '해';
    const step = (dir) => {
      const to = month ? shift(month, dir * s.months) : null;
      const off = !to || (dir > 0 && last);
      return h(
        'button',
        { type: 'button', class: 'sx-btn', 'data-act': dir < 0 ? 'report-prev' : 'report-next', 'aria-label': off ? (dir < 0 ? `이전 ${unit} 없음` : `다음 ${unit} 없음`) : `${spanTitle(periodEnd(to, s.months), s.months)} 보기`, disabled: off ? true : null, onclick: () => pick({ month: to }) },
        icon(dir < 0 ? 'chevronLeft' : 'chevronRight'),
      );
    };
    return h(
      'div',
      { class: 'rp-head' },
      h('div', { class: 'rp-month' }, step(-1), h('span', { class: 't' }, end ? spanTitle(end, s.months) : ''), step(1)),
      h(
        'div',
        { class: 'rp-head-r' },
        h('div', { class: 'sx-seg', role: 'group', 'aria-label': '기간' }, ...WINDOWS.map(([n, label]) => h('button', { type: 'button', class: s.months === n ? 'is-on' : null, 'aria-pressed': String(s.months === n), 'data-months': String(n), onclick: () => s.months !== n && pick({ months: n }) }, label))),
        btn(s.saving ? '저장하는 중' : 'PDF로 저장', savePdf, '', { 'data-act': 'report-pdf', disabled: s.saving || !d ? true : null }),
      ),
      d?.hometaxAt
        ? h(
            'span',
            { class: 'rp-updated', 'data-report-updated': '' },
            s.sync ? `받는 중 ${syncCount(s.sync)}` : `${updatedText(d.hometaxAt)} 기준`,
            s.sync ? null : h('button', { type: 'button', class: 'rp-refresh', 'aria-label': '지금 다시 받기', 'data-act': 'report-refresh', disabled: s.syncing ? true : null, onclick: syncNow }, icon('refresh')),
          )
        : null,
    );
  }

  const known = (l) => l.amount !== null;
  const hasPurchase = (d) => [d.purchase.invoices, d.purchase.card, d.purchase.cashReceipts].some(known) || !!d.purchase.receipts.amount || d.purchase.payroll.amount !== null;
  const hasPurchaseRank = (d) => d.partners.purchase.top.length > 0;

  function notes(d) {
    const missing = [
      !hasPurchase(d) ? '매입' : null,
      !known(d.sales.cardSales) ? '카드 매출' : null,
      !d.bank.hasAccounts ? '통장' : null,
    ].filter(Boolean);
    const stale = d.notes.find((n) => n.kind === 'hometax_stale');
    const gap = d.notes.find((n) => n.kind === 'account_gap');
    const text = missing.length
      ? `${missing.join(', ')}${eun(missing.at(-1))} 아직 몰라요`
      : stale
        ? stale.lastAt ? `홈택스 자료를 받은 지 ${stale.days}일 됐어요` : '홈택스 자료를 아직 받지 않았어요'
        : gap
          ? `${gap.bank} ${gap.last4} 거래내역이 ${gap.coverTo ? `${md(gap.coverTo)}까지만 있어요` : '아직 없어요'}`
          : null;
    const out = [];
    if (text) {
      const needHometax = !!stale || missing.some((x) => x !== '통장');
      out.push(
        h(
          'div',
          { class: 'sx-note is-attention', 'data-note': 'report-missing' },
          icon('warn'),
          h('div', {}, text),
          needHometax && !s.sync ? btn('홈택스 자료 받기', syncNow, '', { 'data-act': 'report-sync', disabled: s.syncing ? true : null }) : null,
          !d.bank.hasAccounts ? btn('계좌 연결', goBank, '', { 'data-act': 'report-bank' }) : null,
        ),
      );
    }
    if (s.saved)
      out.push(
        h(
          'div',
          { class: 'sx-note is-done', role: 'status', 'data-note': 'report-saved' },
          h('span', { class: 'rp-done' }, icon('check'), 'PDF로 저장했어요'),
          h('span', { class: 'rp-head-r' }, btn('폴더에서 보기', () => fileAct('reveal'), '', { 'data-act': 'report-reveal' }), btn('열기', () => fileAct('open'), '', { 'data-act': 'report-open' })),
        ),
      );
    return out;
  }

  const card = (title, ...body) => h('section', { class: 'sx-card rp-card' }, h('div', { class: 'sx-card-hd' }, h('h2', { class: 'sx-card-title' }, title)), ...body);
  const cardWith = (title, side, ...body) => h('section', { class: 'sx-card rp-card' }, h('div', { class: 'sx-card-hd' }, h('h2', { class: 'sx-card-title' }, title), side), ...body);

  const prevLabel = (d) => `${PREV[d.months]}보다`;

  const trendText = (d, cur, prev, comparable) => {
    if (cur.amount === null) return null;
    if (prev.amount === null || !prev.amount || comparable === false || (prev.partial && !cur.partial)) return `비교할 ${PREV[d.months]} 자료가 없어요`;
    const diff = cur.amount - prev.amount;
    const p = Math.round((diff / prev.amount) * 100);
    if (!diff) return `${prevLabel(d)} 같아요`;
    return h('span', {}, `${prevLabel(d)} `, h('b', { class: 'rp-change' }, `${diff > 0 ? '+' : '−'}${won(Math.abs(diff))} (${diff > 0 ? '+' : '−'}${Math.abs(p)}%)`));
  };

  function spark(values, tone) {
    const vs = values.map((v) => v ?? 0);
    const max = Math.max(1, ...vs);
    const pts = vs.map((v, i) => [4 + (i * 112) / Math.max(1, vs.length - 1), 40 - (v / max) * 34]);
    const [lx, ly] = pts.at(-1);
    return svg(
      'svg',
      { viewBox: '0 0 120 44', class: `rp-spark is-${tone}`, 'aria-hidden': 'true' },
      svg('polyline', { points: pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ') }),
      svg('circle', { cx: lx.toFixed(1), cy: ly.toFixed(1), r: '3.5' }),
    );
  }

  const prevName = (d) => PREV[d.months];
  const dayCount = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  function average(d, total) {
    if (total.amount === null) return ['평균', '확인 못 함', { state: 'unknown' }];
    if (d.months === 1) return ['하루 평균', won(total.amount / dayCount(d.from, d.to < d.today ? d.to : d.today)), {}];
    // 이번 기간은 지난 달 수로 나눈다(4분기의 11월이면 두 달)
    const gone = d.series.filter((m) => m.inWindow && m.month <= d.today.slice(0, 7)).length;
    return ['한 달 평균', won(total.amount / Math.max(1, gone)), {}];
  }

  const totalCard = (d, title, tone, total, prev, comparable, pick) =>
    cardWith(
      title,
      spark(d.series.map((m) => pick(m).amount), tone),
      h('div', { class: 'rp-total-l' }, h('span', { class: 'rp-strong' }, amountText(total)), h('span', {}, trendText(d, total, prev, comparable))),
      kv([comparable === false ? [prevName(d), '일부만 받았어요', { state: 'unknown' }] : [prevName(d), amountText(prev), prev.amount === null ? { state: 'unknown' } : {}], average(d, total)]),
    );

  function vatCard(d) {
    const v = d.vat;
    const due = v.sale !== null && v.purchase !== null ? v.sale - v.purchase : null;
    const fill = v.sale && due !== null ? sized(h('i'), 'width', `${Math.round((Math.max(0, due) / v.sale) * 100)}%`) : null;
    const left = dayDiff(d.today, v.deadline);
    const info = hover(h('button', { type: 'button', class: 'rp-info', 'aria-label': `부가세 ${v.half}기가 뭔지 보기` }, icon('info')), () => tipBox(`부가세 ${v.half}기`, [[v.half === 1 ? '1월부터 6월' : '7월부터 12월', `${md(v.deadline)} 신고`]]), 'is-below');
    return cardWith(
      h('span', { class: 'rp-title-i' }, `부가세 ${v.half}기`, info),
      h('span', { class: 'rp-due' }, md(v.deadline), left >= 0 ? h('span', { class: `rp-dday${left <= 14 ? ' is-near' : ''}` }, left ? `D-${left}` : 'D-DAY') : null),
      h('span', { class: 'rp-strong' }, due !== null ? `${won(due)} 낼 것 같아요` : v.sale !== null ? `매출 부가세 ${won(v.sale)}` : '확인 못 함'),
      h('div', { class: 'rp-meter', 'aria-hidden': 'true' }, fill),
      kv([
        ['매출 부가세', v.sale === null ? '확인 못 함' : won(v.sale), v.sale === null ? { state: 'unknown' } : {}],
        ['매입 부가세', v.purchase === null ? '확인 못 함' : won(v.purchase), v.purchase === null ? { state: 'unknown' } : {}],
      ]),
    );
  }

  function summary(d) {
    return h(
      'div',
      { class: 'rp-grid3' },
      totalCard(d, '매출', 'sale', d.sales.total, d.prev.sales, d.prev.comparable?.sales, (m) => m.sales.total),
      totalCard(d, '매입', 'buy', d.purchase.total, d.prev.purchase, d.prev.comparable?.purchase, (m) => m.purchase.total),
      vatCard(d),
    );
  }

  const shortWon = (v) => {
    const a = Math.abs(v);
    const unit = a >= 1e12 ? [1e12, '조'] : a >= 1e8 ? [1e8, '억'] : [1e4, '만'];
    const n = v / unit[0];
    return `${(Math.abs(n) >= 100 || unit[1] === '만' ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('en-US')}${unit[1]}원`;
  };

  /** 눈금 간격: 1, 2, 2.5, 5, 10 x 10^n 가운데 다섯 칸 안에 드는 가장 작은 것 */
  const niceStep = (max) => {
    const raw = max / 5;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const n = raw / mag;
    return Math.max(10_000, (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag);
  };
  const tickText = (v) => (v ? shortWon(v).replace(/원$/, '') : '0');

  function chart(d) {
    const H = 168;
    const most = Math.max(1, ...d.series.flatMap((m) => [m.sales.total.amount ?? 0, m.purchase.total.amount ?? 0]));
    const step = niceStep(most);
    const top = step * Math.ceil(most / step);
    const px = (v) => Math.max(v ? 2 : 0, Math.round(((v ?? 0) / top) * H));
    const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
    const half = d.series.length / 2;
    const tipRows = (m) => {
      const L = (label, l) => (known(l) && l.amount ? [label, won(l.amount)] : null);
      return [
        ['매출', amountText(m.sales.total), true],
        L('세금계산서', m.sales.invoices),
        L('현금영수증', m.sales.cashReceipts),
        L('카드 매출', m.sales.cardSales),
        L('현금 매출', m.sales.cashSales),
        ['매입', amountText(m.purchase.total), true],
        L('세금계산서', m.purchase.invoices),
        L('사업용 카드', m.purchase.card),
        L('현금영수증', m.purchase.cashReceipts),
        L('영수증', m.purchase.receipts),
        L('급여', m.purchase.payroll),
      ].filter(Boolean);
    };
    const cur = d.series.at(-1);
    const label = `${monthNo(d.series[0].month)}월부터 ${monthNo(cur.month)}월까지 달마다 매출과 매입. ${monthNo(cur.month)}월 매출 ${amountText(cur.sales.total)}, 매입 ${amountText(cur.purchase.total)}`;
    const line = (v) => sized(h('i', {}), 'bottom', `${px(v)}px`);
    const ly = (m) => m.lastYear?.sales.amount ?? null;
    const lyOk = d.series.some((m) => ly(m));
    const compare = s.compare && lyOk;
    const n = d.series.length;
    const overlay = compare
      ? svg(
          'svg',
          { class: 'rp-ly', viewBox: `0 0 100 ${H}`, preserveAspectRatio: 'none', 'aria-hidden': 'true' },
          ...lySegments(d.series).map((seg) => svg('polyline', { points: seg.map(([i, v]) => `${(((i + 0.5) / n) * 100).toFixed(2)},${(H - px(v)).toFixed(1)}`).join(' '), 'vector-effect': 'non-scaling-stroke' })),
        )
      : null;
    const partial = (l) => l.partial || l.amount === null;
    // 이번 기간의 남은 달(오늘 뒤)은 막대 없이 달 이름만. 고른 달 표시는 오늘이 든 달
    const nowM = d.today.slice(0, 7);
    const future = (m) => m.month > nowM;
    const onM = d.month > nowM ? nowM : d.month;
    const amt = (m, l) => (future(m) ? null : l.amount);
    const row = (sw, label, vals) =>
      h('div', { class: 'rp-trow' }, h('span', { class: 'k' }, sw, label), ...vals.map((v, i) => h('span', { class: d.series[i].month === onM ? 'is-on' : null }, v)));
    const tableCell = (v) => (v === null ? '-' : shortWon(v).replace(/원$/, ''));
    const table = sized(
      h(
        'div',
        { class: 'rp-table', 'aria-label': '달마다 금액 표' },
        row(h('i', { class: 'rp-dot is-sale-0' }), '매출', d.series.map((m) => tableCell(amt(m, m.sales.total)))),
        row(h('i', { class: 'rp-dot is-buy-0' }), '매입', d.series.map((m) => tableCell(amt(m, m.purchase.total)))),
        compare ? row(h('i', { class: 'rp-dash' }), '작년', d.series.map((m) => tableCell(ly(m)))) : null,
      ),
      'gridTemplateColumns',
      `60px repeat(${n}, minmax(0, 1fr))`,
    );
    return cardWith(
      h('span', { class: 'rp-headline' }, h('span', { class: 'rp-headline-k' }, '달마다'), headline(d, compare)),
      h(
        'span',
        { class: 'rp-chart-side' },
        h('span', { class: 'rp-legend' }, h('span', {}, h('i', { class: 'is-sale' }), '매출'), h('span', {}, h('i', { class: 'is-buy' }), '매입')),
        lyOk ? h('button', { type: 'button', class: `rp-toggle${compare ? ' is-on' : ''}`, 'aria-pressed': String(compare), 'data-act': 'report-compare', onclick: () => ((s.compare = !s.compare), rerender()) }, h('i', { class: 'rp-dash' }), '작년과 비교') : null,
      ),
      h(
        'div',
        { class: `rp-plot${d.series.length > 8 ? ' is-dense' : ''}`, role: 'img', 'aria-label': label },
        h('div', { class: 'rp-axis', 'aria-hidden': 'true' }, ...ticks.map((v) => sized(h('span', {}, tickText(v)), 'bottom', `${px(v)}px`))),
        h(
          'div',
          { class: 'rp-chart' },
          h('div', { class: 'rp-gridlines', 'aria-hidden': 'true' }, ...ticks.map(line)),
          overlay,
          ...d.series.map((m, i) => {
            const sale = amt(m, m.sales.total);
            const buy = amt(m, m.purchase.total);
            const tall = Math.max(px(sale), px(buy));
            const busy = m.month === onM && (partial(m.sales.total) || partial(m.purchase.total));
            return hover(
              h(
                'div',
                { class: `rp-col${m.inWindow ? ' is-in' : ''}${m.month === onM ? ' is-on' : ''}${future(m) ? ' is-future' : ''}`, 'data-month': m.month },
                h(
                  'div',
                  { class: 'rp-bars' },
                  sale ? sized(h('span', { class: 'rp-amt' }, shortWon(sale)), 'bottom', `${tall + (busy ? 20 : 6)}px`) : null,
                  sized(h('i', { class: `is-sale${busy && partial(m.sales.total) ? ' is-busy' : ''}` }), 'height', `${px(sale)}px`),
                  sized(h('i', { class: `is-buy${busy && partial(m.purchase.total) ? ' is-busy' : ''}` }), 'height', `${px(buy)}px`),
                ),
                h('span', { class: 'm' }, `${monthNo(m.month)}월`, busy ? h('span', { class: 'rp-wait', role: 'img', 'aria-label': '아직 다 안 들어왔어요' }, icon('clock')) : null),
              ),
              () => tipBox(`${monthNo(m.month)}월`, tipRows(m)),
              i >= half ? 'is-left' : 'is-right',
            );
          }),
        ),
      ),
      table,
    );
  }

  /** 작년 점선: 모르는 달에서 끊는다(0으로 내려 긋지 않는다) */
  function lySegments(series) {
    const out = [];
    let cur = [];
    series.forEach((m, i) => {
      const v = m.lastYear?.sales.amount ?? null;
      if (v === null) {
        if (cur.length) out.push(cur);
        cur = [];
      } else cur.push([i, v]);
    });
    if (cur.length) out.push(cur);
    return out.map((seg) => (seg.length === 1 ? [[seg[0][0] - 0.2, seg[0][1]], [seg[0][0] + 0.2, seg[0][1]]] : seg));
  }

  /** 차트 위 한 줄: "11월 매출은 3,540만원, 지난달보다 13% 많아요" */
  function headline(d, compare) {
    const total = d.sales.total.amount;
    if (total === null) return null;
    const what = `${period(d)} 매출은 ${shortWon(total)}`;
    const base = compare
      ? (() => {
          const ms = d.series.filter((m) => m.inWindow && m.month <= d.today.slice(0, 7));
          const ok = ms.every((m) => m.lastYear && m.lastYear.sales.amount !== null && !m.lastYear.sales.partial);
          return ok ? { label: d.months === 12 ? '작년 같은 때보다' : `작년 ${span(d.month, d.months)}보다`, amount: ms.reduce((a, m) => a + m.lastYear.sales.amount, 0) } : null;
        })()
      : d.prev.comparable?.sales !== false && d.prev.sales.amount && !(d.prev.sales.partial && !d.sales.total.partial)
        ? { label: prevLabel(d), amount: d.prev.sales.amount }
        : null;
    if (!base || !base.amount) return `${what}이에요`;
    const p = Math.round(((total - base.amount) / base.amount) * 100);
    return p === 0 ? `${what}, ${base.label} 같아요` : `${what}, ${base.label} ${Math.abs(p)}% ${p > 0 ? '많아요' : '적어요'}`;
  }

  function whyCard(d) {
    const diff = d.sales.total.amount !== null && d.prev.sales.amount !== null ? d.sales.total.amount - d.prev.sales.amount : 0;
    const up = diff > 0;
    const why = (d.why ?? []).filter((x) => (up ? x.delta > 0 : x.delta < 0)).slice(0, 3);
    if (!why.length || !diff) return null;
    const title = `${period(d)} 매출이 왜 ${up ? '늘었을까' : '줄었을까'}`;
    return card(
      title,
      h(
        'div',
        { class: 'rp-why' },
        ...why.map((x) => h('div', { class: 'rp-why-i' }, h('span', { class: 'k' }, x.kind === 'item' ? `${x.name ?? '품목 없음'} 품목` : x.name ?? '이름 없음'), h('span', { class: 'v' }, `${x.delta > 0 ? '+' : '−'}${shortWon(Math.abs(x.delta))}`))),
      ),
      goChat ? h('div', { class: 'sx-actions' }, btn('대화에서 더 묻기', () => goChat(`${period(d)} 매출이 ${prevLabel(d)} 왜 ${up ? '늘었는지' : '줄었는지'} 알려줘`), 'sx-btn-quiet', { 'data-act': 'report-why-chat' })) : null,
    );
  }

  function ring(parts, tone, label, classes = parts.map((_, i) => i)) {
    const total = parts.reduce((a, [, v]) => a + Math.max(0, v ?? 0), 0);
    const C = 2 * Math.PI * 44;
    let at = 0;
    const arcs = total
      ? parts.map(([, v], i) => {
          const len = (Math.max(0, v ?? 0) / total) * C;
          const el = svg('circle', { cx: '60', cy: '60', r: '44', class: `rp-ring-arc is-${tone}-${classes[i]}`, 'stroke-dasharray': `${len.toFixed(1)} ${C.toFixed(1)}`, 'stroke-dashoffset': (-at).toFixed(1), transform: 'rotate(-90 60 60)' });
          at += len;
          return el;
        })
      : [];
    return svg('svg', { viewBox: '0 0 120 120', class: 'rp-ring', role: 'img', 'aria-label': label }, svg('circle', { cx: '60', cy: '60', r: '44', class: 'rp-ring-bg' }), ...arcs);
  }

  // 매출은 어디서, 매입은 어디로: 거래처별(2026-11-28 대표: 계산서인지 카드인지보다 어디인지가 궁금하다). 위 세 곳, 그 밖에, 계산서가 없는 몫
  function mixCard(d, title, side, otherLabel, others) {
    const tone = side === 'sale' ? 'sale' : 'buy';
    const r = d.partners[side];
    const top = r.top.slice(0, 3);
    const restN = r.top.length - top.length + (r.rest?.n ?? 0);
    const restAmount = r.top.slice(3).reduce((a, x) => a + x.amount, 0) + (r.rest?.amount ?? 0);
    const other = others.reduce((a, l) => a + Math.max(0, l?.amount ?? 0), 0);
    const parts = [
      ...top.map((x, i) => [x.name ?? '이름 없음', x.amount, i]),
      ...(restAmount > 0 ? [[`그 밖에 ${num(restN)}곳`, restAmount, 3]] : []),
      ...(other > 0 ? [[otherLabel, other, 4]] : []),
    ].filter(([, v]) => v > 0);
    if (!parts.length) return null;
    const sum = parts.reduce((a, [, v]) => a + v, 0);
    const share = (v) => `${Math.round((v / sum) * 100)}%`;
    return cardWith(
      title,
      null,
      h(
        'div',
        { class: 'rp-mix' },
        ring(parts.map(([label, v]) => [label, v]), tone, `${title}: ${parts.map(([label, v]) => `${label} ${share(v)}`).join(', ')}`, parts.map(([, , c]) => c)),
        h('dl', { class: 'sx-kv rp-mix-kv' }, ...parts.map(([label, v, c]) => [h('dt', {}, h('i', { class: `rp-dot is-${tone}-${c}` }), `${label} ${share(v)}`), h('dd', {}, h('span', { class: 'sx-val' }, won(v)))])),
      ),
      restN > 0 ? h('div', { class: 'sx-actions' }, btn('거래처 전체 보기', () => open({ kind: 'all', what: 'partners', side, q: '' }), 'sx-btn-quiet', { 'data-act': `report-${tone}-partners-all` })) : null,
    );
  }

  function mix(d) {
    return h(
      'div',
      { class: 'rp-grid2' },
      mixCard(d, '매출은 어디서', 'sale', '카드·현금 손님', [d.sales.cardSales, d.sales.cashReceipts, d.sales.cashSales]),
      mixCard(d, '매입은 어디로', 'purchase', '카드·영수증·급여', [d.purchase.card, d.purchase.cashReceipts, d.purchase.receipts, d.purchase.payroll]),
    );
  }

  const pct = (share) => `${Math.round(share * 100)}%`;
  const seg = (key, label) =>
    h('div', { class: 'sx-seg rp-seg', role: 'group', 'aria-label': label }, ...[['sale', '매출'], ['purchase', '매입']].map(([v, t]) => h('button', { type: 'button', class: s.side[key] === v ? 'is-on' : null, 'aria-pressed': String(s.side[key] === v), 'data-side': v, onclick: () => ((s.side[key] = v), rerender()) }, t)));

  function rankCard(d, key, title, unit, label, allAct) {
    const both = hasPurchaseRank(d);
    const side = both ? s.side[key] : 'sale';
    const r = d[key][side];
    const tone = side === 'sale' ? 'sale' : 'buy';
    const row = (x, name) =>
      h(
        'div',
        { class: 'rp-rank', 'data-key': x.key ?? '' },
        h('span', { class: 'name' }, name),
        h('span', { class: 'v' }, won(x.amount)),
        h('span', { class: 'p' }, pct(x.share)),
        h('div', { class: 'rp-meter' }, sized(h('i', { class: `is-${tone}` }), 'width', pct(x.share))),
      );
    const rows = r.top.slice(0, 5).map((x) => row(x, label(x)));
    return cardWith(
      title,
      both ? seg(key, `${title} 기준`) : null,
      rows.length ? h('div', { class: 'rp-ranks' }, ...rows) : h('p', {}, `이 기간 ${unit}이 없어요`),
      r.top.length > 5 || r.rest ? h('div', { class: 'sx-actions' }, btn('전체 보기', () => open({ kind: 'all', what: key, side, q: '' }), 'sx-btn-quiet', { 'data-act': allAct })) : null,
    );
  }

  const ranks = (d) => rankCard(d, 'items', '많이 판 품목', '품목', (x) => (x.name ? `${x.name} ${num(x.count)}건` : '품목 없음'), 'report-items-all');

  function receivableCard(d) {
    const r = d.receivable;
    const all = r.received + r.left;
    const w = (v) => `${all ? Math.round((v / all) * 100) : 0}%`;
    return card(
      '받을 돈',
      h('div', { class: 'rp-stack', 'aria-hidden': 'true' }, sized(h('i', { class: 'is-sale' }), 'width', w(r.received)), sized(h('i', { class: 'is-sale-2' }), 'width', w(r.left - r.late.amount)), sized(h('i', { class: 'is-late' }), 'width', w(r.late.amount))),
      h(
        'dl',
        { class: 'sx-kv rp-mix-kv' },
        h('dt', {}, h('i', { class: 'rp-dot is-sale' }), '받은 돈'),
        h('dd', {}, h('span', { class: 'sx-val' }, won(r.received))),
        h('dt', {}, h('i', { class: 'rp-dot is-sale-2' }), '기다리는 돈'),
        h('dd', {}, h('span', { class: 'sx-val' }, won(r.left - r.late.amount))),
        r.late.count ? [h('dt', {}, h('i', { class: 'rp-dot is-late' }), `기한 지남 ${num(r.late.count)}건`), h('dd', { class: 'is-late' }, h('span', { class: 'sx-val' }, won(r.late.amount)))] : null,
      ),
      h('div', { class: 'sx-actions' }, btn('받을 돈 보기', goBank, 'sx-btn-quiet', { 'data-act': 'report-receivables' })),
    );
  }

  function bankCard(d) {
    if (!d.bank.hasAccounts)
      return card('통장', h('p', {}, '계좌를 연결하면 들어온 돈과 나간 돈이 보여요'), h('div', { class: 'sx-actions' }, btn('계좌 연결', goBank, 'sx-btn-quiet', { 'data-act': 'report-bank' })));
    const most = Math.max(1, d.bank.in, d.bank.out);
    const bar = (side, list, total, tone) => {
      const shown = list.filter(([k]) => d.bankLines[side][k]?.amount);
      const wrap = sized(h('div', { class: 'rp-stack' }), 'width', `${Math.round((total / most) * 100)}%`);
      shown.forEach(([k, label], i) => {
        const seg = sized(h('button', { type: 'button', class: `is-${tone}-${Math.min(i, 2)}`, 'aria-label': `${label} ${won(d.bankLines[side][k].amount)}, 거래 보기`, 'data-cat': k }), 'width', `${Math.round((d.bankLines[side][k].amount / Math.max(1, total)) * 100)}%`);
        seg.addEventListener('click', () => open({ kind: 'lines', side, category: k, label, picks: {} }));
        hover(seg, () => tipBox(label, [[`${num(d.bankLines[side][k].count)}건`, won(d.bankLines[side][k].amount)]]), 'is-below');
        wrap.append(seg);
      });
      return h('div', { class: 'rp-bank-row' }, h('span', {}, side === 'in' ? '들어온 돈' : '나간 돈'), h('div', { class: 'rp-bank-bar' }, wrap), h('span', { class: 'v' }, won(total)));
    };
    const acc = d.balance.accounts;
    return card(
      '통장',
      h('div', { class: 'rp-bank' }, bar('in', IN, d.bank.in, 'sale'), bar('out', OUT, d.bank.out, 'buy')),
      kv([
        ['남은 돈', won(d.bank.net), { total: true }],
        [`계좌 잔액 ${num(acc.length)}곳`, d.balance.total === null ? '확인 못 함' : won(d.balance.total), d.balance.total === null ? { state: 'unknown' } : {}],
      ]),
    );
  }

  const sourceRows = (d) => {
    const at = (kinds) => {
      const xs = kinds.map((k) => d.arrivals?.find((x) => x.kind === k)).filter(Boolean);
      const wait = xs.find((x) => x.expectedOn);
      if (wait) return { wait: true, text: `${md(wait.expectedOn)}쯤` };
      const ths = xs.map((x) => x.through).filter(Boolean);
      return ths.length ? { wait: false, text: `${md(ths.sort()[0])}까지` } : null;
    };
    return [
      ['세금계산서', at(['sale_invoice', 'purchase_invoice'])],
      ['현금영수증', at(['cash_receipt_in', 'cash_receipt_out'])],
      ['카드 매출', at(['card_sales'])],
      ['사업용 카드', at(['business_card'])],
      ['통장', d.bank.hasAccounts && d.through.bank ? { wait: false, text: `${md(d.through.bank)}까지` } : null],
    ];
  };

  function sourceCard(d) {
    return card(
      '자료',
      h(
        'div',
        { class: 'rp-sources' },
        ...sourceRows(d).map(([label, st]) =>
          h('span', { class: st ? (st.wait ? 'is-wait' : 'is-ok') : 'is-none' }, icon(st ? (st.wait ? 'clock' : 'doneCircle') : 'info'), st ? (st.wait ? `${label} ${monthNo(d.month)}월분은 ${st.text}` : `${label} ${st.text}`) : `${label} 아직 못 받았어요`),
        ),
      ),
    );
  }

  const neverFetched = (d) => d.notes.some((n) => n.kind === 'hometax_stale' && !n.lastAt);

  const STEPS = [
    ['docs', '홈택스에서 가져와요', '지난 12개월 세금계산서, 카드, 현금영수증', 'sale'],
    ['report', '달마다 정리해요', '매출과 매입, 거래처, 부가세', 'buy'],
    ['eye', '조회만 해요', '신고나 발급은 하지 않아요', null],
  ];

  function previewArt(filling) {
    const sale = [84, 100, 92, 112, 130, 148];
    const buy = [46, 58, 52, 68, 70, 66];
    const months = ['6월', '7월', '8월', '9월', '10월', '11월'];
    const col = (i) => {
      const empty = filling && i >= 4;
      return h(
        'div',
        { class: `rp-col${i === 5 && !empty ? ' is-on' : ''}` },
        h('div', { class: 'rp-bars' }, sized(h('i', { class: empty ? 'is-empty' : 'is-sale' }), 'height', `${empty ? 24 : sale[i]}px`), sized(h('i', { class: empty ? 'is-empty' : 'is-buy' }), 'height', `${empty ? 24 : buy[i]}px`)),
        h('span', { class: 'm' }, months[i]),
      );
    };
    return h(
      'div',
      { class: 'rp-preview', 'aria-hidden': 'true' },
      h('section', { class: 'sx-card rp-card' }, h('div', { class: 'sx-card-hd' }, h('span', { class: 'sx-card-title' }, '달마다'), h('span', { class: 'rp-legend' }, h('span', {}, h('i', { class: 'is-sale' }), '매출'), h('span', {}, h('i', { class: 'is-buy' }), '매입'))), h('div', { class: 'rp-chart' }, ...months.map((_, i) => col(i)))),
      h(
        'div',
        { class: 'rp-grid2' },
        h('section', { class: 'sx-card rp-card' }, h('span', { class: 'sx-card-title' }, '많이 판 거래처'), ...[86, 62, 38].map((w, i) => h('div', { class: 'rp-ghost' }, sized(h('i'), 'width', `${[54, 40, 48][i]}%`), h('div', { class: 'rp-meter' }, sized(h('i', { class: 'is-sale' }), 'width', `${filling ? 0 : w}%`))))),
        h('section', { class: 'sx-card rp-card' }, h('span', { class: 'sx-card-title' }, '부가세'), h('div', { class: 'rp-mix' }, ring([['a', filling ? 20 : 35], ['b', filling ? 80 : 65]], 'buy', ''), h('div', { class: 'rp-ghost' }, sized(h('i'), 'width', '80%'), sized(h('i'), 'width', '56%'), sized(h('i'), 'width', '68%')))),
      ),
    );
  }

  const KIND_ORDER = ['sale_invoice', 'purchase_invoice', 'cash_receipt_in', 'cash_receipt_out', 'card_sales', 'business_card'];

  function firstPage() {
    const p = s.sync;
    const left = p
      ? h(
          'div',
          { class: 'rp-first-l', 'data-report-first': 'receiving', role: 'status' },
          h('h2', { class: 'rp-hero' }, '리포트를 만들고 있어요'),
          h('div', { class: 'rp-progress' }, syncBar(p), h('div', { class: 'rp-two' }, h('span', { class: 'rp-strong' }, `${Math.round((p.done / p.total) * 100)}%`), h('span', {}, syncCount(p)))),
          h(
            'ul',
            { class: 'rp-kinds' },
            ...KIND_ORDER.map((k) => p.kinds?.find((x) => x.kind === k)).filter(Boolean).map((k) => {
              const st = k.done >= k.total ? 'done' : p.next?.kind === k.kind ? 'now' : 'todo';
              return h('li', { class: `is-${st}` }, st === 'done' ? icon('doneCircle') : h('i'), h('span', {}, SYNC_KIND[k.kind]), h('span', {}, st === 'done' ? '받음' : st === 'now' ? `${syncItem(p.next).replace(`${SYNC_KIND[k.kind]} `, '')} 받는 중` : '다음'));
            }),
          ),
          h('div', { class: 'rp-first-act' }, btn('멈추기', stopSync, 'sx-btn-quiet', { 'data-act': 'report-stop' }), h('span', {}, '다른 일을 해도 돼요')),
        )
      : h(
          'div',
          { class: 'rp-first-l', 'data-report-first': s.needPassword ? 'password' : 'fetch' },
          h('h2', { class: 'rp-hero' }, '가게 돈 흐름을', h('br'), '한 장으로 보여 드려요'),
          h(
            'ol',
            { class: 'rp-steps' },
            ...(s.needPassword ? [['lock', '인증서 비밀번호 저장', '앱이 대신 홈택스에 들어가요. 이 Mac 금고에만 둬요', 'turn'], ...STEPS.slice(0, 2)] : STEPS).map(([ic, title, sub, tone]) =>
              h('li', {}, h('span', { class: `rp-step-ic${tone ? ` is-${tone}` : ''}` }, icon(ic)), h('span', {}, h('b', {}, title), h('br'), sub)),
            ),
          ),
          h(
            'div',
            { class: 'rp-first-act is-col' },
            s.needPassword
              ? btn('비밀번호 저장하기', goAuth, 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-password' })
              : btn('홈택스 자료 받기', syncNow, 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-sync', disabled: s.syncing ? true : null }),
            s.needPassword ? null : h('span', {}, s.simpleAuth ? '처음 한 번 몇 분 걸려요. 받을 때마다 휴대폰에서 승인해요' : '처음 한 번 몇 분 걸리고, 다음부터는 앱이 알아서 받아요'),
          ),
        );
    return h('div', { class: 'rp-first' }, left, previewArt(!!p));
  }

  /** 불러오는 동안: 요약 세 칸과 차트 자리를 같은 크기의 회색 뼈대로 */
  function skeleton() {
    const bone = (w, hh) => sized(sized(h('i', { class: 'rp-bone' }), 'width', w), 'height', hh);
    return h(
      'div',
      { class: 'rp-skeleton', 'aria-busy': 'true', 'aria-label': '리포트 불러오는 중' },
      h('div', { class: 'rp-grid3' }, ...[0, 1, 2].map(() => h('section', { class: 'sx-card rp-card' }, bone('40px', '14px'), bone('70%', '20px'), bone('50%', '14px'), bone('100%', '14px')))),
      h('section', { class: 'sx-card rp-card' }, bone('280px', '18px'), h('div', { class: 'rp-bone-bars' }, ...[90, 80, 86, 104, 98, 110].map((x) => bone('100%', `${x}px`)))),
    );
  }

  function view() {
    const d = s.data;
    if (d && neverFetched(d)) return h('section', { class: 'rail-screen report-screen is-first', 'data-view': 'report', 'data-screen': 'ADR-068' }, firstPage());
    const body = s.failed && !d
      ? [h('div', { class: 'sx-note is-attention', role: 'alert' }, icon('warn'), h('div', {}, '리포트를 불러오지 못했어요'), btn('다시 시도', load, '', { 'data-act': 'report-retry' }))]
      : !d
        ? [skeleton()]
        : [...notes(d), summary(d), chart(d), whyCard(d), mix(d), ranks(d), h('div', { class: 'rp-grid2' }, receivableCard(d), bankCard(d)), sourceCard(d)];
    return h('section', { class: 'rail-screen report-screen', 'data-view': 'report', 'data-screen': 'ADR-068', 'data-month': d?.month ?? '', 'data-months': String(s.months) }, h('div', { class: 'rs-col rp-col-main' }, head(d), ...body));
  }

  // ── 모달 ──
  function allModal(m) {
    const d = s.data;
    const r = m.data?.[m.what]?.[m.side];
    const sideLabel = m.side === 'sale' ? '매출' : '매입';
    const q = m.q.trim();
    const list = r ? r.top.filter((x) => !q || (x.name ?? '').includes(q)) : [];
    const partner = m.what === 'partners';
    const title = `${period(d)} ${sideLabel} ${partner ? '거래처' : '품목'} ${r ? `${num(r.top.length)}${partner ? '곳' : '개'}` : ''}`.trim();
    const search = textInput({ value: m.q, max: 40, compact: true, placeholder: partner ? '거래처 찾기' : '품목 찾기', 'aria-label': partner ? '거래처 찾기' : '품목 찾기', 'data-act': 'report-search' });
    search.addEventListener('input', () => {
      m.q = search.value;
      rerender();
    });
    const cols = partner
      ? [['거래처'], [sideLabel, 'num'], ['비율', 'num'], [m.side === 'sale' ? '받을 돈' : '낼 돈', 'num'], ['건수', 'num']]
      : [['품목'], ['건수', 'num'], ['금액', 'num'], ['비율', 'num']];
    const rows = list.map((x) =>
      h(
        'tr',
        {},
        ...(partner
          ? [h('td', { class: 'name' }, x.name ?? '이름 없음'), h('td', { class: 'num' }, num(x.amount)), h('td', { class: 'num' }, pct(x.share)), h('td', { class: 'num' }, x.remaining ? num(x.remaining) : '—'), h('td', { class: 'num' }, num(x.count))]
          : [h('td', { class: 'name' }, x.name ?? '품목 없음'), h('td', { class: 'num' }, num(x.count)), h('td', { class: 'num' }, num(x.amount)), h('td', { class: 'num' }, pct(x.share))]),
      ),
    );
    const sideSeg = h('div', { class: 'sx-seg', role: 'group', 'aria-label': '기준' }, ...[['sale', '매출'], ['purchase', '매입']].map(([v, t]) => h('button', { type: 'button', class: m.side === v ? 'is-on' : null, 'aria-pressed': String(m.side === v), onclick: () => ((m.side = v), rerender()) }, t)));
    return listModal({
      id: 'report-all',
      title,
      onClose: close,
      tools: [sideSeg, search],
      body: m.failed ? h('p', { class: 'sx-body-sm' }, '불러오지 못했어요. 닫고 다시 열어 주세요.') : !r ? h('p', { class: 'sx-body-sm is-muted' }, '불러오는 중이에요') : rows.length ? listTableEl(cols, rows) : h('p', { class: 'sx-body-sm is-muted' }, q ? '찾는 이름이 없어요' : '없어요'),
    });
  }

  function linesModal(m) {
    const d = s.data;
    const verb = m.side === 'out' ? '나간 돈' : '들어온 돈';
    const title = `${period(d)} ${ro(m.label)} ${verb}${m.rows ? ` ${num(m.rows.length)}건` : ''}`;
    const editable = m.category !== 'receivable' && m.category !== 'payable';
    const rows = (m.rows ?? []).map((x) => {
      const cur = m.picks[x.id] ?? x.human ?? x.category;
      const cell = editable
        ? selectInput(PICK[m.side], { value: cur, compact: true, 'aria-label': `${md(x.day)} ${x.label} 갈래`, 'data-txn': x.id })
        : h('span', {}, m.category === 'receivable' ? '받을 돈' : '매입 결제');
      if (editable)
        cell.addEventListener('change', () => {
          if (cell.value === (x.human ?? x.category)) delete m.picks[x.id];
          else m.picks[x.id] = cell.value;
          rerender();
        });
      return h('tr', {}, h('td', { class: 'num-l' }, md(x.day)), h('td', { class: 'name' }, x.label || '표시 없음'), h('td', { class: 'num-l' }, x.account), h('td', {}, cell), h('td', { class: 'num' }, num(x.amount)));
    });
    const dirty = Object.keys(m.picks).length;
    return listModal({
      id: 'report-lines',
      title,
      onClose: close,
      body: m.failed ? h('p', { class: 'sx-body-sm' }, '불러오지 못했어요. 닫고 다시 열어 주세요.') : !m.rows ? h('p', { class: 'sx-body-sm is-muted' }, '불러오는 중이에요') : rows.length ? listTableEl([['날짜'], ['통장 표시'], ['계좌'], ['갈래'], ['금액', 'num']], rows) : h('p', { class: 'sx-body-sm is-muted' }, '없어요'),
      primary: editable ? btn(m.busy ? '저장하는 중' : '저장', saveLines, 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-lines-save', disabled: m.busy || !dirty ? true : null }) : null,
    });
  }

  const listTableEl = (cols, rows) => h('div', { class: 'list-box rp-list' }, h('table', { class: 'list' }, h('thead', {}, h('tr', {}, cols.map(([t, cls]) => h('th', { class: cls ?? null }, t)))), h('tbody', {}, rows)));

  return {
    load,
    view,
    onSync,
    sync: () => s.sync,
    reset: () => pick({ month: null }),
    at: (month) => Object.assign(s, { month, months: 1, saved: null }),
    modalOpen: () => !!s.modal || !!authStep(),
    modal: () => {
      const step = authStep();
      return step ? authModal(step) : s.modal?.kind === 'all' ? allModal(s.modal) : s.modal?.kind === 'lines' ? linesModal(s.modal) : null;
    },
    close: () => {
      const step = authStep();
      if (!step) return close();
      if (step !== 'sent') authCancel();
    },
  };
}
