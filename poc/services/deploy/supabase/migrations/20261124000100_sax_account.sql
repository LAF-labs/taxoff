-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/012_passwordless_unlock.sql
-- 계정 서비스 v12: 비밀번호 없는 계정(ADR-061, 대표 승인 2026-11-24). 표를 더하기만 한다(옛 판 코드가 그대로 돈다).
-- 서버가 가진 것만으로는 어떤 열쇠도 열리지 않는다. 여기 표에는 사용자 기기 없이 쓸모없는 값만 둔다.

-- 복구 코드로 잠근 계정 열쇠(RKr, 결정 8). 금고가 만든 불투명한 암호문(솔트 포함, 200바이트 이하)이고, 열쇠는 사용자가 적어 둔 120비트 복구 코드뿐이다.
CREATE TABLE recovery_keys (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  aik_pub TEXT NOT NULL,                    -- 맡길 때의 계정 AIK 공개키(계정의 AIK와 다르면 내주지 않는다)
  blob TEXT NOT NULL,                       -- RKr(base64)
  set_at BIGINT NOT NULL
);

-- 이메일로 PC 잠금 풀기 조각(Se, 결정 7). PC마다 32바이트. 그 PC 디스크의 봉인문과 기기 결박 키가 함께 있어야 쓸모가 있다.
CREATE TABLE unlock_email_shares (
  device_id TEXT PRIMARY KEY REFERENCES devices(device_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  se TEXT NOT NULL,                         -- Se(base64 32B)
  set_at BIGINT NOT NULL
);
CREATE INDEX unlock_email_shares_account ON unlock_email_shares (account_id);

-- 이메일로 풀기 숫자(6자리, 10분, 5회). 요청한 PC에 결속한다. 평문 없음
CREATE TABLE unlock_codes (
  unlock_id_hash TEXT PRIMARY KEY,          -- sha256(unlockId)
  device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  code_mac TEXT NOT NULL,                   -- HMAC(CODE_MAC_KEY, "SAX-unlock-code-v1" ‖ deviceId ‖ unlockId ‖ code)
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at BIGINT NOT NULL
);
CREATE INDEX unlock_codes_device ON unlock_codes (device_id);

-- 맡긴 열쇠를 지운 계정(결정 10 2단계). 이 줄이 있으면 옛 판 PC가 다시 맡기려 해도 받지 않는다
CREATE TABLE key_escrow_off (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  off_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 12) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
