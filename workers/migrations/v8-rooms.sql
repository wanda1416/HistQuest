-- v8：对战房间
-- 只对已上线的库执行一次（ALTER TABLE ADD COLUMN 不可重复执行）。
-- 新库直接跑 schema.sql 即可（同一段已并入其中）。
--
--   npx wrangler d1 execute hq --remote --file=workers/migrations/v8-rooms.sql

CREATE TABLE IF NOT EXISTS rooms (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  host_user_id   TEXT,
  host_name      TEXT,
  status         TEXT NOT NULL,             -- lobby | playing | finished | closed
  listed         INTEGER NOT NULL DEFAULT 1,
  max_players    INTEGER NOT NULL DEFAULT 8,
  turn_limit     INTEGER NOT NULL DEFAULT 20,
  difficulty     INTEGER,
  polity         TEXT,
  region         TEXT,
  world_era      TEXT,
  cn_share       REAL,
  mode           TEXT,
  player_count   INTEGER NOT NULL DEFAULT 0,
  target_id      TEXT,                      -- 进行中不下发
  started_at     INTEGER,
  ended_at       INTEGER,
  winner_user_id TEXT,
  winner_name    TEXT,
  end_reason     TEXT,                      -- guess | vote | exhausted | last-man | stale | host-closed
  end_vote_json  TEXT,                      -- 投票通过时的现场快照（几个人在线、谁在线）
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms(status, created_at DESC);

ALTER TABLE games ADD COLUMN room_id TEXT;
ALTER TABLE games ADD COLUMN finish_rank INTEGER;
CREATE INDEX IF NOT EXISTS idx_games_room ON games(room_id);
