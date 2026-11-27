// 여러 건 발급 화면(ADR-059, 캔버스 "대량 발급 화면" PC 1~6): 입력창 파일 칩, 묶음 카드, 목록 모달, 승인 카드, 자세히 보기 모달.
// [승인하고 발급]은 main bulk.issue로 홈택스 발급을 시작한다. 홈택스가 읽은 값의 승인은 언제나 앱 승인 카드(별도 창)에서 한 번 더 받는다.
import { applyStatus, batchDigest, dateLabel, editRow, issuePayload, isHard, makeBatch, parseAmountInput, parseDateInput, periodLabel, REASON, setOn, summary, totalOf } from './bulk-model.js';
import { btn, h, icon, num, replyOptions, titleWithIcon } from './shell-views.js';
import { actions, listModal } from './shell-ui.js';

const SHEET_EXT = /\.(xlsx|xls|csv|htm|html)$/i;
const FILE_MAX = 10 * 1024 * 1024;
/** 카드에 건마다 한 줄을 보이는 상한(결정 3). 넘으면 요약 카드 */
const CARD_ROWS = 10;
const READ_ERR = {
  header_not_found: '표에서 거래처와 금액 칸을 찾지 못했어요. 첫 줄에 거래처, 공급가액 같은 칸 이름이 있는지 봐 주세요. 앱 양식에 옮겨 적어도 돼요.',
  no_rows: '표에 발급할 줄이 없어요.',
  not_sheet: '엑셀이나 CSV 파일만 읽을 수 있어요.',
  too_big: '10MB보다 큰 파일은 읽지 못해요.',
};
const ISSUE_ERR = {
  'bulk.sheet_not_ready': '11건부터는 홈택스 일괄발급으로 내요. 이 길은 아직 준비 중이라 발급하지 않았어요.',
  'bulk.bad_row': '목록에 고칠 값이 남아 있어요. 목록에서 확인해 주세요.',
  'bulk.no_rows': '발급할 건이 없어요.',
  'bulk.too_many': '한 번에 5,000건까지 낼 수 있어요.',
  gesture_required: '다시 눌러 주세요.',
};
const won = (n) => `${num(n)}원`;
const amt = (n) => (n == null ? '' : num(n));
/** 엑셀에서 복사한 칸: 탭이 있는 두 줄 이상 */
export const looksLikeTable = (t) => t.includes('\t') && t.trim().split(/\r?\n/).length >= 2;

function b64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * ctx: { call, toast, appendThread, today: () => 'YYYY-MM-DD', cps: () => 거래처, renderModal, composer: { chipSlot, input, refresh } }
 */
