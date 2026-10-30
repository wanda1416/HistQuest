import type { AiConfig, AiTestRes, MetaRes, RevealRes, SessionView } from '../shared/protocol.ts';
import type { AnswerMode, PronounStyle } from '../shared/domain.ts';

export type ViewName = 'setup' | 'lobby' | 'game' | 'reveal';

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
  notice: Notice | null;
  testResult: AiTestRes | null;
  guessOpen: boolean;
  copied: boolean;
  saved: string[];
  guessError: string | null;
  difficulty: number;
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
}

const CONFIG_KEY = 'hq.aiConfig';
const PREFS_KEY = 'hq.prefs';
const QUESTIONS_KEY = 'hq.questions';
const GAME_KEY = 'hq.gameId';

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

export function saveGameId(id: string | null): void {
  try {
    if (!id) localStorage.removeItem(GAME_KEY);
    else localStorage.setItem(GAME_KEY, id);
  } catch {
    /* ignore */
  }
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
  notice: null,
  testResult: null,
  guessOpen: false,
  copied: false,
  saved: [],
  guessError: null,
  difficulty: 2,
  polity: null,
  scope: 'mixed',
  worldEra: null,
  cnShare: 0.5,
  mode: 'strict',
  pronoun: 'neutral',
  turns: null,
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
