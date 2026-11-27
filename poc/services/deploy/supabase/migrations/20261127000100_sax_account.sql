-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/015_pc_moves.sql
-- 계정 서비스 v15: 새 PC로 기록 옮기기 청하기(ADR-055 개정, ADR-070 결정 8).
-- 서버는 어느 PC가 청했고 어느 PC가 답했는지, 두 PC가 만날 룸 ID만 본다. 기록은 두 PC가 룸에서 바로 주고받고 여기에는 오지 않는다.
CREATE TABLE pc_moves (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_device_id TEXT NOT NULL,
  from_device_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('asked', 'done', 'closed')),
  room_id TEXT,
  room_at BIGINT,
  asker_seen_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX pc_moves_account ON pc_moves (account_id, state);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 15) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
