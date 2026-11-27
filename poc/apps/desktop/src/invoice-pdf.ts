import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { docFileName } from '@sax/db';
import { writePrivateExport } from './private-exports.ts';
import { invoiceFormHtml, invoiceTotals, parseInvoiceForm, type InvoiceFonts, type InvoiceForm } from './invoice-form.ts';
import type { DeviceAuth, InvoiceMailRequest } from './remote-ports.ts';

/**
 * 앱이 직접 만드는 세금계산서 PDF와 거래처 메일(대표 11-24).
 * 홈택스 화면을 찍지 않고 발급 데이터(InvoiceForm)만으로 표준 양식을 그린다. 글꼴은 앱에 든 Noto Sans KR을 PDF에 심는다.
 * 건별, 수정, 대량 발급이 모두 save → mail 순서로 이 모듈을 쓴다.
 */

let fontCache: Promise<InvoiceFonts> | null = null;
export function invoiceFonts(staticDir: string): Promise<InvoiceFonts> {
  fontCache ??= (async () => {
    const read = (n: string) => fs.readFile(path.join(staticDir, 'fonts', n)).then((b) => b.toString('base64'));
    return { regular: await read('NotoSansKR-Regular.invoice.woff2'), bold: await read('NotoSansKR-Bold.invoice.woff2') };
  })();
  fontCache.catch(() => (fontCache = null));
  return fontCache;
}

export type HtmlToPdf = (html: string) => Promise<Uint8Array>;

export async function invoicePdf(form: InvoiceForm, staticDir: string, render: HtmlToPdf): Promise<Uint8Array> {
  return render(invoiceFormHtml(form, { fonts: await invoiceFonts(staticDir) }));
}

/**
 * 다 쓴 tmp를 dest에 배타적으로 건다. link가 안 되는 파일 시스템은 빈 파일로 이름을 잡고, 다 쓴 사본을 그 위로 옮긴다.
 * 그래서 dest는 언제나 완성본이거나 0바이트다(0바이트는 끝나지 못한 저장이 남긴 것).
 */
