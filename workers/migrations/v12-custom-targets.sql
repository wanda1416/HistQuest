-- v12：自定义题库（用户级条目，不进全局 targets 表）
-- draft（草稿）→ submitted（待审）→ approved（已复制入全局）/ rejected（驳回）
-- 审核通过时复制一行到 targets 表，custom_targets 行保留供用户追溯。
CREATE TABLE IF NOT EXISTS custom_targets (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'character',
  name        TEXT NOT NULL,
  aliases     TEXT NOT NULL DEFAULT '[]',
  summary     TEXT NOT NULL,
  region      TEXT NOT NULL DEFAULT 'cn',
  polity      TEXT NOT NULL DEFAULT '',
  world_era   TEXT,
  gender      TEXT NOT NULL DEFAULT '',
  birth       INTEGER,
  death       INTEGER,
  birthplace  TEXT,
  difficulty  INTEGER NOT NULL DEFAULT 2,
  status      TEXT NOT NULL DEFAULT 'draft',
  review_note TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_user ON custom_targets(user_id, status);
