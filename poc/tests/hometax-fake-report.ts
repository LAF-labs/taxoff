/**
 * 가짜 홈택스의 월 리포트 조회 화면(ADR-068 결정 6). id, 열, 요청은 2026-11-25 맥북 실측(/mnt/project-files/hometax-ref/report-probe.md)과 같다.
 * 화면 글과 배치는 실화면과 다르다(값만 같다). REPORT_CLIENT는 hometax-fake.ts CLIENT 안에 들어가 그 도우미($, P, wrap, header, act, perm)를 쓴다.
 * 실화면에서 확인하지 못한 것(쪽 넘김 링크가 쪽마다 같은 요청을 다시 보내는지, 결과 없음 안내가 뜨는지)은 가정이고 knobs로 바꿔 본다.
 */

/** 가짜 홈택스에 심는 조회 자료. 열 id와 값 모양은 실측 그대로다(금액은 쉼표 없는 글자, 날짜는 실측 꼴). */
export interface FakeReportData {
  /** 세금계산서 매입 목록 줄. 공급받는자는 가짜 홈택스 사업자다. */
  purchases: Array<{ etan: string; wrtDt: string; splrTxprDscmNo: string; tnmNm: string; rprsFnm: string; lsatNm: string; totaAmtStr: string; sumSplCftStr: string; sumTxamtStr: string }>;
  /** 현금영수증 매출(trsDtm 9999-99-99 99:99:99) */
  cashIn: Array<Record<string, string>>;
  /** 현금영수증 매입(trsDtTime) */
  cashOut: Array<Record<string, string>>;
  /** 사업용 카드(aprvDt 9999-99-99, busnCrdCardNoEncCntn 카드번호 16자리 전체) */
  bizCard: Array<Record<string, string>>;
  /** 카드 매출자료: 카드사 달 합계와 판매대행 달 합계(stlYm yyyymm) */
  cardSales: { card: Array<Record<string, string>>; pg: Array<Record<string, string>> };
}

export interface FakeReportKnobs {
  /** 조회 결과가 0건이면 「조회된 자료가 없습니다.」 alert를 띄운다(실화면은 0건에 안내가 없었다, 실측. 가정 갈래 시험용) */
  reportEmptyAlert: boolean;
  /** 이 화면(menu 숫자)의 [조회]에서 이 alert를 띄우고 요청하지 않는다(점검, 세션 만료 같은 안내) */
  reportAlert: { menu: string; text: string } | null;
  /** 쪽 넘김 링크를 눌러도 쪽이 바뀌지 않는다(금고가 page_not_moved로 멈춰야 한다) */
  reportPagerStuck: boolean;
  /** 목록조회 화면이 다 그려진 뒤 초기화 요청을 보내고, 끝나면 기간 칸과 쪽 크기를 기본값(오늘, 10줄)으로 되돌린다(11/25 실측) */
  reportLateInit: boolean;
  /** 세금계산서 목록 합계 칸을 이만큼 어긋나게 보인다(합계 검산 시험) */
  reportSumOff: number;
}

export const emptyReport = (): FakeReportData => ({ purchases: [], cashIn: [], cashOut: [], bizCard: [], cardSales: { card: [], pg: [] } });

/** 화면별 쪽 크기(실측: 현금영수증 매출은 고정 쪽, 매입 10 기본, 사업용 카드 20 고정). 가짜는 매출도 10으로 둔다. */
const PAGE: Readonly<Record<string, number>> = { ATECRCBA001R03: 10, ATECRCBA001R02: 10, ATECRCCA001R06: 20 };

/** 서버 쪽: 조회 요청 하나에 기간에 맞는 줄 전체를 돌려준다(쪽 자르기는 화면이 한다). */
export function reportAct(actionId: string, body: Record<string, unknown>, data: FakeReportData): unknown {
  const ym = String(body.ym ?? '');
  const inMonth = (d: string) => d.replace(/[^0-9]/g, '').slice(0, 6) === ym;
  switch (actionId) {
    case 'ATECRCBA001R03':
      return { rows: data.cashIn.filter((r) => inMonth(r.trsDtm ?? '')), size: PAGE[actionId] };
    case 'ATECRCBA001R02':
      return { rows: data.cashOut.filter((r) => inMonth(r.trsDtTime ?? '')), size: PAGE[actionId] };
    case 'ATECRCCA001R06':
      return { rows: data.bizCard.filter((r) => inMonth(r.aprvDt ?? '')), size: PAGE[actionId] };
    case 'ATESFAAA014R02': {
      const y = String(body.year ?? '');
      const qf = Number(body.qFrom ?? 0);
      const qt = Number(body.qTo ?? 0);
      const inQ = (s: string) => s.slice(0, 4) === y && Math.floor((Number(s.slice(4, 6)) - 1) / 3) + 1 >= qf && Math.floor((Number(s.slice(4, 6)) - 1) / 3) + 1 <= qt;
      return { card: data.cardSales.card.filter((r) => inQ(r.stlYm ?? '')), pg: data.cardSales.pg.filter((r) => inQ(r.stlYm ?? '')) };
    }
    default:
      return null;
  }
}

