import type { D1Database } from './d1.ts';
import type { AnswerRecord, SoloSession } from '../src/shared/domain.ts';
import type { HistoryDetail, HistoryListRes } from '../src/shared/protocol.ts';
import {
  INSERT_TURN_SQL,
  UPSERT_GAME_SQL,
  clampLimit,
  clampOffset,
  gameParams,
  rowToDetail,
  rowToSummary,
  turnParams,
  whereClause,
  type GameRecorder,
  type GameRow,
  type HistoryQuery,
  type HistoryStore,
  type TargetSnapshot,
  type TurnRow,
} from '../src/server/history.ts';

/**
 * D1 版对局账本：与 Node 的 SqliteHistoryStore 共用同一份 SQL 与投影，
 * 保证两端「历史里看到的东西」逐字段一致。
 */
export class D1HistoryStore implements HistoryStore, GameRecorder {
  private readonly db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  async start(session: SoloSession, target: TargetSnapshot): Promise<void> {
    await this.upsert(session, target);
  }

  async turn(session: SoloSession, target: TargetSnapshot, record: AnswerRecord): Promise<void> {
    await this.db.prepare(INSERT_TURN_SQL).bind(...turnParams(session.id, record)).run();
    await this.upsert(session, target);
  }

  async sync(session: SoloSession, target: TargetSnapshot): Promise<void> {
    await this.upsert(session, target);
  }

  private async upsert(session: SoloSession, target: TargetSnapshot): Promise<void> {
    await this.db.prepare(UPSERT_GAME_SQL).bind(...gameParams(session, target)).run();
  }

  async list(query: HistoryQuery = {}): Promise<HistoryListRes> {
    const where = whereClause(query);
    const limit = clampLimit(query.limit);
    const offset = clampOffset(query.offset);
    const count = await this.db
      .prepare(`SELECT COUNT(*) AS n FROM games ${where.sql}`)
      .bind(...where.params)
      .first<{ n: number }>();
    const rows = await this.db
      .prepare(`SELECT * FROM games ${where.sql} ORDER BY started_at DESC LIMIT ? OFFSET ?`)
      .bind(...where.params, limit, offset)
      .all<GameRow>();
    return { total: count?.n ?? 0, items: rows.results.map(rowToSummary) };
  }

  async get(id: string): Promise<HistoryDetail | null> {
    const row = await this.db.prepare('SELECT * FROM games WHERE id = ?').bind(id).first<GameRow>();
    if (!row) return null;
    const turns = await this.db
      .prepare('SELECT * FROM game_turns WHERE game_id = ? ORDER BY seq ASC')
      .bind(id)
      .all<TurnRow>();
    return rowToDetail(row, turns.results);
  }
}
