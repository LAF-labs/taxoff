-- 계정 서비스 v14: 문서함 계정 사본(ADR-064, 대표 결정 2026-11-24 "택스오프 계정에 암호화해 보관").
-- 서버는 문서 기록의 암호문과 조각 수·크기만 본다. 이름·종류·날짜·내용·문서 열쇠는 기록 암호문 안에 있고, 그 열쇠는 사용자 기기에만 있다.
-- 조각 암호문은 DB가 아니라 비공개 객체 저장소(DOCS_S3_*)에 둔다. 경로는 <account_id>/<doc_id>/<순번>.
-- accounts를 참조하지 않는다: 탈퇴로 계정 줄이 지워진 뒤 주기 작업이 남은 줄을 보고 저장소의 조각을 먼저 지운 다음 줄을 지운다.
CREATE TABLE doc_heads (
  account_id TEXT PRIMARY KEY,
  next_seq {{BIGINT}} NOT NULL              -- 다음 변경이 받을 순번
);
CREATE TABLE docs (
  account_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,                     -- PC가 뽑은 22자 b64url
  seq {{BIGINT}},                           -- 마지막 변경의 계정 안 순번(올리는 중이면 NULL). 받는 쪽은 이 순번 뒤만 받는다
  state TEXT NOT NULL,                      -- uploading | ready | deleted
  rev INTEGER NOT NULL,                     -- 기록 판(1부터). 같거나 낮은 판은 받지 않는다(서버가 옛 기록으로 되돌리지 못한다)
  epoch INTEGER NOT NULL,                   -- 기록을 봉인한 열쇠의 세대
  device_id TEXT NOT NULL,                  -- 마지막으로 올린 데스크톱
  record TEXT,                              -- 문서 기록 암호문(b64url). 지우면 NULL
  chunks INTEGER NOT NULL,                  -- 조각 수(1~16)
  got INTEGER NOT NULL,                     -- 받은 조각 비트(올리는 중에만 쓴다)
  blob_bytes {{BIGINT}} NOT NULL,           -- 조각 암호문 바이트 합(Padmé로 채운 크기, 할당량)
  expires_at {{BIGINT}},                    -- 올리는 중일 때만: 이때까지 기록이 안 오면 주기 작업이 조각과 함께 지운다
  PRIMARY KEY (account_id, doc_id)
);
CREATE UNIQUE INDEX docs_seq ON docs (account_id, seq);
CREATE INDEX docs_expires ON docs (expires_at);
