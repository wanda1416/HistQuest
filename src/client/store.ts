import type {
  AiConfig,
  AiTestRes,
  HistoryDetail,
  HistorySummary,
  MetaRes,
  RevealRes,
  SessionView,
} from '../shared/protocol.ts';
import type { RoomListItem, RoomSnapshot } from '../shared/room.ts';
import type { AnswerMode, PronounStyle, TargetCategory } from '../shared/domain.ts';

export type ViewName =
  | 'setup'
  | 'lobby'
  | 'game'
  | 'reveal'
  | 'auth'
  | 'history'
  /** 我的题库（自定义条目） */
  | 'mine'
  /** 对战：大厅 */
  | 'rooms'
  /** 对战：房间（未开局） */
  | 'room'
  /** 对战：对抗中 */
  | 'race'
  /** 对战：复盘 */
  | 'review';

export interface Notice {
  kind: 'error' | 'info';
  text: string;
}

export interface State {
  ready: boolean;
  meta: MetaRes | null;
  config: AiConfig | null;
  verified: boolean;
  view: ViewName;
  session: SessionView | null;
  reveal: RevealRes | null;
  pending: boolean;
  /** 已提交、等待判定的问题：提交瞬间先上屏，响应后原位替换 */
  pendingQuestion: string | null;
  notice: Notice | null;
  testResult: AiTestRes | null;
  guessOpen: boolean;
  copied: boolean;
  saved: string[];
  /** 登录/注册页模式 */
  authMode: 'login' | 'register';
  authBusy: boolean;
  authError: string | null;
  guessError: string | null;
  difficulty: number;
  /** 谜底类别：人物 / 事件 / 物品 / 混合 */
  category: TargetCategory | 'mixed';
  /** 中国朝代筛选 */
  polity: string | null;
  /** 开局范围：中国 / 世界 / 混合 */
  scope: 'cn' | 'world' | 'mixed';
  /** 世界模式下选中的时期 */
  worldEra: string | null;
  /** 混合模式下中国人物占比 0–1 */
  cnShare: number;
  mode: AnswerMode;
  pronoun: PronounStyle;
  /** 本局提问轮次；null = 跟随服务端默认 */
  turns: number | null;
  /** 设置存储方式：本地 / 在线 */
  syncMode: 'local' | 'online';
  syncEndpoint: string;
  syncVersion: number;
  syncAt: number;
  syncBusy: boolean;
  syncMessage: string | null;
  syncError: boolean;
  /** 我的对局历史列表；null = 还没加载 */
  history: HistorySummary[] | null;
  historyTotal: number;
  /** 展开的那一局（含完整问答） */
  historyDetail: HistoryDetail | null;
  historyError: string | null;

  /* ---------------- 我的题库（自定义条目） ---------------- */

  /** 服务端列表；null = 还没加载 */
  mineItems: MineTarget[] | null;
  mineError: string | null;
  /** 非 null = 表单态（新建时 id 为空） */
  mineDraft: MineDraft | null;
  mineBusy: boolean;

  /* ---------------- 对战（房间） ---------------- */

  /** 当前房间码；地址栏之外的副本，用于"回到上次的房间" */
  roomCode: string | null;
  /** 房间快照（服务端投影，观战者拿到的没有他人的问答） */
  room: RoomSnapshot | null;
  roomError: string | null;
  /** 实时通道：还没连 / 握手中 / WS / 降级轮询 */
  roomChannel: 'off' | 'connecting' | 'ws' | 'polling';
  /** 大厅列表 */
  rooms: RoomListItem[] | null;
  roomsError: string | null;
  /** 输码加入框里的内容 */
  joinCode: string;
  /** 建房表单 */
  roomTurnLimit: number;
  roomDifficulty: number;
  roomMode: AnswerMode;
  roomScope: 'cn' | 'world' | 'mixed';
  roomListed: boolean;
  /** 猜答案弹窗（对战版，与单人的 guessOpen 分开） */
  raceGuessOpen: boolean;
  raceGuessError: string | null;
  /** 命令在途：按钮防连点 */
  roomBusy: boolean;

