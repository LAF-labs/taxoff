import { btn, h, kv, note, noteGroup } from './shell-views.js';

const md = (d) => (d ? `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일` : '날짜 모름');
const GAP_LABEL = { paper_check: '종이 계산서 값 확인 필요' };
const ERR = { pack_missing: '꾸러미를 다시 만들었어요. 한 번 더 눌러 주세요.', gesture_required: '버튼을 직접 눌러 주세요.' };

function months(today) {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const last = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
  return [
    ['last', last, `지난달 (${Number(last.slice(5))}월)`],
    ['this', today.slice(0, 7), `이번 달 (${m}월)`],
  ];
}

function gapLines(d) {
  const by = new Map();
  const lines = [];
  for (const g of d.gaps) {
    if (g.kind === 'bank_short') lines.push({ kind: g.kind, text: `${g.who} 통장은 ${g.day ? `${md(g.day)}까지만` : `${d.label} 거래내역을 못`} 받았어요` });
    else by.set(g.kind, [...(by.get(g.kind) ?? []), g]);
  }
  for (const [kind, list] of by) {
    const who = list.filter((g) => g.who).map((g) => `${g.who} ${md(g.day)}`);
    lines.push({ kind, text: `${GAP_LABEL[kind]} ${list.length}건`, who: who.slice(0, 3).join(', ') + (who.length > 3 ? ` 외 ${who.length - 3}건` : '') });
  }
  return lines;
}

const madeText = (iso) => {
  const t = new Date(iso);
  const h24 = t.getHours();
  return `${h24 < 12 ? '오전' : '오후'} ${h24 % 12 || 12}시 ${t.getMinutes() ? `${t.getMinutes()}분` : ''}`.trim();
};

export function createPackScreen({ call, toast, rerender, errText, today, railHead, listTable }) {
  const s = { month: null, data: null, busy: false, failed: false };

  async function make(month) {
    s.month = month;
    s.busy = true;
    s.failed = false;
    rerender();
    try {
      const r = await call('pack.make', { month });
      if (s.month === month) s.data = r;
    } catch {
      if (s.month === month) {
        s.failed = true;
        s.data = null;
      }
    } finally {
      if (s.month === month) s.busy = false;
      rerender();
    }
  }

  const load = (month) => make(month ?? s.month ?? months(today())[0][1]);

  async function fileAct(method, month) {
    try {
      const r = await call(method, { month });
      if (method === 'pack.share' && r?.via === 'folder') toast('파일을 보여 드렸어요. 메일에 붙여 보내 주세요.');
    } catch (e) {
      const c = errText(e);
      if (c === 'pack_missing') await make(month);
      toast(ERR[c] ?? '열지 못했어요. 다시 눌러 주세요.');
    }
  }
  const actions = (d) =>
    h(
      'div',
      { class: 'sx-actions' },
      btn('보내기', () => fileAct('pack.share', d.month), 'sx-btn-primary', { 'data-act': 'pack-share' }),
      btn('Finder에서 보기', () => fileAct('pack.reveal', d.month), '', { 'data-act': 'pack-reveal' }),
    );

  const fileList = (d) =>
    listTable(
      [['파일'], ['든 것', 'num']],
      d.entries.map((e) => h('tr', { 'data-pack-file': e.kind }, h('td', { class: 'name' }, e.name), h('td', { class: 'num' }, e.note))),
    );

  function gapsBox(d) {
    if (!d.gaps.length) return note('빠진 것이 없어요.', false, null, 'check');
    const lines = gapLines(d);
    return h(
      'div',
      { class: 'pack-gaps', 'data-pack-gaps': String(d.gaps.length) },
      noteGroup(lines.map((g) => [[g.text, g.who ? h('span', { class: 'sx-meta' }, `, ${g.who}`) : null], { 'data-gap': g.kind }]), false),
    );
  }

  function view() {
    const opts = months(today());
    if (!s.month) s.month = opts[0][1];
    const d = s.data?.month === s.month ? s.data : null;
    const tab = ([key, month, label]) =>
      h('button', { type: 'button', class: s.month === month ? 'is-on' : null, 'aria-pressed': String(s.month === month), 'data-pack-month': key, onclick: () => s.month !== month && make(month) }, label);
    const meta = d ? d.label : s.busy ? '만드는 중…' : null;
    return h(
      'section',
      { class: 'rail-screen', 'data-view': 'bundle', 'data-screen': 'D-05', 'data-pack': d ? d.month : '' },
      h(
        'div',
        { class: 'rs-col' },
        railHead('세무사 꾸러미', meta),
        h('div', { class: 'filters', role: 'group', 'aria-label': '기간' }, opts.map(tab)),
        s.failed ? note('꾸러미를 만들지 못했어요.', true, null, 'info') : null,
        s.failed ? h('div', { class: 'sx-actions' }, btn('다시 만들기', () => make(s.month), 'sx-btn-primary', { 'data-act': 'pack-retry' })) : null,
        !d && !s.failed ? h('p', { class: 'sx-meta' }, '꾸러미를 만들고 있어요…') : null,
        d ? packBody(d) : null,
      ),
    );
  }

  function packBody(d) {
    return [
      h(
        'article',
        { class: 'sx-card pack-card', 'data-pack-summary': '' },
        h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, d.zipName)),
        h('p', { class: 'sx-meta' }, `파일 ${d.files.length}개, ${madeText(d.madeAt)}에 만들었어요`),
        actions(d),
      ),
      h('div', { class: 'rs-sec', 'data-pack-files': String(d.entries.length) }, h('h2', { class: 'sx-card-title' }, '꾸러미에 든 것'), fileList(d)),
      h('div', { class: 'rs-sec' }, h('h2', { class: 'sx-card-title' }, '빠진 것'), gapsBox(d)),
    ];
  }

  function chatCard(d, openScreen) {
    s.data = d;
    s.month = d.month;
    return h(
      'article',
      { class: 'sx-card pack-card', 'data-pack-chat': d.month },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${d.label} 세무사 꾸러미`), h('span', { class: 'sx-meta' }, d.gaps.length ? `빠진 것 ${d.gaps.length}건` : '빠진 것 없음')),
      kv([['파일', `${d.files.length}개`]]),
      h(
        'div',
        { class: 'sx-actions' },
        btn('꾸러미 열기', () => openScreen(d.month), 'sx-btn-primary', { 'data-act': 'pack-open' }),
        btn('보내기', () => fileAct('pack.share', d.month), '', { 'data-act': 'pack-share' }),
      ),
    );
  }

  return { view, load, chatCard, select: (month) => (s.month = month) };
}
