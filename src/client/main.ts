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
import { closeMenu, isMenuOpen, renderApp, toggleMenu } from './views.ts';
import { renderRoomApp } from './room-views.ts';
import { attachRoomApp } from './room-app.ts';
import { transcriptForGame, transcriptForReview } from './format.ts';
import { isRoomRoute, isShowing, parseRoute, routeHash, type Route } from './route.ts';

const root = document.getElementById('app')!;

const msg = (err: unknown): string =>
  err instanceof ApiError ? err.message : '出了点意外，再试一次';

function render(): void {
  const s = getState();
  const hadFocus =
    document.activeElement?.getAttribute('data-role') === 'ask-input' ||
    document.activeElement?.getAttribute('data-role') === 'race-ask-input';
  const draft = root.querySelector<HTMLInputElement>('[data-role="ask-input"]')?.value ?? '';
  const raceDraft = root.querySelector<HTMLInputElement>('[data-role="race-ask-input"]')?.value ?? '';

  root.innerHTML = isRoomRoute(currentRoute()) || s.view === 'rooms' ? renderRoomApp(s) : renderApp(s);

  if (s.view === 'race') {
    const log = root.querySelector<HTMLElement>('.race-log');
    if (log) {
      log.style.scrollBehavior = 'auto';
      log.scrollTop = log.scrollHeight;
      log.style.scrollBehavior = '';
    }
    const input = root.querySelector<HTMLInputElement>('[data-role="race-ask-input"]');
    if (input && !input.disabled) {
      if (raceDraft) input.value = raceDraft;
      if (hadFocus) input.focus();
    }
  }

  if (s.raceGuessOpen) {
    root.querySelector<HTMLInputElement>('[data-role="race-guess-input"]')?.focus();
  }

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
      category: s.category,
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
    syncUrl({ view: 'game', id: session.gameId });
  } catch (err) {
    setState({ pending: false, notice: { kind: 'error', text: msg(err) } });
  }
}

async function doLogout(): Promise<void> {
  try { await api.logout(); } catch { /* ignore */ }
  const meta = await api.meta().catch(() => null);
  setState({ meta, session: null, reveal: null, history: null, historyDetail: null });
  saveGameId(null);
  go({ view: meta?.authEnabled ? 'auth' : 'lobby' });
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
    // 服务端返回空对象时（历史上少过一个 await）不能一路往下走成 NaN
    if (typeof res?.correct !== 'boolean') {
      setState({ guessError: '服务器没有返回判定结果，请再试一次' });
      return;
    }
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
    // 空/残缺响应必须挡住：渲染层读 reveal.character 会抛错，整页就卡死在这里
    if (!reveal?.character) {
      setState({
        notice: { kind: 'error', text: '揭晓数据不完整，刷新页面或到「历史」里查看这一局' },
        pending: false,
      });
      return;
    }
    setState({ reveal, view: 'reveal', notice: null, guessOpen: false });
    // 局结束了就把地址换成 reveal：刷新仍回到这张人物卡
    syncUrl({ view: 'reveal', id: s.session.gameId }, { replace: true });
  } catch (err) {
    setState({ notice: { kind: 'error', text: msg(err) } });
  }
}

/* ---------------- 我的历史 ---------------- */

async function openHistory(): Promise<void> {
  setState({ view: 'history', historyDetail: null, historyError: null });
  try {
    const res = await api.historyMine();
    setState({ history: res.items, historyTotal: res.total, historyError: null });
  } catch (err) {
    setState({ history: [], historyTotal: 0, historyError: msg(err) });
  }
}

async function openHistoryGame(id: string): Promise<void> {
  try {
    const detail = await api.historyGame(id);
    setState({ view: 'history', historyDetail: detail, historyError: null });
  } catch (err) {
    setState({ historyError: msg(err) });
  }
}

/** 从历史里接着打：只有仍在进行中的局能回到对局界面 */
async function resumeHistoryGame(id: string): Promise<void> {
  // 交给路由：它会判断这局还在不在、该进对局还是揭晓
  go({ view: 'game', id });
}


/* ---------------- 路由：地址栏即事实 ---------------- */

let routing = false;

function currentRoute(): Route | null {
  return parseRoute(location.hash);
}

