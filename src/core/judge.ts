import type { Basis, Character, ParsedQuery, Verdict } from '../shared/domain.ts';
import { dynastyScope, fmtYear } from './index.ts';
import { spanOf } from './dynasty.ts';

export interface JudgeOutcome {
  verdict: Verdict;
  basis: Basis;
  note?: string;
}

const MALE = new Set(['男', '男性', '男的', '男人', 'male', 'm', '他']);
const FEMALE = new Set(['女', '女性', '女的', '女人', 'female', 'f', '她']);

const ROLE_SYNONYMS: Record<string, string> = {
  武将: '将军',
  名将: '将军',
  军事统帅: '将军',
  统帅: '将军',
  元帅: '将军',
  君主: '皇帝',
  天子: '皇帝',
  国君: '皇帝',
  帝王: '皇帝',
  医生: '医学家',
  大夫: '医学家',
  郎中: '医学家',
  名医: '医学家',
  大诗人: '诗人',
  词作家: '词人',
  作家: '文学家',
  文豪: '文学家',
  散文家: '文学家',
  书法大师: '书法家',
  画家: '画家',
  谋臣: '谋士',
  军师: '谋士',
  宰相: '政治家',
  丞相: '政治家',
  和尚: '僧人',
  高僧: '僧人',
};

export function normalizeRole(input: string): string {
  const s = String(input ?? '').trim().replace(/[家人物者]$/u, (m) => m);
  return ROLE_SYNONYMS[s] ?? s;
}

function asBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  const s = String(v ?? '').trim().toLowerCase();
  if (['true', 'yes', '是', '1', '有', '当过', '对'].includes(s)) return true;
  if (['false', 'no', '否', '0', '没有', '不是', '没当过'].includes(s)) return false;
  return null;
}

/**
 * 确定性判定：只用索引字段算，结果可复现。
 * 铁律：字段缺失或属性不可控 → unknown，绝不猜。
 */
