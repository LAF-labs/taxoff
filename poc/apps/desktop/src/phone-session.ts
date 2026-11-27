import { CAP, fitPhoneCopy, type Channel, type CmdRunBody, type Envelope, type GateRefreshBody, type GateResponseBody, type PhoneCopyBody, type PxAckBody, type PxEnrollBody, type UnlockGrantBody, type UxEnrollBody } from '@sax/remote';
import type { PhoneSessionHook } from './phone-link.ts';
import type { GateSink, PhoneGate } from './phone-gate.ts';
import type { CmdResumeBody, PhoneIssue, PhoneSink } from './phone-issue.ts';

export const SESSION_CAPS: readonly string[] = Object.freeze([CAP.issue, CAP.copy, CAP.sync, CAP.issued, CAP.book, CAP.unlock, CAP.amend]);
export const APPROVE_CAPS: readonly string[] = Object.freeze([CAP.approve]);

interface PhoneSessionOptions {
  issue: PhoneIssue;
  copy: (pairId: string, want: { issued: boolean; amend?: boolean; report: boolean }) => Promise<PhoneCopyBody>;
  approve?: {
    gate: PhoneGate;
    enroll: (pairId: string, body: PxEnrollBody) => Promise<PxAckBody>;
  };
  /** PC 잠금 풀기(ADR-061 결정 3, 5, 6). 폰이 unlock.v1을 알릴 때만 붙인다. */
  lock?: PhoneLockHook;
  log?: (name: string, data?: Record<string, string | number | boolean>) => void;
}

export interface PhoneLockHook {
  attach(pairId: string, send: (type: 'unlock.request', body: object) => void): void;
  detach(pairId: string): void;
  enroll(pairId: string, body: UxEnrollBody): Promise<object>;
  grant(pairId: string, body: UnlockGrantBody): Promise<void>;
  /** 잠긴 PC에 맡긴 일: 그 폰에 원격 풀기를 묻고 답을 기다린다. */
  remote(pairId: string): Promise<boolean>;
}

type Sink = PhoneSink & GateSink;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function sinkFor(ch: Channel, peerCaps: ReadonlySet<string>): Sink {
  if (peerCaps.has(CAP.sync)) return ch as unknown as Sink;
  return {
    send(type: string, body: object): unknown {
      if (type === 'gate.resolved') return undefined;
      if (type === 'run.event' && 'rev' in body) {
        const rest = { ...(body as { rev?: number }) };
        delete rest.rev;
        return ch.send(type, rest as never);
      }
      return ch.send(type as never, body as never);
    },
  } as Sink;
}

