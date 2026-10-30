import type { AiConfig, RecordView } from '../shared/protocol.ts';
import { ApiError, api } from './net.ts';
import {
  getState,
  loadConfig,
  loadGameId,
  loadPrefs,
  loadQuestions,
  loadDataKey,
  loadVaultSecret,
  normalizeQuestion,
  saveConfig,
  saveGameId,
  saveDataKey,
  savePrefs,
  saveQuestions,
  saveSync,
  saveVaultSecret,
  setState,
  setStateSilent,
  subscribe,
} from './store.ts';
import { decodeManagementKey, generateKey, keyFromBase64, keyToBase64 } from './vault.ts';
import { applyPayload, normalizeEndpoint, pullVault, pushVault } from './sync.ts';
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
  return { baseURL, apiKey, model };
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
  // 服务器已配模型（CF 部署）：无需本地 BYOK 即可开局
  if (!s.config && !s.meta?.serverModelReady) {
    setState({ view: 'setup', notice: { kind: 'error', text: '先配置模型才能开局' } });
    return;
  }
  setState({ pending: true, notice: null });
  try {
    const session = await api.startSolo({
      difficulty: s.difficulty,
      polity: s.scope === 'cn' ? s.polity : null,
      region: null,
      worldEra: s.scope === 'world' ? s.worldEra : null,
      cnShare: s.scope === 'cn' ? 1 : s.scope === 'world' ? 0 : s.cnShare,
      mode: s.mode,
      pronoun: s.pronoun,
      ...(s.turns ? { turns: s.turns } : {}),
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
  // 服务器已配模型时无需本地 BYOK（CF 部署场景）
  if (!s.session || s.pending) return;
  if (!s.config && !s.meta?.serverModelReady) return;
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

/* ---------------- 设置同步 ---------------- */

function currentSecret(): Uint8Array | null {
  const raw = loadVaultSecret();
  return raw ? keyFromBase64(raw) : null;
}

function currentDataKey(): Uint8Array | null {
  const raw = loadDataKey();
  return raw ? keyFromBase64(raw) : null;
}

function syncEndpoint(): string {
  const input = root.querySelector<HTMLInputElement>('#syncEndpoint');
  return normalizeEndpoint(input?.value ?? getState().syncEndpoint);
}

async function doVaultPush(): Promise<void> {
  const s = getState();
  const secret = currentSecret();
  if (!secret) {
    setState({ syncMessage: '先在「在线」模式下生成管理密钥', syncError: true });
    return;
  }

  const endpoint = syncEndpoint();
  setState({ syncBusy: true, syncMessage: null, syncError: false });
  const result = await pushVault(endpoint, secret, s.syncVersion, currentDataKey());

  // 首次上传会新建数据密钥，必须落到本地
  if (result.dataKey) saveDataKey(keyToBase64(result.dataKey));

  if (!result.ok) {
    setState({ syncBusy: false, syncMessage: result.message ?? '上传失败', syncError: true });
    return;
  }

  const at = Date.now();
  const version = result.version ?? s.syncVersion;
  saveSync({ endpoint, version, at });
  setState({
    syncBusy: false,
    syncEndpoint: endpoint,
    syncVersion: version,
    syncAt: at,
    syncMessage: `已加密上传（版本 ${version}）`,
    syncError: false,
  });
}

async function doVaultPull(): Promise<void> {
  const secret = currentSecret();
  if (!secret) {
    setState({ syncMessage: '先输入管理密钥，或在本机生成一个', syncError: true });
    return;
  }

  const endpoint = syncEndpoint();
  setState({ syncBusy: true, syncMessage: null, syncError: false });
  const result = await pullVault(endpoint, secret);

  if (!result.ok || !result.payload) {
    setState({ syncBusy: false, syncMessage: result.message ?? '恢复失败', syncError: true });
    return;
  }

  if (result.dataKey) saveDataKey(keyToBase64(result.dataKey));
  applyPayload(result.payload);
  const prefs = loadPrefs();
  const at = Date.now();
  const version = result.version ?? 0;
  saveSync({ endpoint, version, at });
  setState({
    syncBusy: false,
    syncEndpoint: endpoint,
    syncVersion: version,
    syncAt: at,
    config: loadConfig(),
    pronoun: prefs.pronoun,
    turns: prefs.turns,
    saved: loadQuestions(),
    syncMessage: '已从云端恢复并覆盖本机设置',
    syncError: false,
  });
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
    case 'pick-turns': {
      const t = Number(el.dataset.value);
      if (Number.isFinite(t) && t >= 10) {
        setState({ turns: Math.round(t) });
        savePrefs({ turns: Math.round(t) });
      }
      break;
    }
    case 'pick-polity':
      setState({ polity: el.dataset.value || null });
      break;
    case 'pick-era':
      setState({ worldEra: el.dataset.value || null });
      break;
    case 'pick-scope': {
      const value = el.dataset.value;
      setState({
        scope: value === 'cn' || value === 'world' ? value : 'mixed',
        ...(value === 'cn' ? { worldEra: null } : {}),
        ...(value === 'world' ? { polity: null } : {}),
      });
      break;
    }
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
    case 'pick-sync-mode': {
      const mode = el.dataset.value === 'online' ? 'online' : 'local';
      if (mode === 'online' && !currentSecret()) {
        saveVaultSecret(keyToBase64(generateKey()));
        saveSync({ version: 0, at: 0 });
      }
      saveSync({ mode });
      setState({ syncMode: mode, syncMessage: null, syncError: false });
      break;
    }
    case 'vault-generate': {
      // 轮换管理密钥：保留数据密钥，新密钥会重新包裹它
      saveVaultSecret(keyToBase64(generateKey()));
      saveSync({ version: 0, at: 0 });
      setState({
        syncVersion: 0,
        syncAt: 0,
        syncMessage: '已生成新的管理密钥；数据密钥不变，重新上传即可',
        syncError: false,
      });
      break;
    }
    case 'vault-import': {
      const input = root.querySelector<HTMLInputElement>('#syncCode');
      const secret = decodeManagementKey(input?.value ?? '');
      if (!secret) {
        setState({ syncMessage: '管理密钥格式不对，请从另一台设备完整复制', syncError: true });
        break;
      }
      saveVaultSecret(keyToBase64(secret));
      saveDataKey(null); // 数据密钥要从云端解包，本地旧值作废
      saveSync({ version: 0, at: 0 });
      setState({
        syncVersion: 0,
        syncAt: 0,
        syncMessage: '已切换到这段管理密钥，现在可以「从云端恢复」',
        syncError: false,
      });
      break;
    }
    case 'vault-push':
      void doVaultPush();
      break;
    case 'vault-pull':
      void doVaultPull();
      break;
    case 'fill-example': {
      const input = root.querySelector<HTMLInputElement>('[data-role="ask-input"]');
      if (input) {
        input.value = el.dataset.value ?? '';
        input.focus();
      }
      break;
    }
    case 'use-question': {
      const input = root.querySelector<HTMLInputElement>('[data-role="ask-input"]');
      if (input) {
        input.value = el.dataset.value ?? '';
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
      break;
    }
    case 'save-question': {
      const text = (el.dataset.value ?? '').trim();
      if (!text) break;
      const current = getState().saved;
      if (current.some((q) => normalizeQuestion(q) === normalizeQuestion(text))) break;
      const next = [text, ...current].slice(0, 24);
      saveQuestions(next);
      setState({ saved: next });
      break;
    }
    case 'drop-question': {
      const target = normalizeQuestion(el.dataset.value ?? '');
      const next = getState().saved.filter((q) => normalizeQuestion(q) !== target);
      saveQuestions(next);
      setState({ saved: next });
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

root.addEventListener('input', (event) => {
  const el = event.target as HTMLInputElement;
  if (el?.getAttribute('data-field') !== 'cn-share') return;
  // 滑块不重渲染，否则会丢失拖拽焦点
  setStateSilent({ cnShare: Number(el.value) / 100 });
  const label = root.querySelector<HTMLElement>('[data-role="cn-share-label"]');
  if (label) label.textContent = `${el.value}%`;
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
  setState({ pronoun: prefs.pronoun, turns: prefs.turns, saved: loadQuestions() });
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

  setState({ view: config || getState().meta?.serverModelReady ? 'lobby' : 'setup' });
}

void boot();
