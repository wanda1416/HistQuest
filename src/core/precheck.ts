/**
 * 形式检查：只处理"这压根不是一个能判定的问题"（空 / 超长）。
 * 问法是否成立、是否主观、是否过于直接——全部交给模型按模式规则判断，
 * 本地不做任何语义拦截。
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
