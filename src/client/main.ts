import type { AiConfig, RecordView } from '../shared/protocol.ts';
import { ApiError, api } from './net.ts';
import {
  getState,
  loadConfig,
  loadGameId,
  loadPrefs,
  saveConfig,
  saveGameId,
  savePrefs,
  setState,
  subscribe,
} from './store.ts';
import { renderApp } from './views.ts';
import { transcriptForGame, transcriptForReview } from './format.ts';

const root = document.getElementById('app')!;

const msg = (err: unknown): string =>
  err instanceof ApiError ? err.message : '出了点意外，再试一次';

function render(): void {
  const s = getState();
  const hadFocus = document.activeElement?.getAttribute('data-role') === 'ask-input';
  const draft = root.querySelector<HTMLInputElement>('[data-role="ask-input"]')?.value ?? '';

  root.innerHTML = renderApp(s);

  if (s.view === 'game') {
    const log = root.querySelector<HTMLElement>('[data-role="log"]');
    if (log) {
      // smooth 滚动会让程序化定位变成动画，先关掉再定位，避免新回答停在可视区外
      log.style.scrollBehavior = 'auto';
      log.scrollTop = log.scrollHeight;
      log.style.scrollBehavior = '';
    }

    const input = root.querySelector<HTMLInputElement>('[data-role="ask-input"]');
    if (input) {
      if (draft) input.value = draft;
      if (!s.pending && (hadFocus || s.session?.history.length === 0)) input.focus();
    }
  }

  if (s.guessOpen) {
    root.querySelector<HTMLInputElement>('[data-role="guess-input"]')?.focus();
  }
}

subscribe(render);

/* ---------------- 动作 ---------------- */

function readFormConfig(): AiConfig | null {
  const val = (name: string) =>
    root.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value?.trim() ?? '';
  const baseURL = val('baseURL');
  const apiKey = val('apiKey');
  const model = val('model');
  if (!baseURL || !apiKey || !model) return null;
  const t = Number(val('temperature'));
  return {
    baseURL,
    apiKey,
    model,
    ...(Number.isFinite(t) ? { temperature: Math.min(1, Math.max(0, t)) } : {}),
  };
}

async function testAi(): Promise<void> {
  const cfg = readFormConfig();
  if (!cfg) {
    setState({ notice: { kind: 'error', text: '地址、密钥、模型名都要填' }, testResult: null });
    return;
  }
  setState({ pending: true, notice: null, testResult: null });
  try {
    const result = await api.testAi(cfg);
    setState({ testResult: result, pending: false });
    if (result.ok) {
      saveConfig(cfg);
      setState({ config: cfg, verified: true });
    }
  } catch (err) {
    setState({ pending: false, testResult: { ok: false, message: msg(err) } });
  }
}

async function startGame(): Promise<void> {
  const s = getState();
  if (!s.config) {
    setState({ view: 'setup', notice: { kind: 'error', text: '先配置模型才能开局' } });
    return;
  }
  setState({ pending: true, notice: null });
  try {
    const session = await api.startSolo({
      difficulty: s.difficulty,
      dynasty: s.dynasty,
      mode: s.mode,
      pronoun: s.pronoun,
      aiConfig: s.config,
    });
    saveGameId(session.gameId);
    setState({ session, view: 'game', pending: false, reveal: null, testResult: null });
  } catch (err) {
    setState({ pending: false, notice: { kind: 'error', text: msg(err) } });
  }
}

async function askQuestion(question: string): Promise<void> {
  const s = getState();
  if (!s.session || !s.config || s.pending) return;
  const text = question.trim();
  if (!text) return;

  setState({ pending: true, notice: null });
  try {
    const res = await api.ask(s.session.gameId, text, s.config);
    const record: RecordView = {
      seq: res.seq,
      question: text,
      verdict: res.verdict,
      text: res.text,
      ...(res.hint ? { hint: res.hint } : {}),
      ...(res.invalid ? { invalid: res.invalid } : {}),
    };
    setState({
      session: {
        ...s.session,
        turnsLeft: res.turnsLeft,
        status: res.status,
        history: [...s.session.history, record],
      },
      pending: false,
    });
    if (res.status !== 'playing') await doReveal();
  } catch (err) {
    setState({ pending: false, notice: { kind: 'error', text: msg(err) } });
  }
}

async function doGuess(): Promise<void> {
  const s = getState();
  if (!s.session) return;
  const name = root.querySelector<HTMLInputElement>('[data-role="guess-input"]')?.value?.trim() ?? '';
  if (!name) {
    setState({ guessError: '先写下你猜的名字' });
    return;
  }

  try {
    const res = await api.guess(s.session.gameId, name);
    if (res.correct) {
      setState({ guessOpen: false, guessError: null, session: { ...s.session, status: res.status } });
      await doReveal();
      return;
    }
    setState({
      guessOpen: false,
      guessError: null,
      session: { ...s.session, turnsLeft: res.turnsLeft, status: res.status },
      notice: { kind: 'info', text: `${res.hint ?? '不是这个人。'}（剩余 ${res.turnsLeft} 问）` },
    });
    if (res.status !== 'playing') await doReveal();
  } catch (err) {
    setState({ guessError: msg(err) });
  }
}

