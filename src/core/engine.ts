import type {
  AiCredential,
  AnswerMode,
  AnswerRecord,
  Basis,
  Character,
  ParsedQuery,
  Verdict,
} from '../shared/domain.ts';
import type { CharacterIndex } from './index.ts';
import { precheck, detectNonBinary } from './precheck.ts';
import { judgeByIndex } from './judge.ts';
import { clarify, phrase, PARSE_FAILED_TEXT } from './phraser.ts';
import { extractDynasty } from './dynasty.ts';
import { modelAnswer, toQuery } from './answerer.ts';
import { AiError } from '../ai/client.ts';

export interface AskParams {
  question: string;
  target: Character;
  index: CharacterIndex;
  credential: AiCredential;
  seq: number;
  /** 回答模式，默认精确 */
  mode?: AnswerMode;
  timeoutMs?: number;
  rng?: () => number;
}

export interface AskOutcome {
  record: AnswerRecord;
}

const TRANSIENT_TEXT = '模型这次没能及时回应，这问不计次数，请再问一次。';

/** 主观评价类：本地短路，保证话术稳定且不花调用 */
const SUBJECTIVE_RE = /(伟大|厉害|了不起|优秀|聪明|有趣|好人|坏人|最强|最牛|很牛|牛逼|牛不牛)/;

/**
 * 一次提问的完整流程。
 *
 * 判定取向：模型用自己的知识作答（知识优先），索引负责校对；
 * 唯一强制由索引裁定的是「朝代」——严格史学分期是产品硬要求，不能让模型按民间印象答。
 */
export async function runAsk(params: AskParams): Promise<AskOutcome> {
  const startedAt = Date.now();
  const rng = params.rng ?? Math.random;
  const seq = params.seq;
  const question = params.question;

  const make = (partial: {
    verdict: Verdict;
    text: string;
    basis: Basis;
    query?: ParsedQuery | null;
    hint?: string;
    calls: number;
    invalid?: 'suspicious' | 'format';
    transient?: boolean;
  }): AnswerRecord => ({
    seq,
    question,
    query: partial.query ?? null,
    verdict: partial.verdict,
    text: partial.text,
    ...(partial.hint ? { hint: partial.hint } : {}),
    basis: partial.basis,
    calls: partial.calls,
    ms: Date.now() - startedAt,
    ...(partial.invalid ? { invalid: partial.invalid } : {}),
    ...(partial.transient ? { transient: true } : {}),
  });

  /** 口径说明：只在解说模式出现，且绝不允许包含目标人物名 */
  const hintFor = (
    query: ParsedQuery | null,
    verdict: Verdict,
    note?: string,
  ): string | undefined => {
    if (params.mode !== 'guided' || !query) return undefined;
    const hint = clarify(query, verdict, note);
    if (!hint) return undefined;
    const names = [params.target.name, ...params.target.aliases].filter(Boolean);
    return names.some((n) => hint.includes(n)) ? undefined : hint;
  };

  // ---------- 规则前置：只处理形式，不做"作弊审查" ----------
  // 这是自我挑战游戏，绕过规则只坑自己；真正的约束是玩家会复盘自己的问答记录。
  const pre = precheck(question);
  let calls = 0;

  if (!pre.ok) {
    return {
      record: make({
        verdict: 'unknown',
        text: phrase('unknown', 'invalid', rng),
        basis: 'fallback',
        calls,
        invalid: 'suspicious',
      }),
    };
  }

  const asked = pre.cleaned || question;

  // ---------- 问法检查：不是是/否问题就给出改法，不进模型、不扣次数 ----------
  const nonBinary = detectNonBinary(asked);
  if (nonBinary) {
    return {
      record: make({
        verdict: 'unknown',
        text: nonBinary.text,
        basis: 'fallback',
        calls,
        invalid: 'format',
      }),
    };
  }

  // ---------- 主观评价：本地短路 ----------
  if (SUBJECTIVE_RE.test(asked)) {
    return {
      record: make({
        verdict: 'unknown',
        text: phrase('unknown', 'subjective', rng),
        basis: 'subjective',
        calls: 0,
        query: { attr: 'other', value: null, subjective: true },
      }),
    };
  }

  // ---------- 模型作答（一次调用，知识优先） ----------
  let verdict: Verdict = 'unknown';
  let basis: Basis = 'fallback';
  let query: ParsedQuery | null = null;
  let hint: string | undefined;
  let text: string;

  try {
    const answer = await modelAnswer(
      params.credential,
      params.target,
      params.index.brief(params.target),
      asked,
      { timeoutMs: params.timeoutMs },
    );
    calls += answer.calls;

    query = toQuery(answer);
    verdict = answer.verdict;
    basis = 'knowledge';

    // 朝代由索引裁定：严格史学分期（曹操=东汉）不能被模型的民间印象覆盖。
    // 注意：必须用"问句里提到的朝代"去比对——模型返回的 dynasty.value 指的是
    // 人物所属朝代，直接拿来比对会把"他是唐朝人吗"这类问题的答案反过来。
    const askedDynasty = extractDynasty(asked);
    if (answer.attr === 'dynasty' && askedDynasty) {
      const dynastyQuery: ParsedQuery = { attr: 'dynasty', value: askedDynasty };
      const outcome = judgeByIndex(params.target, dynastyQuery);
      if (outcome.verdict !== 'unknown') {
        verdict = outcome.verdict;
        basis = outcome.basis;
        query = dynastyQuery;
        hint = hintFor(dynastyQuery, verdict, outcome.note);
      }
    }

    if (basis !== 'knowledge') {
      // 结论被索引改写过，模型那句话可能与结论矛盾，改用模板
      text = phrase(verdict, 'normal', rng);
    } else if (params.mode === 'guided' && answer.text) {
      text = answer.text;
      if (verdict === 'unknown') hint = hintFor(query, verdict);
    } else {
      text = phrase(verdict, 'normal', rng);
    }
  } catch (err) {
    const e = err as AiError;
    // 凭据失效/地址不可达：让上层知道，不能伪装成"无法判断"
    if (
      e instanceof AiError &&
      (e.code === 'AUTH' || e.code === 'UNSUPPORTED' || e.code === 'NETWORK')
    ) {
      throw e;
    }
    if (e instanceof AiError && e.code === 'BAD_JSON') {
      return {
        record: make({
          verdict: 'unknown',
          text: PARSE_FAILED_TEXT,
          basis: 'fallback',
          calls: calls + ((e as unknown as { calls?: number }).calls ?? 1),
          transient: true,
        }),
      };
    }
    if (e instanceof AiError && (e.code === 'TIMEOUT' || e.code === 'EMPTY')) {
      return {
        record: make({
          verdict: 'unknown',
          text: TRANSIENT_TEXT,
          basis: 'fallback',
          calls: calls + 1,
          transient: true,
        }),
      };
    }
    verdict = 'unknown';
    basis = 'fallback';
    text = PARSE_FAILED_TEXT;
  }

  return { record: make({ verdict, text, basis, query, hint, calls }) };
}
