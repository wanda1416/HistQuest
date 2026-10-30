/**
 * 会话令牌：HMAC-SHA256 签名的自包含 token。
 *
 * 设计：多 isolate 友好——验证只需密钥与纯计算，不查库。
 * 格式：base64url(payload).base64url(hmac)
 * payload: { uid, role, ask, exp }  （ask=当日已问次数由服务端另记，
 *           这里只放身份与过期；轮换密钥靠 exp 自然过期）
 */

export interface SessionPayload {
  uid: string;
  role: 'user' | 'admin';
  /** 过期时间（epoch 秒） */
  exp: number;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signSession(payload: SessionPayload, secret: string): Promise<string> {
  const body = b64urlEncode(enc.encode(JSON.stringify(payload)));
  const sig = new Uint8Array(
    await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body)),
  );
  return `${body}.${b64urlEncode(sig)}`;
}

export async function verifySessionToken(
  token: string,
  secret: string,
): Promise<SessionPayload | null> {
  const [body, sig] = String(token ?? '').split('.');
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      b64urlDecode(sig) as unknown as ArrayBuffer,
      enc.encode(body),
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(body))) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
    if (!payload.uid || (payload.role !== 'user' && payload.role !== 'admin')) return null;
    return payload;
  } catch {
    return null;
  }
}

/** cookie 名 */
export const SESSION_COOKIE = 'hq_session';

export const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 天

export function sessionCookieHeader(token: string, maxAge = SESSION_TTL_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readSessionCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=') || null;
  }
  return null;
}
