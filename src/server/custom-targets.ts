import type { DatabaseSync } from 'node:sqlite';

/**
 * 自定义题库：用户级条目，不进全局 targets 表。
 * draft（草稿，自己可见）→ submitted（待审）→ approved（已复制入全局）/ rejected（驳回）
 * 审核通过时由管理员侧复制到 targets 表，custom_targets 行保留供用户追溯。
 */

export type CustomStatus = 'draft' | 'submitted' | 'approved' | 'rejected';

export interface CustomTarget {
  id: string;
  userId: string;
  category: 'character' | 'event' | 'item';
  name: string;
  aliases: string[];
  summary: string;
  difficulty: number;
  status: CustomStatus;
  reviewNote: string | null;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string; user_id: string; category: string; name: string;
  aliases: string; summary: string; difficulty: number;
  status: string; review_note: string | null;
  created_at: number; updated_at: number;
}

function rowToTarget(r: Row): CustomTarget {
  let aliases: string[] = [];
  try { aliases = JSON.parse(r.aliases) as string[]; } catch { /* ignore */ }
  return {
    id: r.id, userId: r.user_id, category: r.category as CustomTarget['category'],
    name: r.name, aliases, summary: r.summary, difficulty: r.difficulty,
    status: r.status as CustomStatus, reviewNote: r.review_note,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const esc = (s: string) => String(s ?? '').replace(/'/g, "''");

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
    insert(t: CustomTarget): void {
      db.prepare(
        `INSERT INTO custom_targets (id, user_id, category, name, aliases, summary, difficulty, status, review_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(t.id, t.userId, t.category, t.name, JSON.stringify(t.aliases), t.summary, t.difficulty, t.status, t.reviewNote, t.createdAt, t.updatedAt);
    },
    updateDraft(id: string, userId: string, fields: { name: string; aliases: string[]; summary: string; difficulty: number; category: string }): void {
      const now = Date.now();
      db.prepare(
        `UPDATE custom_targets SET name = ?, aliases = ?, summary = ?, difficulty = ?, category = ?, updated_at = ?
         WHERE id = ? AND user_id = ? AND status = 'draft'`,
      ).run(fields.name, JSON.stringify(fields.aliases), fields.summary, fields.difficulty, fields.category, now, id, userId);
    },
    remove(id: string, userId: string): void {
      db.prepare("DELETE FROM custom_targets WHERE id = ? AND user_id = ? AND status IN ('draft','rejected')").run(id, userId);
    },
    setStatus(id: string, userId: string, status: CustomStatus): void {
      db.prepare('UPDATE custom_targets SET status = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(status, Date.now(), id, userId);
    },
    /** 管理员审核：approved/rejected */
    review(id: string, status: 'approved' | 'rejected', note: string | null): CustomTarget | null {
      const r = db.prepare('SELECT * FROM custom_targets WHERE id = ? AND status = ?').get(id, 'submitted') as unknown as Row | undefined;
      if (!r) return null;
      db.prepare('UPDATE custom_targets SET status = ?, review_note = ?, updated_at = ? WHERE id = ?').run(status, note, Date.now(), id);
      return rowToTarget({ ...r, status, review_note: note });
    },
    /** 校验：名称 2–20 字、summary 20–100 字、difficulty 1–3、category 合法 */
    validate(input: { name: string; summary: string; difficulty: number; category: string }): string[] {
      const errs: string[] = [];
      const nLen = input.name?.trim().length ?? 0;
      if (nLen < 2 || nLen > 20) errs.push(`名称需 2–20 字，当前 ${nLen} 字`);
      const sLen = input.summary?.trim().length ?? 0;
      if (sLen < 20 || sLen > 200) errs.push(`描述需 20–200 字，当前 ${sLen} 字`);
      if (![1, 2, 3].includes(input.difficulty)) errs.push('难度须为 1/2/3');
      if (!['character', 'event', 'item'].includes(input.category)) errs.push('类别须为 character/event/item');
      return errs;
    },
  };
}

export type CustomTargetStore = ReturnType<typeof createCustomTargetStore>;
