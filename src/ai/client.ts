import type { AiCredential } from '../shared/domain.ts';

export type AiErrorCode =
  | 'TIMEOUT'
  | 'AUTH'
  | 'RATE'
  | 'HTTP'
  | 'NETWORK'
  | 'BAD_JSON'
  | 'EMPTY'
  | 'UNSUPPORTED';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly status?: number;

  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message);
    this.name = 'AiError';
    this.code = code;
    this.status = status;
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
}

const DEFAULT_TIMEOUT_MS = 6000;

/** 兼容 OpenAI 风格端点：允许用户填 https://host 或 https://host/v1 */
export function resolveEndpoint(baseURL: string): string {
  let base = String(baseURL ?? '').trim().replace(/\/+$/, '');
  if (!base) throw new AiError('UNSUPPORTED', '未填写模型地址');
  if (/\/chat\/completions$/i.test(base)) return base;
  if (!/\/v\d+$/i.test(base)) base += '/v1';
  return `${base}/chat/completions`;
}

/** 任何可能回显给用户/日志的文本，都要先把密钥抹掉 */
export function scrubSecret(text: string, secret?: string): string {
  let out = String(text ?? '');
  if (secret && secret.length >= 6) {
    out = out.split(secret).join('***');
  }
  out = out.replace(/sk-[A-Za-z0-9_\-]{6,}/g, 'sk-***');
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{6,}/gi, '$1***');
  return out.slice(0, 300);
}

export async function chat(
  cred: AiCredential,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  if (cred.kind !== 'byok') {
    throw new AiError('UNSUPPORTED', '平台代调模式尚未开放（Steam 版预留）');
  }

  const url = resolveEndpoint(cred.baseURL);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.apiKey}`,
      },
      body: JSON.stringify({
        model: cred.model,
        messages,
        temperature: opts.temperature ?? cred.temperature ?? 0.1,
        max_tokens: opts.maxTokens ?? 400,
        stream: false,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') {
      throw new AiError('TIMEOUT', '模型响应超时');
    }
    throw new AiError('NETWORK', '无法连接模型服务，请检查地址与网络');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const code: AiErrorCode =
      res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 429 ? 'RATE' : 'HTTP';
    let detail = '';
    try {
      detail = scrubSecret(await res.text(), cred.apiKey);
    } catch {
      detail = '';
    }
    const hint =
      code === 'AUTH'
        ? '密钥无效或无权限'
        : code === 'RATE'
          ? '请求过于频繁，请稍后再试'
          : `模型服务返回 ${res.status}`;
    throw new AiError(code, detail ? `${hint}（${detail}）` : hint, res.status);
  }

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    throw new AiError('BAD_JSON', '模型服务返回了非 JSON 响应');
  }

  const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })?.choices?.[0]
    ?.message?.content;

  if (typeof content !== 'string' || !content.trim()) {
    throw new AiError('EMPTY', '模型返回为空');
  }
  return content;
}

/** 从可能带 ```json 围栏或前后废话的文本里抠出第一个完整 JSON 对象 */
export function extractJson(text: string): unknown {
  const raw = String(text ?? '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates: string[] = [];
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(raw);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // 继续尝试括号打捞
    }
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < candidate.length; i++) {
      const ch = candidate[i]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(candidate.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new AiError('BAD_JSON', '模型输出不是合法 JSON');
}

export async function chatJson(
  cred: AiCredential,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<unknown> {
  const text = await chat(cred, messages, opts);
  return extractJson(text);
}

export async function testConnection(
  cred: AiCredential,
  timeoutMs = 15000,
): Promise<{ ok: boolean; errorCode?: string; message?: string; latencyMs: number }> {
  const started = Date.now();
  try {
    // 注意：推理模型会把 token 花在 reasoning 上，上限给小了会返回空内容
    await chat(cred, [{ role: 'user', content: '回复两个字：可用' }], {
      timeoutMs,
      maxTokens: 400,
      temperature: 0,
    });
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    const e = err as AiError;
    return {
      ok: false,
      errorCode: e.code ?? 'UNKNOWN',
      message: scrubSecret(e.message ?? '连接失败', cred.kind === 'byok' ? cred.apiKey : undefined),
      latencyMs: Date.now() - started,
    };
  }
}
