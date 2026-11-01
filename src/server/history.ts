import type { AnswerMode, AnswerRecord, Region, SessionStatus, SoloSession, TargetCategory } from '../shared/domain.ts';
import type {
  GameResult,
  HistoryDetail,
  HistoryListRes,
  HistorySummary,
  HistoryTurn,
} from '../shared/protocol.ts';

/**
 * 只用到 prepare/run/get/all 三件套：这样本模块不 import node:sqlite，
 * Workers 侧也能直接复用同一份 SQL 与投影。
 */
export interface SqliteLike {
  prepare(sql: string): {
    run(...params: unknown[]): { changes?: number | bigint };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * 对局历史（永久账本）的读写模型。
 *
 * 与 sessions 的区别：sessions 是「进行中的工作状态」，24h 过期、每条覆盖写；
 * games / game_turns 是只追加的账本——一局一行、一问一行，会话被清理了历史还在。
 *
 * 两端同构：Node 用 node:sqlite（同步），Workers 用 D1（异步），
 * 所以接口允许返回 Promise，投影逻辑（rowToSummary / rowToDetail）共用同一份。
 */

export interface HistoryQuery {
  /** 精确匹配归属用户；'guest' 表示只看游客局 */
  userId?: string | 'guest';
  /** 挑战局过滤：只看用这个挑战码玩的局（出题人查看「谁玩了」） */
  challengeCode?: string;
  /** 用户名模糊匹配（管理员用） */
  userName?: string;
  /** 只看某个结局 */
  result?: GameResult;
  /** 目标人物名 / 用户名 模糊匹配 */
  q?: string;
  limit?: number;
  offset?: number;
}

export interface TargetSnapshot {
  name: string;
  roles: string[];
  /** 真实类别（混合局与玩家所选可能不同） */
  category: TargetCategory;
}

export interface HistoryStore {
  list(query?: HistoryQuery): HistoryListRes | Promise<HistoryListRes>;
  get(id: string): HistoryDetail | null | Promise<HistoryDetail | null>;
}

/**
 * 归档写入接口：SoloStore 在开局、每次问答、每次状态变化时调用。
 * 实现方负责 upsert，重复调用是安全的（幂等）。
 */
export interface GameRecorder {
  /** 开局：写入对局骨架 */
  start(session: SoloSession, target: TargetSnapshot): void | Promise<void>;
  /** 一条问答落账（含被纠正的问法与超时/坏 JSON 这类重试记录，那些也是真实对话） */
  turn(session: SoloSession, target: TargetSnapshot, record: AnswerRecord): void | Promise<void>;
  /** 状态变化（猜测、揭晓、次数用尽）时同步对局行 */
  sync(session: SoloSession, target: TargetSnapshot): void | Promise<void>;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

/* ---------------- 行 → DTO ---------------- */

export interface GameRow {
  id: string;
  user_id: string | null;
  user_name: string | null;
  target_id: string;
  target_name: string;
  target_roles: string;
  attribution: string | null;
  category: string | null;
  difficulty: number;
  polity: string | null;
  region: string | null;
  world_era: string | null;
  mode: string;
  pronoun: string;
  turns_total: number;
  turns_left: number;
  turns_used: number;
  asks: number;
  status: string;
  started_at: number;
  ended_at: number | null;
  updated_at: number;
  /** 对战局才有（Node v5 / D1 v8 迁移之后的列；老行是 undefined） */
  room_id?: string | null;
  finish_rank?: number | null;
  /** 挑战局才有（Node v12 / D1 v15 迁移之后的列） */
  challenge_code?: string | null;
  player_ip?: string | null;
}

export interface TurnRow {
  game_id: string;
  seq: number;
  question: string;
  verdict: string;
  text: string;
  hint: string | null;
  invalid: string | null;
  failed: number;
  hit: number;
  basis: string | null;
  calls: number;
  ms: number;
  asked_at: number;
}

/** 结局判定：次数用尽算输，还有余量就揭晓算主动放弃 */
export function resultOf(status: string, turnsLeft: number): GameResult {
  if (status === 'won') return 'won';
  if (status === 'revealed') return turnsLeft > 0 ? 'abandoned' : 'lost';
  return 'playing';
}

export function rowToSummary(r: GameRow): HistorySummary {
  const result = resultOf(r.status, r.turns_left);
  const finished = result !== 'playing';
  const summary: HistorySummary = {
    id: r.id,
    status: r.status as SessionStatus,
    result,
    category: (r.category ?? 'character') as HistorySummary['category'],
    difficulty: r.difficulty,
    mode: r.mode as AnswerMode,
    polity: r.polity,
    region: (r.region as Region | null) ?? null,
    worldEra: r.world_era,
    turnsTotal: r.turns_total,
    turnsUsed: r.turns_used,
    turnsLeft: r.turns_left,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    userName: r.user_name,
    owner: r.attribution === 'user' ? 'user' : r.attribution === 'guest' ? 'guest' : 'unknown',
    // 进行中的局不给目标名：与对局接口一致，不给扒答案的口子
    target: finished
      ? { name: r.target_name, polity: r.polity ?? '', roles: safeRoles(r.target_roles) }
      : null,
  };
  // 对战局的标记：前端据此显示"对战 · 第 N 名"，而不是让人困惑的"放弃"
  if (r.room_id) summary.roomId = r.room_id;
  if (typeof r.finish_rank === 'number') summary.finishRank = r.finish_rank;
  if (r.challenge_code) summary.challengeCode = r.challenge_code;
  if (r.player_ip) summary.playerIp = r.player_ip;
  return summary;
}

function safeRoles(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function rowToDetail(r: GameRow, turns: TurnRow[]): HistoryDetail {
  return { ...rowToSummary(r), userId: r.user_id, turns: turns.map(rowToTurn) };
}

export function rowToTurn(t: TurnRow): HistoryTurn {
  const turn: HistoryTurn = {
    seq: t.seq,
    question: t.question,
    verdict: t.verdict as HistoryTurn['verdict'],
    text: t.text,
  };
  if (t.hint) turn.hint = t.hint;
  if (t.invalid) turn.invalid = t.invalid as 'format';
  if (t.failed) turn.failed = true;
  return turn;
}

/* ---------------- 写库参数：Node 与 D1 共用 ---------------- */

export function gameParams(session: SoloSession, target: TargetSnapshot): unknown[] {
  const used = session.history.filter((r) => !r.transient && !r.invalid).length;
  return [
    session.id,
    session.userId ?? null,
    session.userName ?? null,
    session.targetId,
    target.name,
    JSON.stringify(target.roles),
    // 归属来源：开局时就知道玩家有没有登录，落库时一次定死
    session.userId ? 'user' : 'guest',
    target.category,
    session.difficulty,
    session.polity,
    session.region,
    session.worldEra,
    session.mode,
    session.pronoun,
    // 已扣掉的次数 + 现余额；首次写入即总轮次，后续 upsert 不覆盖该列
    used + session.turnsLeft,
    session.turnsLeft,
    used,
    session.history.length,
    session.status,
    session.createdAt,
    session.status === 'playing' ? null : session.updatedAt,
    session.updatedAt,
    // 挑战局审计：挑战码与玩家 IP 只在首次写入，后续 upsert 不覆盖
    session.challengeCode ?? null,
    session.playerIp ?? null,
  ];
}

export const UPSERT_GAME_SQL = `INSERT INTO games (
    id, user_id, user_name, target_id, target_name, target_roles, attribution, category, difficulty, polity, region, world_era,
    mode, pronoun, turns_total, turns_left, turns_used, asks, status, started_at, ended_at, updated_at,
    challenge_code, player_ip
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET
    user_id    = COALESCE(games.user_id, excluded.user_id),
    user_name  = COALESCE(games.user_name, excluded.user_name),
    attribution = excluded.attribution,
    turns_left = excluded.turns_left,
    turns_used = excluded.turns_used,
    asks       = excluded.asks,
    status     = excluded.status,
    ended_at   = COALESCE(games.ended_at, excluded.ended_at),
    updated_at = excluded.updated_at`;

export const INSERT_TURN_SQL = `INSERT INTO game_turns (
    game_id, seq, question, verdict, text, hint, invalid, failed, hit, basis, calls, ms, asked_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(game_id, seq) DO UPDATE SET
    question = excluded.question,
    verdict  = excluded.verdict,
    text     = excluded.text,
    hint     = excluded.hint,
    invalid  = excluded.invalid,
    failed   = excluded.failed,
    hit      = excluded.hit,
    basis    = excluded.basis,
    calls    = excluded.calls,
    ms       = excluded.ms`;

export function turnParams(gameId: string, record: AnswerRecord): unknown[] {
  return [
    gameId,
    record.seq,
    record.question,
    record.verdict,
    record.text,
    record.hint ?? null,
    record.invalid ?? null,
    record.transient ? 1 : 0,
    record.hit ? 1 : 0,
    record.basis ?? null,
    record.calls ?? 0,
    record.ms ?? 0,
    Date.now(),
  ];
}

/** 查询条件的 SQL 片段：两端共用，避免列表语义漂移 */
export function whereClause(query: HistoryQuery = {}): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];

  if (query.userId === 'guest') {
    parts.push('user_id IS NULL');
  } else if (query.userId) {
    parts.push('user_id = ?');
    params.push(query.userId);
  }
  if (query.userName) {
    parts.push("IFNULL(user_name, '') LIKE ?");
    params.push(`%${query.userName}%`);
  }
  if (query.challengeCode) {
    parts.push('challenge_code = ?');
    params.push(query.challengeCode);
  }
  if (query.result === 'playing') {
    parts.push("status = 'playing'");
  } else if (query.result === 'won') {
    parts.push("status = 'won'");
  } else if (query.result === 'lost') {
    parts.push("status = 'revealed' AND turns_left = 0");
  } else if (query.result === 'abandoned') {
    parts.push("status = 'revealed' AND turns_left > 0");
  }
  if (query.q) {
    parts.push('(target_name LIKE ? OR IFNULL(user_name, \'\') LIKE ?)');
    params.push(`%${query.q}%`, `%${query.q}%`);
  }

  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', params };
}

export function clampLimit(limit: unknown): number {
  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.round(n));
}

export function clampOffset(offset: unknown): number {
  const n = Number(offset);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n);
}

