// 월 리포트(ADR-068) 화면: 달 넘기기, 기간(1, 3, 6개월, 1년), 매출 매입 통장, 달마다 막대, 거래처와 품목 순위, 통장 갈래, 계좌 잔액.
// 값은 main이 엔진 리포트 조회(db.query.bank.report)로 준 것을 그대로 그린다. 합계와 판정은 엔진 몫이다.
// 장부가 바뀌면(ledger 알림) 지금 보는 달과 기간으로 다시 읽는다. 사장님이 [새로고침]을 누를 일이 없게 한다(결정 5, 6).
// 마우스를 올리거나 키보드로 옮기면 자세한 값(sx-tip)을 띄운다(결정 12). PDF는 main이 같은 값으로 그린다(결정 11).
import { btn, emptyState, h, icon, kv, num } from './shell-views.js';
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

export function createReportScreen({ call, toast, rerender, errText, goBank, goAuth }) {
  const s = { month: null, months: 1, data: null, busy: false, failed: false, side: { partners: 'sale', items: 'sale' }, saved: null, saving: false, syncing: false, sync: null, needPassword: false, modal: null, seq: 0 };

  async function loadSync() {
    const r = await call('bank.reportSyncState', {}).catch(() => null);
    if (!r) return;
    s.sync = r.sync;
    s.needPassword = r.needPassword === true;
    rerender();
  }

  function onSync(p) {
    const ended = s.sync && !p;
    s.sync = p;
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

  const stopSync = () => call('bank.reportStop', {}).catch(() => toast('멈추지 못했어요. 다시 눌러 주세요.'));

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
      ? `${missing.join(', ')}${missing.at(-1) === '통장' ? '은' : '는'} 아직 몰라요`
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

  const prevLabel = (d) => (d.months === 1 ? '지난달보다' : d.months === 12 ? '지난해보다' : `앞 ${d.months}개월보다`);
  const change = (cur, prev) => {
    if (cur.amount === null || !prev.amount) return null;
    const diff = cur.amount - prev.amount;
    return diff === 0 ? '같아요' : `${won(Math.abs(diff))} ${diff > 0 ? '늘었어요' : '줄었어요'}`;
  };

  function sideCard(title, d, total, prev, parts) {
    const shown = parts.filter(([, l]) => l && known(l) && (l.amount !== 0 || l === parts[0][1]));
    const rows = shown.length === 1 && shown[0][2] !== undefined
      ? [[shown[0][0], `${num(shown[0][2])}건`]]
      : shown.map(([label, l, count]) => [count === undefined ? label : `${label} ${num(count)}건`, won(l.amount)]);
    return card(title, kv([[period(d), amountText(total), { total: true }], ...rows, [prevLabel(d), change(total, prev)]]));
  }

  function salesCard(d) {
    const split = d.partners.sale.split;
    const count = split ? split.ledger.count + split.outside.count : undefined;
    const el = sideCard('매출', d, d.sales.total, d.prev.sales, [
      ['세금계산서', d.sales.invoices, count],
      ['카드 매출', d.sales.cardSales],
      ['현금영수증', d.sales.cashReceipts],
      ['현금 매출', d.sales.cashSales],
    ]);
    const inv = el.querySelectorAll('dd')[1];
    if (inv && split && split.outside.count)
      hover(inv, () =>
        tipBox(`${period(d)} 매출 세금계산서`, [
          [`앱에서 발급 ${num(split.ledger.count)}건`, won(split.ledger.amount)],
          [`앱 밖에서 발급 ${num(split.outside.count)}건`, won(split.outside.amount)],
        ]),
      'is-below');
    return el;
  }

  const purchaseCard = (d) =>
    sideCard('매입', d, d.purchase.total, d.prev.purchase, [
      ['세금계산서', d.purchase.invoices, d.partners.purchase.top.reduce((n, x) => n + x.count, 0) + (d.partners.purchase.rest?.count ?? 0)],
      ['사업용 카드', d.purchase.card],
      ['현금영수증', d.purchase.cashReceipts],
      ['영수증', d.purchase.receipts],
      ['급여', d.purchase.payroll],
    ]);

  function receivableCard(d) {
    const r = d.receivable;
    return card(
      '받을 돈',
      kv([
        ['남은 돈', won(r.left), { total: true }],
        ['받은 돈', won(r.received)],
        r.late.count ? ['기한 지남', `${num(r.late.count)}건 ${won(r.late.amount)}`, { state: 'late' }] : null,
      ]),
      h('div', { class: 'sx-actions' }, btn('받을 돈 보기', goBank, '', { 'data-act': 'report-receivables' })),
    );
  }

  function vatCard(d) {
    const v = d.vat;
    const due = v.sale !== null && v.purchase !== null ? v.sale - v.purchase : null;
    const span = `${monthNo(v.from)}월부터 ${monthNo(v.to)}월`;
    return card(
      `부가세 ${v.half}기`,
      kv([
        ['매출 부가세', v.sale === null ? '확인 못 함' : won(v.sale), v.sale === null ? { state: 'unknown' } : {}],
        due === null ? [span, `${num(v.saleCount)}건`] : null,
        v.purchase !== null ? ['매입 세금계산서 부가세', won(v.purchase)] : null,
        due !== null ? ['세금계산서 기준 낼 부가세', won(due), { total: true }] : null,
        ['신고 기한', md(v.deadline)],
      ]),
    );
  }

  function money(d) {
    const p = hasPurchase(d);
    return h('div', { class: p ? 'rp-grid2' : 'rp-grid3' }, salesCard(d), p ? purchaseCard(d) : null, receivableCard(d), vatCard(d));
  }

  const manwon = (v) => `${Math.round(v / 10_000).toLocaleString('en-US')}만원`;

  function chart(d) {
    const withPurchase = d.series.some((m) => m.purchase.total.amount);
    const max = Math.max(1, ...d.series.flatMap((m) => [m.sales.total.amount ?? 0, withPurchase ? (m.purchase.total.amount ?? 0) : 0]));
    const hgt = (v) => `${Math.max(v ? 2 : 0, Math.round(((v ?? 0) / max) * 140))}px`;
    const half = d.series.length / 2;
    const tipRows = (m) => {
      const L = (label, l) => (known(l) && l.amount ? [label, won(l.amount)] : null);
      return [
        ['매출', amountText(m.sales.total), true],
        L('세금계산서', m.sales.invoices),
        L('현금영수증', m.sales.cashReceipts),
        L('카드 매출', m.sales.cardSales),
        L('현금 매출', m.sales.cashSales),
        ...(withPurchase
          ? [['매입', amountText(m.purchase.total), true], L('세금계산서', m.purchase.invoices), L('사업용 카드', m.purchase.card), L('현금영수증', m.purchase.cashReceipts), L('영수증', m.purchase.receipts), L('급여', m.purchase.payroll)]
          : []),
      ].filter(Boolean);
    };
    const cur = d.series.at(-1);
    const label = `${monthNo(d.series[0].month)}월부터 ${monthNo(cur.month)}월까지 달마다 매출${withPurchase ? '과 매입' : ''}. ${monthNo(cur.month)}월 매출 ${amountText(cur.sales.total)}`;
    return card(
      withPurchase ? '달마다' : '달마다 매출',
      withPurchase ? h('div', { class: 'rp-legend' }, h('span', {}, h('i'), '매출'), h('span', {}, h('i', { class: 'is-b' }), '매입')) : null,
      h(
        'div',
        { class: 'rp-chart', role: 'img', 'aria-label': label },
        ...d.series.map((m, i) => {
          const on = m.month === d.month;
          return hover(
            h(
              'div',
              { class: `rp-col ${on ? 'is-on' : m.inWindow ? '' : 'is-out'}`.trim(), 'data-month': m.month },
              on && m.sales.total.amount ? h('span', { class: 'rp-amt' }, manwon(m.sales.total.amount)) : null,
              h('div', { class: 'rp-bars' }, sized(h('i'), 'height', hgt(m.sales.total.amount)), withPurchase ? sized(h('i', { class: 'is-b' }), 'height', hgt(m.purchase.total.amount)) : null),
              h('span', { class: 'm' }, `${monthNo(m.month)}월`),
            ),
            () => tipBox(`${monthNo(m.month)}월`, tipRows(m)),
            i >= half ? 'is-left' : 'is-right',
          );
        }),
      ),
    );
  }

  const pct = (share) => `${Math.round(share * 100)}%`;
  const seg = (key, label) =>
    h('div', { class: 'sx-seg rp-seg', role: 'group', 'aria-label': label }, ...[['sale', '매출'], ['purchase', '매입']].map(([v, t]) => h('button', { type: 'button', class: s.side[key] === v ? 'is-on' : null, 'aria-pressed': String(s.side[key] === v), 'data-side': v, onclick: () => ((s.side[key] = v), rerender()) }, t)));

  function rankCard(d, key, saleTitle, bothTitle, cols, cells, empty, allAct) {
    const both = hasPurchaseRank(d);
    const side = both ? s.side[key] : 'sale';
    const r = d[key][side];
    const rows = r.top.map((x) => h('tr', { 'data-key': x.key }, ...cells(x, side)));
    if (r.rest) rows.push(h('tr', { class: 'is-rest' }, ...cells({ ...r.rest, name: `그 밖에 ${num(r.rest.n)}${key === 'partners' ? '곳' : '개'}`, late: 0 }, side)));
    return card(
      both ? bothTitle : saleTitle,
      both ? seg(key, `${bothTitle} 기준`) : null,
      rows.length ? listTableEl(cols(side), rows) : h('p', { class: 'sx-body-sm is-muted' }, empty),
      r.rest ? h('div', { class: 'sx-actions' }, btn('전체 보기', () => open({ kind: 'all', what: key, side, q: '' }), '', { 'data-act': allAct })) : null,
    );
  }

  const partners = (d) =>
    rankCard(
      d, 'partners', '많이 판 거래처', '거래처',
      (side) => [['거래처'], [side === 'sale' ? '매출' : '매입', 'num'], ['비율', 'num'], [side === 'sale' ? '남은 돈' : '낼 돈', 'num']],
      (x) => [
        h('td', { class: 'name' }, x.name ?? '이름 없음'),
        h('td', { class: 'num' }, num(x.amount)),
        h('td', { class: 'num' }, pct(x.share)),
        h('td', { class: `num${x.late ? ' is-late' : ''}` }, num(x.remaining ?? 0)),
      ],
      '이 기간 거래처가 없어요', 'report-partners-all',
    );

  const items = (d) =>
    rankCard(
      d, 'items', '많이 판 품목', '품목',
      (side) => [['품목'], ['건수', 'num'], [side === 'sale' ? '매출' : '매입', 'num'], ['비율', 'num']],
      (x) => [h('td', { class: 'name' }, x.name ?? '품목 없음'), h('td', { class: 'num' }, num(x.count)), h('td', { class: 'num' }, num(x.amount)), h('td', { class: 'num' }, pct(x.share))],
      '이 기간 품목이 없어요', 'report-items-all',
    );

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
      card('통장에서 나간 돈', lines('out', OUT)),
      card('통장에 들어온 돈', lines('in', IN)),
      card('계좌 잔액', kv([...acc.map((a) => [`${a.bank} ${a.last4}`, a.balance === null ? '확인 못 함' : won(a.balance), a.balance === null ? { state: 'unknown' } : {}]), ['잔액 합계', d.balance.total === null ? '확인 못 함' : won(d.balance.total), { total: true, ...(d.balance.partial || d.balance.total === null ? { state: 'unknown' } : {}) }]])),
    );
  }

  const neverFetched = (d) => d.notes.some((n) => n.kind === 'hometax_stale' && !n.lastAt);

  function firstPage() {
    const p = s.sync;
    if (p)
      return h(
        'div',
        { class: 'rp-first', 'data-report-first': 'receiving', role: 'status' },
        h('p', { class: 'empty-title' }, '홈택스 자료를 받는 중이에요'),
        h('p', { class: 'empty-sub' }, '다 받으면 리포트가 바로 보여요. 다른 일을 해도 돼요.'),
        syncBar(p),
        h('div', { class: 'rp-sync-line' }, h('span', {}, p.next ? syncItem(p.next) : '정리하는 중'), h('span', {}, syncCount(p))),
        btn('멈추기', stopSync, 'sx-btn-quiet', { 'data-act': 'report-stop' }),
      );
    return s.needPassword
      ? emptyState('홈택스 자료를 받으면 리포트가 보여요', '인증서 비밀번호를 저장해 두면 앱이 홈택스에 들어가 받아 와요.', btn('비밀번호 저장하기', goAuth, 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-password' }), { 'data-report-first': 'password' })
      : emptyState('홈택스 자료를 받으면 리포트가 보여요', '지난 12개월 매출과 매입을 홈택스에서 받아 와요. 처음엔 몇 분 걸려요.', btn('홈택스 자료 받기', syncNow, 'sx-btn-primary sx-btn-lg', { 'data-act': 'report-sync', disabled: s.syncing ? true : null }), { 'data-report-first': 'fetch' });
  }

  function syncStrip(p) {
    return h('div', { class: 'sx-note rp-sync', role: 'status', 'data-report-sync': '' }, h('div', { class: 'rp-sync-line' }, h('span', {}, `홈택스 자료 받는 중${p.next ? ` · ${syncItem(p.next)}` : ''}`), h('span', {}, syncCount(p))), syncBar(p));
  }

  function view() {
    const d = s.data;
    if (d && neverFetched(d)) return h('section', { class: 'rail-screen report-screen is-first', 'data-view': 'report', 'data-screen': 'ADR-068' }, h('div', { class: 'rs-col rp-col-main' }, firstPage()));
    const body = s.failed && !d
      ? [h('div', { class: 'sx-note is-attention', role: 'alert' }, icon('warn'), h('div', {}, '리포트를 불러오지 못했어요'), btn('다시 시도', load, '', { 'data-act': 'report-retry' }))]
      : !d
        ? [h('p', { class: 'sx-body-sm is-muted', 'aria-busy': 'true' }, '불러오는 중이에요')]
        : [s.sync ? syncStrip(s.sync) : null, ...notes(d), money(d), chart(d), h('div', { class: 'rp-grid2' }, partners(d), items(d)), bankCards(d)];
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
    modalOpen: () => !!s.modal,
    modal: () => (s.modal?.kind === 'all' ? allModal(s.modal) : s.modal?.kind === 'lines' ? linesModal(s.modal) : null),
    close,
  };
}
