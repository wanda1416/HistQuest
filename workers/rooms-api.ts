import type { RoomSettings } from '../src/shared/room.ts';
import type { D1Database } from './d1.ts';
import { currentUser } from './auth.ts';

/**
 * 对战房间的 HTTP 面。只做三件事：
 *   1. 鉴权（会话 cookie → userId）
 *   2. 大厅目录（D1 rooms 表）
 *   3. 把请求转发给房间自己的 Durable Object
 *
 * 身份只从 cookie 解析，然后以 x-hq-user-id 注入 DO——DO 永不信任客户端声称的身份。
 */

interface RoomEnv {
  DB: D1Database;
  ROOMS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
  SESSION_SECRET?: string;
}

interface AuthUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

const CODE_RE = /^[A-Z0-9]{4,12}$/;
/** 易读字母表：去掉 0/O/1/I，方便口头报房号 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  let out = '';
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export async function handleRooms(req: Request, url: URL, env: RoomEnv): Promise<Response | null> {
  const path = url.pathname;
  if (!path.startsWith('/api/room')) return null;

  const user = await requireUser(req, env);
  if (!user) return json(401, { error: 'LOGIN_REQUIRED', message: '对战需要登录' });

  /* ---------- 大厅列表 ---------- */
  if (path === '/api/rooms' && req.method === 'GET') {
    const rows = await env.DB.prepare(
      `SELECT code, host_name, status, player_count, max_players, turn_limit, difficulty, created_at
         FROM rooms
        WHERE status IN ('lobby', 'playing') AND listed = 1
        ORDER BY created_at DESC
        LIMIT 50`,
    )
      .bind()
      .all<Record<string, unknown>>();
    return json(200, {
      total: rows.results.length,
      items: rows.results.map((r) => ({
        code: String(r.code),
        hostName: String(r.host_name ?? ''),
        status: String(r.status),
        players: Number(r.player_count ?? 0),
        maxPlayers: Number(r.max_players ?? 8),
        turnLimit: Number(r.turn_limit ?? 20),
        difficulty: Number(r.difficulty ?? 2),
        createdAt: Number(r.created_at ?? 0),
      })),
    });
  }

  /* ---------- 建房 ---------- */
  if (path === '/api/rooms' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      settings?: Partial<RoomSettings>;
      listed?: unknown;
    };
    // 房间码在 D1 里查重（DO 的 id 由码决定，重复码会串房间）
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newCode();
      const taken = await env.DB.prepare('SELECT 1 AS x FROM rooms WHERE code = ?')
        .bind(code)
        .first<{ x: number }>();
      if (taken) continue;
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      const res = await stub.fetch(
        new Request('https://room/new', {
          method: 'POST',
          headers: identity(user),
          body: JSON.stringify({
            code,
            settings: body.settings ?? {},
            listed: body.listed !== false,
          }),
        }),
      );
      const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return json(res.status, out);
    }
    return json(503, { error: 'CODE_EXHAUSTED', message: '房间码分配失败，请重试' });
  }

  /* ---------- 房间级接口 ---------- */
  const match = path.match(/^\/api\/room\/([A-Za-z0-9]{4,12})(?:\/(join|cmd|ws|snapshot))?$/);
  if (!match) return null;
  const code = match[1]!.toUpperCase();
  const action = match[2] ?? 'snapshot';
  if (!CODE_RE.test(code)) return json(400, { error: 'BAD_CODE', message: '房间码不合法' });

  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));

  if (action === 'ws') {
    if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return json(400, { error: 'UPGRADE_REQUIRED', message: '这不是 WebSocket 请求' });
    }
    return stub.fetch(
      new Request(`https://room/ws`, { method: 'GET', headers: { ...identity(user), upgrade: 'websocket' } }),
    );
  }

  if (action === 'join') {
    return stub.fetch(new Request('https://room/join', { method: 'POST', headers: identity(user) }));
  }

  if (action === 'cmd') {
    if (req.method !== 'POST') return json(405, { error: 'METHOD', message: '请用 POST' });
    const body = await req.text();
    return stub.fetch(
      new Request('https://room/cmd', {
        method: 'POST',
        headers: { ...identity(user), 'content-type': 'application/json' },
        body,
      }),
    );
  }

  // snapshot：轮询降级与首屏都走这条
  return stub.fetch(new Request('https://room/snapshot', { method: 'GET', headers: identity(user) }));
}

function identity(user: AuthUser): Record<string, string> {
  const headers: Record<string, string> = { 'x-hq-user-id': user.id };
  if (user.username) headers['x-hq-user-name'] = encodeURIComponent(user.username);
  return headers;
}

async function requireUser(req: Request, env: RoomEnv): Promise<AuthUser | null> {
  if (!env.SESSION_SECRET) return null;
  const user = await currentUser(env.DB, req, env.SESSION_SECRET);
  if (!user) return null;
  return { id: user.id, username: user.username, role: user.role };
}
