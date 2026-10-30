import express from 'express';
import type { Request, Response } from 'express';
import { AiError, testConnection } from '../ai/client.ts';
import type { AiCredential } from '../shared/domain.ts';
import { DYNASTIES } from '../shared/domain.ts';
import type { AiConfig, MetaRes } from '../shared/protocol.ts';
import type { CharacterIndex } from '../core/index.ts';
import { config, serverModelReady } from '../config.ts';
import { projectSession } from './dto.ts';
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

function toCredential(cfg: AiConfig): AiCredential {
  return {
    kind: 'byok',
    baseURL: cfg.baseURL,
    apiKey: cfg.apiKey,
    model: cfg.model,
    temperature: cfg.temperature ?? config.ai.temperature,
  };
}

export function createRoutes(deps: { index: CharacterIndex; solo: SoloStore }): express.Router {
  const router = express.Router();
  const limiter = new RateLimiter(30, 0.5);

  router.get('/meta', (_req: Request, res: Response) => {
    const meta: MetaRes = {
      dynasties: [...DYNASTIES],
      difficulties: DIFFICULTIES,
      maxTurns: config.soloTurns,
      serverModelReady: serverModelReady(),
      characterCount: deps.index.size,
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

  router.post('/solo', (req: Request, res: Response) => {
    const cfg = readAiConfig(req.body);
    if (!cfg) return fail(res, 400, 'MODEL_NOT_CONFIGURED', '没有模型配置就无法开局');

    const body = req.body as { difficulty?: unknown; dynasty?: unknown; mode?: unknown };
    const difficulty = Math.min(3, Math.max(1, Number(body?.difficulty) || 1));
    const dynasty = typeof body?.dynasty === 'string' && body.dynasty ? body.dynasty : null;
    const mode = body?.mode === 'guided' ? 'guided' : 'strict';

    const session = deps.solo.create({ difficulty, dynasty, mode });
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
    if (!cfg) return fail(res, 400, 'MODEL_NOT_CONFIGURED', '没有模型配置就无法判定');

    const id = String(req.params.id);
    if (!limiter.take(id)) return fail(res, 429, 'RATE_LIMITED', '问得太快了，缓一缓');

    try {
      const result = await deps.solo.ask(id, question, toCredential(cfg), {
        timeoutMs: config.ai.timeoutMs,
      });
      log('solo.ask', { id, seq: result.seq, accepted: result.accepted, status: result.status });
      res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/solo/:id/guess', (req: Request, res: Response) => {
    const name = String((req.body as { name?: unknown })?.name ?? '').trim();
    if (!name) return fail(res, 400, 'EMPTY_GUESS', '请输入你猜的人物名');
    try {
      const result = deps.solo.guess(String(req.params.id), name);
      res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  router.post('/solo/:id/reveal', (req: Request, res: Response) => {
    try {
      const result = deps.solo.reveal(String(req.params.id));
      res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
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
