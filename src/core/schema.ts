import { DYNASTIES, type Character } from '../shared/domain.ts';

/**
 * 人物数据的规范化、校验与序列化（纯函数，前后端共用）。
 *
 * 后台保存前必须过这里：任何 error 级问题都不允许写盘。
 * 定级依据是当前判定链路——索引只强制裁定「朝代」，其余字段作为资料卡喂给模型校对，
 * 所以朝代类问题会直接答错，资料缺失只会降低准确率。
 */

export type IssueLevel = 'error' | 'warning';

export interface Issue {
  level: IssueLevel;
  /** 对应 Character 的字段名 */
  field: string;
  code: string;
  message: string;
}

/** 写回文件时的字段顺序：一人一行、顺序稳定，diff 才不会被整体重排淹没 */
export const CHARACTER_KEY_ORDER: Array<keyof Character> = [
  'id',
  'name',
  'aliases',
  'dynasty',
  'dynastyAlt',
  'gender',
  'birth',
  'death',
  'birthplace',
  'birthProvince',
  'roles',
  'tags',
  'emperor',
  'notable',
  'difficulty',
  'externalId',
  'retired',
];

const DYNASTY_SET = new Set<string>(DYNASTIES);
const GENDERS = new Set(['male', 'female']);
const ID_RE = /^[a-z][a-z0-9_]{1,31}$/;
const NAME_MIN = 2;
const NAME_MAX = 5;

const GENDER_LABEL: Record<string, string> = { male: '男', female: '女' };

