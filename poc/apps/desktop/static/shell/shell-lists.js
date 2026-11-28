import { h, icon } from './shell-views.js';

const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
export const firstSound = (s) => {
  const c = s.charCodeAt(0) - 0xac00;
  return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : (s[0] ?? '').toUpperCase();
};

const digits = (s) => String(s ?? '').replace(/\D/g, '');

export function cpMatches(c, q) {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  const d = digits(t);
  return c.name.toLowerCase().includes(t) || c.rep.toLowerCase().includes(t) || (d.length >= 3 && (digits(c.bizNo).includes(d) || digits(c.phone).includes(d)));
}

const CP_STATE = { '01': ['계속사업자', ''], '02': ['휴업', 'is-attention'], '03': ['폐업', 'is-attention'] };
export function cpState(status) {
  const m = /(0[123])$/.exec(status ?? '');
  return m ? CP_STATE[m[1]] : ['확인 전', ''];
}

export function findBox({ value, placeholder, label, onInput, field }) {
  return h('label', { class: 'ls-find' }, icon('search'), h('input', { type: 'search', placeholder, 'aria-label': label, value, 'data-field': field, oninput: (e) => onInput(e.target.value) }));
}

export function sortMenu({ value, options, open, onToggle, onPick, name }) {
  const cur = options.find(([k]) => k === value) ?? options[0];
  return h(
    'div',
    { class: 'ls-pop', 'data-pop': name },
    h('button', { type: 'button', class: 'ls-sort', 'aria-haspopup': 'menu', 'aria-expanded': String(open), 'data-act': `${name}-open`, onclick: onToggle }, cur[1], icon('chevron')),
    open
      ? h(
          'div',
          { class: 'menu is-right', role: 'menu', 'aria-label': '정렬' },
          ...options.map(([k, label]) =>
            h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': String(k === value), class: 'menu-item', 'data-sort': k, onclick: () => onPick(k) }, h('span', { class: 'menu-check' }, k === value ? icon('check') : null), h('span', {}, label)),
          ),
        )
      : null,
  );
}

export function chipRow(items, on, onPick, label) {
  return h(
    'div',
    { class: 'ls-chips', role: 'group', 'aria-label': label },
    ...items.map(([k, text, n, cls]) => h('button', { type: 'button', class: [k === on ? 'is-on' : null, cls].filter(Boolean).join(' ') || null, 'aria-pressed': String(k === on), 'data-chip': k, onclick: () => onPick(k) }, text, h('span', {}, ` ${n}`))),
  );
}

const ISSUERS = [
  [/지방세/, '위택스'],
  [/중소기업확인서|소상공인확인서/, '중소벤처24'],
  [/주민등록|가족관계|건강보험/, '정부24'],
  [/등기사항|법인인감/, '인터넷등기소'],
];
const KNOWN_CERT = /증명|확인서|등본|초본|원부/;
const LOGO = { 홈택스: 'issuer-hometax.svg', 위택스: 'issuer-wetax.png' };

export function docIssuer(d) {
  const named = ISSUERS.find(([re]) => re.test(d.docName ?? d.name))?.[1];
  if (d.kind === '증명서') return named ?? '홈택스';
  return named ?? (KNOWN_CERT.test(d.docName ?? d.name) ? '홈택스' : null);
}

export function docMark(kind, issuer) {
  if (kind === 'tax') return h('span', { class: 'ls-mark is-icon', 'aria-hidden': 'true' }, icon('receipt'));
  if (!issuer) return h('span', { class: 'ls-mark is-icon', 'aria-hidden': 'true' }, icon('contract'));
  const logo = LOGO[issuer];
  return h('span', { class: 'ls-mark', 'aria-hidden': 'true' }, logo ? h('img', { src: logo, alt: '' }) : h('b', {}, issuer.slice(0, 3)));
}
