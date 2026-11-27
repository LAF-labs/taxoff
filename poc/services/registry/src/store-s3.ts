import { S3Client, type S3Opts } from '@sax/svc-shared';
import { checkKey, type Store } from './store.ts';

export { sigV4Authorization } from '@sax/svc-shared';
export type S3StoreOpts = S3Opts;

const MAX_OBJECT = 24 * 1024 * 1024;

/** 공개 파일의 Content-Type·Cache-Control(API.md 공개 GET 표). 공개 버킷이 이 메타데이터로 응답한다 */
export function objectMeta(key: string): { contentType: string; cacheControl: string } {
  if (key.startsWith('packages/')) return { contentType: 'application/octet-stream', cacheControl: 'public, max-age=31536000, immutable' };
  if (key.endsWith('.yml')) return { contentType: 'text/yaml; charset=utf-8', cacheControl: 'public, max-age=60' };
  return { contentType: 'application/json', cacheControl: 'public, max-age=60' };
}

export class S3Store implements Store {
  private readonly s3: S3Client;
  constructor(o: S3StoreOpts) {
    this.s3 = new S3Client(o);
  }

  async get(key: string): Promise<Buffer | null> {
    return this.s3.getBytes(checkKey(key), MAX_OBJECT);
  }

  async put(key: string, bytes: Buffer): Promise<void> {
    if (bytes.length > MAX_OBJECT) throw new Error('store_s3_too_large');
    const m = objectMeta(checkKey(key));
    await this.s3.putBytes(key, bytes, { 'content-type': m.contentType, 'cache-control': m.cacheControl });
  }
}

/** env(서비스 접두를 뗀 값) → S3 저장소. S3_ENDPOINT가 없으면 null */
export function s3StoreFromEnv(env: NodeJS.ProcessEnv): S3Store | null {
  if (!env.S3_ENDPOINT) return null;
  return new S3Store({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION ?? '', bucket: env.S3_BUCKET ?? '', accessKeyId: env.S3_ACCESS_KEY_ID ?? '', secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' });
}
