import type { D1Database } from './d1.ts';
import { hashPassword, verifyPassword } from '../src/core/password.ts';
import {
  signSession,
  verifySessionToken,
  sessionCookieHeader,
  clearSessionCookieHeader,
  readSessionCookie,
  SESSION_TTL_SECONDS,
} from '../src/core/session-token.ts';

/**
 * 用户系统：邀请码注册 + 用户名密码登录。
 * 会话：HMAC 签名 HttpOnly cookie，多 isolate 无状态验证。
 * 预置管理员：环境变量 ADMIN_USER / ADMIN_PASSWORD，首次 init 时创建。
 */

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'user' | 'admin';
  allow_server_key: number;
  banned: number;
  created_at: number;
  daily_quota?: number;
}

export interface AuthUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
  allowServerKey: boolean;
  /** 每日配额：-1 跟随全局默认；0 禁用；>0 自定义 */
  dailyQuota?: number | null;
}

function rowToUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    username: r.username,
    role: r.role,
    allowServerKey: Boolean(r.allow_server_key),
    ...(typeof r.daily_quota === 'number' ? { dailyQuota: r.daily_quota } : {}),
  };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/;
const PASSWORD_MIN = 8;

/** 从请求解析当前用户（null = 未登录/无效） */
export async function currentUser(db: D1Database, req: Request, secret: string): Promise<AuthUser | null> {
  const token = readSessionCookie(req.headers.get('cookie'));
  if (!token) return null;
  const payload = await verifySessionToken(token, secret);
  if (!payload) return null;
  const row = await db.prepare('SELECT * FROM users WHERE id = ?').bind(payload.uid).first<UserRow>();
  if (!row || row.banned) return null;
  return rowToUser(row);
}

/** 预置管理员（幂等） */
export async function ensureAdmin(db: D1Database, username: string, password: string): Promise<void> {
  const exists = await db.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (exists) return;
  const hash = await hashPassword(password);
  await db
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, allow_server_key, banned, created_at, updated_at)
       VALUES (?, ?, ?, 'admin', 1, 0, ?, ?)
       ON CONFLICT(username) DO NOTHING`,
    )
    .bind(crypto.randomUUID().replace(/-/g, ''), username, hash, Date.now(), Date.now())
    .run();
}

export async function handleAuth(
  db: D1Database,
  req: Request,
  url: URL,
  secret: string,
  inviteMode: boolean,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api\/auth/, '');

  // ---------- 当前用户 ----------
  if (path === '/me' && req.method === 'GET') {
    const user = await currentUser(db, req, secret);
    if (!user) return json(200, { user: null });
    return json(200, { user });
  }

  // ---------- 注册（邀请码） ----------
  if (path === '/register' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as {
      username?: unknown;
      password?: unknown;
      invite?: unknown;
    };
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const invite = String(body.invite ?? '').trim();

    if (!USERNAME_RE.test(username)) {
      return json(400, { error: 'BAD_USERNAME', message: '用户名 2-20 位，可用字母数字下划线或中文' });
    }
    if (password.length < PASSWORD_MIN) {
      return json(400, { error: 'BAD_PASSWORD', message: `密码至少 ${PASSWORD_MIN} 位` });
    }

    // 邀请码核销（原子：UPDATE ... WHERE used_by IS NULL，changes=0 即已被用/不存在）
    const used = await db
      .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
      .bind('pending', Date.now(), invite)
      .run();
    if (!used.meta?.changes) {
      return json(403, { error: 'BAD_INVITE', message: '邀请码无效或已被使用' });
    }

    const hash = await hashPassword(password);
    const id = crypto.randomUUID().replace(/-/g, '');
    try {
      await db
        .prepare(
          `INSERT INTO users (id, username, password_hash, role, allow_server_key, banned, created_at, updated_at)
           VALUES (?, ?, ?, 'user', 1, 0, ?, ?)`,
        )
        .bind(id, username, hash, Date.now(), Date.now())
        .run();
      // 回填邀请码使用人
      await db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').bind(id, invite).run();
    } catch (err) {
      // 用户名冲突：归还邀请码
      await db.prepare('UPDATE invites SET used_by = NULL, used_at = NULL WHERE code = ?').bind(invite).run();
      const msg = String((err as Error)?.message ?? '');
      if (msg.includes('UNIQUE') || msg.includes('constraint')) {
        return json(409, { error: 'USERNAME_TAKEN', message: '这个用户名已被使用' });
      }
      throw err;
    }

    const token = await signSession({ uid: id, role: 'user', exp: nowExp() }, secret);
    return json(201, { user: { id, username, role: 'user', allowServerKey: true } }, {
      'set-cookie': sessionCookieHeader(token),
    });
  }

  // ---------- 登录 ----------
  if (path === '/login' && req.method === 'POST') {
    const body = (await req.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const username = String(body.username ?? '').trim();
    const password = String(body.password ?? '');
    const row = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>();
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return json(401, { error: 'BAD_CREDENTIALS', message: '用户名或密码不对' });
    }
    if (row.banned) {
      return json(403, { error: 'BANNED', message: '账号已被停用' });
    }
    const token = await signSession({ uid: row.id, role: row.role, exp: nowExp() }, secret);
    return json(200, { user: rowToUser(row) }, { 'set-cookie': sessionCookieHeader(token) });
  }

  // ---------- 登出 ----------
  if (path === '/logout' && req.method === 'POST') {
    return json(200, { ok: true }, { 'set-cookie': clearSessionCookieHeader() });
  }

  return json(404, { error: 'NOT_FOUND', message: '接口不存在' });
}

function nowExp(): number {
  return Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
}
