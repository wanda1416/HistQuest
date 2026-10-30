import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * SQLite 建库与迁移。
 *
 * 选 node:sqlite 而不是 better-sqlite3：零依赖、无需编译，符合项目「零编译运行」的前提。
 * 代价是要求宿主 Node ≥ 23.4（22.x 需 --experimental-sqlite）。
 */

export const SCHEMA_VERSION = 5;

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

  if (current < 3) {
    migrateV3(db);
  }

  if (current < 4) {
    // v4：把「游客」和「归属未记录」分开
    //   attribution = 'user'  有登录玩家
    //   attribution = 'guest' 明确知道是未登录玩家（本版本起写入）
    //   attribution IS NULL   迁移回填的老局，玩家是否登录已无从得知
    // 不能在迁移里用 user_id IS NULL 反推：回填那批恰恰全是 NULL，
    // 直接推断会把登录用户的局误标成游客。
    addColumn(db, 'games', 'attribution', 'TEXT');
    db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (4, ${Date.now()})`);
  }

  if (current < 5) {
    // v5：对战房间（规则见 docs/MULTIPLAYER.md）
    // 与 Workers 侧 schema.sql v8 同构。房间实时状态在 Durable Object 里，
    // 这张表只是大厅目录 + 结算后的复盘索引；对战局的逐条问答仍进 game_turns。
    db.exec(`
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
    `);
    addColumn(db, 'games', 'room_id', 'TEXT');
    addColumn(db, 'games', 'finish_rank', 'INTEGER');
    db.exec('CREATE INDEX IF NOT EXISTS idx_games_room ON games(room_id)');
    db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (5, ${Date.now()})`);
  }
}

/**
 * v3：账号系统 + 对局归档。
 *
 * sessions 仍是「进行中的工作状态」（24h TTL，可随时重写），
 * games / game_turns 才是永久账本：一局一行、一问一行，只追加不覆盖。
 * 分开存是为了让历史不受会话过期影响——会话被清理掉，历史仍在。
 */
function migrateV3(db: DatabaseSync): void {
  db.exec(`
    -- 账号：PBKDF2 哈希，与 Workers 端 users 表同构
    CREATE TABLE IF NOT EXISTS users (
      id               TEXT PRIMARY KEY,
      username         TEXT NOT NULL UNIQUE,
      password_hash    TEXT NOT NULL,
      role             TEXT NOT NULL DEFAULT 'user',
      allow_server_key INTEGER NOT NULL DEFAULT 1,
      banned           INTEGER NOT NULL DEFAULT 0,
      asks_today       INTEGER NOT NULL DEFAULT 0,
      quota_day        INTEGER NOT NULL DEFAULT 0,
      daily_quota      INTEGER NOT NULL DEFAULT -1,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT PRIMARY KEY,
      created_by TEXT NOT NULL,
      used_by    TEXT,
      used_at    INTEGER,
      created_at INTEGER NOT NULL
    );

    -- 服务端自用键值（会话签名密钥等），只存本机
    CREATE TABLE IF NOT EXISTS app_settings (
      k          TEXT PRIMARY KEY,
      v          TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    -- 对局账本：一局一行，永不因 TTL 删除
    CREATE TABLE IF NOT EXISTS games (
      id          TEXT PRIMARY KEY,
      user_id     TEXT,
      user_name   TEXT,
      target_id   TEXT NOT NULL,
      target_name TEXT NOT NULL,
      target_roles TEXT NOT NULL DEFAULT '[]',
      attribution TEXT,
      difficulty  INTEGER NOT NULL,
      polity      TEXT,
      region      TEXT,
      world_era   TEXT,
      mode        TEXT NOT NULL,
      pronoun     TEXT NOT NULL,
      turns_total INTEGER NOT NULL,
      turns_left  INTEGER NOT NULL,
      turns_used  INTEGER NOT NULL DEFAULT 0,
      asks        INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      ended_at    INTEGER,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_games_user    ON games(user_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_games_started ON games(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_games_target  ON games(target_id);

    -- 对话账本：一问一行，含被纠正的问法与重试型失败（那是真实的对话记录）
    CREATE TABLE IF NOT EXISTS game_turns (
      game_id   TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      seq       INTEGER NOT NULL,
      question  TEXT NOT NULL,
      verdict   TEXT NOT NULL,
      text      TEXT NOT NULL,
      hint      TEXT,
      invalid   TEXT,
      failed    INTEGER NOT NULL DEFAULT 0,
      hit       INTEGER NOT NULL DEFAULT 0,
      basis     TEXT,
      calls     INTEGER NOT NULL DEFAULT 0,
      ms        INTEGER NOT NULL DEFAULT 0,
      asked_at  INTEGER NOT NULL,
      PRIMARY KEY (game_id, seq)
    );
  `);

  addColumn(db, 'sessions', 'user_id', 'TEXT');
  addColumn(db, 'sessions', 'user_name', 'TEXT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, updated_at)');

  backfillGamesFromSessions(db);

  db.exec(`INSERT INTO schema_migrations (version, applied_at) VALUES (3, ${Date.now()})`);
}

