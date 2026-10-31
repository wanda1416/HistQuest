import type { ParsedQuery, Verdict } from '../shared/domain.ts';

export type PhraseKind = 'normal' | 'subjective' | 'invalid' | 'parse_failed';

const YES = ['是。', '是的。', '没错。', '对，是这样。', '正是。'];
const NO = ['不是。', '不对。', '并非如此。', '不是这样。'];
const UNKNOWN = [
  '这一点资料不足，我无法判断。',
  '这个问题我没法确定，换个更具体的事实问法吧。',
  '无法判断。',
];

export const SUBJECTIVE_TEXT = '无法判断，请提问客观事实。';
export const INVALID_TEXT = '问题为空或太长，换个简短的是/否问法吧（不扣次数）。';
export const PARSE_FAILED_TEXT = '这个问题我没听明白，换个说法再问一次？';

function pickFrom(list: string[], rng: () => number): string {
  return list[Math.floor(rng() * list.length)] ?? list[0]!;
}

export function phrase(verdict: Verdict, kind: PhraseKind = 'normal', rng: () => number = Math.random): string {
  if (kind === 'invalid') return INVALID_TEXT;
  if (kind === 'parse_failed') return PARSE_FAILED_TEXT;
  if (kind === 'subjective') return SUBJECTIVE_TEXT;

  if (verdict === 'yes') return pickFrom(YES, rng);
  if (verdict === 'no') return pickFrom(NO, rng);
  return pickFrom(UNKNOWN, rng);
}

/**
 * guided 模式的口径说明：只解释"这个问法是怎么判的"，绝不透露未被问到的信息。
 * 例如不会说"享年 61 岁"，因为那是另一个问题的答案。
 */
const DYNASTY_NOTES: Record<string, string> = {
  宋: '「宋」包含北宋与南宋。',
  汉: '「汉」包含西汉与东汉。',
  晋: '「晋」包含西晋与东晋。',
  周: '「周」包含西周、春秋与战国。',
  五代: '「五代」指后梁、后唐、后晋、后汉、后周。',
  南北朝: '「南北朝」含南朝与北朝各代。',
  三国: '按史学分期，三国起于 220 年曹丕称帝；此前去世的人物算东汉。',
  东汉: '东汉止于 220 年，此后进入三国时期。',
};

export function clarify(query: ParsedQuery, verdict: Verdict, note?: string): string | undefined {
  // 判定层给出的"为什么不确定"优先
  if (note) return note;

  switch (query.attr) {
    case 'dynasty': {
      const raw = String(query.value ?? '').replace(/(朝|代|时期|时代)$/g, '');
      return DYNASTY_NOTES[raw] ?? '按生卒年与朝代起止时间，判断他是否经历过这个时期。';
    }
    default:
      return undefined;
  }
}
