import type { VaultPayload } from './vault.ts';
import {
  authHashOf,
  deriveKeys,
  generateKey,
  keyToBase64,
  openPayload,
  sealPayload,
  unwrapDataKey,
  wrapDataKey,
} from './vault.ts';
import { loadConfig, loadPrefs, loadQuestions, saveConfig, savePrefs, saveQuestions } from './store.ts';

/**
 * 设置同步：管理密钥派生出 authKey（认证）与 KEK（包裹数据密钥）。
 * 服务端只看到 authKey 的哈希、被包裹的数据密钥、以及密文。
 */

export function collectPayload(): VaultPayload {
  return {
    version: 1,
    aiConfig: loadConfig(),
    prefs: loadPrefs(),
    questions: loadQuestions(),
    savedAt: Date.now(),
  };
}

export function applyPayload(payload: VaultPayload): void {
  saveConfig(payload.aiConfig ?? null);
  if (payload.prefs) savePrefs(payload.prefs);
  if (Array.isArray(payload.questions)) saveQuestions(payload.questions);
}

export function normalizeEndpoint(input: string): string {
  return String(input ?? '').trim().replace(/\/+$/, '');
}

export interface PushResult {
  ok: boolean;
  version?: number;
  conflict?: boolean;
  message?: string;
  /** 首次上传时新建的数据密钥；调用方需要持久化 */
  dataKey?: Uint8Array;
}

export async function pushVault(
  endpoint: string,
  secret: Uint8Array,
  baseVersion: number,
  existingDataKey: Uint8Array | null,
): Promise<PushResult> {
  try {
    const { authKey, kek } = await deriveKeys(secret);
    const dataKey = existingDataKey ?? generateKey();
    const wrappedDek = await wrapDataKey(kek, dataKey);
    const blob = await sealPayload(dataKey, collectPayload());

    const res = await fetch(`${normalizeEndpoint(endpoint)}/api/settings/vault`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Vault-Auth': keyToBase64(authKey),
      },
      body: JSON.stringify({ baseVersion, blob, wrappedDek }),
    });
    const data = (await res.json().catch(() => null)) as
      | { version?: number; message?: string }
      | null;

    if (res.status === 409) {
      return {
        ok: false,
        conflict: true,
        version: data?.version ?? 0,
        message: '云端已有更新，请先「从云端恢复」再上传',
        dataKey,
      };
    }
    if (!res.ok) return { ok: false, message: data?.message ?? `上传失败（${res.status}）`, dataKey };
    return { ok: true, version: data?.version, dataKey };
  } catch (err) {
    return { ok: false, message: `上传失败：${(err as Error).message}` };
  }
}

export interface PullResult {
  ok: boolean;
  payload?: VaultPayload;
  version?: number;
  message?: string;
  /** 从云端 wrappedDek 解出的数据密钥 */
  dataKey?: Uint8Array;
}

export async function pullVault(endpoint: string, secret: Uint8Array): Promise<PullResult> {
  try {
    const { authKey, kek } = await deriveKeys(secret);
    const res = await fetch(`${normalizeEndpoint(endpoint)}/api/settings/vault`, {
      headers: { 'X-Vault-Auth': keyToBase64(authKey) },
    });
    const data = (await res.json().catch(() => null)) as
      | { blob?: string; wrappedDek?: string; version?: number; message?: string }
      | null;

    if (res.status === 404) return { ok: false, message: '云端还没有这份设置，先上传一次' };
    if (!res.ok) return { ok: false, message: data?.message ?? `读取失败（${res.status}）` };
    if (!data?.blob || !data?.wrappedDek) return { ok: false, message: '云端数据不完整' };

    const dataKey = await unwrapDataKey(kek, data.wrappedDek);
    const payload = await openPayload(dataKey, data.blob);
    return { ok: true, payload, version: data.version, dataKey };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** 仅用于诊断：当前管理密钥对应的服务端记录 ID */
export async function vaultIdOfSecret(secret: Uint8Array): Promise<string> {
  const { authKey } = await deriveKeys(secret);
  return (await authHashOf(authKey)).slice(0, 32);
}
