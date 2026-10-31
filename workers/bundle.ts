import { DYNASTIES, REGIONS, REGION_LABELS, isTargetCategory, type Region } from '../src/shared/domain.ts';
import type { AiCredential } from '../src/shared/domain.ts';
import type { MetaRes } from '../src/shared/protocol.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { SoloStore, SoloError } from '../src/server/solo.ts';
import { projectSession } from '../src/server/dto.ts';
import { AiError, testConnection } from '../src/ai/client.ts';
import { D1SessionPersistence, type D1Database } from './d1.ts';
import { D1HistoryStore } from './d1-history.ts';
import { D1TargetStore } from './d1-targets.ts';
import { handleVault } from './vault.ts';
import { handleAuth, currentUser, ensureAdmin, type AuthUser } from './auth.ts';
import { takeUserQuota } from './quota.ts';
import { handleRooms } from './rooms-api.ts';
import { RoomDo } from './room-do.ts';
import { handleTranscribe } from './asr.ts';

/** Durable Object 必须在模块层导出，wrangler 才认得这个 class */
export { RoomDo };

/**
 * Cloudflare Worker 入口：纯 BS 一体化（见 docs/ARCHITECTURE.md §6）。
 * 路由与 src/server/routes.ts 逐条对齐；core/ai 层原样复用。
 *
 * 密钥：AI_API_KEY 走 wrangler secret，只存在于 Worker→LLM 这一段。
 * 用户系统：邀请码注册 + 用户名密码登录；ask 按账号/访客 IP 计配额。
 */

interface Env {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  /** 语音识别模型（OpenAI 兼容 /audio/transcriptions）；未配置 = 语音按钮隐藏 */
  AI_ASR_MODEL?: string;
  /** ASR 专用端点/密钥（可选；不配则复用 LLM 的） */
  AI_ASR_BASE_URL?: string;
  AI_ASR_API_KEY?: string;
  /** Cloudflare Workers AI（语音识别首选：账号免费额度，零密钥） */
  AI: { run(model: string, input: unknown): Promise<unknown> };
  SOLO_TURNS?: string;
  ADMIN_TOKEN?: string;
  /** 会话签名密钥（secret）；未配置时用户系统禁用 */
  SESSION_SECRET?: string;
  /** 预置管理员 */
  ADMIN_USER?: string;
  ADMIN_PASSWORD?: string;
  /** 对战房间：每房一个 Durable Object 实例 */
  ROOMS: {
    idFromName(name: string): unknown;
    get(id: unknown): { fetch(req: Request): Promise<Response> };
  };
}

const DIFFICULTIES = [
  { level: 1, label: '入门', desc: '家喻户晓的人物' },
  { level: 2, label: '进阶', desc: '需要一点历史功底' },
  { level: 3, label: '考据', desc: '冷门，靠推理' },
];

const MAX_TURNS_DEFAULT = 50;

interface Runtime {
  index: CharacterIndex;
  store: D1TargetStore;
  solo: SoloStore;
  /** 对局账本（永久历史），与 SoloStore 的归档钩子共用同一实例 */
  history: D1HistoryStore;
  env: Env;
  maxTurns: number;
  /** 后台可改的 LLM 覆盖配置（D1 app_settings.llm）；优先于 env */
  llmOverride: { baseURL: string; model: string; apiKey?: string; asrModel?: string; asrBaseURL?: string; asrApiKey?: string } | null;
}

/** 读 D1 的 LLM 覆盖配置 */
async function readLlmOverride(db: D1Database): Promise<Runtime['llmOverride'] | null> {
  const row = await db
    .prepare("SELECT v FROM app_settings WHERE k = 'llm'")
    .bind()
    .first<{ v: string }>();
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.v) as { baseURL?: string; model?: string; apiKey?: string; asrModel?: string; asrBaseURL?: string; asrApiKey?: string };
    if (!parsed.baseURL || !parsed.model) return null;
    return { baseURL: parsed.baseURL, model: parsed.model, ...(parsed.apiKey ? { apiKey: parsed.apiKey } : {}) };
  } catch {
    return null;
  }
}

/** LLM 设置更新后刷新运行时（本 isolate 立即生效；其他 isolate 下次启动生效） */
async function refreshLlmOverride(rt: Runtime): Promise<void> {
  rt.llmOverride = await readLlmOverride(rt.env.DB);
}

let runtime: Promise<Runtime> | null = null;

