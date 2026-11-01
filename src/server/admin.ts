import express from 'express';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { DYNASTIES, REGIONS, REGION_LABELS, type Region } from '../shared/domain.ts';
import type { Character } from '../shared/domain.ts';
import type { GameResult } from '../shared/protocol.ts';
import type { Issue } from '../core/schema.ts';
import type { TargetStoreLike } from './targets-sqlite.ts';
import type { AuthUser } from './auth.ts';
import {
  changePassword,
  createInvites,
  deleteUser,
  findUserRole,
  listInvites,
  listUsers,
  setUserFlag,
} from './auth.ts';
import type { HistoryStore } from './history.ts';
import type { SoloStore } from './solo.ts';
import { toCharacter, newGlobalId, type CustomTargetStore } from './custom-targets.ts';
import { log } from './util.ts';

/**
 * 管理后台路由。
 *
 * 访问控制两层：
 * 1. 回环地址直接放行（本机维护）；其他来源必须带 ADMIN_TOKEN。
 * 2. 所有请求必须带 X-HQ-Admin 头——跨站页面无法在不触发 CORS 预检的情况下伪造它，
 *    等于用一行代码拿到 CSRF 防护。
 */

export const ADMIN_HEADER = 'x-hq-admin';

const DIFFICULTIES = [
  { level: 1, label: '入门' },
  { level: 2, label: '进阶' },
  { level: 3, label: '考据' },
];

export interface AdminAccess {
  remoteAddress?: string;
  authorization?: string;
}

export interface AdminDeps {
  store: TargetStoreLike;
  solo: SoloStore;
  token: string;
  /** 账号与历史都依赖 SQLite；JSON 存储模式下为 null */
  db?: DatabaseSync | null;
  history?: HistoryStore | null;
  /** 解析管理员会话（getUser 由 index.ts 注入，与玩家端共用一套 cookie） */
  getUser?: (req: Request) => Promise<AuthUser | null>;
  /** 自定义题库审核（SQLite 模式）；JSON 模式为 null */
  customTargets?: CustomTargetStore | null;
}

