import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_DAILY_QUOTA } from './auth.ts';

/**
 * 挑战（出题）服务：挑战码登记 / 解析 / 出题人额度扣减 / 玩家记录审计。
 *
 * 两种模式：
 * - custom  指定题目：custom_id/global_id 指向出题人的草稿与其在全局库的 retired 副本
 * - random  随机抽题：settings 存出题人指定的范围（难度/类别等），开局时公共题库随机
 *
 * 审计：每局写入 games.challenge_code + games.player_ip（含匿名游客），
 * 出题人可查「谁用我的链接玩了」，额度消耗可追溯。
 */

export interface ChallengeSettings {
  difficulty?: number;
  category?: string;
  polity?: string | null;
  region?: string | null;
  worldEra?: string | null;
  cnShare?: number;
}

export interface ChallengeResolved {
  code: string;
  creatorId: string;
  creatorName: string | null;
  /** 指定题目时非空：全局库里的 retired 副本 id */
  globalId: string | null;
  settings: ChallengeSettings;
}

export interface ChallengeMineRow {
  code: string;
  mode: 'custom' | 'random';
  name: string | null;
  settings: ChallengeSettings;
  plays: number;
  lastPlayedAt: number | null;
  createdAt: number;
}

export interface ChallengePlayRow {
  id: string;
  userName: string | null;
  playerIp: string | null;
  result: string;
  asks: number;
  startedAt: number;
  endedAt: number | null;
}

export interface ChallengeService {
  /** 登记挑战行；code 由调用方生成（与 custom_targets.share_code 保持一致） */
  register(input: { code: string; creatorId: string; customId?: string | null; globalId?: string | null; settings?: ChallengeSettings }): void;
  /** 随机出题：生成并登记挑战码，返回 code */
  registerRandom(creatorId: string, settings: ChallengeSettings): string;
  /** 游客在该挑战下进行中的对局 id（同一游客同一挑战只保留一局） */
  findPlayingGuestSession(guestId: string, code: string): string | null;
  resolve(code: string): ChallengeResolved | null;
  mine(creatorId: string): ChallengeMineRow[];
  plays(code: string): ChallengePlayRow[];
  /** 出题人今日还能不能用站方模型（不扣减） */
  quotaOk(code: string): boolean;
  /** 扣一次出题人的提问额度；返回 null = 挑战码不存在 */
  chargeAsk(code: string): { ok: boolean; message?: string } | null;
}

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode(db: DatabaseSync): string {
  for (let i = 0; i < 20; i++) {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    const hit = db.prepare('SELECT 1 AS x FROM challenges WHERE code = ?').get(code);
    if (!hit) return code;
  }
  throw new Error('挑战码分配失败');
}

interface CreatorRow {
  id: string;
  username: string;
  role: string;
  allow_server_key: number;
  banned: number;
  asks_today: number;
  quota_day: number;
  daily_quota: number;
}

