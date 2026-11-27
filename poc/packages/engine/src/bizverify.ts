import { BIZ_STATUS_PER_CALL, EgressError, GatewayError, type Egress } from '@sax/net';


export interface BizStatus {
  bizNo: string;
  statusCode: '01' | '02' | '03' | '';
  status: string;
  taxType: string;
  closedAt: string | null;
}

export interface ValidateInput {
  bizNo: string;
  startDate: string;
  repName: string;
  name?: string;
}

export interface ValidateResult {
  bizNo: string;
  valid: boolean;
  validCode: string;
  message: string | null;
  status: BizStatus | null;
}

export class BizVerifyError extends Error {
  readonly code: 'no_key' | 'unauthorized' | 'quota' | 'upstream' | 'network' | 'bad_request';
  constructor(code: BizVerifyError['code']) {
    super(code);
    this.code = code;
  }
}

type Json = Record<string, unknown>;

const toStatus = (r: Json): BizStatus => ({
  bizNo: String(r.b_no ?? ''),
  statusCode: String(r.b_stt_cd ?? '') as BizStatus['statusCode'],
  status: String(r.b_stt ?? ''),
  taxType: String(r.tax_type ?? ''),
  closedAt: r.end_dt ? String(r.end_dt) : null,
});

export class BizVerifier {
  private readonly egress: Egress;
  private key: string | null = null;

  constructor(egress: Egress) {
    this.egress = egress;
  }

  setServiceKey(key: string | null): void {
    this.key = key && key.trim() ? key.trim() : null;
  }

  get hasKey(): boolean {
    return this.key !== null;
  }

  private headers(): Record<string, string> {
    if (!this.key) throw new BizVerifyError('no_key');
    return { authorization: `Infuser ${this.key}` };
  }

  private async call(path: '/api/nts-businessman/v1/status' | '/api/nts-businessman/v1/validate', body: Json): Promise<Json[]> {
    let res;
    try {
      res = await this.egress.postJson('odcloud', path, body, this.headers());
    } catch (e) {
      if (e instanceof BizVerifyError) throw e;
      throw new BizVerifyError(e instanceof EgressError && e.code === 'bad_response' ? 'upstream' : 'network');
    }
    if (res.status === 401 || res.status === 403) throw new BizVerifyError('unauthorized');
    if (res.status === 429) throw new BizVerifyError('quota');
    if (res.status === 400 || res.status === 413) throw new BizVerifyError('bad_request');
    if (res.status !== 200) throw new BizVerifyError('upstream');
    const data = (res.json as Json | null)?.data;
    if (!Array.isArray(data)) throw new BizVerifyError('upstream');
    return data as Json[];
  }

  async status(bizNos: string[]): Promise<BizStatus[]> {
    const b_no = bizNos.map((b) => b.replace(/\D/g, ''));
    if (b_no.length === 0 || b_no.length > 100) throw new BizVerifyError('bad_request');
    return (await this.call('/api/nts-businessman/v1/status', { b_no })).map(toStatus);
  }

  /**
   * 여러 거래처의 휴폐업 상태(대량 발급 ADR-059 결정 4). 공공데이터 키가 있으면 직접 100개씩, 없으면 게이트웨이 /v1/biz/status로 10개씩 묻는다.
   * 조회하지 못한 번호는 결과에서 빠진다(호출한 쪽이 "모름"으로 둔다). 멈춘 까닭은 code로 돌려준다.
   */
  async statusMany(bizNos: string[]): Promise<{ statuses: BizStatus[]; code: BizVerifyError['code'] | null }> {
    const uniq = [...new Set(bizNos.map((b) => b.replace(/\D/g, '')).filter((b) => /^[0-9]{10}$/.test(b)))];
    const out: BizStatus[] = [];
    const per = this.key ? 100 : BIZ_STATUS_PER_CALL;
    for (let i = 0; i < uniq.length; i += per) {
      const chunk = uniq.slice(i, i + per);
      try {
        out.push(...(this.key ? await this.status(chunk) : await this.statusByGateway(chunk)));
      } catch (e) {
        return { statuses: out, code: e instanceof BizVerifyError ? e.code : 'network' };
      }
    }
    return { statuses: out, code: null };
  }

  private async statusByGateway(b_no: string[]): Promise<BizStatus[]> {
    let r: unknown;
    try {
      r = await this.egress.toGateway({ surface: 'bizStatus', body: { b_no } });
    } catch (e) {
      if (e instanceof GatewayError && (e.code === 'gateway.rate_limited' || e.code === 'gateway.quota_exceeded')) throw new BizVerifyError('quota');
      if (e instanceof GatewayError && e.code === 'gateway.unauthorized') throw new BizVerifyError('unauthorized');
      throw new BizVerifyError(e instanceof GatewayError ? 'upstream' : 'network');
    }
    const data = (r as Json | null)?.data;
    if (!Array.isArray(data)) throw new BizVerifyError('upstream');
    return (data as Json[]).map(toStatus);
  }

  async validate(input: ValidateInput): Promise<ValidateResult> {
    const business = [{
      b_no: input.bizNo.replace(/\D/g, ''),
      start_dt: input.startDate.replace(/\D/g, ''),
      p_nm: input.repName.trim(),
      ...(input.name ? { b_nm: input.name.trim() } : {}),
    }];
    const [r] = await this.call('/api/nts-businessman/v1/validate', { businesses: business });
    if (!r) throw new BizVerifyError('upstream');
    return {
      bizNo: String(r.b_no ?? business[0]!.b_no),
      valid: r.valid === '01',
      validCode: String(r.valid ?? ''),
      message: r.valid_msg ? String(r.valid_msg) : null,
      status: r.status ? toStatus(r.status as Json) : null,
    };
  }
}
