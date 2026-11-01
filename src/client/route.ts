/**
 * 玩家端 URL 路由。
 *
 * 对局状态必须能从地址栏还原：`#/game/<id>` 刷新、换标签页、把链接发给
 * 同一个账号的另一个设备，都应回到同一局。以前只把 id 放在 localStorage，
 * 且恢复条件还要求"本地填过 BYOK"，登录用户一刷新就丢局。
 *
 * 选 hash 而不是路径：管理端（admin.html）已是 hash 路由，这里保持同一套心智，
 * 也不必依赖 express / Vite / Workers assets 三处的 SPA 回退行为。
 *
 * 对战沿用同一套：`#/rooms` 大厅、`#/room/<code>` 房间、`#/race/<code>` 对抗、
 * `#/review/<code>` 复盘。房号本身就是访问凭证，可以直接贴给朋友。
 */

export type Route =
  | { view: 'setup' }
  | { view: 'auth'; invite?: string }
  | { view: 'lobby' }
  | { view: 'game'; id: string }
  | { view: 'reveal'; id: string }
  | { view: 'history'; id: string | null }
  | { view: 'mine' }
  | { view: 'invite' }
  /** 挑战：出题人生成的链接 */
  | { view: 'challenge'; code: string }
  | { view: 'rooms' }
  | { view: 'room'; code: string }
  | { view: 'race'; code: string }
  | { view: 'review'; code: string };

const ID_RE = /^[A-Za-z0-9-]{4,64}$/;
/** 房号：与 workers/rooms-api.ts 的字母表一致（去掉 0/O/1/I） */
const CODE_RE = /^[A-Z0-9]{4,12}$/i;

/** 解析地址栏 hash；无法识别返回 null（调用方走默认视图） */
export function parseRoute(rawHash: string): Route | null {
  const hash = String(rawHash ?? '').replace(/^#/, '');
  const path = hash.startsWith('/') ? hash.slice(1) : hash;
  if (!path) return { view: 'lobby' };

  const parts = path.split('/').filter(Boolean);
  const head = parts[0];
  const tail = parts[1];

  if (head === 'setup' && parts.length === 1) return { view: 'setup' };
  if (head === 'auth' && parts.length === 1) return { view: 'auth' };
  if (head === 'auth' && parts.length === 2 && tail && /^[A-Za-z0-9]{4,32}$/.test(tail)) {
    return { view: 'auth', invite: tail };
  }
  if (head === 'lobby' && parts.length === 1) return { view: 'lobby' };
  if (head === 'rooms' && parts.length === 1) return { view: 'rooms' };
  if (head === 'history' && parts.length === 1) return { view: 'history', id: null };
  if (head === 'mine' && parts.length === 1) return { view: 'mine' };
  if (head === 'invite' && parts.length === 1) return { view: 'invite' };
  if (head === 'c' && parts.length === 2 && tail && CODE_RE.test(tail)) {
    return { view: 'challenge', code: tail.toUpperCase() };
  }
  if (head === 'history' && parts.length === 2 && tail && ID_RE.test(tail)) {
    return { view: 'history', id: tail };
  }
  if (head === 'game' && parts.length === 2 && tail && ID_RE.test(tail)) return { view: 'game', id: tail };
  if (head === 'reveal' && parts.length === 2 && tail && ID_RE.test(tail)) return { view: 'reveal', id: tail };

  if (parts.length === 2 && tail && CODE_RE.test(tail)) {
    const code = tail.toUpperCase();
    if (head === 'room') return { view: 'room', code };
    if (head === 'race') return { view: 'race', code };
    if (head === 'review') return { view: 'review', code };
  }
  return null;
}

/** 路由 → hash（写进地址栏的规范形式） */
export function routeHash(route: Route): string {
  switch (route.view) {
    case 'game':
      return `#/game/${route.id}`;
    case 'reveal':
      return `#/reveal/${route.id}`;
    case 'history':
      return route.id ? `#/history/${route.id}` : '#/history';
    case 'mine':
      return '#/mine';
    case 'invite':
      return '#/invite';
    case 'challenge':
      return `#/c/${route.code}`;
    case 'rooms':
      return '#/rooms';
    case 'room':
      return `#/room/${route.code}`;
    case 'race':
      return `#/race/${route.code}`;
    case 'review':
      return `#/review/${route.code}`;
    case 'setup':
      return '#/setup';
    case 'auth':
      return route.invite ? `#/auth/${route.invite}` : '#/auth';
    default:
      return '#/';
  }
}

/** 这一屏是不是已经显示出来了（用于避免重复拉取；也用于前进后退时判断要不要重载） */
export function isShowing(
  route: Route,
  current: {
    view: string;
    gameId?: string | null;
    historyId?: string | null;
    roomCode?: string | null;
  },
): boolean {
  switch (route.view) {
    case 'game':
      return current.view === 'game' && current.gameId === route.id;
    case 'reveal':
      return current.view === 'reveal' && current.gameId === route.id;
    case 'history':
      return current.view === 'history' && (current.historyId ?? null) === (route.id ?? null);
    case 'room':
    case 'race':
    case 'review':
    case 'challenge':
      return current.view === route.view && (current.roomCode === route.code || current.view === route.view);
    default:
      return current.view === route.view;
  }
}

/** 这个路由是不是"在对战里"（需要保持实时通道） */
export function isRoomRoute(
  route: Route | null,
): route is Extract<Route, { view: 'room' | 'race' | 'review' }> {
  return Boolean(route && (route.view === 'room' || route.view === 'race' || route.view === 'review'));
}
