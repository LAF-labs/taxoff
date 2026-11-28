/**
 * 월 리포트 홈택스 자동 받기 예약(ADR-068 결정 6, ADR-069). 사람이 앱을 열면(금고 화면 잠금 풀기) 받을 때가 됐는지 장부에 묻고,
 * 됐으면 금고에 unlock 실행을 열고(풀기 뒤 120초 안, 풀기 한 번에 한 번) 엔진에 읽기 전용 받기 실행을 시킨다.
 * [최신화]는 사람이 누른 것이라 금고 실행을 local로 연다. 받은 줄은 엔진이 장부에 넣고 장부 알림으로 화면이 다시 읽는다.
 * 받기는 화면에 카드가 없는 뒤쪽 일이라 사람을 기다리지 않는다. 핸드오프(간편인증 등)가 오면 바로 멈추고, 사람이 서류나 발급을 시작하면 비켜 준다(stop).
 */

export const REPORT_PLAYBOOK = 'hometax.report.sync';
/** 받기 한 번의 상한. 처음 받기(12개월, 52구간)도 이 안에 끝난다. 넘으면 멈추고 다음 풀기에 남은 구간부터 받는다. */
export const REPORT_RUN_CAP_MS = 15 * 60_000;

export type ReportSyncWhy = 'unlock' | 'human';
export type ReportSyncResult = 'done' | 'failed' | 'not_due' | 'busy' | 'cant_login' | 'simple_auth' | 'stopped' | 'yielded';

export interface ReportSyncPorts {
  /** 엔진이 준비될 때까지 기다린다. */
  ready(): Promise<unknown>;
  /** 엔진 rpc. */
  rpc(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** 금고 control. */
  control(method: string, params: Record<string, unknown>): Promise<unknown>;
  /** 엔진 실행 알림을 듣는다. 돌려준 함수로 끊는다. */
  onRun(cb: (e: { type?: string; runId?: string; status?: string; code?: string }) => void): () => void;
  profileId(): Promise<string | null>;
  /** 사람 없이 홈택스에 로그인할 수 있나. ready = 공동인증서 비밀번호를 기억함, simple_auth = 간편인증 사업자(폰 승인이 있어야 해서 받지 않는다) */
  login(): Promise<'ready' | 'simple_auth' | 'not_ready'>;
  /** 발급, 미리 로그인 같은 다른 실행이 돌고 있나. */
  busy(): boolean;
  log(name: string, data?: Record<string, string | number | boolean>): void;
  now?(): number;
}

export class ReportSync {
  readonly #o: ReportSyncPorts;
  #running: Promise<ReportSyncResult> | null = null;
  #runId: string | null = null;
  #yield = false;
  #unlocks = 0;

  constructor(o: ReportSyncPorts) {
    this.#o = o;
  }

  get running(): boolean {
    return !!this.#running;
  }

  /** 사람이 홈택스 일을 시작한다. 돌고 있는 받기를 멈추고 끝날 때까지 기다린다. 남은 구간은 다음 받기가 이어 받는다. */
  async stop(): Promise<void> {
    const p = this.#running;
    if (!p) return;
    this.#yield = true;
    const runId = this.#runId;
    if (runId) await this.#o.rpc('run.stop', { runId }).catch(() => {});
    await p;
  }

  /** 화면 잠금이 풀렸다. 앱을 켠 뒤 처음 풀기면 언제나 받고, 그다음부터는 마지막 받기에서 6시간이 지났을 때만 받는다. */
  screenOpened(): Promise<ReportSyncResult> {
    return this.start('unlock', ++this.#unlocks === 1);
  }

  /** first: 앱을 켠 뒤 처음 풀기. [최신화](human)는 언제나 받는다. */
  start(why: ReportSyncWhy, first = false): Promise<ReportSyncResult> {
    if (this.#running) return Promise.resolve('busy');
    this.#yield = false;
    const p = this.#run(why, why === 'human' || first).finally(() => {
      if (this.#running === p) {
        this.#running = null;
        this.#runId = null;
      }
    });
    this.#running = p;
    return p;
  }

  async #run(why: ReportSyncWhy, always: boolean): Promise<ReportSyncResult> {
    const o = this.#o;
    const t0 = (o.now ?? Date.now)();
    const out = (result: ReportSyncResult, extra: Record<string, string | number> = {}) => {
      o.log('main.report_sync', { why, result, ms: (o.now ?? Date.now)() - t0, ...extra });
      return result;
    };
    let plan: { due?: boolean; steps?: unknown[] };
    try {
      await o.ready();
      if (o.busy()) return out('busy');
      const login = await o.login();
      if (login !== 'ready') return out(login === 'simple_auth' ? 'simple_auth' : 'cant_login');
      const profileId = await o.profileId();
      if (!profileId) return out('cant_login');
      plan = (await o.rpc('db.query.bank.hometaxPlan', { profileId, firstUnlock: always })) as typeof plan;
    } catch (e) {
      return out('failed', { code: String((e as Error)?.message ?? 'error').slice(0, 60) });
    }
    if (!plan?.due || !Array.isArray(plan.steps) || plan.steps.length === 0) return out('not_due');
    if (o.busy()) return out('busy');
    if (this.#yield) return out('yielded');
    const runId = `report-${(o.now ?? Date.now)().toString(36)}`;
    let off = () => {};
    let handedOff = '';
    try {
      // unlock 실행은 금고가 풀기 뒤 120초 안, 풀기 한 번에 한 번만 연다(unlock_expired면 이번 풀기로는 받지 않는다)
      await o.control('run.begin', why === 'unlock' ? { runId, trigger: 'unlock', playbook: REPORT_PLAYBOOK } : { runId, trigger: 'local' });
      const ended = new Promise<{ status?: string; code?: string }>((resolve) => {
        const cap = setTimeout(() => {
          void o.rpc('run.stop', { runId }).catch(() => {});
          resolve({ status: 'stopped', code: 'report.timeout' });
        }, REPORT_RUN_CAP_MS);
        cap.unref?.();
        off = o.onRun((e) => {
          if (e.runId !== runId) return;
          if (e.type === 'handoff' && !handedOff) {
            // 사람 손이 필요한 곳(간편인증 등)이다. 카드가 없어 아무도 답하지 못하니, 실행 자리를 잡고 기다리지 않고 멈춘다.
            handedOff = e.code || 'handoff';
            void o.rpc('run.stop', { runId }).catch(() => {});
            return;
          }
          if (e.type !== 'end') return;
          clearTimeout(cap);
          resolve(e);
        });
      });
      this.#runId = runId;
      await o.rpc('run.startReport', { runId, plan: plan.steps, trigger: why });
      if (this.#yield) void o.rpc('run.stop', { runId }).catch(() => {});
      const e = await ended;
      if (handedOff) return out('cant_login', { steps: plan.steps.length, code: handedOff.slice(0, 60) });
      return out(this.#yield ? 'yielded' : e.status === 'success' || e.status === 'completed_with_issues' ? 'done' : e.status === 'stopped' ? 'stopped' : 'failed', { steps: plan.steps.length, ...(e.code ? { code: e.code.slice(0, 60) } : {}) });
    } catch (e) {
      return out('failed', { code: String((e as Error)?.message ?? 'error').slice(0, 60) });
    } finally {
      off();
      await o.control('run.end', { runId }).catch(() => {});
    }
  }
}
