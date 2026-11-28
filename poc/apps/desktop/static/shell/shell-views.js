import { amountInput, bizNoInput, checkFields, dateInput, emailInput, keys, kvField, LIMITS, selectInput, textInput } from './fields.js';
import { pickList, pickModal } from './shell-ui.js';

export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  if (tag === 'tr' && typeof attrs?.onclick === 'function') {
    el.tabIndex = 0;
    el.addEventListener('keydown', (e) => {
      if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        el.click();
      }
    });
  }
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';
const ICONS = {
  chat: [20, 'M3.5 5.5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H9l-3.5 3v-3a2 2 0 0 1-2-2z'],
  docs: [20, 'M3 6.5V15a1.5 1.5 0 0 0 1.5 1.5h11A1.5 1.5 0 0 0 17 15V8a1.5 1.5 0 0 0-1.5-1.5H10L8.5 4.5h-4A1.5 1.5 0 0 0 3 6z'],
  cps: [20, 'M10.25 7a2.75 2.75 0 1 1-5.5 0a2.75 2.75 0 1 1 5.5 0z', 'M2.5 16c.6-2.6 2.6-4 5-4s4.4 1.4 5 4', 'M13 4.6a2.6 2.6 0 0 1 0 5', 'M14.5 12.2c1.6.5 2.6 1.8 3 3.8'],
  biz: [20, 'M3.5 16.5V5.5l6.5-2.5 6.5 2.5v11', 'M2.5 16.5h15', 'M8 16.5v-4h4v4'],
  bundle: [20, 'M3.5 7h13v8.5a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5z', 'M2.5 4h15v3h-15z', 'M8 10.5h4'],
  activity: [20, 'M6 5h10M6 10h10M6 15h10M3 5h.5M3 10h.5M3 15h.5'],
  update: [20, 'M10 3v9M6 8.5l4 4 4-4', 'M4 15.5h12'],
  settings: [20, 'M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z', 'M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4'],
  pc: [16, 'M2 3.5h12v7.5H2z', 'M6 13.5h4M8 11v2.5'],
  lock: [16, 'M4.5 7h7A1.5 1.5 0 0 1 13 8.5v4a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 12.5v-4A1.5 1.5 0 0 1 4.5 7z', 'M5.5 7V5a2.5 2.5 0 0 1 5 0v2'],
  phone: [16, 'M6 1.5h4A1.5 1.5 0 0 1 11.5 3v10a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 13V3A1.5 1.5 0 0 1 6 1.5z', 'M7 12h2'],
  chevron: [10, 'M2 3.5 5 6.5 8 3.5'],
  chevronLeft: [16, 'M10 3 5 8l5 5'],
  warn: [16, 'M8 2.5 14 13H2z', 'M8 6.5v3M8 11.2v.1'],
  key: [16, 'M8.5 10.5a3 3 0 1 1-6 0a3 3 0 1 1 6 0z', 'M7.7 8.3 13.5 2.5M11.5 4.5l1.5 1.5'],
  mail: [16, 'M2.5 3.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z', 'M2 4l6 5 6-5'],
  plus: [16, 'M8 3v10M3 8h10'],
  file: [16, 'M4 2h5l3 3v9H4z', 'M9 2v3h3'],
  doc: [16, 'M4 2h5l3 3v9H4z', 'M9 2v3h3', 'M6 8.5h4M6 11h4'],
  search: [16, 'M11.5 7a4.5 4.5 0 1 1-9 0a4.5 4.5 0 1 1 9 0z', 'M10.5 10.5 14 14'],
  check: [16, 'M3.5 8.5 6.5 11.5 12.5 4.5'],
  info: [16, 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z', 'M8 7.5v3.5M8 5v.5'],
  clock: [16, 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z', 'M8 4.8V8l2.2 1.6'],
  refresh: [16, 'M13 8a5 5 0 1 1-1.46-3.54', 'M13 2.5v3h-3'],
  close: [16, 'M4 4l8 8M12 4l-8 8'],
  eye: [16, 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z'],
  eyeOff: [16, 'M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z', 'M10 8a2 2 0 1 1-4 0a2 2 0 1 1 4 0z', 'M2.5 2.5l11 11'],
  send: [14, 'M7 11.5v-9M3 6.5l4-4 4 4'],
  payroll: [20, 'M5 2.5h10A1.5 1.5 0 0 1 16.5 4v12.5l-2-1.25-2 1.25-2.5-1.25-2.5 1.25-2-1.25-2 1.25V4A1.5 1.5 0 0 1 5 2.5z', 'M7 6.5h6M7 9.5h6M7 12.5h3'],
  report: [20, 'M4.5 16.5v-7M10 16.5v-12M15.5 16.5v-5'],
  money: [20, 'M2.5 5.5h15v9h-15z', 'M12.5 10a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0z', 'M5 8v4M15 8v4'],
  pencil: [16, 'M3 13l.7-2.8L10.9 3a1.4 1.4 0 0 1 2 2l-7.2 7.2z'],
  amend: [16, 'M3 13l.8-3.3L11 2.5 13.5 5 6.3 12.2 3 13z', 'M9.5 4l2.5 2.5'],
  cancel: [16, 'M13.5 8a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0z', 'M6 6l4 4M10 6l-4 4'],
  chevronRight: [16, 'M6 3l5 5-5 5'],
  doneCircle: [16, 'M13.5 8a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0z', 'M5.5 8.2l1.8 1.8 3.2-3.6'],
  failCircle: [16, 'M13.5 8a5.5 5.5 0 1 1-11 0a5.5 5.5 0 1 1 11 0z', 'M8 5v3.5M8 10.8v.2'],
  globe: [16, 'M14 8A6 6 0 1 1 2 8a6 6 0 0 1 12 0z', 'M2 8h12', 'M8 2c1.7 1.6 2.5 3.6 2.5 6S9.7 12.4 8 14C6.3 12.4 5.5 10.4 5.5 8S6.3 3.6 8 2z'],
  expand: [16, 'M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9'],
  shrink: [16, 'M13 7H9V3M9 7l4.5-4.5M3 9h4v4M7 9l-4.5 4.5'],
};
export function icon(name) {
  const [box, ...paths] = ICONS[name];
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('viewBox', `0 0 ${box} ${box}`);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.5');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(SVG, 'path');
    p.setAttribute('d', d);
    s.append(p);
  }
  return s;
}

/**
 * 화면 글자에 넣을 값. 빈 값(null, undefined, 빈 글, 숫자가 아님)이면 null을 돌려 그 줄이나 조각을 그리지 않는다.
 * 카드 글에 "null", "undefined", "NaN"이 새지 않게 하는 공용 처리다(tests/shell-card-text.test.ts가 지킨다).
 */
export const shown = (v) => (v == null || v === false || (typeof v === 'number' && !Number.isFinite(v)) || (typeof v === 'string' && !v.trim()) ? null : v);
export const num = (n) => (shown(n) === null || !Number.isFinite(Number(n)) ? '' : Number(n).toLocaleString('en-US').replace(/^-/, '−'));
export const won = (n) => (num(n) ? `${num(n)}원` : '');
const WON_UNITS = [[1e12, '조'], [1e8, '억'], [1e4, '만']];
/** 큰 금액은 조, 억, 만으로 나눠 쓴다(886억 5,627만 3,113원). */
export const bigWon = (n) => {
  if (!Number.isFinite(n)) return '';
  let rest = Math.abs(Math.round(n));
  const parts = [];
  for (const [u, name] of WON_UNITS) {
    const q = Math.floor(rest / u);
    if (q) parts.push(`${q.toLocaleString('en-US')}${name}`);
    rest -= q * u;
  }
  if (rest || !parts.length) parts.push(rest.toLocaleString('en-US'));
  return `${n < 0 ? '−' : ''}${parts.join(' ')}원`;
};
/** 빈 조각은 빼고 ", "로 잇는다. */
export const joinShown = (...xs) => xs.map(shown).filter((x) => x !== null).join(', ');
/** dl 한 줄(dt, dd). 값이 비면 줄째 그리지 않는다. */
export const kvPair = (label, value, attrs = {}) => (shown(value) === null ? null : [h('dt', {}, label), h('dd', attrs, value)]);
export const fmtBiz = (d) => (d && d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}` : d || '—');
const WD = ['일', '월', '화', '수', '목', '금', '토'];
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const dayLabel = (s) => {
  const d = parse(s);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
};
export function museStamp(at, now = new Date(), dateOnly = false) {
  const d = new Date(at);
  const sameDay = d.toDateString() === now.toDateString();
  const date = sameDay ? null : { month: 'short', day: 'numeric', ...(d.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) };
  if (dateOnly) return date ? new Intl.DateTimeFormat('ko-KR', date).format(d) : '오늘';
  return new Intl.DateTimeFormat('ko-KR', { ...date, hour: 'numeric', minute: '2-digit' }).format(d);
}
export const museDayStamp = (s, now) => museStamp(parse(s).getTime(), now, true);
export function dday(s, today) {
  if (!s) return null;
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((parse(s) - t) / 86400000);
}
export const ddayText = (n) => (n === null ? '—' : n < 0 ? '만료됨' : n === 0 ? 'D-day' : `D-${n}`);
export function agoText(s, today) {
  const n = dday(s, today);
  return n === null || n > 0 ? '' : n === 0 ? '(오늘)' : `(${-n}일 전)`;
}

export const CHIP = {
  draft: ['작성 중', ''],
  preparing: ['준비 중', ''],
  turn: ['내 차례', 'is-turn'],
  waiting: ['승인 대기', 'is-waiting'],
  issuing: ['발급 중', ''],
  checking: ['확인 중', ''],
  done: ['완료', 'is-done'],
  stopped: ['중지됨', 'is-stopped'],
  discarded: ['취소함', 'is-stopped'],
  attention: ['확인 필요', 'is-attention'],
};
export const chip = (status, label) => h('span', { class: `sx-chip ${CHIP[status][1]}` }, label ?? CHIP[status][0]);

export const verifying = (run) => run.status === 'issuing' && run.steps[6]?.state === 'now';
export const shownStatus = (run) => (verifying(run) ? 'checking' : run.status === 'draft' && run.starting ? 'preparing' : run.status);

export function amount(total, supply, tax, note, split = true) {
  if (!num(total)) return null;
  return h(
    'div',
    { class: 'sx-amount' },
    h('div', { class: 'sx-amount-total' }, num(total), h('span', { class: 'sx-unit' }, '원')),
    split && num(supply) && num(tax) ? h('div', { class: 'sx-amount-split' }, joinShown(`공급가 ${num(supply)} + 세액 ${num(tax)}`, note)) : null,
  );
}

export function kv(rows, start = false) {
  return h(
    'dl',
    { class: `sx-kv${start ? ' is-start' : ''}` },
    rows.filter((r) => r && shown(r[1]) !== null).map(([label, value, o = {}]) => [
      h('dt', {}, label),
      h(
        'dd',
        { class: [o.state ? `is-${o.state}` : '', o.total ? 'is-total' : '', o.start ? 'is-start' : ''].join(' ').trim() || null },
        h('span', { class: `sx-val${o.mono ? ' sx-id' : ''}` }, value),
        o.tag ? h('span', { class: 'sx-tag' }, o.tag) : null,
        o.flag ? h('span', { class: 'sx-flag' }, o.flag) : null,
        o.copy ? h('button', { type: 'button', class: 'sx-copy', onclick: o.copy, 'aria-label': `${label} ${o.copyLabel ?? '복사'}` }, o.copyLabel ?? '복사') : null,
      ),
    ]),
  );
}

export function steps(list) {
  return h(
    'ol',
    { class: 'sx-steps' },
    list.map((s) =>
      h(
        'li',
        { class: s.state === 'todo' ? null : `is-${s.state}` },
        h(
          'span',
          {},
          s.label,
          s.note ? h('small', {}, s.note) : null,
          ...(s.checks ?? []).map((c) => h('small', { class: `sx-step-check ${c.ok ? 'is-ok' : 'is-bad'}`, 'data-portal-check': c.ok ? 'ok' : 'bad' }, c.text)),
        ),
      ),
    ),
  );
}

const STEP_GROUPS = [
  ['홈택스 로그인', [0]],
  ['세금계산서 화면 열기', [1]],
  ['내용 넣고 확인', [2, 3]],
  ['사장님 승인', [4]],
  ['서명하고 발급 확인', [5, 6]],
];
const CERT_STEP_GROUPS = [
  ['홈택스 로그인', [0]],
  ['신청 화면 열기', [1]],
  ['신청 내용 넣고 확인', [2, 3]],
  ['사장님 승인', [4]],
  ['발급하고 확인', [5, 6]],
];
const ACTIVE = ['preparing', 'turn', 'waiting', 'issuing'];
export function runSteps(run) {
  const groups = (run.cert ? CERT_STEP_GROUPS : STEP_GROUPS).map(([label, idx]) => {
    const g = group(label, idx);
    const checks = (run.portalChecks ?? []).filter((c) => idx.includes(c.step));
    return checks.length ? { ...g, checks } : g;
  });
  function group(label, idx) {
    const xs = idx.map((i) => run.steps[i]).filter(Boolean);
    const pick = (st) => xs.find((s) => s.state === st);
    const att = pick('attention');
    const now = pick('now');
    if (att) return { label, state: 'attention', note: att.note };
    if (now) return { label, state: 'now', note: now.note };
    if (xs.length && xs.every((s) => s.state === 'done')) return { label, state: 'done', note: xs.map((s) => s.note).filter(Boolean)[0] };
    if (xs.some((s) => s.state === 'done') && ACTIVE.includes(run.status)) return { label, state: 'now' };
    return { label, state: 'todo' };
  }
  if (run.status === 'attention' && !groups.some((g) => g.state === 'attention')) {
    const at = groups.find((g) => g.state !== 'done');
    if (at) at.state = 'attention';
  }
  return groups;
}

export function note(text, attention, extra, ic = 'info') {
  return h('div', { class: `sx-note${attention ? ' is-attention' : ''}` }, icon(ic), h('div', {}, text, extra ? h('div', { class: 'sx-meta' }, extra) : null));
}

export function noteGroup(items, attention = true, ic = attention ? 'warn' : 'info') {
  const list = items.filter(Boolean).map((x) => (Array.isArray(x) ? x : [x, {}]));
  if (!list.length) return null;
  return h('div', { class: `sx-note${attention ? ' is-attention' : ''}`, 'data-note-group': String(list.length) }, icon(ic), h('div', { class: 'sx-note-body' }, ...list.map(([t, a]) => h('p', a, t))));
}

const tagged = (el, key, value) => ((el.dataset[key] = value), el);

export const btn = (label, onclick, kind = '', attrs = {}) => h('button', { type: 'button', class: `sx-btn ${kind}`.trim(), onclick, ...attrs }, label);

const vatText = (run) => (run.vat === 'separate' ? (run.status === 'draft' && run.vatGuessed ? '부가세 별도로 계산했어요' : '부가세 별도') : '부가세 포함');
const nowStep = (run) => runSteps(run).find((s) => s.state === 'now' || s.state === 'attention');
const line = (text, muted) => h('p', { class: `sx-body-sm${muted ? ' is-muted' : ''}` }, text);

export const NO_CHROME_TEXT = 'Chrome이 설치돼 있어야 발급할 수 있어요. Chrome을 설치한 뒤 [발급하기]를 다시 눌러 주세요. 아직 아무것도 보내지 않았어요.';
export const CHROME_GUIDE_TEXT = '홈택스 작업은 이 PC의 Chrome 창에서 해요. 다른 브라우저에서 google.com/chrome 을 열어 Chrome을 설치한 뒤 [다시 확인]을 눌러 주세요.';
export const ISSUE_DATE_LATE_TEXT = '국세청 안내 발급기한(공급한 달 다음 달 10일)이 지났어요. 가산세가 붙는지는 세무사에게 확인해 보세요.';
export const ISSUE_DATE_HELD_TEXT = '작성일자를 오늘이 아닌 날로 정한 카드는 곧 발급할 수 있어요. 지금 발급하려면 작성일자를 오늘로 바꿔 주세요.';
export const writeDateText = (d) => {
  if (!/^\d{4}-\d{2}-\d{2}/.test(String(d ?? ''))) return null;
  const y = Number(String(d).slice(0, 4));
  const md = `${Number(String(d).slice(5, 7))}월 ${Number(String(d).slice(8, 10))}일`;
  return y === Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(new Date())) ? md : `${y}년 ${md}`;
};
export const BIG_AMOUNT_TEXT = '평소보다 훨씬 큰 금액이에요. 금액이 맞는지 한 번 더 확인해 주세요.';
export const DUP_TODAY_TEXT = '이미 오늘 같은 거래처/같은 금액으로 발급했어요. 한 번 더 발급하려는 게 맞는지 확인해 주세요.';

export function emptyState(title, sub, action = null, attrs = {}) {
  return h('div', { class: 'empty', ...attrs }, h('p', { class: 'empty-title' }, title), sub ? h('p', { class: 'empty-sub' }, sub) : null, action ? h('div', { class: 'empty-act' }, action) : null);
}

export function replyOptions(opts, attrs = {}) {
  const box = h('div', { class: 'sx-replies', role: 'group', ...attrs });
  const rows = opts.map((o) =>
    h(
      'button',
      {
        type: 'button',
        class: 'sx-reply',
        'data-act': o.act ?? null,
        ...(o.attrs ?? {}),
        onclick: (e) => {
          const row = e.currentTarget;
          if (box.dataset.picked) return;
          if (o.lock !== false) {
            box.dataset.picked = '1';
            for (const r of rows) r.disabled = r !== row;
            row.classList.add('is-picked');
            row.append(icon('check'));
          }
          o.onPick(e);
        },
      },
      h('span', {}, o.label),
    ),
  );
  box.append(...rows);
  return box;
}

export const NO_FILE_TEXT = '세금계산서 PDF는 홈택스 발급목록에서 확인할 수 있어요.';
const CERT_NO_FILE_TEXT = '원본 PDF를 받지 못했어요.';
/** 발급한 파일을 여는 단추 둘(대표 11-24): 파일 열기, 폴더에서 보기. */
const fileBtns = (open, reveal, act = '') => [btn('열기', open, 'sx-btn-primary', { 'data-act': `${act}open` }), btn('폴더에서 보기', reveal, '', { 'data-act': `${act}reveal` })];
export const docDate = (doc) => (doc.issuedOn ? (doc.issuedAt ? `${doc.issuedOn} ${doc.issuedAt}` : doc.issuedOn) : null);

export const runTitle = (run) => (run.cert ? shown(run.cert.name) ?? '민원서류' : run.amend ? shown(run.amend.view.title) ?? '세금계산서 고치기' : [shown(run.counterparty?.name), '세금계산서'].filter(Boolean).join(' '));
const md = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d ?? '') ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일` : d ?? '');
/**
 * 카드 제목(기준판 PC 부품, v3.0 확정 기준 2): 테두리 대신 제목 앞 아이콘으로 종류와 상태를 가른다.
 * 발급은 문서, 고치기는 연필, 취소는 동그라미 X(늘 danger), 완료는 동그라미 체크, 실패는 동그라미 느낌표(색 없음),
 * 발급됐는지 모름은 세모(attention). 승인이나 내 차례를 기다리면 아이콘이 accent다. 발급 카드가 끝나면 제목 끝에 "발급 완료".
 */
/** 카드 제목 한 줄: 아이콘(18) + 600 제목. tone은 wait(accent), attn(attention), cancel(danger). 대화 카드는 모두 이것을 쓴다. */
export const titleWithIcon = (name, text, tone = '') => h('div', { class: name ? `sx-card-title sx-card-t${tone ? ` is-${tone}` : ''}` : 'sx-card-title' }, name ? icon(name) : null, text);

const moveCounts = (c) => [c.bank_txns ? `통장 내역 ${num(c.bank_txns)}건` : '', c.documents ? `서류 ${num(c.documents)}개` : ''].filter(Boolean).join(', ');

export function moveLine(m, o) {
  const bar = (n, total) => {
    const fill = h('i');
    fill.style.width = `${total ? Math.round((n / total) * 100) : 0}%`;
    return h('div', { class: 'sx-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(total), 'aria-valuenow': String(n) }, fill);
  };
  const line = (...kids) => h('div', { class: 'sx-card is-line', 'data-move': m.step }, ...kids);
  const close = () => btn('닫기', o.onClose, 'sx-btn-text');
  switch (m.step) {
    case 'waiting':
      return line(titleWithIcon('pc', '쓰던 PC를 켜면 기록을 가져와요'));
    case 'receiving':
      return line(titleWithIcon('pc', `‘${m.fromName}’에서 기록을 가져오고 있어요`), chip('issuing', '받는 중'), bar(m.got, m.total));
    case 'received': {
      const what = moveCounts(m.counts);
      return line(titleWithIcon('doneCircle', what ? `기록을 가져왔어요. ${what}` : '기록을 가져왔어요'), close());
    }
    case 'update_needed':
      return line(titleWithIcon('warn', '이 PC의 앱을 올린 뒤 가져와요', 'attention'), o.updateReady ? btn('업데이트', o.onUpdate, 'sx-btn-text is-main') : null);
    case 'sending':
      return line(titleWithIcon('pc', `새 PC ‘${m.toName}’로 기록을 보내고 있어요`), chip('issuing', '보내는 중'), bar(m.sent, m.total));
    case 'sent':
      return line(titleWithIcon('doneCircle', `새 PC ‘${m.toName}’로 기록을 보냈어요`), close());
    default:
      return null;
  }
}

const cardTitle = (run, prefix = '', suffix = '') => {
  const st = run.status;
  const failed = (st === 'stopped' || st === 'attention') && !run.inDoubt;
  const doubt = run.inDoubt && st === 'attention';
  const name = st === 'done' ? 'doneCircle' : failed ? 'failCircle' : doubt ? 'warn' : run.amend ? (run.amend.view.icon === 'cancel' ? 'cancel' : 'amend') : 'doc';
  const tone = name === 'cancel' ? 'cancel' : st === 'waiting' || st === 'turn' ? 'wait' : doubt ? 'attn' : '';
  return titleWithIcon(name, `${prefix}${runTitle(run)}${st === 'done' && !run.amend ? ' 발급 완료' : ''}${suffix}`, tone);
};
/** 머리 줄 칩은 진행 상태(준비 중, 발급 중, 확인 중)뿐이다. 승인 대기, 내 차례, 확인 필요, 완료, 실패는 아이콘이 말한다(README v3.0 규칙 3). */
const progressChip = (run) => (['preparing', 'issuing', 'checking'].includes(shownStatus(run)) ? chip(shownStatus(run)) : null);
const certLine = (run) => h('div', { class: 'sx-meta', 'data-cert-inputs': '' }, `사용 용도 ${run.cert.inputs.purpose ?? ''}, 제출처 ${run.cert.inputs.submitTo ?? ''}`);

const showBrowserBtn = (run, act, primary = false) => btn('홈택스 창 보기', () => act.showBrowser(run.id), primary ? 'sx-btn-primary' : '', { 'data-act': 'show-browser' });

const verifyLine = (n) => (n && n > 1 ? `발급 목록 다시 확인 중(${n}번째)` : '발급 목록 확인 중, 1~2분 걸려요');
const stepLine = (now, withNote = true) => (now ? (withNote && now.note ? now.note : now.label) : '');
function progressBar(run) {
  const gs = runSteps(run);
  const done = gs.filter((g) => g.state === 'done').length;
  const at = gs.findIndex((g) => g.state === 'now' || g.state === 'attention');
  const n = Math.min(gs.length, done + (at >= 0 ? 0.5 : 0));
  const fill = h('i');
  fill.style.width = `${Math.round((n / gs.length) * 100)}%`;
  return h('div', { class: 'sx-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(gs.length), 'aria-valuenow': String(done), 'aria-label': `${gs.length}단계 중 ${done}단계 끝`, 'data-progress': `${done}/${gs.length}` }, fill);
}

const todoLine = (text, ...meta) => h('div', { class: 'sx-todo' }, h('p', {}, text), meta.filter(Boolean).map((m) => (m instanceof Node ? m : h('p', { class: 'sx-meta' }, m))));

/** 진행 중인 카드: 제목과 상태, 지금 하는 일 한 문장과 막대(기준판 "진행 중, 단추 없이 한 문장과 막대"). [중지]는 맨 아래 단추 줄 끝에 붙는다(taskCard 끝). */
function fold(card, run, act, step, stop = null) {
  const info = run.info && run.info !== step ? [run.info] : [];
  card.stopBtn = stop;
  card.replaceChildren(
    ...[
      h('div', { class: 'sx-card-hd sx-run-hd' }, cardTitle(run, run.batch ? `${run.batch.index + 1}. ` : ''), progressChip(run)),
      run.cert ? certLine(run) : null,
      step || info.length
        ? h(
            'div',
            { class: 'sx-run-foot' },
            step ? h('p', { class: 'sx-card-now', 'aria-live': 'polite' }, step, progressCount(run)) : null,
            run.status === 'attention' || run.status === 'stopped' ? null : progressBar(run),
            ...info.map((t) => h('p', { class: 'sx-run-info', 'data-run-info': '' }, t)),
            stepsToggle(run, act),
          )
        : null,
    ].filter(Boolean),
  );
}

function stepsToggle(run, act) {
  if (!act?.stepsOpen) return null;
  const open = act.stepsOpen.has(run.id);
  const list = steps(runSteps(run));
  list.classList.add('sx-run-steps');
  if (!open) list.hidden = true;
  const b = h('button', { type: 'button', class: 'sx-steps-toggle', 'data-act': 'steps-toggle', 'aria-expanded': String(open) }, open ? '단계 접기' : '단계 보기', icon('chevron'));
  b.addEventListener('click', () => {
    const now = list.hidden;
    list.hidden = !now;
    b.setAttribute('aria-expanded', String(now));
    b.firstChild.textContent = now ? '단계 접기' : '단계 보기';
    act.toggleSteps(run.id, now);
  });
  return [b, list];
}

function progressCount(run) {
  if (run.status === 'attention' || run.status === 'stopped') return null;
  const gs = runSteps(run);
  return h('span', { class: 'sx-run-count' }, `${Math.min(gs.length, gs.filter((g) => g.state === 'done').length + 1)}/${gs.length}`);
}
const LIVE = ['draft', 'preparing', 'turn', 'waiting', 'issuing'];
const stopBtn = (run, act) => btn('중지', () => act.stop(run.id), '', { 'data-act': 'stop' });

export function taskCard(run, act) {
  if (run.discarded)
    return h(
      'section',
      { class: 'sx-card is-discarded', 'data-run': run.id, 'data-status': 'discarded' },
      h('div', { class: 'sx-card-hd' }, cardTitle(run), chip('discarded')),
    );
  const st = run.status;
  if (st === 'draft' && run.amend && !run.starting) return amendCard(run, act);
  const card = h('section', { class: 'sx-card', 'data-run': run.id, 'data-status': st });
  const domAppend = card.append.bind(card);
  card.append = (...kids) => domAppend(...kids.flat().filter((k) => k != null && k !== false));
  card.addEventListener('click', (e) => {
    if (!e.target.closest('button, input, select, dl, .sx-where')) act.open(run.id);
  });
  card.append(h('div', { class: 'sx-card-hd' }, cardTitle(run), progressChip(run)), run.cert ? certLine(run) : null);
  const now = nowStep(run);

  if (st === 'draft' && run.starting) {
    card.dataset.starting = '';
    fold(card, run, act, run.info || '곧 시작해요', stopBtn(run, act));
  } else if (st === 'draft' && run.cert) {
    card.append(
      noteGroup([run.noChrome ? [NO_CHROME_TEXT, { 'data-no-chrome': '' }] : null, ...(run.notices ?? [])]),
      h('div', { class: 'sx-actions' }, btn('홈택스에서 떼기', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare' }), btn('취소', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'cancel' })),
    );
  } else if (st === 'draft') {
    const noItem = !String(run.item ?? '').trim();
    const noAmount = !(Number(run.total) > 0);
    const errAt = (f) => (act.draftErr?.id === run.id && act.draftErr.field === f ? act.draftErr.msg : null);
    const kept = (act.draftErr?.id === run.id && act.draftErr.vals) || {};
    const err = act.draftErr?.id === run.id && !act.draftErr.field ? h('p', { class: 'sx-field-error', role: 'alert', 'data-draft-err': '' }, act.draftErr.msg) : null;
    const valBtn = (label, text, onclick, o = {}) =>
      h('button', { type: 'button', class: `sx-val-btn${o.cls ? ` ${o.cls}` : ''}`, 'data-act': o.act, 'aria-label': `${label}: ${text}. 눌러서 고치기`, onclick }, text);
    let rows;
    if (act.editingCp === run.id) {
      const others = (act.counterparties ?? []).filter((c) => c.id !== run.counterparty.id);
      const cancel = () => act.editCp(null);
      const quit = btn('그만두기', cancel, 'sx-btn-quiet', { 'data-act': 'draft-cp-cancel' });
      if (others.length) {
        const sel = selectInput(others.map((c) => [c.id, c.name]), { name: 'counterparty', compact: true });
        const save = () => act.saveCp(run.id, sel.value);
        sel.addEventListener('keydown', keys(save, cancel));
        rows = kvField({ label: '거래처', input: sel, error: errAt('counterparty'), after: [btn('바꾸기', save, 'sx-btn-primary', { 'data-act': 'draft-cp-save' }), quit], attrs: { 'data-draft-cp': '' } });
        setTimeout(() => sel.focus(), 0);
      } else rows = [h('dt', {}, '거래처'), h('dd', { class: 'is-editing' }, h('div', { class: 'sx-actions', 'data-draft-cp': '' }, h('span', { class: 'sx-meta' }, '장부에 다른 거래처가 없어요. 거래처 화면에서 추가할 수 있어요.'), quit))];
    } else if (act.editing === run.id) {
      const input = amountInput({ name: 'amount', value: kept.amount ?? run.amount, units: true, compact: true });
      const save = () => checkFields([input]) && act.saveAmount(run.id, input.value);
      const cancel = () => act.editAmount(null);
      input.addEventListener('keydown', keys(save, cancel));
      rows = kvField({ label: run.vat === 'separate' ? '공급가액' : '합계', input, error: errAt('amount'), after: [btn('바꾸기', save, 'sx-btn-primary'), btn('그만두기', cancel, 'sx-btn-quiet')] });
      setTimeout(() => (input.focus(), input.select()), 0);
    } else if (act.editingFields === run.id) {
      const item = textInput({ name: 'item', value: kept.item ?? run.item, max: LIMITS.item, required: '품목을 넣어 주세요. 예: 컨설팅 용역', placeholder: '예: 컨설팅 용역', compact: true });
      const email = emailInput({ name: 'email', value: kept.email ?? run.email.value, compact: true });
      const save = () => checkFields([item, email]) && act.saveFields(run.id, item.value, email.value);
      const cancel = () => act.editFields(null);
      for (const i of [item, email]) i.addEventListener('keydown', keys(save, cancel));
      rows = [
        ...kvField({ label: '품목', input: item, error: errAt('item') }),
        ...kvField({ label: '받는 이메일', input: email, help: '비우면 메일을 보내지 않아요', error: errAt('email') }),
        h('dt', {}, ''),
        h('dd', { class: 'is-editing' }, h('div', { class: 'sx-actions' }, btn('바꾸기', save, 'sx-btn-primary', { 'data-act': 'fields-save' }), btn('그만두기', cancel, 'sx-btn-quiet', { 'data-act': 'fields-cancel' }))),
      ];
      setTimeout(() => (act.editingFocus === 'email' ? email : item).focus(), 0);
    } else {
      const vatSeg = h(
        'div',
        { class: 'sx-seg', role: 'group', 'aria-label': '부가세' },
        ...[['separate', '별도', 'included'], ['included', '포함', 'separate']].map(([v, label]) =>
          h('button', { type: 'button', class: run.vat === v ? 'is-on' : null, 'aria-pressed': String(run.vat === v), 'data-act': run.vat === v ? null : 'vat', onclick: run.vat === v ? null : () => act.vat(run.id, v) }, label),
        ),
      );
      // 기준판 PC 부품 "발급, 작성 중": 줄마다 이름 왼쪽, 값 오른쪽. 고칠 수 있는 값은 눌러서 그 자리에서 고친다. 추정 값도 회색 꼬리표 없이 값만 보인다.
      const byTotal = run.vat === 'included';
      const amountBtn = (text, cls) => valBtn('금액', text, () => act.editAmount(run.id), { act: 'amount-edit', cls: [cls, noAmount ? 'is-missing' : ''].filter(Boolean).join(' ') });
      rows = [
        h('dt', {}, '거래처'),
        h('dd', {}, valBtn('거래처', shown(run.counterparty.name) ?? '거래처 없음', () => act.editCp(run.id), { act: 'draft-cp', cls: shown(run.counterparty.name) ? '' : 'is-missing' })),
        h('dt', {}, '작성일'),
        h('dd', { 'data-draft-date': run.writeDate ?? '' }, writeDateText(run.writeDate)),
        h('dt', {}, '공급가액'),
        h('dd', {}, byTotal ? h('span', { class: 'sx-val' }, won(run.supply)) : amountBtn(won(run.supply), '')),
        h('dt', {}, '부가세'),
        h('dd', { class: 'is-vat' }, vatSeg, h('span', { class: 'sx-val' }, won(run.tax))),
        h('dt', {}, '품목'),
        h('dd', { 'data-draft-item': run.item ?? '' }, valBtn('품목', `${noItem ? '비어 있음' : run.item}`, () => act.editFields(run.id, 'item'), { act: 'fields-edit', cls: noItem ? 'is-missing' : run.itemGuessed ? 'is-guessed' : '' })),
        h('dt', {}, '받는 이메일'),
        h('dd', { 'data-draft-email': run.email.value ?? '' }, valBtn('받는 이메일', run.email.value || '보내지 않아요', () => act.editFields(run.id, 'email'), { act: 'email-edit', cls: run.email.value ? '' : 'is-none' })),
        h('dt', {}, '합계'),
        h('dd', { class: 'is-total', 'data-draft-amount': '' }, byTotal ? amountBtn(won(run.total), 'is-total') : h('span', { class: 'sx-val' }, won(run.total))),
      ];
    }
    const editing = act.editingCp === run.id || act.editing === run.id || act.editingFields === run.id;
    card.append(
      noteGroup([
        run.noChrome ? [NO_CHROME_TEXT, { 'data-no-chrome': '' }] : null,
        run.dupToday ? [DUP_TODAY_TEXT, { 'data-dup-today': '' }] : null,
        run.bigAmount ? [BIG_AMOUNT_TEXT, { 'data-big-amount': '' }] : null,
        run.issueDateHeld ? [ISSUE_DATE_HELD_TEXT, { 'data-issue-date-held': '' }] : run.issueDateLate ? [ISSUE_DATE_LATE_TEXT, { 'data-issue-date-late': '' }] : null,
        ...(run.notices ?? []),
      ]),
      h('dl', { class: 'sx-kv is-split sx-draft', 'data-draft-fields': '', 'data-draft-edit': act.editingFields === run.id ? '' : null }, ...rows),
      err,
      editing || !(noAmount || noItem) ? null : h('p', { class: 'sx-card-now', 'data-draft-missing': '' }, noAmount ? '합계가 0원이에요. 금액을 눌러 고치면 발급할 수 있어요.' : '품목을 넣으면 발급할 수 있어요.'),
      editing
        ? null
        : h(
            'div',
            { class: 'sx-actions' },
            btn('발급하기', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare', disabled: noItem || noAmount || !!run.issueDateHeld }),
            btn('수정', () => act.editFields(run.id, 'item'), '', { 'data-act': 'draft-edit' }),
            btn('취소', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'cancel' }),
          ),
    );
  } else if (st === 'preparing') {
    fold(card, run, act, stepLine(now, run.steps[0].state !== 'now'), stopBtn(run, act));
  } else if (verifying(run)) {
    fold(card, run, act, h('span', { 'data-verify-attempt': run.verifyAttempt ? String(run.verifyAttempt) : null }, verifyLine(run.verifyAttempt)));
  } else if (st === 'issuing' && run.steps[5].state === 'now' && run.steps[5].note) {
    card.dataset.signNow = '';
    fold(card, run, act, stepLine(now, false));
    card.append(todoLine(`${run.steps[5].note}. 끝나면 자동으로 이어집니다`, '홈택스 발급목록에서 확인할 때까지 다시 발급하지 않아요.'), h('div', { class: 'sx-actions' }, showBrowserBtn(run, act, true)));
  } else if (st === 'issuing') {
    fold(card, run, act, stepLine(now));
  } else if (st === 'turn' && run.handoff) {
    const kind = run.handoff.kind ?? 'other';
    card.dataset.handoff = kind;
    fold(card, run, act, stepLine(now, false), btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' }));
    card.append(
      todoLine(run.turn.text, run.turn.note, kind === 'sign' ? h('p', { class: 'sx-meta', 'data-sign-wait': '' }, '서명을 마치면 앱이 발급목록을 확인해요. 그동안 다시 발급하지 않아요.') : null),
      h(
        'div',
        { class: 'sx-actions' },
        kind === 'sign' ? showBrowserBtn(run, act, true) : null,
        run.handoff.code === 'login.simple_sent' ? btn('승인했어요', () => act.simpleDone(run.id), 'sx-btn-primary', { 'data-act': 'simple-done' }) : null,
        run.handoff.code === 'login.simple_auth' || run.handoff.code === 'login.simple_sent' ? btn('인증서로 다시 시도', () => act.retryCert(run.id), run.handoff.code === 'login.simple_auth' ? 'sx-btn-primary' : '', { 'data-act': 'retry-cert' }) : null,
        run.handoff.code === 'login.simple_sent' ? null : kind === 'login' ? btn(run.handoff.code === 'login.simple_auth' ? '간편인증 마치고 이어서' : '이어서', () => act.resume(run.id), run.handoff.code === 'login.simple_auth' ? '' : 'sx-btn-primary', { 'data-act': 'resume' }) : btn('다 했어요', () => act.resume(run.id), kind === 'sign' ? '' : 'sx-btn-primary', { 'data-act': 'resume' }),
        kind === 'other' ? btn('직접 발급함', () => act.manualDone(run.id), '', { 'data-act': 'manual-done' }) : null,
        kind === 'sign' ? null : showBrowserBtn(run, act),
      ),
    );
  } else if (st === 'turn') {
    const signing = run.steps[4].state === 'done';
    fold(card, run, act, stepLine(now, false), signing ? null : stopBtn(run, act));
    card.append(todoLine(run.turn.text, run.turn.note));
  } else if (st === 'waiting') {
    card.replaceChildren();
    card.classList.add('is-folded');
    card.append(
      ...[
        h('div', { class: 'sx-card-hd', 'data-folded': '' }, cardTitle(run, '', run.cert ? '' : `, ${won(run.total)}`), chip(shownStatus(run))),
        run.regate ? tagged(note(run.regate.note, true), 'regate', run.regate.reason) : null,
        run.approvedPending ? h('div', { class: 'sx-actions' }, note('승인했어요. 2초 안에 [중지]하면 발급하지 않아요'), btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'stop' })) : null,
      ].filter(Boolean),
    );
  } else if (st === 'done') {
    const r = run.result;
    const mail = mailState(run);
    card.append(
      h(
        'dl',
        { class: 'sx-kv is-split', 'data-done-rows': '' },
        kvPair('작성일', writeDateText(run.writeDate)),
        r.approvalNo ? [h('dt', {}, run.cert ? '접수번호' : '승인번호'), h('dd', {}, h('span', { class: 'sx-val sx-id', 'data-approval-no': '' }, r.approvalNo))] : null,
        run.cert ? null : [h('dt', {}, '받는 이메일'), h('dd', { 'data-done-mail': mail }, DONE_MAIL_TEXT[mail])],
        run.cert || !won(run.total) ? null : [h('dt', {}, '합계'), h('dd', { class: 'is-total' }, h('span', { class: 'sx-val' }, won(run.total)))],
      ),
      r.noFile ? line(run.cert ? CERT_NO_FILE_TEXT : NO_FILE_TEXT) : null,
      h(
        'div',
        { class: 'sx-actions' },
        ...(run.cert && !r.noFile
          ? [btn('열기', () => act.openRunDoc(run), 'sx-btn-quiet', { 'data-act': 'done-open' }), btn('폴더에서 보기', () => act.openRunDoc(run, true), 'sx-btn-quiet', { 'data-act': 'done-reveal' })]
          : [btn('자세히', () => act.open(run.id), '', { 'data-act': 'done-more' })]),
      ),
    );
  } else if (st === 'stopped' && run.replaced) {
    card.replaceChildren(h('div', { class: 'sx-replaced-line', 'data-replaced': '' }, h('span', {}, runTitle(run)), h('span', {}, joinShown(won(run.total), '고친 값으로 바꿨어요'))));
    card.classList.add('is-folded', 'is-replaced');
    return card;
  } else if (st === 'stopped') {
    fold(card, run, act, null);
    card.append(line(run.stoppedNote || '중지했어요.', true));
    if (run.browserClosed) card.append(h('div', { class: 'sx-actions' }, btn('다시 시작', () => act.restart(run.id), 'sx-btn-primary', { 'data-act': 'restart' })));
    else if (run.redo) card.append(h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'redraft' })));
  } else if (st === 'attention' && run.inDoubt) {
    card.dataset.inDoubt = '1';
    fold(card, run, act, stepLine(now, false));
    card.append(
      todoLine(
        run.stoppedNote || '발급됐는지 확인하지 못했어요.',
        '확인되기 전에는 이 건을 다시 발급하지 않아요.',
        run.attest?.note ? h('p', { class: 'sx-meta', 'data-attest': run.attest.state }, run.attest.note) : null,
      ),
      h('div', { class: 'sx-actions' }, btn('홈택스에서 직접 확인', () => act.open(run.id), 'sx-btn-primary', { 'data-act': 'check-list' })),
    );
  } else if (st === 'attention') {
    fold(card, run, act, stepLine(now, false));
    card.append(
      todoLine(run.stoppedNote || '확인이 필요해요.'),
      run.maintenance
        ? run.maintenance.restartedAs
          ? line('같은 내용으로 다시 시작했어요. 아래 새 카드에서 이어져요.', true)
          : run.maintenance.until
            ? h('div', { class: 'sx-meta', 'data-maintenance': 'auto' }, `${run.maintenance.until} 지나면 자동으로 다시 시작해요`)
            : h('div', { class: 'sx-actions', 'data-maintenance': 'manual' }, btn('다시 시작', () => act.restart(run.id), 'sx-btn-primary', { 'data-act': 'maintenance-restart' }))
        : run.handoffEnd
        ? h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'handoff-again' }), btn('홈택스에서 직접 발급', () => act.open(run.id), '', { 'data-act': 'handoff-manual' }))
        : run.redo && !run.retry
          ? h('div', { class: 'sx-actions' }, btn('다시 준비', () => act.redraft(run.id), 'sx-btn-primary', { 'data-act': 'redo' }))
          : null,
    );
  }
  if (run.notices?.length && !(st === 'draft' && !run.starting)) card.append(noteGroup(run.notices));
  if (run.info && LIVE.includes(st) && !run.starting && !card.querySelector('[data-run-info]')) card.append(h('p', { class: 'sx-run-info', 'data-run-info': '' }, run.info));
  if (run.retry && !run.result && !run.inDoubt && (st === 'stopped' || st === 'attention')) {
    card.append(h('div', { class: 'sx-actions' }, btn('다시 시도', () => act.again(run), 'sx-btn-primary', { 'data-act': 'retry' })));
  }
  // 단추는 한 줄에 오른쪽으로(기준판): [중지]는 그 카드 마지막 단추 줄 끝에, 줄이 없으면 혼자 한 줄.
  if (card.stopBtn) {
    const last = card.lastElementChild?.classList.contains('sx-actions') ? card.lastElementChild : null;
    if (last) last.append(card.stopBtn);
    else card.append(h('div', { class: 'sx-actions' }, card.stopBtn));
  }
  return card;
}

