import type { AnswerRecord } from '../../shared/domain.ts';
import type { FlagReason, TurnFlag } from '../../shared/room.ts';

/**
 * 破甲（jailbreak）事后审查：只做**确定性标记**，不调模型、不判罚。
 *
 * 为什么不做自动判负：这是自我挑战游戏，绕规则只坑自己；多人模式靠对局记录
 * 事后复盘，异常提问由人判断（与 README「不防破甲」的取舍一致）。
 * 这里输出的是"值得人看一眼"的条目，不是"作弊判定"。
 */

export const FLAG_LABELS: Record<FlagReason, string> = {
  override: '指令覆盖',
  'ask-answer': '直接索答',
  encode: '编码绕过',
  structure: '结构注入',
  long: '超长问句',
  repeat: '反复重问',
};

const RULES: Array<{ reason: FlagReason; re: RegExp }> = [
  // 试图改写模型的行为约束
  {
    reason: 'override',
    re: /(忽略|无视|忘记|抛开|不要管|跳过)[^，。！？\n]{0,12}(以上|之前|前面|上面|上述|设定|规则|指令|提示|系统)/,
  },
  {
    reason: 'override',
    re: /(系统提示|提示词|system\s*prompt|jailbreak|越狱|开发者模式|从现在开始你|你现在是|扮演)/i,
  },
  // 直接要答案（不是"是/否"提问）
  {
    reason: 'ask-answer',
    re: /(直接(告诉|说|给出?|输出)我?|到底是谁|究竟是谁|答案是|答案是什么|告诉我他|他叫什么|输出(全部|所有)|列出(全部|所有)|按(概率|可能|把握)排序)/,
  },
  // 用编码/变形绕过"不许说名字"的过滤
  {
    reason: 'encode',
    re: /(拼音|首字母|英文|英语|藏头|倒序|反过来写|编码|base64|摩斯|谐音|拆字|第[一二三四五六七八九十\d]{1,3}个字)/i,
  },
  // 提示拼接痕迹：换行、代码块、标签、JSON
  {
    reason: 'structure',
    re: /[\r\n]|```|<[a-zA-Z/][^>]*>|\{[^\n]{0,200}\}/,
  },
];

const LONG_QUESTION = 60;
const REPEAT_THRESHOLD = 3;

/** 归一化：去掉首尾标点与空白，用于判断"同一个问题被反复问" */
function norm(q: string): string {
  return String(q ?? '')
    .trim()
    .replace(/[？?！!。，,、；;：:\s]+$/g, '')
    .replace(/\s+/g, '');
}

/**
 * 给每一条提问打标记。只返回"有标记"的条目，页面按 seq 定位高亮。
 */
export function flagHistory(history: AnswerRecord[]): TurnFlag[] {
  const counts = new Map<string, number>();
  for (const r of history) {
    const key = norm(r.question);
    if (!key) continue;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const out: TurnFlag[] = [];
  for (const r of history) {
    const reasons: FlagReason[] = [];
    for (const rule of RULES) {
      if (rule.re.test(r.question) && !reasons.includes(rule.reason)) reasons.push(rule.reason);
    }
    if (r.question.length > LONG_QUESTION) reasons.push('long');
    if ((counts.get(norm(r.question)) ?? 0) >= REPEAT_THRESHOLD) reasons.push('repeat');
    if (reasons.length) out.push({ seq: r.seq, question: r.question, reasons });
  }
  return out;
}

/**
 * 整局层面的观察结论（给复盘页顶部一行提示）。
 * 与 flagHistory 分开：这里是"这一局的形状不对"，不是"这一条可疑"。
 */
export function sessionNotes(history: AnswerRecord[]): string[] {
  const notes: string[] = [];
  const valid = history.filter((r) => !r.invalid && !r.transient);
  if (!valid.length) return notes;

  const unknown = valid.filter((r) => r.verdict === 'unknown').length;
  if (unknown / valid.length > 0.5) {
    notes.push(`${valid.length} 问里有 ${unknown} 问「无法判断」，问法可能在试探模型边界`);
  }

  const flagged = flagHistory(history);
  if (flagged.length) {
    notes.push(`有 ${flagged.length} 条提问命中可疑规则，见逐条标记`);
  }

  const repeat = flagged.filter((f) => f.reasons.includes('repeat')).length;
  if (repeat) notes.push(`有 ${repeat} 条属于同一问题的反复重问`);

  return notes;
}
