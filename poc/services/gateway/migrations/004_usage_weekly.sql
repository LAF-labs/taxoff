-- 게이트웨이 v4: 대화 주간 한도(대표 결정 2026-11-24, 한 주 1,000원). 한 주 = 한국 시간 월요일 0시부터(week = 그 월요일의 KST 날짜).
-- 대화 범위 호출의 금액만 쌓는다(마이크로 달러, OpenRouter usage.cost, 없으면 토큰 × 한도 단가). 한도 판정용이고 지난주 행은 정리 cron이 지운다.
CREATE TABLE usage_weekly (
  account_id TEXT NOT NULL,
  week TEXT NOT NULL,
  cost_micro_usd {{BIGINT}} NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, week)
);
-- 한도에 닿은 뒤에도 일 시키는 대화(판정 act task·followup)의 에이전트 호출을 보내는 시각 상한(밀리초). 0이면 없음
ALTER TABLE run_scopes ADD COLUMN work_until {{BIGINT}} NOT NULL DEFAULT 0;
-- 하루 한도는 주간 한도로 바뀌었다. 이틀 보존 한도 카운터라 지워도 잃는 기록이 없다
DROP TABLE usage_daily;