/**
 * 수정세금계산서 카드(ADR-058 결정 5, 캔버스 "수정세금계산서 화면" PC 1~3). 계산서가 여럿이면 먼저 고르고, 사유 여섯 줄(두 묶음)을 고르면
 * 그 사유에서 홈택스가 사람에게 묻는 값만 줄로 보인다. 값은 누르면 그 자리에서 고친다. 금액 세 칸은 서로 따라 바뀐다(main이 계산).
 */
export function amendCard(run, act) {
  const v = run.amend.view;
  const card = h('section', { class: 'sx-card sx-amend', 'data-run': run.id, 'data-status': 'draft', 'data-amend': v.stage });
  const domAppend = card.append.bind(card);
  card.append = (...kids) => domAppend(...kids.filter((k) => k != null && k !== false));
  const hd = h('div', { class: 'sx-card-hd' }, cardTitle(run));
  const kv = (label, value, attrs = {}) => h('div', { class: 'sx-amend-kv', ...attrs }, h('span', { class: 'k' }, label), value instanceof Node ? value : h('span', { class: 'v' }, value));
  const original = v.original ? kv('원래 계산서', `${md(v.original.date)}, ${won(v.original.total)}`, { 'data-amend-original': '' }) : null;
  if (v.stage === 'which') {
    card.append(
      hd,
      h('p', { class: 'sx-amend-q' }, '어느 계산서인가요?'),
      h(
        'div',
        { class: 'sx-replies', role: 'group', 'data-amend-which': '' },
        ...v.which.map((x, i) =>
          h('button', { type: 'button', class: 'sx-reply', 'data-act': 'amend-pick', onclick: () => act.amendPick(run.id, i) }, h('span', { class: 'sx-amend-pick' }, h('span', {}, md(x.date)), h('span', { class: 'sx-amend-it' }, x.item)), h('span', { class: 'sx-amend-amt' }, won(x.total))),
        ),
      ),
    );
    return card;
  }
  if (v.stage === 'what') {
    card.append(
      hd,
      original,
      h('p', { class: 'sx-amend-q' }, '사유를 골라 주세요'),
      h(
        'div',
        { class: 'sx-amend-groups', 'data-amend-what': '' },
        ...v.groups.map((g) => h('div', { class: 'sx-replies', role: 'group' }, ...g.map((x) => h('button', { type: 'button', class: 'sx-reply', 'data-act': 'amend-what', 'data-what': x.what, onclick: () => act.amendWhat(run.id, x.what) }, h('span', {}, x.label))))),
      ),
    );
    return card;
  }
  const editing = act.amendEdit?.id === run.id ? act.amendEdit.field : null;
  const editor = (field, value, kind) => {
    const input = kind === 'date' ? dateInput({ name: field, value, compact: true }) : kind === 'biz' ? bizNoInput({ name: field, value, compact: true }) : kind === 'amount' ? amountInput({ name: field, value, required: false, compact: true }) : textInput({ name: field, value, max: LIMITS.item, compact: true });
    let done = false;
    const save = () => {
      if (done) return;
      done = true;
      act.amendSave(run.id, field, input.value);
    };
    const cancel = () => {
      if (done) return;
      done = true;
      act.amendEditOff(run.id);
    };
    input.addEventListener('keydown', keys(save, cancel));
    input.addEventListener('blur', save);
    // 금액은 치는 동안 나머지 두 칸이 그 자리에서 따라 바뀐다(저장은 칸을 벗어날 때 한 번)
    if (kind === 'amount') input.addEventListener('input', () => act.amendPreview(run.id, field, input.value));
    input.classList.add('sx-amend-input');
    setTimeout(() => (input.focus(), input.select?.()), 0);
    return input;
  };
  const RAW = { issueDate: run.amend.values?.issueDate ?? '', counterpartBizNo: run.amend.values?.counterpartBizNo ?? '', item: run.amend.values?.item ?? '' };
  const KIND = { issueDate: 'date', counterpartBizNo: 'biz', item: 'text' };
  const rows = v.rows.map((r) =>
    kv(
      r.label,
      editing === r.field
        ? editor(r.field, RAW[r.field], KIND[r.field])
        : r.edit
          ? h('button', { type: 'button', class: 'v sx-amend-val', 'data-act': 'amend-edit', 'data-field': r.field, 'aria-label': `${r.label}: ${r.value}. 눌러서 고치기`, onclick: () => act.amendEditOn(run.id, r.field) }, r.value)
          : h('span', { class: 'v' }, r.value),
      { 'data-amend-row': r.field },
    ),
  );
  const amounts = v.amounts
    ? h(
        'div',
        { class: 'sx-amend-amts', 'data-amend-amounts': '' },
        ...v.amounts.map((a) =>
          h(
            'div',
            { class: 'sx-amend-amount', 'data-amount': a.field },
            kv(a.label, h('span', { class: 'sx-amend-old' }, `기존 ${won(a.before)}`)),
            editing === a.field
              ? editor(a.field, String(a.after), 'amount')
              : h('button', { type: 'button', class: 'sx-amend-field', 'data-act': 'amend-edit', 'data-field': a.field, 'aria-label': `${a.label}: ${won(a.after)}. 눌러서 고치기`, onclick: () => act.amendEditOn(run.id, a.field) }, won(a.after)),
          ),
        ),
      )
    : null;
  const first = v.amounts?.[0]?.field ?? v.rows.find((r) => r.edit)?.field ?? null;
  card.append(
    hd,
    h(
      'div',
      { class: 'sx-amend-rows' },
      original,
      kv('사유', h('button', { type: 'button', class: 'v is-pick sx-amend-tap', 'data-act': 'amend-repick', 'aria-haspopup': 'dialog', 'aria-label': `사유: ${v.label}. 눌러서 바꾸기`, onclick: () => act.amendMenuToggle(run.id) }, v.label, icon('chevronRight')), { 'data-amend-row': 'what' }),
      ...rows,
      amounts,
    ),
    v.notice ? h('div', { 'data-amend-notice': '' }, note(v.notice, true, null, 'warn')) : null,
    h(
      'div',
      { class: 'sx-actions sx-amend-acts' },
      btn('발급하기', () => act.prepare(run.id), 'sx-btn-primary', { 'data-act': 'prepare', disabled: !v.ready || !!editing }),
      btn('수정', () => (first ? act.amendEditOn(run.id, first) : act.amendMenuToggle(run.id)), '', { 'data-act': 'amend-modify' }),
    ),
  );
  return card;
}

