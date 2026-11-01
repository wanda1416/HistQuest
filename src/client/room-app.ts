import type { RoomCommand, RoomSettings, RoomSnapshot } from '../shared/room.ts';
import { ROOM } from '../shared/room.ts';
import { ApiError, api } from './net.ts';
import { RoomLive } from './live.ts';
import { VoiceInput, attachVoice } from './voice.ts';
import { getState, saveRoomCode, setState } from './store.ts';
import { isRoomRoute, type Route } from './route.ts';

/**
 * 对战四屏的交互与实时通道管理。
 *
 * 为什么单独一个模块而不是塞进 main.ts：main.ts 已经很长，而且这里的逻辑是
 * "只在房间路由下活跃"的一坨自包含行为——路由进出即启停，跟单人对局无关。
 * 它与 main 的协作只有三个口子（见 RoomAppHost），不反向 import，避免循环依赖。
 */

export interface RoomAppHost {
  go: (route: Route, opts?: { replace?: boolean }) => void;
  currentRoute: () => Route | null;
}

export interface RoomApp {
  /** 路由变化时调用：进入房间就建通道，离开就拆 */
  onRoute: (route: Route | null) => void;
}

let live: RoomLive | null = null;
let lobbyTimer: ReturnType<typeof setInterval> | null = null;
let host: RoomAppHost | null = null;

/**
 * 对抗屏的语音输入：与单人（main.ts 的 soloVoice）各持一个实例，
 * 识别出的文字填进 race-ask-input，由玩家点「提问」走同一 dispatch。
 */
const raceVoice = new VoiceInput({
  onState: (state, interim) => setState({ voiceState: state, voiceInterim: interim ?? '' }),
  onText: (text) => {
    const input = document.querySelector<HTMLInputElement>('[data-role="race-ask-input"]');
    if (input && !input.disabled) {
      input.value = text;
      input.focus();
    }
  },
  onError: (message) => setState({ roomError: message }),
});

/* ---------------- 对外 ---------------- */

export function attachRoomApp(root: HTMLElement, appHost: RoomAppHost): RoomApp {
  host = appHost;
  // 🎤 按住说话：pointer 事件在 click 之前触发，voice.ts 里会 stopPropagation
  attachVoice(root, 'race-voice', { targetRole: 'race-ask-input', voice: raceVoice });
  root.addEventListener('click', (event) => {
    const node = event.target as HTMLElement;
    // 点遮罩关掉"我猜是"弹窗
    const mask = node.closest('[data-mask="race-guess"]');
    if (mask && node === mask) {
      setState({ raceGuessOpen: false, raceGuessError: null });
      return;
    }
    const el = node.closest<HTMLElement>('[data-action]');
    if (!el) return;
    const action = el.dataset.action ?? '';
    if (!action.startsWith('room-') && !ROOM_ACTIONS.has(action)) return;
    void handleClick(action, el);
  });

  root.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    const role = form.dataset.role;
    if (role !== 'race-ask-form' && role !== 'join-form') return;
    event.preventDefault();
    const input =
      form.querySelector<HTMLInputElement>('[data-role="race-ask-input"]') ??
      form.querySelector<HTMLInputElement>('[name="code"]');
    const value = input?.value?.trim() ?? '';
    if (!value) return;
    if (role === 'join-form') {
      input!.value = '';
      setState({ joinCode: '' });
      host?.go({ view: 'room', code: value.toUpperCase() });
      return;
    }
    input!.value = '';
    send({ t: 'ask', question: value });
  });

  root.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement;
    if (event.key !== 'Enter') return;
    if (target.getAttribute('data-role') === 'race-guess-input') {
      event.preventDefault();
      void submitGuess();
    }
    if (target.getAttribute('data-role') === 'race-ask-input' && !event.shiftKey) {
      event.preventDefault();
      (target.closest('form') as HTMLFormElement | null)?.requestSubmit();
    }
  });

  root.addEventListener('input', (event) => {
    const el = event.target as HTMLInputElement;
    if (el?.id === 'joinCode') setState({ joinCode: el.value.toUpperCase() });
  });

  return { onRoute };
}

/* ---------------- 路由进出 ---------------- */

function onRoute(route: Route | null): void {
  if (!isRoomRoute(route)) {
    teardownLive();
    stopLobbyPoll();
    if (route?.view === 'rooms') {
      setState({ room: null, roomCode: null, roomError: null });
      void loadRooms();
      startLobbyPoll();
    }
    return;
  }

  stopLobbyPoll();
  const code = route.code;
  saveRoomCode(code);
  setState({ roomCode: code, view: route.view, roomError: null, roomBusy: false, raceGuessOpen: false });

  if (live?.code === code) return;
  teardownLive();
  live = new RoomLive(code, {
    onSnapshot: handleSnapshot,
    onError: (code2, message) => setState({ roomError: message }),
    onChannel: (channel) => setState({ roomChannel: channel }),
  });
  live.start();
  void enterRoom(code);
}

