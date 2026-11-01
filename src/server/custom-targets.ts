import { randomBytes } from 'node:crypto';
import { DYNASTIES, REGIONS, WORLD_ERAS, type Character, type Region, type WorldEra } from '../shared/domain.ts';

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
  region: Region;
  /** 中国区 = 朝代；世界区 = 政权/国家 */
  polity: string;
  worldEra: string | null;
  /** 仅人物有效：male / female；空串表示未填（事件/物品占位） */
  gender: string;
  birth: number | null;
  death: number | null;
  birthplace: string | null;
  difficulty: number;
  status: CustomStatus;
  reviewNote: string | null;
  createdAt: number;
  updatedAt: number;
}

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
    region: r.region as Region, polity: r.polity, worldEra: r.world_era,
    gender: r.gender, birth: r.birth, death: r.death, birthplace: r.birthplace,
    difficulty: r.difficulty,
    status: r.status as CustomStatus, reviewNote: r.review_note,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function createCustomTargetStore(db: import('node:sqlite').DatabaseSync) {
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
    updateDraft(id: string, userId: string, t: Omit<CustomTarget, 'id' | 'userId' | 'status' | 'reviewNote' | 'createdAt' | 'updatedAt'>): void {
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
    /** 校验：返回错误列表（空数组 = 通过）。规则与全局题库 validateCharacter 对齐的必填项。 */
    validate(input: Pick<CustomTarget, 'category' | 'name' | 'aliases' | 'summary' | 'region' | 'polity' | 'worldEra' | 'gender' | 'birth' | 'death' | 'difficulty'>): string[] {
      const errs: string[] = [];
      const nLen = input.name?.trim().length ?? 0;
      if (nLen < 2 || nLen > 20) errs.push(`名称需 2–20 字，当前 ${nLen} 字`);
      const sLen = input.summary?.trim().length ?? 0;
      if (sLen < 20 || sLen > 200) errs.push(`描述需 20–200 字，当前 ${sLen} 字`);
      if (![1, 2, 3].includes(input.difficulty)) errs.push('难度须为 1/2/3');
      if (!['character', 'event', 'item'].includes(input.category)) errs.push('类别须为 character/event/item');
      if (!(REGIONS as readonly string[]).includes(input.region)) errs.push('文明圈不在受控枚举内');
      if (input.region === 'cn') {
        if (!(DYNASTIES as readonly string[]).includes(input.polity)) errs.push('中国条目必须选择朝代');
      } else if (!input.polity.trim()) {
        errs.push('世界条目必须填写所属政权/国家');
      }
      if (input.worldEra && input.region !== 'cn' && !(WORLD_ERAS as readonly string[]).includes(input.worldEra)) {
        errs.push('时期不在受控枚举内');
      }
      if (input.category === 'character' && input.gender !== 'male' && input.gender !== 'female') {
        errs.push('人物必须选择性别');
      }
      if (input.category === 'event' && input.birth === null) errs.push('事件必须填写发生年份');
      if (input.birth !== null && !Number.isInteger(input.birth)) errs.push('年份必须是整数（公元前用负数），或留空');
      if (input.death !== null && !Number.isInteger(input.death)) errs.push('卒年必须是整数（公元前用负数），或留空');
      if (input.category === 'character' && input.birth !== null && input.death !== null && input.birth >= input.death) {
        errs.push('卒年必须晚于生年');
      }
      for (const alias of input.aliases) {
        if (!alias.trim()) errs.push('别名不能为空字符串');
        if (alias === input.name) errs.push(`别名「${alias}」与名称重复`);
      }
      return errs;
    },
  };
}

/** 审核通过 → 全局 targets 的 Character 形状。id 由调用方生成后传入。 */
export function toCharacter(t: CustomTarget, id: string): Character {
  return {
    id,
    category: t.category,
    name: t.name,
    aliases: t.aliases,
    region: t.region,
    polity: t.polity,
    worldEra: t.region === 'cn' ? null : ((t.worldEra as WorldEra | null) ?? null),
    gender: t.category === 'character' ? (t.gender === 'female' ? 'female' : 'male') : 'male',
    birth: t.birth,
    death: t.death,
    birthplace: t.birthplace,
    birthProvince: null,
    country: t.region === 'cn' ? null : t.polity,
    roles: [t.category === 'character' ? '自定义' : t.category === 'event' ? '历史事件' : '历史物品'],
    tags: [],
    emperor: false,
    notable: t.summary,
    difficulty: t.difficulty,
  };
}

/** 生成符合 ID_RE 的全局 id（custom- 前缀 + 8 位十六进制） */
export function newGlobalId(): string {
  return `custom-${randomBytes(4).toString('hex')}`;
}

export type CustomTargetStore = ReturnType<typeof createCustomTargetStore>;
