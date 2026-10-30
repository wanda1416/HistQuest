import type { D1Database } from './d1.ts';
import type { AuthUser } from './auth.ts';

/**
 * 提问配额：只对"消耗服务端 Key 的调用"计数——BYOK 不算（花自己的额度）。
 * 服务端 Key 仅限登录用户（游客一律 BYOK）；默认 500 问/天，
 * admin 可将具体用户 allow_server_key 置 0 完全禁用。
 */

const USER_DAILY = 500;

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

/** 原子扣 1：跨日自动清零，RETURNING 拿回计数 */
export async function takeUserQuota(db: D1Database, user: AuthUser): Promise<QuotaCheck> {
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
  if (used > USER_DAILY) {
    return { ok: false, remaining: 0, message: `今日 ${USER_DAILY} 问已用完，明天再来；或到设置里填自己的模型（BYOK）` };
  }
  return { ok: true, remaining: Math.max(0, USER_DAILY - used) };
}
