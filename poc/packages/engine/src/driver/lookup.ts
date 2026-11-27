import { randomUUID } from 'node:crypto';
import { probeLookupPopup } from '@sax/platform';
import type { Page, Response } from 'playwright-core';
import type { ActResult } from '../core/page.ts';
import { LOOKUP_POPUP_EXPOSE_FAILED, type LookupPort, type LookupRequest, type LookupResult, type LookupRow } from '../core/verify.ts';
import { hostAllowed } from '../core/validate.ts';
import type { LookupDef } from '../portal.ts';

/** 집행기에서 조회 포트가 쓰는 부분(RunEnforcer). */
export interface LookupPolicy {
  beforeAction(kind: 'navigate'): Promise<ActResult>;
  settled(): Promise<ActResult>;
  observe(where: { url?: string; text?: string }): void;
  observeStatus(status: number, document: boolean): void;
  readonly halted: string | null;
}

export interface PopupLookupInput {
  page: Page;
  origin: string;
  defs: ReadonlyMap<string, LookupDef>;
  policy: LookupPolicy;
  domains: readonly string[];
  timeoutMs?: number;
}

const popupWork = new WeakMap<Page, Promise<unknown>>();
const POPUP_CLEANUP_MS = 5_000;
type PopupFailureSource = (onFailure: (probe: string) => void) => () => void;
const popupFailureSources = new WeakMap<Page, PopupFailureSource>();

class LookupPopupExposeError extends Error {
  constructor() {
    super(LOOKUP_POPUP_EXPOSE_FAILED);
  }
}

export function setLookupPopupFailureSource(page: Page, subscribe: PopupFailureSource): void {
  popupFailureSources.set(page, subscribe);
}

export function lookupPopupFailureCode(error: unknown, signal?: AbortSignal): string {
  if (signal?.aborted) return 'run.stopped';
  return error instanceof LookupPopupExposeError ? LOOKUP_POPUP_EXPOSE_FAILED : 'lookup.popup_failed';
}

function trackPopupWork(page: Page, work: Promise<unknown>): void {
  popupWork.set(page, work);
  const done = () => {
    if (popupWork.get(page) === work) popupWork.delete(page);
  };
  void work.then(done, done);
}