async function place(tmp: string, dest: string): Promise<boolean> {
  try {
    await fs.link(tmp, dest);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EXDEV' && code !== 'EINVAL') throw e;
  }
  try {
    await (await fs.open(dest, 'wx', 0o600)).close();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  }
  await writePrivateExport(dest, await fs.readFile(tmp));
  return true;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const safeId = (runId: string) => runId.replace(/[^A-Za-z0-9_-]/g, '');

/**
 * 실행 하나의 PDF, 양식 값(.json), 메일 보낸 표시(.mailed), PDF 파일 이름과 내용 해시(.name, 두 줄). 모두 본인만 읽는다(0600, 폴더 0700).
 * 이름은 다른 건이 나중에 가져갈 수 있으니, 기록한 해시와 내용이 같아야 이 실행의 PDF로 본다.
 * 해시가 없는 예전 기록은, 해시를 적은 다른 실행이 같은 파일을 가리키지 않을 때만 믿는다.
 * PDF 이름은 "전자세금계산서_거래처명_작성일자.pdf"이고 같은 이름이 있으면 _2, _3을 붙인다(대표 11-25). 예전 이름(실행 id.pdf)도 그대로 연다.
 */
export class InvoiceFiles {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  async pdf(runId: string): Promise<string> {
    return (await this.record(runId)).file;
  }

  private async record(runId: string): Promise<{ file: string; sha: string | null; named: boolean }> {
    const r = await this.readName(this.file(runId, 'name'));
    return { file: path.join(this.dir, r?.name ?? `${safeId(runId)}.pdf`), sha: r?.sha ?? null, named: r !== null };
  }

  private async readName(f: string): Promise<{ name: string; sha: string | null } | null> {
    const [name = '', sha = ''] = (await fs.readFile(f, 'utf8').catch(() => '')).split('\n').map((l) => l.trim());
    if (name === '' || path.basename(name) !== name) return null;
    return { name, sha: /^[0-9a-f]{64}$/.test(sha) ? sha : null };
  }

  /** 해시를 적은 다른 실행의 기록이 이 이름과 내용을 가리키는지. 해시 없는 예전 기록보다 앞선다. */
  private async claimedByOther(runId: string, name: string, sha: string): Promise<boolean> {
    const own = `${safeId(runId)}.name`;
    for (const f of await fs.readdir(this.dir)) {
      if (!f.endsWith('.name') || f === own) continue;
      const r = await this.readName(path.join(this.dir, f));
      if (r?.name === name && r.sha === sha) return true;
    }
    return false;
  }

  /** none: 파일 없음, empty: 끝나지 못한 저장의 0바이트(이 실행 몫), own: 이 실행의 완성본, other: 이름을 다른 건이 가져갔다. */
  private async state(runId: string): Promise<{ file: string; state: 'none' | 'empty' | 'own' | 'other' }> {
    const r = await this.record(runId);
    const bytes = await fs.readFile(r.file).catch(() => null);
    if (!bytes) return { file: r.file, state: 'none' };
    if (!bytes.length) return { file: r.file, state: 'empty' };
    const sha = sha256(bytes);
    if (r.sha) return { file: r.file, state: sha === r.sha ? 'own' : 'other' };
    if (r.named && (await this.claimedByOther(runId, path.basename(r.file), sha))) return { file: r.file, state: 'other' };
    return { file: r.file, state: 'own' };
  }

  private file(runId: string, ext: 'json' | 'mailed' | 'name'): string {
    return path.join(this.dir, `${safeId(runId)}.${ext}`);
  }

  private async write(f: string, data: string | Uint8Array): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    await writePrivateExport(f, typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }

  private saving: Promise<unknown> = Promise.resolve();

  /**
   * 같은 실행이면 이미 있는 완성본을 그대로 쓰고(0바이트면 다시 쓴다), 처음이면 비어 있는 "서류명_날짜" 이름을 잡는다.
   * 겹쳐 저장해도(발급 직후 저장과 열기) 파일이 하나이게 차례로 저장한다.
   */
  save(runId: string, form: InvoiceForm, pdf: Uint8Array): Promise<string> {
    const run = this.saving.then(() => this.saveNow(runId, form, pdf));
    this.saving = run.catch(() => {});
    return run;
  }

  private async saveNow(runId: string, form: InvoiceForm, pdf: Uint8Array): Promise<string> {
    await this.write(this.file(runId, 'json'), JSON.stringify(form));
    const cur = await this.state(runId);
    if (cur.state === 'own') return cur.file;
    const record = (name: string) => this.write(this.file(runId, 'name'), `${name}\n${sha256(pdf)}`);
    if (cur.state === 'empty') {
      await record(path.basename(cur.file));
      await this.write(cur.file, pdf);
      return cur.file;
    }
    // 이름을 먼저 기록하고 건다. 걸다 꺼지면 기록은 없는 파일이나 0바이트를 가리키고, 다음 저장이 그 자리를 다시 쓴다.
    const tmp = path.join(this.dir, `${randomUUID()}.part`);
    await this.write(tmp, pdf);
    try {
      for (let i = 0; i < 100; i++) {
        const name = docFileName('tax_invoice', ymd(form.issueDate) ?? form.issueDate, 'pdf', i, form.buyer.name);
        const dest = path.join(this.dir, name);
        if (await fs.lstat(dest).then(() => true, () => false)) continue;
        await record(name);
        if (await place(tmp, dest)) return dest;
      }
      throw new Error('invoice_name_exhausted');
    } finally {
      // 남은 .part는 시작할 때 prepareExistingExports가 지운다. 여기서 못 지운 것이 저장 결과나 앞선 오류를 가리지 않게 한다.
      await fs.rm(tmp, { force: true }).catch(() => {});
    }
  }

  async form(runId: string): Promise<InvoiceForm | null> {
    const raw = await fs.readFile(this.file(runId, 'json'), 'utf8').catch(() => null);
    if (raw === null) return null;
    try {
      return parseInvoiceForm(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** 이 실행의 완성된 PDF가 있는지. 0바이트(예전 판이나 끝나지 못한 저장)와 다른 건의 파일은 없는 것으로 보고, 열 때 양식 값으로 다시 그린다. */
  async exists(runId: string): Promise<boolean> {
    return (await this.state(runId)).state === 'own';
  }

  async mailed(runId: string): Promise<boolean> {
    return fs.stat(this.file(runId, 'mailed')).then(() => true, () => false);
  }

  async markMailed(runId: string): Promise<void> {
    await this.write(this.file(runId, 'mailed'), new Date().toISOString());
  }
}

const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,}$/;
const ymd = (v: string) => {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(v.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const clip = (v: string, n: number) => v.replace(/\s+/g, ' ').trim().slice(0, n);

/** 양식 값 → 메일 요청. 받는 주소가 없거나 모양이 틀리면 null(보내지 않는다). */
export function mailRequest(form: InvoiceForm, pdf: Uint8Array): InvoiceMailRequest | null {
  const to = (form.buyer.email ?? '').trim();
  const issueDate = ymd(form.issueDate);
  const supplierName = clip(form.supplier.name, 70);
  if (!ADDRESS.test(to) || !issueDate || !supplierName) return null;
  const mail = (form.supplier.email ?? '').trim();
  return {
    to,
    supplierEmail: ADDRESS.test(mail) && mail.toLowerCase() !== to.toLowerCase() ? mail : null,
    supplierName,
    buyerName: clip(form.buyer.name, 70),
    approvalNo: form.approvalNo.trim(),
    issueDate,
    total: Math.round(invoiceTotals(form).total),
    pdf,
  };
}

export type InvoiceMailResult = 'sent' | 'already' | 'no_address' | 'signed_out' | 'failed';

export interface InvoiceMailDeps {
  files: InvoiceFiles;
  client: { sendInvoiceMail(auth: DeviceAuth, m: InvoiceMailRequest): Promise<void> } | null;
  device: () => Promise<{ auth: DeviceAuth; clearToken(): void } | null>;
  log?: (name: string, data: Record<string, string | number | boolean>) => void;
}

const codeOf = (e: unknown) => {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : 'other';
};

/** 한 실행의 PDF를 거래처에 메일로 한 번만 보낸다. 토큰이 만료됐으면 한 번 새로 받아 다시 부른다. */
export async function mailInvoice(d: InvoiceMailDeps, runId: string, form: InvoiceForm, pdf: Uint8Array): Promise<InvoiceMailResult> {
  if (await d.files.mailed(runId)) return 'already';
  const req = mailRequest(form, pdf);
  if (!req) return 'no_address';
  const dev = d.client ? await d.device().catch(() => null) : null;
  if (!d.client || !dev) return 'signed_out';
  try {
    try {
      await d.client.sendInvoiceMail(dev.auth, req);
    } catch (e) {
      if (codeOf(e) !== 'account.unauthorized') throw e;
      dev.clearToken();
      await d.client.sendInvoiceMail(dev.auth, req);
    }
  } catch (e) {
    d.log?.('main.invoice_mail_failed', { code: codeOf(e).slice(0, 60) });
    return 'failed';
  }
  await d.files.markMailed(runId);
  d.log?.('main.invoice_mail_sent', {});
  return 'sent';
}
