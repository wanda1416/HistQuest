import { DYNASTIES, REGIONS, REGION_LABELS, type Region } from '../src/shared/domain.ts';
import type { AiCredential } from '../src/shared/domain.ts';
import type { MetaRes } from '../src/shared/protocol.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { SoloStore, SoloError } from '../src/server/solo.ts';
import { projectSession } from '../src/server/dto.ts';
import { AiError, testConnection } from '../src/ai/client.ts';
import { D1Database, D1SessionPersistence, loadCharactersFromD1, seedCharactersIntoD1 } from './d1.ts';
import { D1CharacterStore } from './d1-characters.ts';
import { handleVault } from './vault.ts';

/**
 * Cloudflare Worker 入口：纯 BS 一体化（TECH-DESIGN v1.5）。
 * 路由与 src/server/routes.ts 逐条对齐；core/ai 层原样复用。
 *
 * 密钥：AI_API_KEY 走 wrangler secret，只存在于 Worker→LLM 这一段。
 */

interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  SOLO_TURNS?: string;
  ADMIN_TOKEN?: string;
}

const DIFFICULTIES = [
  { level: 1, label: '入门', desc: '家喻户晓的人物' },
  { level: 2, label: '进阶', desc: '需要一点历史功底' },
  { level: 3, label: '考据', desc: '冷门，靠推理' },
];

const MAX_TURNS_DEFAULT = 50;

interface Runtime {
  index: CharacterIndex;
  store: D1CharacterStore;
  solo: SoloStore;
  env: Env;
  maxTurns: number;
}

let runtime: Promise<Runtime> | null = null;

/** 惰性初始化：首个请求触发 D1 读取 + 种子导入 */
function initRuntime(env: Env): Promise<Runtime> {
  if (!runtime) {
    runtime = (async () => {
      const store = new D1CharacterStore({ db: env.DB });
      {
        const seed = await import('./seed.ts');
        await store.init(seed.SEED_CHARACTERS);
      }
      const index = store.index;
      const persistence = new D1SessionPersistence(env.DB);
      const sessions = await persistence.load();
      const solo = new SoloStore(index, {
        awaitPersist: true,
        turns: Number(env.SOLO_TURNS) || MAX_TURNS_DEFAULT,
        preloaded: sessions,
        newId: () => crypto.randomUUID().replace(/-/g, ''),
      });
      const maxTurns = Number(env.SOLO_TURNS) || MAX_TURNS_DEFAULT;
      return { index, store, solo, env, maxTurns };
    })().catch((err) => {
      runtime = null; // 失败后允许重试
      throw err;
    });
  }
  return runtime;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(status: number, error: string, message: string): Response {
  return json(status, { error, message });
}

/** 服务端模型凭据：未配置时返回 null，前端回落 BYOK */
function serverCredential(env: Env): AiCredential | null {
  if (!env.AI_BASE_URL || !env.AI_API_KEY || !env.AI_MODEL) return null;
  return {
    kind: 'byok',
    baseURL: env.AI_BASE_URL,
    apiKey: env.AI_API_KEY,
    model: env.AI_MODEL,
    temperature: 0.1,
  };
}

function readAiConfig(body: Record<string, unknown>): AiCredential | null {
  const raw = (body.aiConfig ?? body) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== 'object') return null;
  const baseURL = String(raw.baseURL ?? '').trim();
  const apiKey = String(raw.apiKey ?? '').trim();
  const model = String(raw.model ?? '').trim();
  if (!baseURL || !apiKey || !model) return null;
  return { kind: 'byok', baseURL, apiKey, model };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof SoloError) {
    return fail(err.code === 'NOT_FOUND' ? 404 : 409, err.code, err.message);
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
    return fail(status, `AI_${err.code}`, message);
  }
  console.error('http.error', err);
  return fail(500, 'SERVER_ERROR', '服务器内部错误');
}

