import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  BankRepo, bizNoKind, CardRepo, CounterpartyRepo, DocumentRepo, isValidBizNo, normalizePayerName, normalizePayTerms, ProfileRepo, ValidationError,
  type Alloc, type AllocMethod, type BankTxn, type ColumnCipher, type Db, type PayTerms, type Receivable, type ReceivableEvent, type TxnInput,
} from '@sax/db';
import { SourceError, type SourceProgress, type SourceRow, type TxnSource } from './source.ts';
import { analyzeCashFlow, HUMAN_CATEGORIES, shiftMonth, type CashFlowMonth, type CashFlowResult, type CfAccount, type CfInvoice, type CfTxn, type HometaxKind, type HumanCategory } from './cashflow.ts';
import { coveredTo, syncPlan, syncDue, SYNC_KINDS, type SyncRecord } from './hometax-sync.ts';
import { analyzeReport, periodEnd, REPORT_WINDOWS, reportLines, reportMonthOk, vatDue, type Line, type ReportLineRow, type ReportInput, type ReportPurchase, type ReportResult, type ReportSales, type ReportWindow, type VatDue } from './report.ts';
import { addDays, FEE_TOLERANCE, runMatch, type Candidate, type MatchCounterparty, type MatchReceivable, type MatchTxn, type Side } from './match.ts';

export class BankError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
const fail = (code: string): never => {
  throw new BankError(code);
};
type Params = Record<string, unknown>;

/** 홈택스 목록의 승인번호. 끝 8자리는 발급 사업자가 매긴 일련번호라 영문이 섞일 수 있다 */
const approvalKey = (v: string) => v.replace(/[^0-9A-Za-z]/g, '');

/** 장부 줄로 넣을 수 있는 세금계산서 줄인가. 수정분(음수 합계)도 제 승인번호를 가진 한 줄이다 */
function usableInvoice(raw: Record<string, unknown>): boolean {
  return typeof raw.approvalNo === 'string' && approvalKey(raw.approvalNo).length === 24 && Number.isSafeInteger(raw.total);
}

/** 받은 목록의 줄이 내 것인가: 내 쪽 번호가 있으면 내 번호여야 하고, 상대 쪽 번호가 내 번호면 안 된다(ADR-072 결정 2) */
function mineRow(kind: Kind, me: string, raw: Record<string, unknown>): boolean {
  const digits = (x: unknown) => (typeof x === 'string' ? x.replace(/\D/g, '') : '');
  const own = digits(kind === 'sale' ? raw.supplierBizNo : raw.buyerBizNo);
  const other = digits(kind === 'sale' ? raw.buyerBizNo : raw.supplierBizNo);
  return (!own || own === me) && other !== me;
}

export const DEFAULT_TERMS: PayTerms = { kind: 'days', n: 30 };
/** 거래내역 기준일이 이보다 오래되면 "확인 못 함"(09 §8.3) */
export const STALE_DAYS = 7;
const BANK_FILE_MAX = 15 * 1024 * 1024;
const ROWS_MAX = 20_000;
const METHODS: readonly AllocMethod[] = ['account', 'cash', 'other_account', 'offset', 'other'];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 건 종류 → 맞출 입출금 방향. sale = 받을 돈(입금), purchase = 낼 돈(출금) */
export type Kind = 'sale' | 'purchase';
const SIDE: Record<Kind, Side> = { sale: 'in', purchase: 'out' };
const kindOf = (v: unknown): Kind => (v === undefined || v === null || v === 'sale' ? 'sale' : v === 'purchase' ? 'purchase' : fail('bad_kind'));
const sideOf = (v: unknown): Side => (v === undefined || v === null || v === 'in' ? 'in' : v === 'out' ? 'out' : fail('bad_side'));

const periodOf = (v: unknown): { from: string; to: string } | null => {
  const o = v as { from?: unknown; to?: unknown } | null;
  return o && typeof o === 'object' && typeof o.from === 'string' && typeof o.to === 'string' && ISO.test(o.from) && ISO.test(o.to) && o.from <= o.to ? { from: o.from, to: o.to } : null;
};

export const kstDay = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** 받기로 한 날(09 §5.2). none이면 null */
export function dueDate(writtenOn: string, t: PayTerms): string | null {
  const [y, m] = writtenOn.split('-').map(Number) as [number, number];
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  switch (t.kind) {
    case 'days':
      return addDays(writtenOn, t.n);
    case 'next_month_day':
      return `${ny}-${String(nm).padStart(2, '0')}-${String(Math.min(t.d, lastDayOfMonth(ny, nm))).padStart(2, '0')}`;
    case 'month_end':
      return `${ny}-${String(nm).padStart(2, '0')}-${String(lastDayOfMonth(ny, nm))}`;
    case 'none':
      return null;
  }
}

/** 줄 열쇠: 일시·방향·금액·잔액·입금자 + 같은 값 순번(같은 파일을 다시 올려도 같은 열쇠) */
export function rowKeys(rows: Array<Pick<TxnInput, 'occurredAt' | 'direction' | 'amount' | 'balance' | 'payer'>>): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const base = [r.occurredAt, r.direction, r.amount, r.balance ?? '', r.payer ?? ''].join('|');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return createHash('sha256').update(`${base}|${n}`).digest('hex').slice(0, 32);
  });
}

/** unknown: 거래내역이 없거나 오래돼(STALE_DAYS) 입금을 확인하지 못한 건. 모르는 상태에서 "못 받음"이라고 하지 않는다(09 §7 원칙 6) */
export type ReceivableStatus = 'unpaid' | 'unknown' | 'partial' | 'waiting' | 'received' | 'excluded';

export interface ReceivableView {
  id: string;
  counterpartyId: string | null;
  cpName: string | null;
  cpBizNo: string | null;
  item: string | null;
  approvalTail: string | null;
  writtenOn: string;
  total: number;
  tax: number | null;
  received: number;
  /** 수정세금계산서 음수분을 붙인 금액. 당초분 줄은 남은 돈에서 뺀 금액, 음수 줄은 당초분에 붙인 금액(양수) */
  credited: number;
  remaining: number;
  dueOn: string | null;
  promisedOn: string | null;
  dueIn: number | null;
  overdue: boolean;
  status: ReceivableStatus;
  via: 'auto' | 'manual' | null;
  offAccount: AllocMethod | null;
  sources: Array<'ledger' | 'hometax'>;
  excludedReason: string | null;
}

export interface TxnView {
  id: string;
  accountId: string;
  accountLast4: string;
  bank: string;
  day: string;
  occurredAt: string;
  direction: 'in' | 'out';
  amount: number;
  unallocated: number;
  payer: string | null;
  memo: string | null;
  ignoredReason: string | null;
  assignedCounterpartyId: string | null;
  candidates: Array<{ receivableIds: string[]; cpName: string | null; fit: Candidate['fit']; amounts: number[]; feeGap: number; reason: string; writtenOn: string; total: number }>;
}

export interface BankSummary {
  today: string;
  latestDay: string | null;
  stale: boolean;
  hasAccounts: boolean;
  /** 통장으로 못 받은 것이 확인된 돈(못 받음, 일부 받음). 통장 기록 전이라 모르는 건(unknown)은 unconfirmed에 따로 센다 */
  unpaidCount: number;
  unpaidTotal: number;
  unconfirmedCount: number;
  unconfirmedTotal: number;
  overdueCount: number;
  overdueTotal: number;
  oldestOverdue: { cpName: string | null; writtenOn: string; daysOver: number } | null;
  reviewCount: number;
  autoCount: number;
  payable: PayableSummary;
}

export interface PayableSummary {
  unpaidCount: number;
  unpaidTotal: number;
  unconfirmedCount: number;
  unconfirmedTotal: number;
  overdueCount: number;
  overdueTotal: number;
  dueSoonCount: number;
  dueSoonTotal: number;
  reviewCount: number;
}

interface MatchRun {
  autoTxnIds: string[];
  review: string[];
  unknown: string[];
  candidates: Map<string, Candidate[]>;
}

interface BankServiceOptions {
  vaultDir: string;
  now?: () => Date;
  /**
   * 장부 자료가 바뀌었을 때 한 번(ADR-068 결정 5). 쓰기 명령이 끝났을 때와 자동 조회가 줄을 넣었을 때 부른다.
   * profileId가 null이면 어느 사업장인지 모르는 쓰기(거래처 계좌, 별칭)다.
   */
  onChange?: (e: { profileId: string | null; source: string }) => void;
  log?: (type: string, data: Record<string, string | number | boolean>) => void;
}

/** 자료를 바꾸지 않는 명령. 나머지는 끝나면 변경 알림을 낸다 */
const READ_ONLY = new Set(['bank.revealAccount', 'bank.revealCpAccount']);

/** 최신화 한 번의 진행(계좌마다 하나). 값(계좌번호·거래)은 담지 않는다 */
export interface RefreshJob {
  id: string;
  accountId: string;
  state: 'requested' | 'waiting' | 'running' | 'done' | 'failed';
  done?: number;
  jobs?: number;
  range: { from: string; to: string };
  startedAt: string;
  finishedAt: string | null;
  code: string | null;
  retryAt?: string | null;
  result: { rows: number; newCount: number; duplicateCount: number; match: { auto: number; review: number; unknown: number } } | null;
}

/** 원천 행 → 넣기 줄. 입금자는 원천이 아는 칸, 없으면 적요 첫 칸. 나머지 적요는 메모로 */
export function sourceRowsToInput(provider: string, rows: SourceRow[]): Array<Record<string, unknown>> {
  return rows.flatMap((r) => {
    const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?$/.exec(typeof r.occurredAt === 'string' ? r.occurredAt : '');
    const money = (Number.isSafeInteger(r.deposit) && r.deposit > 0) || (Number.isSafeInteger(r.withdrawal) && r.withdrawal > 0);
    // 돈이 오간 줄의 날짜를 못 읽으면 조용히 빼지 않는다. 뺀 채 넣으면 그 구간을 다 받은 것으로 쳐 입금을 못 받음으로 보인다(데이터 검증 F17)
    if (!m && money) throw new SourceError('source.bad_rows');
    if (!m) return [];
    const remarks = (Array.isArray(r.remarks) ? r.remarks : []).map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean);
    const payer = typeof r.payer === 'string' && r.payer.trim() ? r.payer.trim() : (remarks[0] ?? null);
    const rest = remarks.filter((x) => x !== payer);
    const memo = [...rest, typeof r.memo === 'string' ? r.memo.trim() : ''].filter(Boolean).join(' ') || null;
    const base = { day: m[1], occurredAt: m[2] ? `${m[1]} ${m[2]}` : m[1], balance: Number.isSafeInteger(r.balance) ? r.balance : null, payer, memo };
    const sid = typeof r.sourceId === 'string' && r.sourceId ? createHash('sha256').update(`${provider}|${r.sourceId}`).digest('hex').slice(0, 32) : null;
    const out: Array<Record<string, unknown>> = [];
    if (Number.isSafeInteger(r.deposit) && r.deposit > 0) out.push({ ...base, direction: 'in', amount: r.deposit, sourceKey: sid && `${sid}:in` });
    if (Number.isSafeInteger(r.withdrawal) && r.withdrawal > 0) out.push({ ...base, direction: 'out', amount: r.withdrawal, sourceKey: sid && `${sid}:out` });
    return out;
  });
}

export class BankService {
  private readonly db: Db;
  private readonly cipher: ColumnCipher;
  readonly repo: BankRepo;
  private readonly opts: BankServiceOptions;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly sources = new Map<string, TxnSource>();
  private readonly jobs = new Map<string, RefreshJob & { abort: AbortController }>();

  constructor(db: Db, cipher: ColumnCipher, hmacKey: Uint8Array, opts: BankServiceOptions) {
    this.db = db;
    this.cipher = cipher;
    this.repo = new BankRepo(db, cipher, hmacKey);
    this.opts = opts;
  }

  registerSource(src: TxnSource): void {
    if (src.kind !== 'auto' || !/^[a-z0-9_-]{1,40}$/.test(src.provider)) throw new BankError('bad_provider');
    this.sources.set(src.provider, src);
  }

  private changed(profileId: string | null, source: string): void {
    try {
      this.opts.onChange?.({ profileId, source });
    } catch {
      // 알림이 실패해도 쓰기는 끝났다. 다음 변경이나 화면을 열 때 다시 계산한다
    }
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }
  private at(): string {
    return this.now().toISOString();
  }
  private today(): string {
    return kstDay(this.now());
  }

  async handle(method: string, p: Params): Promise<unknown> {
    if (method === 'bank.refresh' || method === 'bank.autoRefresh' || method === 'db.query.bank.refreshStatus') {
      try {
        return method === 'bank.refresh' ? this.refresh(p ?? {}) : method === 'bank.autoRefresh' ? this.autoRefresh(p ?? {}) : this.refreshStatus(p ?? {});
      } catch (e) {
        if (e instanceof ValidationError) throw new BankError(e.code);
        throw e;
      }
    }
    try {
      const r = await this.serial(() => this.dispatch(method, p ?? {}));
      if (!method.startsWith('db.query.') && !READ_ONLY.has(method)) this.changed(typeof p?.profileId === 'string' ? p.profileId : null, method);
      return r;
    } catch (e) {
      if (e instanceof ValidationError) throw new BankError(e.code);
      throw e;
    }
  }

  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private profile(v: unknown): string {
    return typeof v === 'string' && v && new ProfileRepo(this.db).get(v) ? v : fail('profile_not_found');
  }
  private str(v: unknown, code: string, max = 128): string {
    return typeof v === 'string' && v && v.length <= max ? v : fail(code);
  }

