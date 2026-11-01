import type {
  AiCredential,
  AnswerMode,
  AnswerRecord,
  Basis,
  Character,
  ParsedQuery,
  PronounStyle,
  Verdict,
} from '../shared/domain.ts';
import type { CharacterIndex } from './index.ts';
import { precheck } from './precheck.ts';
import { judgeByIndex, guessMatches } from './judge.ts';
import { clarify, phrase, PARSE_FAILED_TEXT } from './phraser.ts';
import { extractDynasty } from './dynasty.ts';
import { modelAnswer, toQuery } from './answerer.ts';
import { leaksProfile, neutralizePronoun } from './scrub.ts';
import { AiError } from '../ai/client.ts';

export interface AskParams {
  question: string;
  target: Character;
  index: CharacterIndex;
  credential: AiCredential;
  seq: number;
  /** 回答模式，默认精确 */
  mode?: AnswerMode;
  /** 性别词风格，neutral 时他/她统一替换为 TA */
  pronoun?: PronounStyle;
  timeoutMs?: number;
  rng?: () => number;
}

export interface AskOutcome {
  record: AnswerRecord;
  /** 模型判定玩家点名猜中（已通过 guessMatches 复核）：服务端据此直接结算 */
  won?: boolean;
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
    invalid?: 'format';
    transient?: boolean;
  }): AnswerRecord => ({
    seq,
    question,
    query: partial.query ?? null,
    verdict: partial.verdict,
    text: neutralizePronoun(partial.text, params.pronoun ?? 'normal'),
    ...(partial.hint
      ? { hint: neutralizePronoun(partial.hint, params.pronoun ?? 'normal') }
      : {}),
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
    if (params.mode === 'strict' || !query) return undefined;
    const hint = clarify(query, verdict, note);
    if (!hint) return undefined;
    const names = [params.target.name, ...params.target.aliases].filter(Boolean);
    return names.some((n) => hint.includes(n)) ? undefined : hint;
  };

  // ---------- 形式检查：只拦"压根不是问题"（空 / 超长），不做意图审查 ----------
  const pre = precheck(question);
  let calls = 0;

  if (!pre.ok) {
    return {
      record: make({
        verdict: 'unknown',
        text: phrase('unknown', 'invalid', rng),
        basis: 'fallback',
        calls,
        invalid: 'format',
      }),
    };
  }

  const asked = pre.cleaned || question;

  // ---------- 主观评价：本地短路（保证话术稳定且不花调用） ----------
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
  let won: boolean | undefined;

  try {
    const answer = await modelAnswer(
      params.credential,
      params.target,
      params.index.brief(params.target),
      asked,
      { timeoutMs: params.timeoutMs, mode: params.mode },
    );
    calls += answer.calls;

    query = toQuery(answer);
    verdict = answer.verdict;
    basis = 'knowledge';

    // 模式规则拒答（严格：开放问法；解说/辅助：问得太直接）：不消耗轮次
    if (answer.refuse) {
      return {
        record: make({
          verdict: 'unknown',
          text: answer.text || '这个提问方式不对，我只能回答是或否。',
          basis: 'knowledge',
          query,
          calls,
          invalid: 'format',
        }),
      };
    }

    // 点名猜测：模型判定 + 服务端复核，猜中直接结算，不扣次数。
    // 复核必须有：模型可能把"提到名字"误报成猜中，直接结算就是错杀。
    if (answer.guessed && verdict === 'yes' && guessMatches(params.target, answer.guessed)) {
      won = true;
      basis = 'index.name';
      query = { attr: 'other', value: null };
      // 恭喜文案不走 scrub：玩家自己说出了名字，重复它不泄密
      text = answer.text || '没错，就是TA。恭喜你猜中了！';
      if (!/恭喜|猜中/.test(text)) text = `没错，就是TA。恭喜你猜中了！`;
      return { record: make({ verdict: 'yes', text, basis, query, hint, calls }), won };
    }

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
    } else if (params.mode !== 'strict' && answer.text) {
      // 模型爱把话说满：问"是唐朝之前吗"会答"不是，她是北宋至南宋时期的人物"，
      // 等于把没被问到的维度直接报出来。guided 命中资料就弃用原话，改用模板 + 判法口径；
      // assist 的提示本来就是要提相关维度，不做整句重写（姓名仍由 guardLeak 兜底）。
      if (params.mode === 'guided' && leaksProfile(answer.text, params.target)) {
        text = phrase(verdict, 'normal', rng);
        hint = hintFor(query, verdict);
      } else {
        text = answer.text;
        if (verdict === 'unknown') hint = hintFor(query, verdict);
      }
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
