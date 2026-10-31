import type { Basis, Character, ParsedQuery, Verdict } from '../shared/domain.ts';
import { dynastyScope } from './index.ts';

export interface JudgeOutcome {
  verdict: Verdict;
  basis: Basis;
  note?: string;
}

/**
 * 确定性判定：只用索引字段算，结果可复现。
 * 铁律：字段缺失或属性不可控 → unknown，绝不猜。
 *
 * 引擎只对「朝代」类问题走索引裁定（曹操=东汉这类模型必错的题）；
 * 其余维度（性别/生卒/事迹…）由模型知识作答、资料校对——
 * 旧的多维度分支已随字段精简（v8 facts 化）删除。
 */
export function judgeByIndex(c: Character, q: ParsedQuery): JudgeOutcome {
  switch (q.attr) {
    case 'dynasty': {
      const scope = dynastyScope(String(q.value ?? ''));
      // 非中国朝代（如“罗马帝国”）不做硬裁定，交给模型知识
      if (!scope) return { verdict: 'unknown', basis: 'index.dynasty', note: '非中国朝代，交由模型判断' };
      // 跨时期人物（如耶律阿保机 polityAlt 含唐）：经历过即算「是」
      const hit =
        scope.includes(c.polity) || (c.polityAlt ?? []).some((p) => scope.includes(p));
      return { verdict: hit ? 'yes' : 'no', basis: 'index.dynasty' };
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

/**
 * 猜名判定：必须与姓名或某个别名完全相等。
 *
 * 不做任何包含匹配：输入「子」不应命中「孔子」，输入「白」也不应命中「李白」。
 * 常见的口语修饰（我猜是/吧/吗）由 normalizeGuess 先去干净，这里只负责严格比对。
 */
export function guessMatches(c: Character, raw: string): boolean {
  const want = normalizeGuess(raw);
  if (!want) return false;
  const candidates = [c.name, ...c.aliases].map((n) => n.replace(/\s/g, ''));
  return candidates.some((n) => n === want);
}
