import { btn, h, icon } from './shell-views.js';

const ERR = {
  'account.email_shape': '이메일 형식이 아니에요',
  'account.code_shape': '6자리 숫자를 넣어 주세요',
  'account.code_invalid': '숫자가 맞지 않아요. 메일의 6자리를 다시 확인해 주세요',
  'account.code_locked': '여러 번 틀려서 이 숫자는 막혔어요. 숫자를 다시 받아 주세요',
  'account.code_expired': '시간이 지났어요. 숫자를 다시 받아 주세요',
  'account.aik_already_pinned': '이 계정에는 이미 PC가 등록돼 있어요. 다시 로그인하면 이어서 연결해요',
  'account.passkey_required': '이 계정은 패스키로 로그인해야 해요. 패스키 로그인은 곧 지원해요',
  'account.device_limit': '이 계정에는 PC가 3대 연결돼 있어요. 쓰던 PC의 설정 > 기기 연결에서 하나를 끊은 뒤 다시 로그인해 주세요',
  'account.key_changed': '다른 PC에서 이 계정에 새로 로그인했어요. 이메일로 다시 로그인하면 이어서 쓸 수 있어요',
  'account.link_rejected': '쓰던 PC에서 연결을 거절했어요. 다시 하려면 다시 로그인해 주세요',
  'account.link_expired': '시간이 지나 연결을 마치지 못했어요. 다시 로그인해 주세요',
  'account.link_mismatch': '쓰던 PC의 답이 맞지 않아 연결하지 않았어요. 다시 로그인해 주세요',
  'account.device_churn_limit': '최근에 PC를 여러 번 바꿨어요. 며칠 뒤에 다시 해 주세요',
  'account.keys_unavailable': '금고가 열려 있지 않아요. 앱을 다시 켠 뒤 해 주세요',
  'policy.rate_limited': '요청이 많아요. 잠시 뒤에 다시 해 주세요',
  gesture_required: '버튼을 다시 눌러 주세요',
  'account.confirm_click': '[확인]을 눌러 주세요',
  pair_unavailable: '이 빌드에서는 아직 폰을 연결할 수 없어요',
  run_active: '발급이 진행 중이라 지금은 로그아웃할 수 없어요. 끝난 뒤에 해 주세요.',
  account_required: '먼저 로그인해 주세요',
  busy: '처리 중이에요. 잠시만 기다려 주세요',
};
export const accountErrText = (code) => (code ? (ERR[code] ?? (code.startsWith('net.') ? '연결하지 못했어요. 인터넷 연결을 확인해 주세요' : '잠시 뒤에 다시 해 주세요')) : null);

export function accountCard(view, onLogin, pairRow, onSignOut) {
  const v = view ?? { step: 'unavailable' };
  const body =
    v.step === 'unavailable'
      ? [h('p', { class: 'sx-body-sm is-muted' }, '이 빌드에서는 아직 계정에 연결할 수 없어요.')]
      : v.step === 'signed_in'
        ? [
            h('p', { class: 'sx-body-sm', 'data-account-email': '' }, v.email),
            h('p', { class: 'sx-meta', 'data-account-phones': String(v.phones ?? 0) }, v.phones ? `이 PC가 계정에 등록됐어요. 연결된 폰 ${v.phones}대.` : '이 PC가 계정에 등록됐어요. 아직 연결된 폰이 없어요.'),
            v.pairable === false
              ? h('p', { class: 'sx-meta', 'data-pair-soon': '' }, '폰 앱은 곧 나와요. 나오면 여기서 폰을 연결할 수 있어요.')
              : pairRow(),
            onSignOut ? h('div', { class: 'sx-actions' }, btn('로그아웃', onSignOut, 'sx-btn-quiet', { 'data-act': 'account-signout' }), h('span', { class: 'sx-meta' }, '로그아웃하면 다시 로그인할 때까지 앱을 쓸 수 없어요.')) : null,
          ]
        : [h('p', { class: 'sx-body-sm is-muted' }, '폰을 연결하려면 먼저 로그인해 주세요. 메일로 받은 숫자 6자리로 들어가요.'), h('div', { class: 'sx-actions' }, btn('로그인', onLogin, 'sx-btn-primary', { 'data-act': 'account-login' }))];
  return h('div', { class: 'sx-card', 'data-account': v.step }, h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, '계정')), ...body);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const back = (label, onClick) => h('button', { type: 'button', class: 'acct-back', 'data-act': 'account-back', onclick: onClick }, icon('chevronLeft'), label);
