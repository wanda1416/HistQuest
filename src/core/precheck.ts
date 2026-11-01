/**
 * 形式检查：只处理"这压根不是一个能判定的问题"。
 *
 * 刻意不做意图审查（索要答案、要求扮演、提示词注入…）——
 * 这是自我挑战型游戏，玩家绕过规则只坑自己；靠提示词与模型自身判断足够，
 * 过度防御只会带来误伤（正常问法被拦下反而更糟）。
 */

export interface PrecheckResult {
  ok: boolean;
  reasons: string[];
  cleaned: string;
}

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

export const MAX_QUESTION_LEN = 200;

export function precheck(raw: string): PrecheckResult {
  const text = String(raw ?? '');
  const cleaned = text.replace(ZERO_WIDTH, ' ').replace(CONTROL, ' ').trim();

  const reasons: string[] = [];
  if (!cleaned) reasons.push('empty');
  if (cleaned.length > MAX_QUESTION_LEN) reasons.push('too_long');

  return { ok: reasons.length === 0, reasons, cleaned };
}

/**
 * 不是是/否问法的识别。
 * 这不算玩家的错——直接把"无法判断"丢回去会让人莫名其妙，所以给一个能用的改法，
 * 并且不扣次数（问法问题不该消耗线索额度）。
 */
export interface NonBinaryHint {
  kind: 'choice' | 'open' | 'age';
  text: string;
}

const CHOICE_RE = /(还是|抑或)/;
const AGE_RE = /(多少岁|几岁|活了多久|享年多少|多大年纪|哪年出生|哪年去世|出生在哪一年|死于哪一年|多少年|哪一年|哪年)/;
const OPEN_RE =
  /(哪个|哪些|哪国|哪一种|哪种|哪类|哪一位|哪一个|什么阵营|什么国|什么朝代|哪一朝|什么时代|是谁|叫什么|什么名字|哪里人|什么地方人|做什么的|干什么的|多久以前|距离现在|什么样|怎么样|怎样|为什么|为何)/;

export function detectNonBinary(question: string): NonBinaryHint | null {
  const q = String(question ?? '').trim();
  if (!q) return null;

  if (CHOICE_RE.test(q)) {
    return {
      kind: 'choice',
      text: '这个提问方式不对，我只能回答「是」或「否」。「A 还是 B」拆成两次问就行，比如：他生活在唐朝之前吗？',
    };
  }
  if (AGE_RE.test(q)) {
    return {
      kind: 'age',
      text: '这个提问方式不对，我只能回答「是」或「否」。年龄类换成是 / 否的形式，比如：他活过六十岁吗？',
    };
  }
  if (OPEN_RE.test(q)) {
    return {
      kind: 'open',
      text: '这个提问方式不对，我只能回答「是」或「否」。换成是 / 否的形式试试，比如：他是蜀国的人吗？',
    };
  }
  return null;
}
