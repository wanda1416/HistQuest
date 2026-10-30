import type { AiConfig } from '../shared/protocol.ts';
import type { PronounStyle } from '../shared/domain.ts';

/**
 * 设置保险箱：管理密钥与数据密钥分离。
 *
 * 管理密钥（accountSecret，32B，用户抄写的那串）
 *   ├─ authKey = HKDF(secret, "auth")  → 只用于向服务端证明身份，服务端存它的 SHA-256
 *   └─ kek     = HKDF(secret, "wrap")  → 只用于包裹数据密钥
 *
 * 数据密钥 DEK（32B 随机，用户无感）：真正加密设置 blob
 *
 * 这样换管理密钥时只需用新 KEK 重新包裹 DEK，blob 不必重加密；
 * 服务端拿到的只有 auth_hash、wrapped_dek 与 blob，三者都无法直接解出设置。
 */

export const KEY_BYTES = 32;
const IV_BYTES = 12;
const HKDF_SALT = 'hq-vault-v1';

export interface VaultPayload {
  version: 1;
  aiConfig: AiConfig | null;
  prefs: { pronoun?: PronounStyle; turns?: number | null } | null;
  questions: string[];
  savedAt: number;
}

export interface DerivedKeys {
  /** 服务端用它校验身份（只传它，不传管理密钥） */
  authKey: Uint8Array;
  /** 本地用它包裹 / 解包数据密钥 */
  kek: Uint8Array;
}

/* ---------------- 管理密钥编码（Base32，去掉易混字符 I O 0 1） ---------------- */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function encodeManagementKey(secret: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of secret) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)?.join('-') ?? out;
}

export function decodeManagementKey(code: string): Uint8Array | null {
  const clean = String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!clean) return null;

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) return null;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (out.length !== KEY_BYTES) return null;
  return new Uint8Array(out);
}

/* ---------------- 密钥生成与编码 ---------------- */

export function generateKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

export function keyToBase64(key: Uint8Array): string {
  let binary = '';
  for (const byte of key) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function keyFromBase64(text: string): Uint8Array | null {
  try {
    const binary = atob(String(text ?? ''));
    if (binary.length !== KEY_BYTES) return null;
    const bytes = new Uint8Array(KEY_BYTES);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/* ---------------- HKDF 派生 ---------------- */

export async function deriveKeys(secret: Uint8Array): Promise<DerivedKeys> {
  const base = await crypto.subtle.importKey('raw', copyBuffer(secret), 'HKDF', false, ['deriveBits']);
  const salt = new TextEncoder().encode(HKDF_SALT);

  const [authBits, kekBits] = await Promise.all([
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('auth') },
      base,
      256,
    ),
    crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt, info: new TextEncoder().encode('wrap') },
      base,
      256,
    ),
  ]);

  return { authKey: new Uint8Array(authBits), kek: new Uint8Array(kekBits) };
}

/** authKey 的 SHA-256（hex）：服务端存这个值做校验 */
export async function authHashOf(authKey: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', copyBuffer(authKey));
  return toHex(new Uint8Array(digest));
}

/** 服务端记录主键：authHash 前 16 字节 */
export function vaultIdFromAuthHash(authHash: string): string {
  return authHash.slice(0, 32);
}

/* ---------------- 数据密钥包裹 ---------------- */

export async function wrapDataKey(kek: Uint8Array, dek: Uint8Array): Promise<string> {
  return sealBytes(kek, dek);
}

export async function unwrapDataKey(kek: Uint8Array, wrapped: string): Promise<Uint8Array> {
  const bytes = await openBytes(kek, wrapped);
  if (bytes.length !== KEY_BYTES) throw new Error('数据密钥长度不正确');
  return bytes;
}

/* ---------------- 设置载荷加解密（用数据密钥） ---------------- */

export async function sealPayload(dek: Uint8Array, payload: VaultPayload): Promise<string> {
  return sealBytes(dek, new TextEncoder().encode(JSON.stringify(payload)));
}

export async function openPayload(dek: Uint8Array, blobText: string): Promise<VaultPayload> {
  let plain: Uint8Array;
  try {
    plain = await openBytes(dek, blobText);
  } catch {
    throw new Error('解密失败：数据密钥不匹配或数据已损坏');
  }

  const payload = JSON.parse(new TextDecoder().decode(plain)) as VaultPayload;
  if (payload?.version !== 1) throw new Error('设置格式版本不受支持');
  return payload;
}

/* ---------------- 内部：AES-256-GCM ---------------- */

interface SealedBlob {
  iv: string;
  ct: string;
}

async function sealBytes(key: Uint8Array, data: Uint8Array): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey('raw', copyBuffer(key), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    cryptoKey,
    data as BufferSource,
  );

  const blob: SealedBlob = { iv: toBase64(iv), ct: toBase64(new Uint8Array(sealed)) };
  return JSON.stringify(blob);
}

async function openBytes(key: Uint8Array, blobText: string): Promise<Uint8Array> {
  let blob: SealedBlob;
  try {
    blob = JSON.parse(blobText) as SealedBlob;
  } catch {
    throw new Error('云端数据格式不正确');
  }
  if (!blob?.iv || !blob?.ct) throw new Error('云端数据格式不正确');

  const cryptoKey = await crypto.subtle.importKey('raw', copyBuffer(key), 'AES-GCM', false, ['decrypt']);
  const iv = fromBase64(blob.iv);
  const data = fromBase64(blob.ct);

  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    cryptoKey,
    data as BufferSource,
  );
  return new Uint8Array(plain);
}

function copyBuffer(key: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(key.length);
  copy.set(key);
  return copy.buffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(String(text ?? ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
