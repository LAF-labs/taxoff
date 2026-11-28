import type { EventLog } from '@sax/platform';
import type { TargetState } from '../relay/relay.ts';
import { REPORT_SCREEN_IDS, SCREENS, type ReportScreenId, type ScreenSpec } from './screens.ts';

type Json = Record<string, unknown>;

const RUN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const TARGET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ISO = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
/** 홈택스 화면 공통 접두(실측). 고정 스크립트는 이 접두 + screens.ts의 id만 찾는다. */
export const WFRAME = 'mf_txppWframe_';
/** 한 번의 받기에서 읽는 줄과 쪽의 상한. 엔진 bank.hometaxSync가 한 번에 받는 줄도 5,000이다. */
export const REPORT_ROWS_MAX = 5_000;
export const REPORT_PAGES_MAX = 120;
/** 화면 열기, 조회 한 번, 쪽 넘김 한 번을 기다리는 상한. */
export const REPORT_WAIT_MS = 30_000;
/** 조회 요청이 끝난 뒤 표가 그려지기를 기다리는 시간. 처리 중 표시가 사라진 뒤에도 이만큼 둔다. */
export const REPORT_SETTLE_MS = 300;
/**
 * 화면이 다 떴다고 보려면 홈택스 요청이 이만큼 조용해야 한다. 메뉴를 누르면 메뉴 요청 묶음이 끝나고 몇 ms 뒤 화면 초기화 요청 묶음이 오고,
 * 그 초기화가 기간 칸과 쪽 크기를 기본값(오늘, 10줄)으로 되돌린다(11/25 실측: 표지 요소는 140ms에 다 있고 기본값은 250ms에 들어왔다).
 * 표지만 보고 기간을 넣으면 초기화가 덮어써 조회가 나가지 않았다.
 */
export const REPORT_QUIET_MS = 500;
const POLL_MS = 150;

/** 조회 결과가 없다는 안내. 이 문구는 0건으로 본다. 다른 안내는 받기 실패(portal_alert)다. */
const NO_DATA = /(조회된|조회할|검색된)?\s*(자료|내역|데이터|정보)가?\s*(없습니다|존재하지)/;

/**
 * 고정 스크립트 묶음. 모두 `(args) => 값` 꼴이고 vault가 JSON 인자를 붙여 Runtime.evaluate로 돈다. 엔진과 패키지는 바꿀 수 없다.
 * 홈택스 조회 단추를 JS로 바로 누르면 검증 실패 alert가 탭을 멈춘다(실측). 그래서 alert와 confirm을 먼저 가로채 문구를 모으고(confirm은 언제나 취소),
 * 누르기는 setTimeout으로 비동기로 한다. 조회가 끝났는지는 그 화면 조회 요청(actionId)이 끝난 횟수로 본다(XHR loadend).
 */
const HOOK = `function hook() {
  const w = window;
  if (w.__saxReport) return w.__saxReport;
  const st = { alerts: [], done: {}, pending: 0, last: 0 };
  Object.defineProperty(w, '__saxReport', { value: st, enumerable: false });
  w.alert = (m) => { st.alerts.push(String(m === undefined ? '' : m).slice(0, 200)); };
  w.confirm = (m) => { st.alerts.push(String(m === undefined ? '' : m).slice(0, 200)); return false; };
  const X = XMLHttpRequest.prototype, open = X.open, send = X.send;
  X.open = function (method, url) { this.__saxUrl = String(url); return open.apply(this, arguments); };
  X.send = function () {
    const m = /[?&]actionId=([A-Za-z0-9]{1,40})/.exec(this.__saxUrl || '');
    st.pending++; st.last = Date.now();
    this.addEventListener('loadend', () => { st.pending--; st.last = Date.now(); if (m) st.done[m[1]] = (st.done[m[1]] || 0) + 1; });
    return send.apply(this, arguments);
  };
  return st;
}
const busy = () => [...document.querySelectorAll('[id$="_wq_processMsgComp"]')].some((e) => e.getClientRects().length > 0 && getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden');`;