export function createBulk(ctx) {
  const st = { attach: null, batches: new Map(), modal: null, modalEl: null };

  // 입력창에 붙은 파일 또는 붙여 넣은 표
  function paintChip() {
    const slot = ctx.composer.chipSlot;
    const a = st.attach;
    slot.hidden = !a;
    slot.closest('.sx-input')?.classList.toggle('has-file', !!a);
    if (!a) return slot.replaceChildren();
    slot.replaceChildren(
      h(
        'span',
        { class: 'bk-chip', 'data-bulk-chip': a.kind },
        icon('file'),
        h('span', { class: 'bk-chip-name' }, a.label),
        h('button', { type: 'button', class: 'bk-chip-x', 'aria-label': '파일 빼기', onclick: () => clearAttach(true) }, icon('close')),
      ),
    );
    ctx.composer.refresh();
  }
  function clearAttach(focus) {
    st.attach = null;
    paintChip();
    if (focus) ctx.composer.input.focus();
  }
  async function attachFile(file) {
    if (!SHEET_EXT.test(file.name)) {
      ctx.toast('엑셀이나 CSV 파일을 올려 주세요');
      return false;
    }
    if (file.size > FILE_MAX) {
      ctx.toast('10MB보다 큰 파일은 읽지 못해요');
      return false;
    }
    st.attach = { kind: 'file', label: file.name, data: b64(await file.arrayBuffer()) };
    paintChip();
    ctx.composer.input.focus();
    return true;
  }
  function attachText(text) {
    const n = text.trim().split(/\r?\n/).filter((l) => l.trim()).length;
    st.attach = { kind: 'text', label: `붙여 넣은 표 ${n}줄`, text };
    paintChip();
  }
  const sheetFile = (list) => [...(list ?? [])].find((f) => SHEET_EXT.test(f.name));

  /** 입력창 붙여 넣기: 엑셀 파일이나 탭으로 나뉜 표면 칩으로 붙이고, 그 밖의 글은 그대로 둔다 */
  function onPaste(e) {
    const f = sheetFile(e.clipboardData?.files);
    if (f) {
      e.preventDefault();
      void attachFile(f);
      return;
    }
    const t = e.clipboardData?.getData('text/plain') ?? '';
    if (looksLikeTable(t)) {
      e.preventDefault();
      attachText(t);
    }
  }
  /** 창 어디에나 끌어다 놓기(결정 2) */
  function wireDrop(root, accept) {
    const has = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
    root.addEventListener('dragover', (e) => {
      if (!has(e) || !accept()) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      root.classList.add('is-drop');
    });
    root.addEventListener('dragleave', (e) => {
      if (!root.contains(e.relatedTarget)) root.classList.remove('is-drop');
    });
    root.addEventListener('drop', (e) => {
      root.classList.remove('is-drop');
      if (!has(e) || !accept()) return;
      e.preventDefault();
      const f = sheetFile(e.dataTransfer.files) ?? e.dataTransfer.files[0];
      if (f) void attachFile(f);
    });
  }

  const pending = () => !!st.attach;

  /** 보내기: 내 말풍선(파일 이름, 쓴 말) → 읽기 → 묶음 카드 */
  async function send(text) {
    const a = st.attach;
    if (!a) return false;
    st.attach = null;
    paintChip();
    ctx.appendThread(h('div', { class: 'sx-me bk-me-file', 'data-bulk-me': a.kind }, icon('file'), h('span', {}, a.label)), true, true);
    if (text) ctx.appendThread(h('div', { class: 'sx-me' }, text), true, true);
    const wait = h('div', { class: 'sx-app sx-typing', role: 'status', 'aria-label': '표를 읽고 있어요' }, h('i'), h('i'), h('i'));
    ctx.appendThread(wait);
    let r;
    try {
      r = await ctx.call('bulk.read', a.kind === 'file' ? { data: a.data } : { text: a.text });
    } catch {
      r = null;
    } finally {
      wait.remove();
    }
    if (r?.kind === 'pick' && a.kind === 'file') {
      askColumns(a, r);
      return true;
    }
    showRows(r);
    return true;
  }

  /** 앱 양식(대표 결정 2026-11-24: 양식 없이도 받되 양식도 준다). 내려받기 폴더에 저장하고 그 폴더를 연다. */
  async function saveTemplate() {
    try {
      const r = await ctx.call('bulk.template', {});
      ctx.toast(`내려받기 폴더에 ${r.name}을 저장했어요`);
    } catch {
      ctx.toast('양식을 저장하지 못했어요');
    }
  }
  const templateBtn = () => h('div', { class: 'sx-actions' }, btn('양식 받기', () => void saveTemplate(), '', { 'data-act': 'bulk-template' }));

  function showRows(r) {
    if (!r || r.kind !== 'rows') {
      ctx.appendThread(h('div', { class: 'sx-app', 'data-bulk-error': r?.reason ?? 'failed' }, h('p', {}, READ_ERR[r?.reason] ?? '표를 읽지 못했어요. 다시 올려 주세요.'), r?.reason === 'not_sheet' || r?.reason === 'too_big' ? null : templateBtn()));
      return;
    }
    const batch = makeBatch(r.rows, ctx.cps(), ctx.today(), undefined, r.status ?? {});
    batch.source = r.source;
    st.batches.set(batch.id, batch);
    if (r.assumedSupply) ctx.appendThread(h('div', { class: 'sx-app' }, h('p', {}, '금액 칸은 부가세를 뺀 값으로 봤어요. 다르면 목록에서 고쳐 주세요.')));
    batch.cardEl = h('div', { class: 'sx-app bk-wrap', 'data-bulk': batch.id });
    paintCard(batch);
    ctx.appendThread(batch.cardEl);
  }

  /**
   * 거래처나 금액 칸을 찾지 못한 표(결정 2): 답 후보 줄로 칸을 한 번씩 묻고, 고른 칸으로 다시 읽는다.
   * 칸 이름은 첫 줄 글자, 비었으면 첫 값을 보인다.
   */
  function askColumns(a, r) {
    const width = Math.min(12, Math.max(r.headers.length, ...r.sample.map((x) => x.length)));
    const label = (i) => {
      const head = (r.sample[0]?.[i] ?? '').trim();
      const eg = r.sample.slice(1).map((x) => (x[i] ?? '').trim()).find(Boolean);
      return head ? (eg && eg !== head ? `${head} (${eg})` : head) : `${i + 1}번째 칸`;
    };
    const cols = Array.from({ length: width }, (_, i) => i).filter((i) => r.sample.some((x) => (x[i] ?? '').trim()));
    const picked = {};
    const ask = (text, role, then) => {
      const box = h('div', { class: 'sx-app', 'data-bulk-ask': role }, h('p', {}, text), replyOptions(cols.filter((i) => !Object.values(picked).includes(i)).map((i) => ({ label: label(i).slice(0, 40), attrs: { 'data-col': String(i) }, onPick: () => ((picked[role] = i), then()) }))));
      ctx.appendThread(box, true);
    };
    const basis = () => {
      const box = h(
        'div',
        { class: 'sx-app', 'data-bulk-ask': 'basis' },
        h('p', {}, '그 금액은 부가세를 뺀 값인가요?'),
        replyOptions([
          { label: '부가세 뺀 금액', attrs: { 'data-basis': 'supply' }, onPick: () => reread('supply') },
          { label: '부가세 포함 합계', attrs: { 'data-basis': 'total' }, onPick: () => reread('total') },
        ]),
      );
      ctx.appendThread(box, true);
    };
    const reread = async (role) => {
      const amt = picked.amount;
      const first = (r.sample[0]?.[amt] ?? '').trim();
      // 첫 줄 금액 칸이 글자면 머리글 줄이다. 비었거나 숫자면 머리글 없는 표로 읽는다(빈 칸을 머리글로 보면 첫 건을 잃는다).
      const looksHead = first !== '' && !/^[\d,.\s원₩()-]+$/.test(first);
      const mapping = { sheet: r.sheet, headerRow: looksHead ? 0 : -1, columns: { name: picked.name, [role]: amt } };
      const wait = h('div', { class: 'sx-app sx-typing', role: 'status', 'aria-label': '표를 읽고 있어요' }, h('i'), h('i'), h('i'));
      ctx.appendThread(wait);
      let res;
      try {
        res = await ctx.call('bulk.read', { data: a.data, mapping: JSON.stringify(mapping) });
      } catch {
        res = null;
      } finally {
        wait.remove();
      }
      showRows(res);
    };
    ask('표에서 거래처 칸을 찾지 못했어요. 거래처는 어느 칸인가요?', 'name', () => ask('금액은 어느 칸인가요?', 'amount', basis));
  }

  // 묶음 카드(결정 3)
  function paintCard(b) {
    const all = b.rows;
    const s = summary(b);
    const withAmt = all.filter((r) => r.supply != null);
    const supply = withAmt.reduce((n, r) => n + r.supply, 0);
    const total = withAmt.reduce((n, r) => n + (totalOf(r) ?? 0), 0);
    const dates = all.map((r) => r.date).filter(Boolean).sort();
    const parties = new Set(all.map((r) => r.bizNo ?? r.name)).size;
    const kids = [h('div', { class: 'sx-card-hd' }, titleWithIcon('doc', `세금계산서 ${all.length}건`))];
    if (all.length <= CARD_ROWS) {
      kids.push(
        h(
          'div',
          { class: 'bk-cmp', 'data-bulk-rows': String(all.length) },
          h('span'), h('span', { class: 'bk-h' }, '공급가액'), h('span', { class: 'bk-h' }, '합계'),
          ...all.flatMap((r) => [
            h('span', { class: 'bk-nm' }, r.issues.length && !r.on ? h('i', { class: 'bk-dot', 'aria-label': '확인할 건' }) : null, r.name || '거래처 없음'),
            h('span', { class: 'bk-n' }, amt(r.supply)),
            h('span', { class: 'bk-n' }, amt(totalOf(r))),
          ]),
          h('span', { class: 'bk-sep' }),
          h('span', { class: 'bk-k' }, '모두'), h('span', { class: 'bk-n' }, num(supply)), h('span', { class: 'bk-n is-strong' }, num(total)),
        ),
      );
    } else {
      const row = (k, v, strong) => h('div', { class: 'bk-kv' }, h('span', { class: 'bk-k' }, k), h('span', { class: `bk-v${strong ? ' is-strong' : ''}` }, v));
      kids.push(h('div', { class: 'bk-rows', 'data-bulk-summary': '' }, row('거래처', `${num(parties)}곳`), row('작성일', periodLabel(dates[0], dates[dates.length - 1], b.today)), row('공급가액', won(supply)), row('합계', won(total), true)));
    }
    if (b.started) {
      b.cardEl.replaceChildren(h('article', { class: 'sx-card bk-card', 'data-bulk-card': all.length <= CARD_ROWS ? 'rows' : 'summary', 'data-bulk-started': '' }, ...kids));
      return;
    }
    if (s.attention) {
      kids.push(h('div', { class: 'sx-note is-attention bk-note', 'data-bulk-attention': String(s.attention) }, icon('warn'), h('div', {}, `확인할 ${s.attention}건이 있어요`)));
      kids.push(h('div', { class: 'sx-actions' }, btn(`${s.attention}건 확인하기`, () => openList(b, 'check'), 'sx-btn-primary', { 'data-act': 'bulk-check' }), btn('목록 보기', () => openList(b, 'all'), '', { 'data-act': 'bulk-list' })));
    } else {
      kids.push(
        h(
          'div',
          { class: 'sx-actions' },
          btn(`${s.ready}건 발급하기`, () => askApproval(b), 'sx-btn-primary', { 'data-act': 'bulk-issue', disabled: s.ready ? null : true }),
          btn(all.length <= CARD_ROWS ? '수정' : '목록 보기', () => openList(b, 'all'), '', { 'data-act': 'bulk-list' }),
        ),
      );
    }
    b.cardEl.replaceChildren(h('article', { class: 'sx-card bk-card', 'data-bulk-card': all.length <= CARD_ROWS ? 'rows' : 'summary' }, ...kids));
  }

  // 승인 카드(결정 5): 단추는 [승인하고 발급] [자세히 보기] [중지]
  function askApproval(b) {
    const s = summary(b);
    if (!s.ready) return ctx.toast('발급할 건이 없어요');
    withdraw(b);
    b.digest = batchDigest(b);
    const row = (k, v) => h('div', { class: 'bk-kv' }, h('span', { class: 'bk-k' }, k), h('span', { class: 'bk-v' }, v));
    b.approvalEl = h(
      'div',
      { class: 'sx-app bk-wrap', 'data-bulk-approval': b.id },
      h(
        'article',
        { class: 'sx-card bk-appr' },
        h('div', { class: 'sx-card-hd' }, titleWithIcon('doc', `세금계산서 ${s.ready}건`, 'wait'), h('span', { class: 'bk-state' }, '승인 대기')),
        h('p', { class: 'bk-sum' }, won(s.total)),
        h(
          'div',
          { class: 'bk-rows' },
          row('공급가액', won(s.supply)),
          row('부가세', won(s.vat)),
          row('거래처', `${num(s.parties)}곳`),
          row('작성일', periodLabel(s.from, s.to, b.today)),
          s.largest ? row('가장 큰 건', `${s.largest.name} ${won(totalOf(s.largest))}`) : null,
        ),
        h('p', { class: 'bk-line' }, '발급하면 되돌릴 수 없어요.'),
        h(
          'div',
          { class: 'sx-actions' },
          btn('승인하고 발급', () => approve(b), 'sx-btn-approve', { 'data-act': 'bulk-approve' }),
          btn('자세히 보기', () => openDetail(b), '', { 'data-act': 'bulk-detail' }),
          btn('중지', () => stop(b), '', { 'data-act': 'bulk-stop' }),
        ),
      ),
    );
    ctx.appendThread(b.approvalEl);
  }
  function withdraw(b) {
    b.approvalEl?.remove();
    b.approvalEl = null;
    b.digest = null;
  }
  async function approve(b) {
    if (b.digest !== batchDigest(b)) {
      withdraw(b);
      askApproval(b);
      return ctx.toast('값이 바뀌어 승인 카드를 다시 띄웠어요');
    }
    if (b.starting) return;
    closeModal();
    b.starting = true;
    let r;
    try {
      r = await ctx.call('bulk.issue', { rows: JSON.stringify(issuePayload(b)) });
    } catch (e) {
      const code = String(e?.message ?? '');
      ctx.toast(ISSUE_ERR[code] ?? '발급을 시작하지 못했어요. 아무것도 발급하지 않았어요.');
      return;
    } finally {
      b.starting = false;
    }
    if (r?.kind === 'status') {
      const n = applyStatus(b, r.status, ctx.cps());
      withdraw(b);
      paintCard(b);
      ctx.appendThread(h('div', { class: 'sx-app', 'data-bulk-status': String(n) }, h('p', {}, '방금 국세청에 다시 물어보니 폐업했거나 없는 번호가 있어 빼 두었어요. 묶음 카드에서 다시 발급해 주세요.')));
      return;
    }
    if (r?.kind !== 'started') return ctx.toast('발급을 시작하지 못했어요. 아무것도 발급하지 않았어요.');
    // 10건까지(건별 길)는 main이 만든 묶음 카드(차례로 발급)가 진행을 보이고, 홈택스가 읽은 값의 승인은 앱 승인 카드가 받는다.
    b.started = r;
    withdraw(b);
    paintCard(b);
  }
  function stop(b) {
    closeModal();
    withdraw(b);
    ctx.appendThread(h('div', { class: 'sx-app' }, h('p', {}, '발급하지 않았어요.')));
  }

  // 모달 공통: scrim + 가운데 면, 닫기 단추와 바깥 누르기와 Esc(shell.js dismissModal)
  function openList(b, filter) {
    withdraw(b);
    st.modal = { kind: 'list', b, filter, q: '' };
    st.modalEl = editModal(st.modal);
    ctx.renderModal();
  }
  function openDetail(b) {
    st.modal = { kind: 'detail', b, filter: 'on', q: '' };
    st.modalEl = detailModal(st.modal);
    ctx.renderModal();
  }
  function closeModal() {
    if (!st.modal) return;
    const b = st.modal.b;
    const kind = st.modal.kind;
    st.modal = null;
    st.modalEl = null;
    ctx.renderModal();
    if (kind === 'list') paintCard(b);
    (kind === 'list' ? b.cardEl : b.approvalEl)?.querySelector('.sx-btn-primary, .sx-btn-approve')?.focus();
  }

  const bulkList = (count, tools, body, footer, attrs) =>
    listModal({ id: 'bulk', title: `세금계산서 ${num(count)}건`, onClose: closeModal, tools, body, footer, attrs: { class: 'bk-modal', ...attrs } });
  const numBox = (label, value, attr) => h('div', { class: 'bk-num' }, h('span', {}, label), h('b', attr ?? {}, value));
  function tools(m, segs, onChange) {
    const seg = h('div', { class: 'sx-seg bk-seg', role: 'group', 'aria-label': '거르기' });
    const paintSeg = () =>
      seg.replaceChildren(
        ...segs().map(([id, label]) =>
          h('button', { type: 'button', class: m.filter === id ? 'is-on' : null, 'aria-pressed': String(m.filter === id), 'data-filter': id, onclick: () => ((m.filter = id), paintSeg(), onChange()) }, label),
        ),
      );
    paintSeg();
    const find = h('input', { type: 'search', class: 'bk-find-in', placeholder: '거래처 찾기', 'aria-label': '거래처 찾기', spellcheck: 'false' });
    find.addEventListener('input', () => ((m.q = find.value.trim()), onChange()));
    return { el: h('div', { class: 'bk-tools' }, seg, h('label', { class: 'bk-find' }, icon('search'), find)), paintSeg };
  }
  const match = (m, r) => !m.q || r.name.toLowerCase().includes(m.q.toLowerCase());

  // 목록 모달(결정 4): 모든 칸이 언제나 테두리 없는 입력 칸
  function editModal(m) {
    const b = m.b;
    const flagged = b.rows.filter((r) => r.flagged).length;
    const nums = h('div', { class: 'bk-nums' });
    const issue = btn('', () => {
      closeModal();
      askApproval(b);
    }, 'sx-btn-primary sx-btn-lg', { 'data-act': 'bulk-list-issue' });
    const excluded = h('span', { class: 'bk-foot-line' });
    const foot = actions(issue, excluded);
    const body = h('div', { class: 'bk-tbody', role: 'rowgroup' });
    const paintTop = () => {
      const s = summary(b);
      nums.replaceChildren(numBox('발급할 건', `${num(s.ready)}건`, { 'data-bulk-ready': String(s.ready) }), numBox('합계', won(s.total)), numBox('확인할 건', `${num(s.attention)}건`, { 'data-bulk-attn': String(s.attention) }));
      const why = s.excluded ? (s.excludedAttention ? `확인할 ${s.excluded}건은 빼고 발급해요` : `${s.excluded}건은 빼고 발급해요`) : null;
      issue.textContent = `${num(s.ready)}건 발급하기`;
      issue.disabled = !s.ready;
      excluded.hidden = !why;
      excluded.textContent = why;
      if (why) excluded.dataset.bulkExcluded = String(s.excluded);
      else delete excluded.dataset.bulkExcluded;
    };
    const t = tools(m, () => [['all', `전체 ${num(b.rows.length)}`], ['check', `확인할 ${num(flagged)}`]], () => paintBody());
    const paintBody = () => {
      const list = b.rows.filter((r) => (m.filter !== 'check' || r.flagged) && match(m, r));
      body.replaceChildren(...(list.length ? list.map((r) => editRowEl(b, r, paintTop)) : [h('p', { class: 'bk-empty' }, m.q ? '찾는 거래처가 없어요' : '확인할 건이 없어요')]));
    };
    paintTop();
    paintBody();
    const head = h('div', { class: 'bk-tr bk-th', role: 'row' }, h('span'), h('span', {}, '거래처'), h('span', {}, '작성일'), h('span', {}, '품목'), h('span', { class: 'bk-n' }, '공급가액'), h('span', { class: 'bk-n' }, '부가세'), h('span', { class: 'bk-n' }, '합계'));
    return bulkList(b.rows.length, [nums, t.el], h('div', { class: 'bk-tbl', role: 'table', 'aria-label': '발급할 세금계산서' }, head, body), foot, { 'data-bulk-list': b.id });
  }

  function editRowEl(b, r, paintTop) {
    const tr = h('div', { class: 'bk-tr', role: 'row', 'data-row': r.key });
    const cell = (field, value, cls, label) => {
      const i = h('input', { class: `bk-in${cls ? ` ${cls}` : ''}`, value, 'aria-label': label, 'data-field': field, spellcheck: 'false', autocomplete: 'off' });
      i.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.isComposing) i.blur();
        if (e.key === 'Escape') {
          e.stopPropagation();
          i.value = shown(field);
          i.blur();
        }
      });
      i.addEventListener('change', () => commit(field, i));
      return i;
    };
    const shown = (f) => (f === 'name' ? r.name : f === 'item' ? r.item : f === 'date' ? dateLabel(r.date, b.today) : amt(r[f]));
    const commit = (field, i) => {
      let v = i.value;
      if (field === 'supply' || field === 'vat') {
        v = parseAmountInput(v);
        if (v === undefined) {
          i.value = shown(field);
          return ctx.toast('금액은 숫자로 써 주세요');
        }
      } else if (field === 'date') {
        v = parseDateInput(v, b.today);
        if (!v) {
          i.value = shown(field);
          return ctx.toast('날짜는 11월 24일처럼 써 주세요');
        }
      }
      editRow(b, r, field, v, ctx.cps());
      paint();
      paintTop();
    };
    const chk = h('button', { type: 'button', class: 'bk-chk', role: 'checkbox', 'data-act': 'bulk-toggle' });
    chk.addEventListener('click', () => {
      if (!setOn(b, r, !r.on)) return ctx.toast(`${REASON[r.issues.find((c) => isHard([c]))]}. 고치면 넣을 수 있어요`);
      paint();
      paintTop();
    });
    const dot = h('i', { class: 'bk-dot', 'aria-hidden': 'true' });
    const why = h('small', { class: 'bk-why' });
    const ins = { name: cell('name', r.name, 'bk-name-in', '거래처'), date: cell('date', '', 'bk-date', '작성일'), item: cell('item', r.item, '', '품목'), supply: cell('supply', '', 'bk-n', '공급가액'), vat: cell('vat', '', 'bk-n', '부가세') };
    const total = h('span', { class: 'bk-n bk-total' });
    const paint = () => {
      chk.setAttribute('aria-checked', String(r.on));
      chk.setAttribute('aria-label', `${r.name || '거래처 없음'} ${r.on ? '빼기' : '넣기'}`);
      chk.replaceChildren(r.on ? icon('check') : '');
      const reason = r.issues.length && !r.on ? REASON[r.issues[0]] : '';
      dot.hidden = !reason;
      why.hidden = !reason;
      why.textContent = reason;
      tr.dataset.attention = reason ? '1' : '';
      for (const [f, i] of Object.entries(ins)) if (document.activeElement !== i) i.value = shown(f);
      total.textContent = amt(totalOf(r));
    };
    paint();
    tr.append(chk, h('span', { class: 'bk-name' }, dot, ins.name, why), ins.date, ins.item, ins.supply, ins.vat, total);
    return tr;
  }

  // 자세히 보기(결정 5): 읽기 전용, 금액 큰 순. 아래 [승인하고 발급] [고치기]
  function detailModal(m) {
    const b = m.b;
    const s = summary(b);
    const body = h('div', { class: 'bk-tbody', role: 'rowgroup' });
    const t = tools(m, () => [['on', `발급할 ${num(s.ready)}`], ['off', `뺀 ${num(s.excluded)}`]], () => paintBody());
    const sorted = [...b.rows].sort((x, y) => (totalOf(y) ?? 0) - (totalOf(x) ?? 0));
    const paintBody = () => {
      const list = sorted.filter((r) => (m.filter === 'on' ? r.on : !r.on) && match(m, r));
      body.replaceChildren(
        ...(list.length
          ? list.map((r) =>
              h('div', { class: 'bk-tr is-ro', role: 'row', 'data-row': r.key }, h('span', { class: 'bk-name' }, r.name || '거래처 없음'), h('span', {}, dateLabel(r.date, b.today)), h('span', { class: 'bk-ell' }, r.item), h('span', { class: 'bk-n' }, amt(r.supply)), h('span', { class: 'bk-n' }, amt(r.vat)), h('span', { class: 'bk-n' }, amt(totalOf(r)))),
            )
          : [h('p', { class: 'bk-empty' }, m.q ? '찾는 거래처가 없어요' : '뺀 건이 없어요')]),
      );
    };
    paintBody();
    const head = h('div', { class: 'bk-tr bk-th is-ro', role: 'row' }, h('span', {}, '거래처'), h('span', {}, '작성일'), h('span', {}, '품목'), h('span', { class: 'bk-n' }, '공급가액'), h('span', { class: 'bk-n' }, '부가세'), h('span', { class: 'bk-n' }, '합계'));
    const foot = actions(
      btn('승인하고 발급', () => approve(b), 'sx-btn-approve sx-btn-lg', { 'data-act': 'bulk-detail-approve' }),
      btn('고치기', () => openList(b, 'all'), 'sx-btn-lg', { 'data-act': 'bulk-fix' }),
    );
    return bulkList(s.ready, [h('div', { class: 'bk-nums' }, numBox('공급가액', won(s.supply)), numBox('부가세', won(s.vat)), numBox('합계', won(s.total))), t.el], h('div', { class: 'bk-tbl', role: 'table', 'aria-label': '발급할 세금계산서' }, head, body), foot, { 'data-bulk-detail': b.id });
  }

  return {
    onPaste,
    wireDrop,
    pending,
    send,
    clearAttach,
    modalOpen: () => !!st.modal,
    modal: () => st.modalEl,
    close: closeModal,
  };
}
