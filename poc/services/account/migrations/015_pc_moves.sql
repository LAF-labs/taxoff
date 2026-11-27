-- 계정 서비스 v15: 새 PC로 기록 옮기기 청하기(ADR-055 개정, ADR-070 결정 8).
-- 서버는 어느 PC가 청했고 어느 PC가 답했는지, 두 PC가 만날 룸 ID만 본다. 기록은 두 PC가 룸에서 바로 주고받고 여기에는 오지 않는다.
CREATE TABLE pc_moves (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  to_device_id TEXT NOT NULL,
  from_device_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('asked', 'done', 'closed')),
  room_id TEXT,
  room_at {{BIGINT}},
  asker_seen_at {{BIGINT}} NOT NULL,
  created_at {{BIGINT}} NOT NULL,
  expires_at {{BIGINT}} NOT NULL
);
CREATE INDEX pc_moves_account ON pc_moves (account_id, state);
