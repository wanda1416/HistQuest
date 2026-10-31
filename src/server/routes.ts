import express from 'express';
import type { Request, Response } from 'express';
import { AiError, testConnection } from '../ai/client.ts';
import type { AiCredential } from '../shared/domain.ts';
import { DYNASTIES, REGIONS, REGION_LABELS, isTargetCategory, type Region } from '../shared/domain.ts';
import type { AiConfig, HistoryDetail, MetaRes } from '../shared/protocol.ts';
import type { CharacterIndex } from '../core/index.ts';
import { config, serverModelReady } from '../config.ts';
import type { AuthUser } from './auth.ts';
import { projectSession } from './dto.ts';
import type { HistoryStore } from './history.ts';
import { SoloError, type SoloStore } from './solo.ts';
import { RateLimiter, log } from './util.ts';

const DIFFICULTIES = [
  { level: 1, label: '入门', desc: '家喻户晓的人物' },
  { level: 2, label: '进阶', desc: '需要一点历史功底' },
  { level: 3, label: '考据', desc: '冷门，靠推理' },
];

function fail(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

function readAiConfig(body: unknown): AiConfig | null {
  const raw = (body as { aiConfig?: unknown })?.aiConfig ?? body;
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const baseURL = String(c.baseURL ?? '').trim();
  const apiKey = String(c.apiKey ?? '').trim();
  const model = String(c.model ?? '').trim();
  if (!baseURL || !apiKey || !model) return null;
  const t = Number(c.temperature);
  const cfg: AiConfig = { baseURL, apiKey, model };
  if (Number.isFinite(t)) cfg.temperature = Math.min(1, Math.max(0, t));
  return cfg;
}

function toCredential(cfg: AiConfig | null): AiCredential {
  // 优先用户 BYOK；未填时回落服务端配置（CF 部署：部署者出 key 给朋友玩）
  if (cfg) {
    return {
      kind: 'byok',
      baseURL: cfg.baseURL,
      apiKey: cfg.apiKey,
      model: cfg.model,
      temperature: cfg.temperature ?? config.ai.temperature,
    };
  }
  if (serverModelReady()) {
    return { kind: 'byok', baseURL: config.ai.baseURL, apiKey: config.ai.apiKey, model: config.ai.model, temperature: config.ai.temperature };
  }
  throw new AiError('UNSUPPORTED', '没有可用的模型配置');
}

export interface RouteDeps {
  getIndex: () => CharacterIndex;
  solo: SoloStore;
  /** 永久对局账本；JSON 存储模式下为 null（历史接口返回 503） */
  history?: HistoryStore | null;
  /** 解析当前登录用户；不传表示未启用账号系统 */
  getUser?: (req: Request) => Promise<AuthUser | null>;
  /** 站方模型每日配额扣减；不传表示不限额 */
  quota?: (user: AuthUser) => { ok: boolean; message?: string };
}

export function createRoutes(deps: RouteDeps): express.Router {
  const router = express.Router();
  const limiter = new RateLimiter(30, 0.5);
  const authEnabled = Boolean(deps.getUser);

  const currentUser = async (req: Request): Promise<AuthUser | null> =>
    deps.getUser ? deps.getUser(req) : null;

  router.get('/meta', async (req: Request, res: Response) => {
    const index = deps.getIndex();
    const counts = new Map<string, number>();
    for (const c of index.list) counts.set(c.region, (counts.get(c.region) ?? 0) + 1);

    const user = await currentUser(req);
    const meta: MetaRes = {
      dynasties: [...DYNASTIES],
      difficulties: DIFFICULTIES,
      maxTurns: config.soloTurns,
      serverModelReady: serverModelReady(),
      characterCount: index.size,
      categories: index.categoryCounts(),
      regions: REGIONS.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => ({
        value: value as Region,
        label: REGION_LABELS[value],
        count: counts.get(value) ?? 0,
      })),
      authEnabled,
      user: user
        ? { username: user.username, role: user.role, allowServerKey: user.allowServerKey }
        : null,
    };
    res.json(meta);
  });

  router.post('/ai/test', async (req: Request, res: Response) => {
    const cfg = readAiConfig(req.body);
    if (!cfg) return fail(res, 400, 'MODEL_NOT_CONFIGURED', '请填写模型地址、密钥和模型名');
    const result = await testConnection(toCredential(cfg));
    log('ai.test', { ok: result.ok, code: result.errorCode ?? '', ms: result.latencyMs });
    res.json(result);
  });

  router.post('/solo', async (req: Request, res: Response) => {
    // 开局即要求登录：否则会出现无主对局（能开局、能猜、能放弃，一问都没问），
    // 历史和后台里就会多出归属不明的记录
    const user = await currentUser(req);
    if (authEnabled && !user) {
      return fail(res, 401, 'LOGIN_REQUIRED', '登录后才能开局');
    }

    const cfg = readAiConfig(req.body);
    if (!cfg && !serverModelReady()) {
      return fail(res, 400, 'MODEL_NOT_CONFIGURED', '没有模型配置就无法开局');
    }

    const body = req.body as {
      category?: unknown;
      difficulty?: unknown;
      polity?: unknown;
      region?: unknown;
      worldEra?: unknown;
      cnShare?: unknown;
      mode?: unknown;
      pronoun?: unknown;
      turns?: unknown;
    };
    const difficulty = Math.min(3, Math.max(1, Number(body?.difficulty) || 1));
    // 类别：character / event / item / mixed；缺省人物（向后兼容老客户端）
    const rawCategory = body?.category;
    const category =
      rawCategory === 'mixed' || isTargetCategory(rawCategory) ? rawCategory : 'character';
    const polity = typeof body?.polity === 'string' && body.polity ? body.polity : null;
    const region =
      typeof body?.region === 'string' && body.region
        ? (body.region as (typeof REGIONS)[number])
        : null;
    const share = Number(body?.cnShare);
    const cnShare = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0.5;
    const worldEra =
      typeof body?.worldEra === 'string' && body.worldEra ? body.worldEra : null;
    const mode = body?.mode === 'guided' ? 'guided' : 'strict';
    const pronoun = body?.pronoun === 'neutral' ? 'neutral' : 'normal';
    const turnsRaw = Number(body?.turns);
    const turns = Number.isFinite(turnsRaw) && turnsRaw > 0 ? Math.round(turnsRaw) : undefined;

    // 归属玩家：未启用账号系统时（JSON 存储模式）可能为空
    const session = await deps.solo.create({
      difficulty,
      category,
      polity,
      region,
      worldEra,
      cnShare,
      mode,
      pronoun,
      turns,
      userId: user?.id ?? null,
      userName: user?.username ?? null,
    });
    res.status(201).json(projectSession(session));
  });

  router.get('/solo/:id', (req: Request, res: Response) => {
    try {
      const session = deps.solo.require(String(req.params.id));
      res.json(projectSession(session));
    } catch (err) {
      if (err instanceof SoloError) return fail(res, 404, err.code, err.message);
      throw err;
    }
  });

  router.post('/solo/:id/ask', async (req: Request, res: Response) => {
    const question = String((req.body as { question?: unknown })?.question ?? '').trim();
    if (!question) return fail(res, 400, 'EMPTY_QUESTION', '问题不能为空');

    const cfg = readAiConfig(req.body);
    let cred: AiCredential;
    if (cfg) {
      cred = toCredential(cfg);
    } else if (!serverModelReady()) {
      return fail(res, 400, 'MODEL_NOT_CONFIGURED', '没有模型配置就无法判定');
    } else {
      // 站方 Key 的规则与 Workers 一致：必须登录、账号允许、且当日额度未用尽
      const user = await currentUser(req);
      if (authEnabled && !user) {
        return fail(res, 401, 'LOGIN_REQUIRED', '未登录只能使用自己的模型（BYOK）；注册/登录后可用站方模型');
      }
      if (user) {
        if (user.role !== 'admin' && !user.allowServerKey) {
          return fail(res, 403, 'BYOK_REQUIRED', '管理员为本账号关闭了站方模型，请在设置里填写自己的模型');
        }
        const quota = deps.quota ? deps.quota(user) : { ok: true };
        if (!quota.ok) return fail(res, 429, 'QUOTA_EXCEEDED', quota.message ?? '今日额度已用完');
      }
      cred = toCredential(null);
    }

    const id = String(req.params.id);
    if (!limiter.take(id)) return fail(res, 429, 'RATE_LIMITED', '问得太快了，缓一缓');

    try {
      const result = await deps.solo.ask(id, question, cred, {
        timeoutMs: config.ai.timeoutMs,
      });
      log('solo.ask', { id, seq: result.seq, accepted: result.accepted, status: result.status });
      res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/solo/:id/guess', async (req: Request, res: Response) => {
    const name = String((req.body as { name?: unknown })?.name ?? '').trim();
    if (!name) return fail(res, 400, 'EMPTY_GUESS', '请输入你猜的人物名');
    try {
      const result = await deps.solo.guess(String(req.params.id), name);
      res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/solo/:id/reveal', async (req: Request, res: Response) => {
    try {
      const result = await deps.solo.reveal(String(req.params.id));
      res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  /* ---------------- 我的对局历史 ---------------- */

  const requireHistory = (res: Response): HistoryStore | null => {
    if (!deps.history) {
      fail(res, 503, 'HISTORY_DISABLED', '当前是 JSON 存储模式，对局历史不可用');
      return null;
    }
    return deps.history;
  };

  router.get('/history/mine', async (req: Request, res: Response) => {
    const store = requireHistory(res);
    if (!store) return;
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后可查看自己的对局历史');

    const result = await store.list({
      userId: user.id,
      limit: Number(req.query.limit) || undefined,
      offset: Number(req.query.offset) || undefined,
      ...(typeof req.query.result === 'string' && req.query.result
        ? { result: req.query.result as HistoryDetail['result'] }
        : {}),
    });
    res.json(result);
  });

  router.get('/history/mine/:id', async (req: Request, res: Response) => {
    const store = requireHistory(res);
    if (!store) return;
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后可查看自己的对局历史');

    const detail = await store.get(String(req.params.id));
    if (!detail) return fail(res, 404, 'NOT_FOUND', '找不到这一局');
    if (detail.userId !== user.id && user.role !== 'admin') {
      return fail(res, 403, 'FORBIDDEN', '这局不属于当前账号');
    }
    res.json(detail);
  });

  return router;
}

function handleError(res: Response, err: unknown): void {
  if (err instanceof SoloError) {
    const status = err.code === 'NOT_FOUND' ? 404 : 409;
    fail(res, status, err.code, err.message);
    return;
  }
  if (err instanceof AiError) {
    const map: Record<string, [number, string]> = {
      AUTH: [401, '密钥无效或无权限，请到设置里检查'],
      RATE: [429, '模型服务限流，请稍后重试'],
      TIMEOUT: [504, '模型响应超时'],
      NETWORK: [502, '无法连接模型服务'],
      BAD_JSON: [502, '模型返回格式异常'],
      UNSUPPORTED: [400, err.message],
    };
    const [status, message] = map[err.code] ?? [502, '模型调用失败'];
    log('ai.error', { code: err.code, message: err.message });
    fail(res, status, `AI_${err.code}`, message);
    return;
  }
  log('http.error', { message: (err as Error)?.message ?? 'unknown' });
  fail(res, 500, 'SERVER_ERROR', '服务器内部错误');
}
