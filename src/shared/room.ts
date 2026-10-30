/**
 * 对战（房间）协议：前后端共享。
 *
 * 规则来源见 docs/MULTIPLAYER.md。要点：
 * - 同一目标人物，每人一条独立提问轨道（问答私有）
 * - 轮次独立，房主开局前定 10–50；猜中即结束，否则过半投票结束
 * - 中途加入者只能是观战者：看得到轮次，看不到任何问答
 * - 结束后全员（含观战者）可见全部问答，用于事后审查
 *
 * 与单人协议的分工：本文件的类型只描述"房间里发生了什么"，
 * 不描述某一局怎么判——判定仍走 core/engine.ts 的 runAsk。
 */
import type { AnswerMode, AnswerRecord, Character, PronounStyle, Region } from './domain.ts';
import type { RecordView } from './protocol.ts';

/** 房间级常量：前端做表单时也用它，避免前后端各写一遍 */
export const ROOM = {
  turnMin: 10,
  turnMax: 50,
  playersMin: 2,
  playersMax: 8,
  spectatorsMax: 20,
  /** 房主离线多久后，投票发起权移交给最早加入的在线玩家 */
  hostHandoverMs: 60_000,
  /** 房间多久无任何事件视为废弃（adapter 用，属清理策略而非游戏规则） */
  idleSweepMs: 6 * 60 * 60 * 1000,
} as const;

export type RoomStatus = 'lobby' | 'playing' | 'finished' | 'closed';

/** host 也是参赛者；spectator 永远不是 */
export type MemberRole = 'host' | 'player' | 'spectator';

/**
 * waiting  = 已进房、未开局
 * playing  = 在局中（还有轮次）
 * guessed  = 猜中（房间随之结束）
 * exhausted= 轮次用尽，仍在房内、仍有投票权、问答照常公开
 * gave_up  = 主动放弃，同上
 * left     = 已离开，不再计入任何统计
 */
export type PlayerStatus = 'waiting' | 'playing' | 'guessed' | 'exhausted' | 'gave_up' | 'left';

/** 房间为什么结束——复盘页要显示这个，事后审查也看它 */
export type EndReason = 'guess' | 'vote' | 'exhausted' | 'last-man' | 'stale' | 'host-closed';

export type RoomError =
  | 'ROOM_CLOSED'
  | 'ROOM_FULL'
  | 'SPECTATOR_FULL'
  | 'NOT_MEMBER'
  | 'NOT_HOST'
  | 'NOT_PLAYER'
  | 'NOT_PLAYING'
  | 'NOT_LOBBY'
  | 'NO_TURNS'
  | 'ASK_PENDING'
  | 'STALE_TICKET'
  | 'TOO_FEW_PLAYERS'
  | 'VOTE_OPEN'
  | 'NO_VOTE'
  | 'ALREADY_VOTED'
  | 'BAD_SETTINGS';

/* ---------------- 设置 ---------------- */

export interface RoomSettings {
  difficulty: number;
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
  /** 每人轮次上限 10–50，全员相同 */
  turnLimit: number;
  /** 参赛人数上限 2–8 */
  maxPlayers: number;
}

export function defaultRoomSettings(): RoomSettings {
  return {
    difficulty: 2,
    polity: null,
    region: null,
    worldEra: null,
    cnShare: 0.5,
    mode: 'strict',
    pronoun: 'neutral',
    turnLimit: 20,
    maxPlayers: 8,
  };
}

const clampInt = (v: unknown, lo: number, hi: number, fb: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fb;
  return Math.min(hi, Math.max(lo, Math.round(n)));
};

