import type { D1Database } from './d1.ts';

/**
 * 设置在线同步（Workers 版）。
 * 与 Node 版 src/server/settings.ts 同一信任模型：
 * 服务端只存 SHA-256(authKey)，无解密能力；这里用 WebCrypto 实现。
 */

const MAX_BLOB = 64 * 1024;
const MAX_WRAPPED = 4 * 1024;
const AUTH_RE = /^[A-Za-z0-9+/=]{20,100}$/;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 常量时间字符串比较（等长场景） */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface VaultRow {
  vault_id: string;
  auth_hash: string;
  wrapped_dek: string;
  version: number;
  blob: string;
  updated_at: number;
}

async function getVault(db: D1Database, vaultId: string): Promise<VaultRow | null> {
  return db.prepare('SELECT * FROM settings_vault WHERE vault_id = ?').bind(vaultId).first<VaultRow>();
}

export async function handleVault(
  db: D1Database,
  req: Request,
): Promise<Response> {
  const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });

  const authRaw = (req.headers.get('x-vault-auth') ?? '').trim();
  if (!AUTH_RE.test(authRaw)) {
    return json(401, { error: 'UNAUTHORIZED', message: '缺少或格式不正确的管理密钥派生凭据' });
  }
  const authHash = await sha256Hex(authRaw);
  const vaultId = authHash.slice(0, 32);

  if (req.method === 'GET') {
    const row = await getVault(db, vaultId);
    if (!row) return json(404, { error: 'VAULT_NOT_FOUND', message: '云端还没有这份设置' });
    if (!sameString(row.auth_hash, authHash)) {
      return json(403, { error: 'FORBIDDEN', message: '管理密钥不匹配' });
    }
    return json(200, {
      version: row.version,
      blob: row.blob,
      wrappedDek: row.wrapped_dek,
      updatedAt: row.updated_at,
    });
  }

  if (req.method === 'PUT') {
    const body = (await req.json().catch(() => ({}))) as {
      baseVersion?: unknown;
      blob?: unknown;
      wrappedDek?: unknown;
    };
    const blob = typeof body.blob === 'string' ? body.blob : '';
    if (!blob) return json(400, { error: 'BAD_BLOB', message: '密文不能为空' });
    if (blob.length > MAX_BLOB) return json(413, { error: 'BLOB_TOO_LARGE', message: '设置体积过大' });
    const baseVersion = Number(body.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      return json(400, { error: 'BAD_VERSION', message: '版本号不合法' });
    }
    const wrappedDek = typeof body.wrappedDek === 'string' ? body.wrappedDek : '';
    if (wrappedDek.length > MAX_WRAPPED) return json(413, { error: 'DEK_TOO_LARGE', message: '数据密钥过长' });

    const row = await getVault(db, vaultId);
    if (!row) {
      if (!wrappedDek) return json(400, { error: 'MISSING_DEK', message: '首次上传必须携带数据密钥' });
      if (baseVersion !== 0) {
        return json(409, { error: 'VERSION_CONFLICT', message: '云端还没有记录，baseVersion 应为 0' });
      }
      await db
        .prepare(
          `INSERT INTO settings_vault (vault_id, auth_hash, wrapped_dek, version, blob, updated_at)
           VALUES (?, ?, ?, 1, ?, ?)`,
        )
        .bind(vaultId, authHash, wrappedDek, blob, Date.now())
        .run();
      return json(200, { version: 1 });
    }

    if (!sameString(row.auth_hash, authHash)) {
      return json(403, { error: 'FORBIDDEN', message: '管理密钥不匹配' });
    }
    if (baseVersion !== row.version) {
      return json(409, {
        error: 'VERSION_CONFLICT',
        message: '云端已有更新，请先恢复再上传',
        version: row.version,
        blob: row.blob,
      });
    }
    const next = row.version + 1;
    await db
      .prepare(
        `UPDATE settings_vault SET version = ?, blob = ?, wrapped_dek = ?, updated_at = ? WHERE vault_id = ?`,
      )
      .bind(next, blob, wrappedDek || row.wrapped_dek, Date.now(), vaultId)
      .run();
    return json(200, { version: next });
  }

  return json(405, { error: 'METHOD_NOT_ALLOWED', message: '只支持 GET / PUT' });
}
