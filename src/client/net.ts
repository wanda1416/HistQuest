import type {
  AiConfig,
  AiTestRes,
  AskRes,
  GuessRes,
  HistoryDetail,
  HistoryListRes,
  MetaRes,
  RevealRes,
  SessionView,
  StartSoloReq,
} from '../shared/protocol.ts';
import type { RoomCommand, RoomCreateReq, RoomListRes, RoomSnapshot } from '../shared/room.ts';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const FRIENDLY: Record<string, string> = {
  MODEL_NOT_CONFIGURED: '还没有配置模型，先到设置里填好地址和密钥',
  AI_AUTH: '密钥无效或无权限，请到设置里检查',
  AI_RATE: '模型服务限流了，稍等一会儿再问',
  AI_TIMEOUT: '模型响应超时了，这一步不算次数，再问一次',
  AI_NETWORK: '连不上模型服务，检查一下 API 地址',
  AI_BAD_JSON: '模型返回格式异常，换个问法试试',
  RATE_LIMITED: '问得太快了，缓一缓',
  NOT_FOUND: '找不到这一局，可能已经过期',
  NOT_PLAYING: '本局已经结束了',
  NO_TURNS: '提问次数用完了',
  EMPTY_QUESTION: '先写下你的问题',
  SERVER_ERROR: '服务器出了点问题',
  /* 对战 */
  LOGIN_REQUIRED: '对战需要先登录',
  ROOM_CLOSED: '房间已经关闭',
  ROOM_FULL: '这个房间人满了',
  SPECTATOR_FULL: '观战位满了',
  NOT_MEMBER: '你不在这个房间里',
  NOT_HOST: '只有房主能做这件事',
  NOT_LOBBY: '对局已经开始，不能再改',
  ASK_PENDING: '上一问还在等模型回答',
  TOO_FEW_PLAYERS: '至少要两个人才开始',
  ALREADY_VOTED: '你已经投过票了',
  VOTE_OPEN: '已经有一个投票在进行',
  NO_VOTE: '当前没有投票',
  BAD_CODE: '房间码不合法',
  CODE_EXHAUSTED: '房间码分配失败，请重试',
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'OFFLINE', '连不上本地服务，确认它还在运行');
  }

  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { error?: string; message?: string })
    | null;

  if (!res.ok) {
    const code = String(data?.error ?? 'UNKNOWN');
    const message = FRIENDLY[code] ?? String(data?.message ?? '请求失败');
    throw new ApiError(res.status, code, message);
  }
  return data as T;
}

function jsonInit(body: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export const api = {
  meta: () => request<MetaRes>('/api/meta'),

  login: (username: string, password: string) =>
    request<{ user: unknown }>('/api/auth/login', jsonInit({ username, password })),

  register: (username: string, password: string, invite: string) =>
    request<{ user: unknown }>('/api/auth/register', jsonInit({ username, password, invite })),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', jsonInit({})),

  testAi: (cfg: AiConfig) =>
    request<AiTestRes>('/api/ai/test', jsonInit({ baseURL: cfg.baseURL, apiKey: cfg.apiKey, model: cfg.model })),

  startSolo: (input: StartSoloReq) => request<SessionView>('/api/solo', jsonInit(input)),

  getSolo: (id: string) => request<SessionView>(`/api/solo/${encodeURIComponent(id)}`),

  ask: (id: string, question: string, aiConfig?: AiConfig | null) =>
    request<AskRes>(`/api/solo/${encodeURIComponent(id)}/ask`, jsonInit({ question, aiConfig })),

  guess: (id: string, name: string) =>
    request<GuessRes>(`/api/solo/${encodeURIComponent(id)}/guess`, jsonInit({ name })),

  reveal: (id: string) =>
    request<RevealRes>(`/api/solo/${encodeURIComponent(id)}/reveal`, jsonInit({})),

  /** 我的对局历史 */
  historyMine: () => request<HistoryListRes>('/api/history/mine'),

  historyGame: (id: string) =>
    request<HistoryDetail>(`/api/history/mine/${encodeURIComponent(id)}`),

  /* ---------------- 我的题库（自定义条目） ---------------- */

  mineList: () => request<{ items: unknown[] }>('/api/custom-targets'),

  mineCreate: (body: unknown) => request<{ target: unknown }>('/api/custom-targets', jsonInit(body)),

  mineUpdate: (id: string, body: unknown) =>
    request<{ target: unknown }>(`/api/custom-targets/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),

  mineSubmit: (id: string) =>
    request<{ target: unknown }>(`/api/custom-targets/${encodeURIComponent(id)}/submit`, jsonInit({})),

  mineDelete: (id: string) =>
    request<{ ok: boolean }>(`/api/custom-targets/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** 出题：生成挑战链接（幂等） */
  mineChallenge: (id: string) =>
    request<{ code: string; url: string }>(`/api/custom-targets/${encodeURIComponent(id)}/challenge`, jsonInit({})),

  /** 挑战页信息（不含谜底；quotaOk=false = 出题人今日额度用完） */
  challengeInfo: (code: string) =>
    request<{ code: string; mode: 'custom' | 'random'; category: string | null; difficulty: number | null; creator: string; quotaOk: boolean }>(`/api/challenge/${encodeURIComponent(code)}`),

  /** 随机出题：公共题库按范围抽谜底 */
  randomChallenge: (settings: { difficulty: number; category: string; polity?: string; region?: string; worldEra?: string }) =>
    request<{ code: string; url: string }>('/api/challenges', jsonInit(settings)),

  /** 我的挑战列表 */
  myChallenges: () => request<{ items: unknown[] }>('/api/challenges/mine'),

  /** 挑战的玩家记录（仅出题人可见；匿名显示 IP） */
  challengePlays: (code: string) =>
    request<{ items: unknown[] }>(`/api/challenge/${encodeURIComponent(code)}/plays`),

  /* ---------------- 对战（房间） ---------------- */

  rooms: () => request<RoomListRes>('/api/rooms'),

  createRoom: (input: RoomCreateReq) => request<RoomSnapshot>('/api/rooms', jsonInit(input)),

  joinRoom: (code: string) =>
    request<RoomSnapshot>(`/api/room/${encodeURIComponent(code)}/join`, jsonInit({})),

  roomSnapshot: (code: string) => request<RoomSnapshot>(`/api/room/${encodeURIComponent(code)}`),

  roomCmd: (code: string, cmd: RoomCommand) =>
    request<RoomSnapshot>(`/api/room/${encodeURIComponent(code)}/cmd`, jsonInit(cmd)),

  /** 语音识别：音频 → 文字（只填输入框，不直接进 ask） */
  transcribe: (form: FormData) =>
    request<{ text: string; ms: number }>('/api/ai/transcribe', { method: 'POST', body: form }),
};

/** 房间的 WebSocket 地址（同源，靠会话 cookie 鉴权） */
export function roomSocketUrl(code: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/room/${encodeURIComponent(code)}/ws`;
}