/** 只改地址栏，不动状态（避免 applyRoute 递归） */
function syncUrl(route: Route, opts: { replace?: boolean } = {}): void {
  const hash = routeHash(route);
  if (location.hash === hash) return;
  if (opts.replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
}

/** 改地址栏并立即应用 */
function go(route: Route, opts: { replace?: boolean } = {}): void {
  syncUrl(route, opts);
  void applyRoute(true);
}

/**
 * 对战四屏的交互与实时通道。它自己不渲染，只在路由进出时启停通道，
 * 并把快照写回 store（渲染统一由 subscribe(render) 触发）。
 */
const roomApp = attachRoomApp(root, { go, currentRoute });

/**
 * 把界面状态对齐到地址栏。
 * 刷新、前进后退、粘贴链接、从历史里续局，全都汇聚到这里，
 * 所以在任何入口都不需要重复写"加载这一局"的代码。
 */
async function applyRoute(force = false): Promise<void> {
  if (routing) return;
  routing = true;
  try {
    const route = currentRoute();
    if (!route) {
      syncUrl({ view: 'lobby' }, { replace: true });
      setState({ view: 'lobby' });
      return;
    }

    const s = getState();
    const showing = isShowing(route, {
      view: s.view,
      gameId: s.session?.gameId ?? null,
      historyId: s.historyDetail?.id ?? null,
      roomCode: s.roomCode,
    });
    if (!force && showing) return;

    // 对战路由：界面由房间快照驱动（进 lobby/playing/finished 自动切屏），
    // 这里只负责把实时通道挂上/拆掉，并把 view 先切过去让壳子先渲染出来。
    roomApp.onRoute(route);
    if (isRoomRoute(route)) return;

    switch (route.view) {
      case 'game':
      case 'reveal': {
        let session = s.session?.gameId === route.id ? s.session : null;
        if (!session) {
          try {
            session = await api.getSolo(route.id);
          } catch {
            saveGameId(null);
            setState({ notice: { kind: 'error', text: '找不到这一局，可能已经过期' } });
            syncUrl({ view: 'lobby' }, { replace: true });
            setState({ view: 'lobby', session: null, reveal: null });
            return;
          }
        }

        if (session.status === 'playing') {
          saveGameId(session.gameId);
          setState({ session, view: 'game', reveal: null, pending: false });
          // 地址写成 reveal 但这局还没结束：拉回对局界面
          if (route.view === 'reveal') syncUrl({ view: 'game', id: route.id }, { replace: true });
          return;
        }

        // 已结束：直接把揭晓还原出来（刷新 #/reveal/<id> 也成立）
        if (s.reveal && s.session?.gameId === route.id) {
          setState({ session, view: 'reveal', pending: false });
        } else {
          try {
            const reveal = await api.reveal(route.id);
            if (!reveal?.character) throw new Error('INCOMPLETE_REVEAL');
            setState({ session, reveal, view: 'reveal', pending: false });
          } catch {
            setState({ session, view: 'game', pending: false });
          }
        }
        if (route.view === 'game') syncUrl({ view: 'reveal', id: route.id }, { replace: true });
        return;
      }

      case 'history':
        setState({ view: 'history' });
        if (route.id) await openHistoryGame(route.id);
        else await openHistory();
        return;

      case 'auth':
        setState({ view: 'auth' });
        return;

      default:
        setState({ view: route.view });
        return;
    }
  } finally {
    routing = false;
  }
}

window.addEventListener('popstate', () => void applyRoute());
window.addEventListener('hashchange', () => void applyRoute());

// 用户菜单：点面板以外的地方关闭（面板内的点击由各自的 data-action 处理）
document.addEventListener('click', (event) => {
  if (!isMenuOpen()) return;
  const el = event.target as HTMLElement | null;
  if (el?.closest('.menu')) return;
  closeMenu();
  render();
});

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
    case 'auth-toggle':
      setState({ authMode: getState().authMode === 'login' ? 'register' : 'login', authError: null });
      break;
    case 'logout':
      closeMenu();
      void doLogout();
      break;
    case 'toggle-menu':
      toggleMenu();
      render();
      break;
    case 'close-menu':
      closeMenu();
      render();
      break;
    case 'go-auth':
      closeMenu();
      go({ view: 'auth' });
      break;
    case 'go-setup':
      closeMenu();
      setState({ testResult: null, notice: null, guessOpen: false });
      go({ view: 'setup' });
      break;
    case 'go-home':
      closeMenu();
      setState({ notice: null, guessOpen: false });
      go({ view: 'lobby' });
      break;
    case 'back': {
      // 返回上一层：历史详情→列表，其余→对局/揭晓/首页
      const st = getState();
      if (st.view === 'history') go({ view: 'history', id: null });
      else if (st.reveal && st.session) go({ view: 'reveal', id: st.session.gameId });
      else if (st.session) go({ view: 'game', id: st.session.gameId });
      else go({ view: 'lobby' });
      break;
    }
    case 'go-history':
      closeMenu();
      go({ view: 'history', id: null });
      break;
    case 'open-history':
      if (el.dataset.id) go({ view: 'history', id: el.dataset.id });
      break;
    case 'resume-history':
      // 续局也走路由：路由会判断这局还在不在、该进对局还是揭晓
      if (el.dataset.id) go({ view: 'game', id: el.dataset.id });
      break;
    case 'history-back':
      go({ view: 'history', id: null });
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
    case 'pick-category': {
      const value = el.dataset.value;
      if (value !== 'character' && value !== 'event' && value !== 'item' && value !== 'mixed') break;
      setState({ category: value });
      break;
    }
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
      setState({ session: null, reveal: null, notice: null });
      go({ view: 'lobby' });
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

root.addEventListener('submit', async (event) => {
  const form = event.target as HTMLFormElement;
  const role = form.dataset.role;
  if (!role) return;
  event.preventDefault();

  if (role === 'auth-form') {
    const val = (name: string) =>
      form.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value?.trim() ?? '';
    const username = val('username');
    const password = form.querySelector<HTMLInputElement>('[name="password"]')?.value ?? '';
    if (!username || !password) {
      setState({ authError: '用户名和密码都要填' });
      return;
    }
    setState({ authBusy: true, authError: null });
    try {
      const s = getState();
      if (s.authMode === 'register') {
        // 是否必须邀请码由服务端判定：空库的第一个账号免邀请码、直接成为管理员，
        // 前端不能在这里先拦下来（否则本地新装环境永远注册不进去）
        await api.register(username, password, val('invite'));
      } else {
        await api.login(username, password);
      }
      // 登录成功：刷新 meta 拿用户态，进开局页
      const meta = await api.meta();
      setState({ meta, authBusy: false });
      // 登录前地址栏里可能就写着某一局/历史：登录后直接回去，而不是丢掉
      const after = currentRoute();
      if (after && (after.view === 'game' || after.view === 'reveal' || after.view === 'history')) {
        await applyRoute(true);
      } else {
        go({ view: 'lobby' });
      }
    } catch (err) {
      setState({ authBusy: false, authError: msg(err) });
    }
    return;
  }

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
      notice: null,
    });
    const session = getState().session;
    go(session ? { view: 'game', id: session.gameId } : { view: 'lobby' });
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
  // 用户菜单：Esc 关闭
  if (event.key === 'Escape' && isMenuOpen()) {
    closeMenu();
    render();
    return;
  }
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

  const m = getState().meta;
  const route = currentRoute();

  // 0) 没登录：先去登录页，地址栏原样保留，登录后再回到原来那一屏
  if (m?.authEnabled && !m.user) {
    setState({ view: 'auth' });
    return;
  }

  // 1) 地址栏里写着具体页面：以地址栏为准（刷新、粘链接、前进后退都走这条）
  if (route && (route.view === 'game' || route.view === 'reveal' || route.view === 'history')) {
    await applyRoute(true);
    const view = getState().view;
    if (view === 'game' || view === 'reveal' || view === 'history') return;
  }

  // 1b) 房间里/大厅：同样以地址栏为准（朋友发来的 `#/room/<code>` 直接进）
  if (route && (isRoomRoute(route) || route.view === 'rooms')) {
    await applyRoute(true);
    const view = getState().view;
    if (isRoomRoute(currentRoute()) || view === 'rooms' || view === 'room' || view === 'race' || view === 'review') {
      return;
    }
  }

  // 2) 地址栏**完全没写页面**（裸域名）时，才退回上次那一局。
  //    `#/` 是用户明确点过「首页」的结果，刷新就该留在首页，不能又被拽回旧对局。
  //    这里以前还多了个 `config` 条件，导致用站方 Key 的登录用户刷新就丢局。
  const bareHash = !location.hash || location.hash === '#';
  const lastId = bareHash ? loadGameId() : null;
  if (lastId) {
    syncUrl({ view: 'game', id: lastId }, { replace: true });
    await applyRoute(true);
    const view = getState().view;
    if (view === 'game' || view === 'reveal') return;
  }

  // 2b) 上次停在某个房间里：裸域名进来直接回那张牌桌
  const lastRoom = bareHash ? getState().roomCode : null;
  if (lastRoom && !lastId) {
    syncUrl({ view: 'room', code: lastRoom }, { replace: true });
    await applyRoute(true);
    if (getState().view === 'room' || getState().view === 'race' || getState().view === 'review') return;
  }

  // 3) 默认落点
  if (route && (route.view === 'setup' || route.view === 'auth')) {
    setState({ view: route.view });
    return;
  }
  if (m?.authEnabled && !m.user) {
    syncUrl({ view: 'auth' }, { replace: true });
    setState({ view: 'auth' });
  } else {
    syncUrl({ view: config || m?.serverModelReady ? 'lobby' : 'setup' }, { replace: true });
    setState({ view: config || m?.serverModelReady ? 'lobby' : 'setup' });
  }
}

void boot();