/** 화면 쪽(가짜 홈택스 CLIENT 안). */
export const REPORT_CLIENT = String.raw`
  // ---------------- 월 리포트 조회 화면(report-probe.md) ----------------
  const comps = {};
  window.$p = { getComponentById: (id) => comps[id] || null };
  const ymOptions = () => {
    const [y, m] = C.today.split('-').map(Number);
    const out = [];
    for (let i = 0; i < 37; i++) { const t = new Date(Date.UTC(y, m - 1 - i, 1)); const mm = t.getUTCMonth() + 1; out.push(t.getUTCFullYear() + '년 ' + (mm < 10 ? '0' + mm : mm) + '월'); }
    return out;
  };
  const sel = (id, title, opts, extra) => '<select id="' + P + id + '" title="' + title + '"' + (extra || '') + '>' + opts.map((o) => '<option value="' + o + '">' + o + '</option>').join('') + '</select>';
  const btn = (id, val) => '<input type="button" id="' + P + id + '" value="' + val + '">';
  // WebSquare 표: 화면은 지금 쪽 줄만 갖는다. 열 id로 값을 준다.
  function gridComp(id, cols) {
    let rows = [];
    const c = { rows: () => rows, set: (xs) => { rows = xs; render(); }, getRowCount: () => rows.length, getCellData: (r, col) => (rows[r] ? rows[r][col] : undefined) };
    const render = () => { $(P + id).querySelector('tbody').innerHTML = rows.map((x) => '<tr class="grid_body_row">' + cols.map((k) => '<td data-col_id="' + k + '">' + (x[k] ?? '') + '</td>').join('') + '</tr>').join(''); };
    comps[P + id] = c;
    return '<div id="' + P + id + '" class="w2grid" role="grid"><table><thead><tr>' + cols.map((k) => '<th>' + k + '</th>').join('') + '</tr></thead><tbody></tbody></table></div>';
  }
  // 쪽 넘김(w2pagination): pglNavi_page_{n}, 지금 쪽은 class active. 누르면 같은 조회 요청을 다시 보내고 그 쪽 줄을 그린다(가정).
  function pager(onPage) {
    const box = document.createElement('div');
    box.id = P + 'pglNavi';
    const draw = (cur, pages) => {
      box.innerHTML = Array.from({ length: pages }, (_, i) => '<a href="#" id="' + P + 'pglNavi_page_' + (i + 1) + '" class="w2pageList_control_label' + (i + 1 === cur ? ' active' : '') + '">' + (i + 1) + '</a>').join(' ');
      for (let i = 1; i <= pages; i++) $(P + 'pglNavi_page_' + i).onclick = (e) => { e.preventDefault(); onPage(i); };
    };
    return { box, draw };
  }
  function pagedSearch(o) {
    let all = [], size = 10, cur = 1;
    const pg = pager(async (n) => { await o.request(); if (!C.reportPagerStuck) cur = n; show(); });
    const show = () => { const pages = Math.max(1, Math.ceil(all.length / size)); o.grid.set(all.slice((cur - 1) * size, cur * size)); $(P + 'txtTotal').textContent = String(all.length); pg.draw(cur, all.length ? pages : 0); };
    return {
      box: pg.box,
      async search() {
        if (C.reportAlert && C.reportAlert.menu === o.menu) { alert(C.reportAlert.text); return; }
        const r = await o.request();
        all = r.rows || []; size = r.size || o.size || 10; cur = 1; show();
        if (!all.length && C.reportEmptyAlert) alert('조회된 자료가 없습니다.');
      },
    };
  }
  const pickedYm = (id) => { const t = $(id).options[$(id).selectedIndex].text; const x = /(\d{4})\D+(\d{1,2})/.exec(t); return x[1] + (x[2].length < 2 ? '0' + x[2] : x[2]); };

  function cashScreen(o) {
    document.title = '국세청 홈택스 - ' + o.title;
    perm(o.screenId);
    const tabs = ['일별', '주별', '월별', '분기별'];
    wrap.innerHTML = header() + '<div id="mf_txppWframe"><h2>' + o.title + '</h2><div id="' + P + o.tab + '">' +
      tabs.map((t, i) => '<a href="#" id="' + P + o.tab + '_tab_tabs' + (i + 1) + '_tabHTML">' + t + '</a>').join(' ') + '</div><div id="' + P + 'periodBox"><input type="text" id="' + P + 'inputCalendar18_input" value="' + C.today + '"></div>' +
      btn('trigger1', '조회') + ' 총 <span id="' + P + 'txtTotal">0</span>건 ' + gridComp('grdCshpt', o.cols) + '</div>';
    let monthly = false;
    // 월별 탭을 눌러야 년월 칸이 생긴다(가짜: 늦게 그린다)
    $(P + o.tab + '_tab_tabs3_tabHTML').onclick = (e) => {
      e.preventDefault();
      setTimeout(() => { monthly = true; $(P + 'periodBox').innerHTML = sel('selectbox5', o.ymTitle, ymOptions()); }, 200);
    };
    const s = pagedSearch({ menu: o.menu, grid: comps[P + 'grdCshpt'], request: () => act(o.action, o.screenId, monthly ? { ym: pickedYm(P + 'selectbox5') } : { day: $(P + 'inputCalendar18_input').value }) });
    $('mf_txppWframe').append(s.box);
    $(P + 'trigger1').onclick = () => s.search();
  }

  function bizCardScreen() {
    document.title = '국세청 홈택스 - 사업용 신용카드 매입세액 공제 확인/변경';
    perm('UTECRCB023');
    const cols = ['chk', 'aprvDt', 'crcmClNm', 'busnCrdCardNoEncCntn', 'mrntTxprDscmNoEncCntn', 'mrntTxprNm', 'splCft', 'vaTxamt', 'tip', 'totaTrsAmt', 'bmanClNm', 'ddcYnNm', 'busnCrdcTrsBrkdSn'];
    const radio = (i, t) => '<input type="radio" name="rdoSearch" id="' + P + 'rdoSearch_input_' + i + '"' + (i === 0 ? ' checked' : '') + '><label>' + t + '</label>';
    wrap.innerHTML = header() + '<div id="mf_txppWframe"><h2>매입세액 공제 확인/변경</h2>' + radio(0, '일별') + radio(1, '월별') + radio(2, '분기별') +
      '<div id="' + P + 'periodBox"><input type="text" id="' + P + 'inputCalendar_input" value="' + C.today + '"></div>' +
      btn('btnSearch', '조회') + btn('trigger19', '변경하기') + ' 총 <span id="' + P + 'txtTotal">0</span>건 ' + gridComp('grdCshpt', cols) + '</div>';
    let monthly = false;
    $(P + 'rdoSearch_input_1').onclick = () => setTimeout(() => { monthly = true; $(P + 'periodBox').innerHTML = sel('selectbox6', '년월 선택', ymOptions()); }, 200);
    // [변경하기]는 공제여부를 저장한다. 읽기 자동화가 누르면 안 된다(시험이 요청으로 잡는다).
    $(P + 'trigger19').onclick = () => act('ATECRCCA001C01', 'UTECRCB023', {});
    const s = pagedSearch({ menu: '4608020100', grid: comps[P + 'grdCshpt'], request: () => act('ATECRCCA001R06', 'UTECRCB023', monthly ? { ym: pickedYm(P + 'selectbox6') } : { day: $(P + 'inputCalendar_input').value }) });
    $('mf_txppWframe').append(s.box);
    $(P + 'btnSearch').onclick = () => s.search();
  }

  function cardSalesScreen() {
    document.title = '국세청 홈택스 - 신용카드, 판매(결제)대행 매출자료 조회';
    perm('UTESFABG35');
    const y = Number(C.today.slice(0, 4));
    const years = [y - 4, y - 3, y - 2, y - 1, y].map(String);
    const qs = ['1분기', '2분기', '3분기', '4분기'];
    wrap.innerHTML = header() + '<div id="mf_txppWframe"><h2>신용카드, 판매(결제)대행 매출자료 조회</h2>' + sel('selectStlYr', '결제년도', years) + sel('selectQrtFrom', '분기', qs) + sel('selectQrtTo', '분기', qs) + btn('trigger163', '조회') +
      gridComp('grdCrdcZrpSleStlVcexMateAdmDVOList', ['rowSeq', 'stlQrt', 'mateKndNm', 'stlScnt', 'totaStlAmt']) +
      gridComp('grdCrdcTrsBrkdMateAdmDVOList', ['rowSeq', 'stlYm', 'mateKndNm', 'stlScnt', 'totaStlAmt', 'etcSls', 'purcEuCardSls', 'tip']) +
      gridComp('grdSleVcexSlsMateInqrDVOList', ['rowSeq', 'stlYm', 'sumStlScnt', 'sumTipExclAmt', 'crdcAmt', 'etcAmt', 'txprNm']) + '</div>';
    $(P + 'selectStlYr').selectedIndex = 4; $(P + 'selectQrtFrom').selectedIndex = 0; $(P + 'selectQrtTo').selectedIndex = 1;
    const search = async () => {
      if (C.reportAlert && C.reportAlert.menu === '4607010000') { alert(C.reportAlert.text); return; }
      const qn = (id) => $(P + id).selectedIndex + 1;
      const r = await act('ATESFAAA014R02', 'UTESFABG35', { year: $(P + 'selectStlYr').value, qFrom: qn('selectQrtFrom'), qTo: qn('selectQrtTo') });
      comps[P + 'grdCrdcTrsBrkdMateAdmDVOList'].set((r.card || []).map((x, i) => ({ rowSeq: String(i + 1), ...x })));
      comps[P + 'grdSleVcexSlsMateInqrDVOList'].set((r.pg || []).map((x, i) => ({ rowSeq: String(i + 1), ...x })));
    };
    $(P + 'trigger163').onclick = () => search();
    // 화면을 열면 기본값(올해 1~2분기)으로 이미 조회돼 있다(실측)
    search();
  }
`;