export async function waitForLookupPopupCleanup(page: Page, signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  if (!popupWork.has(page)) return true;
  let timer: NodeJS.Timeout | undefined;
  let stop: (() => void) | undefined;
  const interrupted = new Promise<boolean>((resolve, reject) => {
    timer = setTimeout(() => resolve(false), POPUP_CLEANUP_MS);
    stop = () => reject(signal?.reason);
    signal?.addEventListener('abort', stop, { once: true });
  });
  try {
    for (let work = popupWork.get(page); work; work = popupWork.get(page)) {
      if (!(await Promise.race([work.then(() => true, () => true), interrupted]))) return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
    if (stop) signal?.removeEventListener('abort', stop);
  }
}

export function openLookupPopup(page: Page, url: string, timeout: number, signal?: AbortSignal): Promise<Page> {
  const open = openPopup(page, url, timeout, signal);
  if (signal) trackPopupWork(page, open);
  return open;
}

async function openPopup(page: Page, url: string, timeout: number, signal?: AbortSignal): Promise<Page> {
  signal?.throwIfAborted();
  const waiting = new AbortController();
  const open = Promise.resolve().then(() => page.evaluateHandle((url) => {
    const popup = globalThis.open(url, '_blank');
    const probes = new Set<string>();
    const onProbe = (event: MessageEvent) => {
      const probe = event.data?.saxLookupProbe;
      if (!event.isTrusted || typeof probe !== 'string' || !event.ports[0]) return;
      if (event.source === popup) probes.add(probe);
      event.ports[0].postMessage(true);
      event.ports[0].close();
    };
    globalThis.addEventListener('message', onProbe);
    return { popup, probes, remove: () => globalThis.removeEventListener('message', onProbe) };
  }, url));
  const answered = (probe: string) => open.then((handle) => handle.evaluate((state, key) => state.probes.delete(key), probe));
  const popup = page.waitForEvent('popup', {
    timeout,
    signal: signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal,
    predicate: async (tab) => {
      const probe = randomUUID();
      try {
        await tab.evaluate(probeLookupPopup, probe);
        return await answered(probe);
      } catch {
        return tab.url() === url;
      }
    },
  });
  let unsubscribe: (() => void) | undefined;
  const exposureFailed = new Promise<never>((_, reject) => {
    unsubscribe = popupFailureSources.get(page)?.((probe) => {
      void answered(probe).then((match) => { if (match) reject(new LookupPopupExposeError()); }, () => {});
    });
  });
  try {
    const [tab] = await Promise.race([Promise.all([popup, open]), exposureFailed]);
    signal?.throwIfAborted();
    if (signal) {
      const close = () => trackPopupWork(page, tab.close());
      signal.addEventListener('abort', close, { once: true });
      tab.once('close', () => signal.removeEventListener('abort', close));
    }
    return tab;
  } catch (e) {
    await open.then((handle) => handle.evaluate(({ popup: w }) => w?.close())).catch(() => {});
    throw e;
  } finally {
    unsubscribe?.();
    waiting.abort();
    await open.then(async (handle) => {
      await handle.evaluate((state) => state.remove()).catch(() => {});
      await handle.dispose();
    }).catch(() => {});
  }
}

export class PopupLookupPort implements LookupPort {
  private readonly i: PopupLookupInput;

  constructor(i: PopupLookupInput) {
    this.i = i;
  }

  async run(req: LookupRequest, signal?: AbortSignal): Promise<LookupResult> {
    const def = this.i.defs.get(req.playbook);
    if (!def) return { ok: false, code: 'lookup.unknown_playbook' };
    const url = new URL(def.path, this.i.origin);
    for (const [k, q] of Object.entries(def.query)) if (q) url.searchParams.set(q, req.match[k] ?? '');
    const a = await this.i.policy.beforeAction('navigate');
    if (!a.ok) return { ok: false, code: a.code };
    const timeout = this.i.timeoutMs ?? 10_000;
    const ctx = this.i.page.context();
    const onResponse = (r: Response) => {
      if (signal?.aborted) return;
      let portal = false;
      try {
        portal = hostAllowed(new URL(r.url()).hostname, this.i.domains);
      } catch {
        // 주소가 아니면 포털 응답이 아니다
      }
      const f = r.frame();
      if (!portal || f.page() === this.i.page) return;
      this.i.policy.observeStatus(r.status(), r.request().resourceType() === 'document' && f.parentFrame() === null);
    };
    ctx.on('response', onResponse);
    let popup: Page;
    try {
      popup = await openLookupPopup(this.i.page, url.toString(), timeout, signal);
    } catch (e) {
      ctx.off('response', onResponse);
      return { ok: false, code: lookupPopupFailureCode(e, signal) };
    }
    const onNav = (f: ReturnType<Page['mainFrame']>) => {
      if (!signal?.aborted && f === popup.mainFrame()) this.i.policy.observe({ url: f.url() });
    };
    popup.on('framenavigated', onNav);
    try {
      this.i.policy.observe({ url: popup.url() });
      await popup.waitForLoadState('domcontentloaded', { timeout });
      const text = await popup.locator('body').innerText({ timeout }).catch(() => '');
      signal?.throwIfAborted();
      this.i.policy.observe({ text });
      const s = await this.i.policy.settled();
      if (!s.ok) return { ok: false, code: s.code };
      if (this.i.policy.halted) return { ok: false, code: this.i.policy.halted };
      const ready = popup.locator(def.ready);
      await ready.first().waitFor({ state: 'attached', timeout });
      if ((await ready.count()) !== 1) return { ok: false, code: 'lookup.ready_ambiguous' };
      const count = Number(await ready.getAttribute('data-count'));
      const rows: LookupRow[] = await popup
        .locator(def.rows)
        .evaluateAll((trs) => trs.map((tr) => Object.fromEntries([...tr.querySelectorAll('[data-k]')].map((td) => [td.getAttribute('data-k') ?? '', td.textContent ?? '']))));
      if (!Number.isSafeInteger(count) || count !== rows.length) return { ok: false, code: 'lookup.incomplete' };
      if (this.i.policy.halted) return { ok: false, code: this.i.policy.halted };
      return { ok: true, rows };
    } catch {
      return { ok: false, code: signal?.aborted ? 'run.stopped' : (this.i.policy.halted ?? 'lookup.failed') };
    } finally {
      popup.off('framenavigated', onNav);
      ctx.off('response', onResponse);
      await popup.close().catch(() => {});
    }
  }
}