  /* ---------------- 语音输入 ---------------- */

  /** 🎤 状态：idle / listening（说话中，interim 显示在 placeholder）/ transcribing / error */
  voiceState: 'idle' | 'listening' | 'transcribing' | 'error' | null;
  /** 说话过程中的中间文字（Web Speech 档才有） */
  voiceInterim: string;
}

/* ---------------- 我的题库 ---------------- */

export interface MineTarget {
  id: string;
  category: 'character' | 'event' | 'item';
  name: string;
  aliases: string[];
  summary: string;
  region: string;
  polity: string;
  worldEra: string | null;
  gender: string;
  birth: number | null;
  death: number | null;
  birthplace: string | null;
  difficulty: number;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  reviewNote: string | null;
  updatedAt: number;
}

/** 表单态：id 为空 = 新建 */
export interface MineDraft {
  id: string;
  category: 'character' | 'event' | 'item';
  name: string;
  aliases: string;
  summary: string;
  region: string;
  polity: string;
  worldEra: string;
  gender: string;
  birth: string;
  death: string;
  birthplace: string;
  difficulty: number;
}

const CONFIG_KEY = 'hq.aiConfig';
const PREFS_KEY = 'hq.prefs';
const QUESTIONS_KEY = 'hq.questions';
const GAME_KEY = 'hq.gameId';
const ROOM_KEY = 'hq.roomCode';
const SYNC_KEY = 'hq.sync';
const SECRET_KEY = 'hq.vaultSecret';
const DEK_KEY = 'hq.dataKey';

export interface SyncPrefs {
  mode: 'local' | 'online';
  endpoint: string;
  version: number;
  at: number;
}

export function loadSync(): SyncPrefs {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<SyncPrefs>;
      return {
        mode: p.mode === 'online' ? 'online' : 'local',
        endpoint: typeof p.endpoint === 'string' ? p.endpoint : '',
        version: Number.isFinite(Number(p.version)) ? Number(p.version) : 0,
        at: Number.isFinite(Number(p.at)) ? Number(p.at) : 0,
      };
    }
  } catch {
    /* 隐私模式下不可读 */
  }
  return { mode: 'local', endpoint: '', version: 0, at: 0 };
}

export function saveSync(patch: Partial<SyncPrefs>): SyncPrefs {
  const next = { ...loadSync(), ...patch };
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
}

/** 管理密钥（Base64）：只存在本机，只派生出 authKey 与 KEK */
export function loadVaultSecret(): string | null {
  try {
    return localStorage.getItem(SECRET_KEY);
  } catch {
    return null;
  }
}

export function saveVaultSecret(value: string | null): void {
  try {
    if (!value) localStorage.removeItem(SECRET_KEY);
    else localStorage.setItem(SECRET_KEY, value);
  } catch {
    /* ignore */
  }
}

/** 数据密钥（Base64）：真正加密设置，换管理密钥时保留它 */
export function loadDataKey(): string | null {
  try {
    return localStorage.getItem(DEK_KEY);
  } catch {
    return null;
  }
}

export function saveDataKey(value: string | null): void {
  try {
    if (!value) localStorage.removeItem(DEK_KEY);
    else localStorage.setItem(DEK_KEY, value);
  } catch {
    /* ignore */
  }
}

export function loadConfig(): AiConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as AiConfig;
    if (!c?.baseURL || !c?.apiKey || !c?.model) return null;
    return c;
  } catch {
    return null;
  }
}

export function saveConfig(config: AiConfig | null): void {
  try {
    if (!config) localStorage.removeItem(CONFIG_KEY);
    else localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
  } catch {
    /* 隐私模式下可能不可写，忽略 */
  }
}

export function loadGameId(): string | null {
  try {
    return localStorage.getItem(GAME_KEY);
  } catch {
    return null;
  }
}

/** 上次所在的房间码：裸域名进来时用来回到那张牌桌 */
export function loadRoomCode(): string | null {
  try {
    return localStorage.getItem(ROOM_KEY);
  } catch {
    return null;
  }
}

