const MS = { H: 3600_000 } as const;

export const GATEWAY = {
  l1PerRun: 12,
  l2PerRun: 2,
  l1PerChat: 12,
  l2PerChat: 20,
  agentPerRun: 32,
  agentUpstreamTimeoutMs: 50_000,
  runTokenTtlMs: 2 * MS.H,
  runTokensPerDeviceHour: 120,
  l1PerMinute: 60,
  l2PerMinute: 10,
  agentPerMinute: 40,
  monthlyTokensDefault: 3_000_000,
  hardCapMultiplier: 2,
  safetyAfterCapPerMinute: 6,
  providerRetries: 2,
  backoffBaseMs: 250,
  callRecordRetentionDays: 35,
  abuseWindowMs: MS.H,
  abuseThreshold: 20,
  bizPerRequest: 10,
  bizPerMinute: 30,
  codefTokenPerDeviceHour: 20,
} as const;

/** 단가(마이크로 달러 / 100만 토큰). S9 실측·계약 전에는 0이고 ENV(GW_PRICES_JSON)로 넣는다. 토큰 수 계량은 단가와 무관하게 정확하다. */
export interface Prices {
  decideIn: number;
  decideOut: number;
  respondIn: number;
  respondOut: number;
  decideCached?: number;
  respondCached?: number;
  agentIn?: number;
  agentCached?: number;
  agentOut?: number;
}
export const ZERO_PRICES: Prices = { decideIn: 0, decideOut: 0, respondIn: 0, respondOut: 0 };

/**
 * 주간 한도용 기본 단가(마이크로 달러 / 100만 토큰). 공급사가 금액(usage.cost)을 주지 않은 호출만 이 값으로 센다(Anthropic, 모의, 금액 없는 응답).
 * decide = gpt-6-luna Decisions(R1 §A.7: 입력 $0.10, 캐시 $0.01, 출력 무료).
 * respond = DeepSeek V4.1 Flash 1017(사용자 확인 2026-11-16). OpenRouter 표시가는 입력 $0.02·출력 $0.108이지만 제공사 라우팅에 따라 달라서,
 * 한도는 DeepSeek 공식 피크 단가(입력 $0.30, 캐시 $0.006, 출력 $1.20)로 센다(실제보다 많게 세는 쪽).
 * 에이전트 라우터(jev-router) 단가는 모르므로 gpt-6.1-terra(입력 $1, 캐시 $0.05, 출력 $5)로 잡는다(보수적).
 */
export const LIMIT_PRICES: Required<Prices> = {
  decideIn: 100_000,
  decideCached: 10_000,
  decideOut: 0,
  respondIn: 300_000,
  respondCached: 6_000,
  respondOut: 1_200_000,
  agentIn: 1_000_000,
  agentCached: 50_000,
  agentOut: 5_000_000,
};

/**
 * 대화 주간 한도(원, 대표 결정 2026-11-24: 계정마다 한 주 1,000원, 토큰 원가 기준). 한 주는 한국 시간 월요일 0시에 바뀐다.
 * 대화 범위(chatSessionId 실행 토큰) 호출만 세고 막는다. 발급 같은 실행 범위(runId) 호출은 세지도 막지도 않는다.
 * 금액은 OpenRouter가 돌려준 usage.cost(달러)로 세고, 그 값이 없으면 실제 토큰 × LIMIT_PRICES로 센다.
 */
export const WEEKLY = {
  krw: 1000,
  krwPerUsd: 1450,
} as const;

/** 한도에 닿아도 이 시간 안에는 일 시키는 대화(판정 act task·followup)의 에이전트 호출을 보낸다(한 턴의 도구 왕복이 끝나는 시간) */
export const WORK_PASS_MS = 3 * 60_000;

/** 주간 한도의 '한 주'(KST 월요일 날짜)와 다음 초기화 시각(다음 월요일 0시 KST) */
export function limitWeek(ms: number): { week: string; resetAt: number } {
  const kst = new Date(ms + 9 * MS.H);
  const sinceMonday = (kst.getUTCDay() + 6) % 7;
  const mondayKst = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate() - sinceMonday);
  return { week: new Date(mondayKst).toISOString().slice(0, 10), resetAt: mondayKst + 7 * 24 * MS.H - 9 * MS.H };
}
