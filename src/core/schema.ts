import { DYNASTIES, REGIONS, WORLD_ERAS, isTargetCategory, type Character, type Region } from '../shared/domain.ts';

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
  'region',
  'polity',
  'polityAlt',
  'worldEra',
  'gender',
  'birth',
  'death',
  'birthplace',
  'country',
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
const REGION_SET = new Set<string>(REGIONS);
const ERA_SET = new Set<string>(WORLD_ERAS);
const GENDERS = new Set(['male', 'female']);
// 连字符允许：事件/物品种子的 id 形如 ev-cn-001（类别-区域-编号）
const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const NAME_MIN = 2;
const NAME_MAX = 8;

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
  const alt = strList(o.polityAlt ?? o.dynastyAlt);
  const externalId = str(o.externalId);
  const difficulty = Number(o.difficulty);
  const region = str(o.region);
  const country = str(o.country);
  const worldEra = str(o.worldEra);
  const regime = str(o.regime);
  const category = isTargetCategory(o.category) ? o.category : 'character';

  return {
    id: str(o.id),
    ...(category !== 'character' ? { category } : {}),
    name: str(o.name),
    aliases,
    // 旧数据只有 dynasty 字段：迁移期自动落到中国区
    region: (REGIONS as readonly string[]).includes(region) ? (region as Character['region']) : 'cn',
    polity: str(o.polity) || str(o.dynasty),
    // 空数组不写入：否则序列化会把所有没有分期的人物行都改一遍
    ...(alt.length ? { polityAlt: alt } : {}),
    ...(worldEra ? { worldEra: worldEra as Character['worldEra'] } : {}),
    // 世界条目原政权名（era 合并后从主字段降级至此）
    ...(regime ? { regime } : {}),
    gender: str(o.gender) as Character['gender'],
    birth: year(o.birth),
    death: year(o.death),
    birthplace: str(o.birthplace) || null,
    ...(country ? { country } : {}),
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
  // 类别语义：人物专用规则（性别/皇帝/卒年）只对 character 生效
  const category = c.category ?? 'character';
  const isCharacter = category === 'character';
  const err = (field: string, code: string, message: string): void => {
    issues.push({ level: 'error', field, code, message });
  };
  const warn = (field: string, code: string, message: string): void => {
    issues.push({ level: 'warning', field, code, message });
  };

  /* ---------------- 标识 ---------------- */
  if (!c.id) err('id', 'id_empty', 'id 不能为空');
  else if (!ID_RE.test(c.id)) err('id', 'id_format', 'id 需为 2–32 位小写字母、数字、下划线或连字符，并以字母开头');
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
    const hasSpace = /\s/.test(alias);
    if (len < 2) {
      err('aliases', 'alias_too_short', `别名「${alias}」不足 2 字：会命中大量无关猜名，解说也会被整段丢弃`);
    }
    // 西文名天然带空格且较长，这两项只对中文别名（中国区）有意义
    if (!hasSpace && len > 12) warn('aliases', 'alias_too_long', `别名「${alias}」超过 12 字，可能不是常用称呼`);
    if (hasSpace && c.region === 'cn') {
      warn('aliases', 'alias_space', `别名「${alias}」含空白字符`);
    }
    if (alias === c.name) err('aliases', 'alias_same_as_name', `别名「${alias}」与姓名重复`);

    const owner = opts.others.find((o) => o.name === alias || o.aliases.includes(alias));
    if (owner && owner.name !== alias) {
      warn('aliases', 'alias_conflict', `别名「${alias}」与「${owner.name}」重名，猜名会同时命中两人`);
    } else if (owner) {
      warn('aliases', 'alias_conflict', `别名「${alias}」与「${owner.name}」的姓名相同，猜名会同时命中两人`);
    }
  }

  /* ---------------- 归属（中国区是唯一被索引强制裁定的维度） ---------------- */
  if (!REGION_SET.has(c.region)) {
    err('region', 'region_unknown', `文明圈「${c.region || '空'}」不在受控枚举内`);
  }

  if (c.region === 'cn') {
    if (!DYNASTY_SET.has(c.polity)) {
      err(
        'polity',
        'polity_unknown',
        `朝代「${c.polity || '空'}」不在受控枚举内：所有「他是 X 朝人吗」都会绕过索引，可能答得与揭晓卡矛盾`,
      );
    }
    for (const alt of c.polityAlt ?? []) {
      if (!DYNASTY_SET.has(alt)) err('polityAlt', 'polity_alt_unknown', `分期「${alt}」不在受控枚举内`);
      if (alt === c.polity) warn('polityAlt', 'polity_alt_self', `分期与主朝代相同（「${alt}」），属于冗余`);
    }
    // 卒于三国建立（220 年）之前的东汉人物不得标注三国；蔡文姬卒年 249，允许同时标注
    if (
      c.polity === '东汉' &&
      (c.polityAlt ?? []).includes('三国') &&
      c.death !== null &&
      c.death <= 220
    ) {
      err(
        'polityAlt',
        'polity_alt_three_kingdoms',
        '按严格史学分期，卒于 220 年前的东汉人物不能标注三国（曹操、关羽、周瑜均属此例）',
      );
    }
    if (c.worldEra) warn('worldEra', 'world_era_on_cn', '中国人物不需要世界时期字段');
  } else {
    // 世界区不做政权硬裁定：只要求非空，避免词表不全卡住录入
    if (!c.polity) err('polity', 'polity_empty', '世界人物必须填写所属政权/国家');
    if (!c.country) warn('country', 'country_missing', '世界人物建议填写今属国家：资料卡会多一条校对信息');
    if (!c.worldEra) {
      warn('worldEra', 'world_era_missing', '未划分时期：单选「世界」时无法按时期筛选');
    } else if (!ERA_SET.has(c.worldEra)) {
      err('worldEra', 'world_era_unknown', `时期「${c.worldEra}」不在受控枚举内`);
    }
  }

  /* ---------------- 性别 / 君主（人物专用；事件/物品的占位值不校验） ---------------- */
  if (isCharacter && !GENDERS.has(c.gender)) err('gender', 'gender_invalid', '性别只能是 male（男）或 female（女）');

  // 身份与「是否君主」的一致性只对中国区提示：世界区有国王、法老、苏丹等不同称谓
  if (isCharacter && c.region === 'cn') {
    const roleEmperor = c.roles.includes('皇帝');
    if (c.emperor !== roleEmperor) {
      warn(
        'emperor',
        'emperor_role_mismatch',
        c.emperor ? '标记为皇帝，但身份里没有「皇帝」' : '身份里含「皇帝」，但未标记为皇帝',
      );
    }
  }

  /* ---------------- 时地（语义随类别：生卒/发生时间/制造年代） ---------------- */
  if (c.birth !== null && !Number.isInteger(c.birth)) {
    err('birth', 'birth_invalid', isCharacter ? '生年必须是整数（公元前用负数），或留空' : '年份必须是整数（公元前用负数）');
  }
  if (c.death !== null && !Number.isInteger(c.death)) err('death', 'death_invalid', '卒年必须是整数（公元前用负数），或留空');
  if (isCharacter && c.birth !== null && c.death !== null && c.birth >= c.death) {
    err('death', 'death_before_birth', `卒年（${c.death}）必须晚于生年（${c.birth}）`);
  }
  if (isCharacter) {
    if (c.birth === null) warn('birth', 'birth_missing', '生年未填：生卒资料卡会缺一项，模型只能凭自身知识判断');
    if (c.death === null) warn('death', 'death_missing', '卒年未填：生卒资料卡会缺一项，模型只能凭自身知识判断');
  } else if (category === 'event' && c.birth === null) {
    // 事件的年份是核心可判定维度（「发生在 X 朝之前吗」走确定性裁定）
    err('birth', 'birth_required_event', '事件必须填写发生年份：年份是事件最重要的可判定维度');
  }

  /* ---------------- 时地地点（籍贯 / 发生地 / 出土地） ---------------- */
  if (!c.birthplace) {
    const word = isCharacter ? '籍贯' : category === 'item' && c.birthplace !== '传世' ? '出土地' : '地点';
    warn('birthplace', 'birthplace_missing', `${word}未填：资料卡缺此项，模型只能凭自身知识判断`);
  }
  if (c.region === 'cn' && c.birthplace && !c.birthProvince) {
    warn('birthProvince', 'province_missing', '有地点但缺省份，筛选项和省级问法都会受影响');
  }

  /* ---------------- 身份 / 标签 / 事迹 ---------------- */
  if (!c.roles.length) err('roles', 'roles_empty', (isCharacter ? '身份' : '类型') + '不能为空：资料卡会缺少最重要的识别锚点');
  for (const role of c.roles) {
    if (charLen(role) < 2) warn('roles', 'role_too_short', `身份「${role}」只有 1 个字，容易与其他身份词混淆`);
  }

  if (!c.tags.length) warn('tags', 'tags_empty', '标签为空：资料卡会少一组关键词');
  for (const tag of c.tags) {
    if (/\s/.test(tag)) warn('tags', 'tag_space', `标签「${tag}」含空白字符`);
  }

  if (!c.notable) err('notable', 'notable_empty', (isCharacter ? '代表事迹' : category === 'event' ? '经过与结果' : '简介') + '不能为空：它是资料卡与揭晓卡的主要内容');

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
export function serializeTargets(list: Character[]): string {
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

/** 从现有数据聚合下拉选项：身份/类型词与省份不设硬编码表，跟着数据长 */
export function collectVocab(list: Character[]): {
  roles: string[];
  provinces: string[];
  polities: string[];
  /** 各类别的类型词（人物=身份；事件=战役/条约…；物品=青铜器/书画…） */
  types: Record<'character' | 'event' | 'item', string[]>;
  /** 世界时期按文明圈分组（管理后台递进筛选：选了文明圈才列对应时期） */
  worldErasByRegion: Partial<Record<Region, string[]>>;
} {
  const roles = new Set<string>();
  const provinces = new Set<string>();
  const polities = new Set<string>();
  const erasByRegion = new Map<Region, Set<string>>();
  const types: Record<'character' | 'event' | 'item', Set<string>> = {
    character: new Set(),
    event: new Set(),
    item: new Set(),
  };
  for (const c of list) {
    const cat = c.category ?? 'character';
    for (const role of c.roles) {
      roles.add(role);
      types[cat].add(role);
    }
    if (c.birthProvince) provinces.add(c.birthProvince);
    // 中国朝代由 DYNASTIES 提供，这里只收集世界政权建议值
    if (c.region !== 'cn' && c.polity) polities.add(c.polity);
    // 世界时期按文明圈归组（中国区无 worldEra，跳过）
    if (c.region !== 'cn' && c.worldEra) {
      const set = erasByRegion.get(c.region) ?? new Set<string>();
      set.add(c.worldEra);
      erasByRegion.set(c.region, set);
    }
  }
  const byLocale = (a: string, b: string): number => a.localeCompare(b, 'zh');
  const worldErasByRegion: Partial<Record<Region, string[]>> = {};
  for (const [region, set] of erasByRegion) {
    worldErasByRegion[region] = [...set].sort(byLocale);
  }
  return {
    roles: [...roles].sort(byLocale),
    provinces: [...provinces].sort(byLocale),
    polities: [...polities].sort(byLocale),
    types: {
      character: [...types.character].sort(byLocale),
      event: [...types.event].sort(byLocale),
      item: [...types.item].sort(byLocale),
    },
    worldErasByRegion,
  };
}

/** 给前端展示用：性别中文名 */
export function genderLabel(gender: string): string {
  return GENDER_LABEL[gender] ?? gender;
}

/**
 * 谜底写入/读取共用的时期与事实拆分。
 *
 * era 统一存"处于什么时期"：中国=朝代（受控枚举，索引裁定锚点），
 * 世界=时期（受控枚举，筛选锚点）；原政权名（佛罗伦萨/大不列颠王国…）
 * 降级为 facts.regime 备查——判定靠模型，不依赖它。
 * 人物专用便利字段（性别/皇帝/籍贯/省份/现藏）同样折叠进 facts。
 */
export function targetEraFacts(c: Character): {
  era: string;
  regime: string | null;
  facts: Record<string, unknown>;
} {
  const isCn = c.region === 'cn';
  const era = isCn ? c.polity : (c.worldEra ?? c.polity);
  const regime = c.regime ?? (!isCn && c.worldEra && c.worldEra !== c.polity ? c.polity : null);
  const facts: Record<string, unknown> = {
    gender: c.gender ?? 'male',
    emperor: c.emperor ? true : undefined,
    birthplace: c.birthplace ?? undefined,
    province: c.birthProvince ?? undefined,
    country: c.country ?? undefined,
    ...(regime ? { regime } : {}),
  };
  for (const k of Object.keys(facts)) if (facts[k] === undefined) delete facts[k];
  return { era, regime, facts };
}

/** 健康报告的分布矩阵：按可选类别过滤（'all'=全部），Node/D1 两端共用 */
export function buildHealthMatrices(list: Character[]): {
  matrix: Array<{ polity: string; levels: Record<string, number>; total: number }>;
  regionMatrix: Array<{ region: string; levels: Record<string, number>; total: number }>;
  worldEraMatrix: Array<{ era: string; levels: Record<string, number>; total: number }>;
} {
  const active = list.filter((c) => !c.retired);
  const matrix = DYNASTIES.map((polity) => {
    const levels: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
    let total = 0;
    for (const c of active.filter((x) => x.region === 'cn' && x.polity === polity)) {
      levels[String(c.difficulty)] += 1;
      total += 1;
    }
    return { polity, levels, total };
  });
  const regionMatrix = REGIONS.map((region) => {
    const levels: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
    let total = 0;
    for (const c of active.filter((x) => x.region === region)) {
      levels[String(c.difficulty)] += 1;
      total += 1;
    }
    return { region, levels, total };
  });
  const worldEraMatrix = WORLD_ERAS.map((era) => {
    const levels: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
    let total = 0;
    for (const c of active.filter((x) => x.region !== 'cn' && x.worldEra === era)) {
      levels[String(c.difficulty)] += 1;
      total += 1;
    }
    return { era, levels, total };
  });
  return { matrix, regionMatrix, worldEraMatrix };
}