/** 惰性初始化：首个请求触发 D1 读取 + 种子导入 */
function initRuntime(env: Env): Promise<Runtime> {
  if (!runtime) {
    runtime = (async () => {
      const store = new D1TargetStore({ db: env.DB });
      {
        const seed = await import('./seed.ts');
        await store.init(seed.SEED_CHARACTERS);
      }
      const index = store.index;
      const persistence = new D1SessionPersistence(env.DB);
      const sessions = await persistence.load();
      const history = new D1HistoryStore(env.DB);
      const solo = new SoloStore(index, {
        awaitPersist: true,
        persistence,
        history,
        turns: Number(env.SOLO_TURNS) || MAX_TURNS_DEFAULT,
        preloaded: sessions,
        newId: () => crypto.randomUUID().replace(/-/g, ''),
      });
      const maxTurns = Number(env.SOLO_TURNS) || MAX_TURNS_DEFAULT;

      // 预置管理员（幂等）
      if (env.SESSION_SECRET && env.ADMIN_USER && env.ADMIN_PASSWORD) {
        await ensureAdmin(env.DB, env.ADMIN_USER, env.ADMIN_PASSWORD);
      }

      return { index, store, solo, history, env, maxTurns, llmOverride: await readLlmOverride(env.DB) };
    })().catch((err) => {
      runtime = null; // 失败后允许重试
      throw err;
    });
  }
  return runtime;
}

/**
 * 只接受"已经解析好的值"。传 Promise 会让 JSON.stringify 得到一个空对象 `{}`，
 * 客户端拿到空响应后表现为"点了没反应"，很难查。用类型把它挡在编译期。
 */
type Resolved<T> = T extends Promise<unknown> ? never : T;