const script = (body: string) => `((a) => { ${HOOK}\n const $ = (id) => document.getElementById(a.P + id);\n try { ${body} } catch (e) { return { ok: false, reason: 'script_error' }; } })`;

/**
 * 메뉴 a 태그를 누른다(직접 주소 이동은 로그아웃을 일으킨다, 실측). 숨은 메뉴여도 click()으로 열린다.
 * 지금 화면에 이미 있는 표지 요소에 옛 표시를 달아 둔다. 메뉴가 새로 그린 화면(새 문서든 같은 문서의 새 요소든)만 다 떴다고 본다.
 * 앞 화면에서 모인 안내는 버린다(그 화면의 받기가 이미 처리했다).
 */
export const NAV_SCRIPT = script(`const st = hook(); const el = document.getElementById(a.menu); if (!el) return { ok: false, reason: 'menu_missing' };
  st.alerts.length = 0;
  for (const id of a.ready) { const x = $(id); if (x) x.__saxOld = true; }
  setTimeout(() => el.click(), 10); return { ok: true };`);

/** 화면 표지가 모두 있고, 처리 중 표시가 없고, 홈택스 요청이 a.quiet ms 동안 없었는가. 그 문서에서 뜬 안내도 같이 돌려준다. */
export const READY_SCRIPT = script(`const st = hook(); const quiet = !st.pending && Date.now() - st.last >= a.quiet;
  return { ok: true, ready: quiet && a.ids.every((id) => { const x = $(id); return !!x && !x.__saxOld; }) && !busy(), alerts: st.alerts.splice(0) };`);

/** 기간 고르기 1단계: 탭이나 라디오를 누른다(그 뒤 기간 칸이 켜진다). */
export const PERIOD_PREP_SCRIPT = script(`hook();
  const s = a.spec;
  const id = s.kind === 'month_tab' ? s.tab : s.kind === 'month_radio' || s.kind === 'range' ? s.radio : null;
  if (id) { const el = $(id); if (!el) return { ok: false, reason: 'period_missing' }; if (!(el.type === 'radio' && el.checked)) el.click(); }
  return { ok: true, ids: s.kind === 'range' ? [s.from, s.to, s.pageSize.id] : s.kind === 'quarter' ? [s.year, s.qFrom, s.qTo] : [s.month] };`);

/**
 * 기간 고르기 2단계: 칸을 채우고 되읽는다. select는 컴포넌트 setValue로 바뀌지 않아 DOM selectedIndex를 바꾸고 change를 보낸다(실측).
 * 날짜 칸은 DOM 값과 이벤트에 더해 컴포넌트가 있으면 setValue도 부른다. 되읽은 값이 다르면 period_not_set으로 멈춘다(조회하지 않는다).
 * a.check면 아무것도 바꾸지 않고 칸이 그 기간인지만 본다(조회 직전과 직후, 화면이 칸을 되돌리지 않았는지).
 */
