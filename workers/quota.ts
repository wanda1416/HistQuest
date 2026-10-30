import type { D1Database } from './d1.ts';
import type { AuthUser } from './auth.ts';

/**
 * 提问配额：只对"消耗服务端 Key 的调用"计数——BYOK 不算（花自己的额度）。
 * 服务端 Key 仅限登录用户（游客一律 BYOK）。
 * 全局默认 500 问/天；用户级 daily_quota：-1=跟随默认，0=禁用，>0=自定义。
 */

export const DEFAULT_DAILY = 500;

function today(): number {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

export interface QuotaCheck {
  ok: boolean;
  remaining: number;
  /** 超额时的提示 */
  message?: string;
}

/** 该用户的每日上限（读行内的 daily_quota，-1 落到默认） */
export function dailyLimitOf(dailyQuota: number | null | undefined): number {
  const q = Number(dailyQuota);
  if (!Number.isFinite(q) || q < 0) return DEFAULT_DAILY;
  return Math.floor(q);
}

/** 原子扣 1：跨日自动清零，RETURNING 拿回计数 */
export async function takeUserQuota(
  db: D1Database,
  user: AuthUser & { dailyQuota?: number | null },
): Promise<QuotaCheck> {
  const limit = dailyLimitOf(user.dailyQuota);
  const row = await db
    .prepare(
      `UPDATE users SET
         asks_today = CASE WHEN quota_day != ?1 THEN 1 ELSE asks_today + 1 END,
         quota_day = ?1
       WHERE id = ?2
       RETURNING asks_today`,
    )
    .bind(today(), user.id)
    .first<{ asks_today: number }>();
  const used = row?.asks_today ?? 0;
  if (used > limit) {
    return { ok: false, remaining: 0, message: `今日 ${limit} 问已用完，明天再来；或到设置里填自己的模型（BYOK）` };
  }
  return { ok: true, remaining: Math.max(0, limit - used) };
}
