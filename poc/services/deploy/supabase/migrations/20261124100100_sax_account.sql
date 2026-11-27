-- 생성 파일: services/shared/src/supabase.ts(cd poc && node --conditions=development services/deploy/export-supabase.ts). 직접 고치지 않는다.

-- account: 서비스 마이그레이션은 스키마 account, 한도 표는 account_limits. 기록은 account.schema_migrations(상시 서버의 migrate와 같은 표).

SET search_path TO account;

-- account/migrations/014_docs.sql
-- 계정 서비스 v14: 문서함 계정 사본(ADR-064, 대표 결정 2026-11-24 "택스오프 계정에 암호화해 보관").
-- 서버는 문서 기록의 암호문과 조각 수·크기만 본다. 이름·종류·날짜·내용·문서 열쇠는 기록 암호문 안에 있고, 그 열쇠는 사용자 기기에만 있다.
-- 조각 암호문은 DB가 아니라 비공개 객체 저장소(DOCS_S3_*)에 둔다. 경로는 <account_id>/<doc_id>/<순번>.
-- accounts를 참조하지 않는다: 탈퇴로 계정 줄이 지워진 뒤 주기 작업이 남은 줄을 보고 저장소의 조각을 먼저 지운 다음 줄을 지운다.
CREATE TABLE doc_heads (
  account_id TEXT PRIMARY KEY,
  next_seq BIGINT NOT NULL              -- 다음 변경이 받을 순번
);
CREATE TABLE docs (
  account_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,                     -- PC가 뽑은 22자 b64url
  seq BIGINT,                           -- 마지막 변경의 계정 안 순번(올리는 중이면 NULL). 받는 쪽은 이 순번 뒤만 받는다
  state TEXT NOT NULL,                      -- uploading | ready | deleted
  rev INTEGER NOT NULL,                     -- 기록 판(1부터). 같거나 낮은 판은 받지 않는다(서버가 옛 기록으로 되돌리지 못한다)
  epoch INTEGER NOT NULL,                   -- 기록을 봉인한 열쇠의 세대
  device_id TEXT NOT NULL,                  -- 마지막으로 올린 데스크톱
  record TEXT,                              -- 문서 기록 암호문(b64url). 지우면 NULL
  chunks INTEGER NOT NULL,                  -- 조각 수(1~16)
  got INTEGER NOT NULL,                     -- 받은 조각 비트(올리는 중에만 쓴다)
  blob_bytes BIGINT NOT NULL,           -- 조각 암호문 바이트 합(Padmé로 채운 크기, 할당량)
  expires_at BIGINT,                    -- 올리는 중일 때만: 이때까지 기록이 안 오면 주기 작업이 조각과 함께 지운다
  PRIMARY KEY (account_id, doc_id)
);
CREATE UNIQUE INDEX docs_seq ON docs (account_id, seq);
CREATE INDEX docs_expires ON docs (expires_at);

CREATE TABLE IF NOT EXISTS schema_migrations (service TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (service, version));
INSERT INTO schema_migrations (service, version) VALUES ('account', 14) ON CONFLICT DO NOTHING;

-- 권한: 이 서비스 역할만 행을 읽고 쓴다(DDL 없음). Supabase API 역할(anon·authenticated)과 PUBLIC에는 아무것도 없다.
REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA account, account_limits TO sax_account;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA account, account_limits TO sax_account;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON ALL TABLES IN SCHEMA account, account_limits FROM anon, authenticated; END IF; END $$;
RESET search_path;