export const PERIOD_SET_SCRIPT = script(`hook();
  const s = a.spec, p = a.period;
  const pick = (id, test) => {
    const el = $(id);
    if (!el || el.tagName !== 'SELECT') return false;
    const i = [...el.options].findIndex((o) => test(String(o.text || '').trim(), String(o.value || '').trim()));
    if (i < 0) return false;
    if (a.check) return el.selectedIndex === i;
    if (el.selectedIndex !== i) { el.selectedIndex = i; el.dispatchEvent(new Event('change', { bubbles: true })); }
    return el.selectedIndex === i;
  };
  const ym = (t, y, m) => { const x = /(\\d{4})\\D{0,3}(\\d{1,2})/.exec(t); return !!x && Number(x[1]) === y && Number(x[2]) === m; };
  const y = Number(p.from.slice(0, 4)), m = Number(p.from.slice(5, 7)), q = Math.floor((m - 1) / 3) + 1;
  if (s.kind === 'month_tab' || s.kind === 'month_radio') {
    if (!pick(s.month, (t, v) => ym(t, y, m) || ym(v, y, m))) return { ok: false, reason: 'period_not_set' };
    return { ok: true };
  }
  if (s.kind === 'quarter') {
    const yr = (t, v) => Number((/(\\d{4})/.exec(t) || /(\\d{4})/.exec(v) || [])[1]) === y;
    const qt = (t, v) => Number((/^(\\d)\\s*분기/.exec(t) || /^(\\d)$/.exec(v) || [])[1]) === q;
    if (!pick(s.year, yr) || !pick(s.qFrom, qt) || !pick(s.qTo, qt)) return { ok: false, reason: 'period_not_set' };
    return { ok: true };
  }
  const put = (id, iso) => {
    const el = $(id);
    if (!el) return false;
    if (a.check) return String(el.value).replace(/[^0-9]/g, '') === iso.replace(/-/g, '');
    const c = window.$p && typeof window.$p.getComponentById === 'function' ? window.$p.getComponentById(a.P + id.replace(/_input$/, '')) : null;
    if (c && typeof c.setValue === 'function') { try { c.setValue(iso.replace(/-/g, '')); } catch (e) { /* DOM 값으로 넣는다 */ } }
    el.value = iso;
    for (const t of ['input', 'change', 'blur']) el.dispatchEvent(new Event(t, { bubbles: true }));
    return String(el.value).replace(/[^0-9]/g, '') === iso.replace(/-/g, '');
  };
  const party = window.$p && typeof window.$p.getComponentById === 'function' ? window.$p.getComponentById(a.P + s.partyKind) : null;
  if (a.check) { /* 거래처 구분은 넣을 때만 정한다 */ }
  else if (party && typeof party.setValue === 'function') party.setValue('00');
  else if (!pick(s.partyKind, (t) => t === '-전체-')) return { ok: false, reason: 'period_not_set' };
  if (!put(s.from, p.from) || !put(s.to, p.to) || !pick(s.pageSize.id, (t, v) => v === s.pageSize.value)) return { ok: false, reason: 'period_not_set' };
  return { ok: true };`);

/** 조회 직전: 안내를 비우고 지금까지 끝난 조회 요청 수를 돌려준다. */
export const ARM_SCRIPT = script(`const st = hook(); st.alerts.length = 0; return { ok: true, n: st.done[a.action] || 0 };`);

/** 단추나 쪽 링크를 비동기로 누른다. */
export const CLICK_SCRIPT = script(`hook(); const el = $(a.id); if (!el) return { ok: false, reason: 'button_missing' }; setTimeout(() => el.click(), 10); return { ok: true };`);

/** 조회 요청이 끝난 수, 처리 중인지, 모인 안내. */
export const DONE_SCRIPT = script(`const st = hook(); return { ok: true, n: st.done[a.action] || 0, busy: busy(), alerts: st.alerts.slice(0) };`);

/**
 * 표 읽기. 표 API($p.getComponentById)의 getRowCount, getCellData로 읽는다(DOM은 보이는 줄만 그린다). last4 열은 여기서 끝 4자리만 남긴다.
 * 총 건수 칸은 숫자만, 현재 쪽은 class active인 쪽 링크 번호.
 */
export const READ_SCRIPT = script(`hook();
  const out = [];
  for (const g of a.grids) {
    const c = window.$p && typeof window.$p.getComponentById === 'function' ? window.$p.getComponentById(a.P + g.id) : null;
    if (!c || typeof c.getRowCount !== 'function' || typeof c.getCellData !== 'function') return { ok: false, reason: 'grid_unreadable' };
    const n = Number(c.getRowCount());
    if (!Number.isSafeInteger(n) || n < 0 || n > a.maxRows) return { ok: false, reason: 'grid_too_many' };
    const rows = [];
    for (let r = 0; r < n; r++) {
      const row = {};
      for (const col of g.cols) {
        const v = c.getCellData(r, col);
        let s = v === null || v === undefined ? '' : String(v).trim().slice(0, 120);
        if ((g.last4 || []).includes(col)) s = s.replace(/[^0-9]/g, '').slice(-4);
        row[col] = s;
      }
      rows.push(row);
    }
    out.push(rows);
  }
  const tot = a.total ? $(a.total) : null;
  const total = tot ? Number(String(tot.textContent || '').replace(/[^0-9]/g, '') || 'NaN') : null;
  const sumEl = a.sum ? $(a.sum) : null;
  const sumText = sumEl ? String(sumEl.textContent || '').trim() : '';
  const sum = /^-?[0-9,]+$/.test(sumText) ? Number(sumText.replace(/,/g, '')) : null;
  const act = a.pager ? [...document.querySelectorAll('[id^="' + a.P + a.pager + '"]')].find((e) => /(^|\\s)active(\\s|$)/.test(e.className)) : null;
  const page = act ? Number(act.id.slice((a.P + a.pager).length)) : null;
  return { ok: true, grids: out, total: Number.isSafeInteger(total) ? total : null, sum: Number.isSafeInteger(sum) ? sum : null, page: Number.isSafeInteger(page) ? page : null };`);

