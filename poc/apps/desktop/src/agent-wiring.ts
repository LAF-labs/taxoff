import type { DraftResultCard, ReactionId, RouteStep, ScreenFrame, StepParams, StepResult } from '@sax/engine';
import { kstToday } from './approval-gate.ts';
import type { AgentChatPorts, AgentPhase, CashFlowValues, DraftCard, DraftExtraValues, DraftPatch, IssuedAmend, IssuedRow, OpenScreen, ReceivableRow } from './agent-chat.ts';
import type { AmendSaid, AmendSource } from '@sax/chat-core';
import { certDocOf, certInputsFor, type CertCode } from './cert-docs.ts';
import { isInvoicePlaybook } from './run-history.ts';
import type { Vat } from '@sax/chat-core';
import type { Counterparty, RunView } from './shell-model.ts';
import { invoiceDraftError } from './shell-runs.ts';

interface HistoryRow {
  playbookId: string;
  approvalNo: string | null;
  documentId?: string | null;
  mailConfirmed?: boolean | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  supply: number | null;
  tax: number | null;
  issueDate?: string | null;
  item?: string | null;
  amend?: IssuedAmend | null;
  amendOf?: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export const AGENT_HISTORY_LIMIT = 200;

export interface AgentRuns {
  list(): RunView[];
  readonly counterparties: Counterparty[];
  createDraft(cp: Counterparty, amount: number, vat: Vat | null, item?: string | null, extra?: DraftExtraValues): RunView;
  updateDraft(id: string, patch: DraftPatch): RunView;
  discardDraft(id: string): RunView;
  createAmend?(originals: readonly AmendSource[], said: AmendSaid): RunView;
  createCertDraft?(code: CertCode, inputs: Record<string, string>): RunView;
}

interface AgentWiring {
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  profileId(): string | null;
  runs: AgentRuns;
  setupMissing(): boolean;
  onCreated(run: RunView): void;
  onProgress(phase: AgentPhase): void;
  route?: boolean;
  onReaction?(reaction: ReactionId): void;
  openScreen?(screen: OpenScreen): void;
  receivables?: () => Promise<ReceivableRow[] | null>;
  payables?: () => Promise<ReceivableRow[] | null>;
  cashFlow?: (month: string) => Promise<CashFlowValues | null>;
  pastIssued?: () => IssuedRow[];
  /** 수정 발급 패키지를 받아 두었는지(레지스트리 동기화 결과). 없으면 대화 도구가 카드 대신 준비 중이라고 답한다. */
  amendReady?: () => boolean;
  now?: () => number;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function issuedRows(rows: unknown): IssuedRow[] {
  if (!Array.isArray(rows)) return [];
  return (rows as HistoryRow[])
    .filter((r) => r && isInvoicePlaybook(r.playbookId) && typeof r.approvalNo === 'string' && r.approvalNo)
    .map((r) => {
      const at = Date.parse(r.finishedAt ?? r.startedAt);
      return {
        counterpartyId: typeof r.counterpartyId === 'string' ? r.counterpartyId : null,
        counterparty: typeof r.counterpartyName === 'string' ? r.counterpartyName : '이름 모름',
        date: Number.isFinite(at) ? kstToday(at) : '',
        total: isNum(r.supply) && isNum(r.tax) ? r.supply + r.tax : null,
        approvalNo: r.approvalNo,
        documentId: typeof r.documentId === 'string' ? r.documentId : null,
        mail: r.mailConfirmed === true ? ('sent' as const) : r.mailConfirmed === false ? ('unconfirmed' as const) : null,
        issueDate: typeof r.issueDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.issueDate) ? r.issueDate : null,
        supply: isNum(r.supply) ? r.supply : null,
        tax: isNum(r.tax) ? r.tax : null,
        item: typeof r.item === 'string' ? r.item : null,
        amend: r.amend && typeof r.amend === 'object' ? r.amend : null,
        ...(typeof r.amendOf === 'string' && r.amendOf ? { amendOf: r.amendOf } : {}),
      };
    })
    .filter((r) => r.date);
}

export function draftCard(r: RunView): DraftCard {
  return { runId: r.id, counterpartyId: r.counterparty.id, amount: r.amount, vat: r.vatGuessed ? null : r.vat, item: r.item.trim() ? r.item : null, status: r.status };
}

export function agentPorts(w: AgentWiring): AgentChatPorts {
  const summary = (run: RunView): DraftResultCard => ({
    counterpartyId: run.counterparty.id, amount: run.amount, vat: run.vat, vatGuessed: run.vatGuessed,
    writeDate: run.writeDate, quantity: run.quantity ?? null, unitPrice: run.unitPrice ?? null,
    canPrepare: run.status === 'draft' && !w.setupMissing() && !invoiceDraftError(run),
  });
  return {
    step: (p: StepParams) => w.rpc('chat.step', p as unknown as Record<string, unknown>) as Promise<StepResult>,
    ...(w.route === false ? {} : { route: (p: { text: string; frame: ScreenFrame; profileId: string }) => w.rpc('chat.route', p as unknown as Record<string, unknown>) as Promise<RouteStep> }),
    ...(w.onReaction ? { onReaction: w.onReaction } : {}),
    profileId: () => w.profileId(),
    drafts: {
      list: () => w.runs.list().filter((r) => r.status === 'draft' && !r.cert && !r.amend).map(draftCard),
      setupMissing: () => w.setupMissing(),
      create: (counterpartyId, amount, vat, item, extra) => {
        if (w.setupMissing()) return { setup: true };
        const cp = w.runs.counterparties.find((c) => c.id === counterpartyId);
        if (!cp) throw new Error('no_counterparty');
        const run = extra ? w.runs.createDraft(cp, amount, vat, item, extra) : w.runs.createDraft(cp, amount, vat, item);
        w.onCreated(run);
        return { runId: run.id, card: summary(run) };
      },
      update: (runId, patch) => summary(w.runs.updateDraft(runId, patch)),
      discard: (runId) => void w.runs.discardDraft(runId),
      ...(w.runs.createAmend ? {
        amend: (originals, said) => {
          if (w.setupMissing()) return { setup: true as const };
          return { runId: w.runs.createAmend!(originals, said).id };
        },
        ...(w.amendReady ? { amendReady: w.amendReady } : {}),
      } : {}),
      ...(w.runs.createCertDraft ? {
        cert: (doc: string, purpose: string | null) => {
          const def = certDocOf(doc);
          if (!def) return { none: true as const };
          if (w.setupMissing()) return { setup: true as const };
          const run = w.runs.createCertDraft!(def.code, certInputsFor(def, purpose ?? '', kstToday(w.now?.() ?? Date.now())));
          w.onCreated(run);
          return { runId: run.id };
        },
      } : {}),
    },
    issued: async () => [...issuedRows(await w.rpc('db.query.runs.history', { limit: AGENT_HISTORY_LIMIT })), ...(w.pastIssued?.() ?? [])],
    receivables: w.receivables ?? (async () => null),
    payables: w.payables ?? (async () => null),
    cashFlow: w.cashFlow ?? (async () => null),
    counterparties: () => w.runs.counterparties.map((c) => ({ id: c.id, name: c.name, item: c.item.trim() ? c.item : null, bizNo: c.bizNo })),
    today: () => kstToday(w.now?.() ?? Date.now()),
    onProgress: (phase) => w.onProgress(phase),
    ...(w.openScreen ? { openScreen: w.openScreen } : {}),
    ...(w.now ? { now: w.now } : {}),
  };
}
