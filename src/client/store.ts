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
  guessError: string | null;
  difficulty: number;
  dynasty: string | null;
  mode: AnswerMode;
  pronoun: PronounStyle;
}

const CONFIG_KEY = 'hq.aiConfig';
const PREFS_KEY = 'hq.prefs';
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
  guessError: null,
  difficulty: 2,
  dynasty: null,
  mode: 'strict',
  pronoun: 'neutral',
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

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 问答偏好：只影响新开的局 */
export function loadPrefs(): { pronoun: PronounStyle } {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { pronoun?: string };
      return { pronoun: p.pronoun === 'normal' ? 'normal' : 'neutral' };
    }
  } catch {
    /* 隐私模式下不可读，用默认值 */
  }
  return { pronoun: 'neutral' };
}

export function savePrefs(prefs: { pronoun: PronounStyle }): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}