export function saveRoomCode(code: string | null): void {
  try {
    if (!code) localStorage.removeItem(ROOM_KEY);
    else localStorage.setItem(ROOM_KEY, code);
  } catch {
    /* ignore */
  }
}

export function saveGameId(id: string | null): void {
  try {
    if (!id) localStorage.removeItem(GAME_KEY);
    else localStorage.setItem(GAME_KEY, id);
  } catch {
    /* ignore */
  }
}

function initialSyncState(): Pick<
  State,
  'syncMode' | 'syncEndpoint' | 'syncVersion' | 'syncAt' | 'syncBusy' | 'syncMessage' | 'syncError'
> {
  const sync = loadSync();
  return {
    syncMode: sync.mode,
    syncEndpoint: sync.endpoint,
    syncVersion: sync.version,
    syncAt: sync.at,
    syncBusy: false,
    syncMessage: null,
    syncError: false,
  };
}

let state: State = {
  ready: false,
  meta: null,
  config: null,
  verified: false,
  view: 'setup',
  session: null,
  reveal: null,
  pending: false,
  pendingQuestion: null,
  notice: null,
  testResult: null,
  guessOpen: false,
  copied: false,
  saved: [],
  authMode: 'login',
  authBusy: false,
  authError: null,
  guessError: null,
  difficulty: 2,
  category: 'character',
  polity: null,
  scope: 'mixed',
  worldEra: null,
  cnShare: 0.5,
  mode: 'strict',
  pronoun: 'neutral',
  turns: null,
  ...initialSyncState(),
  history: null,
  historyTotal: 0,
  historyDetail: null,
  historyError: null,
  mineItems: null,
  mineError: null,
  mineDraft: null,
  mineBusy: false,
  roomCode: loadRoomCode(),
  room: null,
  roomError: null,
  roomChannel: 'off',
  rooms: null,
  roomsError: null,
  joinCode: '',
  roomTurnLimit: 20,
  roomDifficulty: 2,
  roomMode: 'strict',
  roomScope: 'mixed',
  roomListed: true,
  raceGuessOpen: false,
  raceGuessError: null,
  roomBusy: false,
  voiceState: 'idle',
  voiceInterim: '',
};

type Listener = (s: State) => void;
const listeners = new Set<Listener>();

export function getState(): State {
  return state;
}

export function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn(state);
}

/** 静默更新：只改数据不重渲染，用于滑块这类高频输入 */
export function setStateSilent(patch: Partial<State>): void {
  state = { ...state, ...patch };
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 问答偏好：只影响新开的局 */
export function loadPrefs(): { pronoun: PronounStyle; turns: number | null } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { pronoun?: string; turns?: unknown };
      const turns =
        typeof p.turns === 'number' && Number.isFinite(p.turns) && p.turns >= 10
          ? Math.round(p.turns)
          : null;
      return { pronoun: p.pronoun === 'normal' ? 'normal' : 'neutral', turns };
    }
  } catch {
    /* 隐私模式下不可读，用默认值 */
  }
  return { pronoun: 'neutral', turns: null };
}

export function savePrefs(prefs: { pronoun?: PronounStyle; turns?: number | null }): void {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const prev: Record<string, unknown> = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    localStorage.setItem(PREFS_KEY, JSON.stringify({ ...prev, ...prefs }));
  } catch {
    /* ignore */
  }
}

/** 去重用的归一化：忽略首尾标点与空白 */
export function normalizeQuestion(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/[？?！!。，,、；;：:\s]+$/g, '')
    .replace(/\s+/g, '');
}

export function loadQuestions(): string[] {
  try {
    const raw = localStorage.getItem(QUESTIONS_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 24);
  } catch {
    return [];
  }
}

export function saveQuestions(list: string[]): void {
  try {
    localStorage.setItem(QUESTIONS_KEY, JSON.stringify(list.slice(0, 24)));
  } catch {
    /* ignore */
  }
}
