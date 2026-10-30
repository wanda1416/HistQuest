import express from 'express';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { hashPassword, verifyPassword } from '../core/password.ts';
import {
  SESSION_TTL_SECONDS,
  clearSessionCookieHeader,
  readSessionCookie,
  sessionCookieHeader,
  signSession,
  verifySessionToken,
} from '../core/session-token.ts';
import { log } from './util.ts';

/**
 * 账号系统（本地 Node 版）。
 *
 * 与 Workers 端 workers/auth.ts 同构：邀请码注册、PBKDF2 口令、HMAC 签名 cookie、
 * users/invites 表结构一致——同一套前端页面在两端都能用。
 *
 * 差异只在密钥来源：Workers 用 SESSION_SECRET 环境变量；
 * Node 单机默认从 app_settings 读/生成（见 ensureSessionSecret），零配置可用。
 */

export interface AuthUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
  allowServerKey: boolean;
  /** 每日配额：-1 跟随全局默认；0 禁用站方模型；>0 自定义上限 */
  dailyQuota: number;
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: string;
  allow_server_key: number;
  banned: number;
  asks_today: number;
  quota_day: number;
  daily_quota: number;
  created_at: number;
  updated_at: number;
}

export const DEFAULT_DAILY_QUOTA = 500;

const USERNAME_RE = /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,20}$/;
const PASSWORD_MIN = 8;

function rowToUser(r: UserRow): AuthUser {
  return {
    id: r.id,
    username: r.username,
    role: r.role === 'admin' ? 'admin' : 'user',
    allowServerKey: Boolean(r.allow_server_key),
    dailyQuota: typeof r.daily_quota === 'number' ? r.daily_quota : -1,
  };
}

function fail(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

function newId(): string {
  return randomBytes(12).toString('hex');
}

function today(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/** 本地 HTTP 不能用 Secure cookie，否则浏览器直接丢弃 */
function secureCookie(req: Request): boolean {
  return req.secure;
}

/* ---------------- 会话签名密钥 ---------------- */

/**
 * 密钥优先级：显式配置 > 库里已存的 > 新生成入库。
 * 存库不是为了防谁，只是保证重启后已登录的 cookie 仍然有效。
 */
export function ensureSessionSecret(db: DatabaseSync, configured?: string): string {
  if (configured) return configured;
  const row = db.prepare("SELECT v FROM app_settings WHERE k = 'session_secret'").get() as
    | { v?: string }
    | undefined;
  if (row?.v) return row.v;
  const secret = randomBytes(32).toString('hex');
  db.prepare("INSERT OR REPLACE INTO app_settings (k, v, updated_at) VALUES ('session_secret', ?, ?)").run(
    secret,
    Date.now(),
  );
  log('auth.secret.created', {});
  return secret;
}

/* ---------------- 读当前用户 ---------------- */

export async function readUser(
  db: DatabaseSync,
  req: Request,
  secret: string,
): Promise<AuthUser | null> {
  const token = readSessionCookie(req.get('cookie') ?? null);
  if (!token) return null;
  const payload = await verifySessionToken(token, secret);
  if (!payload) return null;
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid) as unknown as
    | UserRow
    | undefined;
  if (!row || row.banned) return null;
  return rowToUser(row);
}

export function countUsers(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n?: number } | undefined;
  return row?.n ?? 0;
}

/** 预置管理员（幂等）：配置了 ADMIN_USER / ADMIN_PASSWORD 时在启动阶段调用 */
export async function ensureAdmin(
  db: DatabaseSync,
  username: string,
  password: string,
): Promise<void> {
  if (!username || !password) return;
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return;
  const hash = await hashPassword(password);
  db.prepare(
    `INSERT OR IGNORE INTO users
       (id, username, password_hash, role, allow_server_key, banned, asks_today, quota_day, daily_quota, created_at, updated_at)
     VALUES (?, ?, ?, 'admin', 1, 0, 0, 0, -1, ?, ?)`,
  ).run(newId(), username, hash, Date.now(), Date.now());
  log('auth.admin.ensured', { username });
}

/* ---------------- 配额 ---------------- */

export interface QuotaResult {
  ok: boolean;
  message?: string;
  remaining?: number;
}

/**
 * 站方模型按天计次：-1 用全局默认，0 禁用，>0 自定义。
 * 管理员不受限（与 Workers 一致）。只统计站方 Key 的调用，BYOK 不计。
 */
