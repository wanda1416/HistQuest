import { DYNASTIES, REGIONS, WORLD_ERAS, type Character, type Region, type WorldEra } from './domain.ts';

/**
 * 自定义题库的纯逻辑（类型 / 校验 / 全局条目转换）：
 * Node 服务端（src/server/custom-targets.ts 的 SQLite store）与
 * Workers 端（workers/bundle.ts 的 D1 直查）共用，禁止引入 Node 专属模块。
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

/** 提交/保存时的字段（不含服务端管理的字段） */
export type CustomTargetInput = Pick<
  CustomTarget,
  'category' | 'name' | 'aliases' | 'summary' | 'region' | 'polity' | 'worldEra' | 'gender' | 'birth' | 'death' | 'birthplace' | 'difficulty'
>;

/** 校验：返回错误列表（空数组 = 通过）。必填项与全局题库 validateCharacter 对齐。 */
export function validateCustomTarget(input: CustomTargetInput): string[] {
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
}

/** 审核通过 / 房主题库开局 → 全局 targets 的 Character 形状。id 由调用方传入。 */
export function customToCharacter(t: CustomTarget | CustomTargetInput, id: string): Character {
  const category = t.category;
  return {
    id,
    category,
    name: t.name,
    aliases: t.aliases,
    region: t.region,
    polity: t.polity,
    worldEra: t.region === 'cn' ? null : ((t.worldEra as WorldEra | null) ?? null),
    gender: category === 'character' ? (t.gender === 'female' ? 'female' : 'male') : 'male',
    birth: t.birth,
    death: t.death,
    birthplace: t.birthplace,
    birthProvince: null,
    country: t.region === 'cn' ? null : t.polity,
    roles: [category === 'character' ? '自定义' : category === 'event' ? '历史事件' : '历史物品'],
    tags: [],
    emperor: false,
    notable: t.summary,
    difficulty: t.difficulty,
  };
}

/** 生成符合 ID_RE 的全局 id（custom- 前缀 + 8 位十六进制；Web Crypto，Node ≥ 19 与 Workers 都有） */
export function newGlobalCustomId(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `custom-${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}
