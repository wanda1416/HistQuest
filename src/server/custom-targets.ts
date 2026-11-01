import type { DatabaseSync } from 'node:sqlite';
import { validateCustomTarget, type CustomStatus, type CustomTarget, type CustomTargetInput } from '../shared/custom-targets.ts';

/**
 * 自定义题库：用户级条目，不进全局 targets 表。
 * draft（草稿，自己可见）→ submitted（待审）→ approved（已复制入全局）/ rejected（驳回）
 * 审核通过时由管理员侧复制到 targets 表，custom_targets 行保留供用户追溯。
 * 类型与校验在 src/shared/custom-targets.ts（Workers 端复用）；这里只做 SQLite 存取。
 */

export {
  validateCustomTarget as validate,
  newGlobalCustomId as newGlobalId,
  customToCharacter as toCharacter,
} from '../shared/custom-targets.ts';
export type { CustomStatus, CustomTarget, CustomTargetInput } from '../shared/custom-targets.ts';

interface Row {
  id: string; user_id: string; category: string; name: string;
  aliases: string; summary: string;
  region: string; polity: string; world_era: string | null;
  gender: string; birth: number | null; death: number | null; birthplace: string | null;
  difficulty: number;
  status: string; review_note: string | null;
  created_at: number; updated_at: number;
}

function rowToTarget(r: Row): CustomTarget {
  let aliases: string[] = [];
  try { aliases = JSON.parse(r.aliases) as string[]; } catch { /* ignore */ }
  return {
    id: r.id, userId: r.user_id, category: r.category as CustomTarget['category'],
    name: r.name, aliases, summary: r.summary,
    region: r.region as CustomTarget['region'], polity: r.polity, worldEra: r.world_era,
    gender: r.gender, birth: r.birth, death: r.death, birthplace: r.birthplace,
    difficulty: r.difficulty,
    status: r.status as CustomStatus, reviewNote: r.review_note,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createCustomTargetStore(db: DatabaseSync) {
  return {
    listByUser(userId: string): CustomTarget[] {
      return (db.prepare('SELECT * FROM custom_targets WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as unknown as Row[]).map(rowToTarget);
    },
    /** 管理员审核队列：status = submitted */
    listSubmitted(): CustomTarget[] {
      return (db.prepare("SELECT * FROM custom_targets WHERE status = 'submitted' ORDER BY updated_at ASC").all() as unknown as Row[]).map(rowToTarget);
    },
    get(id: string, userId: string): CustomTarget | null {
      const r = db.prepare('SELECT * FROM custom_targets WHERE id = ? AND user_id = ?').get(id, userId) as unknown as Row | undefined;
      return r ? rowToTarget(r) : null;
    },
    getById(id: string): CustomTarget | null {
      const r = db.prepare('SELECT * FROM custom_targets WHERE id = ?').get(id) as unknown as Row | undefined;
      return r ? rowToTarget(r) : null;
    },
    insert(t: CustomTarget): void {
      db.prepare(
        `INSERT INTO custom_targets (id, user_id, category, name, aliases, summary, region, polity, world_era, gender, birth, death, birthplace, difficulty, status, review_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(t.id, t.userId, t.category, t.name, JSON.stringify(t.aliases), t.summary,
        t.region, t.polity, t.worldEra, t.gender, t.birth, t.death, t.birthplace,
        t.difficulty, t.status, t.reviewNote, t.createdAt, t.updatedAt);
    },
    updateDraft(id: string, userId: string, t: CustomTargetInput): void {
      const now = Date.now();
      db.prepare(
        `UPDATE custom_targets SET category = ?, name = ?, aliases = ?, summary = ?, region = ?, polity = ?, world_era = ?, gender = ?, birth = ?, death = ?, birthplace = ?, difficulty = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'draft'`,
      ).run(t.category, t.name, JSON.stringify(t.aliases), t.summary, t.region, t.polity, t.worldEra,
        t.gender, t.birth, t.death, t.birthplace, t.difficulty, now, id, userId);
    },
    remove(id: string, userId: string): void {
      db.prepare("DELETE FROM custom_targets WHERE id = ? AND user_id = ? AND status IN ('draft','rejected')").run(id, userId);
    },
    setStatus(id: string, userId: string, status: CustomStatus): void {
      db.prepare('UPDATE custom_targets SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, Date.now(), id, userId);
    },
    /** 管理员审核：approved/rejected；仅 submitted 状态可审 */
    review(id: string, status: 'approved' | 'rejected', note: string | null): CustomTarget | null {
      const r = db.prepare('SELECT * FROM custom_targets WHERE id = ? AND status = ?').get(id, 'submitted') as unknown as Row | undefined;
      if (!r) return null;
      db.prepare('UPDATE custom_targets SET status = ?, review_note = ?, updated_at = ? WHERE id = ?').run(status, note, Date.now(), id);
      return rowToTarget({ ...r, status, review_note: note });
    },
    validate: validateCustomTarget,
  };
}

export type CustomTargetStore = ReturnType<typeof createCustomTargetStore>;
