import express from 'express';
import type { Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { log } from './util.ts';

/**
 * 设置在线同步。
 *
 * 密钥分层：
 * - 管理密钥只在客户端；请求头 X-Vault-Auth 携带由它派生的 authKey
 * - 服务端只存 SHA-256(authKey)，用常量时间比较校验身份
 * - wrapped_dek 是被 KEK 包裹的数据密钥，blob 是被数据密钥加密的设置
 *
 * 服务端没有任何解密能力：它既没有管理密钥，也没有数据密钥。
 */

const MAX_BLOB = 64 * 1024;
const MAX_WRAPPED = 4 * 1024;
const AUTH_RE = /^[A-Za-z0-9+/=]{20,100}$/;

function fail(res: Response, status: number, error: string, message: string): void {
  res.status(status).json({ error, message });
}

function authHashOf(authKey: string): string {
  return createHash('sha256').update(authKey, 'utf8').digest('hex');
}

function vaultIdOf(authHash: string): string {
  return authHash.slice(0, 32);
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

interface VaultRow {
  vault_id: string;
  auth_hash: string;
  wrapped_dek: string;
  version: number;
  blob: string;
  updated_at: number;
}

export function createSettingsRoutes(deps: { db: DatabaseSync | null }): express.Router {
  const router = express.Router();

  if (!deps.db) {
    router.use((_req: Request, res: Response) => {
      fail(res, 503, 'SYNC_DISABLED', '当前是 JSON 存储模式，在线同步不可用');
    });
    return router;
  }
  const db = deps.db;

  /** 从请求头取 authKey 并算出身份标识 */
  function identify(req: Request): { authHash: string; vaultId: string } | null {
    const raw = String(req.get('x-vault-auth') ?? '').trim();
    if (!AUTH_RE.test(raw)) return null;
    const authHash = authHashOf(raw);
    return { authHash, vaultId: vaultIdOf(authHash) };
  }

  router.get('/vault', (req: Request, res: Response) => {
    const id = identify(req);
    if (!id) return fail(res, 401, 'UNAUTHORIZED', '缺少或格式不正确的管理密钥派生凭据');

    const row = db
      .prepare('SELECT * FROM settings_vault WHERE vault_id = ?')
      .get(id.vaultId) as unknown as VaultRow | undefined;

    if (!row) return fail(res, 404, 'VAULT_NOT_FOUND', '云端还没有这份设置');
    if (!sameHash(row.auth_hash, id.authHash)) return fail(res, 403, 'FORBIDDEN', '管理密钥不匹配');

    res.json({
      version: row.version,
      blob: row.blob,
      wrappedDek: row.wrapped_dek,
      updatedAt: row.updated_at,
    });
  });

  router.put('/vault', (req: Request, res: Response) => {
    const id = identify(req);
    if (!id) return fail(res, 401, 'UNAUTHORIZED', '缺少或格式不正确的管理密钥派生凭据');

    const body = req.body as { baseVersion?: unknown; blob?: unknown; wrappedDek?: unknown };
    const blob = typeof body?.blob === 'string' ? body.blob : '';
    if (!blob) return fail(res, 400, 'BAD_BLOB', '密文不能为空');
    if (blob.length > MAX_BLOB) return fail(res, 413, 'BLOB_TOO_LARGE', '设置体积过大');

    const baseVersion = Number(body?.baseVersion);
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      return fail(res, 400, 'BAD_VERSION', '版本号不合法');
    }

    const wrappedDek = typeof body?.wrappedDek === 'string' ? body.wrappedDek : '';
    if (wrappedDek.length > MAX_WRAPPED) return fail(res, 413, 'DEK_TOO_LARGE', '数据密钥过长');

    const row = db
      .prepare('SELECT * FROM settings_vault WHERE vault_id = ?')
      .get(id.vaultId) as unknown as VaultRow | undefined;

    // 创建：必须同时提供被包裹的数据密钥
    if (!row) {
      if (!wrappedDek) return fail(res, 400, 'MISSING_DEK', '首次上传必须携带数据密钥');
      if (baseVersion !== 0) return fail(res, 409, 'VERSION_CONFLICT', '云端还没有记录，baseVersion 应为 0');

      db.prepare(
        `INSERT INTO settings_vault (vault_id, auth_hash, wrapped_dek, version, blob, updated_at)
         VALUES (?, ?, ?, 1, ?, ?)`,
      ).run(id.vaultId, id.authHash, wrappedDek, blob, Date.now());

      log('settings.create', { vault: id.vaultId.slice(0, 8), bytes: blob.length });
      return res.json({ version: 1 });
    }

    if (!sameHash(row.auth_hash, id.authHash)) return fail(res, 403, 'FORBIDDEN', '管理密钥不匹配');
    if (baseVersion !== row.version) {
      return res.status(409).json({
        error: 'VERSION_CONFLICT',
        message: '云端已有更新，请先恢复再上传',
        version: row.version,
        blob: row.blob,
      });
    }

    const next = row.version + 1;
    db.prepare(
      `UPDATE settings_vault SET
         version = ?, blob = ?, wrapped_dek = ?, updated_at = ?
       WHERE vault_id = ?`,
    ).run(next, blob, wrappedDek || row.wrapped_dek, Date.now(), id.vaultId);

    log('settings.push', { vault: id.vaultId.slice(0, 8), version: next, bytes: blob.length });
    res.json({ version: next });
  });

  return router;
}