/** 사유 바꾸기(기준판 "폰 사유 고르기"의 PC 모달): 두 묶음 여섯 줄과 아래 한 줄, 지금 사유에 체크. 줄을 누르면 바로 바뀌고 닫힌다. */
export function amendWhatModal(run, act) {
  const v = run.amend.view;
  const cur = run.amend.what;
  const groups = v.groups.map((g, i) => ({ label: v.groupLabels[i], items: g.map((x) => ({ value: x.what, label: x.label, hint: x.hint })) }));
  const pick = (what) => (act.amendMenuToggle(null), what !== cur && act.amendWhat(run.id, what));
  return pickModal({ title: '왜 고치나요?', id: 'amend-what', onClose: () => act.amendMenuToggle(null), attrs: { 'data-amend-menu': '' } }, ...pickList(groups, cur, pick));
}

const sentSet = (sent) => new Set(Array.isArray(sent) ? sent.filter((x) => typeof x === 'string') : []);
export const modelRow = (sent) => {
  const s = sentSet(sent);
  if (s.has('openrouter_demo')) return ['AI', '시연용 외부 AI, 채팅 문장과 가상 거래처 이름만 보냄'];
  if (s.has('gateway.decide')) return ['AI', '이름/번호를 가린 요청 문장만 보냄'];
  return null;
};
export const serverRow = (sent) => {
  const s = sentSet(sent);
  const parts = [s.has('gateway.run_tokens') ? '실행 허가 받기(문장 없음)' : null, s.has('gateway.decide') ? '이름/번호를 가린 요청 문장' : null, s.has('gateway.respond') ? '이름/번호를 가린 대화 문장(짧은 답)' : null].filter(Boolean);
  return parts.length ? ['우리 서버', parts.join(', ')] : null;
};
export const modelCell = (sent) => {
  const s = sentSet(sent);
  return s.has('openrouter_demo') ? '시연용 AI' : s.has('gateway.decide') ? '우리 서버' : null;
};

