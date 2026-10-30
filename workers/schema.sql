-- D1 schema：与 src/server/db.ts 的迁移 v2 保持同构。
-- 部署：wrangler d1 execute hq --remote --file=workers/schema.sql

CREATE TABLE IF NOT EXISTS characters (
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
  external_id    TEXT,
  retired        INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS character_aliases (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  alias        TEXT NOT NULL,
  PRIMARY KEY (character_id, alias)
);

CREATE INDEX IF NOT EXISTS idx_pick_region ON characters(retired, region, difficulty);
CREATE INDEX IF NOT EXISTS idx_pick_polity ON characters(retired, polity, difficulty);
CREATE INDEX IF NOT EXISTS idx_pick_era    ON characters(retired, world_era, difficulty);
CREATE INDEX IF NOT EXISTS idx_alias       ON character_aliases(alias);

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

