import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AnswerMode, AnswerRecord, PronounStyle, SoloSession } from '../shared/domain.ts';

/**
 * 对局会话的持久化。
 *
 * 三种实现共用一套接口：
 * - Sqlite：生产默认，单条 upsert，不再每次全量重写
 * - Json：兼容旧数据与测试
 * - Memory：测试或关闭持久化
 */

export interface SessionPersistence {
  load(): SoloSession[];
  save(session: SoloSession): void;
  flush(): void;
}

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class MemorySessionPersistence implements SessionPersistence {
  load(): SoloSession[] {
    return [];
  }
  save(): void {
    /* 无持久化 */
  }
  flush(): void {
    /* 无持久化 */
  }
}

export class JsonSessionPersistence implements SessionPersistence {
  private readonly file: string;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending: Map<string, SoloSession> | null = null;

  constructor(file: string) {
    this.file = file;
  }

  load(): SoloSession[] {
    if (!fs.existsSync(this.file)) return [];
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as SoloSession[];
      const now = Date.now();
      return raw.filter((s) => now - s.updatedAt < SESSION_TTL_MS);
    } catch {
      return [];
    }
  }

  save(session: SoloSession): void {
    if (!this.pending) this.pending = new Map();
    this.pending.set(session.id, session);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 200);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const map = this.pending;
    this.pending = null;

    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      // 旧文件里可能还有别的会话：读出来合并，避免覆盖
      const existing = new Map<string, SoloSession>();
      if (fs.existsSync(this.file)) {
        try {
          for (const s of JSON.parse(fs.readFileSync(this.file, 'utf8')) as SoloSession[]) {
            existing.set(s.id, s);
          }
        } catch {
          /* 损坏的旧文件直接丢弃 */
        }
      }
      for (const [id, s] of map) existing.set(id, s);
      fs.writeFileSync(this.file, JSON.stringify([...existing.values()]), 'utf8');
    } catch {
      /* 写盘失败交给下次重试 */
    }
  }
}

interface SessionRow {
  id: string;
  target_id: string;
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
}

export class SqliteSessionPersistence implements SessionPersistence {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  load(): SoloSession[] {
    const since = Date.now() - SESSION_TTL_MS;
    const rows = this.db
      .prepare('SELECT * FROM sessions WHERE updated_at >= ? ORDER BY updated_at DESC')
      .all(since) as unknown as SessionRow[];
    return rows.map(rowToSession);
  }

  save(session: SoloSession): void {
    this.db
      .prepare(
        `INSERT INTO sessions (
           id, target_id, difficulty, polity, region, world_era, cn_share,
           turns_left, total_turns, mode, pronoun, status, history, created_at, updated_at
         ) VALUES (?,?,?,?,?,?,?,?,? ,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           turns_left = excluded.turns_left,
           mode = excluded.mode,
           status = excluded.status,
           history = excluded.history,
           updated_at = excluded.updated_at`,
      )
      .run(
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
      );
  }

  flush(): void {
    /* 单条写入即时生效，无需 flush */
  }

  /** 清理过期会话，返回删除条数 */
  prune(before = Date.now() - SESSION_TTL_MS): number {
    const result = this.db.prepare('DELETE FROM sessions WHERE updated_at < ?').run(before);
    return Number(result.changes ?? 0);
  }
}

function rowToSession(r: SessionRow): SoloSession {
  return {
    id: r.id,
    targetId: r.target_id,
    difficulty: r.difficulty,
    polity: r.polity,
    region: r.region as SoloSession['region'],
    worldEra: r.world_era,
    cnShare: r.cn_share,
    turnsLeft: r.turns_left,
    mode: r.mode as AnswerMode,
    pronoun: r.pronoun as PronounStyle,
    status: r.status as SoloSession['status'],
    history: safeHistory(r.history),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function safeHistory(raw: string): AnswerRecord[] {
  try {
    return JSON.parse(raw) as AnswerRecord[];
  } catch {
    return [];
  }
}