async function doReveal(): Promise<void> {
  const s = getState();
  if (!s.session) return;
  try {
    const reveal = await api.reveal(s.session.gameId);
    setState({ reveal, view: 'reveal', notice: null, guessOpen: false });
  } catch (err) {
    setState({ notice: { kind: 'error', text: msg(err) } });
  }
}

/** 剪贴板：优先 Clipboard API，非安全上下文回落 execCommand */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyTranscript(withTarget: boolean): Promise<void> {
  const s = getState();
  const history = (withTarget ? s.reveal?.history : s.session?.history) ?? s.session?.history ?? [];
  if (!history.length) {
    setState({ notice: { kind: 'info', text: '还没有可复制的问答' } });
    return;
  }

  const text =
    withTarget && s.reveal
      ? transcriptForReview(history, s.reveal.character, s.reveal.turnsUsed)
      : transcriptForGame(history);

  const ok = await copyText(text);
  if (!ok) {
    setState({ notice: { kind: 'error', text: '复制失败，浏览器不允许访问剪贴板' } });
    return;
  }

  setState({ copied: true, notice: null });
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => setState({ copied: false }), 1600);
}

/* ---------------- 事件 ---------------- */

root.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;

  const mask = target.closest('[data-mask]');
  if (mask && target === mask) {
    setState({ guessOpen: false, guessError: null });
    return;
  }

  const el = target.closest<HTMLElement>('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'go-setup':
      setState({ view: 'setup', testResult: null, notice: null, guessOpen: false });
      break;
    case 'back':
      setState({ view: getState().reveal ? 'reveal' : getState().session ? 'game' : 'lobby' });
      break;
    case 'test-ai':
      void testAi();
      break;
    case 'pick-difficulty':
      setState({ difficulty: Number(el.dataset.value) });
      break;
    case 'pick-mode':
      setState({ mode: el.dataset.value === 'guided' ? 'guided' : 'strict' });
      break;
    case 'pick-dynasty':
      setState({ dynasty: el.dataset.value || null });
      break;
    case 'start-game':
      void startGame();
      break;
    case 'open-guess':
      setState({ guessOpen: true, guessError: null });
      break;
    case 'close-guess':
      setState({ guessOpen: false, guessError: null });
      break;
    case 'do-guess':
      void doGuess();
      break;
    case 'reveal':
      void doReveal();
      break;
    case 'copy-log':
      void copyTranscript(false);
      break;
    case 'copy-review':
      void copyTranscript(true);
      break;
    case 'new-game':
      saveGameId(null);
      setState({ view: 'lobby', session: null, reveal: null, notice: null });
      break;
    case 'fill-example': {
      const input = root.querySelector<HTMLInputElement>('[data-role="ask-input"]');
      if (input) {
        input.value = el.dataset.value ?? '';
        input.focus();
      }
      break;
    }
    default:
      break;
  }
});

root.addEventListener('submit', (event) => {
  const form = event.target as HTMLFormElement;
  const role = form.dataset.role;
  if (!role) return;
  event.preventDefault();

  if (role === 'config-form') {
    const cfg = readFormConfig();
    if (!cfg) {
      setState({ notice: { kind: 'error', text: '地址、密钥、模型名都要填' } });
      return;
    }
    saveConfig(cfg);
    const neutral = root.querySelector<HTMLInputElement>('[name="neutralPronoun"]')?.checked ?? true;
    const pronoun = neutral ? 'neutral' : 'normal';
    savePrefs({ pronoun });
    setState({
      config: cfg,
      verified: true,
      pronoun,
      view: getState().session ? 'game' : 'lobby',
      notice: null,
    });
    return;
  }

  if (role === 'ask-form') {
    const input = form.querySelector<HTMLInputElement>('[data-role="ask-input"]');
    const question = input?.value ?? '';
    if (input) input.value = '';
    void askQuestion(question);
  }
});

root.addEventListener('keydown', (event) => {
  const target = event.target as HTMLElement;
  if (event.key !== 'Enter') return;
  if (target.getAttribute('data-role') === 'guess-input') {
    event.preventDefault();
    void doGuess();
  }
  if (target.getAttribute('data-role') === 'ask-input' && !event.shiftKey) {
    event.preventDefault();
    const form = target.closest('form');
    form?.requestSubmit();
  }
});

/* ---------------- 启动 ---------------- */

async function boot(): Promise<void> {
  try {
    const meta = await api.meta();
    setState({ meta, ready: true });
  } catch (err) {
    setState({ ready: true, notice: { kind: 'error', text: msg(err) } });
    return;
  }

  const config = loadConfig();
  const prefs = loadPrefs();
  setState({ pronoun: prefs.pronoun });
  if (config) setState({ config, verified: true });

  const gameId = loadGameId();
  if (config && gameId) {
    try {
      const session = await api.getSolo(gameId);
      if (session.status === 'playing') {
        setState({ session, view: 'game' });
      } else {
        const reveal = await api.reveal(gameId);
        setState({ session, reveal, view: 'reveal' });
      }
      return;
    } catch {
      saveGameId(null);
    }
  }

  setState({ view: config ? 'lobby' : 'setup' });
}

void boot();