export function takeQuota(
  db: DatabaseSync,
  user: AuthUser,
  fallback = DEFAULT_DAILY_QUOTA,
): QuotaResult {
  if (user.role === 'admin') return { ok: true };
  const row = db
    .prepare('SELECT asks_today, quota_day, daily_quota FROM users WHERE id = ?')
    .get(user.id) as
    | { asks_today: number; quota_day: number; daily_quota: number }
    | undefined;
  if (!row) return { ok: false, message: '账号不存在' };

  const day = today();
  const used = Number(row.quota_day) === day ? Number(row.asks_today) : 0;
  const limit = Number(row.daily_quota) < 0 ? fallback : Number(row.daily_quota);

  if (limit === 0) return { ok: false, message: '管理员为本账号关闭了站方模型，请在设置里填写自己的模型' };
  if (used >= limit) return { ok: false, message: `今日额度已用完（${limit} 次），明天再来或用自带模型` };

  db.prepare('UPDATE users SET asks_today = ?, quota_day = ?, updated_at = ? WHERE id = ?').run(
    used + 1,
    day,
    Date.now(),
    user.id,
  );
  return { ok: true, remaining: limit - used - 1 };
}

/* ---------------- 用户 / 邀请码（后台用） ---------------- */

export interface UserAdminRow {
  id: string;
  username: string;
  role: string;
  allowServerKey: boolean;
  banned: boolean;
  createdAt: number;
  asksToday: number;
  dailyQuota: number;
}

export function listUsers(db: DatabaseSync, limit = 500): UserAdminRow[] {
  const rows = db
    .prepare(
      `SELECT id, username, role, allow_server_key, banned, created_at, asks_today, quota_day, daily_quota
         FROM users ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as UserRow[];
  const day = today();
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    role: r.role,
    allowServerKey: Boolean(r.allow_server_key),
    banned: Boolean(r.banned),
    createdAt: r.created_at,
    asksToday: Number(r.quota_day) === day ? Number(r.asks_today) : 0,
    dailyQuota: Number(r.daily_quota),
  }));
}

export function findUserRole(db: DatabaseSync, id: string): string | null {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(id) as
    | { role?: string }
    | undefined;
  return row?.role ?? null;
}

export function setUserFlag(
  db: DatabaseSync,
  id: string,
  kind: 'server-key' | 'ban' | 'quota',
  value: boolean | number,
): void {
  const now = Date.now();
  if (kind === 'server-key') {
    db.prepare('UPDATE users SET allow_server_key = ?, updated_at = ? WHERE id = ?').run(
      value ? 1 : 0,
      now,
      id,
    );
  } else if (kind === 'ban') {
    db.prepare('UPDATE users SET banned = ?, updated_at = ? WHERE id = ?').run(value ? 1 : 0, now, id);
  } else {
    db.prepare('UPDATE users SET daily_quota = ?, updated_at = ? WHERE id = ?').run(
      Math.max(-1, Math.round(Number(value) || 0)),
      now,
      id,
    );
  }
}

export interface InviteAdminRow {
  code: string;
  createdAt: number;
  usedAt: number | null;
  usedByName: string | null;
}

export function listInvites(db: DatabaseSync, limit = 200): InviteAdminRow[] {
  const rows = db
    .prepare(
      `SELECT i.code, i.created_at, i.used_at, u.username AS used_by_name
         FROM invites i LEFT JOIN users u ON u.id = i.used_by
        ORDER BY i.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{
    code: string;
    created_at: number;
    used_at: number | null;
    used_by_name: string | null;
  }>;
  return rows.map((r) => ({
    code: r.code,
    createdAt: r.created_at,
    usedAt: r.used_at,
    usedByName: r.used_by_name,
  }));
}

export function createInvites(db: DatabaseSync, count: number, createdBy = 'admin'): string[] {
  const n = Math.min(20, Math.max(1, Math.round(count)));
  const codes: string[] = [];
  const insert = db.prepare(
    'INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)',
  );
  for (let i = 0; i < n; i++) {
    const code = randomBytes(5).toString('hex');
    insert.run(code, createdBy, Date.now());
    codes.push(code);
  }
  return codes;
}

export async function changePassword(
  db: DatabaseSync,
  userId: string,
  current: string,
  next: string,
): Promise<{ ok: boolean; error?: string; message?: string }> {
  if (next.length < PASSWORD_MIN) return { ok: false, error: 'BAD_PASSWORD', message: '新密码至少 8 位' };
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as
    | { password_hash?: string }
    | undefined;
  if (!row?.password_hash) return { ok: false, error: 'NOT_FOUND', message: '账号不存在' };
  if (!(await verifyPassword(current, row.password_hash))) {
    return { ok: false, error: 'BAD_CREDENTIALS', message: '当前密码不对' };
  }
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    await hashPassword(next),
    Date.now(),
    userId,
  );
  return { ok: true };
}