export function batchCard(runs, act) {
  const live = (r) => ['preparing', 'turn', 'waiting', 'issuing'].includes(r.status);
  const done = runs.filter((r) => r.status === 'done').length;
  const total = runs.reduce((n, r) => n + (r.discarded ? 0 : Number(r.total) || 0), 0);
  const focus = runs.find(live) ?? runs.find((r) => r.status === 'draft' && !r.discarded) ?? null;
  const approved = runs.some((r) => r.batch?.approved);
  const halted = runs.some((r) => r.batch?.halted);
  const ended = !focus;
  const extra = runs.filter((r) => r !== focus && !r.discarded && (r.status === 'attention' || (r.status === 'stopped' && (r.redo || r.browserClosed))));
  const inRow = new Set([...(focus && live(focus) ? [focus] : []), ...extra]);
  const rows = runs.map((r) =>
    inRow.has(r)
      ? h('li', { class: 'is-card', 'data-batch-row': r.id, 'data-status': shownStatus(r) }, taskCard(r, act))
      : h(
          'li',
          { 'data-batch-row': r.id, 'data-status': r.discarded ? 'discarded' : shownStatus(r), onclick: () => act.open(r.id) },
          h('span', { class: 'sx-batch-name' }, `${(r.batch?.index ?? 0) + 1}. ${r.counterparty.name}`),
          h('span', { class: 'sx-batch-amt' }, `${num(r.total)}원`),
          r.discarded ? chip('discarded') : chip(shownStatus(r)),
          r.result?.approvalNo ? h('span', { class: 'sx-batch-no' }, `승인번호 ${r.result.approvalNo}`) : null,
        ),
  );
  const lead = ended
    ? `${runs.length}건 중 ${done}건 발급했어요.`
    : halted
      ? `${done}건 발급하고 멈췄어요. 남은 건은 한 건씩 승인해요.`
      : approved
      ? '차례로 발급하고 있어요.'
      : `모두 ${num(total)}원. 한 번 승인하면 차례로 발급해요.`;
  return h(
    'article',
    { class: 'sx-card sx-batch', 'data-batch': runs[0].batch.id, 'data-done': done },
    h('div', { class: 'sx-card-hd' }, titleWithIcon(ended ? 'doneCircle' : 'doc', `세금계산서 ${runs.length}건, 차례로 발급`), h('span', { class: `sx-chip${ended ? ' is-done' : ''}` }, `${done}/${runs.length} 발급`)),
    h('p', { class: 'sx-meta' }, lead),
    h('ol', { class: 'sx-batch-list' }, rows),
    focus && !inRow.has(focus) ? taskCard(focus, act) : null,
  );
}