/** 首次进入：join 是幂等的（大厅阶段=参赛，已开局=观战） */
async function enterRoom(code: string): Promise<void> {
  try {
    const snapshot = await api.joinRoom(code);
    handleSnapshot(snapshot);
  } catch (err) {
    const message = err instanceof ApiError ? err.message : '进不了这个房间';
    setState({ roomError: message });
    if (err instanceof ApiError && (err.code === 'NOT_FOUND' || err.code === 'ROOM_CLOSED' || err.code === 'ROOM_FULL' || err.code === 'SPECTATOR_FULL')) {
      host?.go({ view: 'rooms' }, { replace: true });
    }
  }
}

function teardownLive(): void {
  live?.stop();
  live = null;
}

/** 快照到达：更新界面，并把地址栏对齐到当前阶段 */
function handleSnapshot(snapshot: RoomSnapshot): void {
  setState({ room: snapshot, roomBusy: false, roomError: null });

  const route = host?.currentRoute() ?? null;
  if (!isRoomRoute(route) || route.code !== snapshot.code) return;

  const want =
    snapshot.status === 'lobby' ? 'room' : snapshot.status === 'playing' ? 'race' : snapshot.status === 'finished' ? 'review' : null;

  if (!want) {
    setState({ roomError: '房间已经关闭' });
    host?.go({ view: 'rooms' }, { replace: true });
    return;
  }
  if (route.view !== want) host?.go({ view: want, code: snapshot.code }, { replace: true });

  // 猜中或结束：关掉猜答案弹窗
  if (snapshot.status !== 'playing' && getState().raceGuessOpen) {
    setState({ raceGuessOpen: false, raceGuessError: null });
  }
}

/* ---------------- 大厅 ---------------- */

async function loadRooms(): Promise<void> {
  try {
    const res = await api.rooms();
    setState({ rooms: res.items, roomsError: null });
  } catch (err) {
    setState({ rooms: [], roomsError: err instanceof ApiError ? err.message : '载入失败' });
  }
}

function startLobbyPoll(): void {
  stopLobbyPoll();
  lobbyTimer = setInterval(() => {
    if (getState().view !== 'rooms') {
      stopLobbyPoll();
      return;
    }
    void loadRooms();
  }, 3000);
}

function stopLobbyPoll(): void {
  if (lobbyTimer) clearInterval(lobbyTimer);
  lobbyTimer = null;
}

/* ---------------- 动作 ---------------- */

const ROOM_ACTIONS = new Set([
  'go-rooms',
  'refresh-rooms',
  'pick-room-turns',
  'pick-room-difficulty',
  'pick-room-mode',
  'pick-room-scope',
  'pick-room-target-scope',
  'toggle-room-listed',
  'create-room',
  'enter-room',
  'watch-room',
  'copy-room-link',
  'room-start',
  'room-leave',
  'race-guess-open',
  'race-guess-close',
  'race-guess-submit',
  'race-abandon',
  'vote-open',
  'vote-cast',
  'vote-cancel',
  'copy-review-room',
]);

async function handleClick(action: string, el: HTMLElement): Promise<void> {
  const s = getState();

  switch (action) {
    case 'go-rooms':
      host?.go({ view: 'rooms' });
      return;

    case 'refresh-rooms':
      await loadRooms();
      return;

    case 'pick-room-turns':
    case 'pick-room-difficulty':
    case 'pick-room-mode':
    case 'pick-room-scope':
    case 'pick-room-target-scope': {
      const raw = el.dataset.value ?? '';
      const patch = settingsPatch(action, raw);
      if (!patch) return;
      // 在房间里且是房主：直接改服务端设置；在大厅：只是本地建房表单
      if (s.view === 'room' && s.room?.me.role === 'host') {
        send({ t: 'config', patch });
        return;
      }
      applyLocalSettings(patch);
      return;
    }

    case 'toggle-room-listed':
      setState({ roomListed: el.dataset.value === '1' });
      return;

    case 'create-room': {
      setState({ roomBusy: true, roomError: null });
      const st = getState();
      try {
        const snapshot = await api.createRoom({
          listed: st.roomListed,
          settings: {
            turnLimit: st.roomTurnLimit,
            difficulty: st.roomDifficulty,
            mode: st.roomMode,
            region: st.roomScope === 'cn' ? 'cn' : null,
            worldEra: null,
            polity: null,
            cnShare: st.roomScope === 'mixed' ? 0.5 : st.roomScope === 'cn' ? 1 : 0,
            targetScope: st.roomTargetScope,
          },
        });
        saveRoomCode(snapshot.code);
        setState({ room: snapshot, roomBusy: false });
        host?.go({ view: 'room', code: snapshot.code });
      } catch (err) {
        setState({ roomBusy: false, roomError: err instanceof ApiError ? err.message : '建房失败' });
      }
      return;
    }

    case 'enter-room':
    case 'watch-room': {
      const code = el.dataset.code;
      if (code) host?.go({ view: 'room', code });
      return;
    }

    case 'copy-room-link': {
      const code = s.room?.code ?? s.roomCode;
      if (!code) return;
      const ok = await copyText(`${location.origin}/#/room/${code}`);
      setState({ roomError: ok ? null : '复制失败，请手动复制地址栏' });
      if (ok) flashNotice('邀请链接已复制');
      return;
    }

    case 'room-start':
      send({ t: 'start' });
      return;

    case 'room-leave': {
      send({ t: 'leave' });
      saveRoomCode(null);
      host?.go({ view: 'rooms' });
      return;
    }

    case 'race-guess-open':
      setState({ raceGuessOpen: true, raceGuessError: null });
      return;

    case 'race-guess-close':
      setState({ raceGuessOpen: false, raceGuessError: null });
      return;

    case 'race-guess-submit':
      await submitGuess();
      return;

    case 'race-abandon':
      send({ t: 'abandon' });
      return;

    case 'vote-open':
      send({ t: 'open-vote' });
      return;

    case 'vote-cast':
      send({ t: 'cast-vote' });
      return;

    case 'vote-cancel':
      send({ t: 'cancel-vote' });
      return;

    case 'copy-review-room': {
      const text = reviewText(s.room);
      if (!text) return;
      const ok = await copyText(text);
      flashNotice(ok ? '复盘已复制' : '复制失败，浏览器不允许访问剪贴板');
      return;
    }

    default:
      return;
  }
}

