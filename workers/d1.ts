import type { AnswerMode, AnswerRecord, Character, PronounStyle, SoloSession } from '../src/shared/domain.ts';
import { targetEraFacts } from '../src/core/schema.ts';
import { SESSION_TTL_MS } from '../src/server/sessions.ts';
import type { SessionPersistence } from '../src/server/sessions.ts';

/**
 * D1 接口的最小类型声明（避免引入 @cloudflare/workers-types 全量）。
 * prepare().bind().all/first/run 与官方 SDK 同构。
 */
export interface D1Stmt {
  bind(...values: unknown[]): D1Bound;
}
export interface D1Bound {
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta?: { changes?: number } }>;
}
export interface D1Database {
  prepare(sql: string): D1Stmt;
  exec(sql: string): Promise<unknown>;
  batch(statements: D1Bound[]): Promise<unknown>;
}

/** D1 版会话持久化：行结构与 Node 版 SqliteSessionPersistence 完全一致 */
export class D1SessionPersistence implements SessionPersistence {
  // 不用参数属性：本项目要求 .ts 能被 Node 直接擦除运行（见 shared/domain.ts 开头）
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async load(): Promise<SoloSession[]> {
    const since = Date.now() - SESSION_TTL_MS;
    const rows = await this.db
      .prepare('SELECT * FROM sessions WHERE updated_at >= ? ORDER BY updated_at DESC')
      .bind(since)
      .all<SessionRow>();
    return rows.results.map(rowToSession);
  }

  /** Workers 多 isolate 兜底：内存未命中时按 id 从 D1 读单条 */
  async loadOne(id: string): Promise<SoloSession | null> {
    const row = await this.db
      .prepare('SELECT * FROM sessions WHERE id = ?')
      .bind(id)
      .first<SessionRow>();
    return row ? rowToSession(row) : null;
  }