const DONE_MAIL_TEXT = { sent: '보냈어요', none: '보내지 않았어요' };

const mailState = (run) => (run.result.mailTo ? 'sent' : 'none');

export function whereRows(run) {
  if (run.cert) return [['홈택스', `${run.cert.name} 1건 발급`], ['보관', '이 PC 문서함'], modelRow(run.sent), serverRow(run.sent)];
  const to = run.result.mailTo;
  const mail = to ? ['메일', to] : null;
  return [['홈택스', '전자세금계산서 1건 발급'], mail, ['보관', '이 PC 문서함'], modelRow(run.sent), serverRow(run.sent)];
}
/** 발급 끝 카드의 [자세히]: 값만. 홈택스/보관/AI/서버 줄은 넣지 않는다(대표 11-23). */
export function doneRows(run) {
  if (run.cert) return [['서류', run.cert.name], ['사용 용도', run.cert.inputs.purpose || null], ['제출처', run.cert.inputs.submitTo || null]];
  return [['공급가', won(run.supply)], ['세액', won(run.tax)], ['품목', run.item || null], ['작성일자', run.writeDate || null], ['받는 메일', run.result.mailTo || null]];
}
const panelX = (act) => h('button', { type: 'button', class: 'panel-x', 'aria-label': '패널 닫기', onclick: act.closePanel }, icon('close'));

