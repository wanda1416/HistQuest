-- v15：挑战（出题）：统一登记表；会话/对局账本记录挑战码与玩家 IP（审计与额度归属）
CREATE TABLE IF NOT EXISTS challenges (
  code       TEXT PRIMARY KEY,
  creator_id TEXT NOT NULL,
  custom_id  TEXT,
  global_id  TEXT,
  settings   TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
ALTER TABLE sessions ADD COLUMN challenge_code TEXT;
ALTER TABLE games ADD COLUMN challenge_code TEXT;
ALTER TABLE games ADD COLUMN player_ip TEXT;
CREATE INDEX IF NOT EXISTS idx_games_challenge ON games(challenge_code, started_at DESC);