  private async dispatch(method: string, p: Params): Promise<unknown> {
    switch (method) {
      case 'db.query.bank.accounts':
        return this.accounts(this.profile(p.profileId));
      case 'db.query.bank.overview':
        return this.overview(this.profile(p.profileId));
      case 'db.query.bank.summary':
        return this.summary(this.profile(p.profileId));
      case 'db.query.bank.saleScale':
        return this.saleScale(this.profile(p.profileId));
      case 'db.query.bank.receivable':
        return this.detail(this.profile(p.profileId), this.str(p.id, 'not_found'));
      case 'db.query.bank.counterparty':
        return this.cpBanking(this.str(p.counterpartyId, 'not_found'));
      case 'db.query.bank.cashflow':
        return this.cashflow(this.profile(p.profileId), p.month);
      case 'db.query.bank.cashflowSeries':
        return this.cashflowSeries(this.profile(p.profileId), p.months);
      case 'db.query.bank.report':
        return this.report(this.profile(p.profileId), p.month, p.months, p.rolling === true);
      case 'db.query.bank.invoices':
        return this.monthInvoices(this.profile(p.profileId), p.kind, p.month);
      case 'db.query.bank.lastSales':
        return this.lastSales(this.profile(p.profileId));
      case 'db.query.bank.vat':
        return this.vat(this.profile(p.profileId));
      case 'db.query.bank.packRows':
        return this.packRows(this.profile(p.profileId), p.month);
      case 'db.query.bank.hometaxPlan':
        return this.hometaxPlan(this.profile(p.profileId), p.firstUnlock === true);
      case 'db.query.bank.reportAll':
        return this.reportAll(this.profile(p.profileId), p.month, p.months);
      case 'db.query.bank.reportLines':
        return this.reportLines(this.profile(p.profileId), p);
      case 'bank.hometaxSync':
        return this.hometaxSync(p);
      case 'bank.categorize':
        return this.categorize(p);
      case 'db.query.bank.format':
        return this.format(this.str(p.signature, 'bad_signature', 400));
      case 'bank.consent':
        return this.consent(this.profile(p.profileId), p);
      case 'bank.addAccount':
        if (!this.consentOf(this.profile(p.profileId))) return fail('consent_required');
        return this.repo.addAccount({ profileId: this.profile(p.profileId), bank: p.bank, number: p.number, alias: p.alias, usage: p.usage }, this.at());
      case 'bank.updateAccount':
        return this.repo.updateAccount(this.ownAccount(p), { alias: p.alias, usage: p.usage, bank: p.bank });
      case 'bank.deleteAccount':
        return this.repo.deleteAccount(this.ownAccount(p));
      case 'bank.setLink':
        return this.setLink(p);
      case 'bank.revealAccount':
        return { number: this.repo.revealAccount(this.ownAccount(p)) };
      case 'bank.importTxns':
        return this.importTxns(p);
      case 'bank.importInvoices':
        return this.importInvoices(p);
      case 'bank.rematch':
        return this.rematch(this.profile(p.profileId));
      case 'bank.accept':
        return this.accept(p);
      case 'bank.attach':
        return this.attach(p);
      case 'bank.detach':
        return this.detach(p);
      case 'bank.reject':
        return this.reject(p);
      case 'bank.markReceived':
        return this.markReceived(p);
      case 'bank.closeFee':
        return this.closeFee(p);
      case 'bank.ignoreTxn':
        return this.ignoreTxn(p);
      case 'bank.assignTxn':
        return this.assignTxn(p);
      case 'bank.setPromised':
        return this.setPromised(p);
      case 'bank.exclude':
        return this.exclude(p);
      case 'bank.undo':
        return this.undo(p);
      case 'bank.addCpAccount':
        return this.addCpAccount(p);
      case 'bank.deleteCpAccount':
        return { deleted: this.repo.deleteCpAccount(this.str(p.id, 'not_found')) };
      case 'bank.revealCpAccount':
        return { number: this.repo.revealCpAccount(this.str(p.id, 'not_found')) };
      case 'bank.addAlias':
        return this.addAlias(p);
      case 'bank.deleteAlias':
        return { deleted: this.repo.deleteAlias(this.str(p.id, 'not_found')) };
      case 'bank.setPayTerms':
        return { terms: this.repo.setPayTerms(this.str(p.counterpartyId, 'not_found'), p.terms, sideOf(p.side)) };
      case 'bank.setDefaultTerms':
        return this.setDefaultTerms(this.profile(p.profileId), p.terms, kindOf(p.kind));
    }
    return fail('unknown_method');
  }

  private ownAccount(p: Params): string {
    const pid = this.profile(p.profileId);
    const a = this.repo.account(this.str(p.id ?? p.accountId, 'account_not_found'));
    return a && a.profileId === pid ? a.id : fail('account_not_found');
  }

  private ownReceivable(pid: string, id: unknown): Receivable {
    const r = typeof id === 'string' ? this.repo.receivable(id) : null;
    return r && r.profileId === pid ? r : fail('not_found');
  }

  private ownTxn(pid: string, id: unknown): BankTxn {
    const t = typeof id === 'string' ? this.repo.txn(id) : null;
    return t && t.profileId === pid ? t : fail('txn_not_found');
  }

  private settingKey(pid: string, k: string) {
    return `profile.${pid}.bank.${k}`;
  }
  private getSetting<T>(key: string): T | null {
    const v = this.db.prepare('SELECT value_json FROM settings WHERE key = ?').pluck().get(key) as string | undefined;
    if (v === undefined) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }
  private putSetting(key: string, v: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json').run(key, JSON.stringify(v));
  }

  defaultTerms(pid: string, kind: Kind = 'sale'): PayTerms {
    try {
      return normalizePayTerms(this.getSetting(this.settingKey(pid, kind === 'purchase' ? 'defaultOutTerms' : 'defaultTerms'))) ?? DEFAULT_TERMS;
    } catch {
      return DEFAULT_TERMS;
    }
  }
  private setDefaultTerms(pid: string, terms: unknown, kind: Kind) {
    const t = normalizePayTerms(terms) ?? DEFAULT_TERMS;
    this.putSetting(this.settingKey(pid, kind === 'purchase' ? 'defaultOutTerms' : 'defaultTerms'), t);
    return { terms: t };
  }

  private format(signature: string) {
    const all = this.getSetting<Record<string, unknown>>('bank.formats') ?? {};
    return { mapping: all[createHash('sha256').update(signature).digest('hex').slice(0, 24)] ?? null };
  }
  private rememberFormat(signature: unknown, mapping: unknown): void {
    if (typeof signature !== 'string' || !signature || signature.length > 400 || typeof mapping !== 'object' || mapping === null) return;
    if (JSON.stringify(mapping).length > 2000) return;
    const all = this.getSetting<Record<string, unknown>>('bank.formats') ?? {};
    all[createHash('sha256').update(signature).digest('hex').slice(0, 24)] = mapping;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete all[k];
    this.putSetting('bank.formats', all);
  }

  consentOf(pid: string): { version: string; at: string } | null {
    return this.getSetting<{ version: string; at: string }>(this.settingKey(pid, 'consent'));
  }
  private consent(pid: string, p: Params) {
    const version = typeof p.version === 'string' && /^[\w.-]{1,20}$/.test(p.version) ? p.version : fail('bad_version');
    const v = { version, at: this.at() };
    this.putSetting(this.settingKey(pid, 'consent'), v);
    return v;
  }

