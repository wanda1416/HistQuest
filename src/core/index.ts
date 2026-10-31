import { DYNASTIES, CATEGORIES, REGION_LABELS, type Character, type Region, type TargetCategory } from '../shared/domain.ts';

/**
 * 朝代归一与分组。
 * 玩家问"他是宋朝人吗"，北宋/南宋都应命中；问"他是汉朝人吗"，西汉/东汉都应命中。
 */
const DYNASTY_GROUPS: Record<string, string[]> = {
  史前: ['史前'],
  商: ['商'],
  汉: ['西汉', '东汉'],
  两汉: ['西汉', '东汉'],
  晋: ['西晋', '东晋'],
  两晋: ['西晋', '东晋'],
  宋: ['北宋', '南宋'],
  两宋: ['北宋', '南宋'],
  // 辽/金/西夏/大理与宋是并存政权：保持互斥，不并入宋组（辽代条目问
  // 「它是宋朝的吗」必须答否）；单字「金」带朝代后缀匹配，避免误伤「金融」
  辽: ['辽'],
  金: ['金'],
  西夏: ['西夏'],
  大理: ['大理'],
  周: ['西周', '春秋', '战国'],
  先秦: ['商', '西周', '春秋', '战国'],
  五代: ['五代'],
  五代十国: ['五代'],
  南北朝: ['南北朝'],
  民国: ['近代'],
};

// 直接从领域枚举派生，避免两处维护导致漂移
const KNOWN_DYNASTIES = new Set<string>(DYNASTIES);

/** 把"唐朝 / 唐代 / 三国时期"归一为"唐 / 唐 / 三国"；无法识别返回 null */
export function normalizeDynasty(input: string): string | null {
  if (!input) return null;
  let s = String(input).trim().replace(/\s+/g, '');
  s = s.replace(/(时期|时代|年间|王朝|朝|代)+$/g, '');
  if (!s) return null;
  if (KNOWN_DYNASTIES.has(s)) return s;
  if (s in DYNASTY_GROUPS) return s;
  if (/^三国/.test(s)) return '三国';
  const withSuffix = s + '朝';
  if (KNOWN_DYNASTIES.has(withSuffix)) return withSuffix;
  return null;
}

export function dynastyScope(asked: string): string[] | null {
  const canon = normalizeDynasty(asked);
  if (!canon) return null;
  return DYNASTY_GROUPS[canon] ?? [canon];
}

/**
 * 难度配比：选 N 难度时按此权重在 1..N 各档间加权抽样。
 * 设计意图：高难度不等于"只出冷门题"，而是提高高难占比、保留低难保底，
 * 避免纯冷门池把题目难度推向不可玩。
 */
export const DIFFICULTY_MIX: Record<number, Record<number, number>> = {
  1: { 1: 10 },
  2: { 1: 4, 2: 6 },
  3: { 1: 2, 3: 5, 2: 3 },
};

/**
 * 按难度配比从池中加权抽一个。
 * 档位缺失（当前筛选范围里没有该难度的条目）时，其权重按比例摊给剩余档；
 * 全池都为空时返回 undefined（调用方自行兜底）。
 */
function pickByDifficulty(
  pool: Character[],
  difficulty: number,
  rng: () => number,
): Character[] {
  const mix = DIFFICULTY_MIX[difficulty] ?? { [difficulty]: 10 };
  const tiers = new Map<number, Character[]>();
  for (const c of pool) {
    const d = Math.min(3, Math.max(1, c.difficulty));
    const list = tiers.get(d) ?? [];
    list.push(c);
    tiers.set(d, list);
  }

  // 各档的实际权重：缺失档的权重按剩余档的原权重比例分摊
  const weights = new Map<number, number>();
  let missingWeight = 0;
  for (const [d, w] of Object.entries(mix)) {
    const lv = Number(d);
    if (tiers.has(lv)) weights.set(lv, w);
    else missingWeight += w;
  }
  const remaining = [...weights.keys()];
  if (remaining.length === 0) return []; // 整个池空
  if (missingWeight > 0 && remaining.length > 0) {
    const totalBase = remaining.reduce((s, d) => s + (weights.get(d) ?? 0), 0);
    if (totalBase > 0) {
      for (const d of remaining) {
        weights.set(d, (weights.get(d) ?? 0) + (missingWeight * (weights.get(d) ?? 0)) / totalBase);
      }
    }
  }

  // 加权抽档，再在档内均匀抽条目
  const totalWeight = remaining.reduce((s, d) => s + (weights.get(d) ?? 0), 0);
  let roll = rng() * totalWeight;
  for (const d of remaining) {
    roll -= weights.get(d) ?? 0;
    if (roll < 0) {
      const list = tiers.get(d)!;
      return list;
    }
  }
  return tiers.get(remaining[remaining.length - 1]!) ?? [];
}

