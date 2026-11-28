import { bigWon, btn, detailHead, h, icon, kv, listGroup, listRow, monthStep, pageHero, pageTabs } from './shell-views.js';
import { actions, modal } from './shell-ui.js';

/*
 * 세무사 꾸러미 화면(D-05). 승인된 보드 "세무사 꾸러미: 10월"(캔버스 QKz6, 대표 승인 2026-11-28)대로:
 * 문서함 탭 줄(서류, 세무사 꾸러미)과 달 넘기기, 큰 글씨 한 줄과 확인할 것, 왼쪽 목록(엑셀 파일, 종이 증빙), 오른쪽 고른 것.
 * 줄에는 단추를 두지 않는다(금액 자리가 흔들리지 않게). 고치기와 빼기는 오른쪽 상세에 있다.
 */

const md = (d) => `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
const monthText = (m) => `${m.slice(0, 4)}년 ${Number(m.slice(5))}월`;
const addMonth = (m, n) => {
  const t = Number(m.slice(0, 4)) * 12 + Number(m.slice(5)) - 1 + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
};
const ERR = {
  pack_missing: '꾸러미를 다시 만들었어요. 한 번 더 눌러 주세요.',
  gesture_required: '버튼을 직접 눌러 주세요.',
  bad_format: '사진이나 PDF만 넣을 수 있어요.',
  format_mismatch: '사진이나 PDF만 넣을 수 있어요.',
  input_size: '15MB보다 작은 파일만 넣을 수 있어요.',
  receipt_not_found: '이미 빠진 증빙이에요.',
};
const KIND = { tax_invoice: '세금계산서', invoice: '계산서', receipt: '영수증' };
const DIR = { sales: '매출', purchase: '매입' };
/** 확인할 것: 줄과 상세의 한 줄 말, 고치기 단추 */
const CHECK = {
  amount: ['금액이 맞지 않아요', '금액 고치기'],
  day: ['작성일이 없어요', '작성일 넣기'],
  direction: ['내 사업자번호가 없어요', '매입 매출 고르기'],
  party: ['거래처를 못 읽었어요', '거래처 넣기'],
  unread: ['날짜와 금액이 없어요', '날짜와 금액 넣기'],
};
const digitsOf = (v) => String(v ?? '').replace(/\D/g, '');
const amountOf = (v) => (digitsOf(v) === '' ? null : Number(digitsOf(v)));

export function createPackScreen({ call, toast, rerender, errText, today, openDocs, waiting = () => null }) {
  const s = { month: null, data: null, busy: false, failed: false, sel: null, edit: null, ask: null, adding: false, saving: false, thumbs: new Map() };
  const thisMonth = () => today().slice(0, 7);

  async function make(month, sel = null) {
    s.month = month;
    s.busy = true;
    s.failed = false;
    if (sel) s.sel = sel;
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

  const load = (month) => make(month ?? s.month ?? addMonth(thisMonth(), -1));
  const pickMonth = (m) => {
    s.edit = null;
    s.sel = null;
    void make(m);
  };

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

  async function addPaper() {
    if (s.adding) return;
    s.adding = true;
    rerender();
    try {
      const r = await call('pack.paperAdd', { month: s.month });
      if (!r?.picked) return;
      if (r.duplicate) toast('이미 넣은 증빙이에요.');
      else if (r.month !== s.month) toast(`${Number(r.month.slice(5))}월 계산서라 ${Number(r.month.slice(5))}월 꾸러미에 넣었어요.`);
      s.edit = null;
      await make(r.month, r.docId);
    } catch (e) {
      toast(ERR[errText(e)] ?? '넣지 못했어요. 다시 눌러 주세요.');
    } finally {
      s.adding = false;
      rerender();
    }
  }

  // 고치기: 칸은 상세의 값 자리에 열린다. 단추 줄은 같은 자리에서 [저장하기] [그만두기]로 바뀐다
  function startEdit(x) {
    const other = x.direction === 'sales' ? x.buyer : x.supplier;
    s.edit = {
      docId: x.docId,
      kind: x.kind,
      direction: x.direction,
      day: x.day ?? '',
      name: x.name ?? '',
      supply: x.supply ?? (x.kind === 'receipt' ? null : x.amount),
      vat: x.kind === 'invoice' ? 0 : x.vat,
      amount: x.amount,
      parties: { supplier: x.supplier, buyer: x.buyer },
      approvalNo: x.approvalNo ?? null,
      other: other?.bizNo ?? null,
      tried: false,
    };
    rerender();
  }

  const editTotal = (e) => (e.kind === 'receipt' ? e.amount : e.supply === null ? null : e.supply + (e.kind === 'invoice' ? 0 : (e.vat ?? 0)));
  const editMissing = (e) => {
    const miss = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.day)) miss.push('day');
    if (e.kind === 'receipt') {
      if (e.amount === null) miss.push('amount');
    } else {
      if (!e.direction) miss.push('direction');
      if (e.supply === null) miss.push('supply');
      if (e.kind === 'tax_invoice' && e.vat === null) miss.push('vat');
    }
    return miss;
  };

  async function saveEdit() {
    const e = s.edit;
    if (!e || s.saving) return;
    if (editMissing(e).length) {
      e.tried = true;
      rerender();
      toast('빈 칸을 채워 주세요.');
      return;
    }
    s.saving = true;
    rerender();
    const party = e.direction === 'sales' ? e.parties.buyer : e.parties.supplier;
    const bizNo = digitsOf(party?.bizNo);
    try {
      await call('pack.paperSave', {
        docId: e.docId,
        kind: e.kind,
        day: e.day,
        name: e.name.trim() || null,
        bizNo: bizNo.length === 10 ? bizNo : null,
        amount: editTotal(e),
        direction: e.kind === 'receipt' ? null : e.direction,
        ...(e.kind === 'receipt' ? {} : { supply: e.supply, vat: e.kind === 'invoice' ? 0 : e.vat, approvalNo: e.approvalNo }),
      });
      s.edit = null;
      const m = e.day.slice(0, 7);
      if (m !== s.month) toast(`${Number(m.slice(5))}월 꾸러미로 옮겼어요.`);
      await make(m, e.docId);
    } catch (err) {
      toast(ERR[errText(err)] ?? '저장하지 못했어요. 값을 확인해 주세요.');
    } finally {
      s.saving = false;
      rerender();
    }
  }

  async function remove() {
    const id = s.ask;
    s.ask = null;
    rerender();
    try {
      await call('pack.paperRemove', { docId: id });
      s.thumbs.delete(id);
      s.sel = null;
      s.edit = null;
      toast('꾸러미에서 뺐어요.');
      await make(s.month);
    } catch (e) {
      toast(ERR[errText(e)] ?? '빼지 못했어요. 다시 눌러 주세요.');
    }
  }

  function thumb(x) {
    if (!x.image) return null;
    if (!s.thumbs.has(x.docId)) {
      s.thumbs.set(x.docId, undefined);
      call('pack.paperThumb', { docId: x.docId }).then(
        (r) => (s.thumbs.set(x.docId, r?.src ?? null), rerender()),
        () => (s.thumbs.set(x.docId, null), rerender()),
      );
    }
    const src = s.thumbs.get(x.docId);
    if (src === null) return null;
    return h('div', { class: 'pk-photo', role: 'img', 'aria-label': `${x.name ?? KIND[x.kind]} 원본 사진`, 'data-pack-photo': x.docId }, src ? h('img', { src, alt: '' }) : null);
  }

  // 목록 줄
  const bankSub = (b, m) => {
    const mm = Number(m.slice(5));
    if (b.full) return [`${mm}월 전부`];
    if (!b.coverTo) return [[`${mm}월 거래내역이 없어요`, 'attention']];
    const d = Number(b.coverTo.slice(8));
    return [d === 1 ? `${mm}월 1일만` : `${mm}월 1일부터 ${d}일까지`, [`${d + 1}일부터 없어요`, 'attention']];
  };
  const evSub = (x) => [x.day ? md(x.day) : null, x.kind === 'receipt' ? KIND.receipt : `${KIND[x.kind]}${x.direction ? ` ${DIR[x.direction]}` : ''}`, x.check ? [CHECK[x.check][0], 'attention'] : null];
  const evName = (x) => x.name ?? KIND[x.kind];

  function rowsOf(d) {
    const excel = [
      ...d.bank.map((b) => ({ key: `bank:${b.who}`, kind: 'bank', b, name: `${b.who} 통장`, sub: bankSub(b, d.month), end: `${b.txns.toLocaleString('ko-KR')}건` })),
      d.payroll ? { key: 'payroll', kind: 'payroll', name: '급여대장', sub: [`${d.payroll.people}명`], end: bigWon(d.payroll.gross) } : null,
      d.cash ? { key: 'cash', kind: 'cash', name: '현금 매출', sub: [`${d.cash.days}일`], end: bigWon(d.cash.total) } : null,
    ].filter(Boolean);
    // 최근 것이 위(날짜 없는 것이 맨 위). 꾸러미 파일은 날짜 순이다
    const paper = [...d.evidence].sort((a, b) => (b.day ?? '9999').localeCompare(a.day ?? '9999')).map((x) => ({ key: x.docId, kind: 'evidence', x, name: evName(x), sub: evSub(x), end: x.amount === null ? '' : bigWon(x.amount) }));
    return { excel, paper };
  }

  function listPane(d, rows, sel) {
    const row = (r) => listRow({ name: r.name, sub: r.sub, end: r.end, on: sel?.key === r.key, onclick: () => s.sel !== r.key && ((s.sel = r.key), (s.edit = null), rerender()), attrs: { 'data-pack-row': r.kind } });
    return h(
      'div',
      { class: 'pg-list' },
      h(
        'div',
        { class: 'pg-list-hd' },
        h('h2', {}, '꾸러미에 든 것'),
        btn([icon('plus'), s.adding ? '읽는 중…' : '종이 증빙 올리기'], () => void addPaper(), '', { 'data-act': 'pack-paper-add', disabled: s.adding || s.busy }),
      ),
      h(
        'section',
        { class: 'pg-rows', 'aria-label': '꾸러미에 든 것', 'data-pack-files': String(d.files.length) },
        listGroup('엑셀 파일', `${rows.excel.length}개`, true),
        rows.excel.length ? rows.excel.map(row) : h('p', { class: 'pg-none' }, '없어요'),
        listGroup('종이 증빙', `${rows.paper.length}장`),
        rows.paper.length ? rows.paper.map(row) : h('p', { class: 'pg-none' }, '없어요'),
      ),
    );
  }

  const fileOf = (d, part) => d.entries.find((e) => e.name.includes(part))?.name ?? null;

  function excelDetail(d, r) {
    if (r.kind === 'bank') {
      const sub = bankSub(r.b, d.month);
      return [
        detailHead(r.name, r.end, sub[1] ? sub[1][0] : r.b.full ? null : sub[0][0], !r.b.full),
        kv([['받은 기간', r.b.coverTo ? sub[0] : null], ['파일', r.b.txns ? fileOf(d, r.b.who.replace(/[\\/:*?"<>|]/g, ' ')) : null]]),
      ];
    }
    if (r.kind === 'payroll') return [detailHead(r.name, r.end, null), kv([['사람', `${d.payroll.people}명`], ['파일', fileOf(d, '급여대장')]])];
    return [detailHead(r.name, r.end, null), kv([['적은 날', `${d.cash.days}일`], ['파일', fileOf(d, '현금 매출')]])];
  }

  function field(label, input, attrs = {}) {
    return h('label', { class: 'sx-field', ...attrs }, h('span', { class: 'sx-field-label' }, label), input);
  }

  function editForm(x) {
    const e = s.edit;
    const miss = e.tried ? editMissing(e) : [];
    const sumNode = h('span', { 'data-pack-sum': '' }, editTotal(e) === null ? '' : bigWon(editTotal(e)));
    const refreshSum = () => (sumNode.textContent = editTotal(e) === null ? '' : bigWon(editTotal(e)));
    const input = (key, value, attrs, set) =>
      h('input', {
        class: `sx-field-input${attrs.amount ? ' is-amount' : ''}`,
        value: value ?? '',
        'aria-invalid': miss.includes(key) ? 'true' : null,
        'data-field': key,
        ...attrs.html,
        oninput: (ev) => {
          set(ev.target.value);
          refreshSum();
        },
      });
    const money = (key) =>
      input(key, e[key] === null ? '' : e[key].toLocaleString('ko-KR'), { amount: true, html: { inputmode: 'numeric', autocomplete: 'off' } }, (v) => {
        e[key] = amountOf(v);
      });
    const seg = (label, opts, cur, set) =>
      h('div', { class: 'sx-seg', role: 'group', 'aria-label': label }, ...opts.map(([k, t]) => h('button', { type: 'button', class: cur === k ? 'is-on' : null, 'aria-pressed': String(cur === k), 'data-seg': k, onclick: () => cur !== k && (set(k), rerender()) }, t)));
    const isPaper = e.kind !== 'receipt';
    const otherLabel = e.direction === 'sales' ? '공급받는자' : '공급자';
    return h(
      'div',
      { class: 'pg-form', 'data-pack-edit': x.docId },
      seg('종류', [['tax_invoice', '세금계산서'], ['invoice', '계산서'], ['receipt', '영수증']], e.kind, (k) => {
        e.kind = k;
        if (k === 'invoice') e.vat = 0;
        if (k === 'receipt' && e.amount === null) e.amount = editTotal({ ...e, kind: 'tax_invoice' });
      }),
      isPaper
        ? seg('매입 매출', [['purchase', '매입'], ['sales', '매출']], e.direction, (k) => {
            e.direction = k;
            const p = k === 'sales' ? e.parties.buyer : e.parties.supplier;
            if (p?.name) e.name = p.name;
          })
        : null,
      field(isPaper ? '작성일' : '날짜', input('day', e.day, { html: { type: 'date', max: today() } }, (v) => (e.day = v))),
      field(isPaper ? otherLabel : '가게', input('name', e.name, { html: { maxlength: '100', autocomplete: 'off' } }, (v) => (e.name = v))),
      isPaper ? field('공급가액', money('supply')) : field('금액', money('amount')),
      isPaper && e.kind === 'tax_invoice' ? field('세액', money('vat')) : null,
      isPaper ? h('div', { class: 'pg-form-sum' }, h('span', {}, '합계'), sumNode) : null,
    );
  }

  function evidenceDetail(x) {
    const editing = s.edit?.docId === x.docId;
    const label = x.check ? CHECK[x.check][1] : '고치기';
    const other = x.direction === 'sales' ? '공급받는자' : '공급자';
    const acts = editing
      ? h('div', { class: 'pg-acts' }, btn(s.saving ? '저장하는 중' : '저장하기', () => void saveEdit(), 'sx-btn-primary', { 'data-act': 'pack-edit-save', disabled: s.saving }), btn('그만두기', () => ((s.edit = null), rerender()), 'sx-btn-quiet', { 'data-act': 'pack-edit-cancel' }))
      : h('div', { class: 'pg-acts' }, btn(label, () => startEdit(x), x.check ? 'sx-btn-primary' : '', { 'data-act': 'pack-edit' }), btn('꾸러미에서 빼기', () => ((s.ask = x.docId), rerender()), 'sx-btn-quiet', { 'data-act': 'pack-remove' }));
    const values =
      x.kind === 'receipt'
        ? kv([['날짜', x.day ? md(x.day) : null], ['가게', x.name], ['금액', x.amount === null ? null : bigWon(x.amount), { state: x.check ? 'attention' : null }]])
        : kv([
            ['작성일', x.day ? md(x.day) : null, { state: x.check === 'day' ? 'attention' : null }],
            [other, x.name, { state: x.check === 'party' ? 'attention' : null }],
            ['공급가액', x.supply === null ? null : bigWon(x.supply)],
            ['세액', x.kind === 'tax_invoice' && x.vat !== null ? bigWon(x.vat) : null],
            ['합계', x.amount === null ? null : bigWon(x.amount), { state: x.check === 'amount' ? 'attention' : null }],
          ]);
    return [detailHead(evName(x), x.amount === null ? null : bigWon(x.amount), x.check ? CHECK[x.check][0] : null, !!x.check), acts, thumb(x), editing ? editForm(x) : values];
  }

  function body(d) {
    const rows = rowsOf(d);
    const all = [...rows.excel, ...rows.paper];
    const sel = all.find((r) => r.key === s.sel) ?? rows.paper.find((r) => r.x.check) ?? rows.paper[0] ?? all[0] ?? null;
    if (s.edit && s.edit.docId !== sel?.key) s.edit = null;
    const empty = !all.length;
    return [
      pageHero(
        empty ? '아직 담을 것이 없어요' : d.gaps.length ? '거의 다 모였어요' : '다 모였어요',
        [d.gaps.length ? ['확인할 것', `${d.gaps.length}건`, 'attention'] : ['확인할 것', '없어요']],
        btn('세무사에게 보내기', () => fileAct('pack.share', d.month), 'sx-btn-primary', { 'data-act': 'pack-share' }),
        btn('폴더 열기', () => fileAct('pack.reveal', d.month), '', { 'data-act': 'pack-reveal' }),
      ),
      h(
        'div',
        { class: 'pg-split' },
        listPane(d, rows, sel),
        h('section', { class: 'pg-detail', 'aria-label': sel ? sel.name : '고른 것', 'data-pack-detail': sel?.kind ?? '' }, sel ? (sel.kind === 'evidence' ? evidenceDetail(sel.x) : excelDetail(d, sel)) : null),
      ),
    ];
  }

  function view() {
    if (!s.month) s.month = addMonth(thisMonth(), -1);
    const d = s.data?.month === s.month ? s.data : null;
    const first = addMonth(thisMonth(), -11);
    const prev = s.month > first ? addMonth(s.month, -1) : null;
    const next = s.month < thisMonth() ? addMonth(s.month, 1) : null;
    const step = monthStep(
      monthText(s.month),
      prev ? { label: `${Number(prev.slice(5))}월 꾸러미 보기`, onclick: () => pickMonth(prev) } : null,
      next ? { label: `${Number(next.slice(5))}월 꾸러미 보기`, onclick: () => pickMonth(next) } : null,
      'pack-month',
    );
    return h(
      'section',
      { class: 'rail-screen pg-screen', 'data-view': 'bundle', 'data-screen': 'D-05', 'data-pack': d ? d.month : '' },
      h(
        'div',
        { class: 'pg-col' },
        pageTabs([['docs', '서류'], ['bundle', '세무사 꾸러미']], 'bundle', () => openDocs(), waiting(), step),
        s.failed
          ? pageHero('꾸러미를 만들지 못했어요', [], btn('다시 만들기', () => make(s.month), 'sx-btn-primary', { 'data-act': 'pack-retry' }))
          : d
            ? body(d)
            : pageHero('꾸러미를 만들고 있어요', []),
      ),
    );
  }

  /** 빼기 확인. 원본 파일까지 지우므로 묻는다 */
  function removeModal() {
    const x = s.data?.evidence.find((e) => e.docId === s.ask);
    if (!x) return null;
    return modal({
      id: 'pack-remove',
      title: '꾸러미에서 뺄까요?',
      body: ['원본 사진도 이 PC에서 지워요.'],
      acts: actions(btn('빼기', () => void remove(), 'sx-btn-primary sx-btn-lg', { 'data-act': 'pack-remove-confirm' }), btn('그대로 두기', () => ((s.ask = null), rerender()), 'sx-btn-lg', { 'data-act': 'pack-remove-cancel' })),
      onClose: () => ((s.ask = null), rerender()),
      attrs: { 'data-pack-remove': x.docId },
    });
  }

  function chatCard(d, openScreen) {
    s.data = d;
    s.month = d.month;
    return h(
      'article',
      { class: 'sx-card', 'data-pack-chat': d.month },
      h('div', { class: 'sx-card-hd' }, h('div', { class: 'sx-card-title' }, `${d.label} 세무사 꾸러미`), h('span', { class: 'sx-meta' }, d.gaps.length ? `확인할 것 ${d.gaps.length}건` : '확인할 것 없음')),
      kv([['파일', `${d.files.length}개`]]),
      h(
        'div',
        { class: 'sx-actions' },
        btn('꾸러미 열기', () => openScreen(d.month), 'sx-btn-primary', { 'data-act': 'pack-open' }),
        btn('세무사에게 보내기', () => fileAct('pack.share', d.month), '', { 'data-act': 'pack-share' }),
      ),
    );
  }

  return {
    view,
    load,
    chatCard,
    select: (month) => (s.month = month),
    modalOpen: () => !!s.ask,
    modal: removeModal,
    close: () => ((s.ask = null), rerender()),
  };
}