const mark = () => h('span', { class: 'acct-mark', 'aria-hidden': 'true' }, 'ax');
const head = (title, sub, subAttrs) => h('div', { class: 'acct-head' }, h('h1', { class: 'title-screen', id: 'acct-title' }, title), sub ? h('p', { class: 'sx-body-sm', ...(subAttrs ?? {}) }, sub) : null);
const links = (...bs) => h('div', { class: 'acct-links' }, ...bs.flatMap((b, i) => (i ? [h('span', { class: 'acct-dot', 'aria-hidden': 'true' }, '/'), b] : [b])));
const quiet = (label, onClick, act) => btn(label, onClick, 'sx-btn-quiet', { 'data-act': act });
const primary = (label, onClick, act, busy) => btn(label, onClick, 'sx-btn-primary sx-btn-lg', { 'data-act': act, disabled: busy });

function codeField(ctx, busy, onFull, onChange = () => {}) {
  const { draft } = ctx;
  const code = (draft.code ?? '').replace(/\D/g, '').slice(0, 6);
  const cells = h('div', { class: 'acct-cells', 'aria-hidden': 'true' }, ...Array.from({ length: 6 }, (_, i) => h('span', { class: `acct-cell${i === Math.min(code.length, 5) ? ' is-at' : ''}` }, code[i] ?? '')));
  const i = h('input', { class: 'acct-code-in acct-code', inputmode: 'numeric', maxlength: 6, autocomplete: 'one-time-code', 'aria-label': '숫자 6자리', 'aria-describedby': 'acct-to' });
  i.value = code;
  i.addEventListener('input', () => {
    draft.code = i.value.replace(/\D/g, '').slice(0, 6);
    if (i.value !== draft.code) i.value = draft.code;
    cells.querySelectorAll('.acct-cell').forEach((c, k) => {
      c.textContent = draft.code[k] ?? '';
      c.classList.toggle('is-at', k === Math.min(draft.code.length, 5));
    });
    onChange(draft.code);
    if (draft.code.length === 6 && !busy) onFull(draft.code);
  });
  i.addEventListener('keydown', (e) => e.key === 'Enter' && !busy && onFull(draft.code ?? ''));
  return h('div', { class: 'acct-code-box' }, cells, i);
}

const codeFoot = (v, ctx, busy, resend) =>
  h('div', { class: 'acct-code-foot' }, v.codeExpiresAt ? h('span', { class: 'acct-left', 'data-acct-left': '' }, left(v.codeExpiresAt, ctx.now())) : null, quiet('다시 받기', () => !busy && resend(), 'account-resend'));