export function runPanel(run, act) {
  const st = run.status;
  const confirmed = run.confirmed;
  const r = run.result;
  const firstOnly = (text, on) => (on && st !== 'done' ? { flag: text } : {});
  const rows = run.cert
    ? [
        st === 'done' && r?.approvalNo ? ['접수번호', r.approvalNo, { mono: true }] : null,
        ['신청 사업자', act.supplier()],
        ['서류', run.cert.name],
        ['사용 용도', run.cert.inputs.purpose],
        ['제출처', run.cert.inputs.submitTo],
        ['발급 인증', run.auth],
      ]
    : [
        st === 'done' && r ? ['승인번호', r.approvalNo, { mono: true }] : null,
        run.amend ? ['사유', run.amend.view.label] : null,
        run.amend?.view.original ? ['원래 계산서', `${md(run.amend.view.original.date)}, ${won(run.amend.view.original.total)}`] : null,
        ['공급자', act.supplier()],
        ['공급받는자', run.counterparty.name, firstOnly('처음 거래', run.counterparty.first)],
        ['사업자번호', fmtBiz(run.counterparty.bizNo), { mono: true }],
        st === 'draft' && !run.amend ? ['부가세', run.vat === 'separate' ? '별도' : '포함'] : null,
        ['공급가', won(run.supply)],
        ['세액', won(run.tax)],
        ['품목', run.item || null],
        ['작성일자', run.writeDate],
        ['받는 이메일', run.email.value, firstOnly('처음 보내는 주소', run.email.first)],
        ['발급 인증', run.auth],
      ];
  const guessed = [run.vatGuessed ? '부가세' : null, run.itemGuessed ? '품목' : null].filter(Boolean);
  const source =
    st === 'done' && r
      ? (shown(r.doneAt) ? `${r.doneAt} 발급` : '발급')
      : confirmed
        ? joinShown('홈택스에서 다시 읽음', shown(run.createdAt) && `${run.createdAt} 요청`)
        : st === 'draft'
          ? `초안, ${guessed.length ? `추정 값 ${guessed.length}개, ` : ''}아직 아무것도 보내지 않았어요`
          : run.cert
            ? joinShown('요청 문장과 기본 용도/제출처로 채움', run.createdAt)
            : joinShown('요청 문장과 거래처 장부에서 채움', run.createdAt);
  const canStop = st === 'preparing' || st === 'waiting' || (st === 'turn' && (!!run.handoff || run.steps[4].state !== 'done'));
  const promise = st === 'preparing' ? '승인하기 전에는 아무것도 발급하지 않아요.' : st === 'issuing' ? '홈택스 발급목록에서 확인할 때까지 다시 발급하지 않아요.' : null;
  return h(
    'div',
    { class: 'panel-in', 'data-panel-run': run.id },
    h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, runTitle(run)), chip(shownStatus(run)), panelX(act)),
    run.cert ? null : amount(run.total, run.supply, run.tax, run.amend ? null : vatText(run)),
    st === 'attention' && run.inDoubt ? checkListGuide(run, act) : null,
    kv(rows),
    h('div', { class: 'sx-source' }, source),
    h('div', { class: 'sx-panel-sec' }, '실행 단계'),
    steps(runSteps(run)),
    promise ? line(promise, true) : null,
    canStop ? h('div', { class: 'sx-actions' }, btn('중지', () => act.stop(run.id), 'sx-btn-quiet', { 'data-act': 'panel-stop' })) : null,
    st === 'done' ? (run.result.noFile ? line(run.cert ? CERT_NO_FILE_TEXT : NO_FILE_TEXT, true) : h('div', { class: 'sx-actions' }, ...fileBtns(() => act.openRunDoc(run), () => act.openRunDoc(run, true), 'panel-'))) : null,
  );
}

