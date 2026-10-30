import { DYNASTIES, REGION_LABELS, type Character, type Region } from '../shared/domain.ts';

/**
 * 朝代归一与分组。
 * 玩家问"他是宋朝人吗"，北宋/南宋都应命中；问"他是汉朝人吗"，西汉/东汉都应命中。
 */
const DYNASTY_GROUPS: Record<string, string[]> = {
  汉: ['西汉', '东汉'],
  两汉: ['西汉', '东汉'],
  晋: ['西晋', '东晋'],
  两晋: ['西晋', '东晋'],
  宋: ['北宋', '南宋'],
  两宋: ['北宋', '南宋'],
  周: ['西周', '春秋', '战国'],
  先秦: ['春秋', '战国'],
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

export interface PickOptions {
  difficulty?: number | null;
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

  get(id: string): Character | undefined {
    return this.byId.get(id);
  }

  /**
   * 抽样：先按政权/文明圈/难度筛选，再按 cnShare 加权。
   * 过滤器宁可放宽也不报空，但已限定的条件不会被放宽。
   */
  pick(opts: PickOptions = {}): Character {
    const rng = opts.rng ?? Math.random;
    let pool = this.list;

    // 1) 政权筛选：中国朝代先按分组（宋=北京+南宋）匹配
    if (opts.polity) {
      const scope = dynastyScope(opts.polity);
      pool = scope
        ? pool.filter(
            (c) => scope.includes(c.polity) || (c.polityAlt ?? []).some((p) => scope.includes(p)),
          )
        : pool.filter((c) => c.polity === opts.polity);
    }

    // 2) 文明圈筛选
    if (opts.region) pool = pool.filter((c) => c.region === opts.region);

    // 3) 世界时期筛选（仅世界人物有该字段）
    if (opts.worldEra) pool = pool.filter((c) => c.worldEra === opts.worldEra);

    // 4) 已限定政权 / 文明圈 / 时期时，中国占比不再生效
    const limited = Boolean(opts.polity || opts.region || opts.worldEra);
    if (pool.length === 0) pool = this.list;

    // 3) 难度：先精确，池内无该难度时退回不区分难度
    const exact = opts.difficulty ? pool.filter((c) => c.difficulty === opts.difficulty) : [];
    const candidates = exact.length > 0 ? exact : pool;
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
    const names = [c.name, ...c.aliases].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const n of names) out = out.split(n).join('该人物');
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
   * 带姓名的资料卡：交给模型"用自己的知识作答"时用。
   * 名字是召回知识的锚点——没有名字，模型对冷门人物基本答不出来。
   * 泄题风险交给提示词约束 + 输出端过滤（见 answerer.guardLeak）。
   */
  brief(c: Character): string {
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