/** 给老库补列：SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查 table_info */
function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * 把升级前还在有效期内的会话搬进账本，避免"刚打完的局在历史里查不到"。
 * 只搬 games 表还没有的局；turns 从会话的 history JSON 逐条展开。
 */
function backfillGamesFromSessions(db: DatabaseSync): void {
  interface SessionRow {
    id: string;
    target_id: string;
    difficulty: number;
    polity: string | null;
    region: string | null;
    world_era: string | null;
    mode: string;
    pronoun: string;
    turns_left: number;
    status: string;
    history: string;
    created_at: number;
    updated_at: number;
    user_id?: string | null;
    user_name?: string | null;
  }

  const rows = db
    .prepare(
      `SELECT s.id, s.target_id, s.difficulty, s.polity, s.region, s.world_era, s.mode, s.pronoun,
              s.turns_left, s.status, s.history, s.created_at, s.updated_at, s.user_id, s.user_name
         FROM sessions s
         LEFT JOIN games g ON g.id = s.id
        WHERE g.id IS NULL`,
    )
    .all() as unknown as SessionRow[];
  if (!rows.length) return;

  const insertGame = db.prepare(
    `INSERT OR IGNORE INTO games (
       id, user_id, user_name, target_id, target_name, target_roles, difficulty, polity, region, world_era,
       mode, pronoun, turns_total, turns_left, turns_used, asks, status, started_at, ended_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const insertTurn = db.prepare(
    `INSERT OR REPLACE INTO game_turns (
       game_id, seq, question, verdict, text, hint, invalid, failed, hit, basis, calls, ms, asked_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  );
  const findName = db.prepare('SELECT name, roles FROM characters WHERE id = ?');

  for (const row of rows) {
    let turns: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(row.history) as unknown;
      if (Array.isArray(parsed)) turns = parsed as Array<Record<string, unknown>>;
    } catch {
      turns = [];
    }
    const found = findName.get(row.target_id) as { name?: string; roles?: string } | undefined;
    const used = turns.filter((t) => !t.transient && !t.invalid).length;
    const endedAt = row.status === 'playing' ? null : row.updated_at;
    insertGame.run(
      row.id,
      row.user_id ?? null,
      row.user_name ?? null,
      row.target_id,
      found?.name ?? row.target_id,
      found?.roles ?? '[]',
      row.difficulty,
      row.polity,
      row.region,
      row.world_era,
      row.mode,
      row.pronoun,
      row.turns_left + used,
      row.turns_left,
      used,
      turns.length,
      row.status,
      row.created_at,
      endedAt,
      row.updated_at,
    );
    for (const t of turns) {
      insertTurn.run(
        row.id,
        Number(t.seq) || 0,
        String(t.question ?? ''),
        String(t.verdict ?? 'unknown'),
        String(t.text ?? ''),
        typeof t.hint === 'string' ? t.hint : null,
        typeof t.invalid === 'string' ? t.invalid : null,
        t.transient ? 1 : 0,
        t.hit ? 1 : 0,
        typeof t.basis === 'string' ? t.basis : null,
        Number(t.calls) || 0,
        Number(t.ms) || 0,
        row.created_at,
      );
    }
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
