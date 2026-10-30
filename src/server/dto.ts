import type { AnswerRecord, Character, SoloSession } from '../shared/domain.ts';
import type { RecordView, SessionView } from '../shared/protocol.ts';

/**
 * 唯一的下行出口。
 * 原则：白名单生成，而不是"把敏感字段删掉"——漏删的代价是泄题。
 */

export function projectRecord(r: AnswerRecord): RecordView {
  const view: RecordView = {
    seq: r.seq,
    question: r.question,
    verdict: r.verdict,
    text: r.text,
  };
  if (r.hint) view.hint = r.hint;
  if (r.invalid) view.invalid = r.invalid;
  return view;
}

export function projectHistory(list: AnswerRecord[]): RecordView[] {
  return list.filter((r) => !r.transient).map(projectRecord);
}

export function projectSession(s: SoloSession): SessionView {
  return {
    gameId: s.id,
    status: s.status,
    turnsLeft: s.turnsLeft,
    difficulty: s.difficulty,
    polity: s.polity,
    region: s.region,
    worldEra: s.worldEra,
    cnShare: s.cnShare,
    mode: s.mode,
    pronoun: s.pronoun,
    history: projectHistory(s.history),
  };
}

/** 对局中允许出现的字段 */
const SESSION_FORBIDDEN = [
  'targetId',
  'target',
  'apiKey',
  'authorization',
  'aliases',
  'notable',
  'basis',
  'calls',
  'query',
  'externalId',
  'name',
] as const;

/** 揭晓时允许出现 name / aliases / notable，但仍不允许出现这些 */
const REVEAL_FORBIDDEN = ['targetId', 'apiKey', 'authorization', 'basis', 'calls'] as const;

export function findForbiddenKeys(
  payload: unknown,
  forbidden: readonly string[] = SESSION_FORBIDDEN,
): string[] {
  const hits: string[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (forbidden.includes(k)) hits.push(k);
      walk(v);
    }
  };
  walk(payload);
  return [...new Set(hits)];
}

/** 冒烟断言：任何响应体里出现了目标人物名，就是泄题 */
export function containsCharacterName(payload: unknown, c: Character): boolean {
  const text = JSON.stringify(payload ?? null);
  const names = [c.name, ...c.aliases].filter((n) => n && n.length >= 2);
  return names.some((n) => text.includes(n));
}

export const forbidden = { session: SESSION_FORBIDDEN, reveal: REVEAL_FORBIDDEN };
