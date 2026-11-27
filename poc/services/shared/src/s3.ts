import { createHash, createHmac } from 'node:crypto';

/** S3 호환 저장소 접속값(경로 방식, 표준 SigV4만). 레지스트리 공개 버킷과 문서함 비공개 버킷이 같이 쓴다. */
export interface S3Opts {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

const EMPTY_SHA = createHash('sha256').digest('hex');
const sha256hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const hmac = (k: Buffer | string, s: string) => createHmac('sha256', k).update(s, 'utf8').digest();
const enc = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const amzDateOf = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

/**
 * AWS Signature Version 4 Authorization 헤더(서비스 s3, 쿼리 없음). headers는 서명할 헤더 전부(host 포함, 이름 소문자).
 * 공개 시험 벡터(AWS 문서 GET Object 예)로 확인한다.
 */
export function sigV4Authorization(o: {
  method: string;
  path: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  amzDate: string;
}): string {
  const names = Object.keys(o.headers).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(o.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonical = [o.method, o.path, '', canonicalHeaders, signedHeaders, o.payloadHash].join('\n');
  const date = o.amzDate.slice(0, 8);
  const scope = `${date}/${o.region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', o.amzDate, scope, sha256hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${o.secretAccessKey}`, date), o.region), 's3'), 'aws4_request');
  return `AWS4-HMAC-SHA256 Credential=${o.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${createHmac('sha256', key).update(toSign, 'utf8').digest('hex')}`;
}

/** 버킷 하나에 서명한 요청을 보낸다. 접속값이 틀리면 만들 때 던진다(config_S3_*). */
export class S3Client {
  private readonly base: URL;
  private readonly o: S3Opts;
  constructor(o: S3Opts) {
    let u: URL;
    try {
      u = new URL(o.endpoint);
    } catch {
      throw new Error('config_S3_ENDPOINT');
    }
    const local = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
    if ((u.protocol !== 'https:' && !local) || u.search || u.hash || u.username || u.password) throw new Error('config_S3_ENDPOINT');
    if (!/^[a-z0-9-]{2,32}$/.test(o.region)) throw new Error('config_S3_REGION');
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(o.bucket)) throw new Error('config_S3_BUCKET');
    if (!o.accessKeyId || !o.secretAccessKey) throw new Error('config_S3_ACCESS_KEY');
    this.base = u;
    this.o = o;
  }

  /** key는 부르는 쪽이 검사한 경로다(조각마다 URL 인코딩한다). */
  send(method: 'GET' | 'PUT' | 'DELETE', key: string, body?: Uint8Array, extra: Record<string, string> = {}): Promise<Response> {
    const prefix = this.base.pathname.replace(/\/+$/, '');
    const path = `${prefix}/${enc(this.o.bucket)}/${key.split('/').map(enc).join('/')}`;
    const payloadHash = body ? sha256hex(body) : EMPTY_SHA;
    const amzDate = amzDateOf((this.o.now ?? Date.now)());
    const headers: Record<string, string> = { host: this.base.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, ...extra };
    const authorization = sigV4Authorization({ method, path, headers, payloadHash, region: this.o.region, accessKeyId: this.o.accessKeyId, secretAccessKey: this.o.secretAccessKey, amzDate });
    const send = Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'host'));
    return (this.o.fetchFn ?? fetch)(`${this.base.origin}${path}`, {
      method,
      headers: { ...send, authorization },
      body: body ? new Uint8Array(body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
    });
  }

  /** 본문을 상한까지만 읽는다. 404는 null. */
  async getBytes(key: string, max: number): Promise<Buffer | null> {
    const r = await this.send('GET', key);
    if (r.status === 404) {
      await r.body?.cancel();
      return null;
    }
    if (r.status !== 200) {
      await r.body?.cancel();
      throw new Error(`store_s3_get_${r.status}`);
    }
    if (Number(r.headers.get('content-length') ?? '0') > max) {
      await r.body?.cancel();
      throw new Error('store_s3_too_large');
    }
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > max) throw new Error('store_s3_too_large');
    return b;
  }

  async putBytes(key: string, bytes: Uint8Array, headers: Record<string, string>): Promise<void> {
    const r = await this.send('PUT', key, bytes, headers);
    await r.body?.cancel();
    if (r.status !== 200) throw new Error(`store_s3_put_${r.status}`);
  }

  /** 없는 객체도 성공이다(S3는 204, Supabase는 200). */
  async deleteKey(key: string): Promise<void> {
    const r = await this.send('DELETE', key);
    await r.body?.cancel();
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new Error(`store_s3_delete_${r.status}`);
  }
}
