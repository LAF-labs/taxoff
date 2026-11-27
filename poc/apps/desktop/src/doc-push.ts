import { DOC_ID, DOC_MAX_BYTES, docChunkBodies, docListPages, type Channel, type DocListItem, type DocWantBody } from '@sax/remote';
import type { DocPhoneRow } from '@sax/engine';

export interface DocSource {
  list(): Promise<DocPhoneRow[]>;
  read(id: string): Promise<Uint8Array>;
}

/** 릴레이 우편함 한도가 초당 20개라 그 절반으로 보낸다. */
const CHUNK_GAP_MS = 100;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

export function docListItems(rows: readonly DocPhoneRow[]): DocListItem[] {
  return rows
    .filter((r) => DOC_ID.test(r.id) && /^[a-z_]{1,40}$/.test(r.docType) && /^[0-9a-f]{64}$/.test(r.sha256) && Number.isSafeInteger(r.bytes) && r.bytes >= 1 && r.bytes <= DOC_MAX_BYTES)
    .map((r) => ({
      docId: r.id,
      name: clip(r.name.trim() || '서류', 80),
      docType: r.docType,
      ...(r.issuedOn && DAY.test(r.issuedOn) ? { issuedOn: r.issuedOn } : {}),
      ...(r.expiresOn && DAY.test(r.expiresOn) ? { expiresOn: r.expiresOn } : {}),
      bytes: r.bytes,
      sha256: r.sha256,
    }));
}

export class DocPush {
  readonly #src: DocSource;
  readonly #log: (name: string, data: Record<string, string | number | boolean>) => void;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #chain = new WeakMap<Channel, Promise<void>>();
  readonly #live = new Set<Channel>();

  constructor(o: { source: DocSource; log?: (name: string, data: Record<string, string | number | boolean>) => void; sleep?: (ms: number) => Promise<void>; now?: () => number }) {
    this.#src = o.source;
    this.#log = o.log ?? (() => {});
    this.#sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.#now = o.now ?? Date.now;
  }

  open(ch: Channel): Promise<void> {
    this.#live.add(ch);
    return this.#queue(ch, () => this.#sendList(ch));
  }

  close(ch: Channel): void {
    this.#live.delete(ch);
  }

  want(ch: Channel, body: DocWantBody): Promise<void> {
    return this.#queue(ch, () => this.#sendDoc(ch, body.docId));
  }

  async refresh(): Promise<void> {
    await Promise.all([...this.#live].map((ch) => this.#queue(ch, () => this.#sendList(ch))));
  }

  #queue(ch: Channel, job: () => Promise<void>): Promise<void> {
    const next = (this.#chain.get(ch) ?? Promise.resolve()).then(() => (ch.closed ? undefined : job()));
    this.#chain.set(ch, next.catch(() => {}));
    return next.catch((e: unknown) => this.#log('main.phone_docs', { step: 'failed', error: e instanceof Error ? clip(e.name, 40) : 'error' }));
  }

  async #sendList(ch: Channel): Promise<void> {
    const items = docListItems(await this.#src.list());
    const pages = docListPages(items, this.#now());
    for (const p of pages) {
      if (ch.closed) return;
      ch.send('doc.list', p);
    }
    this.#log('main.phone_docs', { step: 'list', docs: items.length, pages: pages.length });
  }

  async #sendDoc(ch: Channel, docId: string): Promise<void> {
    const row = docListItems(await this.#src.list()).find((r) => r.docId === docId);
    if (!row) {
      this.#log('main.phone_docs', { step: 'want_unknown' });
      return;
    }
    const bytes = await this.#src.read(docId);
    if (bytes.length !== row.bytes) {
      this.#log('main.phone_docs', { step: 'file_mismatch' });
      return;
    }
    const chunks = docChunkBodies(docId, bytes);
    for (const [i, c] of chunks.entries()) {
      if (ch.closed) return;
      if (i > 0) await this.#sleep(CHUNK_GAP_MS);
      ch.send('doc.chunk', c);
    }
    this.#log('main.phone_docs', { step: 'sent', chunks: chunks.length });
  }
}