/* ---------------- 路由 ---------------- */

export interface AuthRouteDeps {
  db: DatabaseSync;
  secret: string;
  /** 是否强制邀请码：库里还没有任何账号时自动放行第一个注册者（他成为管理员） */
  inviteRequired?: boolean;
}

export function createAuthRoutes(deps: AuthRouteDeps): express.Router {
  const router = express.Router();
  const db = deps.db;

  router.get('/me', async (req: Request, res: Response) => {
    const user = await readUser(db, req, deps.secret);
    res.json({ user });
  });

  router.post('/register', async (req: Request, res: Response) => {
    const body = req.body as { username?: unknown; password?: unknown; invite?: unknown };
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    const invite = String(body?.invite ?? '').trim();

    if (!USERNAME_RE.test(username)) {
      return fail(res, 400, 'BAD_USERNAME', '用户名 2-20 位，可用字母数字下划线或中文');
    }
    if (password.length < PASSWORD_MIN) {
      return fail(res, 400, 'BAD_PASSWORD', `密码至少 ${PASSWORD_MIN} 位`);
    }

    // 空库的第一个账号直接当管理员：本地单机不需要先造邀请码
    const firstUser = countUsers(db) === 0;
    const requireInvite = deps.inviteRequired !== false && !firstUser;

    if (!firstUser) {
      if (requireInvite && !invite) {
        return fail(res, 403, 'BAD_INVITE', '注册需要邀请码，向管理员索取');
      }
      if (requireInvite) {
        const used = db
          .prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE code = ? AND used_by IS NULL')
          .run('pending', Date.now(), invite);
        if (!Number(used.changes ?? 0)) return fail(res, 403, 'BAD_INVITE', '邀请码无效或已被使用');
      }
    }

    const id = newId();
    const role = firstUser ? 'admin' : 'user';
    try {
      db.prepare(
        `INSERT INTO users
           (id, username, password_hash, role, allow_server_key, banned, asks_today, quota_day, daily_quota, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, 0, 0, 0, -1, ?, ?)`,
      ).run(id, username, await hashPassword(password), role, Date.now(), Date.now());
    } catch (err) {
      if (requireInvite && invite) {
        db.prepare('UPDATE invites SET used_by = NULL, used_at = NULL WHERE code = ?').run(invite);
      }
      const message = String((err as Error)?.message ?? '');
      if (/UNIQUE|constraint/i.test(message)) {
        return fail(res, 409, 'USERNAME_TAKEN', '这个用户名已被使用');
      }
      throw err;
    }
    if (!firstUser && invite) {
      db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(id, invite);
    }

    const token = await signSession(
      { uid: id, role: role === 'admin' ? 'admin' : 'user', exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
      deps.secret,
    );
    log('auth.register', { id, role });
    res
      .status(201)
      .setHeader('set-cookie', sessionCookieHeader(token, { secure: secureCookie(req) }))
      .json({ user: { id, username, role, allowServerKey: true } });
  });

  router.post('/login', async (req: Request, res: Response) => {
    const body = req.body as { username?: unknown; password?: unknown };
    const username = String(body?.username ?? '').trim();
    const password = String(body?.password ?? '');
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as unknown as
      | UserRow
      | undefined;
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      return fail(res, 401, 'BAD_CREDENTIALS', '用户名或密码不对');
    }
    if (row.banned) return fail(res, 403, 'BANNED', '账号已被停用');
    const token = await signSession(
      { uid: row.id, role: row.role === 'admin' ? 'admin' : 'user', exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS },
      deps.secret,
    );
    res
      .setHeader('set-cookie', sessionCookieHeader(token, { secure: secureCookie(req) }))
      .json({ user: rowToUser(row) });
  });

  router.post('/logout', (req: Request, res: Response) => {
    res
      .setHeader('set-cookie', clearSessionCookieHeader({ secure: secureCookie(req) }))
      .json({ ok: true });
  });

  return router;
}