/** 房间设置的唯一收敛点：越界一律夹到合法区间，不做静默丢弃 */
export function normalizeSettings(patch: Partial<RoomSettings>, prev: RoomSettings): RoomSettings {
  const pick = <T>(next: T | undefined, fallback: T): T => (next === undefined ? fallback : next);
  const text = (v: unknown, fb: string | null): string | null =>
    v === undefined ? fb : typeof v === 'string' && v.trim() ? v.trim() : null;
  return {
    difficulty: clampInt(pick(patch.difficulty, prev.difficulty), 1, 3, prev.difficulty),
    polity: text(patch.polity, prev.polity),
    region: pick(patch.region, prev.region) ?? null,
    worldEra: text(patch.worldEra, prev.worldEra),
    cnShare: Math.min(1, Math.max(0, Number.isFinite(Number(patch.cnShare)) ? Number(patch.cnShare) : prev.cnShare)),
    mode: pick(patch.mode, prev.mode) === 'guided' ? 'guided' : 'strict',
    pronoun: pick(patch.pronoun, prev.pronoun) === 'normal' ? 'normal' : 'neutral',
    turnLimit: clampInt(patch.turnLimit, ROOM.turnMin, ROOM.turnMax, prev.turnLimit),
    maxPlayers: clampInt(patch.maxPlayers, ROOM.playersMin, ROOM.playersMax, prev.maxPlayers),
  };
}

/* ---------------- 服务端内部状态（永不下行） ---------------- */

export interface RoomMember {
  userId: string;
  /** 用户名快照：改名不断联，也不影响复盘 */
  name: string;
  role: 'host' | 'player';
  status: PlayerStatus;
  turnsTotal: number;
  turnsLeft: number;
  /** 点名猜错的次数（猜中即结束，不在这里累计） */
  guesses: number;
  /** 有效提问数（invalid / transient 不计） */
  asked: number;
  history: AnswerRecord[];
  /** 正在飞的那一问的票据；null = 没有 in-flight */
  pending: string | null;
  online: boolean;
  joinedAt: number;
  finishedAt: number | null;
}

export interface RoomSpectator {
  userId: string;
  name: string;
  joinedAt: number;
  online: boolean;
}

export interface RoomVote {
  by: string;
  at: number;
  /** 票集合：发起即投赞成 */
  votes: string[];
}

/** 投票通过瞬间的现场快照，写进复盘（"谁在几个人在线时把它结束了"） */
export interface EndedVote {
  by: string;
  onlineCount: number;
  need: number;
  onlineIds: string[];
}

export interface Room {
  code: string;
  status: RoomStatus;
  settings: RoomSettings;
  hostId: string;
  /** 参赛者（含房主）；离开的人留在数组里，status='left' */
  members: RoomMember[];
  spectators: RoomSpectator[];
  /** 服务端唯一持有，任何下行都不得包含 */
  targetId: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  winnerId: string | null;
  endReason: EndReason | null;
  vote: RoomVote | null;
  endedVote: EndedVote | null;
  /** 房主掉线起始时刻；回来即清空。用于发起权移交 */
  hostOfflineAt: number | null;
}

/* ---------------- 事件（core 的输入，零 IO） ---------------- */

export type RoomEvent =
  | { t: 'join'; userId: string; name: string }
  | { t: 'leave'; userId: string }
  | { t: 'presence'; userId: string; online: boolean }
  | { t: 'config'; userId: string; patch: Partial<RoomSettings> }
  | { t: 'start'; userId: string; targetId: string }
  | { t: 'ask-start'; userId: string; ticket: string }
  | { t: 'ask-done'; userId: string; ticket: string; record: AnswerRecord; won?: boolean }
  | { t: 'ask-fail'; userId: string; ticket: string }
  | { t: 'guess'; userId: string; correct: boolean }
  | { t: 'abandon'; userId: string }
  | { t: 'open-vote'; userId: string }
  | { t: 'cast-vote'; userId: string }
  | { t: 'cancel-vote'; userId: string }
  | { t: 'close'; by: 'host' | 'stale' | 'system'; userId?: string };

