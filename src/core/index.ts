import type { Character } from '../shared/domain.ts';

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

const KNOWN_DYNASTIES = new Set([
  '春秋', '战国', '秦', '西汉', '东汉', '三国', '西晋', '东晋', '南北朝',
  '隋', '唐', '五代', '北宋', '南宋', '元', '明', '清', '近代',
]);

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
  dynasty?: string | null;
  rng?: () => number;
}

export class CharacterIndex {
  readonly list: Character[];
  private byId = new Map<string, Character>();

  constructor(list: Character[]) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('人物索引为空');
    }
    this.list = list;
    for (const c of list) this.byId.set(c.id, c);
  }

  get size(): number {
    return this.list.length;
  }

  get(id: string): Character | undefined {
    return this.byId.get(id);
  }

  /**
   * 按难度/朝代取样。过滤器宁可放宽也不报空：
   * 先按精确条件，再退到"难度最接近"，最后退到全量。
   */
  pick(opts: PickOptions = {}): Character {
    const rng = opts.rng ?? Math.random;
    const scope = opts.dynasty ? dynastyScope(opts.dynasty) : null;

    const inScope = scope
      ? this.list.filter(
          (c) => scope.includes(c.dynasty) || (c.dynastyAlt ?? []).some((d) => scope.includes(d)),
        )
      : this.list;

    const pool = inScope.length > 0 ? inScope : this.list;

    if (opts.difficulty) {
      const exact = pool.filter((c) => c.difficulty === opts.difficulty);
      if (exact.length > 0) return exact[Math.floor(rng() * exact.length)]!;
    }

    return pool[Math.floor(rng() * pool.length)]!;
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
    rows.push(`朝代：${c.dynasty}`);
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
    rows.push(`朝代：${c.dynasty}${c.dynastyAlt?.length ? `（也活跃于 ${c.dynastyAlt.join('、')}）` : ''}`);
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