export interface PickOptions {
  difficulty?: number | null;
  /** 谜底类别；'mixed' 在三类里均匀抽。缺省=人物（向后兼容） */
  category?: TargetCategory | 'mixed' | null;
  /** 玩家选中的中国朝代（唐/宋…）；指定后忽略 cnShare */
  polity?: string | null;
  /** 玩家选中的文明圈；指定后忽略 cnShare */
  region?: Region | null;
  /** 玩家选中的世界时期（仅世界模式） */
  worldEra?: string | null;
  /** 混合模式下中国人物占比（0–1），默认 0.5 */
  cnShare?: number;
  rng?: () => number;
}

export class CharacterIndex {
  readonly list: Character[];
  private byId = new Map<string, Character>();

  constructor(list: Character[]) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('人物索引为空');
    }
    // byId 收录全部（含软删除），保证在途对局还能揭晓；抽样池只用未下线的人物
    for (const c of list) this.byId.set(c.id, c);
    this.list = list.filter((c) => !c.retired);
    if (this.list.length === 0) {
      throw new Error('人物索引为空（全部已下线）');
    }
  }

  get size(): number {
    return this.list.length;
  }

  /** 各类别的在库数量（未下线），供开局页展示与禁用空类别 */
  categoryCounts(): Record<TargetCategory, number> {
    const out: Record<TargetCategory, number> = { character: 0, event: 0, item: 0 };
    for (const c of this.list) out[c.category ?? 'character'] += 1;
    return out;
  }

  get(id: string): Character | undefined {
    return this.byId.get(id);
  }

  /**
   * 抽样：先按政权/文明圈/难度筛选，再按 cnShare 加权。
   * 过滤器宁可放宽也不报空，但已限定的条件不会被放宽。
   */
  pick(opts: PickOptions = {}): Character {
    const rng = opts.rng ?? Math.random;

    // 0) 类别筛选：指定类别只在该类里抽；mixed 在有候选的类别间均匀抽。
    //    缺省=人物（老调用点与老数据兼容）。
    const want: TargetCategory | 'mixed' = opts.category ?? 'character';
    const byCategory = (cat: TargetCategory): Character[] =>
      this.list.filter((c) => (c.category ?? 'character') === cat);
    let pool: Character[];
    if (want === 'mixed') {
      const available = CATEGORIES.filter((cat) => byCategory(cat).length > 0);
      if (available.length === 0) pool = this.list;
      else pool = byCategory(available[Math.floor(rng() * available.length)]!);
    } else {
      pool = byCategory(want);
      // 所选类别没有条目时回退全量池，并在返回值上保留语义（与朝代回退一致）
      if (pool.length === 0) pool = this.list;
    }

    // 1) 政权筛选：中国朝代先按分组（宋=北京+南宋）匹配。
    //    只按主 polity 抽样——polityAlt（经历过的时期）是判定口径
    //    （耶律阿保机活过唐，问「他是唐朝人吗」答是），若进抽样池，
    //    玩家筛「唐」会抽到辽太祖，反而困惑。
    if (opts.polity) {
      const scope = dynastyScope(opts.polity);
      pool = scope
        ? pool.filter((c) => scope.includes(c.polity))
        : pool.filter((c) => c.polity === opts.polity);
    }

    // 2) 文明圈筛选
    if (opts.region) pool = pool.filter((c) => c.region === opts.region);

    // 3) 世界时期筛选（仅世界人物有该字段）
    if (opts.worldEra) pool = pool.filter((c) => c.worldEra === opts.worldEra);

    // 4) 已限定政权 / 文明圈 / 时期时，中国占比不再生效
    const limited = Boolean(opts.polity || opts.region || opts.worldEra);
    if (pool.length === 0) pool = this.list;

    // 3) 难度：**按难度配比加权抽样**，不是精确匹配——高难度不是"只抽高难度"，
    //    而是混入低难度保持手感，且比例随难度上移偏向高难：
    //    入门(1) → 全入门；进阶(2) → 入门:进阶 = 4:6；考据(3) → 入门:进阶:考据 = 2:3:5。
    //    某一档在当前筛选范围内缺失时，其配额按权重比例摊给其余档（不静默跳档）。
    //    加权抽档在 pickByDifficulty 内完成，candidates 已是"选中的那一档"。
    const tier = opts.difficulty ? pickByDifficulty(pool, opts.difficulty, rng) : pool;
    const candidates = tier.length > 0 ? tier : pool;
    // 5) 玩家已限定政权或文明圈时，中国占比不再生效
    if (limited) {
      return candidates[Math.floor(rng() * candidates.length)]!;
    }

    const cnShare = Math.min(1, Math.max(0, opts.cnShare ?? 0.5));
    const cn = candidates.filter((c) => c.region === 'cn');
    const world = candidates.filter((c) => c.region !== 'cn');
    if (cn.length === 0) return world[Math.floor(rng() * world.length)]!;
    if (world.length === 0) return cn[Math.floor(rng() * cn.length)]!;

    const target = rng() < cnShare ? cn : world;
    return target[Math.floor(rng() * target.length)]!;
  }

  /** 去名化：把人物名与所有别名替换为「该人物」，供任何需要交给模型的文本使用 */
  redact(text: string, c: Character): string {
    if (!text) return '';
    let out = text;
    const label = (c.category ?? 'character') === 'character' ? '该人物' : '该条目';
    const names = [c.name, ...c.aliases].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const n of names) out = out.split(n).join(label);
    return out;
  }

  /** 结构化事实表（已去名），用于揭晓卡与可选的取证判定 */
  evidence(c: Character): string {
    const rows: string[] = [];
    rows.push(`文明圈：${REGION_LABELS[c.region] ?? c.region}`);
    rows.push(`政权：${c.polity}`);
    rows.push(`性别：${c.gender === 'female' ? '女' : '男'}`);
    if (c.birth !== null || c.death !== null) {
      rows.push(`生卒：${fmtYear(c.birth)}—${fmtYear(c.death)}`);
    }
    if (c.birthplace) rows.push(`籍贯：${c.birthplace}`);
    if (c.roles.length) rows.push(`身份：${c.roles.join('、')}`);
    if (c.tags.length) rows.push(`标签：${c.tags.join('、')}`);
    rows.push(`事迹：${c.notable}`);
    return this.redact(rows.join('\n'), c);
  }

  /**
   * 带名称的资料卡：交给模型"用自己的知识作答"时用。
   * 名字是召回知识的锚点——没有名字，模型对冷门条目基本答不出来。
   * 泄题风险交给提示词约束 + 输出端过滤（见 answerer.guardLeak）。
   * 字段标签随类别变化：人物=生卒/籍贯/身份；事件=发生时间/地点/类型；
   * 物品=年代/出土地/现藏。
   */
  brief(c: Character): string {
    const cat = c.category ?? 'character';
    if (cat === 'event') {
      const rows: string[] = [`名称：${c.name}`];
      if (c.aliases.length) rows.push(`别称：${c.aliases.join('、')}`);
      rows.push(`文明圈：${REGION_LABELS[c.region] ?? c.region}`);
      rows.push(`时期：${c.polity}`);
      if (c.birth !== null) rows.push(`发生时间：${fmtYear(c.birth)}`);
      if (c.birthplace) rows.push(`地点：${c.birthplace}`);
      if (c.roles.length) rows.push(`类型：${c.roles.join('、')}`);
      if (c.tags.length) rows.push(`关键词：${c.tags.join('、')}`);
      rows.push(`经过与结果：${c.notable}`);
      return rows.join('\n');
    }
    if (cat === 'item') {
      const rows: string[] = [`名称：${c.name}`];
      if (c.aliases.length) rows.push(`别称：${c.aliases.join('、')}`);
      rows.push(`文明圈：${REGION_LABELS[c.region] ?? c.region}`);
      rows.push(`时期：${c.polity}`);
      if (c.birth !== null) rows.push(`制造年代：约${fmtYear(c.birth)}`);
      if (c.birthplace) rows.push(`出土地：${c.birthplace}`);
      if (c.country) rows.push(`现藏：${c.country}`);
      if (c.roles.length) rows.push(`类型：${c.roles.join('、')}`);
      if (c.tags.length) rows.push(`关键词：${c.tags.join('、')}`);
      rows.push(`简介：${c.notable}`);
      return rows.join('\n');
    }
    const rows: string[] = [`姓名：${c.name}`];
    if (c.aliases.length) rows.push(`别称：${c.aliases.join('、')}`);
    rows.push(`文明圈：${REGION_LABELS[c.region] ?? c.region}`);
    rows.push(
      `政权：${c.polity}${c.polityAlt?.length ? `（也活跃于 ${c.polityAlt.join('、')}）` : ''}`,
    );
    if (c.country) rows.push(`今属：${c.country}`);
    rows.push(`性别：${c.gender === 'female' ? '女' : '男'}`);
    if (c.birth !== null || c.death !== null) {
      rows.push(`生卒：${fmtYear(c.birth)}—${fmtYear(c.death)}`);
    }
    if (c.birthplace) rows.push(`籍贯：${c.birthplace}`);
    if (c.roles.length) rows.push(`身份：${c.roles.join('、')}`);
    if (c.tags.length) rows.push(`关键词：${c.tags.join('、')}`);
    rows.push(`事迹：${c.notable}`);
    return rows.join('\n');
  }
}

export function fmtYear(year: number | null): string {
  if (year === null || year === undefined) return '不详';
  return year < 0 ? `公元前${Math.abs(year)}年` : `${year}年`;
}

export function loadIndex(raw: Character[]): CharacterIndex {
  return new CharacterIndex(raw);
}