/** core 只说"要做什么"，DO/Node 去执行 */
export type RoomEffect =
  | { t: 'broadcast' }
  | { t: 'call-ask'; userId: string; ticket: string; question: string }
  | { t: 'archive' }
  | { t: 'close' };

/* ---------------- 下行：个性化快照（白名单生成） ---------------- */

export type FlagReason = 'override' | 'ask-answer' | 'encode' | 'structure' | 'long' | 'repeat';

/** 复盘时给每条提问打的"待人工复核"标记（确定性规则，不调模型） */
export interface TurnFlag {
  seq: number;
  question: string;
  reasons: FlagReason[];
}

/**
 * 对手视角：只有进度，没有内容。
 * 这里**故意**不存在 question / verdict / text 字段——投影层不生成，
 * 前端就没有可以泄漏的东西。
 */
export interface RoomPlayerView {
  userId: string;
  name: string;
  isHost: boolean;
  status: PlayerStatus;
  turnsUsed: number;
  turnsTotal: number;
  turnsLeft: number;
  guesses: number;
  online: boolean;
  thinking: boolean;
  /** 1 = 领跑（已猜中 > 轮次用得最多 > 先加入） */
  rank: number;
}

export interface RoomVoteView {
  byName: string;
  /** 当前有效（在线）票数 */
  votes: number;
  need: number;
  onlineCount: number;
  voters: string[];
  mine: boolean;
}

export interface RoomMeView {
  userId: string;
  name: string;
  role: MemberRole;
  status?: PlayerStatus;
  turnsLeft?: number;
  turnsTotal?: number;
  guesses?: number;
  /** 有一问在飞，输入框该锁 */
  pending?: boolean;
  /** 只有参赛者才有；观战者恒为空 */
  history?: RecordView[];
  /** 能否发起结束投票（房主，或房主掉线超时后的最早在线玩家） */
  canOpenVote?: boolean;
}

export interface RoomRevealPlayer {
  userId: string;
  name: string;
  rank: number;
  status: PlayerStatus;
  turnsUsed: number;
  turnsTotal: number;
  guesses: number;
  history: RecordView[];
  flags: TurnFlag[];
  /** 本局给人工复核的观察结论（可为空） */
  notes: string[];
}

export interface RoomReveal {
  character: Character;
  winnerId: string | null;
  endReason: EndReason | null;
  players: RoomRevealPlayer[];
  vote: EndedVote | null;
  spectators: number;
}

export interface RoomSnapshot {
  code: string;
  status: RoomStatus;
  /** 客户端据此算时钟偏移；房间没有倒计时，这里只用于显示耗时 */
  serverNow: number;
  settings: RoomSettings;
  hostId: string;
  me: RoomMeView;
  players: RoomPlayerView[];
  spectators: number;
  vote: RoomVoteView | null;
  winnerId: string | null;
  endReason: EndReason | null;
  startedAt: number | null;
  endedAt: number | null;
  /** 只有 finished 之后才出现（且需要 adapter 传入目标人物） */
  reveal?: RoomReveal;
}

/* ---------------- 上行：命令（WS 与 REST /cmd 共用） ---------------- */

export interface RoomCreateReq {
  settings?: Partial<RoomSettings>;
  /** false = 私有房，只能凭码加入 */
  listed?: boolean;
}

export interface RoomCreateRes {
  code: string;
}

export interface RoomListItem {
  code: string;
  hostName: string;
  status: RoomStatus;
  players: number;
  maxPlayers: number;
  turnLimit: number;
  difficulty: number;
  createdAt: number;
}

export interface RoomListRes {
  total: number;
  items: RoomListItem[];
}

export type RoomCommand =
  | { t: 'leave' }
  | { t: 'config'; patch: Partial<RoomSettings> }
  | { t: 'start' }
  | { t: 'ask'; question: string }
  | { t: 'guess'; name: string }
  | { t: 'abandon' }
  | { t: 'open-vote' }
  | { t: 'cast-vote' }
  | { t: 'cancel-vote' };
