import { createHash } from 'node:crypto';
import type { InputDecl } from './core/types.ts';
import { jcs } from './gate.ts';

/** 민원증명 승인 카드 id(GATE_CARDS). */
export const CERT_CARD = 'cert.confirm';

/** main → 엔진 run.startCert 인자. inputs 키는 그 패키지 playbook.inputs 선언 키다(예: purpose·submitTo·rrnDisclosure). */
export interface CertStartParams {
  runId: string;
  playbookId: string;
  inputs?: Record<string, unknown>;
  rehearsal?: boolean;
}

/** 빠진 필수 칸은 H-01과 같은 input.missing(데스크톱 문구 있음). 선언 밖 값·키는 데스크톱이 카드 선택지만 보내면 생기지 않는 오류다. */
export type CertInputCode = 'input.missing' | 'cert.input_invalid' | 'cert.input_unknown';

export type CertInputResult = { ok: true; inputs: Record<string, string> } | { ok: false; code: CertInputCode; field: string };

const MAX_LEN = 100;
// eslint-disable-next-line no-control-regex -- 제어 문자를 거르는 것이 목적이다
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SCALAR = new Set<InputDecl['type']>(['enum', 'string', 'date']);

/**
 * 패키지 선언으로 입력을 검사하고 기본값을 채운다. 값은 문자열만(앞뒤 공백은 잘라 낸다).
 * - 선언에 없는 키 → cert.input_unknown
 * - 값이 없고 기본값도 없는데 required → input.missing(빈 문자열도 없음으로 본다)
 * - 문자열이 아님·위험 문자·너무 김·enum 밖·date 모양 아님·지원하지 않는 선언 종류 → cert.input_invalid
 */
export function certInputs(decl: Readonly<Record<string, InputDecl>>, raw: unknown): CertInputResult {
  if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) return { ok: false, code: 'cert.input_invalid', field: '' };
  const given = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(given)) if (!Object.hasOwn(decl, k)) return { ok: false, code: 'cert.input_unknown', field: k.slice(0, 40).replace(/[^A-Za-z0-9_]/g, '_') };
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(decl)) {
    if (!SCALAR.has(d.type)) return { ok: false, code: 'cert.input_invalid', field: k };
    let v: unknown = given[k];
    if (typeof v === 'string') v = v.trim();
    if (v === undefined || v === null || v === '') v = d.default;
    if (v === undefined || v === null || v === '') {
      if (d.required) return { ok: false, code: 'input.missing', field: k };
      continue;
    }
    if (typeof v !== 'string' || v.length > MAX_LEN || UNSAFE.test(v)) return { ok: false, code: 'cert.input_invalid', field: k };
    const s = v.normalize('NFC');
    if (d.type === 'enum' && !(d.values ?? []).includes(s)) return { ok: false, code: 'cert.input_invalid', field: k };
    if (d.type === 'date' && !DATE.test(s)) return { ok: false, code: 'cert.input_invalid', field: k };
    out[k] = s;
  }
  return { ok: true, inputs: out };
}

/**
 * 민원증명 업무 키(원장 business_key): SHA-256(JCS{kind, playbookId, bizNo, day, inputs}). 같은 날 같은 사업자가 같은 서류를 같은 입력으로
 * 다시 떼려 하면 같은 값이다(승인 카드 $dup.businessKey). 값 자체는 원장에 해시로만 남는다.
 */
export function certBusinessKey(x: { playbookId: string; bizNo: string; day: string; inputs: Readonly<Record<string, string>> }): string {
  return createHash('sha256').update(jcs({ kind: 'cert', playbookId: x.playbookId, bizNo: x.bizNo.replace(/\D/g, ''), day: x.day, inputs: x.inputs })).digest('hex');
}

export const INSTANT_CERTS = [
  { code: 'H-30', id: 'hometax.cert.income_amount', docType: 'income_amount_cert', menuCode: '4315011000', name: '소득금액증명', label: '소득금액증명' },
  { code: 'H-31', id: 'hometax.cert.tax_paid_history', docType: 'tax_paid_history_cert', menuCode: '4315010200', name: '납부내역증명(납세사실증명)', label: '납부내역증명' },
  { code: 'H-32', id: 'hometax.cert.closure', docType: 'closure_fact_cert', menuCode: '4315011700', name: '폐업사실증명', label: '폐업사실증명' },
  { code: 'H-33', id: 'hometax.cert.suspension', docType: 'suspension_fact_cert', menuCode: '4315011900', name: '휴업사실증명', label: '휴업사실증명' },
  { code: 'H-34', id: 'hometax.cert.exempt_revenue', docType: 'exempt_revenue_cert', menuCode: '4315010600', name: '부가가치세 면세사업자 수입금액증명', label: '면세사업자 수입금액증명' },
  { code: 'H-35', id: 'hometax.cert.model_taxpayer', docType: 'model_taxpayer_cert', menuCode: '4315010400', name: '모범납세자증명', label: '모범납세자증명' },
  { code: 'H-36', id: 'hometax.cert.unit_branch', docType: 'unit_branch_cert', menuCode: '4315010700', name: '사업자단위과세 적용 종된사업장증명', label: '종된사업장증명' },
  { code: 'H-37', id: 'hometax.cert.eitc_receipt', docType: 'eitc_receipt_cert', menuCode: '4315010100', name: '근로(자녀)장려금 수급사실 증명', label: '장려금 수급사실 증명' },
  { code: 'H-38', id: 'hometax.cert.pension_deduction', docType: 'pension_deduction_cert', menuCode: '4315011600', name: '연금보험료등 소득·세액 공제확인서', label: '연금보험료 공제확인서' },
  { code: 'H-39', id: 'hometax.cert.income_isa', docType: 'income_isa_cert', menuCode: '4315011100', name: '소득확인증명서(개인종합자산관리계좌가입)', label: '소득확인증명서(ISA)' },
  { code: 'H-40', id: 'hometax.cert.income_coop', docType: 'income_coop_cert', menuCode: '4315012000', name: '소득확인증명서(조합 등 출자금·예탁금 과세특례 신청용)', label: '소득확인증명서(조합 출자금)' },
  { code: 'H-41', id: 'hometax.cert.income_youth_leap', docType: 'income_youth_leap_cert', menuCode: '4315011200', name: '소득확인증명서(청년도약계좌 가입 및 과세특례 신청용)', label: '소득확인증명서(청년도약계좌)' },
  { code: 'H-42', id: 'hometax.cert.income_youth_housing', docType: 'income_youth_housing_cert', menuCode: '4315011300', name: '소득확인증명서(청년우대형주택청약종합저축 가입 및 과세특례 신청용)', label: '소득확인증명서(청년주택청약)' },
  { code: 'H-43', id: 'hometax.cert.income_youth_fund', docType: 'income_youth_fund_cert', menuCode: '4315011400', name: '소득확인증명서(청년형 장기집합투자증권저축 가입 및 과세특례 신청용)', label: '소득확인증명서(청년형 장기집합투자)' },
  { code: 'H-44', id: 'hometax.cert.income_youth_hope', docType: 'income_youth_hope_cert', menuCode: '4315011500', name: '소득확인증명서(청년희망적금 가입 및 과세특례 신청용)', label: '소득확인증명서(청년희망적금)' },
  { code: 'H-45', id: 'hometax.cert.income_youth_future', docType: 'income_youth_future_cert', menuCode: '4315012100', name: '소득확인증명서(청년미래적금 가입 및 과세특례 신청용)', label: '소득확인증명서(청년미래적금)' },
] as const;
export type InstantCertDocType = (typeof INSTANT_CERTS)[number]['docType'];
