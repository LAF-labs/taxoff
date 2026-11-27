import type { ReportSink, ReportSinkItem } from '../core/report-steps.ts';

/** 받기를 누가 시작했나(hometax_syncs.trigger). unlock = 사람이 앱을 연 뒤 자동, run = 발급 실행이 끝난 뒤, human = [최신화]. */
export type SyncTrigger = 'unlock' | 'run' | 'human';

export interface ReportSinkPorts {
  /** BankService.handle. */
  bank: { handle(method: string, p: Record<string, unknown>): Promise<unknown> };
  /** 받기가 어느 사업자 프로필 것인가(실행을 시작한 프로필). */
  profileId(): string | null;
  /** 이 실행을 누가 시작했나. run.startReport가 실행마다 적어 둔다. */
  triggerOf(runId: string): SyncTrigger | null;
}

const nextDay = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/**
 * 금고가 읽은 홈택스 구간을 장부(bank.hometaxSync)에 넣는 받는 곳(ADR-068 결정 10 받기 층).
 * 세금계산서, 현금영수증, 카드 매출은 구간마다 바로 넣는다. 사업용 카드는 실행 한 번에 한 번만 넣을 수 있어(card_fetches가 실행마다 한 줄)
 * 받은 달을 모았다가 done에서 넣는다. 가운데 달을 못 받았으면 그 앞까지만 넣는다: 넣은 구간이 못 받은 달을 덮으면 빈 달이 0원으로 보이기 때문이다.
 * 뒤의 달은 덮음으로 치지 않으니 다음 받기가 거기서부터 다시 받는다.
 */
export function hometaxReportSink(o: ReportSinkPorts): ReportSink {
  const cards = new Map<string, Array<{ from: string; to: string; rows: Array<Record<string, unknown>> } | null>>();
  const ctx = (runId: string) => {
    const profileId = o.profileId();
    const trigger = o.triggerOf(runId);
    if (!profileId || !trigger) throw new Error('report.no_context');
    return { profileId, trigger };
  };
  return {
    async put(runId: string, item: ReportSinkItem) {
      const c = ctx(runId);
      if (item.kind === 'business_card') {
        const xs = cards.get(runId) ?? [];
        xs.push(item.rows ? { from: item.from, to: item.to, rows: item.rows } : null);
        cards.set(runId, xs);
        if (item.rows) return;
      }
      await o.bank.handle('bank.hometaxSync', { ...c, kind: item.kind, from: item.from, to: item.to, ...(item.code ? { code: item.code } : { rows: item.rows }) });
    },
    async done(runId: string) {
      const xs = cards.get(runId);
      cards.delete(runId);
      if (!xs?.length) return;
      const got: Array<{ from: string; to: string; rows: Array<Record<string, unknown>> }> = [];
      for (const x of xs) {
        if (!x || (got.length && nextDay(got.at(-1)!.to) !== x.from)) break;
        got.push(x);
      }
      if (!got.length) return;
      await o.bank.handle('bank.hometaxSync', { ...ctx(runId), kind: 'business_card', from: got[0]!.from, to: got.at(-1)!.to, rows: got.flatMap((x) => x.rows), runId });
    },
  };
}