function json<T>(status: number, body: Resolved<T>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function fail(status: number, error: string, message: string): Response {
  return json(status, { error, message });
}

/** 服务端模型凭据：未配置时返回 null，前端回落 BYOK */
function serverCredential(env: Env, override?: Runtime['llmOverride']): AiCredential | null {
  // 后台覆盖配置优先（D1），回落部署时的 env secret
  if (override?.apiKey) {
    return { kind: 'byok', baseURL: override.baseURL, apiKey: override.apiKey, model: override.model, temperature: 0.1 };
  }
  if (override && env.AI_API_KEY) {
    return { kind: 'byok', baseURL: override.baseURL, apiKey: env.AI_API_KEY, model: override.model, temperature: 0.1 };
  }
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
  // transcribe 的 body 是 multipart，预读 json() 会把它消费掉——路由内部自己读
  const isMultipart = (req.headers.get('content-type') ?? '').includes('multipart/form-data');
  const body = req.method === 'POST' && !isMultipart ? await readBody(req) : {};
  const serverCred = serverCredential(rt.env, rt.llmOverride);

  // ---------- meta ----------
  if (path === '/meta' && req.method === 'GET') {
    const counts = new Map<string, number>();
    for (const c of rt.index.list) counts.set(c.region, (counts.get(c.region) ?? 0) + 1);
    const user = rt.env.SESSION_SECRET
      ? await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET)
      : null;
    const meta: MetaRes = {
      dynasties: [...DYNASTIES],
      difficulties: DIFFICULTIES,
      maxTurns: rt.maxTurns,
      serverModelReady: Boolean(serverCred),
      dataCount: rt.index.size,
      categories: rt.index.categoryCounts(),
      regions: REGIONS.filter((v) => (counts.get(v) ?? 0) > 0).map((v) => ({
        value: v as Region,
        label: REGION_LABELS[v],
        count: counts.get(v) ?? 0,
      })),
      asrReady: Boolean(rt.env.AI || (rt.llmOverride?.asrModel ?? rt.env.AI_ASR_MODEL)),
    };
    return json(200, {
      ...meta,
      authEnabled: Boolean(rt.env.SESSION_SECRET),
      user: user ? { username: user.username, role: user.role, allowServerKey: user.allowServerKey } : null,
    });
  }

  // ---------- 我的历史 ----------
  if (path === '/history/mine' && req.method === 'GET') {
    const user = rt.env.SESSION_SECRET
      ? await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET)
      : null;
    if (!user) return fail(401, 'LOGIN_REQUIRED', '登录后可查看自己的对局历史');
    const result = await rt.history.list({
      userId: user.id,
      limit: Number(url.searchParams.get('limit')) || undefined,
      offset: Number(url.searchParams.get('offset')) || undefined,
    });
    return json(200, result);
  }

  const myGame = path.match(/^\/history\/mine\/([A-Za-z0-9-]+)$/);
  if (myGame && req.method === 'GET') {
    const user = rt.env.SESSION_SECRET
      ? await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET)
      : null;
    if (!user) return fail(401, 'LOGIN_REQUIRED', '登录后可查看自己的对局历史');
    const detail = await rt.history.get(myGame[1]!);
    if (!detail) return fail(404, 'NOT_FOUND', '找不到这一局');
    if (detail.userId !== user.id && user.role !== 'admin') {
      return fail(403, 'FORBIDDEN', '这局不属于当前账号');
    }
    return json(200, detail);
  }

  // ---------- 模型连通测试（BYOK 时代用；服务器持 key 时也保留） ----------
  if (path === '/ai/test' && req.method === 'POST') {
    const cred = readAiConfig(body) ?? serverCred;
    if (!cred) return fail(400, 'MODEL_NOT_CONFIGURED', '请填写模型地址、密钥和模型名');
    const result = await testConnection(cred);
    return json(200, result);
  }

  // ---------- 语音识别（ASR）：音频 → 文字，文字回给输入框，不直接进 ask ----------
  if (path === '/ai/transcribe' && req.method === 'POST') {
    const user = rt.env.SESSION_SECRET
      ? await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET)
      : null;
    if (!user) return fail(401, 'LOGIN_REQUIRED', '语音识别需要先登录');
    return handleTranscribe(req, rt.env, user);
  }

  // ---------- 开局 ----------
  if (path === '/solo' && req.method === 'POST') {
    const difficulty = Math.min(3, Math.max(1, Number(body.difficulty) || 1));
    const category =
      body.category === 'mixed' || isTargetCategory(body.category) ? body.category : 'character';
    const polity = typeof body.polity === 'string' && body.polity ? body.polity : null;
    const region = typeof body.region === 'string' && body.region ? (body.region as Region) : null;
    const worldEra = typeof body.worldEra === 'string' && body.worldEra ? body.worldEra : null;
    const share = Number(body.cnShare);
    const cnShare = Number.isFinite(share) ? Math.min(1, Math.max(0, share)) : 0.5;
    const mode = body.mode === 'assist' ? 'assist' : body.mode === 'guided' ? 'guided' : 'strict';
    const pronoun = body.pronoun === 'neutral' ? 'neutral' : 'normal';
    const turnsRaw = Number(body.turns);
    const turns = Number.isFinite(turnsRaw) && turnsRaw > 0 ? Math.round(turnsRaw) : undefined;
    const creator = rt.env.SESSION_SECRET
      ? await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET)
      : null;
    // 开局即要求登录：否则会留下无主对局（能开局、能猜、能放弃，一问都没问）
    if (rt.env.SESSION_SECRET && !creator) {
      return fail(401, 'LOGIN_REQUIRED', '登录后才能开局');
    }
    const session = await rt.solo.create({
      difficulty, category, polity, region, worldEra, cnShare, mode, pronoun, turns,
      userId: creator?.id ?? null,
      userName: creator?.username ?? null,
    });
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

      // 凭据规则：BYOK 优先（游客也可用）；服务端 Key 仅限登录用户。
      const user = rt.env.SESSION_SECRET
        ? await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET)
        : null;
      const byok = readAiConfig(body);
      let cred: AiCredential | null = byok ?? null;

      if (!cred && serverCred) {
        if (!user) {
          return fail(401, 'LOGIN_REQUIRED', '未登录只能使用自己的模型（BYOK）；注册/登录后可用站方模型');
        }
        if (user.role !== 'admin' && !user.allowServerKey) {
          return fail(403, 'BYOK_REQUIRED', '管理员为本账号关闭了站方模型，请在设置里填写自己的模型');
        }
        // 管理员不限量
        if (user.role !== 'admin') {
          const quota = await takeUserQuota(rt.env.DB, user);
          if (!quota.ok) return fail(429, 'QUOTA_EXCEEDED', quota.message ?? '今日额度已用完');
        }
        cred = serverCred;
      }
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
        // SoloStore 的写方法都是 async：不 await 会把 Promise 序列化成 {}，
        // 客户端拿不到 correct / turnsLeft，表现为"点了没反应"
        const result = await rt.solo.guess(id, name);
        return json(200, result);
      } catch (err) {
        return errorResponse(err);
      }
    }

    if (action === 'reveal' && req.method === 'POST') {
      try {
        const result = await rt.solo.reveal(id);
        return json(200, result);
      } catch (err) {
        return errorResponse(err);
      }
    }
  }

  return fail(404, 'NOT_FOUND', '接口不存在');
}

