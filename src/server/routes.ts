import express from 'express';
import type { Request, Response } from 'express';
import { AiError, testConnection } from '../ai/client.ts';
import type { AiCredential } from '../shared/domain.ts';
import { DYNASTIES, REGIONS, REGION_LABELS, isTargetCategory, type Region } from '../shared/domain.ts';
import type { AiConfig, HistoryDetail, MetaRes } from '../shared/protocol.ts';
import type { CharacterIndex } from '../core/index.ts';
import type { Character } from '../shared/domain.ts';
import { config, serverModelReady } from '../config.ts';
import type { AuthUser } from './auth.ts';
import { projectSession } from './dto.ts';
import type { HistoryStore } from './history.ts';
import { SoloError, type SoloStore } from './solo.ts';
import { createCustomTargetStore, type CustomTarget, type CustomTargetStore } from './custom-targets.ts';
import { customToCharacter, newGlobalCustomId } from '../shared/custom-targets.ts';

/** 语音识别是否可用：模型名配置了就开（端点/密钥留空则复用 LLM 的） */
function asrReady(): boolean {
  return Boolean(config.ai.asrModel && (config.ai.asrBaseURL || config.ai.baseURL));
}
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
  /** 自定义题库（SQLite 模式）；JSON 模式为 null（接口返回 503） */
  customTargets?: CustomTargetStore | null;
  /** 出题：把条目复制为全局 retired 副本（不进公共抽取池）；JSON 模式为 null */
  createChallengeTarget?: (c: Character) => Promise<void>;
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
      dataCount: index.size,
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
      asrReady: asrReady(),
    };
    res.json(meta);
  });

  /** 语音识别：音频 → 文字（填输入框，不直接进 ask；行为约定见 docs/DECISIONS.md） */
  router.post('/ai/transcribe', express.raw({ type: 'multipart/form-data', limit: '10mb' }), async (req, res) => {
    const started = Date.now();
    const user = await currentUser(req);
    if (authEnabled && !user) {
      return fail(res, 401, 'LOGIN_REQUIRED', '语音识别需要先登录');
    }
    if (!asrReady()) {
      return fail(res, 503, 'ASR_NOT_CONFIGURED', '语音识别未配置（缺 AI_ASR_MODEL）');
    }

    try {
      const buffer = Buffer.from(req.body as Buffer);
      if (buffer.length === 0) return fail(res, 400, 'EMPTY_AUDIO', '音频是空的');
      if (buffer.length > 10 * 1024 * 1024) return fail(res, 413, 'AUDIO_TOO_LARGE', '音频超过 10MB');

      const upstreamForm = new FormData();
      upstreamForm.append('file', new Blob([buffer], { type: 'audio/webm' }), 'speech.webm');
      upstreamForm.append('model', config.ai.asrModel);
      upstreamForm.append('prompt', '历史人物问答：「是」「否」「唐朝」「宋朝」「诗人」「皇帝」等词。');

      const base = (config.ai.asrBaseURL || config.ai.baseURL).replace(/\/+$/, '');
      const endpoint = /\/v\d+$/i.test(base) ? `${base}/audio/transcriptions` : `${base}/v1/audio/transcriptions`;
      const upstream = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.ai.asrApiKey || config.ai.apiKey}` },
        body: upstreamForm,
        signal: AbortSignal.timeout(30_000),
      });
      if (!upstream.ok) {
        const detail = (await upstream.text().catch(() => '')).slice(0, 200);
        return fail(res, 502, 'ASR_HTTP', `识别服务返回 ${upstream.status}${detail ? `：${detail}` : ''}`);
      }
      const data = (await upstream.json()) as { text?: string };
      const ms = Date.now() - started;
      log('ai.transcribe', { ms, len: (data.text ?? '').length });
      res.json({ text: String(data.text ?? '').trim(), ms });
    } catch (err) {
      const aborted = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
      fail(res, aborted ? 504 : 502, aborted ? 'ASR_TIMEOUT' : 'ASR_NETWORK', aborted ? '识别超时，再试一次' : '连不上识别服务');
    }
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
      targetScope?: unknown;
      challengeCode?: unknown;
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
    const mode = body?.mode === 'assist' ? 'assist' : body?.mode === 'guided' ? 'guided' : 'strict';
    const pronoun = body?.pronoun === 'neutral' ? 'neutral' : 'normal';
    const turnsRaw = Number(body?.turns);
    const turns = Number.isFinite(turnsRaw) && turnsRaw > 0 ? Math.round(turnsRaw) : undefined;

    // 「我的题库」：从自己已通过审核的自定义条目里挑谜底（须登录且题库可用）
    let customPoolIds: string[] | null = null;
    if (body?.targetScope === 'mine') {
      const user = await currentUser(req);
      if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '使用自己的题库需要先登录');
      const store = deps.customTargets;
      if (!store) return fail(res, 503, 'CUSTOM_DISABLED', '当前是 JSON 存储模式，自定义题库不可用');
      customPoolIds = store.listGlobalIds(user.id);
      if (!customPoolIds.length) {
        return fail(res, 409, 'CUSTOM_EMPTY', '你的题库里还没有已通过审核的条目');
      }
    }

    // 挑战开局：挑战码锁定固定谜底（出题人出题给别人玩）
    let challengePool: string[] | null = null;
    const challengeCode = typeof body?.challengeCode === 'string' ? body.challengeCode.trim() : '';
    if (challengeCode) {
      const store = deps.customTargets;
      if (!store) return fail(res, 503, 'CUSTOM_DISABLED', '当前是 JSON 存储模式，挑战不可用');
      const t = store.getByCode(challengeCode);
      if (!t?.globalId) return fail(res, 404, 'NOT_FOUND', '挑战不存在或已被删除');
      challengePool = [t.globalId];
    }

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
      customPoolIds: challengePool ?? customPoolIds,
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

  /* ---------------- 自定义题库（用户级 CRUD + 提交审核） ---------------- */

  type CustomStore = ReturnType<typeof createCustomTargetStore>;
  const requireCustom = (res: Response): CustomStore | null => {
    if (!deps.customTargets) {
      fail(res, 503, 'CUSTOM_DISABLED', '当前是 JSON 存储模式，自定义题库不可用');
      return null;
    }
    return deps.customTargets;
  };

  const readCustomBody = (body: unknown) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const str = (k: string) => String(b[k] ?? '').trim();
    const num = (k: string): number | null => {
      const v = b[k];
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n) : null;
    };
    const aliases = Array.isArray(b.aliases)
      ? [...new Set((b.aliases as unknown[]).map((a) => String(a).trim()).filter(Boolean))]
      : [];
    return {
      category: (b.category === 'event' || b.category === 'item' ? b.category : 'character') as CustomTarget['category'],
      name: str('name'),
      aliases,
      summary: str('summary'),
      region: (str('region') || 'cn') as CustomTarget['region'],
      polity: str('polity'),
      worldEra: str('worldEra') || null,
      gender: str('gender'),
      birth: num('birth'),
      death: num('death'),
      birthplace: str('birthplace') || null,
      difficulty: Math.min(3, Math.max(1, Number(b.difficulty) || 2)),
    };
  };

  router.get('/custom-targets', async (req: Request, res: Response) => {
    const store = requireCustom(res);
    if (!store) return;
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后才能使用自定义题库');
    res.json({ items: store.listByUser(user.id) });
  });

  router.post('/custom-targets', async (req: Request, res: Response) => {
    const store = requireCustom(res);
    if (!store) return;
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后才能使用自定义题库');

    const input = readCustomBody(req.body);
    const errs = store.validate(input);
    if (errs.length) return fail(res, 400, 'VALIDATION_FAILED', errs.join('；'));
    const now = Date.now();
    const t: CustomTarget = {
      id: `c-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      userId: user.id,
      ...input,
      status: 'draft',
      reviewNote: null,
      globalId: null,
      shareCode: null,
      createdAt: now,
      updatedAt: now,
    };
    store.insert(t);
    log('custom.create', { id: t.id, userId: user.id });
    res.status(201).json({ target: t });
  });

  router.put('/custom-targets/:id', async (req: Request, res: Response) => {
    const store = requireCustom(res);
    if (!store) return;
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后才能使用自定义题库');
    const existing = store.get(String(req.params.id), user.id);
    if (!existing) return fail(res, 404, 'NOT_FOUND', '找不到这条自定义条目');
    if (existing.status !== 'draft') {
      return fail(res, 409, 'NOT_EDITABLE', '只有草稿状态可以编辑；被驳回的条目请删除后重建');
    }
    const input = readCustomBody(req.body);
    const errs = store.validate(input);
    if (errs.length) return fail(res, 400, 'VALIDATION_FAILED', errs.join('；'));
    store.updateDraft(existing.id, user.id, input);
    res.json({ target: store.get(existing.id, user.id) });
  });

  router.post('/custom-targets/:id/submit', async (req: Request, res: Response) => {
    const store = requireCustom(res);
    if (!store) return;
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后才能使用自定义题库');
    const existing = store.get(String(req.params.id), user.id);
    if (!existing) return fail(res, 404, 'NOT_FOUND', '找不到这条自定义条目');
    if (existing.status !== 'draft') return fail(res, 409, 'NOT_DRAFT', '只有草稿可以提交审核');
    const errs = store.validate(existing);
    if (errs.length) return fail(res, 400, 'VALIDATION_FAILED', errs.join('；'));
    store.setStatus(existing.id, user.id, 'submitted');
    log('custom.submit', { id: existing.id, userId: user.id });
    res.json({ target: store.get(existing.id, user.id) });
  });

  router.delete('/custom-targets/:id', async (req: Request, res: Response) => {
    const store = requireCustom(res);
    if (!store) return;
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后才能使用自定义题库');
    const existing = store.get(String(req.params.id), user.id);
    if (!existing) return fail(res, 404, 'NOT_FOUND', '找不到这条自定义条目');
    if (existing.status !== 'draft' && existing.status !== 'rejected') {
      return fail(res, 409, 'NOT_DELETABLE', '待审/已通过的条目不能删除');
    }
    store.remove(existing.id, user.id);
    res.json({ ok: true });
  });

  router.post('/custom-targets/:id/challenge', async (req: Request, res: Response) => {
    const store = requireCustom(res);
    if (!store) return;
    if (!deps.createChallengeTarget) return fail(res, 503, 'CUSTOM_DISABLED', '当前是 JSON 存储模式，出题不可用');
    const user = await currentUser(req);
    if (!user) return fail(res, 401, 'LOGIN_REQUIRED', '登录后才能出题');
    const existing = store.get(String(req.params.id), user.id);
    if (!existing) return fail(res, 404, 'NOT_FOUND', '找不到这条自定义条目');

    // 幂等：已出过题直接返回原码
    if (existing.shareCode) {
      return res.json({ code: existing.shareCode, url: `/c/${existing.shareCode}` });
    }
    if (existing.status !== 'draft') {
      return fail(res, 409, 'NOT_DRAFT', '只有草稿可以出题；待审/已入库的条目走审核流程');
    }
    const errs = store.validate(existing);
    if (errs.length) return fail(res, 400, 'VALIDATION_FAILED', errs.join('；'));

    const code = store.createChallengeCode(existing.id, user.id);
    if (!code) return fail(res, 409, 'CHALLENGE_FAILED', '出题失败，请重试');
    // 复制为全局 retired 副本：不进公共抽取池，但服务端永远可解析（刷新/重启不丢）
    try {
      const character = customToCharacter(existing, newGlobalCustomId());
      await deps.createChallengeTarget(character);
      store.setGlobalId(existing.id, character.id);
    } catch (err) {
      return fail(res, 500, 'WRITE_FAILED', (err as Error).message);
    }
    log('custom.challenge', { id: existing.id, code, userId: user.id });
    res.status(201).json({ code, url: `/c/${code}` });
  });

  // 挑战信息（不含谜底）：挑战页展示用
  router.get('/challenge/:code', async (req: Request, res: Response) => {
    const store = requireCustom(res);
    if (!store) return;
    const t = store.getByCode(String(req.params.code));
    if (!t) return fail(res, 404, 'NOT_FOUND', '挑战不存在或已被删除');
    res.json({
      code: t.shareCode,
      category: t.category,
      difficulty: t.difficulty,
      creator: store.creatorName(t.userId) ?? '出题人',
    });
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