export function judgeByIndex(c: Character, q: ParsedQuery): JudgeOutcome {
  switch (q.attr) {
    case 'dynasty': {
      const scope = dynastyScope(String(q.value ?? ''));
      if (!scope) return { verdict: 'unknown', basis: 'index.dynasty', note: '朝代名无法识别' };
      const hit =
        scope.includes(c.dynasty) || (c.dynastyAlt ?? []).some((d) => scope.includes(d));
      return { verdict: hit ? 'yes' : 'no', basis: 'index.dynasty' };
    }

    case 'eraBefore': {
      const span = spanOf(String(q.value ?? ''));
      if (!span) return { verdict: 'unknown', basis: 'index.eraBefore', note: '这个朝代名我没认出来' };
      if (c.death === null) return { verdict: 'unknown', basis: 'index.eraBefore', note: '卒年记载不全' };
      return { verdict: c.death < span.start ? 'yes' : 'no', basis: 'index.eraBefore' };
    }

    case 'eraAfter': {
      const span = spanOf(String(q.value ?? ''));
      if (!span) return { verdict: 'unknown', basis: 'index.eraAfter', note: '这个朝代名我没认出来' };
      if (c.birth === null) return { verdict: 'unknown', basis: 'index.eraAfter', note: '生年记载不全' };
      return { verdict: c.birth > span.end ? 'yes' : 'no', basis: 'index.eraAfter' };
    }

    case 'gender': {
      const v = String(q.value ?? '').trim().toLowerCase();
      const wanted = MALE.has(v) ? 'male' : FEMALE.has(v) ? 'female' : null;
      if (!wanted) return { verdict: 'unknown', basis: 'index.gender' };
      return { verdict: wanted === c.gender ? 'yes' : 'no', basis: 'index.gender' };
    }

    case 'emperor': {
      const wanted = asBool(q.value);
      if (wanted === null) return { verdict: 'unknown', basis: 'index.emperor' };
      return { verdict: wanted === c.emperor ? 'yes' : 'no', basis: 'index.emperor' };
    }

    case 'role': {
      const want = normalizeRole(String(q.value ?? ''));
      if (!want) return { verdict: 'unknown', basis: 'index.role' };
      const direct = c.roles.some((r) => r === want);
      if (direct) return { verdict: 'yes', basis: 'index.role' };
      const loose = c.roles.some((r) => r.includes(want) || want.includes(r));
      if (loose) return { verdict: 'yes', basis: 'index.role' };
      const inTags = c.tags.some((t) => t === want);
      if (inTags) return { verdict: 'yes', basis: 'index.role' };
      return { verdict: 'no', basis: 'index.role' };
    }

    case 'birthplace': {
      if (!c.birthplace) return { verdict: 'unknown', basis: 'index.birthplace', note: '籍贯不详' };
      const want = String(q.value ?? '').trim();
      if (!want) return { verdict: 'unknown', basis: 'index.birthplace' };
      const inPlace = c.birthplace.includes(want);
      const inProvince = c.birthProvince ? c.birthProvince.includes(want) || want.includes(c.birthProvince) : false;
      return { verdict: inPlace || inProvince ? 'yes' : 'no', basis: 'index.birthplace' };
    }

    case 'birthEra': {
      if (c.birth === null) return { verdict: 'unknown', basis: 'index.birthEra', note: '生年不详' };
      const v = String(q.value ?? '').trim().toLowerCase();
      if (['bc', '公元前', 'bce'].includes(v)) {
        return { verdict: c.birth < 0 ? 'yes' : 'no', basis: 'index.birthEra' };
      }
      if (['ad', '公元', 'ce'].includes(v)) {
        return { verdict: c.birth >= 0 ? 'yes' : 'no', basis: 'index.birthEra' };
      }
      const num = Number(v);
      if (!Number.isFinite(num)) return { verdict: 'unknown', basis: 'index.birthEra' };
      const cmp = q.op === 'gte' ? c.birth >= num : q.op === 'lte' ? c.birth <= num : c.birth === num;
      return { verdict: cmp ? 'yes' : 'no', basis: 'index.birthEra' };
    }

    case 'nameLength': {
      const want = Number(q.value);
      if (!Number.isFinite(want)) return { verdict: 'unknown', basis: 'index.nameLength' };
      return { verdict: c.name.length === want ? 'yes' : 'no', basis: 'index.nameLength' };
    }

    case 'nameContains': {
      const want = String(q.value ?? '').trim();
      if (!want) return { verdict: 'unknown', basis: 'index.nameContains' };
      const hit = c.name.includes(want) || c.aliases.some((a) => a.includes(want));
      return { verdict: hit ? 'yes' : 'no', basis: 'index.nameContains' };
    }

    case 'lifespan': {
      if (c.birth === null || c.death === null) {
        return { verdict: 'unknown', basis: 'index.lifespan', note: '生卒年记载不全' };
      }
      const age = c.death - c.birth;
      const want = Number(q.value);
      if (!Number.isFinite(want)) return { verdict: 'unknown', basis: 'index.lifespan' };
      const cmp = q.op === 'lte' ? age <= want : age >= want;
      // 刻意不回报具体享年：那是另一个问题的答案
      return { verdict: cmp ? 'yes' : 'no', basis: 'index.lifespan' };
    }

    case 'alive': {
      // 索引内全部为已故历史人物
      const wanted = asBool(q.value);
      if (wanted === null) return { verdict: 'no', basis: 'index.alive' };
      return { verdict: wanted ? 'no' : 'yes', basis: 'index.alive' };
    }

    case 'nationality': {
      const wanted = asBool(q.value);
      if (wanted === null) return { verdict: 'unknown', basis: 'index.nationality' };
      return { verdict: wanted ? 'yes' : 'no', basis: 'index.nationality' };
    }

    case 'event': {
      const want = String(q.value ?? '').trim();
      if (!want) return { verdict: 'unknown', basis: 'index.event' };
      const haystack = [c.notable, ...c.tags, ...c.roles, ...c.aliases].join('｜');
      if (haystack.includes(want)) return { verdict: 'yes', basis: 'index.event' };
      return { verdict: 'unknown', basis: 'index.event', note: '索引未收录相关事迹' };
    }

    default:
      return { verdict: 'unknown', basis: 'fallback' };
  }
}

/** 猜测归一化：去掉"我猜是/叫/吧/？"等修饰（前缀可能叠加，循环剥） */
export function normalizeGuess(raw: string): string {
  let s = String(raw ?? '')
    .replace(/[？?！!。，,、\s]/g, '')
    .trim();
  for (let i = 0; i < 3; i++) {
    const next = s.replace(/^(我猜|应该是|是不是|答案是|我猜是|猜|是|叫)/, '');
    if (next === s) break;
    s = next;
  }
  return s.replace(/(吧|吗|呢|呀|啊)$/g, '').trim();
}

export function guessMatches(c: Character, raw: string): boolean {
  const want = normalizeGuess(raw);
  if (!want) return false;
  const candidates = [c.name, ...c.aliases].map((n) => n.replace(/\s/g, ''));
  return candidates.some((n) => n === want || n.includes(want) || want.includes(n));
}

export { fmtYear };