export const BROWSER_STATUSES = ['preparing', 'turn', 'waiting', 'issuing'];
const parseUrl = (raw) => {
  const url = raw.replace(/^[a-z]+:\/\//i, '');
  const i = url.indexOf('/');
  const host = i < 0 ? url : url.slice(0, i);
  const rest = i < 0 ? '' : url.slice(i);
  return { secure: !!host && !/^(127\.0\.0\.1|localhost)(:|$)/.test(host), host, rest: rest === '/' ? '' : rest };
};
export function browserTabTitle(url) {
  const { host } = parseUrl(url ?? '');
  if (/(^|\.)hometax\.go\.kr$/.test(host)) return '국세청 홈택스';
  if (/^(127\.0\.0\.1|localhost)(:|$)/.test(host)) return '홈택스(시험 페이지)';
  return host || '홈택스';
}
export function browserUrlParts(url) {
  const u = parseUrl(url ?? '');
  return [u.host && u.secure ? icon('lock') : null, h('span', { class: 'bp-host' }, browserTabTitle(url))];
}
export function browserPane(run, url, big, act) {
  if (!BROWSER_STATUSES.includes(run.status) && !run.starting) return null;
  return h(
    'section',
    { class: 'bp', 'data-browser-pane': run.id, 'aria-label': '앱 안 브라우저' },
    act.browserDrag ? h('div', { class: 'bp-resize', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': '브라우저 폭 조절', title: '끌어서 폭 조절', onpointerdown: act.browserDrag }) : null,
    h(
      'div',
      { class: 'bp-bar' },
      h('div', { class: 'bp-url', id: 'browser-addr', role: 'status', 'aria-label': '지금 열린 사이트', title: url || '' }, ...browserUrlParts(url)),
      h('span', { class: 'bp-state', 'data-bp-state': 'loading', title: '이 화면을 직접 눌러 조작할 수 있어요. 인증서 비밀번호는 앱의 비밀번호 창에서 받아요.' }, '여는 중'),
      h('button', { type: 'button', class: 'bp-icon', 'data-act': 'browser-size', 'aria-pressed': String(big), title: big ? '브라우저 작게' : '브라우저 크게', 'aria-label': big ? '브라우저 작게' : '브라우저 크게', onclick: () => act.browserSize(!big) }, icon(big ? 'shrink' : 'expand')),
    ),
    h('div', { class: 'run-screen', 'data-run-screen': run.id }, h('p', { class: 'sx-meta bp-wait' }, h('i', { class: 'bp-wait-dot', 'aria-hidden': 'true' }), '홈택스 여는 중')),
  );
}

export function runDock(run, detail, open, onToggle) {
  const now = nowStep(run);
  const text = run.turn?.text ?? (verifying(run) ? verifyLine(run.verifyAttempt) : stepLine(now));
  detail.hidden = !open;
  const more = h('button', { type: 'button', class: 'sx-btn sx-btn-quiet bp-more', 'aria-expanded': String(open), 'data-act': 'dock-more' }, open ? '접기' : '자세히');
  more.onclick = () => {
    const o = detail.hidden;
    detail.hidden = !o;
    more.textContent = o ? '접기' : '자세히';
    more.setAttribute('aria-expanded', String(o));
    onToggle(o);
  };
  return h(
    'div',
    { class: `bp-dock${open ? ' is-open' : ''}`, 'data-bp-dock': run.id },
    h('div', { class: 'bp-dock-hd' }, h('div', { class: 'sx-card-title' }, runTitle(run)), text ? h('span', { class: 'bp-dock-now' }, text) : null, chip(shownStatus(run)), more),
    detail,
  );
}

function checkListGuide(run, act) {
  const c = (v) => () => act.copy(v);
  return h(
    'div',
    { class: 'sx-check', 'data-check-list': run.id },
    h('div', { class: 'sx-panel-sec' }, '홈택스에서 직접 확인'),
    note('홈택스 발급목록에서 아래 건을 찾아 주세요. 목록에 있으면 발급된 것이니 다시 발급하지 마세요.', !(run.attest?.note && run.attest.state !== 'sent')),
    kv(
      run.cert
        ? [
            ['발급일', run.writeDate, { copy: c(run.writeDate) }],
            ['서류', run.cert.name, { copy: c(run.cert.name) }],
            ['사용 용도', run.cert.inputs.purpose],
          ]
        : [
            ['작성일자', run.writeDate, { copy: c(run.writeDate) }],
            ['공급받는자', run.counterparty.name, { copy: c(run.counterparty.name) }],
            ['사업자번호', fmtBiz(run.counterparty.bizNo), { mono: true, copy: c(fmtBiz(run.counterparty.bizNo)) }],
            ['합계', won(run.total), { copy: c(String(run.total)) }],
          ],
    ),
    h('div', { class: 'sx-meta' }, '목록에 없다는 확인은 대화 아래에 뜨는 황토색 확인 카드로만 받아요. 확인한 뒤 다시 발급하려면 새로 승인해야 해요.'),
    run.attest?.note ? note(run.attest.note, run.attest.state !== 'sent') : null,
  );
}

/** 지난 대화의 발급 완료(데모 기록): 발급 카드 완료 모양과 같다(기준판 PC 부품 "발급 완료"). */
export function pastCard(p) {
  return h(
    'section',
    { class: 'sx-card' },
    h('div', { class: 'sx-card-hd' }, titleWithIcon('doneCircle', `${p.who} ${p.title} 발급 완료`)),
    h(
      'dl',
      { class: 'sx-kv is-split' },
      h('dt', {}, '승인번호'),
      h('dd', {}, h('span', { class: 'sx-val sx-id' }, p.approvalNo)),
      h('dt', {}, '받는 이메일'),
      h('dd', {}, '보냈어요'),
      h('dt', {}, '합계'),
      h('dd', { class: 'is-total' }, h('span', { class: 'sx-val' }, won(p.total))),
    ),
  );
}

export function summaryCard(s) {
  return h('section', { class: 'sx-card' }, h('div', { class: 'sx-card-hd' }, titleWithIcon(null, '등록 내용'), h('span', { class: 'sx-meta' }, '온보딩 요약')), kv(s.rows, true));
}

const EXPIRY_TAG = { document: '문서', rule: '추정', user: '확인함' };
export const expiryTag = (doc) => (doc.vault.needsUser ? '추정' : (EXPIRY_TAG[doc.vault.expirySource] ?? ''));

const docKind = (doc) => (doc.kind === doc.source ? doc.kind : `${doc.kind}, ${doc.source}`);

function docCells(doc, today) {
  const d = dday(doc.expiresOn, today);
  const v = doc.vault;
  const inferred = v && doc.expiresOn && (v.expirySource === 'rule' || v.needsUser);
  return h(
    'div',
    { class: 'sx-cells' },
    h('div', {}, h('span', { class: 'label sx-meta' }, '발급일'), h('span', { class: 'value' }, doc.issuedOn ? h('span', { class: 'doc-date' }, doc.issuedOn) : '—', doc.issuedOn && doc.issuedAt ? h('span', { class: 'doc-date doc-time' }, doc.issuedAt) : null)),
    h('div', {}, h('span', { class: 'label sx-meta' }, '용도'), h('span', { class: `value${doc.purpose ? '' : ' is-none'}` }, doc.purpose || '—')),
    h(
      'div',
      { class: inferred ? 'is-inferred' : v?.expirySource === 'user' ? 'is-verified' : null },
      h('span', { class: 'label sx-meta' }, '유효'),
      h('span', { class: `value sx-val${d !== null && d <= 7 ? ' is-attention' : ''}${d === null ? ' is-none' : ''}` }, ddayText(d)),
      doc.expiresOn ? h('span', { class: 'sx-tag' }, h('span', { class: 'doc-date' }, doc.expiresOn), v ? `, ${expiryTag(doc)}` : '') : null,
    ),
  );
}

export function docCard(doc, today) {
  return h(
    'section',
    { class: 'sx-card sx-doc', 'data-doc': doc.id },
    h('div', { class: 'sx-doc-kind' }, docKind(doc)),
    h('div', { class: 'sx-doc-name' }, doc.docName),
    docCells(doc, today),
  );
}

export function docPanel(doc, today, act, review) {
  return h(
    'div',
    { class: 'panel-in', 'data-panel-doc': doc.id },
    h('div', { class: 'doc-kind-row' }, h('span', { class: 'sx-doc-kind' }, docKind(doc)), panelX(act)),
    h('div', { class: 'doc-head' }, h('div', { class: 'sx-doc-name' }, doc.docName)),
    docCells(doc, today),
    review ?? [
      kv([
        ['프로필', doc.profile === 'business' ? '사업자' : '개인'],
      ]),
      doc.noFile ? h('p', { class: 'sx-body-sm is-muted', 'data-doc-nofile': '' }, doc.kind === '세금계산서' ? NO_FILE_TEXT : CERT_NO_FILE_TEXT) : h('div', { class: 'sx-actions' }, ...fileBtns(() => act.openDoc(doc.id), () => act.revealDoc(doc.id), 'doc-')),
    ],
  );
}

export function securityBox(st, ops, onOk) {
  const box = h('div', { class: 'sx-note is-attention onb-security', role: 'alert', 'data-security': st.state });
  const draw = (s) => {
    box.dataset.security = s.state;
    box.replaceChildren();
    if (s.state !== 'missing' && s.state !== 'stopped') {
      box.remove();
      onOk?.(s);
      return;
    }
    const missing = s.state === 'missing';
    const run = (fn) => async () => {
      try {
        const r = await fn();
        if (r && r.state) draw(r);
      } catch {
        /* 버튼만 다시 누르게 둔다 */
      }
    };
    const main = missing && s.installUrl ? btn('설치 파일 받기', run(async () => (await ops.install(), null)), 'sx-btn-primary', { 'data-act': 'security-install' }) : !missing && s.canStart ? btn('켜기', run(ops.start), 'sx-btn-primary', { 'data-act': 'security-start' }) : null;
    box.append(
      icon('warn'),
      h(
        'div',
        { class: 'sx-note-body' },
        h('b', { class: 'sx-note-title' }, missing ? `홈택스 인증서 프로그램(${s.name})이 없어요` : `홈택스 인증서 프로그램(${s.name})이 꺼져 있어요`),
        h('p', {}, missing ? '홈택스 로그인/서명에 필요해요. 홈택스 공식 설치 파일을 받아 설치한 뒤 [다시 확인]을 눌러 주세요.' : '이 프로그램을 켜야 홈택스가 이 PC의 인증서를 읽어요.'),
        h('div', { class: 'sx-actions' }, main, btn('다시 확인', run(ops.check), main ? 'sx-btn-quiet' : 'sx-btn-primary', { 'data-act': 'security-check' })),
      ),
    );
  };
  draw(st);
  return box;
}