export function isLoopback(address: string | undefined): boolean {
  const a = String(address ?? '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function authorizeAdmin(access: AdminAccess, token: string): { ok: boolean; reason?: string } {
  if (isLoopback(access.remoteAddress)) return { ok: true };
  if (!token) return { ok: false, reason: 'NON_LOCAL_NO_TOKEN' };
  const matched = /^Bearer\s+(.+)$/i.exec(String(access.authorization ?? ''));
  if (matched && sameToken(matched[1]!.trim(), token)) return { ok: true };
  return { ok: false, reason: 'BAD_TOKEN' };
}

function fail(
  res: Response,
  status: number,
  error: string,
  message: string,
  issues?: Issue[],
): void {
  res.status(status).json({ error, message, ...(issues ? { issues } : {}) });
}

export function createAdminRoutes(deps: AdminDeps): express.Router {
  const router = express.Router();

  router.use((req: Request, res: Response, next) => {
    const access = authorizeAdmin(
      { remoteAddress: req.socket.remoteAddress, authorization: req.get('authorization') },
      deps.token,
    );
    if (!access.ok) {
      log('admin.forbidden', { reason: access.reason ?? '', path: req.path });
      return fail(res, 403, 'ADMIN_FORBIDDEN', '管理后台仅限本机访问；远程访问需配置 ADMIN_TOKEN 并携带 Bearer 令牌');
    }
    if (req.get(ADMIN_HEADER) !== '1') {
      return fail(res, 403, 'ADMIN_HEADER_REQUIRED', '缺少管理请求标识 X-HQ-Admin');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !req.is('application/json')) {
      return fail(res, 415, 'JSON_REQUIRED', '写操作必须使用 application/json');
    }
    next();
  });

  router.get('/meta', (_req: Request, res: Response) => {
    const vocab = deps.store.vocab();
    res.json({
      dynasties: [...DYNASTIES],
      difficulties: DIFFICULTIES,
      roles: vocab.roles,
      types: vocab.types,
      worldErasByRegion: vocab.worldErasByRegion,
      provinces: vocab.provinces,
      polities: vocab.polities,
      total: deps.store.total,
      categories: deps.store.categories,
      active: deps.store.activeCount,
      tokenRequired: Boolean(deps.token),
    });
  });

  router.get('/targets', (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const polity = String(req.query.polity ?? '').trim();
    const region = String(req.query.region ?? '').trim();
    const difficulty = Number(req.query.difficulty);
    const retired = String(req.query.retired ?? '');
  const worldEra = String(req.query.worldEra ?? "").trim();

    let items = deps.store.list();
    if (q) {
      items = items.filter((c) =>
        [c.id, c.name, ...c.aliases].some((v) => v.toLowerCase().includes(q)),
      );
    }
    if (polity) items = items.filter((c) => c.polity === polity || (c.polityAlt ?? []).includes(polity));
    if (region) items = items.filter((c) => c.region === (region as Region));
    if ([1, 2, 3].includes(difficulty)) items = items.filter((c) => c.difficulty === difficulty);
    const category = String(req.query.category ?? '').trim();
    if (category) items = items.filter((c) => (c.category ?? 'character') === category);
    if (retired === '1') items = items.filter((c) => c.retired);
    if (retired === '0') items = items.filter((c) => !c.retired);
  if (worldEra) items = items.filter((c) => c.worldEra === worldEra);

    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

    // 分页：默认全量（老调用方兼容）；显式传 limit 才切页。total 永远是过滤后的总数。
    const total = items.length;
    const limit = Number(req.query.limit);
    const offset = Number(req.query.offset) || 0;
    if (Number.isFinite(limit) && limit > 0) {
      items = items.slice(offset, offset + Math.min(limit, 5000));
    }
    res.json({ total, items });
  });

  router.get('/targets/:id', (req: Request, res: Response) => {
    const character = deps.store.find(String(req.params.id));
    if (!character) return fail(res, 404, 'NOT_FOUND', '找不到这个人物');
    res.json({ character });
  });

  router.post('/targets', (req: Request, res: Response) => {
    let result;
    try {
      result = deps.store.create(req.body as Character);
    } catch (err) {
      return fail(res, 500, 'WRITE_FAILED', (err as Error).message);
    }
    if (!result.ok) return fail(res, 400, 'VALIDATION_FAILED', '校验未通过，未写入', result.issues);

    deps.solo.reloadIndex(result.index!);
    log('admin.character.create', { id: result.character!.id });
    res.status(201).json({ character: result.character, issues: result.issues });
  });

  router.put('/targets/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    let result;
    try {
      result = deps.store.update(id, req.body as Character);
    } catch (err) {
      return fail(res, 500, 'WRITE_FAILED', (err as Error).message);
    }
    if (!result.ok) return fail(res, 400, 'VALIDATION_FAILED', '校验未通过，未写入', result.issues);

    deps.solo.reloadIndex(result.index!);
    log('admin.character.update', { id });
    res.json({ character: result.character, issues: result.issues });
  });

  router.post('/targets/:id/retire', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const retired = Boolean((req.body as { retired?: unknown })?.retired);
    let result;
    try {
      result = deps.store.setRetired(id, retired);
    } catch (err) {
      return fail(res, 500, 'WRITE_FAILED', (err as Error).message);
    }
    if (!result.ok) return fail(res, 400, 'VALIDATION_FAILED', '操作失败', result.issues);

    deps.solo.reloadIndex(result.index ?? deps.store.index);
    log('admin.character.retire', { id, retired });
    res.json({ character: result.character });
  });

  /* ---------------- 自定义题库审核 ---------------- */

  router.get('/custom-targets', (_req: Request, res: Response) => {
    if (!deps.customTargets) return fail(res, 503, 'CUSTOM_DISABLED', '当前是 JSON 存储模式，自定义题库不可用');
    res.json({ items: deps.customTargets.listSubmitted() });
  });

  router.post('/custom-targets/:id/review', (req: Request, res: Response) => {
    if (!deps.customTargets) return fail(res, 503, 'CUSTOM_DISABLED', '当前是 JSON 存储模式，自定义题库不可用');
    const id = String(req.params.id);
    const body = (req.body ?? {}) as { action?: unknown; note?: unknown };
    const action = body.action === 'reject' ? 'reject' : body.action === 'approve' ? 'approve' : null;
    if (!action) return fail(res, 400, 'BAD_ACTION', 'action 须为 approve / reject');
    const note = String(body.note ?? '').trim() || null;

    if (action === 'reject') {
      const t = deps.customTargets.review(id, 'rejected', note);
      if (!t) return fail(res, 404, 'NOT_FOUND', '找不到待审的自定义条目');
      log('admin.custom.reject', { id });
      return res.json({ target: t });
    }

    // 通过：复制为全局条目（校验不过则留在待审队列并返回问题清单）
    const t = deps.customTargets.getById(id);
    if (!t || t.status !== 'submitted') return fail(res, 404, 'NOT_FOUND', '找不到待审的自定义条目');
    const character = toCharacter(t, newGlobalId());
    let result;
    try {
      result = deps.store.create(character);
    } catch (err) {
      return fail(res, 500, 'WRITE_FAILED', (err as Error).message);
    }
    if (!result.ok) {
      return fail(res, 400, 'VALIDATION_FAILED', '复制入全局题库未通过校验，条目保留在待审队列', result.issues);
    }
    deps.customTargets.review(id, 'approved', note);
    deps.customTargets.setGlobalId(id, character.id);
    deps.solo.reloadIndex(result.index!);
    log('admin.custom.approve', { id, globalId: character.id });
    res.json({ target: deps.customTargets.getById(id), character: result.character });
  });

  router.post('/validate', (req: Request, res: Response) => {
    const body = req.body as { character?: unknown; id?: unknown };
    const idToUpdate = typeof body?.id === 'string' && body.id ? body.id : null;
    const { character, issues } = deps.store.check(body?.character ?? body, idToUpdate);
    res.json({
      ok: !issues.some((i) => i.level === 'error'),
      character,
      issues,
    });
  });

  router.get('/health', (_req: Request, res: Response) => {
    res.json(deps.store.health());
  });

  router.get('/export', (_req: Request, res: Response) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="characters.json"');
    res.send(deps.store.exportText());
  });

  /* ---------------- 对局历史（管理员视角：全部用户） ---------------- */

  router.get('/history', async (req: Request, res: Response) => {
    if (!deps.history) return fail(res, 503, 'HISTORY_DISABLED', '当前是 JSON 存储模式，对局历史不可用');
    const result = await deps.history.list({
      ...(String(req.query.guest ?? '') === '1' ? { userId: 'guest' as const } : {}),
      ...(String(req.query.user ?? '').trim() ? { userName: String(req.query.user).trim() } : {}),
      ...(String(req.query.result ?? '').trim() ? { result: String(req.query.result).trim() as GameResult } : {}),
      ...(String(req.query.q ?? '').trim() ? { q: String(req.query.q).trim() } : {}),
      limit: Number(req.query.limit) || undefined,
      offset: Number(req.query.offset) || undefined,
    });
    res.json(result);
  });

  router.get('/history/:id', async (req: Request, res: Response) => {
    if (!deps.history) return fail(res, 503, 'HISTORY_DISABLED', '当前是 JSON 存储模式，对局历史不可用');
    const detail = await deps.history.get(String(req.params.id));
    if (!detail) return fail(res, 404, 'NOT_FOUND', '找不到这一局');
    res.json(detail);
  });

  /* ---------------- 用户与邀请码 ---------------- */

  router.get('/users', (_req: Request, res: Response) => {
    if (!deps.db) return fail(res, 503, 'AUTH_DISABLED', 'JSON 存储模式下没有账号系统');
    const users = listUsers(deps.db);
    res.json({ total: users.length, users });
  });

  router.post('/users/:id/:kind(server-key|ban|quota)', (req: Request, res: Response) => {
    if (!deps.db) return fail(res, 503, 'AUTH_DISABLED', 'JSON 存储模式下没有账号系统');
    const id = String(req.params.id);
    const kind = String(req.params.kind) as 'server-key' | 'ban' | 'quota';
    const body = req.body as { on?: unknown; quota?: unknown };

    // 防自锁：管理员的封禁 / 关停 / 配额都不许改
    if (findUserRole(deps.db, id) === 'admin') {
      return fail(res, 403, 'ADMIN_PROTECTED', kind === 'quota' ? '管理员配额不受限制（无限）' : '不能对管理员执行封禁或关闭站方模型');
    }

    if (kind === 'quota') {
      const quota = Math.max(-1, Math.round(Number(body?.quota)));
      setUserFlag(deps.db, id, 'quota', Number.isFinite(quota) ? quota : -1);
    } else {
      setUserFlag(deps.db, id, kind, Boolean(body?.on));
    }
    log('admin.user.flag', { id, kind });
    res.json({ ok: true });
  });

  // 删除账号（不可逆）：与封禁分开一个端点，前端也放在独立的危险区里
  router.post('/users/:id/delete', (req: Request, res: Response) => {
    if (!deps.db) return fail(res, 503, 'AUTH_DISABLED', 'JSON 存储模式下没有账号系统');
    const result = deleteUser(deps.db, String(req.params.id));
    if (!result.ok) {
      return fail(res, result.error === 'NOT_FOUND' ? 404 : 403, result.error ?? 'DELETE_FAILED', result.message ?? '删除失败');
    }
    log('admin.user.delete', { id: String(req.params.id), username: result.username ?? '' });
    res.json({ ok: true });
  });

  router.get('/invites', (_req: Request, res: Response) => {
    if (!deps.db) return fail(res, 503, 'AUTH_DISABLED', 'JSON 存储模式下没有账号系统');
    const invites = listInvites(deps.db);
    res.json({ total: invites.length, invites });
  });

  router.post('/invites', (req: Request, res: Response) => {
    if (!deps.db) return fail(res, 503, 'AUTH_DISABLED', 'JSON 存储模式下没有账号系统');
    const codes = createInvites(deps.db, Number((req.body as { count?: unknown })?.count) || 1);
    log('admin.invite.create', { count: codes.length });
    res.status(201).json({ codes });
  });

  router.post('/change-password', async (req: Request, res: Response) => {
    if (!deps.db) return fail(res, 503, 'AUTH_DISABLED', 'JSON 存储模式下没有账号系统');
    const me = deps.getUser ? await deps.getUser(req) : null;
    if (!me) return fail(res, 403, 'ADMIN_FORBIDDEN', '修改密码需要登录管理员会话（ADMIN_TOKEN 通道不可用）');
    const body = req.body as { current?: unknown; next?: unknown };
    const result = await changePassword(deps.db, me.id, String(body?.current ?? ''), String(body?.next ?? ''));
    if (!result.ok) return fail(res, result.error === 'BAD_CREDENTIALS' ? 401 : 400, result.error ?? 'BAD_REQUEST', result.message ?? '修改失败');
    res.json({ ok: true });
  });

  return router;
}
