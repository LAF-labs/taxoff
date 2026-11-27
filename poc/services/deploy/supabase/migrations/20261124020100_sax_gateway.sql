-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- gateway: 서비스 마이그레이션은 스키마 gateway, 한도 표는 gateway_limits. 기록은 gateway.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO gateway;

-- gateway/migrations/004_usage_weekly.sql
-- 게이트웨이 v4: 대화 주간 한도(대표 결정 2026-11-24, 한 주 1,000원). 한 주 = 한국 시간 월요일 0시부터(week = 그 월요일의 KST 날짜).
-- 대화 범위 호출의 금액만 쌓는다(마이크로 달러, OpenRouter usage.cost, 없으면 토큰 × 한도 단가). 한도 판정용이고 지난주 행은 정리 cron이 지운다.
CREATE TABLE usage_weekly (
  account_id TEXT NOT NULL,
  week TEXT NOT NULL,
  cost_micro_usd BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, week)
);
-- 한도에 닿은 뒤에도 일 시키는 대화(판정 act task·followup)의 에이전트 호출을 보내는 시각 상한(밀리초). 0이면 없음
ALTER TABLE run_scopes ADD COLUMN work_until BIGINT NOT NULL DEFAULT 0;
-- 하루 한도는 주간 한도로 바뀌었다. 이틀 보존 한도 카운터라 지워도 잃는 기록이 없다
DROP TABLE usage_daily;

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('gateway', 4) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA gateway, gateway_limits TO sax_gateway;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA gateway, gateway_limits TO sax_gateway;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA gateway, gateway_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
