/**
 * 领域模型：前后端共享、可被任何运行环境引用（浏览器 / Node / Electron 主进程）。
 * 注意：本项目用 Node 原生类型擦除运行 .ts，因此禁止使用 enum / namespace / 参数属性。
 */

export const DYNASTIES = [
  '春秋', '战国', '秦', '西汉', '东汉', '三国', '西晋', '东晋',
  '南北朝', '隋', '唐', '五代', '北宋', '南宋', '蒙古', '元', '明', '清', '近代',
] as const;

export type Dynasty = (typeof DYNASTIES)[number];

export type Gender = 'male' | 'female';

export interface Character {
  id: string;
  name: string;
  aliases: string[];
  dynasty: string;
  dynastyAlt?: string[];
  gender: Gender;
  birth: number | null;
  death: number | null;
  birthplace: string | null;
  birthProvince: string | null;
  roles: string[];
  tags: string[];
  emperor: boolean;
  notable: string;
  difficulty: number;
  externalId?: string;
  /** 软删除：不再参与抽样，但在途对局仍可正常揭晓 */
  retired?: boolean;
}

/** 受控属性枚举：只有这些属性允许被"确定性判定" */
export const ATTRS = [
  'dynasty',
  'eraBefore',
  'eraAfter',
  'gender',
  'emperor',
  'role',
  'birthplace',
  'birthEra',
  'nameLength',
  'nameContains',
  'lifespan',
  'alive',
  'nationality',
  'event',
  'other',
] as const;

export type Attr = (typeof ATTRS)[number];

export type Verdict = 'yes' | 'no' | 'unknown';

/**
 * 回答模式：
 * - strict：只给 是 / 否 / 无法判断
 * - guided：在答案后补一句判定口径说明，降低误解概率（等于降难度）
 */
export type AnswerMode = 'strict' | 'guided';

/** 性别词风格：normal=保留他/她；neutral=统一替换为 TA，避免一个字暴露性别 */
export type PronounStyle = 'normal' | 'neutral';

export type CompareOp = 'eq' | 'gte' | 'lte';

export interface ParsedQuery {
  attr: Attr;
  value: string | number | boolean | null;
  op?: CompareOp;
  /** 主观评价类问题（伟大/厉害…），不走判定，直接固定话术 */
  subjective?: boolean;
}

export type Basis =
  | 'index.dynasty'
  | 'index.eraBefore'
  | 'index.eraAfter'
  | 'index.gender'
  | 'index.emperor'
  | 'index.role'
  | 'index.birthplace'
  | 'index.birthEra'
  | 'index.nameLength'
  | 'index.nameContains'
  | 'index.lifespan'
  | 'index.alive'
  | 'index.nationality'
  | 'index.event'
  | 'subjective'
  | 'knowledge'
  | 'evidence'
  | 'fallback';

export interface AnswerRecord {
  seq: number;
  question: string;
  query: ParsedQuery | null;
  verdict: Verdict;
  text: string;
  /** guided 模式下的口径说明；strict 模式恒为空 */
  hint?: string;
  basis: Basis;
  calls: number;
  ms: number;
  /** 问法不是有效的是/否问题：不扣次数、不换回合 */
  invalid?: 'format';
  /** 基础设施故障（超时/网络）：不算次数，可重试 */
  transient?: boolean;
}

export type SessionStatus = 'playing' | 'won' | 'revealed';

export interface SoloSession {
  id: string;
  /** 服务端唯一持有，任何下行 DTO 都不得包含 */
  targetId: string;
  difficulty: number;
  dynasty: string | null;
  mode: AnswerMode;
  pronoun: PronounStyle;
  turnsLeft: number;
  status: SessionStatus;
  history: AnswerRecord[];
  createdAt: number;
  updatedAt: number;
}

/** AI 凭据：MVP 只实现 byok；platform 为 Steam 平台代调预留 */
export interface ByokCredential {
  kind: 'byok';
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
}

export interface PlatformCredential {
  kind: 'platform';
  ticket: string;
}

export type AiCredential = ByokCredential | PlatformCredential;