/* ---------------- Node / SQLite 实现 ---------------- */

export class SqliteHistoryStore implements HistoryStore, GameRecorder {
  private readonly db: SqliteLike;

  constructor(db: SqliteLike) {
    this.db = db;
  }

  start(session: SoloSession, target: TargetSnapshot): void {
    this.upsert(session, target);
  }

  turn(session: SoloSession, target: TargetSnapshot, record: AnswerRecord): void {
    this.db.prepare(INSERT_TURN_SQL).run(...(turnParams(session.id, record) as never[]));
    this.upsert(session, target);
  }

  sync(session: SoloSession, target: TargetSnapshot): void {
    this.upsert(session, target);
  }

  private upsert(session: SoloSession, target: TargetSnapshot): void {
    this.db.prepare(UPSERT_GAME_SQL).run(...(gameParams(session, target) as never[]));
  }

  list(query: HistoryQuery = {}): HistoryListRes {
    const where = whereClause(query);
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const total = this.db
      .prepare(`SELECT COUNT(*) AS n FROM games ${where.sql}`)
      .get(...(where.params as never[])) as { n?: number } | undefined;
    const rows = this.db
      .prepare(`SELECT * FROM games ${where.sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .all(...(where.params as never[]), limit, offset) as unknown as GameRow[];
    return { total: total?.n ?? 0, items: rows.map(rowToSummary) };
  }

  get(id: string): HistoryDetail | null {
    const row = this.db.prepare('SELECT * FROM games WHERE id = ?').get(id) as unknown as
      | GameRow
      | undefined;
    if (!row) return null;
    const turns = this.db
      .prepare('SELECT * FROM game_turns WHERE game_id = ? ORDER BY seq ASC')
      .all(id) as unknown as TurnRow[];
    return rowToDetail(row, turns);
  }

  /** 玩家删除自己的一条历史（也删掉翻牌记录） */
  remove(id: string): void {
    this.db.prepare('DELETE FROM game_turns WHERE game_id = ?').run(id);
    this.db.prepare('DELETE FROM games WHERE id = ?').run(id);
  }
}
