import type { D1Database } from './d1.ts';
import type { AuthUser } from './auth.ts';
import { takeUserQuota } from './quota.ts';

/**
 * 语音识别（ASR）：POST /api/ai/transcribe
 *
 * 设计要点（决策见 docs/DECISIONS.md）：
 * - 语音只是**输入法**：识别出的文字回给客户端填进提问框，玩家可改可删再提交，
 *   不直接进 ask——ASR 出错要能改，且破甲审查记的是最终文本
 * - 走 **OpenAI 兼容** `/v1/audio/transcriptions`（Whisper 系事实标准），
 *   硅基流动/Groq/自建 faster-whisper 都是这个接口；豆包等私有协议以后按需加 provider
 * - 音频**即弃不存**：识别完不留文件，game_turns 只记最终文本
 * - **计入每日配额**：一次识别 ≈ 一次提问的资源消耗，防刷
 * - 音频大小硬限制 10MB（约 20 分钟 webm/opus，实际一句提问 < 50KB）
 */

export interface TranscribeEnv {
  DB: D1Database;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
  /** ASR 模型名（如 SenseVoiceSmall / whisper-large-v3-turbo）；未配置 = 功能关闭 */
  AI_ASR_MODEL?: string;
  /**
   * ASR 专用端点/密钥（可选）。不配则复用 LLM 的 baseURL/apiKey——
   * 适用于"聊天和识别是同一个 OpenAI 兼容服务"的部署；
   * 分开部署时（比如聊天用 DeepSeek、识别用硅基流动）配这两个。
   */
  AI_ASR_BASE_URL?: string;
  AI_ASR_API_KEY?: string;
  /**
   * Cloudflare Workers AI 绑定（推荐首选）：账号自带每天 10k Neurons 免费额度
   * （whisper ≈0.023 Neurons/分钟音频 → 每天约 4.6 小时，朋友规模用不完），
   * 零密钥、大陆可达（Cloudflare 边缘）。配了就优先用它，外部 ASR 降为备用。
   */
  AI?: {
    run(model: string, input: unknown): Promise<unknown>;
  };
}

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = /^audio\/(webm|ogg|mpeg|mp3|mp4|wav|x-wav|wave)/i;

/** ASR 是否可用：env 或后台覆盖配置里有模型名 */
export async function asrReady(db: D1Database, env: TranscribeEnv): Promise<boolean> {
  const override = await readLlmOverride(db);
  if (override?.asrModel) return true;
  return Boolean(env.AI_ASR_MODEL);
}

/** 读后台改的 LLM 覆盖配置（与 bundle.ts 的 readLlmOverride 同一张表） */
async function readLlmOverride(
  db: D1Database,
): Promise<{ baseURL?: string; model?: string; apiKey?: string; asrModel?: string; asrBaseURL?: string; asrApiKey?: string } | null> {
  const row = await db
    .prepare("SELECT v FROM app_settings WHERE k = 'llm'")
    .bind()
    .first<{ v: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.v) as {
      baseURL?: string;
      model?: string;
      apiKey?: string;
      asrModel?: string;
      asrBaseURL?: string;
      asrApiKey?: string;
    };
  } catch {
    return null;
  }
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

/** 组装上游 base URL（与 ai/client.ts 的 resolveEndpoint 同规则，但落到 /audio/transcriptions） */
function transcribeEndpoint(baseURL: string): string {
  let base = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new Error('empty base url');
  if (/\/audio\/transcriptions$/i.test(base)) return base;
  if (!/\/v\d+$/i.test(base)) base += '/v1';
  return `${base}/audio/transcriptions`;
}

