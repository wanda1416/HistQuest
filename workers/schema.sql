-- D1 schema：与 src/server/db.ts 的迁移 v2 保持同构。
-- 部署：wrangler d1 execute hq --remote --file=workers/schema.sql

CREATE TABLE IF NOT EXISTS targets (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  region         TEXT NOT NULL,
  polity         TEXT NOT NULL,
  polity_alt     TEXT NOT NULL DEFAULT '[]',
  world_era      TEXT,
  gender         TEXT NOT NULL,
  birth          INTEGER,
  death          INTEGER,
  birthplace     TEXT,
  country        TEXT,
  birth_province TEXT,
  roles          TEXT NOT NULL DEFAULT '[]',
  tags           TEXT NOT NULL DEFAULT '[]',
  emperor        INTEGER NOT NULL DEFAULT 0,
  notable        TEXT NOT NULL DEFAULT '',
  difficulty     INTEGER NOT NULL,
  category       TEXT NOT NULL DEFAULT 'character',
  external_id    TEXT,
  retired        INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS target_aliases (
  target_id TEXT NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  PRIMARY KEY (target_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_pick_region ON targets(retired, region, difficulty);
CREATE INDEX IF NOT EXISTS idx_pick_polity ON targets(retired, polity, difficulty);
CREATE INDEX IF NOT EXISTS idx_pick_era    ON targets(retired, world_era, difficulty);
CREATE INDEX IF NOT EXISTS idx_alias       ON target_aliases(alias);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  target_id   TEXT NOT NULL,
  difficulty  INTEGER NOT NULL,
  polity      TEXT,
  region      TEXT,
  world_era   TEXT,
  cn_share    REAL NOT NULL DEFAULT 0.5,
  turns_left  INTEGER NOT NULL,
  total_turns INTEGER NOT NULL,
  mode        TEXT NOT NULL,
  pronoun     TEXT NOT NULL,
  status      TEXT NOT NULL,
  history     TEXT NOT NULL DEFAULT '[]',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_updated ON sessions(updated_at);

CREATE TABLE IF NOT EXISTS settings_vault (
  vault_id   TEXT PRIMARY KEY,
  version    INTEGER NOT NULL,
  blob       TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  auth_hash  TEXT NOT NULL DEFAULT '',
  wrapped_dek TEXT NOT NULL DEFAULT ''
);

-- v3：用户系统（邀请码注册）
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- PBKDF2-SHA256: salt$iter$hash 的 base64
  role          TEXT NOT NULL DEFAULT 'user',  -- user | admin
  allow_server_key INTEGER NOT NULL DEFAULT 1, -- 是否允许用服务端 Key（0=必须 BYOK）
  banned        INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  asks_today    INTEGER NOT NULL DEFAULT 0,   -- 当日提问计数（服务端 Key 的调用）
  quota_day     INTEGER NOT NULL DEFAULT 0     -- 计数所属日（yyyymmdd，跨日清零）
);

CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  used_by    TEXT,
  used_at    INTEGER,
  created_at INTEGER NOT NULL
);


-- v4：按用户配额 + 后台可改的 LLM 配置
-- daily_quota: -1=跟随全局默认(500)，0=禁用服务端Key，>0=自定义每日上限
ALTER TABLE users ADD COLUMN daily_quota INTEGER NOT NULL DEFAULT -1;

CREATE TABLE IF NOT EXISTS app_settings (
  k          TEXT PRIMARY KEY,
  v          TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- v5：对局历史归属（游客为 NULL；user_name 为注册时的用户名快照）
ALTER TABLE sessions ADD COLUMN user_id TEXT;
ALTER TABLE sessions ADD COLUMN user_name TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at);

-- v6：对局账本（永久历史）——与 src/server/db.ts 迁移 v3 完全同构
-- sessions 仍是 24h 工作状态；games / game_turns 只追加，不随会话过期消失
CREATE TABLE IF NOT EXISTS games (
  id           TEXT PRIMARY KEY,
  user_id      TEXT,
  user_name    TEXT,
  target_id    TEXT NOT NULL,
  target_name  TEXT NOT NULL,
  target_roles TEXT NOT NULL DEFAULT '[]',
  attribution  TEXT,                      -- user / guest / NULL=迁移回填未记录
  difficulty   INTEGER NOT NULL,
  polity       TEXT,
  region       TEXT,
  world_era    TEXT,
  mode         TEXT NOT NULL,
  pronoun      TEXT NOT NULL,
  turns_total  INTEGER NOT NULL,
  turns_left   INTEGER NOT NULL,
  turns_used   INTEGER NOT NULL DEFAULT 0,
  asks         INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  ended_at     INTEGER,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_user    ON games(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_started ON games(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_games_target  ON games(target_id);

CREATE TABLE IF NOT EXISTS game_turns (
  game_id  TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  seq      INTEGER NOT NULL,
  question TEXT NOT NULL,
  verdict  TEXT NOT NULL,
  text     TEXT NOT NULL,
  hint     TEXT,
  invalid  TEXT,
  failed   INTEGER NOT NULL DEFAULT 0,
  hit      INTEGER NOT NULL DEFAULT 0,
  basis    TEXT,
  calls    INTEGER NOT NULL DEFAULT 0,
  ms       INTEGER NOT NULL DEFAULT 0,
  asked_at INTEGER NOT NULL,
  PRIMARY KEY (game_id, seq)
);

-- v7：归属来源（user / guest / NULL=迁移回填查不到），避免把登录玩家误标成游客
-- 老库执行一次：ALTER TABLE games ADD COLUMN attribution TEXT;

-- v8：对战房间（目录 + 对战局归属）
-- 房间实时状态在 Durable Object 里；这里的 rooms 只做大户列表用的目录。
-- 每位参赛者落一条 games 行（room_id 指回房间），复用人/后台/导出全部链路。
-- 老库请改用 workers/migrations/v8-rooms.sql（ALTER 不可重复执行）。
CREATE TABLE IF NOT EXISTS rooms (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  host_user_id   TEXT,
  host_name      TEXT,
  status         TEXT NOT NULL,
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
  target_id      TEXT,
  started_at     INTEGER,
  ended_at       INTEGER,
  winner_user_id TEXT,
  winner_name    TEXT,
  end_reason     TEXT,
  end_vote_json  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rooms_open ON rooms(status, created_at DESC);

-- v9：谜底类别（character / event / item）——见 src/shared/domain.ts 的类别说明
-- 人物专用列（gender/emperor…）对事件/物品填占位值，语义由 category 决定
ALTER TABLE targets ADD COLUMN category TEXT NOT NULL DEFAULT 'character';
ALTER TABLE sessions ADD COLUMN category TEXT NOT NULL DEFAULT 'character';
ALTER TABLE games ADD COLUMN category TEXT NOT NULL DEFAULT 'character';
-- v9（本地 v6）：谜底类别列（category），新库建表时已含
-- v10（本地 v7）：表改名 characters → targets，新库建表时已用新名。
--   老库升级：按顺序执行 migrations/v9-category.sql、v10-rename-targets.sql

-- v12：自定义题库（用户级条目，不进全局 targets 表）；老库执行 migrations/v12-custom-targets.sql
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
  global_id   TEXT,
  share_code  TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_user ON custom_targets(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_share ON custom_targets(share_code);