export function createChallengeService(db: DatabaseSync): ChallengeService {
  const creatorRow = (creatorId: string): CreatorRow | null =>
    db.prepare('SELECT id, username, role, allow_server_key, banned, asks_today, quota_day, daily_quota FROM users WHERE id = ?')
      .get(creatorId) as unknown as CreatorRow | null;

  const remainingOf = (c: CreatorRow): number => {
    const day = new Date();
    const today = day.getFullYear() * 10000 + (day.getMonth() + 1) * 100 + day.getDate();
    const used = Number(c.quota_day) === today ? Number(c.asks_today) : 0;
    const limit = Number(c.daily_quota) < 0 ? DEFAULT_DAILY_QUOTA : Number(c.daily_quota);
    return Math.max(0, limit - used);
  };

  return {
    register({ code, creatorId, customId = null, globalId = null, settings = {} }) {
      db.prepare(
        'INSERT INTO challenges (code, creator_id, custom_id, global_id, settings, created_at) VALUES (?,?,?,?,?,?)',
      ).run(code, creatorId, customId, globalId, JSON.stringify(settings), Date.now());
    },

    registerRandom(creatorId, settings) {
      const code = newCode(db);
      this.register({ code, creatorId, settings });
      return code;
    },

    findPlayingGuestSession(guestId, code) {
      const r = db.prepare(
        "SELECT id FROM sessions WHERE guest_id = ? AND challenge_code = ? AND status = 'playing' ORDER BY updated_at DESC LIMIT 1",
      ).get(guestId, code) as unknown as { id: string } | undefined;
      return r?.id ?? null;
    },

    resolve(code) {
      const r = db.prepare(
        `SELECT ch.code, ch.creator_id, ch.custom_id, ch.global_id, ch.settings,
                u.username AS creator_name
         FROM challenges ch LEFT JOIN users u ON u.id = ch.creator_id
         WHERE ch.code = ?`,
      ).get(code) as unknown as
        | { code: string; creator_id: string; custom_id: string | null; global_id: string | null; settings: string; creator_name: string | null }
        | undefined;
      if (!r) return null;
      let settings: ChallengeSettings = {};
      try { settings = JSON.parse(r.settings) as ChallengeSettings; } catch { /* ignore */ }
      return {
        code: r.code,
        creatorId: r.creator_id,
        creatorName: r.creator_name,
        globalId: r.global_id,
        settings,
      };
    },

    mine(creatorId) {
      const rows = db.prepare(
        `SELECT ch.code, ch.custom_id, ch.global_id, ch.settings, ch.created_at,
                ct.name AS custom_name,
                (SELECT COUNT(*) FROM games g WHERE g.challenge_code = ch.code) AS plays,
                (SELECT MAX(g.started_at) FROM games g WHERE g.challenge_code = ch.code) AS last_played_at
         FROM challenges ch LEFT JOIN custom_targets ct ON ct.id = ch.custom_id
         WHERE ch.creator_id = ?
         ORDER BY ch.created_at DESC
         LIMIT 200`,
      ).all(creatorId) as unknown as Array<{
        code: string; custom_id: string | null; global_id: string | null; settings: string;
        created_at: number; custom_name: string | null; plays: number; last_played_at: number | null;
      }>;
      return rows.map((r) => {
        let settings: ChallengeSettings = {};
        try { settings = JSON.parse(r.settings) as ChallengeSettings; } catch { /* ignore */ }
        return {
          code: r.code,
          mode: r.custom_id ? ('custom' as const) : ('random' as const),
          name: r.custom_name,
          settings,
          plays: Number(r.plays) || 0,
          lastPlayedAt: r.last_played_at,
          createdAt: r.created_at,
        };
      });
    },

    plays(code) {
      const rows = db.prepare(
        `SELECT id, user_name, player_ip, status, turns_left, asks, started_at, ended_at
         FROM games WHERE challenge_code = ?
         ORDER BY started_at DESC LIMIT 100`,
      ).all(code) as unknown as Array<{
        id: string; user_name: string | null; player_ip: string | null;
        status: string; turns_left: number; asks: number; started_at: number; ended_at: number | null;
      }>;
      return rows.map((r) => ({
        id: r.id,
        userName: r.user_name,
        playerIp: r.player_ip,
        result: r.status === 'won' ? 'won' : r.status === 'revealed' ? (r.turns_left > 0 ? 'abandoned' : 'lost') : 'playing',
        asks: Number(r.asks) || 0,
        startedAt: r.started_at,
        endedAt: r.ended_at,
      }));
    },

    quotaOk(code) {
      const r = this.resolve(code);
      if (!r) return false;
      const c = creatorRow(r.creatorId);
      if (!c) return false;
      // 管理员放出的链接同样受额度约束（自己开玩才豁免）
      if (c.banned || !c.allow_server_key) return false;
      return remainingOf(c) > 0;
    },

    chargeAsk(code) {
      const r = this.resolve(code);
      if (!r) return null;
      const c = creatorRow(r.creatorId);
      if (!c) return { ok: false, message: '出题人账号不存在，挑战已失效' };
      if (c.banned) return { ok: false, message: '出题人账号被封禁，挑战已截止' };
      if (!c.allow_server_key) {
        return { ok: false, message: '出题人未开放站方模型，挑战暂时截止' };
      }
      // 挑战扣费对管理员同样生效（放出去的链接不是无限链接）；
      // 管理员自己开玩的额度走 takeQuota 的管理员豁免，两者互不影响。
      const day = new Date();
      const today = day.getFullYear() * 10000 + (day.getMonth() + 1) * 100 + day.getDate();
      const used = Number(c.quota_day) === today ? Number(c.asks_today) : 0;
      const limit = Number(c.daily_quota) < 0 ? DEFAULT_DAILY_QUOTA : Number(c.daily_quota);
      if (used >= limit) {
        return { ok: false, message: '出题人今日额度已用完，挑战今日截止，明天再来' };
      }
      db.prepare('UPDATE users SET asks_today = ?, quota_day = ?, updated_at = ? WHERE id = ?').run(
        used + 1,
        today,
        Date.now(),
        c.id,
      );
      return { ok: true };
    },
  };
}

export type { ChallengeSettings as _ChallengeSettings };