export async function handleTranscribe(
  req: Request,
  env: TranscribeEnv & { DB: D1Database },
  user: AuthUser,
): Promise<Response> {
  const started = Date.now();

  const override = await readLlmOverride(env.DB);
  // ASR 端点解析优先级：专用 env > 专用覆盖 > LLM 覆盖 > LLM env
  const baseURL = override?.asrBaseURL ?? env.AI_ASR_BASE_URL ?? override?.baseURL ?? env.AI_BASE_URL;
  const apiKey = override?.asrApiKey ?? env.AI_ASR_API_KEY ?? override?.apiKey ?? env.AI_API_KEY;
  const asrModel = override?.asrModel ?? env.AI_ASR_MODEL;
  // Workers AI 绑定在就能用（免费档），外部三元组只是备用——都不满足才 503
  if (!env.AI && !(baseURL && apiKey && asrModel)) {
    return fail(503, 'ASR_NOT_CONFIGURED', '语音识别未配置（缺 AI 绑定或 AI_ASR_MODEL）');
  }

  const ct = req.headers.get('content-type') ?? '';
  if (!ct.includes('multipart/form-data')) {
    return fail(400, 'BAD_REQUEST', '请用 multipart/form-data 上传音频');
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, 'BAD_REQUEST', '请求体不是合法的 multipart 表单');
  }

  const audio = form.get('audio');
  if (!(audio instanceof File)) {
    return fail(400, 'NO_AUDIO', '缺少 audio 字段（音频文件）');
  }
  if (audio.size === 0) return fail(400, 'EMPTY_AUDIO', '音频是空的');
  if (audio.size > MAX_AUDIO_BYTES) {
    return fail(413, 'AUDIO_TOO_LARGE', '音频超过 10MB（一句话提问不该这么大）');
  }
  const mime = audio.type || 'audio/webm';
  if (!ALLOWED_MIME.test(mime)) {
    return fail(415, 'UNSUPPORTED_AUDIO', `不支持的音频格式：${mime}`);
  }

  // 配额：一次识别 = 一次提问的额度（站方资源）；与 ask 同一套原子扣减。
  // 放在上游调用前、格式校验后：格式错误不扣；上游故障这单不退（上游已收到请求）。
  if (user.role !== 'admin') {
    const quota = await takeUserQuota(env.DB, user);
    if (!quota.ok) return fail(429, 'QUOTA_EXCEEDED', quota.message ?? '今日额度已用完');
  }

  /* ---------- 识别：首选 Workers AI（免费），失败回落外部 OpenAI 兼容端点 ---------- */

  if (env.AI) {
    try {
      const result = (await env.AI.run('@cf/openai/whisper', {
        audio: await audio.arrayBuffer(),
      })) as { text?: string };
      const text = String(result?.text ?? '').trim();
      if (text) return json(200, { text, ms: Date.now() - started });
      // 空结果（真没说话）也直接返回：whisper 对静音/噪声会回空串
      return json(200, { text: '', ms: Date.now() - started });
    } catch (err) {
      // Workers AI 失败（额度耗尽/模型异常）不中断：落回外部端点
      console.error('asr.workers-ai.failed', { message: (err as Error)?.message });
    }
  }

  // 外部端点需要完整三元组
  if (!baseURL || !apiKey || !asrModel) {
    return fail(503, 'ASR_NOT_CONFIGURED', '语音识别不可用（Workers AI 未绑定，外部 ASR 未配置）');
  }

  // 透传给上游 OpenAI 兼容端点
  const upstream = new FormData();
  upstream.append('file', audio, audio.name || 'speech.webm');
  upstream.append('model', asrModel);
  // 中文游戏：显式提示语提高人名/朝代命中（whisper 系支持 prompt 偏置）
  upstream.append('prompt', '历史人物问答：「是」「否」「唐朝」「宋朝」「诗人」「皇帝」等词。');

  let res: Response;
  try {
    res = await fetch(transcribeEndpoint(baseURL), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: upstream,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    const aborted = (err as Error)?.name === 'TimeoutError' || (err as Error)?.name === 'AbortError';
    return fail(aborted ? 504 : 502, aborted ? 'ASR_TIMEOUT' : 'ASR_NETWORK', aborted ? '识别超时，再试一次' : '连不上识别服务');
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    const code = res.status === 401 || res.status === 403 ? 'ASR_AUTH' : res.status === 429 ? 'ASR_RATE' : 'ASR_HTTP';
    return fail(res.status === 429 ? 429 : 502, code, `识别服务返回 ${res.status}${detail ? `：${detail}` : ''}`);
  }

  let text = '';
  try {
    const data = (await res.json()) as { text?: string };
    text = String(data?.text ?? '').trim();
  } catch {
    return fail(502, 'ASR_BAD_RESPONSE', '识别服务返回了非 JSON 响应');
  }

  return json(200, { text, ms: Date.now() - started } satisfies { text: string; ms: number });
}
