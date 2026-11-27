import { INSTANT_CERTS } from '@sax/engine';

export type CertCode = `H-${string}`;

export interface CertDocDef {
  code: CertCode;
  playbookId: string;
  name: string;
  label: string;
  docType: string;
  match: RegExp;
  purposes: readonly string[];
  submitTo: readonly string[];
  defaults: { purpose: string; submitTo: string };
  extra?: (today: string) => Record<string, string>;
  quick?: boolean;
}

const PURPOSES_COMMON = ['입찰, 계약용', '수금용', '관공서제출용', '대출용', '여권또는비자신청용', '건강보험·국민연금공단제출용', '금융기관제출용', '신용카드발급용', '기타'] as const;
const SUBMIT_COMMON = ['금융기관', '관공서', '조합/협회', '거래처', '학교', '외교부/재외공관/재외동포청', '기타'] as const;

const MATCH: Readonly<Record<(typeof INSTANT_CERTS)[number]['code'], RegExp>> = {
  'H-30': /소득\s*금액\s*증명|소득\s*증명원?/,
  'H-31': /납부\s*내역|납세\s*사실/,
  'H-32': /폐업\s*(사실)?\s*증명/,
  'H-33': /휴업\s*(사실)?\s*증명/,
  'H-34': /수입\s*금액\s*증명/,
  'H-35': /모범\s*납세/,
  'H-36': /종된\s*사업장/,
  'H-37': /장려금\s*(수급|받은)/,
  'H-38': /연금\s*보험료.*공제|공제\s*확인서/,
  'H-41': /도약\s*계좌/,
  'H-42': /청약/,
  'H-43': /집합\s*투자|펀드/,
  'H-44': /희망\s*적금/,
  'H-45': /미래\s*적금/,
  'H-40': /출자금|예탁금/,
  'H-39': /소득\s*확인\s*증명|ISA|개인\s*종합\s*자산/i,
};


const lastYear = (today: string) => String(Number(today.slice(0, 4)) - 1);

export const CERT_DOCS: readonly CertDocDef[] = [
  {
    code: 'H-03', playbookId: 'hometax.cert.biz_registration', name: '사업자등록증명', label: '사업자등록증명', docType: 'biz_registration_cert',
    match: /사업자\s*등록\s*증명/, quick: true, purposes: PURPOSES_COMMON, submitTo: SUBMIT_COMMON, defaults: { purpose: '금융기관제출용', submitTo: '금융기관' },
  },
  {
    code: 'H-04', playbookId: 'hometax.cert.taxpayment', name: '납세증명서', label: '납세증명서', docType: 'national_tax_cert',
    match: /^(?!.*지방세).*(납세\s*증명|국세\s*완납)/,
    purposes: ['대금수령', '관공서 제출', '금융기관 제출', '입찰 참가', '해외이주', '기타'], submitTo: ['관공서', '금융기관', '공공기관', '기타'],
    defaults: { purpose: '금융기관 제출', submitTo: '금융기관' },
  },
  {
    code: 'H-08', playbookId: 'hometax.cert.vat_tax_base', name: '부가가치세 과세표준증명', label: '부가세 과세표준증명', docType: 'vat_tax_base_cert',
    match: /과세\s*표준\s*증명|부가(가치)?세\s*(과표|증명)/, quick: true, purposes: PURPOSES_COMMON, submitTo: SUBMIT_COMMON, defaults: { purpose: '금융기관제출용', submitTo: '금융기관' },
    extra: (today) => ({ periodStartYear: lastYear(today), periodStartHalf: '1기', periodEndYear: lastYear(today), periodEndHalf: '2기' }),
  },
  {
    code: 'H-09', playbookId: 'hometax.cert.financial_statements', name: '표준재무제표증명', label: '표준재무제표증명', docType: 'financial_statements_cert',
    match: /재무\s*제표\s*증명|표준\s*재무/, quick: true, purposes: PURPOSES_COMMON, submitTo: SUBMIT_COMMON, defaults: { purpose: '금융기관제출용', submitTo: '금융기관' },
    extra: (today) => ({ fiscalYear: lastYear(today) }),
  },
  ...(Object.keys(MATCH) as Array<keyof typeof MATCH>).map((code) => {
    const d = INSTANT_CERTS.find((x) => x.code === code)!;
    return { code, playbookId: d.id, name: d.label, label: d.label, docType: d.docType, match: MATCH[code], purposes: PURPOSES_COMMON, submitTo: SUBMIT_COMMON, defaults: { purpose: '금융기관제출용', submitTo: '금융기관' } };
  }),
];

const PURPOSE_WORDS: ReadonlyArray<[RegExp, readonly string[], readonly string[]]> = [
  [/입찰|계약/, ['입찰, 계약용', '입찰 참가'], ['거래처', '관공서']],
  [/대출/, ['대출용', '금융기관제출용', '금융기관 제출'], ['금융기관']],
  [/은행|금융/, ['금융기관제출용', '금융기관 제출'], ['금융기관']],
  [/관공서|구청|시청|주민센터|관청/, ['관공서제출용', '관공서 제출'], ['관공서']],
  [/수금|대금|거래처/, ['수금용', '대금수령'], ['거래처', '기타']],
  [/카드/, ['신용카드발급용'], ['금융기관']],
  [/비자|여권/, ['여권또는비자신청용'], ['외교부/재외공관/재외동포청']],
  [/건강보험|국민연금|공단/, ['건강보험·국민연금공단제출용'], ['관공서', '공공기관']],
  [/해외\s*이주|이민/, ['해외이주'], ['기타']],
];

export const CERT_DOCS_SHOWN: readonly CertDocDef[] = CERT_DOCS.filter((d) => d.quick);

export function certDocOf(text: string): CertDocDef | null {
  return CERT_DOCS.find((d) => d.match.test(text)) ?? null;
}

export function certDocByCode(code: string): CertDocDef | null {
  return CERT_DOCS.find((d) => d.code === code || d.playbookId === code) ?? null;
}

export function certInputsFor(doc: CertDocDef, text: string, today: string): Record<string, string> {
  let purpose = doc.defaults.purpose;
  let submitTo = doc.defaults.submitTo;
  for (const [re, ps, ss] of PURPOSE_WORDS) {
    if (!re.test(text)) continue;
    const p = ps.find((x) => doc.purposes.includes(x));
    const s = ss.find((x) => doc.submitTo.includes(x));
    if (p) purpose = p;
    if (s) submitTo = s;
    break;
  }
  return { purpose, submitTo, ...(doc.extra ? doc.extra(today) : {}) };
}
