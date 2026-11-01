/**
 * 领域模型：前后端共享、可被任何运行环境引用（浏览器 / Node / Electron 主进程）。
 * 注意：本项目用 Node 原生类型擦除运行 .ts，因此禁止使用 enum / namespace / 参数属性。
 */

export const DYNASTIES = [
  '史前', '商', '西周', '春秋', '战国', '秦', '西汉', '东汉', '三国', '西晋', '东晋',
  '南北朝', '隋', '唐', '五代', '北宋', '南宋', '辽', '金', '西夏', '大理',
  '蒙古', '元', '明', '清', '近代',
] as const;

export type Dynasty = (typeof DYNASTIES)[number];

/**
 * 时期组：大厅筛选用（9 组比 26 个朝代好选），索引裁定仍按具体朝代。
 * 注意「宋辽金夏」是并存政权组：组内朝代互不归并（辽代条目问「它是宋朝的吗」
 * 必须答否），与「汉=西汉+东汉」这类合并组方向相反——见 core/index.ts 的
 * DYNASTY_GROUPS（合并）/ 本表（仅分组展示）。
 */
export const PERIOD_GROUPS = [
  { key: 'prehistory', label: '史前传说', dynasties: ['史前'] },
  { key: 'xianqin', label: '先秦', dynasties: ['商', '西周', '春秋', '战国'] },
  { key: 'qinhan', label: '秦汉', dynasties: ['秦', '西汉', '东汉'] },
  { key: 'weijin', label: '魏晋南北朝', dynasties: ['三国', '西晋', '东晋', '南北朝'] },
  { key: 'suitang', label: '隋唐五代', dynasties: ['隋', '唐', '五代'] },
  {
    key: 'songliao',
    label: '宋辽金夏',
    dynasties: ['北宋', '南宋', '辽', '金', '西夏', '大理'],
  },
  { key: 'yuan', label: '元', dynasties: ['蒙古', '元'] },
  { key: 'mingqing', label: '明清', dynasties: ['明', '清'] },
  { key: 'modern', label: '近现代', dynasties: ['近代'] },
] as const;

/** 中国条目所属时期组；世界条目走 worldEra，不在此体系 */
export function periodOf(polity: string): string | null {
  return PERIOD_GROUPS.find((g) => (g.dynasties as readonly string[]).includes(polity))?.key ?? null;
}

/** 文明圈：决定抽样权重与筛选，不参与问答判定 */
export const REGIONS = [
  'cn',
  'europe',
  'west-asia',
  'south-asia',
  'east-asia',
  'africa',
  'americas',
  'oceania',
] as const;

export type Region = (typeof REGIONS)[number];

/**
 * 世界人物的时期划分（仅单选「世界」时用于筛选）。
 * 按史学常用的文明高峰与时代分期，数量与中国朝代相当。
 */
export const WORLD_ERAS = [
  '古埃及',
  '两河流域',
  '古希腊',
  '古罗马',
  '古波斯',
  '古印度',
  '中世纪',
  '蒙古与奥斯曼',
  '日本战国',
  '朝鲜王朝',
  '文艺复兴',
  '大航海时代',
  '科学革命',
  '启蒙时代',
  '19 世纪上半叶',
  '19 世纪下半叶',
  '20 世纪初',
] as const;

export type WorldEra = (typeof WORLD_ERAS)[number];

export const REGION_LABELS: Record<Region, string> = {
  cn: '中国',
  europe: '欧洲',
  'west-asia': '西亚北非',
  'south-asia': '南亚',
  'east-asia': '东亚（中国以外）',
  africa: '撒哈拉以南非洲',
  americas: '美洲',
  oceania: '大洋洲',
};

export type Gender = 'male' | 'female';

/**
 * 谜底类别：人物之外新增事件与物品。
 * 数据层三类共用一张 characters 表（gender/emperor 等人物专用列对
 * 事件/物品填占位值），判定层按类别分流——见 judge.ts / prompts.ts。
 */
export const CATEGORIES = ['character', 'event', 'item'] as const;
export type TargetCategory = (typeof CATEGORIES)[number];

export const CATEGORY_LABELS: Record<TargetCategory, string> = {
  character: '人物',
  event: '事件',
  item: '物品',
};

export function isTargetCategory(v: unknown): v is TargetCategory {
  return typeof v === 'string' && (CATEGORIES as readonly string[]).includes(v);
}

