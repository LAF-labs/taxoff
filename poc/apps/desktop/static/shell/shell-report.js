// 월 리포트(ADR-068) 화면: 달 넘기기, 기간(1, 3, 6개월, 1년), 매출 매입 통장, 달마다 막대, 거래처와 품목 순위, 통장 갈래, 계좌 잔액.
// 값은 main이 엔진 리포트 조회(db.query.bank.report)로 준 것을 그대로 그린다. 합계와 판정은 엔진 몫이다.
// 장부가 바뀌면(ledger 알림) 지금 보는 달과 기간으로 다시 읽는다. 사장님이 [새로고침]을 누를 일이 없게 한다(결정 5, 6).
// 마우스를 올리거나 키보드로 옮기면 자세한 값(sx-tip)을 띄운다(결정 12). PDF는 main이 같은 값으로 그린다(결정 11).
import { btn, h, icon, kv, note, num } from './shell-views.js';
import { selectInput, textInput } from './fields.js';
import { listModal } from './shell-ui.js';

const won = (n) => `${num(n)}원`;
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

const monthNo = (m) => Number(m.slice(5, 7));
const shift = (month, d) => {
  const [y, m] = month.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1 + d, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`;
};
const md = (iso) => `${monthNo(iso)}월 ${Number(iso.slice(8, 10))}일`;
/** 말풍선과 모달 제목의 기간 글: "11월", "9월부터 11월" */
const span = (month, months) => (months === 1 ? `${monthNo(month)}월` : `${monthNo(shift(month, 1 - months))}월부터 ${monthNo(month)}월`);
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
const amountText = (l) => (l.amount === null ? '확인 못 함' : won(l.amount));
const valOpts = (l) => (l.amount === null || l.partial ? { state: 'unknown' } : {});

export function createReportScreen({ call, toast, rerender, errText, goBank }) {
  const s = { month: null, months: 1, data: null, busy: false, failed: false, side: { partners: 'sale', items: 'sale' }, saved: null, saving: false, syncing: false, modal: null, seq: 0 };

  async function load() {
    const seq = ++s.seq;
    s.busy = !s.data;
    s.failed = false;
    try {
      const r = await call('bank.report', s.month ? { month: s.month, months: s.months } : { months: s.months });
      if (seq !== s.seq) return;
      s.data = r;
      s.month = r.month;
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
    rerender();
    try {
      const r = await call('bank.reportSync', {});
      if (r?.result !== 'done' && r?.result !== 'not_due') toast(SYNC_ERR[r?.result] ?? SYNC_ERR.failed);
    } catch (e) {
      toast(ERR[errText(e)] ?? SYNC_ERR.failed);
    } finally {
      s.syncing = false;
      rerender();
      load();
    }
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
    const last = !today || month >= today.slice(0, 7);
    const step = (dir) => {
      const to = month ? shift(month, dir) : null;
      const off = !to || (dir > 0 && last);
      return h(
        'button',
        { type: 'button', class: 'sx-btn', 'data-act': dir < 0 ? 'report-prev' : 'report-next', 'aria-label': off ? (dir < 0 ? '이전 달 없음' : '다음 달 없음') : `${monthNo(to)}월 보기`, disabled: off ? true : null, onclick: () => pick({ month: to }) },
        icon(dir < 0 ? 'chevronLeft' : 'chevronRight'),
      );
    };
    return h(
      'div',
      { class: 'rp-head' },
      h('div', { class: 'rp-month' }, step(-1), h('span', { class: 't' }, month ? `${month.slice(0, 4)}년 ${monthNo(month)}월` : ''), step(1)),
      h(
        'div',
        { class: 'rp-head-r' },
        h('div', { class: 'sx-seg', role: 'group', 'aria-label': '기간' }, ...WINDOWS.map(([n, label]) => h('button', { type: 'button', class: s.months === n ? 'is-on' : null, 'aria-pressed': String(s.months === n), 'data-months': String(n), onclick: () => s.months !== n && pick({ months: n }) }, label))),
        btn(s.saving ? '저장하는 중' : 'PDF로 저장', savePdf, '', { 'data-act': 'report-pdf', disabled: s.saving || !d ? true : null }),
      ),
    );
  }

  function notes(d) {
    const out = [];
    for (const n of d.notes) {
      if (n.kind === 'no_accounts') out.push(h('div', { class: 'sx-note is-attention', 'data-note': 'no_accounts' }, icon('info'), h('div', {}, '계좌를 연결하면 통장 돈 흐름도 보여요'), btn('계좌 연결', goBank, '', { 'data-act': 'report-bank' })));
      if (n.kind === 'account_gap') out.push(note(`${n.bank} ${n.last4} 거래내역이 ${n.coverTo ? `${md(n.coverTo)}까지만 있어요` : '아직 없어요'}`, true, null, 'warn'));
      if (n.kind === 'hometax_stale')
        out.push(
          h(
            'div',
            { class: 'sx-note is-attention', 'data-note': 'hometax_stale' },
            icon('warn'),
            h('div', {}, n.lastAt ? `홈택스 자료를 받은 지 ${n.days}일 됐어요` : '홈택스 자료를 아직 받지 않았어요'),
            btn(s.syncing ? '받는 중' : '최신화', syncNow, '', { 'data-act': 'report-sync', disabled: s.syncing ? true : null }),
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

  function money(d) {
    const sales = d.sales;
    const pur = d.purchase;
    const salesKv = kv([
      ['세금계산서', amountText(sales.invoices), valOpts(sales.invoices)],
      ['현금영수증', amountText(sales.cashReceipts), valOpts(sales.cashReceipts)],
      ['카드 매출', amountText(sales.cardSales), valOpts(sales.cardSales)],
      sales.cashSales.amount !== null ? ['현금 매출', won(sales.cashSales.amount)] : null,
      ['합계', amountText(sales.total), { total: true, ...valOpts(sales.total) }],
    ]);
    const split = d.partners.sale.split;
    const inv = salesKv.querySelector('dd');
    if (inv && split && sales.invoices.amount !== null)
      hover(inv, () =>
        tipBox(`${period(d)} 매출 세금계산서`, [
          [`앱에서 발급 ${num(split.ledger.count)}건`, won(split.ledger.amount)],
          [`앱 밖에서 발급 ${num(split.outside.count)}건`, won(split.outside.amount)],
          [`합계 ${num(split.ledger.count + split.outside.count)}건`, won(split.ledger.amount + split.outside.amount), true],
        ]),
      'is-below');
    const purKv = kv([
      ['세금계산서', amountText(pur.invoices), valOpts(pur.invoices)],
      ['사업용 카드', amountText(pur.card), valOpts(pur.card)],
      ['현금영수증', amountText(pur.cashReceipts), valOpts(pur.cashReceipts)],
      pur.receipts.amount ? ['영수증', won(pur.receipts.amount)] : null,
      pur.payroll.amount !== null ? ['급여', won(pur.payroll.amount)] : null,
      ['합계', amountText(pur.total), { total: true, ...valOpts(pur.total) }],
    ]);
    const bankKv = d.bank.hasAccounts
      ? kv([
          ['들어온 돈', won(d.bank.in)],
          ['나간 돈', won(d.bank.out)],
          ['남은 돈', won(d.bank.net), { total: true }],
        ])
      : h('p', { class: 'sx-body-sm is-muted' }, '계좌 연결 전이에요');
    return h('div', { class: 'rp-grid3' }, card('매출', salesKv), card('매입', purKv), card('통장', bankKv));
  }

  function chart(d) {
    const max = Math.max(1, ...d.series.flatMap((m) => [m.sales.total.amount ?? 0, m.purchase.total.amount ?? 0]));
    const hgt = (v) => `${Math.max(v ? 2 : 0, Math.round(((v ?? 0) / max) * 140))}px`;
    const half = d.series.length / 2;
    const tipRows = (m) => {
      const L = (label, l, skip) => (skip ? null : [label, amountText(l)]);
      return [
        ['매출', amountText(m.sales.total), true],
        L('세금계산서', m.sales.invoices),
        L('현금영수증', m.sales.cashReceipts),
        L('카드 매출', m.sales.cardSales),
        L('현금 매출', m.sales.cashSales, m.sales.cashSales.amount === null),
        ['매입', amountText(m.purchase.total), true],
        L('세금계산서', m.purchase.invoices),
        L('사업용 카드', m.purchase.card),
        L('현금영수증', m.purchase.cashReceipts),
        L('영수증', m.purchase.receipts, !m.purchase.receipts.amount),
        L('급여', m.purchase.payroll, m.purchase.payroll.amount === null),
        ...(m.bank.hasAccounts
          ? [
              ['통장', '', true],
              ['들어온 돈', won(m.bank.in)],
              ['나간 돈', won(m.bank.out)],
              ['남은 돈', won(m.bank.net)],
            ]
          : []),
      ].filter(Boolean);
    };
    const cur = d.series.at(-1);
    const label = `${monthNo(d.series[0].month)}월부터 ${monthNo(cur.month)}월까지 달마다 매출과 매입. ${monthNo(cur.month)}월 매출 ${amountText(cur.sales.total)}, 매입 ${amountText(cur.purchase.total)}`;
    return card(
      '달마다',
      h('div', { class: 'rp-legend' }, h('span', {}, h('i'), '매출'), h('span', {}, h('i', { class: 'is-b' }), '매입')),
      h(
        'div',
        { class: 'rp-chart', role: 'img', 'aria-label': label },
        ...d.series.map((m, i) =>
          hover(
            h('div', { class: `rp-col ${m.month === d.month ? 'is-on' : m.inWindow ? '' : 'is-out'}`.trim(), 'data-month': m.month }, h('div', { class: 'rp-bars' }, sized(h('i'), 'height', hgt(m.sales.total.amount)), sized(h('i', { class: 'is-b' }), 'height', hgt(m.purchase.total.amount))), h('span', { class: 'm' }, `${monthNo(m.month)}월`)),
            () => tipBox(`${monthNo(m.month)}월`, tipRows(m)),
            i >= half ? 'is-left' : 'is-right',
          ),
        ),
      ),
    );
  }

  const bar = (share) => h('div', { class: 'sx-bar' }, sized(h('i'), 'width', `${Math.round(share * 100)}%`));
  const pct = (share) => `${Math.round(share * 100)}%`;
  const seg = (key, label) =>
    h('div', { class: 'sx-seg rp-seg', role: 'group', 'aria-label': label }, ...[['sale', '매출'], ['purchase', '매입']].map(([v, t]) => h('button', { type: 'button', class: s.side[key] === v ? 'is-on' : null, 'aria-pressed': String(s.side[key] === v), 'data-side': v, onclick: () => ((s.side[key] = v), rerender()) }, t)));

  function partners(d) {
    const side = s.side.partners;
    const r = d.partners[side];
    const rows = r.top.map((x) =>
      hover(
        h('div', { 'data-key': x.key }, h('span', { class: 'n' }, x.name ?? '이름 없음'), h('span', { class: 'a' }, won(x.amount)), h('span', { class: 'p' }, pct(x.share)), bar(x.share)),
        () =>
          tipBox(`${x.name ?? '이름 없음'} ${period(d)}`, [
            [`${side === 'sale' ? '매출' : '매입'} ${num(x.count)}건`, won(x.amount)],
            [side === 'sale' ? '받은 돈' : '낸 돈', won(x.settled ?? 0)],
            [side === 'sale' ? '남은 받을 돈' : '남은 낼 돈', won(x.remaining ?? 0), true],
          ]),
        'is-below',
      ),
    );
    if (r.rest) rows.push(h('div', { class: 'is-rest' }, h('span', { class: 'n' }, `그 밖에 ${r.rest.n}곳`), h('span', { class: 'a' }, won(r.rest.amount)), h('span', { class: 'p' }, pct(r.rest.share)), bar(r.rest.share)));
    return card(
      '거래처',
      seg('partners', '거래처 기준'),
      rows.length ? h('div', { class: 'rp-rank' }, ...rows) : h('p', { class: 'sx-body-sm is-muted' }, '이 기간 거래처가 없어요'),
      r.rest ? h('div', { class: 'sx-actions' }, btn('전체 보기', () => open({ kind: 'all', what: 'partners', side, q: '' }), '', { 'data-act': 'report-partners-all' })) : null,
    );
  }

  function items(d) {
    const side = s.side.items;
    const r = d.items[side];
    const rows = r.top.map((x) => h('div', {}, h('span', { class: 'n' }, x.name ?? '품목 없음'), h('span', { class: 'c' }, `${num(x.count)}건`), h('span', { class: 'a' }, won(x.amount)), bar(x.share)));
    if (r.rest) rows.push(h('div', { class: 'is-rest' }, h('span', { class: 'n' }, `그 밖에 ${r.rest.n}개`), h('span', { class: 'c' }, `${num(r.rest.count)}건`), h('span', { class: 'a' }, won(r.rest.amount)), bar(r.rest.share)));
    return card(
      '품목',
      seg('items', '품목 기준'),
      rows.length ? h('div', { class: 'rp-rank is-count' }, ...rows) : h('p', { class: 'sx-body-sm is-muted' }, '이 기간 품목이 없어요'),
      r.rest ? h('div', { class: 'sx-actions' }, btn('전체 보기', () => open({ kind: 'all', what: 'items', side, q: '' }), '', { 'data-act': 'report-items-all' })) : null,
    );
  }

  function bankCards(d) {
    if (!d.bank.hasAccounts) return null;
    const lines = (side, list) => {
      const shown = list.filter(([k]) => d.bankLines[side][k]?.amount);
      const el = kv([...shown.map(([k, label]) => [label, won(d.bankLines[side][k].amount)]), ['합계', won(side === 'out' ? d.bank.out : d.bank.in), { total: true }]]);
      // 갈래마다 값을 누르면 그 갈래를 이룬 거래를 본다
      el.querySelectorAll('dd:not(.is-total)').forEach((dd, i) => {
        const [k, label] = shown[i];
        dd.classList.add('is-pick');
        dd.setAttribute('role', 'button');
        dd.dataset.cat = k;
        dd.setAttribute('aria-label', `${label} 거래 보기`);
        dd.append(icon('chevronRight'));
        const go = () => open({ kind: 'lines', side, category: k, label, picks: {} });
        dd.tabIndex = 0;
        dd.addEventListener('click', go);
        dd.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
      });
      return el;
    };
    const acc = d.balance.accounts;
    return h(
      'div',
      { class: 'rp-grid3' },
      card('나간 돈', lines('out', OUT)),
      card('들어온 돈', lines('in', IN)),
      card('계좌', kv([...acc.map((a) => [`${a.bank} ${a.last4}`, a.balance === null ? '확인 못 함' : won(a.balance), a.balance === null ? { state: 'unknown' } : {}]), ['잔액 합계', d.balance.total === null ? '확인 못 함' : won(d.balance.total), { total: true, ...(d.balance.partial || d.balance.total === null ? { state: 'unknown' } : {}) }]])),
    );
  }

  function view() {
    const d = s.data;
    const body = s.failed && !d
      ? [h('div', { class: 'sx-note is-attention', role: 'alert' }, icon('warn'), h('div', {}, '리포트를 불러오지 못했어요'), btn('다시 시도', load, '', { 'data-act': 'report-retry' }))]
      : !d
        ? [h('p', { class: 'sx-body-sm is-muted', 'aria-busy': 'true' }, '불러오는 중이에요')]
        : [...notes(d), money(d), chart(d), h('div', { class: 'rp-grid2' }, partners(d), items(d)), bankCards(d)];
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
    reset: () => pick({ month: null }),
    modalOpen: () => !!s.modal,
    modal: () => (s.modal?.kind === 'all' ? allModal(s.modal) : s.modal?.kind === 'lines' ? linesModal(s.modal) : null),
    close,
  };
}
