/** REST 契约：前端与后端共用，避免字段漂移。 */
import type { AnswerMode, AnswerRecord, Character, PronounStyle, Region, SessionStatus, TargetCategory, Verdict } from './domain.ts';

export interface AiConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

export interface MetaUser {
  username: string;
  role: 'user' | 'admin';
  allowServerKey: boolean;
}

export interface MetaRes {
  dynasties: string[];
  difficulties: Array<{ level: number; label: string; desc: string }>;
  /** 服务端允许的最大轮次；每局可在 10 到该值之间自选 */
  maxTurns: number;
  serverModelReady: boolean;
  characterCount: number;
  /** 各谜底类别的在库数量（人物/事件/物品），开局页据此展示与禁用空类别 */
  categories?: Record<TargetCategory, number>;
  /** 可选文明圈与各自人数 */
  regions: Array<{ value: Region; label: string; count: number }>;
  /** 用户系统是否启用（Workers 部署） */
  authEnabled?: boolean;
  /** 当前登录用户（未登录为 null） */
  user?: MetaUser | null;
}

export interface StartSoloReq {
  difficulty: number;
  /** 谜底类别：character / event / item / mixed；缺省人物 */
  category?: TargetCategory | 'mixed';
  /** 中国朝代筛选，null = 不限 */
  polity: string | null;
  /** 文明圈筛选，null = 不限 */
  region: Region | null;
  /** 世界时期筛选（仅世界模式），null = 不限 */
  worldEra: string | null;
  /** 混合模式下中国人物占比 0–1 */
  cnShare: number;
  mode: AnswerMode;
  pronoun: PronounStyle;
  /** 本局提问轮次（10–maxTurns），缺省 = maxTurns */
  turns?: number;
  aiConfig?: AiConfig | null;
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
  aiConfig?: AiConfig | null;
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
  invalid?: 'format';
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

/* ---------------- 对局历史 ---------------- */

/**
 * 对局结局：
 * - playing  进行中
 * - won      猜中（抢答或提问中点名）
 * - lost     次数用尽
 * - abandoned 主动放弃（还有剩余次数就揭晓了）
 */
export type GameResult = 'won' | 'lost' | 'abandoned' | 'playing';

/** 历史里的一条问答：与对局中的 RecordView 同形，另带失败标记 */
export interface HistoryTurn {
  seq: number;
  question: string;
  verdict: Verdict;
  text: string;
  hint?: string;
  /** 问法不是有效的是/否问题（不扣次数） */
  invalid?: 'format';
  /** 基础设施故障（超时/网络），不算次数 */
  failed?: boolean;
}

export interface HistorySummary {
  id: string;
  status: SessionStatus;
  result: GameResult;
  /** 谜底类别 */
  category: TargetCategory;
  difficulty: number;
  mode: AnswerMode;
  /** 开局时的筛选条件 */
  polity: string | null;
  region: Region | null;
  worldEra: string | null;
  turnsTotal: number;
  turnsUsed: number;
  turnsLeft: number;
  startedAt: number;
  endedAt: number | null;
  /** 管理员视角下的对局归属；游客与"归属未记录"都为 null */
  userName?: string | null;
  /**
   * 归属来源，三种情况必须分开，否则会把登录玩家误标成游客：
   * - user    有登录玩家（userName 可靠）
   * - guest   明确未登录（本版本起写入）
   * - unknown 迁移回填的老局，玩家是否登录已无从得知
   */
  owner: 'user' | 'guest' | 'unknown';
  /**
   * 目标人物：只有已结束的局才下发（复盘需要）。
   * 进行中的局一律为 null——与对局中接口一致，不给扒答案的口子。
   */
  target: { name: string; polity: string; roles: string[] } | null;
  /** 对战局才有：所属房间 id（ rooms.id，不是房号） */
  roomId?: string | null;
  /** 对战局才有：结算名次（1 = 赢家） */
  finishRank?: number | null;
}

export interface HistoryDetail extends HistorySummary {
  /** 归属用户 id（游客为 null）；用于校验"这局是不是我的" */
  userId?: string | null;
  turns: HistoryTurn[];
}

export interface HistoryListRes {
  total: number;
  items: HistorySummary[];
}

/** 对局中下发的记录：刻意不含 basis / calls / query */
export interface RecordView {
  seq: number;
  question: string;
  verdict: Verdict;
  text: string;
  hint?: string;
  invalid?: 'format';
}

export interface SessionView {
  gameId: string;
  /** 玩家所选类别（mixed 时不揭示真实类别） */
  category: TargetCategory | 'mixed';
  status: SessionStatus;
  turnsLeft: number;
  difficulty: number;
  polity: string | null;
  region: Region | null;
  worldEra: string | null;
  cnShare: number;
  mode: AnswerMode;
  pronoun: PronounStyle;
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