/** 按字符数计，避免代理对（生僻字）被算成两个字 */
export function charLen(value: unknown): number {
  return [...String(value ?? '')].length;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function strList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    const s = str(item);
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function year(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN;
}

function bool(value: unknown): boolean {
  return value === true || value === 'true' || value === 'on' || value === 1 || value === '1';
}

/** 把表单 / JSON 的松数据转成规范的 Character，不合法值保留原样交给校验发现 */
export function normalizeCharacter(raw: unknown): Character {
  const o = (raw ?? {}) as Record<string, unknown>;
  const aliases = strList(o.aliases);
  const alt = strList(o.dynastyAlt);
  const externalId = str(o.externalId);
  const difficulty = Number(o.difficulty);

  return {
    id: str(o.id),
    name: str(o.name),
    aliases,
    dynasty: str(o.dynasty),
    // 空数组不写入：否则序列化会把所有没有分期的人物行都改一遍
    ...(alt.length ? { dynastyAlt: alt } : {}),
    gender: str(o.gender) as Character['gender'],
    birth: year(o.birth),
    death: year(o.death),
    birthplace: str(o.birthplace) || null,
    birthProvince: str(o.birthProvince) || null,
    roles: strList(o.roles),
    tags: strList(o.tags),
    emperor: bool(o.emperor),
    notable: str(o.notable),
    difficulty: Number.isFinite(difficulty) ? difficulty : Number.NaN,
    ...(externalId ? { externalId } : {}),
    ...(o.retired === true ? { retired: true } : {}),
  };
}

export interface ValidateOptions {
  /** 库中其他人物（不含当前被校验者） */
  others: Character[];
}

export function validateCharacter(c: Character, opts: ValidateOptions): Issue[] {
  const issues: Issue[] = [];
  const err = (field: string, code: string, message: string): void => {
    issues.push({ level: 'error', field, code, message });
  };
  const warn = (field: string, code: string, message: string): void => {
    issues.push({ level: 'warning', field, code, message });
  };

  /* ---------------- 标识 ---------------- */
  if (!c.id) err('id', 'id_empty', 'id 不能为空');
  else if (!ID_RE.test(c.id)) err('id', 'id_format', 'id 需为 2–32 位小写字母、数字或下划线，并以字母开头');
  const idOwner = opts.others.find((o) => o.id === c.id);
  if (idOwner) err('id', 'id_duplicate', `id「${c.id}」已被「${idOwner.name}」占用`);

  /* ---------------- 姓名与别名 ---------------- */
  const nameLen = charLen(c.name);
  if (!c.name) err('name', 'name_empty', '姓名不能为空');
  else if (nameLen < NAME_MIN || nameLen > NAME_MAX) {
    err('name', 'name_length', `姓名需 ${NAME_MIN}–${NAME_MAX} 字，当前 ${nameLen} 字`);
  }

  const nameOwner = opts.others.find((o) => o.name === c.name);
  if (nameOwner) err('name', 'name_duplicate', `姓名与「${nameOwner.name}」重复`);
  const nameAsAlias = opts.others.find((o) => o.aliases.includes(c.name));
  if (nameAsAlias) {
    err('name', 'name_conflict', `姓名与「${nameAsAlias.name}」的别名重复，猜名会同时命中两人`);
  }

  for (const alias of c.aliases) {
    const len = charLen(alias);
    if (len < 2) {
      err('aliases', 'alias_too_short', `别名「${alias}」不足 2 字：会命中大量无关猜名，解说也会被整段丢弃`);
    }
    if (len > 12) warn('aliases', 'alias_too_long', `别名「${alias}」超过 12 字，可能不是常用称呼`);
    if (/\s/.test(alias)) err('aliases', 'alias_space', `别名「${alias}」含空白字符`);
    if (alias === c.name) err('aliases', 'alias_same_as_name', `别名「${alias}」与姓名重复`);

    const owner = opts.others.find((o) => o.name === alias || o.aliases.includes(alias));
    if (owner && owner.name !== alias) {
      warn('aliases', 'alias_conflict', `别名「${alias}」与「${owner.name}」重名，猜名会同时命中两人`);
    } else if (owner) {
      warn('aliases', 'alias_conflict', `别名「${alias}」与「${owner.name}」的姓名相同，猜名会同时命中两人`);
    }
  }

  /* ---------------- 朝代（唯一被索引强制裁定的维度） ---------------- */
  if (!DYNASTY_SET.has(c.dynasty)) {
    err(
      'dynasty',
      'dynasty_unknown',
      `朝代「${c.dynasty || '空'}」不在受控枚举内：所有「他是 X 朝人吗」都会绕过索引，可能答得与揭晓卡矛盾`,
    );
  }
  for (const alt of c.dynastyAlt ?? []) {
    if (!DYNASTY_SET.has(alt)) err('dynastyAlt', 'dynasty_alt_unknown', `分期「${alt}」不在受控枚举内`);
    if (alt === c.dynasty) warn('dynastyAlt', 'dynasty_alt_self', `分期与主朝代相同（「${alt}」），属于冗余`);
  }
  // 卒于三国建立（220 年）之前的东汉人物不得标注三国；蔡文姬卒年 249，允许同时标注
  if (
    c.dynasty === '东汉' &&
    (c.dynastyAlt ?? []).includes('三国') &&
    c.death !== null &&
    c.death <= 220
  ) {
    err(
      'dynastyAlt',
      'dynasty_alt_three_kingdoms',
      '按严格史学分期，卒于 220 年前的东汉人物不能标注三国（曹操、关羽、周瑜均属此例）',
    );
  }

  /* ---------------- 性别 / 皇帝 ---------------- */
  if (!GENDERS.has(c.gender)) err('gender', 'gender_invalid', '性别只能是 male（男）或 female（女）');

  const roleEmperor = c.roles.includes('皇帝');
  if (c.emperor !== roleEmperor) {
    warn(
      'emperor',
      'emperor_role_mismatch',
      c.emperor ? '标记为皇帝，但身份里没有「皇帝」' : '身份里含「皇帝」，但未标记为皇帝',
    );
  }

  /* ---------------- 生卒 ---------------- */
  if (c.birth !== null && !Number.isInteger(c.birth)) err('birth', 'birth_invalid', '生年必须是整数（公元前用负数），或留空');
  if (c.death !== null && !Number.isInteger(c.death)) err('death', 'death_invalid', '卒年必须是整数（公元前用负数），或留空');
  if (c.birth !== null && c.death !== null && c.birth >= c.death) {
    err('death', 'death_before_birth', `卒年（${c.death}）必须晚于生年（${c.birth}）`);
  }
  if (c.birth === null) warn('birth', 'birth_missing', '生年未填：生卒资料卡会缺一项，模型只能凭自身知识判断');
  if (c.death === null) warn('death', 'death_missing', '卒年未填：生卒资料卡会缺一项，模型只能凭自身知识判断');

  /* ---------------- 籍贯 ---------------- */
  if (!c.birthplace) warn('birthplace', 'birthplace_missing', '籍贯未填：资料卡缺此项，模型只能凭自身知识判断');
  if (c.birthplace && !c.birthProvince) {
    warn('birthProvince', 'province_missing', '有籍贯但缺省份，筛选项和省级问法都会受影响');
  }

  /* ---------------- 身份 / 标签 / 事迹 ---------------- */
  if (!c.roles.length) err('roles', 'roles_empty', '身份不能为空：资料卡会缺少最重要的识别锚点');
  for (const role of c.roles) {
    if (charLen(role) < 2) warn('roles', 'role_too_short', `身份「${role}」只有 1 个字，容易与其他身份词混淆`);
  }

  if (!c.tags.length) warn('tags', 'tags_empty', '标签为空：资料卡会少一组关键词');
  for (const tag of c.tags) {
    if (/\s/.test(tag)) warn('tags', 'tag_space', `标签「${tag}」含空白字符`);
  }

  if (!c.notable) err('notable', 'notable_empty', '代表事迹不能为空：它是资料卡与揭晓卡的主要内容');

  /* ---------------- 抽样与元数据 ---------------- */
  if (![1, 2, 3].includes(c.difficulty)) err('difficulty', 'difficulty_invalid', '难度只能是 1、2 或 3');
  if (c.externalId && !/^wikidata:Q\d+$/.test(c.externalId)) {
    warn('externalId', 'external_id_format', '外部 id 建议使用 wikidata:Q123 形式');
  }

  return issues;
}

/** 全库不变量：id 与姓名必须全局唯一 */
export function validateLibrary(list: Character[]): Issue[] {
  const issues: Issue[] = [];
  const ids = new Map<string, string>();
  const names = new Map<string, string>();

  for (const c of list) {
    const idPrev = ids.get(c.id);
    if (idPrev !== undefined) {
      issues.push({
        level: 'error',
        field: 'id',
        code: 'library_id_duplicate',
        message: `id「${c.id}」重复：${idPrev} 与 ${c.name}`,
      });
    } else {
      ids.set(c.id, c.name);
    }

    const namePrev = names.get(c.name);
    if (namePrev !== undefined) {
      issues.push({
        level: 'error',
        field: 'name',
        code: 'library_name_duplicate',
        message: `姓名「${c.name}」重复`,
      });
    } else {
      names.set(c.name, c.name);
    }
  }
  return issues;
}

/** 一人一行的紧凑 JSON，与 data/characters.json 的现有格式一致 */
export function serializeCharacters(list: Character[]): string {
  const rows = list.map((c) => {
    const ordered: Record<string, unknown> = {};
    for (const key of CHARACTER_KEY_ORDER) {
      const value = c[key];
      if (value !== undefined) ordered[key] = value;
    }
    return `  ${JSON.stringify(ordered)}`;
  });
  return `[\n${rows.join(',\n')}\n]\n`;
}

/** 从现有数据聚合下拉选项：身份词与省份不设硬编码表，跟着数据长 */
export function collectVocab(list: Character[]): { roles: string[]; provinces: string[] } {
  const roles = new Set<string>();
  const provinces = new Set<string>();
  for (const c of list) {
    for (const role of c.roles) roles.add(role);
    if (c.birthProvince) provinces.add(c.birthProvince);
  }
  const byLocale = (a: string, b: string): number => a.localeCompare(b, 'zh');
  return { roles: [...roles].sort(byLocale), provinces: [...provinces].sort(byLocale) };
}

/** 给前端展示用：性别中文名 */
export function genderLabel(gender: string): string {
  return GENDER_LABEL[gender] ?? gender;
}
