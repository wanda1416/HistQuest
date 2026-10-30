import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite 建库与迁移。
 *
 * 选 node:sqlite 而不是 better-sqlite3：零依赖、无需编译，符合项目「零编译运行」的前提。
 * 代价是要求宿主 Node ≥ 23.4（22.x 需 --experimental-sqlite）。
 */

export const SCHEMA_VERSION = 2;

export interface OpenOptions {
  file: string;
  /** 只读打开（导出、健康检查用） */
  readOnly?: boolean;
}

export function openDatabase(opts: OpenOptions): DatabaseSync {
  if (!opts.readOnly && opts.file !== ':memory:') {
    fs.mkdirSync(path.dirname(opts.file), { recursive: true });
  }
  const db = new DatabaseSync(opts.file, { readOnly: Boolean(opts.readOnly) });

  if (!opts.readOnly) {
    // 内存库不支持 WAL，单独跳过后面的 PRAGMA
    if (opts.file !== ':memory:') {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA synchronous = NORMAL');
    }
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
  }
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;
  if (current >= SCHEMA_VERSION) return;

  if (current < 1) {
    db.exec(`
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

      -- 在线设置同步：只存密文，服务端没有解密能力
      CREATE TABLE IF NOT EXISTS settings_vault (
        vault_id   TEXT PRIMARY KEY,
        version    INTEGER NOT NULL,
        blob       TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      INSERT INTO schema_migrations (version, applied_at) VALUES (1, ${Date.now()});
    `);
  }

  if (current < 2) {
    // 管理密钥与数据密钥分离：
    // auth_hash 用于校验请求身份，wrapped_dek 是经 KEK 包裹的数据密钥
    db.exec(`
      ALTER TABLE settings_vault ADD COLUMN auth_hash TEXT NOT NULL DEFAULT '';
      ALTER TABLE settings_vault ADD COLUMN wrapped_dek TEXT NOT NULL DEFAULT '';
      INSERT INTO schema_migrations (version, applied_at) VALUES (2, ${Date.now()});
    `);
  }
}

/** SQLite 官方在线备份：WAL 模式下也安全，比复制文件可靠 */
export function vacuumInto(db: DatabaseSync, target: string): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const escaped = target.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
}

/** 备份目录清理：只保留最近 keep 份 */
export function pruneBackups(dir: string, keep: number, prefix = 'hq-'): number {
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(prefix) && f.endsWith('.db'))
    .map((name) => ({ name, time: fs.statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => a.time - b.time);

  const drop = files.slice(0, Math.max(0, files.length - keep));
  for (const f of drop) {
    try {
      fs.rmSync(path.join(dir, f.name), { force: true });
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
  return drop.length;
}

export function integrityCheck(db: DatabaseSync): { ok: boolean; detail: string } {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
  const detail = row?.integrity_check ?? 'unknown';
  return { ok: detail === 'ok', detail };
}

export function tableCount(db: DatabaseSync, table: 'characters' | 'sessions'): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}