  async save(session: SoloSession): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (
           id, target_id, difficulty, polity, region, world_era, cn_share,
           turns_left, total_turns, mode, pronoun, status, history, created_at, updated_at,
           user_id, user_name, category, challenge_code
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           turns_left = excluded.turns_left,
           mode = excluded.mode,
           status = excluded.status,
           history = excluded.history,
           updated_at = excluded.updated_at`,
      )
      .bind(
        session.id,
        session.targetId,
        session.difficulty,
        session.polity,
        session.region,
        session.worldEra,
        session.cnShare,
        session.turnsLeft,
        0,
        session.mode,
        session.pronoun,
        session.status,
        JSON.stringify(session.history),
        session.createdAt,
        session.updatedAt,
        session.userId ?? null,
        session.userName ?? null,
        session.category ?? 'character',
        session.challengeCode ?? null,
      )
      .run();
  }

  /** 单条即时写入，无需 flush */
  flush(): void {
    /* noop */
  }
}

interface SessionRow {
  id: string;
  target_id: string;
  category?: string | null;
  difficulty: number;
  polity: string | null;
  region: string | null;
  world_era: string | null;
  cn_share: number;
  turns_left: number;
  mode: string;
  pronoun: string;
  status: string;
  history: string;
  created_at: number;
  updated_at: number;
  user_id?: string | null;
  user_name?: string | null;
}

function rowToSession(r: SessionRow): SoloSession {
  let history: AnswerRecord[] = [];
  try {
    history = JSON.parse(r.history) as AnswerRecord[];
  } catch {
    history = [];
  }
  return {
    id: r.id,
    targetId: r.target_id,
    category: (r.category ?? 'character') as SoloSession['category'],
    difficulty: r.difficulty,
    polity: r.polity,
    region: r.region as SoloSession['region'],
    worldEra: r.world_era,
    cnShare: r.cn_share,
    turnsLeft: r.turns_left,
    mode: r.mode as AnswerMode,
    pronoun: r.pronoun as PronounStyle,
    status: r.status as SoloSession['status'],
    history,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...(r.user_id ? { userId: r.user_id, userName: r.user_name ?? null } : {}),
    ...((r as unknown as { challenge_code?: string | null }).challenge_code
      ? { challengeCode: (r as unknown as { challenge_code: string }).challenge_code }
      : {}),
  };
}

interface CharacterRow {
  id: string;
  category?: string | null;
  name: string;
  region: string;
  polity: string;
  polity_alt: string | null;
  facts: string | null;
  birth: number | null;
  death: number | null;
  roles: string;
  tags: string;
  notable: string;
  difficulty: number;
  external_id: string | null;
  retired: number;
}

function rowToCharacter(r: CharacterRow, aliases: string[]): Character {
  const json = <T>(raw: string | null, fb: T): T => {
    try {
      return raw ? (JSON.parse(raw) as T) : fb;
    } catch {
      return fb;
    }
  };
  const category = (r.category ?? 'character') as Character['category'];
  const facts = json<Record<string, unknown>>(r.facts ?? null, {});
  return {
    id: r.id,
    ...(category !== 'character' ? { category } : {}),
    name: r.name,
    aliases,
    region: r.region as Character['region'],
    polity: r.polity,
    polityAlt: json<string[]>(r.polity_alt, []),
    // 非中国条目 polity 即时期（v12 合并 world_era 后）
    ...(r.region !== 'cn' && r.polity ? { worldEra: r.polity as Character['worldEra'] } : {}),
    // 人物专用便利字段从 facts 往返水合（v12 起存储层无独立列）
    gender: ((facts.gender as string) ?? 'male') as Character['gender'],
    birth: r.birth,
    death: r.death,
    birthplace: (facts.birthplace ?? null) as string | null,
    country: (facts.country ?? null) as string | null,
    birthProvince: (facts.province ?? null) as string | null,
    ...(facts.regime ? { regime: facts.regime as string } : {}),
    roles: json<string[]>(r.roles, []),
    tags: json<string[]>(r.tags, []),
    emperor: Boolean(facts.emperor),
    notable: r.notable,
    difficulty: r.difficulty,
    retired: Boolean(r.retired),
  };
}

/** 从 D1 读出全部人物（含软删除），构造 CharacterIndex 用的列表 */
export async function loadTargetsFromD1(db: D1Database): Promise<Character[]> {
  const rows = await db.prepare('SELECT * FROM targets').bind().all<CharacterRow>();
  if (rows.results.length === 0) return [];
  const aliasRows = await db
    .prepare('SELECT target_id, alias FROM target_aliases')
    .bind()
    .all<{ target_id: string; alias: string }>();
  const aliasMap = new Map<string, string[]>();
  for (const a of aliasRows.results) {
    const list = aliasMap.get(a.target_id) ?? [];
    list.push(a.alias);
    aliasMap.set(a.target_id, list);
  }
  return rows.results.map((r) => rowToCharacter(r, aliasMap.get(r.id) ?? []));
}

/** 首次部署：把打包进来的人物 JSON 种子导入 D1 */
export async function seedTargetsIntoD1(
  db: D1Database,
  list: Character[],
): Promise<number> {
  const count = await db.prepare('SELECT COUNT(*) AS n FROM targets').bind().first<{ n: number }>();
  if ((count?.n ?? 0) > 0) return 0;

  const stmts: D1Bound[] = [];
  for (const c of list) {
    const now = Date.now();
    stmts.push(
      db
        .prepare(
          `INSERT INTO targets (
             id, category, name, region, polity, polity_alt, facts, birth, death,
             roles, tags, notable,
             difficulty, retired, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          c.id,
          c.category ?? 'character',
          c.name,
          c.region,
          targetEraFacts(c).era,
          JSON.stringify(c.polityAlt ?? []),
          JSON.stringify(targetEraFacts(c).facts),
          c.birth ?? null,
          c.death ?? null,
          JSON.stringify(c.roles),
          JSON.stringify(c.tags),
          c.notable,
          c.difficulty,
          c.retired ? 1 : 0,
          now,
        ),
    );
    for (const a of c.aliases) {
      stmts.push(
        db
          .prepare('INSERT OR IGNORE INTO target_aliases (target_id, alias) VALUES (?, ?)')
          .bind(c.id, a),
      );
    }
  }
  // D1 batch 单次上限约 100 语句，分批提交
  for (let i = 0; i < stmts.length; i += 90) {
    await db.batch(stmts.slice(i, i + 90));
  }
  return list.length;
}