export interface Character {
  id: string;
  /** 谜底类别；缺省为人物（老数据无此列） */
  category?: TargetCategory;
  name: string;
  aliases: string[];
  /** 文明圈：中国区为 cn，世界人物按大区归类 */
  region: Region;
  /**
   * 所属政权/朝代。
   * 人物：中国区取 DYNASTIES 中的值（唐/宋/明…），世界区取政权名；
   * 事件：发生时期（严格分期）；物品：制造年代所属时期。
   */
  polity: string;
  /** 人物实际经历过的其他时期/政权 */
  polityAlt?: string[];
  /** 世界条目的时期划分；中国条目为 null */
  worldEra?: WorldEra | null;
  /** 世界条目的原政权/王朝名（era 合并后从主字段降级至此，仅展示用） */
  regime?: string;
  /** 人物专用；事件/物品填 'male' 占位（列 NOT NULL），判定层按类别忽略 */
  gender: Gender;
  birth: number | null;
  /** 人物=卒年；事件/物品恒为 null */
  death: number | null;
  /** 人物=籍贯；事件=发生地；物品=出土地（传世品填「传世」） */
  birthplace: string | null;
  /** 人物=今属国家；物品=现藏机构；事件=null */
  country?: string | null;
  /** 中国区的今属省份；世界条目留空（可缺省） */
  birthProvince?: string | null;
  /** 人物=身份；事件/物品=类型（战役/条约；青铜器/书画） */
  roles: string[];
  tags: string[];
  /** 是否为君主（皇帝/国王/法老/苏丹/沙皇等）；仅人物使用 */
  emperor: boolean;
  /** 类别语义随类别变化：人物=事迹；事件=经过与结果；物品=简介 */
  notable: string;
  difficulty: number;
  externalId?: string;
  /** 软删除：不再参与抽样，但在途对局仍可正常揭晓 */
  retired?: boolean;
}

/**
 * 受控属性枚举：只有这些属性允许被"确定性判定"。
 * v8 精简后仅剩朝代——其余维度由模型知识作答、资料校对，
 * 模型返回的其他 attr 值一律归一为 other。
 */
export const ATTRS = [
  'dynasty',
  'other',
] as const;

export type Attr = (typeof ATTRS)[number];

export type Verdict = 'yes' | 'no' | 'unknown';

/**
 * 回答模式：
 * - strict：只给 是 / 否 / 无法判断
 * - guided：在答案后补一句判定口径说明，降低误解概率（等于降难度）
 * - assist：更低难度——模型判定后主动给一句方向性提示（往对的方向推一把，
 *   如「是，但并非自行登基称帝」），仍不揭示名称与别称
 */
export type AnswerMode = 'strict' | 'guided' | 'assist';

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
  | 'index.century'
  | 'index.alive'
  | 'index.nationality'
  | 'index.event'
  | 'index.name'
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
  /** 玩家在提问中直接说出目标名号：猜中，本局获胜（不扣次数） */
  hit?: boolean;
  /** 基础设施故障（超时/网络）：不算次数，可重试 */
  transient?: boolean;
}

export type SessionStatus = 'playing' | 'won' | 'revealed';

export interface SoloSession {
  id: string;
  /** 服务端唯一持有，任何下行 DTO 都不得包含 */
  targetId: string;
  /** 玩家所选类别（mixed 保持 mixed）；真实类别只在服务端判定与历史账本里 */
  category?: TargetCategory | 'mixed';
  difficulty: number;
  /** 玩家筛选的政权（中国朝代），null = 不限 */
  polity: string | null;
  /** 开局锁定的文明圈筛选，null = 不限 */
  region: Region | null;
  /** 世界模式下锁定的时期，null = 不限 */
  worldEra: string | null;
  /** 混合模式下中国人物占比 0–1 */
  cnShare: number;
  mode: AnswerMode;
  pronoun: PronounStyle;
  turnsLeft: number;
  status: SessionStatus;
  history: AnswerRecord[];
  createdAt: number;
  updatedAt: number;
  /** 归属玩家（Workers 用户系统）；游客为 null */
  userId?: string | null;
  /** 用户名快照（改名不断联） */
  userName?: string | null;
  /** 挑战局：出题人的挑战码（提问额度记在出题人头上） */
  challengeCode?: string | null;
  /** 玩家 IP（审计用；只在开局时写入 games 账本，不随会话持久化） */
  playerIp?: string | null;
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
