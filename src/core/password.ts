/**
 * 密码哈希：PBKDF2-SHA256，100k 轮，16B 盐。
 * 输出格式：pbkdf2$<iter>$<salt-b64>$<hash-b64>
 * WebCrypto 实现即可在 Node（≥18 全局 crypto）与 Workers 通用。
 */

const ITER = 100_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

const b64encode = (buf: ArrayBuffer | Uint8Array): string => {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

const b64decode = (s: string): Uint8Array => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error('此环境没有 WebCrypto');
  return c.subtle;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = new Uint8Array(SALT_BYTES);
  globalThis.crypto.getRandomValues(salt);

  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2',
      salt: copyBuffer(salt),
      iterations: ITER,
      hash: 'SHA-256',
    },
    await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']),
    KEY_BYTES * 8,
  );
  return `pbkdf2$${ITER}$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = String(stored ?? '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iter = Number(parts[1]);
  if (!Number.isFinite(iter) || iter < 1) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = b64decode(parts[2]!);
    expected = b64decode(parts[3]!);
  } catch {
    return false;
  }

  const bits = await subtle().deriveBits(
    {
      name: 'PBKDF2',
      salt: copyBuffer(salt),
      iterations: iter,
      hash: 'SHA-256',
    },
    await subtle().importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']),
    expected.length * 8,
  );

  // 常量时间比较
  const got = new Uint8Array(bits);
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i]! ^ expected[i]!;
  return diff === 0;
}

/** TS5.7+ 的 ArrayBufferView 泛型在两个运行时下表现不一致，这里统一拷贝成纯 ArrayBuffer */
function copyBuffer(view: Uint8Array): ArrayBuffer {
  return view.slice().buffer as ArrayBuffer;
}
