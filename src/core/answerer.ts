import type { AiCredential, Attr, Character, ParsedQuery, Verdict } from '../shared/domain.ts';
import { ATTRS } from '../shared/domain.ts';
import { AiError, chat, extractJson } from '../ai/client.ts';
import { buildAnswerMessages } from '../ai/prompts.ts';

/**
 * 一次调用完成"理解问题 + 用自己的知识作答"。
 *
 * 设计取向（按产品要求）：优先用模型自身的知识回答；参考资料只作校对，
 * 模型自己拿不准时才以资料为准。这样长尾问题不会被索引的字段表卡死。
 */
export interface ModelAnswer {
  attr: Attr;
  value: unknown;
  verdict: Verdict;
  /** 已过去名化；为空时调用方回退到模板 */
  text: string;
  /** 模型判定玩家在点名猜测时，玩家点出的名号原文；否则为 null */
  guessed: string | null;
  calls: number;
}

const VERDICTS = new Set(['yes', 'no', 'unknown']);

/** 最后一道泄题保险：出现姓名/别称就换成「他」 */
export function guardLeak(text: string, c: Character): string {
  let out = String(text ?? '').trim();
  if (!out) return '';
  const names = [c.name, ...c.aliases]
    .filter((n) => n && n.length >= 2)
    .sort((a, b) => b.length - a.length);
  for (const n of names) out = out.split(n).join('他');
  return out;
}

/** 去名后人称堆叠到读不通（"他就是他"）就丢弃 */
function readable(text: string): boolean {
  if (!text) return false;
  return !/他就是他|他是他|他叫他/.test(text);
}

function normalize(raw: unknown, c: Character): Omit<ModelAnswer, 'calls'> | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  const verdictRaw = String(obj.verdict ?? '').trim().toLowerCase();
  if (!VERDICTS.has(verdictRaw)) return null;

  const attrRaw = String(obj.attr ?? '').trim();
  const attr = (ATTRS as readonly string[]).includes(attrRaw) ? (attrRaw as Attr) : 'other';

  const text = typeof obj.text === 'string' ? obj.text.trim().slice(0, 60) : '';
  const safe = guardLeak(text, c);

  return {
    attr,
    value: obj.value ?? null,
    verdict: verdictRaw as Verdict,
    text: readable(safe) ? safe : '',
    guessed: typeof obj.guessed === 'string' && obj.guessed.trim() ? obj.guessed.trim().slice(0, 30) : null,
  };
}

export async function modelAnswer(
  cred: AiCredential,
  character: Character,
  profile: string,
  question: string,
  opts: { timeoutMs?: number } = {},
): Promise<ModelAnswer> {
  const callOpts = { timeoutMs: opts.timeoutMs, maxTokens: 900, temperature: 0 };
  const messages = buildAnswerMessages(profile, question);

  let calls = 1;
  let text: string;
  try {
    text = await chat(cred, messages, callOpts);
  } catch (err) {
    // 推理模型偶发只产出 thinking：补一次
    if (err instanceof AiError && err.code === 'EMPTY') {
      calls += 1;
      text = await chat(cred, messages, callOpts);
    } else {
      throw err;
    }
  }

  let parsed: Omit<ModelAnswer, 'calls'> | null = null;
  try {
    parsed = normalize(extractJson(text), character);
  } catch {
    calls += 1;
    try {
      const retried = await chat(
        cred,
        [
          ...messages,
          { role: 'assistant', content: text.slice(0, 200) },
          {
            role: 'user',
            content:
              '只输出一个 JSON 对象，不要解释：{"attr":"属性名","value":值,"verdict":"yes|no|unknown","text":"一句话回答"}',
          },
        ],
        callOpts,
      );
      parsed = normalize(extractJson(retried), character);
    } catch {
      parsed = null;
    }
  }

  if (!parsed) {
    // 说不清楚就是模型这次没答上来：抛给上层按"不计次数"处理
    const err = new AiError('BAD_JSON', '模型输出不是合法 JSON');
    (err as unknown as { calls: number }).calls = calls;
    throw err;
  }
  return { ...parsed, calls };
}

/** 把模型返回的 attr/value 还原成受控查询，供朝代复算与口径说明复用 */
export function toQuery(answer: ModelAnswer): ParsedQuery {
  return { attr: answer.attr, value: answer.value as ParsedQuery['value'] };
}