async function handleApi(req: Request, url: URL, rt: Runtime): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, '');
  const body = req.method === 'POST' ? await readBody(req) : {};
  const serverCred = serverCredential(rt.env);

  // ---------- meta ----------
  if (path === '/meta' && req.method === 'GET') {
    const counts = new Map<string, number>();
    for (const c of rt.index.list) counts.set(c.region, (counts.get(c.region) ?? 0) + 1);
    const meta: MetaRes = {
      dynasties: [...DYNASTIES],
      difficulties: DIFFICULTIES,
      maxTurns: rt.maxTurns,
      serverModelReady: Boolean(serverCred),
      characterCount: rt.index.size,
      regions: REGIONS.filter((v) => (counts.get(v) ?? 0) > 0).map((v) => ({
        value: v as Region,
        label: REGION_LABELS[v],
        count: counts.get(v) ?? 0,
      })),
    };
    return json(200, meta);
  }

  // ---------- 模型连通测试（BYOK 时代用；服务器持 key 时也保留） ----------
  if (path === '/ai/test' && req.method === 'POST') {
    const cred = serverCred ?? readAiConfig(body);
    if (!cred) return fail(400, 'MODEL_NOT_CONFIGURED', '请填写模型地址、密钥和模型名');
    const result = await testConnection(cred);
    return json(200, result);
  }

  // ---------- 开局 ----------
  if (path === '/solo' && req.method === 'POST') {
    const difficulty = Math.min(3, Math.max(1, Number(body.difficulty) || 1));
    const polity = typeof body.polity === 'string' && body.polity ? body.polity : null;
    const region = typeof body.region === 'string' && body.region ? (body.region as Region) : null;
    const worldEra = typeof body.worldEra === 'string' && body.worldEra ? body.worldEra : null;
    const share = Number(body.cnShare);
    const cnShare = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0.5;
    const mode = body.mode === 'guided' ? 'guided' : 'strict';
    const pronoun = body.pronoun === 'neutral' ? 'neutral' : 'normal';
    const turnsRaw = Number(body.turns);
    const turns = Number.isFinite(turnsRaw) && turnsRaw > 0 ? Math.round(turnsRaw) : undefined;
    const session = await rt.solo.create({ difficulty, polity, region, worldEra, cnShare, mode, pronoun, turns });
    return json(201, projectSession(session));
  }

  // ---------- 会话 ----------
  const soloMatch = path.match(/^\/solo\/([A-Za-z0-9-]+)(\/(ask|guess|reveal))?$/);
  if (soloMatch) {
    const id = soloMatch[1];
    const action = soloMatch[3];

    if (!action && req.method === 'GET') {
      try {
        return json(200, projectSession(rt.solo.require(id)));
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (action === 'ask' && req.method === 'POST') {
      const question = String(body.question ?? '').trim();
      if (!question) return fail(400, 'EMPTY_QUESTION', '问题不能为空');
      const cred = serverCred ?? readAiConfig(body);
      if (!cred) return fail(400, 'MODEL_NOT_CONFIGURED', '没有模型配置就无法判定');
      try {
        const result = await rt.solo.ask(id, question, cred, { timeoutMs: 20000 });
        return json(200, result);
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (action === 'guess' && req.method === 'POST') {
      const name = String(body.name ?? '').trim();
      if (!name) return fail(400, 'EMPTY_GUESS', '请输入你猜的人物名');
      try {
        return json(200, rt.solo.guess(id, name));
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (action === 'reveal' && req.method === 'POST') {
      try {
        return json(200, rt.solo.reveal(id));
      } catch (err) {
        return errorResponse(err);
      }
    }
  }

  return fail(404, 'NOT_FOUND', '接口不存在');
}

// ---------- 管理后台（Workers 版：一律要求 Bearer ADMIN_TOKEN） ----------

function sameToken(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleAdmin(req: Request, url: URL, rt: Runtime): Promise<Response> {
  const token = rt.env.ADMIN_TOKEN ?? '';
  if (!token) return fail(503, 'ADMIN_DISABLED', '未配置 ADMIN_TOKEN，管理接口未开放');
  const matched = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (!matched || !sameToken(matched[1]!.trim(), token)) {
    return fail(403, 'ADMIN_FORBIDDEN', '令牌无效');
  }
  if (req.headers.get('x-hq-admin') !== '1') {
    return fail(403, 'ADMIN_HEADER_REQUIRED', '缺少管理请求标识 X-HQ-Admin');
  }

  const path = url.pathname.replace(/^\/api\/admin/, '');
  const body = req.method === 'POST' || req.method === 'PUT' ? await readBody(req) : {};

  if (path === '/meta' && req.method === 'GET') {
    const vocab = rt.store.vocab();
    return json(200, {
      dynasties: [...DYNASTIES],
      difficulties: DIFFICULTIES,
      roles: vocab.roles,
      provinces: vocab.provinces,
      polities: vocab.polities,
      regions: REGIONS.map((value) => ({ value, label: REGION_LABELS[value] })),
      total: rt.store.total,
      active: rt.store.activeCount,
      tokenRequired: true,
    });
  }

  if (path === '/characters' && req.method === 'GET') {
    const params = url.searchParams;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const polity = (params.get('polity') ?? '').trim();
    const region = (params.get('region') ?? '').trim();
    const difficulty = Number(params.get('difficulty'));
    const retired = params.get('retired') ?? '';

    let items = rt.store.list();
    if (q) items = items.filter((c) => [c.id, c.name, ...c.aliases].some((v) => v.toLowerCase().includes(q)));
    if (polity) items = items.filter((c) => c.polity === polity || (c.polityAlt ?? []).includes(polity));
    if (region) items = items.filter((c) => c.region === region);
    if ([1, 2, 3].includes(difficulty)) items = items.filter((c) => c.difficulty === difficulty);
    if (retired === '1') items = items.filter((c) => c.retired);
    if (retired === '0') items = items.filter((c) => !c.retired);
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    return json(200, { total: items.length, items });
  }

  const byId = path.match(/^\/characters\/([A-Za-z0-9_-]+)$/);
  if (byId) {
    const id = byId[1]!;
    if (req.method === 'GET') {
      const character = rt.store.find(id);
      if (!character) return fail(404, 'NOT_FOUND', '找不到这个人物');
      return json(200, { character });
    }
    if (req.method === 'PUT') {
      const result = await rt.store.update(id, body);
      if (!result.ok) return json(400, { error: 'VALIDATION_FAILED', message: '校验未通过，未写入', issues: result.issues });
      rt.solo.reloadIndex(result.index ?? rt.store.index);
      return json(200, { character: result.character, issues: result.issues });
    }
  }

  if (path === '/characters' && req.method === 'POST') {
    const result = await rt.store.create(body);
    if (!result.ok) return json(400, { error: 'VALIDATION_FAILED', message: '校验未通过，未写入', issues: result.issues });
    rt.solo.reloadIndex(result.index ?? rt.store.index);
    return json(201, { character: result.character, issues: result.issues });
  }

  const retire = path.match(/^\/characters\/([A-Za-z0-9_-]+)\/retire$/);
  if (retire && req.method === 'POST') {
    const result = await rt.store.setRetired(retire[1]!, Boolean(body.retired));
    if (!result.ok) return json(400, { error: 'VALIDATION_FAILED', message: '操作失败', issues: result.issues });
    rt.solo.reloadIndex(result.index ?? rt.store.index);
    return json(200, { character: result.character });
  }

  if (path === '/validate' && req.method === 'POST') {
    const idToUpdate = typeof body.id === 'string' && body.id ? body.id : null;
    const { character, issues } = rt.store.check(body.character ?? body, idToUpdate);
    return json(200, { ok: !issues.some((i) => i.level === 'error'), character, issues });
  }

  if (path === '/health' && req.method === 'GET') {
    return json(200, rt.store.health());
  }

  if (path === '/export' && req.method === 'GET') {
    return new Response(rt.store.exportText(), {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': 'attachment; filename="characters.json"',
      },
    });
  }

  return fail(404, 'NOT_FOUND', '接口不存在');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        const rt = await initRuntime(env);
        if (url.pathname.startsWith('/api/settings/vault')) {
          return handleVault(env.DB, req);
        }
        if (url.pathname.startsWith('/api/admin')) {
          return handleAdmin(req, url, rt);
        }
        return await handleApi(req, url, rt);
      } catch (err) {
        console.error('init.failed', err);
        return fail(503, 'BOOTSTRAP_FAILED', '服务初始化失败，请稍后重试');
      }
    }

    // 静态资源（含 SPA 回退）
    return env.ASSETS.fetch(req);
  },
};
