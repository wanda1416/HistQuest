import express from 'express';
import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { DYNASTIES, REGIONS, REGION_LABELS, type Region } from '../shared/domain.ts';
import type { Character } from '../shared/domain.ts';
import type { Issue } from '../core/schema.ts';
import type { CharacterStore } from './characters.ts';
import type { SoloStore } from './solo.ts';
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
  store: CharacterStore;
  solo: SoloStore;
  token: string;
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
      provinces: vocab.provinces,
      polities: vocab.polities,
      regions: REGIONS.map((value) => ({ value, label: REGION_LABELS[value] })),
      total: deps.store.total,
      active: deps.store.activeCount,
      tokenRequired: Boolean(deps.token),
    });
  });

  router.get('/characters', (req: Request, res: Response) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const polity = String(req.query.polity ?? '').trim();
    const region = String(req.query.region ?? '').trim();
    const difficulty = Number(req.query.difficulty);
    const retired = String(req.query.retired ?? '');

    let items = deps.store.list();
    if (q) {
      items = items.filter((c) =>
        [c.id, c.name, ...c.aliases].some((v) => v.toLowerCase().includes(q)),
      );
    }
    if (polity) items = items.filter((c) => c.polity === polity || (c.polityAlt ?? []).includes(polity));
    if (region) items = items.filter((c) => c.region === (region as Region));
    if ([1, 2, 3].includes(difficulty)) items = items.filter((c) => c.difficulty === difficulty);
    if (retired === '1') items = items.filter((c) => c.retired);
    if (retired === '0') items = items.filter((c) => !c.retired);

    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    res.json({ total: items.length, items });
  });

  router.get('/characters/:id', (req: Request, res: Response) => {
    const character = deps.store.find(String(req.params.id));
    if (!character) return fail(res, 404, 'NOT_FOUND', '找不到这个人物');
    res.json({ character });
  });

  router.post('/characters', (req: Request, res: Response) => {
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

  router.put('/characters/:id', (req: Request, res: Response) => {
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

  router.post('/characters/:id/retire', (req: Request, res: Response) => {
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

  return router;
}
