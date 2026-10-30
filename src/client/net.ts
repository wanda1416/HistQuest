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
};
