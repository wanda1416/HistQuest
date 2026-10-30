/** REST 契约：前端与后端共用，避免字段漂移。 */
import type { AnswerMode, AnswerRecord, Character, SessionStatus, Verdict } from './domain.ts';

export interface AiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

export interface MetaRes {
  dynasties: string[];
  difficulties: Array<{ level: number; label: string; desc: string }>;
  maxTurns: number;
  serverModelReady: boolean;
  characterCount: number;
}

export interface StartSoloReq {
  difficulty: number;
  dynasty: string | null;
  mode: AnswerMode;
  aiConfig: AiConfig;
}

export interface StartSoloRes {
  gameId: string;
  turnsLeft: number;
  difficulty: number;
  dynasty: string | null;
  mode: AnswerMode;
}

export interface AskReq {
  question: string;
  aiConfig: AiConfig;
}

export interface AskRes {
  accepted: boolean;
  seq: number;
  verdict: Verdict;
  text: string;
  /** guided 模式下的口径说明 */
  hint?: string;
  turnsLeft: number;
  status: SessionStatus;
  invalid?: 'suspicious' | 'format';
}

export interface GuessReq {
  name: string;
}

export interface GuessRes {
  correct: boolean;
  status: SessionStatus;
  turnsLeft: number;
  /** 猜错时给出提示语；猜对时为空，由 reveal 拉取人物卡 */
  hint?: string;
}

export interface RevealRes {
  character: Character;
  status: SessionStatus;
  turnsUsed: number;
  history: RecordView[];
}

/** 对局中下发的记录：刻意不含 basis / calls / query */
export interface RecordView {
  seq: number;
  question: string;
  verdict: Verdict;
  text: string;
  hint?: string;
  invalid?: 'suspicious' | 'format';
}

export interface SessionView {
  gameId: string;
  status: SessionStatus;
  turnsLeft: number;
  difficulty: number;
  dynasty: string | null;
  mode: AnswerMode;
  history: RecordView[];
}

export interface AiTestReq {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface AiTestRes {
  ok: boolean;
  errorCode?: string;
  latencyMs?: number;
  message?: string;
}

export interface ApiError {
  error: string;
  message: string;
}

export type { AnswerRecord, Character, SessionStatus, Verdict };