export interface ReportReaderOptions {
  log: EventLog;
  send: <T = Json>(method: string, params: Json, sessionId?: string) => Promise<T>;
  exposed: (targetId: string) => TargetState | undefined;
  scrub: (t: TargetState) => Promise<boolean>;
  waitMs?: number;
  settleMs?: number;
  quietMs?: number;
  pollMs?: number;
}

export type ReportReadResult = { ok: true; screen: ReportScreenId; from: string; to: string; total: number; rows: Json[] } | { ok: false; reason: string };

const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const addMonths = (iso: string, n: number) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(d, lastDay(t.getUTCFullYear(), t.getUTCMonth() + 1))).padStart(2, '0')}`;
};
const validIso = (s: unknown): s is string => typeof s === 'string' && ISO.test(s) && Number(s.slice(8, 10)) <= lastDay(Number(s.slice(0, 4)), Number(s.slice(5, 7)));

/** 화면 단위에 맞는 기간인가. 달 화면은 한 달 안, 분기 화면은 한 분기 안, 날짜 범위 화면은 3개월 이내(홈택스 안내). */
export function periodFits(unit: ScreenSpec['unit'], from: string, to: string): boolean {
  if (!validIso(from) || !validIso(to) || from > to) return false;
  if (unit === 'month') return from.slice(0, 7) === to.slice(0, 7);
  if (unit === 'quarter') return from.slice(0, 4) === to.slice(0, 4) && Math.floor((Number(from.slice(5, 7)) - 1) / 3) === Math.floor((Number(to.slice(5, 7)) - 1) / 3);
  return to < addMonths(from, 3);
}

/** 금액 칸: 쉼표 있거나 없는 정수, 음수 있음. 빈칸은 null. 숫자가 아니면 undefined(읽기 실패). */
function won(s: string): number | null | undefined {
  const t = s.replace(/\s|원|\(|\)/g, '');
  if (t === '') return null;
  if (!/^-?\d{1,3}(,\d{3})*$|^-?\d+$/.test(t)) return undefined;
  const n = Number(t.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : undefined;
}
const isoDay = (s: string): string | null => {
  const d = s.replace(/[^0-9]/g, '').slice(0, 8);
  const iso = d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : '';
  return validIso(iso) ? iso : null;
};
const bizNo = (s: string) => {
  const d = s.replace(/[^0-9]/g, '');
  return d.length === 10 ? d : '';
};

type Cells = Record<string, string>;
type Mapped = { ok: true; rows: Json[] } | { ok: false; reason: string };

/**
 * 읽은 칸을 엔진 bank.hometaxSync가 받는 줄 모양으로 바꾼다(#542 BankService). 꼭 있어야 하는 칸(날짜, 금액, 승인번호)이 읽히지 않으면
 * 그 받기 전체를 cell_unreadable로 실패시킨다(줄을 조용히 빼지 않는다). 선택 칸은 비면 null.
 */
export function mapRows(screen: ReportScreenId, grids: readonly Cells[][]): Mapped {
  const out: Json[] = [];
  const bad: Mapped = { ok: false, reason: 'cell_unreadable' };
  if (screen === 'sale_invoice' || screen === 'purchase_invoice') {
    for (const r of grids[0] ?? []) {
      const writtenOn = isoDay(r.wrtDt ?? '');
      const total = won(r.totaAmtStr ?? '');
      const supply = won(r.sumSplCftStr ?? '');
      const tax = won(r.sumTxamtStr ?? '');
      const approvalNo = (r.etan ?? '').replace(/[^0-9]/g, '');
      if (!writtenOn || total === undefined || total === null || supply === undefined || tax === undefined || approvalNo.length !== 24) return bad;
      // 목록의 상호와 대표자는 상대방 것이다(매출 목록은 공급받는자, 매입 목록은 공급자, 실측).
      const other = { name: r.tnmNm ?? '', rep: r.rprsFnm ?? '' };
      out.push({
        approvalNo, writtenOn, total, supply, tax, item: r.lsatNm ?? '',
        buyerBizNo: bizNo(r.dmnrTxprDscmNo ?? ''), supplierBizNo: bizNo(r.splrTxprDscmNo ?? ''),
        ...(screen === 'sale_invoice' ? { buyerName: other.name, buyerRep: other.rep } : { supplierName: other.name, supplierRep: other.rep }),
      });
    }
    return { ok: true, rows: out };
  }
  if (screen === 'cash_receipt_in' || screen === 'cash_receipt_out') {
    for (const r of grids[0] ?? []) {
      const day = isoDay((screen === 'cash_receipt_in' ? r.trsDtm : r.trsDtTime) ?? '');
      const amount = won(r.totaTrsAmt ?? '');
      const supply = won(r.splCft ?? '');
      const tax = won(r.vaTxamt ?? '');
      const approvalNo = (r.aprvNo ?? '').replace(/[^0-9A-Za-z]/g, '');
      if (!day || amount === undefined || amount === null || supply === undefined || tax === undefined || approvalNo.length < 6) return bad;
      // 취소거래도 금액이 양수로 온다(실측). 취소 표시로 뺀다.
      out.push({
        day, approvalNo, amount, supply, tax, canceled: r.trsClNm === '취소거래',
        ...(screen === 'cash_receipt_out' ? { cpBizNo: bizNo(r.mrntTxprDscmNoEncCntn ?? ''), cpName: r.mrntTxprNm ?? '', deductible: r.prhTxamtDdcClNm === '공제' } : {}),
      });
    }
    return { ok: true, rows: out };
  }
  if (screen === 'business_card') {
    for (const r of grids[0] ?? []) {
      const usedOn = isoDay(r.aprvDt ?? '');
      const amount = won(r.totaTrsAmt ?? '');
      const supplyAmount = won(r.splCft ?? '');
      const vatAmount = won(r.vaTxamt ?? '');
      if (!usedOn || amount === undefined || amount === null || supplyAmount === undefined || vatAmount === undefined) return bad;
      const last4 = (r.busnCrdCardNoEncCntn ?? '').replace(/[^0-9]/g, '');
      out.push({
        usedOn, merchant: r.mrntTxprNm ?? '', merchantBizNo: bizNo(r.mrntTxprDscmNoEncCntn ?? ''), cardLast4: last4.length === 4 ? last4 : '',
        approvalNo: (r.busnCrdcTrsBrkdSn ?? '').trim(), amount, supplyAmount, vatAmount, canceled: amount < 0, deductible: r.ddcYnNm === '공제',
      });
    }
    return { ok: true, rows: out };
  }
  // 카드 매출자료: 카드사 자료는 달마다 자료 종류별 합계, 판매대행 자료는 달마다 PG사별 합계다. 달(stlYm)은 yyyymm.
  const month = (s: string) => {
    const d = s.replace(/[^0-9]/g, '');
    return d.length >= 6 && /^(0[1-9]|1[0-2])$/.test(d.slice(4, 6)) ? `${d.slice(0, 4)}-${d.slice(4, 6)}` : null;
  };
  const count = (s: string) => (/^\d{1,9}$/.test(s.replace(/,/g, '')) ? Number(s.replace(/,/g, '')) : null);
  for (const r of grids[0] ?? []) {
    const m = month(r.stlYm ?? '');
    const n = count(r.stlScnt ?? '');
    const amount = won(r.totaStlAmt ?? '');
    if (!m || n === null || amount === undefined || amount === null) return bad;
    out.push({ month: m, issuer: r.mateKndNm || '신용카드', count: n, amount });
  }
  for (const r of grids[1] ?? []) {
    const m = month(r.stlYm ?? '');
    const n = count(r.sumStlScnt ?? '');
    const amount = won(r.sumTipExclAmt ?? '');
    if (!m || n === null || amount === undefined || amount === null || !(r.txprNm ?? '').trim()) return bad;
    out.push({ month: m, issuer: (r.txprNm ?? '').trim(), count: n, amount });
  }
  return { ok: true, rows: out };
}

/**
 * 월 리포트 홈택스 자동 받기의 화면 읽기(ADR-068 결정 6). `report.readScreen {runId, targetId, screen, period:{from,to}}`.
 * 금고가 고정 스크립트로 메뉴를 눌러 화면에 들어가고, 기간을 고르고, alert를 가로챈 채 [조회]를 누르고, 쪽을 넘기며 표를 읽는다.
 * 읽기만 한다. 공제여부 [변경하기] 같은 단추는 표에 없어 누를 수 없다. 카드번호는 페이지 안에서 끝 4자리만 남긴다.
 */
export class ReportReader {
  private readonly o: ReportReaderOptions;
  private busy = false;

  constructor(o: ReportReaderOptions) {
    this.o = o;
  }

  private refuse(reason: string, screen?: string): ReportReadResult {
    this.o.log.event('vault.report_refused', { reason, ...(screen ? { screen } : {}) });
    return { ok: false, reason };
  }

  async read(p: Json): Promise<ReportReadResult> {
    if (typeof p.runId !== 'string' || !RUN_ID_RE.test(p.runId) || typeof p.targetId !== 'string' || !TARGET_ID_RE.test(p.targetId)) return this.refuse('bad_params');
    if (typeof p.screen !== 'string' || !(REPORT_SCREEN_IDS as readonly string[]).includes(p.screen)) return this.refuse('bad_screen');
    const screen = p.screen as ReportScreenId;
    const spec = SCREENS[screen];
    const per = p.period as { from?: unknown; to?: unknown } | undefined;
    const from = per?.from;
    const to = per?.to;
    if (typeof from !== 'string' || typeof to !== 'string' || !periodFits(spec.unit, from, to)) return this.refuse('bad_period', screen);
    const t = this.o.exposed(p.targetId);
    if (!t) return this.refuse('target_not_exposed', screen);
    if (t.win?.phase === 'tainted') await this.o.scrub(t);
    if (t.win) return this.refuse('secret_window_open', screen);
    if (this.busy) return this.refuse('busy', screen);
    this.busy = true;
    try {
      const r = await this.run(t.vaultSession, screen, spec, from, to);
      if (!r.ok) return this.refuse(r.reason, screen);
      this.o.log.event('vault.report_read', { screen, rows: r.rows.length });
      return r;
    } finally {
      this.busy = false;
    }
  }

  private async ev<T extends Json>(sid: string, fn: string, args: Json): Promise<T | null> {
    try {
      const r = await this.o.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>('Runtime.evaluate', {
        expression: `${fn}(${JSON.stringify({ P: WFRAME, ...args })})`, returnByValue: true, userGesture: false, timeout: 10_000,
      }, sid);
      const v = r.exceptionDetails ? null : r.result?.value;
      return v && typeof v === 'object' ? (v as T) : null;
    } catch {
      // 메뉴를 누른 뒤 문서가 바뀌는 동안은 평가가 실패할 수 있다. 다음 폴링에서 다시 본다.
      return null;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 안내 문구 하나가 받기를 막는가. 결과 없음 안내는 막지 않는다(0건). */
  private blocking(alerts: unknown, screen: ReportScreenId, at: string): boolean {
    const xs = Array.isArray(alerts) ? alerts.filter((x): x is string => typeof x === 'string') : [];
    const other = xs.filter((x) => !NO_DATA.test(x));
    if (other.length) this.o.log.event('vault.report_alert', { screen, at, text: other[0]!.replace(/\s+/g, ' ').slice(0, 80) });
    return other.length > 0;
  }

  private async until<T extends Json>(sid: string, fn: string, args: Json, done: (v: T) => boolean): Promise<T | null> {
    const end = Date.now() + (this.o.waitMs ?? REPORT_WAIT_MS);
    for (;;) {
      const v = await this.ev<T>(sid, fn, args);
      if (v && done(v)) return v;
      if (Date.now() >= end) return v;
      await this.sleep(this.o.pollMs ?? POLL_MS);
    }
  }

  /** 단추를 누르고 그 조회 요청이 하나 더 끝나고 처리 중 표시가 사라질 때까지 기다린다. */
  private async searchOnce(sid: string, screen: ReportScreenId, spec: ScreenSpec, button: string): Promise<{ ok: true; noData: boolean } | { ok: false; reason: string }> {
    const armed = await this.ev<{ ok: boolean; n: number }>(sid, ARM_SCRIPT, { action: spec.action });
    if (!armed?.ok) return { ok: false, reason: 'screen_lost' };
    const c = await this.ev<{ ok: boolean; reason?: string }>(sid, CLICK_SCRIPT, { id: button });
    if (!c?.ok) return { ok: false, reason: c?.reason === 'button_missing' ? 'button_missing' : 'screen_lost' };
    let alerts: unknown[] = [];
    const d = await this.until<{ ok: boolean; n: number; busy: boolean; alerts: unknown[] }>(sid, DONE_SCRIPT, { action: spec.action }, (v) => {
      alerts = v.alerts ?? [];
      return (v.n > armed.n && !v.busy) || alerts.length > 0;
    });
    if (this.blocking(alerts, screen, 'search')) return { ok: false, reason: 'portal_alert' };
    if (alerts.length) return { ok: true, noData: true };
    if (!d || d.n <= armed.n || d.busy) return { ok: false, reason: 'search_timeout' };
    await this.sleep(this.o.settleMs ?? REPORT_SETTLE_MS);
    return { ok: true, noData: false };
  }

  private async run(sid: string, screen: ReportScreenId, spec: ScreenSpec, from: string, to: string): Promise<ReportReadResult> {
    // 1. 메뉴를 눌러 화면에 들어간다
    // 앞 화면이 아직 그리는 중이면 메뉴가 늦게 생긴다. 메뉴가 생길 때까지 기다렸다가 한 번 누른다.
    const nav = await this.until<{ ok: boolean; reason?: string }>(sid, NAV_SCRIPT, { menu: spec.menu, ready: spec.ready }, (v) => v.ok || v.reason !== 'menu_missing');
    if (!nav?.ok) return { ok: false, reason: nav?.reason === 'menu_missing' ? 'menu_missing' : 'screen_lost' };
    let alerts: unknown[] = [];
    const quiet = this.o.quietMs ?? REPORT_QUIET_MS;
    const ready = await this.until<{ ok: boolean; ready: boolean; alerts: unknown[] }>(sid, READY_SCRIPT, { ids: spec.ready, quiet }, (v) => {
      alerts = [...alerts, ...(v.alerts ?? [])];
      return v.ready;
    });
    if (this.blocking(alerts, screen, 'open')) return { ok: false, reason: 'portal_alert' };
    if (!ready?.ready) return { ok: false, reason: 'screen_not_found' };
    // 2. 기간을 고른다(탭이나 라디오 → 칸)
    const prep = await this.ev<{ ok: boolean; reason?: string; ids?: string[] }>(sid, PERIOD_PREP_SCRIPT, { spec: spec.period });
    if (!prep?.ok || !prep.ids) return { ok: false, reason: prep?.reason === 'period_missing' ? 'period_missing' : 'screen_lost' };
    const fields = await this.until<{ ok: boolean; ready: boolean }>(sid, READY_SCRIPT, { ids: prep.ids, quiet }, (v) => v.ready);
    if (!fields?.ready) return { ok: false, reason: 'period_missing' };
    const set = await this.ev<{ ok: boolean; reason?: string }>(sid, PERIOD_SET_SCRIPT, { spec: spec.period, period: { from, to } });
    if (!set?.ok) return { ok: false, reason: set?.reason === 'period_not_set' ? 'period_not_set' : 'screen_lost' };
    // 칸을 바꾸며 나간 요청이 끝나고도 기간이 그대로인지 보고 조회한다. 조회 뒤에도 보아, 다른 기간의 표를 이 기간 것으로 받지 않는다.
    const settled = await this.until<{ ok: boolean; ready: boolean }>(sid, READY_SCRIPT, { ids: prep.ids, quiet }, (v) => v.ready);
    if (!settled?.ready) return { ok: false, reason: 'period_missing' };
    const kept = () => this.ev<{ ok: boolean }>(sid, PERIOD_SET_SCRIPT, { spec: spec.period, period: { from, to }, check: true });
    if (!(await kept())?.ok) return { ok: false, reason: 'period_not_set' };
    // 3. 조회
    const s = await this.searchOnce(sid, screen, spec, spec.search);
    if (!s.ok) return s;
    if (!(await kept())?.ok) return { ok: false, reason: 'period_not_set' };
    // 4. 쪽을 넘기며 읽는다
    const grids: Cells[][] = spec.grids.map(() => []);
    let total: number | null = null;
    let sum: number | null = null;
    let prevSig = '';
    for (let page = 1; ; page++) {
      if (page > REPORT_PAGES_MAX) return { ok: false, reason: 'too_many_pages' };
      const r = await this.ev<{ ok: boolean; reason?: string; grids?: Cells[][]; total?: number | null; sum?: number | null; page?: number | null }>(sid, READ_SCRIPT, {
        grids: spec.grids, total: spec.total ?? null, sum: spec.sum ?? null, pager: spec.pager ?? null, maxRows: 1_000,
      });
      if (!r?.ok || !r.grids) return { ok: false, reason: r?.reason === 'grid_too_many' ? 'grid_too_many' : 'grid_unreadable' };
      // 결과 없음 안내가 떴는데 표에 줄이 남아 있으면 앞 조회의 줄이다. 그 줄을 이번 기간 것으로 받지 않는다.
      if (s.noData) {
        if (r.grids.some((g) => g.length > 0)) return { ok: false, reason: 'grid_stale' };
        break;
      }
      if (spec.sum && page === 1) sum = r.sum ?? null;
      if (spec.total) {
        if (r.total === null || r.total === undefined) return { ok: false, reason: 'total_unreadable' };
        if (total !== null && r.total !== total) return { ok: false, reason: 'total_changed' };
        total = r.total;
        if (r.page !== null && r.page !== undefined && r.page !== page && !(page === 1 && r.grids[0]!.length === 0)) return { ok: false, reason: 'page_not_moved' };
      }
      const sig = JSON.stringify(r.grids.map((g) => g[0] ?? null));
      if (page > 1 && sig === prevSig) return { ok: false, reason: 'page_not_moved' };
      prevSig = sig;
      r.grids.forEach((g, i) => grids[i]!.push(...g));
      const got = grids[0]!.length;
      if (got > REPORT_ROWS_MAX) return { ok: false, reason: 'too_many_rows' };
      // 쪽 넘김이 없는 화면(카드 매출자료)은 한 번 읽으면 끝이다
      if (!spec.total || !spec.pager) break;
      if (got >= total!) break;
      if (r.grids[0]!.length === 0) return { ok: false, reason: 'rows_short' };
      const next = await this.searchOnce(sid, screen, spec, `${spec.pager}${page + 1}`);
      if (!next.ok) return next.reason === 'button_missing' ? { ok: false, reason: 'rows_short' } : next;
    }
    if (spec.total && total !== null && grids[0]!.length !== total) return { ok: false, reason: 'rows_short' };
    const m = mapRows(screen, grids);
    if (!m.ok) return m;
    if (spec.sum && !s.noData) {
      if (sum === null) return { ok: false, reason: 'sum_unreadable' };
      if (m.rows.reduce((a, x) => a + ((x as { total: number }).total), 0) !== sum) return { ok: false, reason: 'sum_mismatch' };
    }
    return { ok: true, screen, from, to, total: m.rows.length, rows: m.rows };
  }
}
