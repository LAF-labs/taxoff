// PC 잠금 화면(ADR-061, 승인 캔버스 PC 1~5). 잠기면 본체 창은 이 화면만 보인다.
import { btn, h, icon, replyOptions } from './shell-views.js';

const device = (v) => (v.phoneKind === 'ios' ? 'iPhone' : '폰');
const josa = (word, withBatchim, without) => {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 ? withBatchim : without;
};

const head = (title, sub) => h('div', { class: 'lk-stack' }, h('h1', { class: 'title-screen' }, title), sub ? h('p', { class: 'lk-sub' }, ...[sub].flat()) : null);
const mark = () => h('div', { class: 'lk-icon', 'aria-hidden': 'true' }, icon('lock'));
const dots = () => h('span', { class: 'sx-typing lk-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'));
const col = (...kids) => h('div', { class: 'lk-col' }, ...kids);
const wide = (label, onClick, kind, act, disabled) => btn(label, onClick, `${kind} sx-btn-lg lk-wide`, { 'data-act': act, disabled });
const textBtn = (label, onClick, act) => btn(label, onClick, 'sx-btn-quiet', { 'data-act': act });

/**
 * @param {object} v 잠금 상태(main LockView)
 * @param {{ openLocal: Function, askPhone: Function, step: Function, emailStart: Function, emailCode: Function, recovery: Function, now: () => number }} act
 */
export function lockScreen(v, act) {
  const other = v.email || v.recovery ? textBtn('다른 방법', () => act.step('other'), 'lock-other') : null;
  let body;
  if (v.step === 'phone')
    body = [mark(), head(`${device(v)}에서 열어 주세요`, h('span', { class: 'lk-sent' }, `${v.phone}에 보냈어요`, dots())), other];
  else if (v.step === 'quiet' || v.step === 'declined') {
    const declined = v.step === 'declined';
    const wait = declined && v.declinedUntil > act.now();
    body = [
      mark(),
      head(declined ? `${device(v)}에서 거절했어요` : `${device(v)}${josa(device(v), '이', '가')} 답하지 않아요`, declined ? (wait ? '5분 뒤에 다시 보낼 수 있어요' : null) : '폰이 인터넷에 연결돼 있으면 다시 보내 주세요'),
      col(wide('다시 보내기', () => act.askPhone(), 'sx-btn-primary', 'lock-resend', wait || v.busy)),
      other,
    ];
  } else if (v.step === 'other')
    body = [
      head('어떻게 열까요?'),
      replyOptions(
        [
          v.email ? { label: [h('b', {}, '이메일로 열기'), h('span', {}, '메일로 온 숫자 6자리를 넣어요')], act: 'lock-email', lock: false, onPick: () => act.emailStart() } : null,
          v.recovery ? { label: [h('b', {}, '복구 코드로 열기'), h('span', {}, '적어 둔 코드를 넣어요')], act: 'lock-recovery', lock: false, onPick: () => act.recovery() } : null,
        ].filter(Boolean),
        { class: 'sx-replies lk-replies' },
      ),
      textBtn('뒤로', () => act.step('start'), 'lock-back'),
    ];
  else if (v.step === 'email_code')
    body = [
      head('메일로 온 숫자 6자리', v.email),
      codeCells(v, act),
      v.wrong ? h('p', { class: 'acct-err sx-body-sm', role: 'alert' }, icon('warn'), v.wrong === 'paused' ? '여러 번 틀려서 1시간 동안 막혔어요' : '숫자가 맞지 않아요') : null,
      h('div', { class: 'lk-links' }, textBtn('다시 받기', () => act.emailStart(), 'lock-email-again'), textBtn('뒤로', () => act.step('other'), 'lock-back')),
    ];
  else
    body = [
      mark(),
      head('잠겨 있어요'),
      col(v.local ? wide(`${v.local}로 열기`, () => act.openLocal(), 'sx-btn-primary', 'lock-local', v.busy) : null, v.phone ? wide('폰으로 열기', () => act.askPhone(), v.local ? '' : 'sx-btn-primary', 'lock-phone', v.busy) : null),
      other,
    ];
  return h('div', { class: 'lk-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': '잠금', 'data-lock': v.step }, h('div', { class: 'lk-bar' }, '택스오프'), h('div', { class: 'lk-center' }, ...body));
}

