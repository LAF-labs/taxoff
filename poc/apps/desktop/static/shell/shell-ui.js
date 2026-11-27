import { h, icon } from './shell-views.js';

/** 단추 줄: 첫 인자가 주요 단추다. 순서는 인자 자리로 정해져 뒤집어 쓸 수 없다(PC는 오른쪽에 붙는다) */
export const actions = (primary, ...rest) => h('div', { class: 'modal-acts' }, primary, ...rest);

export const isModalBackdrop = (target) => target.classList?.contains('modal-scrim');

function frame(attrs, blur, trap, ...body) {
  const dialog = h('section', { 'aria-modal': 'true', ...attrs, class: ['modal sx-modal', attrs.class].filter(Boolean).join(' ') }, ...body);
  if (trap) {
    dialog.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll('button, input')].filter((x) => !x.disabled);
      if (!items.length) return;
      const at = items.indexOf(document.activeElement);
      const last = items.length - 1;
      const next = e.shiftKey ? (at <= 0 ? items[last] : null) : at === last || at < 0 ? items[0] : null;
      if (!next) return;
      e.preventDefault();
      next.focus();
    });
  }
  return h('div', { class: blur ? 'modal-scrim is-blur' : 'modal-scrim' }, dialog);
}

const heading = (id, title, onClose, subtitle) =>
  h(
    'div',
    { class: subtitle ? 'modal-hd has-subtitle' : 'modal-hd' },
    subtitle ? h('div', { class: 'modal-title' }, h('h2', { class: 'title-screen', id: `${id}-title` }, title), subtitle) : h('h2', { class: 'title-screen modal-title', id: `${id}-title` }, title),
    onClose ? h('button', { type: 'button', class: 'panel-x', 'aria-label': '닫기', 'data-act': `${id}-close`, onclick: onClose }, icon('close')) : null,
  );

/**
 * 확인 모달: 딤 위 가운데 면, 머리 줄은 제목과 닫기 단추, 본문 한 단락, 단추 줄.
 * 바깥 누르기와 Esc는 shell.js dismissModal이 같은 onClose로 보낸다.
 * @param {{ id: string, title: string, body?: (string|Node)[], acts: Node, onClose?: () => void, attrs?: Record<string, string|boolean|null>, subtitle?: Node, blur?: boolean, trap?: boolean }} o
 */
export function modal({ id, title, body, acts, onClose, attrs = {}, subtitle, blur, trap }) {
  return frame(
    { role: 'alertdialog', 'aria-labelledby': `${id}-title`, 'aria-describedby': `${id}-body`, ...attrs },
    blur,
    trap,
    heading(id, title, onClose, subtitle),
    body ? h('p', { class: 'modal-body', id: `${id}-body` }, ...body) : null,
    acts,
  );
}

/**
 * 고르기 모달: 확인 모달과 같은 면(폭 400)에 단추 줄 대신 고르기 목록(pickList)을 둔다. 줄을 누르면 고르고 닫힌다.
 * @param {{ id: string, title?: string, onClose?: () => void, attrs?: Record<string, string|boolean|null>, head?: Node, subtitle?: Node, blur?: boolean, trap?: boolean }} o
 */
export function pickModal({ id, title, onClose, attrs = {}, head, subtitle, blur, trap }, ...body) {
  return frame({ role: 'dialog', 'aria-labelledby': `${id}-title`, tabindex: '-1', ...attrs }, blur, trap, head ?? heading(id, title, onClose, subtitle), ...body);
}

/** 고르기 목록: 묶음 이름, 두 줄 글 줄, 고른 줄 끝 체크. 줄을 누르면 onPick(value). */
export function pickList(groups, cur, onPick) {
  return groups.map((g) =>
    h(
      'div',
      { class: 'pick-group' },
      g.label ? h('span', { class: 'pick-label' }, g.label) : null,
      h(
        'div',
        { class: 'pick-rows', role: 'radiogroup', 'aria-label': g.label ?? '' },
        ...g.items.map((x) =>
          h(
            'button',
            { type: 'button', class: 'pick-row', role: 'radio', 'aria-checked': String(x.value === cur), 'data-value': x.value, onclick: () => onPick(x.value) },
            h('span', { class: 'tx' }, h('span', { class: 't1' }, x.label), x.hint ? h('span', { class: 't3' }, x.hint) : null),
            x.value === cur ? icon('check') : null,
          ),
        ),
      ),
    ),
  );
}

/**
 * 목록 모달: 확인 모달과 같은 면을 넓게(is-lg) 쓴다. 머리 줄 아래 도구 줄(기준, 찾기), 목록, 맨 아래 주요 단추 하나.
 * 목록이 길면 목록만 스크롤된다. 바깥 누르기와 Esc는 shell.js dismissModal이 같은 onClose로 보낸다.
 * @param {{ id: string, title: string, onClose: () => void, tools?: Node[], body: Node, primary?: Node | null, footer?: Node, attrs?: Record<string, string> }} o
 */
export function listModal({ id, title, onClose, tools = [], body, primary = null, footer, attrs = {} }) {
  return pickModal(
    { id, title, onClose, attrs: { 'data-list-modal': id, ...attrs, class: ['is-lg', attrs.class].filter(Boolean).join(' ') } },
    tools.length ? h('div', { class: 'modal-tools' }, ...tools) : null,
    h('div', { class: 'modal-list' }, body),
    footer ?? (primary ? actions(primary) : null),
  );
}