/** 猜答案：提交后清空弹窗，结果由快照广播回来 */
async function submitGuess(): Promise<void> {
  const input = document.querySelector<HTMLInputElement>('[data-role="race-guess-input"]');
  const name = input?.value?.trim() ?? '';
  if (!name) {
    setState({ raceGuessError: '先写下你猜的名字' });
    return;
  }
  setState({ raceGuessOpen: false, raceGuessError: null });
  send({ t: 'guess', name });
}

function send(cmd: RoomCommand): void {
  if (!live) {
    setState({ roomError: '连接已断开，正在重连…' });
    return;
  }
  live.send(cmd);
}

/* ---------------- 表单 → 设置 ---------------- */

function settingsPatch(action: string, raw: string): Partial<RoomSettings> | null {
  switch (action) {
    case 'pick-room-turns': {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < ROOM.turnMin || n > ROOM.turnMax) return null;
      return { turnLimit: Math.round(n) };
    }
    case 'pick-room-difficulty': {
      const n = Number(raw);
      return Number.isFinite(n) ? { difficulty: Math.min(3, Math.max(1, Math.round(n))) } : null;
    }
    case 'pick-room-mode':
      return { mode: raw === 'guided' ? 'guided' : 'strict' };
    case 'pick-room-scope':
      return raw === 'cn'
        ? { region: 'cn', cnShare: 1 }
        : raw === 'world'
          ? { region: null, cnShare: 0 }
          : { region: null, cnShare: 0.5 };
    case 'pick-room-target-scope':
      return raw === 'host' ? { targetScope: 'host' } : { targetScope: 'global' };
    default:
      return null;
  }
}

function applyLocalSettings(patch: Partial<RoomSettings>): void {
  const next: Record<string, unknown> = {};
  if (patch.turnLimit !== undefined) next.roomTurnLimit = patch.turnLimit;
  if (patch.difficulty !== undefined) next.roomDifficulty = patch.difficulty;
  if (patch.mode !== undefined) next.roomMode = patch.mode;
  if (patch.cnShare !== undefined) {
    next.roomScope = patch.cnShare === 1 ? 'cn' : patch.cnShare === 0 ? 'world' : 'mixed';
  }
  if (patch.targetScope !== undefined) next.roomTargetScope = patch.targetScope;
  setState(next);
}

/* ---------------- 小工具 ---------------- */

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

let noticeTimer: ReturnType<typeof setTimeout> | null = null;

function flashNotice(text: string): void {
  setState({ notice: { kind: 'info', text } });
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => setState({ notice: null }), 2000);
}

const VERDICT_LABEL: Record<string, string> = { yes: '是', no: '否', unknown: '无法判断' };

/** 复盘导出：把所有人的问答拼成一段可贴到群里的文本 */
function reviewText(room: RoomSnapshot | null): string | null {
  const reveal = room?.reveal;
  if (!reveal) return null;
  const c = reveal.character;
  const lines: string[] = [
    `【猜历史 · 对战复盘】房间 ${room!.code}`,
    `目标：${c.name}（${c.polity}）`,
    `结束方式：${reveal.endReason ?? '—'}`,
    '',
  ];
  for (const p of reveal.players) {
    lines.push(`— ${p.name}（第 ${p.rank} 名，用 ${p.turnsUsed}/${p.turnsTotal} 轮，猜错 ${p.guesses} 次）`);
    for (const t of p.history) {
      const verdict = t.invalid ? '换个问法' : (VERDICT_LABEL[t.verdict] ?? t.verdict);
      lines.push(`  ${t.seq}. ${t.question} → ${verdict}`);
    }
    if (p.flags.length) {
      lines.push(`  ⚠ 可疑提问：${p.flags.map((f) => `第 ${f.seq} 条`).join('、')}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