function codeCells(v, act) {
  let code = '';
  const cells = h('div', { class: 'acct-cells lk-cells', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, (_, i) => h('span', { class: `acct-cell${i === 0 ? ' is-at' : ''}` })));
  const input = h('input', { class: 'acct-code-in lock-code', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', 'aria-label': '숫자 6자리' });
  input.addEventListener('input', () => {
    code = input.value.replace(/\D/g, '').slice(0, 6);
    if (input.value !== code) input.value = code;
    cells.querySelectorAll('.acct-cell').forEach((c, k) => {
      c.textContent = code[k] ?? '';
      c.classList.toggle('is-at', k === Math.min(code.length, 5));
    });
    if (code.length === 6 && !v.busy) act.emailCode(code);
  });
  return h('div', { class: 'acct-code-box lk-code' }, cells, input);
}

const sw = (on, label, onToggle, act, disabled) => h('button', { type: 'button', class: 'sx-switch', role: 'switch', 'aria-checked': String(!!on), 'aria-label': label, 'data-act': act, disabled, onclick: () => onToggle(!on) });
const row = (attrs, ico, name, sub, ...acts) =>
  h('div', { class: 'auth-row dev-row lk-row', ...attrs }, ico ? h('span', { class: 'lk-row-ic', 'aria-hidden': 'true' }, icon(ico)) : null, h('span', { class: 'opt-main' }, h('span', { class: 'auth-name' }, name), sub ? h('span', { class: 'sx-meta' }, sub) : null), ...acts);
const group = (title, ...rows) => h('article', { class: 'sx-card dev-group' }, h('div', { class: 'sx-card-hd' }, h('h2', { class: 'sx-card-title' }, title)), h('div', { class: 'dev-rows' }, ...rows));

/**
 * 설정 > 잠금(캔버스 PC 9). 이 PC를 여는 기기와 폰이 없을 때의 길을 켜고 끈다.
 * @param {object|null} s main LockSettingsView
 * @param {{ lockNow: Function, setLocal: Function, setPhone: Function, setEmail: Function, makeRecovery: Function, busy: boolean }} act
 */
export function lockSettings(s, act) {
  const intro = h('div', { class: 'set-intro lk-intro' }, h('h2', { class: 'sx-card-title' }, '잠금'), btn('지금 잠그기', () => act.lockNow(), 'sx-btn-quiet', { 'data-act': 'lock-now' }));
  if (!s) return h('div', { class: 'set-body', 'data-lock-settings': '' }, intro);
  const openers = [
    s.local ? row({ 'data-lock-local': '' }, 'pc', `이 ${s.local.name === 'Touch ID' ? 'Mac' : 'PC'}`, s.local.name, sw(s.local.on, `이 PC ${s.local.name}로 열기`, (on) => act.setLocal(on), 'lock-local-switch', act.busy)) : null,
    ...s.phones.map((p) => row({ 'data-lock-phone': p.pairId }, 'phone', p.name, p.kind, sw(p.on, `${p.name}으로 열기`, (on) => act.setPhone(p.pairId, on), 'lock-phone-switch', act.busy))),
  ].filter(Boolean);
  const fallback = [
    s.email === null ? null : row({ 'data-lock-email': '' }, null, '이메일로 열기', null, sw(s.email, '이메일로 열기', (on) => act.setEmail(on), 'lock-email-switch', act.busy)),
    s.recovery === null ? null : row({ 'data-lock-recovery': '' }, null, '복구 코드', s.recovery ? '만들어 뒀어요' : null, btn(s.recovery ? '다시 만들기' : '만들기', () => act.makeRecovery(), s.recovery ? '' : 'sx-btn-primary', { 'data-act': 'lock-recovery-make', disabled: act.busy })),
  ].filter(Boolean);
  return h('div', { class: 'set-body', 'data-lock-settings': '' }, intro, openers.length ? group('이 PC를 여는 기기', ...openers) : null, fallback.length ? group('폰이 없을 때', ...fallback) : null);
}
