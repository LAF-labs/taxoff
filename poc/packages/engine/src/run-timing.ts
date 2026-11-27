import type { LogFields } from '@sax/platform';

/** 실행 시작부터 잰 시각(ms)을 남기는 저널 이벤트. 처음 한 번만 적는다. */
const MARKS: Readonly<Record<string, string>> = {
  'gate.requested': 'at_gate_ms',
  'gate.approved': 'at_approved_ms',
  'ledger.dispatched': 'at_dispatched_ms',
  'signflow.done_seen': 'at_sign_done_ms',
  'ledger.committed': 'at_committed_ms',
};

/**
 * 실행 하나의 시간 분해(engine.log `run.timing`). 단계별 시간, 정책 지연으로 쉰 시간, 사람을 기다린 시간,
 * 승인·제출·확정 시각을 값 없이 숫자로만 남긴다.
 */
export class RunTiming {
  private readonly clock: () => number;
  private readonly t0: number;
  private readonly phaseMs = new Map<string, number>();
  private readonly marks = new Map<string, number>();
  private open: { phase: string; at: number } | null = null;
  private humanSince: number | null = null;
  private humanMs = 0;
  private paceMs = 0;
  private paceN = 0;
  private readonly stepMs = new Map<string, number>();
  private stepOpen: { id: string; at: number } | null = null;

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
    this.t0 = clock();
  }

  phase(phase: string, state: 'now' | 'done' | 'attention'): void {
    const now = this.clock();
    this.human(false);
    if (this.open && (this.open.phase !== phase || state !== 'now')) this.close(now);
    if (state === 'now' && !this.open) this.open = { phase, at: now };
  }

  /** 사람 차례(승인 카드·비밀번호·넘김)가 열리거나 닫혔다. */
  human(waiting: boolean): void {
    const now = this.clock();
    if (waiting) this.humanSince ??= now;
    else if (this.humanSince !== null) {
      this.humanMs += now - this.humanSince;
      this.humanSince = null;
    }
  }

  /** 스텝 하나가 시작하고 끝났다(정책 지연은 시작 전에 끝나 있어 포함되지 않는다). 오래 걸린 스텝을 찾는 데 쓴다. */
  step(name: string, stepId: string): void {
    const now = this.clock();
    if (name === 'step.started') this.stepOpen = { id: stepId, at: now };
    else if (name === 'step.finished' && this.stepOpen?.id === stepId) {
      this.stepMs.set(stepId, (this.stepMs.get(stepId) ?? 0) + now - this.stepOpen.at);
      this.stepOpen = null;
    }
  }

  paced(ms: number): void {
    if (ms <= 0) return;
    this.paceMs += ms;
    this.paceN++;
  }

  journal(type: string): void {
    const k = MARKS[type];
    if (!k) return;
    if (type === 'gate.approved') this.human(false);
    this.mark(k);
  }

  baselineFinished(): void {
    this.mark('at_baseline_ms');
  }

  fields(runId: string, end: { status: string; code?: string; playbook: string }): LogFields {
    const now = this.clock();
    this.close(now);
    this.human(false);
    const f: LogFields = { runId, playbook: end.playbook, status: end.status, end: (end.code ?? '').slice(0, 80), total_ms: now - this.t0, human_ms: this.humanMs, pace_ms: this.paceMs, pace_n: this.paceN };
    for (const [p, ms] of this.phaseMs) f[`${p}_ms`] = ms;
    for (const [k, ms] of this.marks) f[k] = ms;
    const slow = [...this.stepMs].filter(([id]) => /^[A-Za-z0-9]{1,8}$/.test(id)).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, ms]) => `${id}:${ms}`).join('_');
    if (slow) f.slow = slow.slice(0, 80);
    return f;
  }

  private close(now: number): void {
    if (!this.open) return;
    this.phaseMs.set(this.open.phase, (this.phaseMs.get(this.open.phase) ?? 0) + now - this.open.at);
    this.open = null;
  }

  private mark(k: string): void {
    if (!this.marks.has(k)) this.marks.set(k, this.clock() - this.t0);
  }
}