// ---------- 管理后台（双通道：管理员会话为主，ADMIN_TOKEN 备用） ----------

function sameToken(given: string, expected: string): boolean {
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

async function handleAdmin(req: Request, url: URL, rt: Runtime): Promise<Response> {
  // 通道一：管理员会话（登录的 role=admin 用户）
  let isAdminSession = false;
  if (rt.env.SESSION_SECRET) {
    const user = await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET);
    isAdminSession = user?.role === 'admin';
  }
  // 通道二：ADMIN_TOKEN Bearer（逃生门，防会话故障锁死）
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  const tokenOk = Boolean(rt.env.ADMIN_TOKEN) && Boolean(bearer) && sameToken(bearer![1]!.trim(), rt.env.ADMIN_TOKEN!);

  if (!isAdminSession && !tokenOk) {
    return fail(403, 'ADMIN_FORBIDDEN', '需要管理员账号登录，或携带 ADMIN_TOKEN');
  }
  if (!tokenOk && req.headers.get('x-hq-admin') !== '1') {
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
      types: vocab.types,
      provinces: vocab.provinces,
      polities: vocab.polities,
      worldErasByRegion: vocab.worldErasByRegion,
      regions: REGIONS.map((value) => ({ value, label: REGION_LABELS[value] })),
      total: rt.store.total,
      categories: rt.store.categories,
      active: rt.store.activeCount,
      tokenRequired: true,
    });
  }

  if (path === '/targets' && req.method === 'GET') {
    const params = url.searchParams;
    const q = (params.get('q') ?? '').trim().toLowerCase();
    const polity = (params.get('polity') ?? '').trim();
    const region = (params.get('region') ?? '').trim();
    const difficulty = Number(params.get('difficulty'));
    const retired = params.get('retired') ?? '';
    const worldEra = (url.searchParams.get("worldEra") ?? "").trim();

    let items = rt.store.list();
    if (q) items = items.filter((c) => [c.id, c.name, ...c.aliases].some((v) => v.toLowerCase().includes(q)));
    if (polity) items = items.filter((c) => c.polity === polity || (c.polityAlt ?? []).includes(polity));
    if (region) items = items.filter((c) => c.region === region);
    if ([1, 2, 3].includes(difficulty)) items = items.filter((c) => c.difficulty === difficulty);
    const category = (url.searchParams.get('category') ?? '').trim();
    if (category) items = items.filter((c) => (c.category ?? 'character') === category);
    if (retired === '1') items = items.filter((c) => c.retired);
    if (retired === '0') items = items.filter((c) => !c.retired);
    if (worldEra) items = items.filter((c) => c.worldEra === worldEra);
    items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
    // 分页：默认全量（老调用方兼容）；显式传 limit 才切页。total 永远是过滤后的总数。
    const total = items.length;
    const limit = Number(url.searchParams.get('limit'));
    const offset = Number(url.searchParams.get('offset')) || 0;
    if (Number.isFinite(limit) && limit > 0) {
      items = items.slice(offset, offset + Math.min(limit, 5000));
    }
    return json(200, { total, items });
  }

  const byId = path.match(/^\/targets\/([A-Za-z0-9_-]+)$/);
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

  if (path === '/targets' && req.method === 'POST') {
    const result = await rt.store.create(body);
    if (!result.ok) return json(400, { error: 'VALIDATION_FAILED', message: '校验未通过，未写入', issues: result.issues });
    rt.solo.reloadIndex(result.index ?? rt.store.index);
    return json(201, { character: result.character, issues: result.issues });
  }

  const retire = path.match(/^\/targets\/([A-Za-z0-9_-]+)\/retire$/);
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

  // ---------- 用户管理 ----------
  if (path === '/users' && req.method === 'GET') {
    const rows = await rt.env.DB
      .prepare(
        `SELECT u.id, u.username, u.role, u.allow_server_key, u.banned, u.created_at,
                u.asks_today, u.quota_day, u.daily_quota
         FROM users u ORDER BY u.created_at DESC LIMIT 500`,
      )
      .bind()
      .all<Record<string, unknown>>();
    const today = new Date();
    const dayNow = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    const users = rows.results.map((r) => ({
      id: r.id,
      username: r.username,
      role: r.role,
      allowServerKey: Boolean(r.allow_server_key),
      banned: Boolean(r.banned),
      createdAt: r.created_at,
      asksToday: Number(r.quota_day) === dayNow ? r.asks_today : 0,
      dailyQuota: typeof r.daily_quota === 'number' ? r.daily_quota : null,
    }));
    return json(200, { total: users.length, users });
  }

  const userToggle = path.match(/^\/users\/([A-Za-z0-9-]+)\/(server-key|ban|quota)$/);
  if (userToggle && req.method === 'POST') {
    const id = userToggle[1]!;
    const what = userToggle[2]!;
    const on = Boolean(body.on);

    // 保护管理员：不允许对 admin 角色做封禁/关停/配额清零（防自锁）
    const target = await rt.env.DB
      .prepare('SELECT role FROM users WHERE id = ?')
      .bind(id)
      .first<{ role: string }>();
    if (target?.role === 'admin' && what !== 'quota') {
      return fail(403, 'ADMIN_PROTECTED', '不能对管理员执行封禁或关闭站方模型');
    }
    if (target?.role === 'admin' && what === 'quota') {
      return fail(403, 'ADMIN_PROTECTED', '管理员配额不受限制（无限）');
    }

    if (what === 'server-key') {
      await rt.env.DB
        .prepare('UPDATE users SET allow_server_key = ?, updated_at = ? WHERE id = ?')
        .bind(on ? 1 : 0, Date.now(), id)
        .run();
    } else if (what === 'quota') {
      // 每日提问配额：0 = 禁用；-1 = 用全局默认
      const q = Math.max(-1, Math.round(Number(body.quota)));
      await rt.env.DB
        .prepare('UPDATE users SET daily_quota = ?, updated_at = ? WHERE id = ?')
        .bind(Number.isFinite(q) ? q : -1, Date.now(), id)
        .run();
    } else {
      await rt.env.DB
        .prepare('UPDATE users SET banned = ?, updated_at = ? WHERE id = ?')
        .bind(on ? 1 : 0, Date.now(), id)
        .run();
    }
    return json(200, { ok: true });
  }

  // 删除账号（不可逆）：只删身份，不删账本；管理员拒绝（防自锁）
  const userDelete = path.match(/^\/users\/([A-Za-z0-9-]+)\/delete$/);
  if (userDelete && req.method === 'POST') {
    const id = userDelete[1]!;
    const target = await rt.env.DB
      .prepare('SELECT username, role FROM users WHERE id = ?')
      .bind(id)
      .first<{ username: string; role: string }>();
    if (!target) return fail(404, 'NOT_FOUND', '用户不存在');
    if (target.role === 'admin') return fail(403, 'ADMIN_PROTECTED', '管理员账号不能删除');

    await rt.env.DB.batch([
      rt.env.DB.prepare('UPDATE invites SET used_by = NULL, used_at = NULL WHERE used_by = ?').bind(id),
      rt.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id),
      rt.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id),
    ]);
    console.log('admin.user.delete', { id, username: target.username });
    return json(200, { ok: true });
  }

  // ---------- 管理员改密 ----------
  if (path === '/change-password' && req.method === 'POST') {
    const me = rt.env.SESSION_SECRET
      ? await currentUser(rt.env.DB, req, rt.env.SESSION_SECRET)
      : null;
    if (!me) return fail(403, 'ADMIN_FORBIDDEN', '修改密码需要管理员会话登录（token 通道不可用）');
    const { hashPassword } = await import('../src/core/password.ts');
    const current = String(body.current ?? '');
    const next = String(body.next ?? '');
    if (next.length < 8) return fail(400, 'BAD_PASSWORD', '新密码至少 8 位');
    const row = await rt.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(me.id).first<{ password_hash: string }>();
    const { verifyPassword } = await import('../src/core/password.ts');
    if (!row || !(await verifyPassword(current, row.password_hash))) {
      return fail(401, 'BAD_CREDENTIALS', '当前密码不对');
    }
    await rt.env.DB
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .bind(await hashPassword(next), Date.now(), me.id)
      .run();
    return json(200, { ok: true });
  }

  // ---------- LLM 服务商设置 ----------
  if (path === '/llm' && req.method === 'GET') {
    return json(200, {
      baseURL: rt.env.AI_BASE_URL ?? '',
      model: rt.env.AI_MODEL ?? '',
      hasKey: Boolean(rt.env.AI_API_KEY),
      maxTurns: rt.maxTurns,
    });
  }

  if (path === '/llm' && req.method === 'POST') {
    // 说明：Workers 的 env 是不可变的；这里落 D1 的 kv 表，启动时 D1 覆盖 env（见 initRuntime）
    const baseURL = String(body.baseURL ?? '').trim();
    const model = String(body.model ?? '').trim();
    const apiKey = String(body.apiKey ?? '').trim();
    if (!baseURL || !model) return fail(400, 'BAD_LLM_CONFIG', '地址和模型名不能为空');
    await rt.env.DB
      .prepare(
        `INSERT INTO app_settings (k, v, updated_at) VALUES ('llm', ?, ?)
         ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
      )
      .bind(JSON.stringify({ baseURL, model, ...(apiKey ? { apiKey } : {}) }), Date.now())
      .run();
    // 立即生效：刷新运行时持有的配置
    await refreshLlmOverride(rt);
    return json(200, { ok: true });
  }

  // ---------- 对局历史（管理员全局） ----------
  if (path === '/history' && req.method === 'GET') {
    const params = url.searchParams;
    const userName = params.get('user')?.trim() || undefined;
    const result = (params.get('result')?.trim() || undefined) as
      | 'won'
      | 'lost'
      | 'abandoned'
      | 'playing'
      | undefined;
    const q = params.get('q')?.trim() || undefined;
    const guest = params.get('guest') === '1';
    const list = await rt.history.list({
      ...(guest ? { userId: 'guest' as const } : {}),
      ...(userName ? { userName } : {}),
      ...(result ? { result } : {}),
      ...(q ? { q } : {}),
      limit: Number(params.get('limit')) || undefined,
      offset: Number(params.get('offset')) || undefined,
    });
    return json(200, list);
  }

  const adminGame = path.match(/^\/history\/([A-Za-z0-9-]+)$/);
  if (adminGame && req.method === 'GET') {
    const detail = await rt.history.get(adminGame[1]!);
    if (!detail) return fail(404, 'NOT_FOUND', '找不到这一局');
    return json(200, detail);
  }

  // ---------- 邀请码管理 ----------
  if (path === '/invites' && req.method === 'GET') {
    const rows = await rt.env.DB
      .prepare(
        `SELECT i.code, i.created_at, i.used_at, i.used_by, u.username AS used_by_name
         FROM invites i LEFT JOIN users u ON u.id = i.used_by
         ORDER BY i.created_at DESC LIMIT 200`,
      )
      .bind()
      .all<Record<string, unknown>>();
    return json(200, {
      total: rows.results.length,
      invites: rows.results.map((r) => ({
        code: r.code,
        createdAt: r.created_at,
        usedAt: r.used_at,
        usedByName: r.used_by_name,
      })),
    });
  }

  if (path === '/invites' && req.method === 'POST') {
    const count = Math.min(20, Math.max(1, Math.round(Number(body.count) || 1)));
    const codes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
      await rt.env.DB
        .prepare('INSERT INTO invites (code, created_by, created_at) VALUES (?, ?, ?)')
        .bind(code, 'admin', Date.now())
        .run();
      codes.push(code);
    }
    return json(201, { codes });
  }

  return fail(404, 'NOT_FOUND', '接口不存在');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        // 对战房间走 Durable Object，不依赖单人的 SoloStore/ChatIndex 初始化，
        // 所以放在 initRuntime 之前：房间请求不该被单人那套启动流程拖住。
        if (url.pathname.startsWith('/api/room')) {
          const roomRes = await handleRooms(req, url, env);
          if (roomRes) return roomRes;
        }

        const rt = await initRuntime(env);
        if (url.pathname.startsWith('/api/settings/vault')) {
          return handleVault(env.DB, req);
        }
        if (url.pathname.startsWith('/api/auth/')) {
          if (!env.SESSION_SECRET) {
            return fail(503, 'AUTH_DISABLED', '用户系统未启用（缺 SESSION_SECRET）');
          }
          return handleAuth(env.DB, req, url, env.SESSION_SECRET, true);
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