const left = (at, now) => {
  const s = Math.max(0, Math.round((at - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function loginScreen(ctx) {
  const { view: v, draft } = ctx;
  const err = v.error;
  const busy = ctx.busy || v.step === 'working';
  const email = () => (draft.email ?? '').trim();
  const input = (key, label, attrs, onEnter, cls = '') => {
    const i = h('input', { class: `acct-in acct-${key} ${cls}`, autocomplete: 'off', spellcheck: 'false', 'aria-label': label, ...attrs });
    i.value = draft[key] ?? '';
    i.addEventListener('input', () => (draft[key] = i.value));
    i.addEventListener('keydown', (e) => e.key === 'Enter' && onEnter());
    return i;
  };
  const errNote = (code) => (code ? h('p', { class: 'acct-err sx-body-sm', role: 'alert' }, icon('warn'), accountErrText(code)) : null);
  let screen = v.step.startsWith('link_') ? v.step : v.step === 'code_sent' ? 'code' : v.step === 'working' ? 'working' : 'email';
  let body;

  if (screen === 'link_wait' || screen === 'link_code' || screen === 'link_confirm') {
    const stop = quiet('그만두기', () => !busy && ctx.linkCancel(), 'account-link-cancel');
    if (screen === 'link_wait')
      body = [
        mark(),
        head('쓰던 PC에서 승인해 주세요', [h('b', { 'data-acct-to': '' }, v.email), ' 계정에 이미 연결된 PC가 있어요']),
        h(
          'div',
          { class: 'acct-stack' },
          h('div', { class: 'acct-box' }, h('p', { class: 'sx-body-sm' }, icon('pc'), '쓰던 PC에서 설정 > 기기 연결을 열어 주세요'), h('p', { class: 'sx-body-sm' }, icon('check'), "'새 PC 연결 요청'에서 [연결]을 눌러 주세요")),
          h('p', { class: 'sx-meta', 'data-link-waiting': '' }, '누르면 이 화면에 6자리가 떠요.'),
          links(stop),
        ),
      ];
    else if (screen === 'link_code')
      body = [
        mark(),
        head('쓰던 PC에 이 숫자를 넣어 주세요', '쓰던 PC의 기기 연결 화면에 6자리 칸이 떠 있어요'),
        h(
          'div',
          { class: 'acct-stack' },
          h('div', { class: 'acct-cells is-show', role: 'text', 'aria-label': `6자리 ${(v.linkCode ?? '').split('').join(' ')}`, 'data-link-code': '' }, ...Array.from({ length: 6 }, (_, i) => h('span', { class: 'acct-cell' }, v.linkCode?.[i] ?? ''))),
          h('p', { class: 'sx-meta' }, '다른 사람에게 알려 주지 마세요. 10분이 지나면 숫자가 바뀌어요.'),
          links(stop),
        ),
      ];
    else
      body = [
        mark(),
        head("쓰던 PC에 '연결됐어요'가 떴나요?", '떴을 때만 눌러 주세요. 안 떴으면 그만두고 다시 로그인해 주세요'),
        h('div', { class: 'acct-stack' }, primary('네, 떴어요', () => !busy && ctx.linkAccept(), 'account-link-accept', busy), errNote(err), links(stop)),
      ];
  } else if (screen === 'working') {
    body = [mark(), head('이 PC를 계정에 등록하고 있어요', '잠시만 기다려 주세요', { 'data-account-working': '' })];
  } else if (screen === 'email') {
    const send = () => {
      if (busy) return;
      if (!EMAIL_RE.test(email())) return ctx.fail('account.email_shape');
      ctx.sendCode(email());
    };
    body = [
      ctx.onClose ? back('닫기', ctx.onClose) : null,
      mark(),
      h('div', { class: 'acct-head', ...(ctx.gate ? { 'data-login-gate': '' } : {}) }, h('h1', { class: 'title-screen', id: 'acct-title' }, '이메일로 시작해요')),
      h(
        'div',
        { class: 'acct-stack' },
        input('email', '이메일', { type: 'email', maxlength: 254, inputmode: 'email', autocomplete: 'username' }, send),
        errNote(err),
        primary('숫자 받기', send, 'account-send', busy),
      ),
    ];
  } else {
    const verify = (code) => (/^\d{6}$/.test(code) ? ctx.verify(code) : ctx.fail('account.code_shape'));
    const ok = primary('확인', () => !busy && verify(draft.code ?? ''), 'account-verify', busy || !/^\d{6}$/.test(draft.code ?? ''));
    body = [
      back('뒤로', ctx.back),
      head('메일로 온 숫자 6자리', [h('b', { 'data-acct-to': '' }, v.email)], { id: 'acct-to' }),
      h(
        'div',
        { class: 'acct-stack' },
        codeField(ctx, busy, verify, (c) => (ok.disabled = busy || !/^\d{6}$/.test(c))),
        ok,
        errNote(err === 'gesture_required' ? 'account.confirm_click' : err),
        codeFoot(v, ctx, busy, () => ctx.sendCode(v.email)),
      ),
    ];
    screen = 'code';
  }
  return h(
    'section',
    { class: 'acct-screen', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'acct-title', 'data-account-login': v.step, 'data-acct-screen': screen },
    h('div', { class: 'acct-col' }, ...body),
  );
}
