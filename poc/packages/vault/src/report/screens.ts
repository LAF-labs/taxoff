/**
 * 월 리포트 홈택스 자동 받기의 조회 화면 표(ADR-068 결정 6). 금고 고정 스크립트(read.ts)만 이 표를 쓴다. 엔진과 패키지는 바꿀 수 없다.
 * id, 열, 요청(actionId)은 2026-11-25 맥북 실측(/mnt/project-files/hometax-ref/report-probe.md, list-probe.md)이다. id는 앞의 `mf_txppWframe_`를 뺐다.
 * 시험용 가짜 홈택스(tests/hometax-fake.ts)도 같은 id를 쓴다.
 */

/** 받는 자료 종류. 엔진 bank/hometax-sync.ts SYNC_KINDS와 같은 이름이다. */
export const REPORT_SCREEN_IDS = ['sale_invoice', 'purchase_invoice', 'cash_receipt_in', 'cash_receipt_out', 'card_sales', 'business_card'] as const;
export type ReportScreenId = (typeof REPORT_SCREEN_IDS)[number];

/** 화면마다 한 번에 고르는 기간. range = 날짜 범위(3개월 이내), month = 달 하나, quarter = 분기 하나. */
export type PeriodUnit = 'range' | 'month' | 'quarter';

/** 기간 고르기 방법. 스크립트 PERIOD_SCRIPT가 kind로 갈래를 탄다. */
export type PeriodSpec =
  /** 세금계산서 목록조회: 매출/매입 라디오, 날짜 두 칸, 쪽 크기, 공급자(받는자) 번호 거르기를 전체로 */
  | { kind: 'range'; radio: string; from: string; to: string; pageSize: { id: string; value: string }; partyKind: string }
  /** 현금영수증: 월별 탭을 누르고 년월 select(옵션 글 「2026년 11월」)를 고른다 */
  | { kind: 'month_tab'; tab: string; month: string }
  /** 사업용 카드: 월별 라디오를 누르고 년월 select를 고른다 */
  | { kind: 'month_radio'; radio: string; month: string }
  /** 카드 매출자료: 결제년도와 분기 from, to select(같은 분기 둘) */
  | { kind: 'quarter'; year: string; qFrom: string; qTo: string };

export interface GridSpec {
  id: string;
  /** 읽는 열(실측 열 id) */
  cols: readonly string[];
  /** 페이지 안에서 끝 4자리만 남기는 열(카드번호 16자리가 가림 없이 온다, 실측). 금고 밖으로 전체 번호가 나가지 않는다. */
  last4?: readonly string[];
}

export interface ScreenSpec {
  menu: string;
  /** 조회 요청 actionId. 이 요청이 끝난 횟수로 조회와 쪽 넘김이 끝났는지 본다. */
  action: string;
  unit: PeriodUnit;
  /** 화면이 다 떴는지 보는 id들(모두 있어야) */
  ready: readonly string[];
  period: PeriodSpec;
  search: string;
  grids: readonly GridSpec[];
  /** 총 건수 칸. 없으면 쪽 넘김이 없는 화면(카드 매출자료) */
  total?: string;
  /** 쪽 넘김 링크 id 앞부분(`pglNavi_page_{n}`) */
  pager?: string;
}

const INVOICE_COLS = ['wrtDt', 'dmnrTxprDscmNo', 'splrTxprDscmNo', 'tnmNm', 'rprsFnm', 'lsatNm', 'totaAmtStr', 'sumSplCftStr', 'sumTxamtStr', 'etan'] as const;
const invoice = (radio: string): ScreenSpec => ({
  menu: 'menuAtag_4609050100', action: 'ATEETBDA001R01', unit: 'range',
  ready: ['trigger50', 'resultGrid', radio],
  period: { kind: 'range', radio, from: 'inqrDtStrt_input', to: 'inqrDtEnd_input', pageSize: { id: 'selectbox90', value: '50' }, partyKind: 'selectbox5' },
  search: 'trigger50', grids: [{ id: 'resultGrid', cols: INVOICE_COLS }], total: 'txtTotal', pager: 'pglNavi_page_',
});

export const SCREENS: Readonly<Record<ReportScreenId, ScreenSpec>> = {
  sale_invoice: invoice('radio7_input_0'),
  purchase_invoice: invoice('radio7_input_1'),
  cash_receipt_in: {
    menu: 'menuAtag_4606010100', action: 'ATECRCBA001R03', unit: 'month',
    ready: ['trigger1', 'grdCshpt', 'tabControl1_UTECRCB057_tab_tabs3_tabHTML'],
    period: { kind: 'month_tab', tab: 'tabControl1_UTECRCB057_tab_tabs3_tabHTML', month: 'selectbox5' },
    search: 'trigger1', grids: [{ id: 'grdCshpt', cols: ['trsDtm', 'splCft', 'vaTxamt', 'tip', 'totaTrsAmt', 'aprvNo', 'trsClNm'] }], total: 'txtTotal', pager: 'pglNavi_page_',
  },
  cash_receipt_out: {
    menu: 'menuAtag_4605010100', action: 'ATECRCBA001R02', unit: 'month',
    ready: ['trigger1', 'grdCshpt', 'tabControl1_UTECRCB005_tab_tabs3_tabHTML'],
    period: { kind: 'month_tab', tab: 'tabControl1_UTECRCB005_tab_tabs3_tabHTML', month: 'selectbox5' },
    search: 'trigger1',
    grids: [{ id: 'grdCshpt', cols: ['trsDtTime', 'mrntTxprDscmNoEncCntn', 'mrntTxprNm', 'splCft', 'vaTxamt', 'tip', 'totaTrsAmt', 'aprvNo', 'trsClNm', 'prhTxamtDdcClNm'] }],
    total: 'txtTotal', pager: 'pglNavi_page_',
  },
  card_sales: {
    menu: 'menuAtag_4607010000', action: 'ATESFAAA014R02', unit: 'quarter',
    ready: ['trigger163', 'selectStlYr', 'grdCrdcTrsBrkdMateAdmDVOList'],
    period: { kind: 'quarter', year: 'selectStlYr', qFrom: 'selectQrtFrom', qTo: 'selectQrtTo' },
    search: 'trigger163',
    grids: [
      { id: 'grdCrdcTrsBrkdMateAdmDVOList', cols: ['stlYm', 'mateKndNm', 'stlScnt', 'totaStlAmt'] },
      { id: 'grdSleVcexSlsMateInqrDVOList', cols: ['stlYm', 'sumStlScnt', 'sumTipExclAmt', 'txprNm'] },
    ],
  },
  business_card: {
    menu: 'menuAtag_4608020100', action: 'ATECRCCA001R06', unit: 'month',
    ready: ['btnSearch', 'grdCshpt', 'rdoSearch_input_1'],
    period: { kind: 'month_radio', radio: 'rdoSearch_input_1', month: 'selectbox6' },
    search: 'btnSearch',
    grids: [{
      id: 'grdCshpt', cols: ['aprvDt', 'busnCrdCardNoEncCntn', 'mrntTxprDscmNoEncCntn', 'mrntTxprNm', 'splCft', 'vaTxamt', 'tip', 'totaTrsAmt', 'ddcYnNm', 'busnCrdcTrsBrkdSn'],
      last4: ['busnCrdCardNoEncCntn'],
    }],
    total: 'txtTotal', pager: 'pglNavi_page_',
  },
};
