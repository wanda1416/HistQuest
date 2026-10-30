/**
 * 规则前置：不依赖模型的第一道防线。
 * 只在"形式"和"明显越权意图"上拦截，避免误伤正常提问。
 */

export interface PrecheckResult {
  ok: boolean;
  level: 'normal' | 'suspicious';
  reasons: string[];
  /** 意图类越权（值得进终审）；形式类只需要提示玩家 */
  intent: boolean;
  cleaned: string;
}

const INTENT_RULES: Array<{ code: string; re: RegExp }> = [
  {
    code: 'ask_answer',
    re: /(告诉|说出|说出答案|给我|直接给|直接说|公布|泄露|透露|报出).{0,6}(答案|谜底|是谁|名字)/,
  },
  {
    code: 'ask_answer',
    re: /(答案|谜底)(到底)?(是|为)(什么|谁|啥)/,
  },
  {
    code: 'ignore_rules',
    re: /(忽略|无视|不要管|别管|抛开|忘记|绕过|跳过).{0,10}(规则|设定|限制|指令|提示词|系统|约束|要求)/,
  },
  {
    code: 'roleplay',
    re: /(扮演|假装|角色扮演|现在你是|从现在起你是|假设你是)/,
  },
  {
    code: 'reveal_prompt',
    re: /(复述|重复|输出|打印|显示|贴出).{0,8}(设定|提示词|系统提示|prompt|规则|上下文)/,
  },
  {
    code: 'change_target',
    re: /(换|改|重新设定|重新选).{0,5}(人物|答案|目标|题目)/,
  },
  {
    code: 'override_output',
    re: /(输出|返回|回答).{0,4}(json|格式|代码|英文)/,
  },
];

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const B64_BLOB = /[A-Za-z0-9+/]{40,}={0,2}/;
const INJECTION = /(```|<\/?[a-z][a-z0-9]*>|<<<|>>>|###|\[system\]|system\s*:|assistant\s*:)/i;

export const MAX_QUESTION_LEN = 200;

/**
 * 不是是/否问法的识别。
 * 这不算玩家的错——直接把"无法判断"丢回去会让人莫名其妙，所以给他一个能用的改法，
 * 并且不扣次数（问法问题不该消耗线索额度）。
 */
export interface NonBinaryHint {
  kind: 'choice' | 'open' | 'age';
  text: string;
}

const CHOICE_RE = /(还是|抑或)/;
const AGE_RE = /(多少岁|几岁|活了多久|享年多少|多大年纪|哪年出生|哪年去世|出生在哪一年|死于哪一年)/;
const OPEN_RE = /(哪个朝代|哪一朝|什么朝代|哪个时代|是谁|叫什么|什么名字|哪里人|什么地方人|做什么的|干什么的|多久以前|距离现在)/;

export function detectNonBinary(question: string): NonBinaryHint | null {
  const q = String(question ?? '').trim();
  if (!q) return null;

  if (CHOICE_RE.test(q)) {
    return {
      kind: 'choice',
      text: '这是「A 还是 B」的选择问句，我只能回答是或否。拆成两次问就行，比如：他生活在唐朝之前吗？',
    };
  }
  if (AGE_RE.test(q)) {
    return {
      kind: 'age',
      text: '年龄类问法我答不了，换成是 / 否的形式，比如：他活过六十岁吗？',
    };
  }
  if (OPEN_RE.test(q)) {
    return {
      kind: 'open',
      text: '这类开放问法我不会直接答。换成是 / 否的形式试试，比如：他是唐朝人吗？',
    };
  }
  return null;
}

export function precheck(raw: string): PrecheckResult {
  const reasons: string[] = [];
  let intent = false;

  const text = String(raw ?? '');
  const cleaned = text.replace(ZERO_WIDTH, ' ').replace(CONTROL, ' ').trim();

  if (!cleaned) {
    return { ok: false, level: 'suspicious', reasons: ['empty'], intent: false, cleaned: '' };
  }

  if (cleaned.length > MAX_QUESTION_LEN) reasons.push('too_long');

  if (ZERO_WIDTH.test(text) || CONTROL.test(text)) {
    reasons.push('hidden_chars');
  }

  if (B64_BLOB.test(cleaned)) reasons.push('encoded_blob');
  if (INJECTION.test(cleaned)) reasons.push('injection_markup');

  for (const rule of INTENT_RULES) {
    if (rule.re.test(cleaned)) {
      reasons.push(rule.code);
      intent = true;
    }
  }

  return {
    ok: reasons.length === 0,
    level: reasons.length === 0 ? 'normal' : 'suspicious',
    reasons: [...new Set(reasons)],
    intent,
    cleaned,
  };
}