export function phoneSession(o: PhoneSessionOptions): PhoneSessionHook {
  const caps = new WeakMap<Channel, ReadonlySet<string>>();
  const sinks = new WeakMap<Channel, Sink>();
  const log = o.log ?? (() => {});
  const live = new Map<string, Channel>();
  const approves = (ch: Channel) => !!o.approve && !!caps.get(ch)?.has(CAP.approve);
  const unlocks = (ch: Channel) => !!o.lock && !!caps.get(ch)?.has(CAP.unlock);
  const running = new WeakMap<Channel, Promise<void>>();
  const sendCopy = async (pairId: string, ch: Channel, have: ReadonlySet<string>): Promise<void> => {
    const body = await o.copy(pairId, { issued: have.has(CAP.issued), amend: have.has(CAP.amend), report: have.has(CAP.report) });
    const fit = fitPhoneCopy(body, { pairId, from: 'desktop', seq: 0xffffffff });
    if (!fit) {
      log('main.phone_copy', { result: 'too_large' });
      return;
    }
    if (ch.closed) return;
    ch.send('phone.copy', fit.body);
    log('main.phone_copy', { result: 'sent', counterparties: fit.body.counterparties.length, dropped: fit.dropped, money: !!fit.body.money, issued: fit.body.issued?.length ?? -1, report: !!fit.body.report });
  };
  /** 폰이 맡긴 일 하나: 잠겼으면 원격 풀기 답을 기다린 뒤 맡기고, 거래처를 넣거나 고쳤으면 바뀐 사본을 같은 연결로 바로 보낸다(ADR-066). */
  const runCmd = async (pairId: string, ch: Channel, body: CmdRunBody): Promise<void> => {
    if (unlocks(ch)) await o.lock!.remote(pairId);
    const ack = await o.issue.handle(pairId, sinks.get(ch) ?? ch, body);
    const added = ack.state === 'saved' || (ack.state !== 'rejected' && isObj(body.inputs) && isObj(body.inputs.counterpart) && 'bizNo' in body.inputs.counterpart);
    const have = caps.get(ch);
    if (added && have?.has(CAP.copy) && !ch.closed) await sendCopy(pairId, ch, have);
  };
  return {
    async open(pairId, ch, peerCaps) {
      const have = new Set(peerCaps);
      caps.set(ch, have);
      live.set(pairId, ch);
      const sink = sinkFor(ch, have);
      sinks.set(ch, sink);
      if (approves(ch)) o.approve!.gate.attach(pairId, sink);
      if (unlocks(ch)) o.lock!.attach(pairId, (type, body) => {
          if (!ch.closed) ch.send(type, body as never);
        });
      if (have.has(CAP.issue)) o.issue.attach(pairId, sink);
      if (!have.has(CAP.copy)) return;
      await sendCopy(pairId, ch, have);
    },
    async handle(pairId, ch, env: Envelope) {
      if (env.type === 'px.enroll' || env.type === 'gate.response' || env.type === 'gate.refresh') {
        if (!approves(ch)) return true;
        const a = o.approve!;
        if (env.type === 'px.enroll') {
          const ack = await a.enroll(pairId, env.body as PxEnrollBody);
          if (!ch.closed) ch.send('px.ack', ack);
        } else if (env.type === 'gate.response') await a.gate.answer(pairId, env.body as GateResponseBody);
        else a.gate.refresh(pairId, env.body as GateRefreshBody);
        return true;
      }
      if (env.type === 'ux.enroll' || env.type === 'unlock.grant') {
        if (!unlocks(ch)) return true;
        if (env.type === 'ux.enroll') {
          const ack = await o.lock!.enroll(pairId, env.body as UxEnrollBody);
          if (!ch.closed) ch.send('ux.ack', ack as never);
        } else await o.lock!.grant(pairId, env.body as UnlockGrantBody);
        return true;
      }
      if (env.type === 'cmd.resume') {
        if (caps.get(ch)?.has(CAP.issue)) await o.issue.resume(pairId, ch, env.body as CmdResumeBody);
        return true;
      }
      if (env.type === 'human.response') {
        if (caps.get(ch)?.has(CAP.issue)) await o.issue.human(pairId, ch, env.body as { runId?: unknown; reqId?: unknown; value?: unknown });
        return true;
      }
      if (env.type !== 'cmd.run') return false;
      if (!caps.get(ch)?.has(CAP.issue)) return true;
      const body = env.body as CmdRunBody;
      if (!unlocks(ch)) {
        await runCmd(pairId, ch, body);
        return true;
      }
      // 잠긴 PC면 맡긴 일 앞에 그 폰에 원격 풀기를 묻고 답(unlock.grant)을 기다린다. 그 답은 이 받기 루프로 들어오므로
      // 루프가 맡긴 일을 기다리면 답을 읽지 못해 풀기가 시간을 넘긴다. 풀기를 쓰는 연결에서는 맡긴 일을 루프 밖에서
      // 연결마다 받은 차례대로 돌린다. 실패는 루프에서 났을 때처럼 남기고 연결을 닫는다.
      const next = (running.get(ch) ?? Promise.resolve())
        .then(() => runCmd(pairId, ch, body))
        .catch((e: unknown) => {
          log('main.phone_live', { step: 'cmd', result: e instanceof Error ? e.name : 'error' });
          ch.close();
        });
      running.set(ch, next);
      return true;
    },
    close(pairId, ch) {
      const sink = sinks.get(ch);
      if (sink) {
        o.issue.detach(pairId, sink);
        o.approve?.gate.detach(pairId, sink);
      }
      if (unlocks(ch)) o.lock!.detach(pairId);
      caps.delete(ch);
      sinks.delete(ch);
      if (live.get(pairId) === ch) live.delete(pairId);
    },
    async refreshCopy() {
      for (const [pairId, ch] of [...live]) {
        const have = caps.get(ch);
        if (ch.closed || !have?.has(CAP.copy)) continue;
        await sendCopy(pairId, ch, have).catch(() => log('main.phone_copy', { result: 'refresh_failed' }));
      }
    },
  };
}