  private async keepFile(pid: string, docType: 'bank_statement' | 'hometax_issue_list', file: unknown): Promise<string | null> {
    if (file === undefined || file === null) return null;
    const f = file as { bytes?: unknown; ext?: unknown; displayName?: unknown };
    if (!(f.bytes instanceof Uint8Array) || f.bytes.length === 0 || f.bytes.length > BANK_FILE_MAX) return fail('input_size');
    const ext = typeof f.ext === 'string' && /^(xlsx|xls|csv|html)$/.test(f.ext) ? f.ext : 'bin';
    const sha256 = createHash('sha256').update(f.bytes).digest('hex');
    const prev = this.db.prepare('SELECT id FROM documents WHERE profile_id = ? AND doc_type = ? AND sha256 = ? LIMIT 1').pluck().get(pid, docType, sha256) as string | undefined;
    if (prev) return prev;
    const dir = this.opts.vaultDir;
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const name = `${docType === 'bank_statement' ? 'bank' : 'hometax_list'}_${this.today().replace(/-/g, '')}_${randomBytes(4).toString('hex')}.${ext}`;
    const dest = path.join(dir, name);
    const fh = await fs.open(dest, 'wx', 0o600);
    try {
      await fh.writeFile(f.bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    const display = typeof f.displayName === 'string' ? f.displayName.split(/[\\/]/).pop()!.slice(0, 100) : null;
    try {
      const id = randomUUID();
      new DocumentRepo(this.db).insert({ id, profileId: pid, docType, displayName: display || (docType === 'bank_statement' ? '은행 거래내역' : '홈택스 발급 목록'), issuedAt: null, expiresAt: null, issuer: null, path: dest, bytes: f.bytes.length, sha256, meta: { v: 1, source: 'pc_file', format: ext }, runId: null }, this.at());
      return id;
    } catch (e) {
      await fs.unlink(dest).catch(() => {});
      throw e;
    }
  }

  private accounts(pid: string) {
    const last = this.db.prepare('SELECT max(day) FROM bank_txns WHERE account_id = ?').pluck();
    const count = this.db.prepare('SELECT count(*) FROM bank_txns WHERE account_id = ?').pluck();
    const lastImport = this.db.prepare('SELECT created_at FROM bank_imports WHERE account_id = ? ORDER BY created_at DESC LIMIT 1').pluck();
    return this.repo.accounts(pid).map((a) => ({ ...a, canRefresh: a.linkState !== 'file_only' && !!a.linkProvider && this.sources.has(a.linkProvider), refresh: this.jobView(this.jobs.get(a.id)), lastDay: (last.get(a.id) as string | null) ?? null, txnCount: Number(count.get(a.id)), lastImportAt: (lastImport.get(a.id) as string | undefined) ?? null }));
  }

  private setLink(p: Params) {
    const id = this.ownAccount(p);
    const state = p.state === 'file_only' || p.state === 'auto_connected' || p.state === 'auto_error' ? p.state : fail('bad_link_state');
    if (state === 'file_only') this.jobs.get(id)?.abort.abort();
    return this.repo.setLink(id, { state, provider: typeof p.provider === 'string' ? p.provider : null, error: typeof p.error === 'string' ? p.error : null }, this.at());
  }

  private jobView(j: (RefreshJob & { abort: AbortController }) | undefined): RefreshJob | null {
    if (!j) return null;
    return { id: j.id, accountId: j.accountId, state: j.state, done: j.done, jobs: j.jobs, range: { ...j.range }, startedAt: j.startedAt, finishedAt: j.finishedAt, code: j.code, retryAt: j.retryAt ?? null, result: j.result };
  }

  private refreshStatus(p: Params): RefreshJob | null {
    return this.jobView(this.jobs.get(this.ownAccount(p)));
  }

  private autoRefresh(p: Params): { started: number } {
    const pid = this.profile(p.profileId);
    let started = 0;
    for (const a of this.repo.accounts(pid)) {
      if (a.linkState === 'file_only' || !a.linkProvider || !this.sources.has(a.linkProvider)) continue;
      this.refresh({ profileId: pid, accountId: a.id, unattended: true, firstOpen: p.firstOpen === true });
      started++;
    }
    return { started };
  }

  private refresh(p: Params): RefreshJob {
    const pid = this.profile(p.profileId);
    const id = this.ownAccount(p);
    const running = this.jobs.get(id);
    if (running && running.state !== 'done' && running.state !== 'failed') return this.jobView(running)!;
    const acct = this.repo.account(id)!;
    if (acct.linkState === 'file_only' || !acct.linkProvider) return fail('source.not_linked');
    const src = this.sources.get(acct.linkProvider) ?? fail('source.not_available');
    const today = this.today();
    const last = this.db.prepare('SELECT max(day) FROM bank_txns WHERE account_id = ?').pluck().get(id) as string | null;
    const from = typeof p.from === 'string' && ISO.test(p.from) ? p.from : last ? addDays(last, -1) : addDays(today, -90);
    const to = typeof p.to === 'string' && ISO.test(p.to) && p.to <= today ? p.to : today;
    if (from > to) return fail('bad_range');
    const job: RefreshJob & { abort: AbortController } = {
      id: randomUUID(), accountId: id, state: 'requested', range: { from, to }, startedAt: this.at(), finishedAt: null, code: null, result: null, abort: new AbortController(),
    };
    this.jobs.set(id, job);
    const first = this.jobView(job)!;
    void this.runRefresh(pid, acct.id, src, job, p.unattended === true, p.firstOpen === true);
    return first;
  }

  private async runRefresh(pid: string, accountId: string, src: TxnSource, job: RefreshJob & { abort: AbortController }, unattended: boolean, firstOpen = false) {
    const finish = (state: 'done' | 'failed', code: string | null) => {
      job.state = state;
      job.code = code;
      job.finishedAt = this.at();
    };
    try {
      const a = this.repo.account(accountId);
      const number = a ? this.repo.revealAccount(accountId) : null;
      if (!a || !number) throw new SourceError('source.not_linked');
      const onProgress = (pr: SourceProgress) => {
        if (job.state === 'done' || job.state === 'failed') return;
        if (pr.state === 'requested' || pr.state === 'waiting' || pr.state === 'running') {
          job.state = pr.state;
          if ('done' in pr && pr.done !== undefined) job.done = pr.done;
          if (pr.jobs !== undefined) job.jobs = pr.jobs;
        }
      };
      const got = await src.fetch({ id: a.id, profileId: pid, bank: a.bank, number, last4: a.last4 }, job.range, { onProgress, signal: job.abort.signal, unattended, firstOpen });
      if (job.abort.signal.aborted) throw new SourceError('source.cancelled');
      const rows = sourceRowsToInput(src.provider, Array.isArray(got?.rows) ? got.rows : []);
      const result = await this.serial(() => this.importAuto(pid, accountId, src.provider, rows, got?.range ?? job.range));
      job.result = { rows: rows.length, ...(result as Omit<NonNullable<RefreshJob['result']>, 'rows'>) };
      finish('done', null);
      this.changed(pid, 'bank.auto');
    } catch (e) {
      const code = e instanceof SourceError ? e.code : e instanceof BankError ? e.code : 'source.failed';
      if (e instanceof SourceError && e.retryAt) job.retryAt = e.retryAt;
      finish('failed', /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : 'source.failed');
    }
    await this.serial(() => {
      const a = this.repo.account(accountId);
      if (!a || a.linkState === 'file_only' || job.code === 'source.too_soon' || job.code === 'source.daily_limit' || job.code === 'source.not_remembered') return;
      this.repo.setLink(accountId, job.code ? { state: 'auto_error', provider: src.provider, error: job.code } : { state: 'auto_connected', provider: src.provider }, this.at());
    }).catch(() => {});
    this.opts.log?.('bank.refresh_end', { unattended, provider: src.provider, code: job.code ?? 'ok', rows: job.result?.rows ?? 0, newCount: job.result?.newCount ?? 0 });
  }

  private importAuto(pid: string, accountId: string, provider: string, raw: Array<Record<string, unknown>>, range: unknown) {
    if (!this.repo.account(accountId)) return fail('account_not_found');
    const rows = this.txnRows(raw);
    const period = periodOf(range);
    if (!rows.length && !period) return { newCount: 0, duplicateCount: 0, match: { auto: 0, review: 0, unknown: 0 } };
    const { import: imp, newIds } = this.repo.importTxns({ profileId: pid, accountId, source: 'auto', provider, documentId: null, format: { range }, rows, period }, this.at());
    const r = this.afterImport(pid, imp, rows.length, newIds);
    return { newCount: r.newCount, duplicateCount: r.duplicateCount, match: r.match };
  }

  private txnRows(v: unknown): TxnInput[] {
    if (!Array.isArray(v) || v.length > ROWS_MAX) return fail('bad_rows');
    const rows = v.map((r): Omit<TxnInput, 'rowKey'> & { sourceKey: string | null } => {
      const o = r as Record<string, unknown>;
      const day = typeof o.day === 'string' && ISO.test(o.day) ? o.day : fail('bad_rows');
      const occurredAt = typeof o.occurredAt === 'string' && o.occurredAt.startsWith(day) && o.occurredAt.length <= 19 ? o.occurredAt : fail('bad_rows');
      const direction = o.direction === 'in' || o.direction === 'out' ? o.direction : fail('bad_rows');
      const amount = Number.isSafeInteger(o.amount) && (o.amount as number) > 0 ? (o.amount as number) : fail('bad_rows');
      const balance = o.balance === null || o.balance === undefined ? null : Number.isSafeInteger(o.balance) ? (o.balance as number) : fail('bad_rows');
      const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : null);
      const sourceKey = typeof o.sourceKey === 'string' && /^[0-9a-f]{32}:(in|out)$/.test(o.sourceKey) ? o.sourceKey : null;
      return { day, occurredAt, direction, amount, balance, payer: text(o.payer), memo: text(o.memo), counterAccount: typeof o.counterAccount === 'string' ? o.counterAccount.slice(0, 40) : null, sourceKey };
    });
    const keys = rowKeys(rows);
    return rows.map(({ sourceKey, ...r }, i) => ({ ...r, rowKey: sourceKey ? createHash('sha256').update(`src|${sourceKey}`).digest('hex').slice(0, 32) : keys[i]! }));
  }

  private async importTxns(p: Params) {
    const pid = this.profile(p.profileId);
    const accountId = this.ownAccount({ profileId: pid, id: p.accountId });
    const rows = this.txnRows(p.rows);
    if (!rows.length) return fail('no_rows');
    const documentId = await this.keepFile(pid, 'bank_statement', p.file);
    const { import: imp, newIds } = this.repo.importTxns({ profileId: pid, accountId, source: 'file', documentId, format: p.mapping, rows, period: periodOf(p.period) }, this.at());
    this.rememberFormat(p.signature, p.mapping);
    return this.afterImport(pid, imp, rows.length, newIds);
  }

  private afterImport(pid: string, imp: unknown, total: number, newIds: string[]) {
    const m = this.rematch(pid);
    const fresh = new Set(newIds);
    return {
      import: imp,
      newCount: newIds.length,
      duplicateCount: total - newIds.length,
      match: { auto: m.autoTxnIds.filter((t) => fresh.has(t)).length, review: m.review.filter((t) => fresh.has(t)).length, unknown: m.unknown.filter((t) => fresh.has(t)).length },
      payMatch: { auto: m.out.autoTxnIds.filter((t) => fresh.has(t)).length, review: m.out.review.filter((t) => fresh.has(t)).length, unknown: m.out.unknown.filter((t) => fresh.has(t)).length },
    };
  }

  private async importInvoices(p: Params) {
    const pid = this.profile(p.profileId);
    if (!Array.isArray(p.rows) || p.rows.length > 5000) return fail('bad_rows');
    const me = new ProfileRepo(this.db).get(pid)?.bizNo?.replace(/\D/g, '') ?? null;
    this.syncLedger(pid);
    const cps = new CounterpartyRepo(this.db);
    const out = { created: 0, merged: 0, purchase: 0, purchaseCreated: 0, skipped: 0, newCounterparties: 0 };
    const documentId = p.rows.length ? await this.keepFile(pid, 'hometax_issue_list', p.file) : null;
    const at = this.at();
    this.db.transaction(() => {
      const onOriginal = this.creditsOnOriginal(pid, p.rows as Array<Record<string, unknown>>);
      for (const raw of p.rows as Array<Record<string, unknown>>) {
        const r = onOriginal.has(approvalKey(String(raw.approvalNo))) ? null : this.upsertHometaxInvoice(pid, me, cps, raw, at);
        if (!r) {
          out.skipped++;
          continue;
        }
        if (r.newCounterparty) out.newCounterparties++;
        if (r.kind === 'purchase') {
          out.purchase++;
          if (r.created) out.purchaseCreated++;
        } else if (r.created) out.created++;
        else out.merged++;
      }
    })();
    const m = this.rematch(pid);
    return { ...out, documentId, match: { auto: m.autoTxnIds.length, review: m.review.length, unknown: m.unknown.length }, payMatch: { auto: m.out.autoTxnIds.length, review: m.out.review.length, unknown: m.out.unknown.length } };
  }

  /** 홈택스 목록의 세금계산서 한 줄을 받을 돈, 낼 돈 줄로 넣거나 합친다(승인번호가 자연 키). 파일 올리기와 자동 받기가 같이 쓴다 */
  private upsertHometaxInvoice(pid: string, me: string | null, cps: CounterpartyRepo, raw: Record<string, unknown>, at: string, listKind?: Kind): { kind: Kind; created: boolean; newCounterparty: boolean } | null {
    const approval = typeof raw.approvalNo === 'string' ? approvalKey(raw.approvalNo) : '';
    const writtenOn = typeof raw.writtenOn === 'string' && ISO.test(raw.writtenOn) ? raw.writtenOn : null;
    const total = Number.isSafeInteger(raw.total) ? (raw.total as number) : null;
    if (approval.length !== 24 || !writtenOn || !total) return null;
    const buyer = typeof raw.buyerBizNo === 'string' ? raw.buyerBizNo.replace(/\D/g, '') : '';
    const supplier = typeof raw.supplierBizNo === 'string' ? raw.supplierBizNo.replace(/\D/g, '') : '';
    const kind: Kind = listKind ?? (me && buyer === me && supplier !== me ? 'purchase' : 'sale');
    const side = kind === 'purchase' ? { bizNo: supplier, name: raw.supplierName, rep: raw.supplierRep } : { bizNo: buyer, name: raw.buyerName, rep: raw.buyerRep };
    const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 120) : null);
    let cpId: string | null = null;
    let newCounterparty = false;
    if (side.bizNo.length === 10 && isValidBizNo(side.bizNo) && !cps.isOwnBizNo(side.bizNo)) {
      const cur = cps.byBizNo(side.bizNo);
      if (cur) cpId = cur.id;
      else if (text(side.name)) {
        cpId = cps.create({ bizNo: side.bizNo, name: text(side.name)!, repName: text(side.rep), source: 'hometax' }).id;
        newCounterparty = true;
      }
    }
    const num = (x: unknown) => (Number.isSafeInteger(x) ? (x as number) : null);
    try {
      const r = this.repo.upsertReceivable(pid, { kind, approvalNo: approval, counterpartyId: cpId, cpBizNo: side.bizNo || null, cpName: text(side.name), cpRep: text(side.rep), item: text(raw.item), writtenOn, supply: num(raw.supply), tax: num(raw.tax), total, from: 'hometax', receipt: raw.receipt === '영수' || raw.receipt === '청구' ? raw.receipt : null }, at);
      return { kind, created: r.created, newCounterparty };
    } catch (e) {
      if (e instanceof ValidationError && e.code === 'kind_mismatch') return null;
      throw e;
    }
  }

  /**
   * 홈택스 목록의 매출 수정분(음수) 가운데 장부에 제 줄로 두지 않을 줄의 승인번호. 이미 제 줄로 들어가 있으면 지운다.
   * 앱에서 낸 수정세금계산서는 당초분 줄을 이미 줄였으니(syncLedger), 같은 거래처, 작성일자, 금액의 목록 줄을 그 수만큼 뺀다. 남는 줄(앱 밖에서 낸 수정분)만 제 줄로 들어간다.
   */
  private creditsOnOriginal(pid: string, rows: ReadonlyArray<Record<string, unknown>>): Set<string> {
    const digits = (x: unknown) => (typeof x === 'string' ? x.replace(/\D/g, '') : '');
    const applied = new Map<string, number>();
    const adjusts = this.db
      .prepare(`SELECT r.cp_biz_no AS biz, CASE WHEN m.what IN ('wrong_entry','local_lc') THEN r.written_on ELSE a.written_on END AS day, a.total
        FROM receivable_adjusts a JOIN receivables r ON r.id = a.receivable_id LEFT JOIN invoice_amends m ON m.run_id = a.run_id WHERE a.profile_id = ? AND r.kind = 'sale'`)
      .all(pid) as Array<{ biz: string | null; day: string; total: number }>;
    for (const a of adjusts) applied.set(`${a.biz}|${a.day}|${a.total}`, (applied.get(`${a.biz}|${a.day}|${a.total}`) ?? 0) + 1);
    const listed = new Map<string, string[]>();
    for (const raw of rows) {
      if (!Number.isSafeInteger(raw.total) || (raw.total as number) >= 0) continue;
      const key = `${digits(raw.buyerBizNo)}|${String(raw.writtenOn)}|${raw.total as number}`;
      if (applied.has(key)) listed.set(key, [...(listed.get(key) ?? []), approvalKey(String(raw.approvalNo))]);
    }
    const out = new Set<string>();
    for (const [key, approvals] of listed) {
      const own = approvals.filter((a) => this.repo.byApproval(pid, a)).sort();
      const rest = approvals.filter((a) => !own.includes(a)).sort();
      const ownLines = Math.max(0, approvals.length - applied.get(key)!);
      for (const a of [...own.slice(ownLines), ...rest.slice(Math.max(0, ownLines - own.length))]) out.add(a);
    }
    for (const a of out) this.db.prepare('DELETE FROM receivables WHERE profile_id = ? AND approval_no = ? AND total < 0').run(pid, a);
    return out;
  }

  private syncRecords(pid: string): SyncRecord[] {
    return this.db.prepare('SELECT kind, range_from AS "from", range_to AS "to", finished_at AS finishedAt, code FROM hometax_syncs WHERE profile_id = ?').all(pid) as SyncRecord[];
  }

  /** 자동 받기를 지금 할지와 받을 구간(ADR-068 결정 6). firstUnlock = 앱을 켠 뒤 첫 잠금 풀기 */
  private hometaxPlan(pid: string, firstUnlock: boolean): { due: boolean; steps: ReturnType<typeof syncPlan> } {
    const recs = this.syncRecords(pid);
    const due = syncDue(recs, Date.parse(this.at()), firstUnlock);
    return { due, steps: due ? syncPlan(recs, this.today()) : [] };
  }

  /**
   * 홈택스 받기 한 구간의 결과를 넣는다(ADR-068 결정 10 받기 층). 줄은 자연 키로 넣거나 합쳐 두 번 받아도 늘지 않는다.
   * 실패(code)도 기록하되 덮음으로 치지 않는다. 받은 줄이 하나라도 형식이 틀리면 그 줄만 빼고 센다(skipped).
   */
  private hometaxSync(p: Params): { syncId: string; rows: number; created: number; merged: number; skipped: number } {
    const pid = this.profile(p.profileId);
    const kind = (SYNC_KINDS as readonly unknown[]).includes(p.kind) ? (p.kind as (typeof SYNC_KINDS)[number]) : fail('bad_kind');
    const trigger = p.trigger === 'unlock' || p.trigger === 'run' || p.trigger === 'human' ? p.trigger : fail('bad_trigger');
    const today = this.today();
    const from = typeof p.from === 'string' && ISO.test(p.from) ? p.from : fail('bad_range');
    const to = typeof p.to === 'string' && ISO.test(p.to) && p.to >= from && p.to <= today ? p.to : fail('bad_range');
    const given = p.code === undefined || p.code === null ? null : typeof p.code === 'string' && /^[a-z_.]{1,40}$/.test(p.code) ? p.code : fail('bad_code');
    // 한 구간은 금고가 읽는 상한(5,000줄)까지다. 사업용 카드는 한 실행의 달을 모아 넣으므로 처음 받기의 13달만큼 받는다
    const rowsMax = kind === 'business_card' ? 5000 * 13 : 5000;
    const read = given ? [] : Array.isArray(p.rows) && p.rows.length <= rowsMax ? (p.rows as Array<Record<string, unknown>>) : fail('bad_rows');
    const listKind: Kind | null = kind === 'sale_invoice' ? 'sale' : kind === 'purchase_invoice' ? 'purchase' : null;
    const me = listKind ? (new ProfileRepo(this.db).get(pid)?.bizNo?.replace(/\D/g, '') || fail('profile_missing')) : null;
    const inRange = (d: unknown): d is string => typeof d === 'string' && ISO.test(d) && d >= from && d <= to;
    const code = given ?? (!listKind ? null : read.some((r) => !mineRow(listKind, me!, r)) ? 'report.not_mine' : read.some((r) => !usableInvoice(r) || !inRange(r.writtenOn)) ? 'report.row_unusable' : null);
    const rows = code ? [] : read;
    // 사업용 카드는 card_fetches(실행마다 한 줄)에 남긴다. 한 실행에서 여러 구간을 받았으면 모아 한 번에 넣는다
    const runId = kind === 'business_card' && !code ? (typeof p.runId === 'string' && this.db.prepare('SELECT 1 FROM runs WHERE id = ? AND profile_id = ?').get(p.runId, pid) ? p.runId : fail('bad_run')) : null;
    if (runId && this.db.prepare('SELECT 1 FROM card_fetches WHERE run_id = ?').get(runId)) fail('already_synced');
    const syncId = randomUUID();
    const at = this.at();
    const out = { syncId, rows: rows.length, created: 0, merged: 0, skipped: 0 };
    const won = (x: unknown) => (Number.isSafeInteger(x) && Math.abs(x as number) <= 100_000_000_000 ? (x as number) : null);
    const text = (x: unknown, n: number) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, n) : null);
    if (listKind) this.syncLedger(pid);
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO hometax_syncs (id, profile_id, kind, range_from, range_to, row_count, trigger, finished_at, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(syncId, pid, kind, from, to, rows.length, trigger, at, code);
      if (listKind) {
        const cps = new CounterpartyRepo(this.db);
        const onOriginal = listKind === 'sale' ? this.creditsOnOriginal(pid, rows) : new Set<string>();
        for (const raw of rows) {
          if (onOriginal.has(approvalKey(String(raw.approvalNo)))) {
            out.merged++;
            continue;
          }
          const r = inRange(raw.writtenOn) ? this.upsertHometaxInvoice(pid, me, cps, raw, at, listKind) : null;
          if (!r) out.skipped++;
          else if (r.created) out.created++;
          else out.merged++;
        }
      } else if (kind === 'cash_receipt_in' || kind === 'cash_receipt_out') {
        const side = kind === 'cash_receipt_in' ? 'in' : 'out';
        const put = this.db.prepare(`INSERT INTO cash_receipts (id, profile_id, side, day, approval_no, amount, supply, tax, cp_biz_no, cp_name, canceled, deductible, sync_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, side, day, approval_no, canceled) DO UPDATE SET amount = excluded.amount, supply = excluded.supply, tax = excluded.tax, cp_biz_no = excluded.cp_biz_no, cp_name = excluded.cp_name, deductible = excluded.deductible, sync_id = excluded.sync_id`);
        const had = this.db.prepare('SELECT 1 FROM cash_receipts WHERE profile_id = ? AND side = ? AND day = ? AND approval_no = ? AND canceled = ?').pluck();
        for (const raw of rows) {
          const approval = typeof raw.approvalNo === 'string' ? raw.approvalNo.replace(/[^0-9A-Za-z]/g, '').slice(0, 40) : '';
          const amount = won(raw.amount);
          if (!inRange(raw.day) || approval.length < 6 || amount === null || amount <= 0) {
            out.skipped++;
            continue;
          }
          const biz = typeof raw.cpBizNo === 'string' ? raw.cpBizNo.replace(/\D/g, '') : '';
          const existed = !!had.get(pid, side, raw.day, approval, raw.canceled === true ? 1 : 0);
          put.run(randomUUID(), pid, side, raw.day, approval, amount, won(raw.supply), won(raw.tax), biz.length === 10 ? biz : null, text(raw.cpName, 120), raw.canceled === true ? 1 : 0, typeof raw.deductible === 'boolean' ? (raw.deductible ? 1 : 0) : null, syncId);
          if (existed) out.merged++;
          else out.created++;
        }
      } else if (kind === 'business_card') {
        if (!runId) return;
        const ok: Parameters<CardRepo['replaceRange']>[1][number][] = [];
        for (const raw of rows) {
          const biz = typeof raw.merchantBizNo === 'string' ? raw.merchantBizNo.replace(/\D/g, '') : '';
          const last4 = typeof raw.cardLast4 === 'string' ? raw.cardLast4.replace(/\D/g, '').slice(-4) : '';
          const amount = won(raw.amount);
          if (!inRange(raw.usedOn) || amount === null) {
            out.skipped++;
            continue;
          }
          ok.push({ usedOn: raw.usedOn, merchant: text(raw.merchant, 120), merchantBizNo: biz.length === 10 ? biz : null, cardLast4: last4.length === 4 ? last4 : null,
            approvalNo: text(raw.approvalNo, 40), amount, supplyAmount: won(raw.supplyAmount), vatAmount: won(raw.vatAmount), canceled: raw.canceled === true, deductible: typeof raw.deductible === 'boolean' ? raw.deductible : null });
        }
        // 받은 구간의 줄을 통째로 바꾼다(같은 날을 다시 받으면 새 회차가 이긴다, 결정 10)
        new CardRepo(this.db).replaceRange({ runId, profileId: pid, rangeFrom: from, rangeTo: to, completedAt: at }, ok);
        out.created = ok.length;
      } else {
        // 카드 매출은 카드사별 달 합계다. 받은 구간이 덮은 달의 값으로 바꾼다
        const put = this.db.prepare('INSERT INTO card_sales (profile_id, month, issuer, count, amount, sync_id) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(profile_id, month, issuer) DO UPDATE SET count = excluded.count, amount = excluded.amount, sync_id = excluded.sync_id');
        const had = this.db.prepare('SELECT 1 FROM card_sales WHERE profile_id = ? AND month = ? AND issuer = ?').pluck();
        for (const raw of rows) {
          const month = typeof raw.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(raw.month) && raw.month >= from.slice(0, 7) && raw.month <= to.slice(0, 7) ? raw.month : null;
          const issuer = text(raw.issuer, 40);
          const amount = won(raw.amount);
          const count = Number.isSafeInteger(raw.count) && (raw.count as number) >= 0 ? (raw.count as number) : null;
          if (!month || !issuer || amount === null || count === null) {
            out.skipped++;
            continue;
          }
          const existed = !!had.get(pid, month, issuer);
          put.run(pid, month, issuer, count, amount, syncId);
          if (existed) out.merged++;
          else out.created++;
        }
      }
    })();
    if (kind === 'sale_invoice' || kind === 'purchase_invoice') this.rematch(pid);
    return out;
  }

  /**
   * 원장(확정된 발급)을 받을 돈 줄로 옮긴다. 자료 파이프라인의 "앱 발급" 받기 길이다(ADR-068 결정 10).
   * 작성일자와 품목은 실행 입력 요약 그대로 쓴다(예전 행은 확정 시각의 날짜, 품목 없음).
   * 수정세금계산서(ADR-058)는 당초분에 반영한다: 음수 수정분은 당초분을 줄이고, 잘못 적음과 내국신용장은 당초분을 모두 지운 뒤 새 장을 새 줄로 둔다.
   * 실행마다 한 번만 반영한다(줄은 run_id, 수정은 receivable_adjusts.run_id).
   */
  syncLedger(pid: string): number {
    const rows = this.db
      .prepare(`SELECT l.run_id, l.verify_ref, l.armed_at, r.inputs_json_enc, a.what AS amend_what, a.original_approval_no AS amend_of
        FROM irreversible_log l JOIN runs r ON r.id = l.run_id LEFT JOIN invoice_amends a ON a.run_id = l.run_id AND a.state = 'committed'
        WHERE l.state IN ('committed','observed_manual') AND r.profile_id = ?
          AND (l.run_id NOT IN (SELECT run_id FROM receivables WHERE run_id IS NOT NULL) OR (a.run_id IS NOT NULL AND l.run_id NOT IN (SELECT run_id FROM receivable_adjusts)))
        ORDER BY l.armed_at, l.run_id`)
      .all(pid) as Array<{ run_id: string; verify_ref: string | null; armed_at: string; inputs_json_enc: Uint8Array | null; amend_what: string | null; amend_of: string | null }>;
    if (!rows.length) return 0;
    const cps = new CounterpartyRepo(this.db);
    let n = 0;
    const at = this.at();
    for (const r of rows) {
      if (!(r.inputs_json_enc instanceof Uint8Array) || !r.inputs_json_enc.length) continue;
      let inputs: { counterpartyId?: unknown; supply?: unknown; tax?: unknown; v?: unknown; item?: unknown; issueDate?: unknown };
      try {
        inputs = JSON.parse(this.cipher.open(r.inputs_json_enc, `runs.inputs_json_enc|${r.run_id}`));
      } catch {
        continue;
      }
      if (inputs.v !== 1 || typeof inputs.counterpartyId !== 'string' || !Number.isSafeInteger(inputs.supply) || !Number.isSafeInteger(inputs.tax)) continue;
      const supply = inputs.supply as number;
      const tax = inputs.tax as number;
      const total = supply + tax;
      const writtenOn = typeof inputs.issueDate === 'string' && ISO.test(inputs.issueDate) ? inputs.issueDate : kstDay(new Date(r.armed_at));
      if (r.amend_of && !this.repo.adjusted(r.run_id)) {
        const orig = this.repo.byApproval(pid, r.amend_of.replace(/\D/g, ''));
        const whole = r.amend_what === 'wrong_entry' || r.amend_what === 'local_lc';
        if (orig && orig.kind === 'sale' && (whole || total < 0)) {
          const d = whole ? { supply: -(orig.supply ?? orig.total), tax: -(orig.tax ?? 0), total: -orig.total } : { supply, tax, total };
          if (this.repo.adjustReceivable(pid, orig.id, r.run_id, d, writtenOn, at)) n++;
        }
      }
      if (total <= 0 || this.repo.byRun(r.run_id)) continue;
      const cp = cps.get(inputs.counterpartyId);
      const approval = r.verify_ref ? r.verify_ref.replace(/\D/g, '') : '';
      const item = typeof inputs.item === 'string' && inputs.item.trim() ? inputs.item.trim().slice(0, 100) : null;
      this.repo.upsertReceivable(pid, {
        approvalNo: approval.length === 24 ? approval : null, runId: r.run_id, counterpartyId: cp?.id ?? null, cpBizNo: cp?.bizNo ?? null, cpName: cp?.name ?? null, cpRep: cp?.repName ?? null, item,
        writtenOn, supply, tax, total, from: 'ledger',
      }, at);
      n++;
    }
    return n;
  }

  private cpKeyOf(r: Receivable): string {
    return r.counterpartyId ?? (r.cpBizNo ? `biz:${r.cpBizNo}` : `r:${r.id}`);
  }

  /**
   * 홈택스 목록의 수정세금계산서 음수분(#55)을 같은 거래처의 당초분에 붙여 그 줄의 남은 돈을 줄인다.
   * 목록은 당초 승인번호를 주지 않아 줄을 고른다: 남은 돈이 음수분과 같은 줄(순액을 보낸 경우), 작성일자가 같은 줄(착오 정정),
   * 합계가 음수분과 같은 줄(계약 해제), 그다음 음수분 날짜에 가장 가까운 줄 순서다. 음수분보다 늦게 쓴 줄은 당초분일 수 없어 맨 뒤에 둔다
   * (그 거래처에 돌려줄 돈을 다음 계산서에서 빼는 것과 같다). 어느 줄에 붙여도 거래처 합계는 같다(리포트 받을 돈과 같은 값).
   * 붙일 줄이 모자라면 남은 음수분은 그 줄에 그대로 남는다(돌려줄 돈). 영수 줄은 이미 받은(돌려준) 돈이라 붙이지도, 붙지도 않는다.
   * sure: 입금 자동 맞춤용. 고를 줄이 하나뿐이거나 금액, 날짜 단서로 하나로 정해질 때만 붙인다(짐작한 줄로 입금을 자동으로 붙이지 않는다).
   */
  private creditsOf(rows: Receivable[], paid: Map<string, number>, sure = false): Map<string, number> {
    const out = new Map<string, number>();
    const open = new Map<string, Array<{ r: Receivable; left: number }>>();
    for (const r of rows) {
      if (r.excludedAt || r.total <= 0 || r.receipt === '영수') continue;
      const left = r.total - (paid.get(r.id) ?? 0);
      if (left <= 0) continue;
      const k = this.cpKeyOf(r);
      open.set(k, [...(open.get(k) ?? []), { r, left }]);
    }
    const credits = rows.filter((r) => !r.excludedAt && r.total < 0 && r.receipt !== '영수' && (r.counterpartyId || r.cpBizNo)).sort((a, b) => a.writtenOn.localeCompare(b.writtenOn) || a.id.localeCompare(b.id));
    for (const c of credits) {
      const amount = -c.total;
      type Open = { r: Receivable; left: number };
      const clue = (o: Open) => (o.left === amount ? 0 : 4) + (o.r.writtenOn === c.writtenOn ? 0 : 2) + (o.r.total === amount ? 0 : 1);
      const rank = (o: Open) => clue(o) + (o.r.writtenOn > c.writtenOn ? 8 : 0);
      const gap = (o: Open) => Math.abs(Date.parse(o.r.writtenOn) - Date.parse(c.writtenOn));
      const pool = (open.get(this.cpKeyOf(c)) ?? []).filter((o) => o.left > 0).sort((a, b) => rank(a) - rank(b) || gap(a) - gap(b) || a.r.id.localeCompare(b.r.id));
      if (sure && pool.length > 1 && (clue(pool[0]!) === 7 || rank(pool[0]!) === rank(pool[1]!))) continue;
      let left = amount;
      for (const o of pool) {
        if (!left) break;
        const x = Math.min(left, o.left);
        o.left -= x;
        left -= x;
        out.set(o.r.id, (out.get(o.r.id) ?? 0) + x);
      }
      if (left < amount) out.set(c.id, amount - left);
    }
    return out;
  }

  /** 거래처마다 마지막으로 쓴 매출 세금계산서 날짜. 앱에서 발급한 것과 홈택스에서 받은 것(앱 밖 발급)을 모두 센다. 받을 돈에서 뺀 건도 발급한 것이라 센다(F8). */
  private lastSales(pid: string): Array<{ counterpartyId: string; day: string }> {
    return this.db
      .prepare(`SELECT counterparty_id AS counterpartyId, max(written_on) AS day FROM receivables WHERE profile_id = ? AND kind = 'sale' AND counterparty_id IS NOT NULL GROUP BY counterparty_id`)
      .all(pid) as Array<{ counterpartyId: string; day: string }>;
  }

  private remainingOf(pid: string): Map<string, number> {
    const paid = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) paid.set(a.receivableId, (paid.get(a.receivableId) ?? 0) + a.amount);
    return paid;
  }

  private dueOf(r: Receivable, termsCache: Map<string, PayTerms>, def: PayTerms): string | null {
    let t = def;
    if (r.counterpartyId) {
      if (!termsCache.has(r.counterpartyId)) termsCache.set(r.counterpartyId, this.repo.payTerms(r.counterpartyId, SIDE[r.kind]) ?? def);
      t = termsCache.get(r.counterpartyId)!;
    }
    return dueDate(r.writtenOn, t);
  }

  private matchInput(pid: string, kind: Kind) {
    const recvs = this.repo.receivables(pid, kind);
    const paid = this.remainingOf(pid);
    const def = this.defaultTerms(pid, kind);
    const terms = new Map<string, PayTerms>();
    const human = new Set(
      (this.db.prepare(`SELECT DISTINCT r.counterparty_id FROM receivable_allocs a JOIN receivables r ON r.id = a.receivable_id WHERE a.profile_id = ? AND r.kind = ? AND a.removed_at IS NULL AND a.decided_by <> 'auto' AND a.txn_id IS NOT NULL AND r.counterparty_id IS NOT NULL`).pluck().all(pid, kind) as string[]),
    );
    const cpMap = new Map<string, MatchCounterparty>();
    const cpRepo = new CounterpartyRepo(this.db);
    for (const r of recvs) {
      const key = this.cpKeyOf(r);
      if (cpMap.has(key)) continue;
      const cp = r.counterpartyId ? cpRepo.get(r.counterpartyId) : null;
      cpMap.set(key, {
        key, name: cp?.name ?? r.cpName, rep: cp?.repName ?? r.cpRep,
        aliases: r.counterpartyId ? this.repo.aliases(r.counterpartyId).map((a) => a.nameNorm) : [],
        holders: r.counterpartyId ? this.repo.cpAccounts(r.counterpartyId).map((a) => normalizePayerName(a.holder)).filter((h) => h.length >= 2) : [],
        accountHmacs: r.counterpartyId ? this.db.prepare('SELECT number_hmac FROM cp_bank_accounts WHERE counterparty_id = ?').pluck().all(r.counterpartyId) as string[] : [],
        humanConfirmed: !!r.counterpartyId && human.has(r.counterpartyId),
      });
    }
    const credit = this.creditsOf(recvs, paid, true);
    const receivables: MatchReceivable[] = recvs
      .filter((r) => !r.excludedAt && r.total > 0 && r.receipt !== '영수')
      .map((r) => ({ id: r.id, cpKey: this.cpKeyOf(r), writtenOn: r.writtenOn, dueOn: r.promisedOn ?? this.dueOf(r, terms, def), remaining: r.total - (paid.get(r.id) ?? 0) - (credit.get(r.id) ?? 0) }));
    const used = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) if (a.txnId) used.set(a.txnId, (used.get(a.txnId) ?? 0) + a.amount);
    const txns: MatchTxn[] = this.repo
      .txns(pid, { direction: SIDE[kind] })
      .filter((t) => !t.ignoredAt)
      .map((t) => ({ id: t.id, day: t.day, amount: t.amount, unallocated: t.amount - (used.get(t.id) ?? 0), payer: t.payer, counterAccountHmac: t.counterAccountHmac, assignedCpKey: t.assignedCounterpartyId }));
    return { recvs, receivables, txns, cps: [...cpMap.values()], rejects: this.repo.rejects(pid) };
  }

  rematch(pid: string): MatchRun & { out: MatchRun } {
    this.syncLedger(pid);
    const sale = this.rematchKind(pid, 'sale');
    const out = this.repo.receivables(pid, 'purchase').length ? this.rematchKind(pid, 'purchase') : { autoTxnIds: [], review: [], unknown: [], candidates: new Map<string, Candidate[]>() };
    return { ...sale, candidates: new Map([...sale.candidates, ...out.candidates]), out };
  }

  private rematchKind(pid: string, kind: Kind): MatchRun {
    const input = this.matchInput(pid, kind);
    const res = runMatch({ counterparties: input.cps, receivables: input.receivables, txns: input.txns, rejects: input.rejects, feeTolerance: FEE_TOLERANCE, side: SIDE[kind] });
    const at = this.at();
    this.db.transaction(() => {
      for (const a of res.auto) {
        const alloc = this.repo.addAlloc({ profileId: pid, receivableId: a.receivableId, txnId: a.txnId, amount: a.amount, method: 'account', decidedBy: 'auto', reason: a.signal }, at);
        this.repo.addEvent(pid, { receivableId: a.receivableId, txnId: a.txnId, allocId: alloc.id, actor: 'auto', action: 'attach', reason: a.signal, undoOf: null }, at);
      }
    })();
    const review: string[] = [];
    const unknown: string[] = [];
    for (const [t, c] of res.candidates) (c.length ? review : unknown).push(t);
    return { autoTxnIds: res.auto.map((a) => a.txnId), review, unknown, candidates: res.candidates };
  }

  private views(pid: string, kind: Kind = 'sale'): { list: ReceivableView[]; byId: Map<string, ReceivableView> } {
    this.syncLedger(pid);
    const today = this.today();
    const { from: coveredFrom, to: latestDay } = this.repo.coverage(pid, SIDE[kind]);
    const stale = !latestDay || latestDay < addDays(today, -STALE_DAYS);
    const def = this.defaultTerms(pid, kind);
    const terms = new Map<string, PayTerms>();
    const allocs = this.repo.liveAllocs(pid);
    const byRecv = new Map<string, Alloc[]>();
    for (const a of allocs) byRecv.set(a.receivableId, [...(byRecv.get(a.receivableId) ?? []), a]);
    const cps = new CounterpartyRepo(this.db);
    const rows = this.repo.receivables(pid, kind);
    const credit = this.creditsOf(rows, new Map([...byRecv].map(([id, as]) => [id, as.reduce((s, a) => s + a.amount, 0)])));
    const list = rows.map((r): ReceivableView => {
      const as = byRecv.get(r.id) ?? [];
      // 영수 계산서는 이미 받은 돈이다(현금, 카드 등). 매출에는 들고 받을 돈에는 없다(파이프라인 점검 11-28 F10)
      const paidOutside = r.receipt === '영수';
      const received = paidOutside ? r.total : as.reduce((s, a) => s + a.amount, 0);
      const credited = credit.get(r.id) ?? 0;
      const remaining = Math.max(0, r.total - received - (r.total > 0 ? credited : 0));
      const due = this.dueOf(r, terms, def);
      const waiting = !!r.promisedOn && r.promisedOn >= today;
      // 통장 기록이 시작되기 전에 쓴 계산서는 그 사이 입금을 앱이 못 봤다. 못 받았다고 하지 않는다(대형 사업자 시험 11-28 B2).
      const before = coveredFrom === null || r.writtenOn < coveredFrom;
      const status: ReceivableStatus = r.excludedAt ? 'excluded' : remaining === 0 ? 'received' : waiting ? 'waiting' : received > 0 ? 'partial' : stale || before ? 'unknown' : 'unpaid';
      const eff = r.promisedOn ?? due;
      const dueIn = eff ? Math.round((Date.parse(`${eff}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000) : null;
      const off = as.find((a) => a.txnId === null && a.method !== 'fee');
      return {
        id: r.id, counterpartyId: r.counterpartyId, cpName: (r.counterpartyId ? cps.get(r.counterpartyId)?.name : null) ?? r.cpName, cpBizNo: r.cpBizNo, item: r.item,
        approvalTail: r.approvalNo ? r.approvalNo.slice(-8) : null, writtenOn: r.writtenOn, total: r.total, tax: r.tax, received, credited, remaining, dueOn: due, promisedOn: r.promisedOn, dueIn,
        // 영수/청구를 아직 모르는 줄(앱 발급 뒤 홈택스 목록 전, 옛 줄)은 기한 지남으로 치지 않는다
        overdue: (status === 'unpaid' || status === 'partial') && r.receipt === '청구' && dueIn !== null && dueIn < 0,
        status, via: status === 'received' && !paidOutside ? (as.every((a) => a.decidedBy === 'auto' || a.method === 'fee') ? 'auto' : 'manual') : null,
        offAccount: off?.method ?? null, sources: [...(r.fromLedger ? ['ledger' as const] : []), ...(r.fromHometax ? ['hometax' as const] : [])], excludedReason: r.excludedReason,
      };
    });
    return { list, byId: new Map(list.map((v) => [v.id, v])) };
  }

  private txnView(t: BankTxn, unallocated: number, acct: Map<string, { last4: string; bank: string }>, cands: Candidate[], views: Map<string, ReceivableView>): TxnView {
    const a = acct.get(t.accountId);
    return {
      id: t.id, accountId: t.accountId, accountLast4: a?.last4 ?? '', bank: a?.bank ?? '', day: t.day, occurredAt: t.occurredAt, direction: t.direction, amount: t.amount, unallocated,
      payer: t.payer, memo: t.memo, ignoredReason: t.ignoredReason, assignedCounterpartyId: t.assignedCounterpartyId,
      candidates: cands.map((c) => {
        const v = views.get(c.receivableIds[0]!);
        return { receivableIds: c.receivableIds, cpName: v?.cpName ?? null, fit: c.fit, amounts: c.amounts, feeGap: c.feeGap, reason: c.reason, writtenOn: v?.writtenOn ?? '', total: c.receivableIds.reduce((s, id) => s + (views.get(id)?.total ?? 0), 0) };
      }),
    };
  }

  private sideLists(pid: string, kind: Kind, m: MatchRun & { out: MatchRun }) {
    const { list, byId } = this.views(pid, kind);
    const acct = new Map(this.repo.accounts(pid).map((a) => [a.id, { last4: a.last4, bank: a.bank }]));
    const used = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) if (a.txnId) used.set(a.txnId, (used.get(a.txnId) ?? 0) + a.amount);
    const txns = this.repo.txns(pid, { direction: SIDE[kind] });
    const matching = kind === 'sale' || list.length > 0;
    const review: TxnView[] = [];
    const recent: TxnView[] = [];
    for (const t of [...txns].reverse()) {
      const un = t.amount - (used.get(t.id) ?? 0);
      const v = this.txnView(t, un, acct, m.candidates.get(t.id) ?? [], byId);
      if (matching && !t.ignoredAt && un > 0) review.push(v);
      if (recent.length < 200) recent.push(v);
    }
    const unpaid = list.filter((v) => v.status === 'unpaid' || v.status === 'unknown' || v.status === 'partial' || v.status === 'waiting').sort((a, b) => (a.dueIn ?? 99999) - (b.dueIn ?? 99999) || (a.writtenOn < b.writtenOn ? -1 : 1));
    // 받은 돈 목록은 돈이 들어온 건만이다. 음수분 줄과 음수분으로 다 지운 당초분은 받은 것이 아니라 싣지 않는다
    const received = list.filter((v) => v.status === 'received' && v.received > 0).sort((a, b) => (a.writtenOn < b.writtenOn ? 1 : -1));
    const excluded = list.filter((v) => v.status === 'excluded');
    return { list, unpaid, received, excluded, review, recent };
  }

  overview(pid: string) {
    const m = this.rematch(pid);
    const s = this.sideLists(pid, 'sale', m);
    const o = this.sideLists(pid, 'purchase', m);
    return {
      consent: this.consentOf(pid), summary: this.summaryOf(pid, s.list, s.review, o.list, o.review), unpaid: s.unpaid, received: s.received, excluded: s.excluded, review: s.review, recent: s.recent,
      accounts: this.accounts(pid), defaultTerms: this.defaultTerms(pid),
      payables: { unpaid: o.unpaid, paid: o.received, excluded: o.excluded, review: o.review, recent: o.recent, defaultTerms: this.defaultTerms(pid, 'purchase') },
    };
  }

  private payableOf(list: ReceivableView[], review: TxnView[]): PayableSummary {
    const open = list.filter((v) => v.status === 'unpaid' || v.status === 'partial');
    const unsure = list.filter((v) => v.status === 'unknown');
    const over = open.filter((v) => v.overdue);
    const soon = open.filter((v) => !v.overdue && v.dueIn !== null && v.dueIn >= 0 && v.dueIn <= 7);
    const sum = (xs: ReceivableView[]) => xs.reduce((a, v) => a + v.remaining, 0);
    return {
      unpaidCount: open.length, unpaidTotal: sum(open), unconfirmedCount: unsure.length, unconfirmedTotal: sum(unsure), overdueCount: over.length, overdueTotal: sum(over), dueSoonCount: soon.length, dueSoonTotal: sum(soon),
      reviewCount: review.filter((t) => !t.ignoredReason).length,
    };
  }

  private summaryOf(pid: string, list: ReceivableView[], review: TxnView[], payList: ReceivableView[], payReview: TxnView[]): BankSummary {
    const today = this.today();
    const latestDay = this.repo.coverage(pid, 'in').to;
    const stale = !latestDay || latestDay < addDays(today, -STALE_DAYS);
    // 통장 기록 전이라 입금을 볼 수 없던 건(unknown)은 못 받은 돈에 넣지 않는다(데이터 검증 F16)
    const open = list.filter((v) => v.status === 'unpaid' || v.status === 'partial');
    const unsure = list.filter((v) => v.status === 'unknown');
    const over = open.filter((v) => v.overdue).sort((a, b) => (a.dueIn ?? 0) - (b.dueIn ?? 0));
    const autoCount = this.db.prepare(`SELECT count(*) FROM receivable_allocs a JOIN receivables r ON r.id = a.receivable_id WHERE a.profile_id = ? AND r.kind = 'sale' AND a.removed_at IS NULL AND a.decided_by = 'auto'`).pluck().get(pid) as number;
    return {
      today, latestDay, stale, hasAccounts: this.repo.accounts(pid).length > 0,
      unpaidCount: open.length, unpaidTotal: open.reduce((s, v) => s + v.remaining, 0),
      unconfirmedCount: unsure.length, unconfirmedTotal: unsure.reduce((s, v) => s + v.remaining, 0),
      overdueCount: over.length, overdueTotal: over.reduce((s, v) => s + v.remaining, 0),
      oldestOverdue: over[0] ? { cpName: over[0].cpName, writtenOn: over[0].writtenOn, daysOver: -(over[0].dueIn ?? 0) } : null,
      reviewCount: review.filter((t) => !t.ignoredReason).length, autoCount,
      payable: this.payableOf(payList, payReview),
    };
  }

  summary(pid: string): BankSummary {
    return this.overview(pid).summary;
  }

  private detail(pid: string, id: string) {
    const r = this.ownReceivable(pid, id);
    const m = this.rematch(pid);
    const { byId } = this.views(pid, r.kind);
    const view = byId.get(r.id)!;
    const acct = new Map(this.repo.accounts(pid).map((a) => [a.id, { last4: a.last4, bank: a.bank }]));
    const allocs = this.repo.allocsOf(r.id).map((a) => {
      const t = a.txnId ? this.repo.txn(a.txnId) : null;
      return { ...a, txn: t ? { day: t.day, amount: t.amount, payer: t.payer, accountLast4: acct.get(t.accountId)?.last4 ?? '' } : null };
    });
    const used = new Map<string, number>();
    for (const a of this.repo.liveAllocs(pid)) if (a.txnId) used.set(a.txnId, (used.get(a.txnId) ?? 0) + a.amount);
    const from = addDays(r.writtenOn, -30);
    const to = addDays(r.promisedOn ?? view.dueOn ?? r.writtenOn, 90);
    const attachable = this.repo
      .txns(pid, { direction: SIDE[r.kind], from, to })
      .filter((t) => !t.ignoredAt && t.amount - (used.get(t.id) ?? 0) > 0)
      .map((t) => this.txnView(t, t.amount - (used.get(t.id) ?? 0), acct, (m.candidates.get(t.id) ?? []).filter((c) => c.receivableIds.includes(r.id)), byId))
      .sort((a, b) => b.candidates.length - a.candidates.length || (a.day < b.day ? 1 : -1))
      .slice(0, 50);
    const events = this.repo.events(r.id).map((e) => ({ ...e, undone: this.repo.undone(pid, e.seq) }));
    return { receivable: view, allocs, events, attachable };
  }

  private cpBanking(cpId: string) {
    if (!new CounterpartyRepo(this.db).get(cpId)) return fail('not_found');
    return { accounts: this.repo.cpAccounts(cpId), aliases: this.repo.aliases(cpId), terms: this.repo.payTerms(cpId) };
  }

  private event(pid: string, e: Omit<ReceivableEvent, 'seq' | 'at' | 'actor'> & { actor?: ReceivableEvent['actor'] }): number {
    return this.repo.addEvent(pid, { actor: 'user', ...e }, this.at());
  }

  private txnFree(pid: string, txnId: string): number {
    const t = this.repo.txn(txnId)!;
    return t.amount - this.repo.liveAllocs(pid, { txnId }).reduce((s, a) => s + a.amount, 0);
  }

  private recvFree(pid: string, r: Receivable): number {
    return r.total - this.repo.liveAllocs(pid, { receivableId: r.id }).reduce((s, a) => s + a.amount, 0);
  }

  private allocate(pid: string, txn: BankTxn, recvs: Receivable[], amounts: number[] | null, decidedBy: 'candidate' | 'manual', reason: string | null): number[] {
    if (recvs.some((r) => SIDE[r.kind] !== txn.direction)) return fail(txn.direction === 'in' ? 'not_outgoing' : 'not_incoming');
    const keys = new Set(recvs.map((r) => this.cpKeyOf(r)));
    if (keys.size !== 1) return fail('mixed_counterparties');
    const others = this.repo.liveAllocs(pid, { txnId: txn.id }).map((a) => this.repo.receivable(a.receivableId)!).filter(Boolean);
    if (others.some((o) => this.cpKeyOf(o) !== [...keys][0])) return fail('mixed_counterparties');
    let free = this.txnFree(pid, txn.id);
    const seqs: number[] = [];
    const at = this.at();
    this.db.transaction(() => {
      recvs.forEach((r, i) => {
        const want = Math.min(amounts?.[i] ?? Infinity, this.recvFree(pid, r), free);
        if (!(want > 0)) return fail('nothing_to_attach');
        const a = this.repo.addAlloc({ profileId: pid, receivableId: r.id, txnId: txn.id, amount: want, method: 'account', decidedBy, reason }, at);
        this.repo.removeReject(r.id, txn.id);
        free -= want;
        seqs.push(this.event(pid, { receivableId: r.id, txnId: txn.id, allocId: a.id, action: 'attach', reason, undoOf: null }));
      });
    })();
    return seqs;
  }

  private ensureCounterparty(r: Receivable): string | null {
    if (r.counterpartyId) return r.counterpartyId;
    const cps = new CounterpartyRepo(this.db);
    if (!r.cpBizNo || !isValidBizNo(r.cpBizNo) || !r.cpName || cps.isOwnBizNo(r.cpBizNo)) return null;
    const id = cps.byBizNo(r.cpBizNo)?.id ?? cps.create({ bizNo: r.cpBizNo, name: r.cpName, repName: r.cpRep, source: 'hometax' }).id;
    this.db.prepare('UPDATE receivables SET counterparty_id = ? WHERE profile_id = ? AND cp_biz_no = ? AND counterparty_id IS NULL').run(id, r.profileId, r.cpBizNo);
    return id;
  }

  private aliasOffer(txn: BankTxn, cpId: string | null): { name: string; counterpartyId: string; conflict: boolean } | null {
    if (!cpId || !txn.payer) return null;
    const norm = normalizePayerName(txn.payer);
    if (norm.length < 2) return null;
    const owners = this.repo.aliasOwners(norm);
    if (owners.includes(cpId)) return null;
    return { name: txn.payer, counterpartyId: cpId, conflict: owners.length > 0 };
  }

  private accept(p: Params) {
    const pid = this.profile(p.profileId);
    const txn = this.ownTxn(pid, p.txnId);
    if (!Array.isArray(p.receivableIds) || !p.receivableIds.length || p.receivableIds.length > 10) return fail('bad_request');
    const recvs = p.receivableIds.map((id) => this.ownReceivable(pid, id));
    const seqs = this.allocate(pid, txn, recvs, null, 'candidate', 'confirmed');
    if (p.closeFee === true && recvs.length === 1) {
      const gap = this.recvFree(pid, recvs[0]!);
      if (gap > 0 && gap <= FEE_TOLERANCE) seqs.push(...this.closeFeeNow(pid, recvs[0]!, gap));
    }
    const cpId = this.ensureCounterparty(recvs[0]!);
    return { seqs, aliasOffer: this.aliasOffer(txn, cpId) };
  }

  private attach(p: Params) {
    const pid = this.profile(p.profileId);
    const txn = this.ownTxn(pid, p.txnId);
    const r = this.ownReceivable(pid, p.receivableId);
    const amount = p.amount === undefined ? null : Number.isSafeInteger(p.amount) && (p.amount as number) > 0 ? (p.amount as number) : fail('bad_amount');
    const seqs = this.allocate(pid, txn, [r], amount === null ? null : [amount], 'manual', null);
    return { seqs, aliasOffer: this.aliasOffer(txn, this.ensureCounterparty(r)) };
  }

  private detach(p: Params) {
    const pid = this.profile(p.profileId);
    const a = typeof p.allocId === 'string' ? this.repo.alloc(p.allocId) : null;
    if (!a || a.profileId !== pid || a.removedAt) return fail('not_found');
    const at = this.at();
    const seq = this.db.transaction(() => {
      this.repo.removeAlloc(a.id, 'user', at);
      if (a.txnId) this.repo.addReject(a.receivableId, a.txnId, at);
      return this.event(pid, { receivableId: a.receivableId, txnId: a.txnId, allocId: a.id, action: 'detach', reason: a.decidedBy === 'auto' ? 'auto_wrong' : null, undoOf: null });
    })();
    return { seq };
  }

  private reject(p: Params) {
    const pid = this.profile(p.profileId);
    const txn = this.ownTxn(pid, p.txnId);
    const r = this.ownReceivable(pid, p.receivableId);
    this.repo.addReject(r.id, txn.id, this.at());
    return { seq: this.event(pid, { receivableId: r.id, txnId: txn.id, allocId: null, action: 'reject', reason: null, undoOf: null }) };
  }

  private markReceived(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const method = METHODS.includes(p.method as AllocMethod) ? (p.method as AllocMethod) : fail('bad_method');
    const free = this.recvFree(pid, r);
    if (free <= 0) return fail('already_received');
    const amount = p.amount === undefined || p.amount === null ? free : Number.isSafeInteger(p.amount) && (p.amount as number) > 0 && (p.amount as number) <= free ? (p.amount as number) : fail('bad_amount');
    const on = p.on === undefined || p.on === null ? this.today() : typeof p.on === 'string' && ISO.test(p.on) ? p.on : fail('bad_date');
    const at = this.at();
    const seq = this.db.transaction(() => {
      const a = this.repo.addAlloc({ profileId: pid, receivableId: r.id, txnId: null, amount, method, decidedBy: 'manual', reason: 'marked', receivedOn: on, memo: p.memo }, at);
      return this.event(pid, { receivableId: r.id, txnId: null, allocId: a.id, action: 'mark_received', reason: method, undoOf: null });
    })();
    return { seq };
  }

  private closeFeeNow(pid: string, r: Receivable, gap: number): number[] {
    const a = this.repo.addAlloc({ profileId: pid, receivableId: r.id, txnId: null, amount: gap, method: 'fee', decidedBy: 'manual', reason: 'fee_gap', receivedOn: this.today() }, this.at());
    return [this.event(pid, { receivableId: r.id, txnId: null, allocId: a.id, action: 'close_fee', reason: String(gap), undoOf: null })];
  }

  private closeFee(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const gap = this.recvFree(pid, r);
    if (gap <= 0 || gap > FEE_TOLERANCE) return fail('gap_out_of_range');
    return { seqs: this.closeFeeNow(pid, r, gap) };
  }

  private ignoreTxn(p: Params) {
    const pid = this.profile(p.profileId);
    const t = this.ownTxn(pid, p.txnId);
    const reason = p.reason === null ? null : typeof p.reason === 'string' && /^(unrelated|interest|own_transfer|card_sales|card_payment|tax|payroll|other)$/.test(p.reason) ? p.reason : fail('bad_reason');
    this.repo.setIgnored(t.id, reason, this.at());
    return { seq: this.event(pid, { receivableId: null, txnId: t.id, allocId: null, action: reason ? 'ignore' : 'unignore', reason: t.ignoredReason, undoOf: null }) };
  }

  private assignTxn(p: Params) {
    const pid = this.profile(p.profileId);
    const t = this.ownTxn(pid, p.txnId);
    const cpId = typeof p.counterpartyId === 'string' && new CounterpartyRepo(this.db).get(p.counterpartyId) ? p.counterpartyId : fail('not_found');
    let alias: { id: string } | null = null;
    let conflict = false;
    this.repo.assignTxn(t.id, cpId);
    if (p.remember === true && t.payer) {
      const norm = normalizePayerName(t.payer);
      const owners = this.repo.aliasOwners(norm).filter((o) => o !== cpId);
      if (owners.length) conflict = true;
      else if (norm.length >= 2) alias = this.repo.addAlias(cpId, t.payer, 'learned', this.at());
    }
    const seq = this.event(pid, { receivableId: null, txnId: t.id, allocId: alias?.id ?? null, action: alias ? 'alias_learned' : 'assign', reason: cpId, undoOf: null });
    const m = this.rematch(pid);
    const { byId } = this.views(pid, t.direction === 'out' ? 'purchase' : 'sale');
    const acct = new Map(this.repo.accounts(pid).map((a) => [a.id, { last4: a.last4, bank: a.bank }]));
    const auto = (t.direction === 'out' ? m.out : m).autoTxnIds.includes(t.id);
    return { seq, conflict, aliasId: alias?.id ?? null, auto, txn: this.txnView(this.repo.txn(t.id)!, this.txnFree(pid, t.id), acct, m.candidates.get(t.id) ?? [], byId) };
  }

  private setPromised(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const on = p.on === null ? null : typeof p.on === 'string' && ISO.test(p.on) ? p.on : fail('bad_date');
    this.repo.setPromised(r.id, on, this.at());
    return { seq: this.event(pid, { receivableId: r.id, txnId: null, allocId: null, action: 'promise', reason: r.promisedOn, undoOf: null }) };
  }

  private exclude(p: Params) {
    const pid = this.profile(p.profileId);
    const r = this.ownReceivable(pid, p.receivableId);
    const reason = p.reason === null ? null : typeof p.reason === 'string' && p.reason.trim() && p.reason.length <= 200 ? p.reason.trim() : fail('bad_reason');
    this.repo.setExcluded(r.id, reason, this.at());
    return { seq: this.event(pid, { receivableId: r.id, txnId: null, allocId: null, action: 'exclude', reason: r.excludedReason, undoOf: null }) };
  }

  private undo(p: Params) {
    const pid = this.profile(p.profileId);
    const seq = Number.isSafeInteger(p.seq) ? (p.seq as number) : fail('not_found');
    const e = this.repo.event(pid, seq) ?? fail('not_found');
    if (e.undoOf !== null) return fail('cannot_undo');
    if (this.repo.undone(pid, seq)) return fail('already_undone');
    const at = this.at();
    const out = this.db.transaction(() => {
      switch (e.action) {
        case 'attach':
        case 'mark_received':
        case 'close_fee': {
          const a = e.allocId ? this.repo.alloc(e.allocId) : null;
          if (a && !a.removedAt) this.repo.removeAlloc(a.id, 'undo', at);
          break;
        }
        case 'detach': {
          const a = e.allocId ? this.repo.alloc(e.allocId) : null;
          if (!a || !a.removedAt) return fail('cannot_undo');
          if (a.txnId && this.txnFree(pid, a.txnId) < a.amount) return fail('txn_used_elsewhere');
          const r = this.repo.receivable(a.receivableId)!;
          if (this.recvFree(pid, r) < a.amount) return fail('receivable_settled');
          this.repo.restoreAlloc(a.id);
          if (a.txnId) this.repo.removeReject(a.receivableId, a.txnId);
          break;
        }
        case 'reject':
          if (e.receivableId && e.txnId) this.repo.removeReject(e.receivableId, e.txnId);
          break;
        case 'promise':
          this.repo.setPromised(e.receivableId!, e.reason, at);
          break;
        case 'exclude':
          this.repo.setExcluded(e.receivableId!, e.reason, at);
          break;
        case 'ignore':
        case 'unignore':
          if (e.txnId) this.repo.setIgnored(e.txnId, e.reason, at);
          break;
        case 'alias_learned':
          if (e.allocId) this.repo.deleteAlias(e.allocId);
          if (e.txnId) this.repo.assignTxn(e.txnId, null);
          break;
        case 'assign':
          if (e.txnId) this.repo.assignTxn(e.txnId, null);
          break;
        default:
          return fail('cannot_undo');
      }
      return this.repo.addEvent(pid, { receivableId: e.receivableId, txnId: e.txnId, allocId: e.allocId, actor: 'user', action: 'undo', reason: e.action, undoOf: seq }, at);
    })();
    return { seq: out };
  }

  private addCpAccount(p: Params) {
    const cpId = this.str(p.counterpartyId, 'not_found');
    const a = this.repo.addCpAccount({ counterpartyId: cpId, bank: p.bank, number: p.number, holder: p.holder, usage: p.usage, memo: p.memo }, this.at());
    return { account: a, holderOffer: a.holder && !this.repo.aliasOwners(normalizePayerName(a.holder)).includes(cpId) ? a.holder : null };
  }

  private addAlias(p: Params) {
    const cpId = this.str(p.counterpartyId, 'not_found');
    const norm = normalizePayerName(typeof p.name === 'string' ? p.name : '');
    const others = this.repo.aliasOwners(norm).filter((o) => o !== cpId);
    if (others.length) return fail('alias_conflict');
    const source = p.source === 'holder' || p.source === 'learned' ? p.source : 'manual';
    return this.repo.addAlias(cpId, p.name, source, this.at());
  }

  /** 앱 발급 줄에 품목이 없던 예전 행을 실행 입력 요약으로 채운다(한 번만 하면 된다) */
  private backfillLedgerItems(pid: string): void {
    const rows = this.db.prepare(`SELECT v.id, v.run_id, r.inputs_json_enc FROM receivables v JOIN runs r ON r.id = v.run_id WHERE v.profile_id = ? AND v.item IS NULL AND v.from_ledger = 1`).all(pid) as Array<{ id: string; run_id: string; inputs_json_enc: Uint8Array | null }>;
    for (const r of rows) {
      if (!(r.inputs_json_enc instanceof Uint8Array) || !r.inputs_json_enc.length) continue;
      try {
        const o = JSON.parse(this.cipher.open(r.inputs_json_enc, `runs.inputs_json_enc|${r.run_id}`)) as { item?: unknown };
        if (typeof o.item === 'string' && o.item.trim()) this.db.prepare('UPDATE receivables SET item = ? WHERE id = ? AND item IS NULL').run(o.item.trim().slice(0, 100), r.id);
      } catch {
        // 열 수 없는 행은 품목 없이 둔다
      }
    }
  }

  /**
   * 장부 입력 하나(ADR-068 결정 10). 돈 흐름, 리포트, 폰 사본, 대화 도구가 모두 이것만 읽는다.
   * 맞춤(rematch)과 원장 옮기기를 먼저 해서 어느 화면이 먼저 열려도 같은 숫자다.
   */
  ledgerInput(pid: string): ReportInput {
    this.rematch(pid);
    this.backfillLedgerItems(pid);
    const today = this.today();
    const accts = this.repo.accounts(pid);
    const ownHmacs = new Set(this.db.prepare('SELECT number_hmac FROM bank_accounts WHERE profile_id = ?').pluck().all(pid) as string[]);
    const ranges = new Map<string, Array<{ from: string; to: string }>>();
    for (const r of this.db
      .prepare(`SELECT i.account_id AS a, coalesce(i.range_from, min(t.day)) AS f, coalesce(i.range_to, max(t.day)) AS t FROM bank_imports i LEFT JOIN bank_txns t ON t.import_id = i.id
        WHERE i.profile_id = ? GROUP BY i.id`)
      .all(pid) as Array<{ a: string; f: string | null; t: string | null }>)
      if (r.f && r.t) ranges.set(r.a, [...(ranges.get(r.a) ?? []), { from: r.f, to: r.t }]);
    const accounts: CfAccount[] = accts.map((a) => {
      const rs = ranges.get(a.id) ?? [];
      const bal = this.db.prepare('SELECT balance, day FROM bank_txns WHERE account_id = ? AND balance IS NOT NULL ORDER BY day DESC, occurred_at DESC, rowid DESC LIMIT 1').get(a.id) as { balance: number; day: string } | undefined;
      return { id: a.id, last4: a.last4, bank: a.bank, ranges: rs, coverTo: rs.length ? rs.map((r) => r.to).sort().at(-1)! : null, balance: bal?.balance ?? null, balanceDay: bal?.day ?? null };
    });
    const settled = new Map<string, number>();
    const lastPaid = new Map<string, string>();
    const txnDay = new Map<string, string>();
    const txns: CfTxn[] = this.repo.txns(pid).map((t) => {
      txnDay.set(t.id, t.day);
      return { id: t.id, accountId: t.accountId, day: t.day, direction: t.direction, amount: t.amount, label: [t.payer, t.memo].filter(Boolean).join(' '), payer: t.payer ?? null, counterOwn: !!t.counterAccountHmac && ownHmacs.has(t.counterAccountHmac), settled: 0, human: t.ignoredAt ? t.ignoredReason : null };
    });
    for (const a of this.repo.liveAllocs(pid)) {
      if (a.txnId) settled.set(a.txnId, (settled.get(a.txnId) ?? 0) + a.amount);
      const d = a.txnId ? txnDay.get(a.txnId) : (a.receivedOn ?? a.createdAt.slice(0, 10));
      if (d && (!lastPaid.has(a.receivableId) || d > lastPaid.get(a.receivableId)!)) lastPaid.set(a.receivableId, d);
    }
    for (const t of txns) t.settled = settled.get(t.id) ?? 0;
    const STATE: Record<ReceivableStatus, CfInvoice['state']> = { unpaid: 'open', partial: 'open', unknown: 'unknown', waiting: 'waiting', received: 'settled', excluded: 'excluded' };
    const invoices: CfInvoice[] = (['sale', 'purchase'] as const).flatMap((kind) =>
      this.views(pid, kind).list.map((v) => ({
        id: v.id, kind, counterpartyKey: v.counterpartyId ?? (v.cpBizNo ? `biz:${v.cpBizNo}` : `r:${v.id}`), cpName: v.cpName, writtenOn: v.writtenOn, total: v.total, tax: v.tax, remaining: v.total < 0 ? v.total - v.received + v.credited : v.remaining, credited: v.credited, overdue: v.overdue,
        dueOn: v.promisedOn ?? v.dueOn, state: STATE[v.status], settledOn: v.status === 'received' ? (lastPaid.get(v.id) ?? null) : null,
        item: v.item, fromLedger: v.sources.includes('ledger'),
      })),
    );
    const rows = <T>(sql: string) => this.db.prepare(sql).all(pid) as T[];
    const cashSales = rows<{ day: string; amount: number }>('SELECT day, amount FROM cash_sales WHERE profile_id = ?');
    // 같은 날을 덮은 카드 조회가 여럿이면 가장 늦게 끝난 회차의 줄만 쓴다(겹쳐 받아도 두 번 세지 않는다, ADR-068 결정 10)
    const cardTxns = rows<{ day: string; amount: number; merchantBizNo: string | null; vat: number | null; deductible: number | null }>(
      `SELECT t.used_on AS day, CASE WHEN t.canceled = 1 THEN -abs(t.amount) ELSE t.amount END AS amount, t.merchant_biz_no AS merchantBizNo,
        CASE WHEN t.canceled = 1 THEN -abs(t.vat_amount) ELSE t.vat_amount END AS vat, t.deductible FROM card_txns t JOIN card_fetches f ON f.run_id = t.fetch_run_id
        WHERE t.profile_id = ? AND f.run_id = (SELECT f2.run_id FROM card_fetches f2 WHERE f2.profile_id = t.profile_id AND t.used_on BETWEEN f2.range_from AND f2.range_to ORDER BY f2.completed_at DESC, f2.rowid DESC LIMIT 1)`,
    ).map((c) => ({ ...c, deductible: c.deductible === null ? null : c.deductible === 1 }));
    // 받은 구간은 받은 날 기준으로 다 들어와 있던 데까지만 덮음으로 친다(홈택스 카드 자료는 다음 달 15일쯤 들어온다)
    const settle = <K extends HometaxKind>(kind: K, xs: Array<{ from: string; to: string; at: string }>) =>
      xs.map((x) => ({ from: x.from, to: coveredTo(kind, x.to, x.at) })).filter((x) => x.to >= x.from);
    const cardRanges = settle('business_card', rows<{ from: string; to: string; at: string }>('SELECT range_from AS "from", range_to AS "to", completed_at AS at FROM card_fetches WHERE profile_id = ?'));
    const receipts = rows<{ day: string; amount: number; merchantBizNo: string | null }>(
      'SELECT r.issued_on AS day, r.amount, r.merchant_biz_no AS merchantBizNo FROM receipts r JOIN documents d ON d.id = r.doc_id WHERE d.profile_id = ? AND r.issued_on IS NOT NULL AND r.amount IS NOT NULL AND r.amount > 0',
    );
    const confirmed = `SELECT m.profile_id AS pid, m.month, m.revision FROM payroll_months m WHERE m.profile_id = ? AND m.status = 'confirmed' AND m.revision = (SELECT max(revision) FROM payroll_months x WHERE x.profile_id = m.profile_id AND x.month = m.month AND x.status = 'confirmed')`;
    const payroll = rows<{ month: string; gross: number; net: number }>(`SELECT l.month, sum(l.gross) AS gross, sum(l.net_pay) AS net FROM payroll_lines l JOIN (${confirmed}) c ON c.pid = l.profile_id AND c.month = l.month AND c.revision = l.revision GROUP BY l.month`);
    const payees = (this.db.prepare(`SELECT e.name, l.month, l.net_pay AS net FROM payroll_lines l JOIN (${confirmed}) c ON c.pid = l.profile_id AND c.month = l.month AND c.revision = l.revision JOIN employees e ON e.id = l.employee_id`).all(pid) as Array<{ name: string; month: string; net: number }>)
      .map((x) => ({ nameNorm: normalizePayerName(x.name), month: x.month, net: x.net }));
    const rules = (this.db.prepare('SELECT direction, label_norm AS labelNorm, category FROM txn_category_rules WHERE profile_id = ?').all(pid) as Array<{ direction: 'in' | 'out'; labelNorm: string; category: HumanCategory }>)
      .filter((r) => (HUMAN_CATEGORIES as readonly string[]).includes(r.category));
    const cashReceipts = rows<{ side: 'in' | 'out'; day: string; amount: number; cpBizNo: string | null; tax: number | null; deductible: number | null }>(
      'SELECT side, day, CASE WHEN canceled = 1 THEN -amount ELSE amount END AS amount, cp_biz_no AS cpBizNo, CASE WHEN canceled = 1 THEN -tax ELSE tax END AS tax, deductible FROM cash_receipts WHERE profile_id = ?',
    ).map((c) => ({ ...c, deductible: c.deductible === null ? null : c.deductible === 1 }));
    const cardSales = rows<{ month: string; amount: number; count: number }>('SELECT month, sum(amount) AS amount, sum(count) AS count FROM card_sales WHERE profile_id = ? GROUP BY month');
    const hometax = rows<{ kind: HometaxKind; from: string; to: string; at: string }>(
      'SELECT kind, range_from AS "from", range_to AS "to", finished_at AS at FROM hometax_syncs WHERE profile_id = ? AND code IS NULL',
    ).flatMap((h) => settle(h.kind, [h]).map((r) => ({ kind: h.kind, ...r })));
    const hometaxLastAt = (this.db.prepare('SELECT max(finished_at) FROM hometax_syncs WHERE profile_id = ? AND code IS NULL').pluck().get(pid) as string | null) ?? null;
    const profile = new ProfileRepo(this.db).get(pid);
    const kind = bizNoKind(profile?.bizNo);
    const corporate = !!profile?.corpNo || kind === 'corporate';
    return { today, accounts, txns, invoices, cashSales, cardTxns, cardRanges, receipts, payroll, payees, rules, cashReceipts, cardSales, hometax, hometaxLastAt, corporate, exempt: !corporate && kind === 'exempt' };
  }

  cashflow(pid: string, month: unknown): CashFlowResult {
    const m = month === undefined || month === null ? this.today().slice(0, 7) : typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= this.today().slice(0, 7) ? month : fail('bad_month');
    return analyzeCashFlow({ ...this.ledgerInput(pid), month: m });
  }

  cashflowSeries(pid: string, months: unknown): { months: CashFlowMonth[] } {
    const n = months === undefined || months === null ? 6 : Number.isInteger(months) && (months as number) >= 1 && (months as number) <= 12 ? (months as number) : fail('bad_months');
    const cur = this.today().slice(0, 7);
    const base = { ...this.ledgerInput(pid), month: cur };
    const out: CashFlowMonth[] = [];
    for (let i = n - 1; i >= 0; i--) out.push(analyzeCashFlow({ ...base, month: shiftMonth(cur, -i) }).month);
    return { months: out };
  }

  /** 고른 달이 든 달력 기간(월, 분기, 반기, 해). rolling이면 고른 달에서 끝나는 n개월(폰 사본의 12달) */
  private reportWindow(month: unknown, months: unknown, rolling = false): { m: string; n: ReportWindow } {
    const today = this.today();
    const m = month === undefined || month === null ? today.slice(0, 7) : reportMonthOk(month, today) ? month : fail('bad_month');
    const n = months === undefined || months === null ? 1 : (REPORT_WINDOWS as readonly unknown[]).includes(months) ? (months as ReportWindow) : fail('bad_months');
    return { m: rolling ? m : periodEnd(m, n), n };
  }

  /** 월 리포트(ADR-068). 고른 달이 든 월, 분기, 반기, 해 */
  report(pid: string, month: unknown, months: unknown, rolling = false): ReportResult {
    const { m, n } = this.reportWindow(month, months, rolling);
    return analyzeReport(this.ledgerInput(pid), m, n);
  }

  /** 최근 2년 매출 세금계산서의 건수와 가장 큰 합계. 발급 카드가 평소보다 훨씬 큰 금액을 알아보는 기준이다(대형 사업자 시험 11-28, 350억 오타). */
  private saleScale(pid: string): { count: number; max: number } {
    const r = this.db
      .prepare(`SELECT count(*) AS count, coalesce(max(total), 0) AS max FROM receivables WHERE profile_id = ? AND kind = 'sale' AND excluded_at IS NULL AND total > 0 AND written_on >= ?`)
      .get(pid, addDays(this.today(), -730)) as { count: number; max: number };
    return { count: Number(r.count), max: Number(r.max) };
  }

  /**
   * 그달 세금계산서 칸(ADR-072 결정 1). 숫자는 리포트(analyzeReport)의 그 칸이고, 줄은 그 칸을 이루는 장부 줄(앱 발급과 홈택스 목록, 지운 것 빼고)이다.
   * 칸이 null이면 그달 홈택스 목록을 아직 못 받았다. 대화의 매출, 매입이 읽는다.
   */
  private monthInvoices(pid: string, kind: unknown, month: unknown): { line: Line; side: ReportSales | ReportPurchase; lastAt: string | null; rows: Array<{ counterpartyId: string | null; counterparty: string | null; writtenOn: string; total: number; tax: number | null; item: string | null }> } {
    const k = kind === 'sale' || kind === 'purchase' ? kind : fail('bad_kind');
    const { m } = this.reportWindow(month, 1);
    const input = this.ledgerInput(pid);
    const r = analyzeReport(input, m, 1);
    const rows = input.invoices
      .filter((v) => v.kind === k && v.writtenOn.startsWith(`${m}-`))
      .map((v) => ({ counterpartyId: v.counterpartyKey.includes(':') ? null : v.counterpartyKey, counterparty: v.cpName, writtenOn: v.writtenOn, total: v.total, tax: v.tax ?? null, item: v.item ?? null }));
    return { ...(k === 'sale' ? { line: r.sales.invoices, side: r.sales } : { line: r.purchase.invoices, side: r.purchase }), lastAt: input.hometaxLastAt, rows };
  }

  /** 다음에 낼 부가세 신고의 기한과 세금계산서 세액(대화 vat_summary). 법인이면 석 달마다다 */
  private vat(pid: string): VatDue {
    return vatDue(this.ledgerInput(pid));
  }

  /**
   * 세무사 꾸러미에 넣을 그달 줄(홈택스 내려받기와 같은 칸). 세금계산서는 리포트 장부(ledgerInput)의 그달 줄이고, 카드는 리포트처럼 가장 늦게 받은 회차의 줄이다.
   * known: 그달 그 자료를 다 받았는가(리포트 칸이 null이 아님). 통장은 계좌마다 그달 거래와 다 받은 날(coverTo).
   */
  private packRows(pid: string, month: unknown) {
    const { m } = this.reportWindow(month, 1);
    const input = this.ledgerInput(pid);
    const a = analyzeCashFlow({ ...input, month: m }).month.accrual;
    const from = `${m}-01`;
    const to = `${m}-31`;
    const all = <T>(sql: string, ...args: unknown[]) => this.db.prepare(sql).all(pid, ...args) as T[];
    const ids = new Set(input.invoices.filter((v) => v.state !== 'excluded' && v.writtenOn.startsWith(`${m}-`)).map((v) => v.id));
    const invoices = all<{ id: string; kind: Kind; approvalNo: string | null; writtenOn: string; cpBizNo: string | null; cpName: string | null; item: string | null; supply: number | null; tax: number | null; total: number }>(
      'SELECT id, kind, approval_no AS approvalNo, written_on AS writtenOn, cp_biz_no AS cpBizNo, cp_name AS cpName, item, supply, tax, total FROM receivables WHERE profile_id = ? AND written_on BETWEEN ? AND ? ORDER BY written_on, rowid', from, to,
    ).filter((v) => ids.has(v.id)).map(({ id: _, ...v }) => v);
    const card = all<{ usedOn: string; cardLast4: string | null; merchantBizNo: string | null; merchant: string | null; supply: number | null; vat: number | null; amount: number; canceled: number }>(
      `SELECT t.used_on AS usedOn, t.card_last4 AS cardLast4, t.merchant_biz_no AS merchantBizNo, t.merchant, t.supply_amount AS supply, t.vat_amount AS vat, t.amount, t.canceled FROM card_txns t
        WHERE t.profile_id = ? AND t.used_on BETWEEN ? AND ? AND t.fetch_run_id = (SELECT f2.run_id FROM card_fetches f2 WHERE f2.profile_id = t.profile_id AND t.used_on BETWEEN f2.range_from AND f2.range_to ORDER BY f2.completed_at DESC, f2.rowid DESC LIMIT 1)
        ORDER BY t.used_on, t.seq`, from, to,
    ).map((c) => ({ ...c, canceled: c.canceled === 1 }));
    const receipts = all<{ side: 'in' | 'out'; day: string; approvalNo: string; supply: number | null; tax: number | null; amount: number; cpBizNo: string | null; cpName: string | null; canceled: number }>(
      'SELECT side, day, approval_no AS approvalNo, supply, tax, amount, cp_biz_no AS cpBizNo, cp_name AS cpName, canceled FROM cash_receipts WHERE profile_id = ? AND day BETWEEN ? AND ? ORDER BY day, rowid', from, to,
    ).map((c) => ({ ...c, canceled: c.canceled === 1 }));
    const cardSales = all<{ issuer: string; count: number; amount: number }>('SELECT issuer, count, amount FROM card_sales WHERE profile_id = ? AND month = ? ORDER BY issuer', m);
    const bank = this.repo.accounts(pid).map((acct) => ({
      bank: acct.bank, last4: acct.last4, coverTo: input.accounts.find((x) => x.id === acct.id)?.coverTo ?? null,
      txns: this.db.prepare('SELECT occurred_at AS at, direction, amount, balance, payer, memo FROM bank_txns WHERE account_id = ? AND day BETWEEN ? AND ? ORDER BY occurred_at, rowid').all(acct.id, from, to) as Array<{ at: string; direction: 'in' | 'out'; amount: number; balance: number | null; payer: string | null; memo: string | null }>,
    }));
    return {
      month: m,
      sales: { known: a.invoicesKnown.sale, rows: invoices.filter((v) => v.kind === 'sale') },
      purchases: { known: a.invoicesKnown.purchase, rows: invoices.filter((v) => v.kind === 'purchase') },
      card: { known: a.card !== null, rows: card },
      cashReceiptsOut: { known: a.cashReceiptsOut !== null, rows: receipts.filter((c) => c.side === 'out') },
      cashReceiptsIn: { known: a.cashReceiptsIn !== null, rows: receipts.filter((c) => c.side === 'in') },
      cardSales: { known: a.cardSales !== null, rows: cardSales },
      bank,
    };
  }

  /** 거래처와 품목 전체 목록(리포트 [전체 보기]) */
  private reportAll(pid: string, month: unknown, months: unknown): Pick<ReportResult, 'partners' | 'items'> {
    const { m, n } = this.reportWindow(month, months);
    const r = analyzeReport(this.ledgerInput(pid), m, n, Number.POSITIVE_INFINITY);
    return { partners: r.partners, items: r.items };
  }

  /** 통장 갈래 하나의 줄들. 계좌는 은행과 끝 4자리로 */
  private reportLines(pid: string, p: Params): { rows: Array<ReportLineRow & { account: string; human: string | null }> } {
    const { m, n } = this.reportWindow(p.month, p.months);
    const side = p.side === 'in' || p.side === 'out' ? p.side : fail('bad_side');
    const category = typeof p.category === 'string' && /^[a-z_]{1,20}$/.test(p.category) ? p.category : fail('bad_category');
    const input = this.ledgerInput(pid);
    const acct = new Map(input.accounts.map((a) => [a.id, `${a.bank} ${a.last4}`]));
    const human = new Map(input.txns.map((t) => [t.id, t.human]));
    return { rows: reportLines(input, m, n, side, category).map((r) => ({ ...r, account: acct.get(r.accountId) ?? '', human: human.get(r.id) ?? null })) };
  }

  private categorize(p: Params) {
    const pid = this.profile(p.profileId);
    const t = this.ownTxn(pid, p.txnId);
    const cat = p.category === null ? null : (HUMAN_CATEGORIES as readonly unknown[]).includes(p.category) ? (p.category as HumanCategory) : fail('bad_category');
    if (cat && this.repo.liveAllocs(pid, { txnId: t.id }).length) return fail('txn_settled');
    const reason = cat === 'unrelated' ? 'unrelated' : cat;
    this.repo.setIgnored(t.id, reason, this.at());
    let rule: { labelNorm: string } | null = null;
    if (cat && p.remember === true) {
      const labelNorm = normalizePayerName([t.payer, t.memo].filter(Boolean).join(' '));
      if (labelNorm.length >= 2) {
        this.db.prepare('INSERT INTO txn_category_rules (profile_id, direction, label_norm, category, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(profile_id, direction, label_norm) DO UPDATE SET category = excluded.category')
          .run(pid, t.direction, labelNorm, cat, this.at());
        rule = { labelNorm };
      }
    }
    const seq = this.event(pid, { receivableId: null, txnId: t.id, allocId: null, action: reason ? 'ignore' : 'unignore', reason: t.ignoredReason, undoOf: null });
    return { seq, remembered: !!rule };
  }

  dispose(): void {
    for (const j of this.jobs.values()) j.abort.abort();
    this.repo.dispose();
  }
}
