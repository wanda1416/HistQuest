import type { AiCredential, AnswerRecord, Character } from '../src/shared/domain.ts';
import {
  ROOM,
  type Room,
  type RoomCommand,
  type RoomError,
  type RoomEvent,
  type RoomSettings,
} from '../src/shared/room.ts';
import {
  applyEvent,
  createRoom,
  findMember,
  voteInitiator,
  type ReduceResult,
} from '../src/core/room/reducer.ts';
import { projectRoom } from '../src/core/room/project.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { runAsk } from '../src/core/engine.ts';
import { guessMatches } from '../src/core/judge.ts';
import { AiError } from '../src/ai/client.ts';
import type { D1Database } from './d1.ts';
import { loadTargetsFromD1 } from './d1.ts';

/**
 * 对战房间的 Durable Object。
 *
 * 房间规则全在 src/core/room/reducer.ts（纯函数、零 IO）；这里只做 IO：
 * WebSocket 收发、DO storage 持久化、模型调用、alarm 清理、D1 目录与账本。
 *
 * 为什么房间必须是 DO：抢答"谁先答出来"需要一个单点串行仲裁者。D1 + 无状态
 * Worker 做不到（两个请求可能同时判赢），DO 天然单线程。
 */

/* ---------------- 最小环境类型（不引入 workers-types） ---------------- */

export interface RoomDoEnv {
  DB: D1Database;
  AI_BASE_URL?: string;
  AI_API_KEY?: string;
  AI_MODEL?: string;
}

interface DoStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(at: number): Promise<void>;
}

interface DoWebSocket {
  accept?(): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

interface DoState {
  storage: DoStorage;
  acceptWebSocket(ws: DoWebSocket): void;
  getWebSockets(): DoWebSocket[];
}

declare const WebSocketPair: { new (): { 0: DoWebSocket; 1: DoWebSocket } };

/* ---------------- 常量 ---------------- */

const SNAPSHOT_KEEP_MS = 24 * 60 * 60 * 1000;
/** 轮询模式下的"在线"判定窗口 */
const PRESENCE_WINDOW_MS = 30_000;
const ALARM_INTERVAL_MS = 30 * 60 * 1000;

interface StoredRoom {
  room: Room;
  /** 房间归属，写 D1 用 */
  id: string;
  lastActivityAt: number;
  archived: boolean;
  listed: boolean;
}

/* ---------------- 房间 DO ---------------- */

export class RoomDo {
  private readonly state: DoState;
  private readonly env: RoomDoEnv;
  private data: StoredRoom | null = null;
  private index: CharacterIndex | null = null;
  /** 轮询客户端的上次出现时间（WS 客户端另算） */
  private seen = new Map<string, number>();
  /** 同一房间内跨玩家的答案缓存：同一目标下同样的问题答案必然相同 */
  private answerCache = new Map<string, AnswerRecord>();
  private lastDirKey = '';

  constructor(state: DoState, env: RoomDoEnv) {
    this.state = state;
    this.env = env;
  }

  /* ---------------- 入口 ---------------- */

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const userId = req.headers.get('x-hq-user-id') ?? '';
    const userName = decodeName(req.headers.get('x-hq-user-name'));
    if (!userId) return json(401, { error: 'LOGIN_REQUIRED', message: '对战需要登录' });

    try {
      await this.load();
      // 房间可能已被关闭（storage 已清空）：除了建房，其余一律明确告诉客户端
      if (!this.data && url.pathname !== '/new') {
        return json(404, { error: 'NOT_FOUND', message: '房间不存在或已经关闭' });
      }

      switch (url.pathname) {
        case '/new':
          return this.onCreate(userId, userName, req);
        case '/ws':
          return this.onSocket(userId, userName);
        case '/snapshot':
          this.touch(userId);
          await this.refreshPresence();
          return json(200, await this.snapshotFor(userId));
        case '/join':
          return this.onJoin(userId, userName);
        case '/cmd':
          return this.onCommandHttp(userId, req);
        default:
          return json(404, { error: 'NOT_FOUND', message: '接口不存在' });
      }
    } catch (err) {
      console.error('room.do.failed', { path: url.pathname, message: (err as Error)?.message });
      return json(500, { error: 'SERVER_ERROR', message: '房间处理失败' });
    }
  }

  /* ---------------- 建房间 ---------------- */

  private async onCreate(userId: string, userName: string, req: Request): Promise<Response> {
    if (this.data?.room) return json(409, { error: 'ROOM_EXISTS', message: '房间码已被占用' });
    const body = (await req.json().catch(() => ({}))) as {
      code?: string;
      settings?: Partial<RoomSettings>;
      listed?: boolean;
    };
    const code = String(body.code ?? '').toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) return json(400, { error: 'BAD_CODE', message: '房间码不合法' });

    const now = Date.now();
    const room = createRoom({ code, hostId: userId, hostName: userName || '玩家', settings: body.settings ?? {}, now });
    this.data = {
      room,
      id: crypto.randomUUID().replace(/-/g, ''),
      lastActivityAt: now,
      archived: false,
      listed: body.listed !== false,
    };
    this.seen.set(userId, now);
    await this.save();
    await this.upsertDirectory(true);
    await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
    return json(201, await this.snapshotFor(userId));
  }

  /* ---------------- 加入 ---------------- */

  private async onJoin(userId: string, userName: string): Promise<Response> {
    this.touch(userId);
    await this.refreshPresence();
    const res = await this.commit({ t: 'join', userId, name: userName || '玩家' });
    if (!res.ok) return json(409, { error: res.error ?? 'JOIN_FAILED', message: joinMessage(res.error) });
    return json(200, await this.snapshotFor(userId));
  }

  /* ---------------- WebSocket ---------------- */

  private onSocket(userId: string, userName: string): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ userId, userName });
    void this.afterSocketConnect(userId, userName);
    return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit);
  }

  private async afterSocketConnect(userId: string, userName: string): Promise<void> {
    try {
      this.touch(userId);
      await this.refreshPresence();
      const member = findMember(this.data!.room, userId);
      if (!member || member.status === 'left') {
        await this.commit({ t: 'join', userId, name: userName || '玩家' });
      }
      await this.broadcast();
    } catch (err) {
      console.error('room.ws.connect', { message: (err as Error)?.message });
    }
  }

  /** 由运行时调用（Hibernation API） */
  async webSocketMessage(ws: DoWebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== 'string') return;
    let parsed: { t?: string } & Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as { t?: string } & Record<string, unknown>;
    } catch {
      return;
    }
    if (!parsed?.t) return;
    if (parsed.t === 'ping') {
      const att = ws.deserializeAttachment() as { userId?: string } | null;
      if (att?.userId) this.touch(att.userId);
      await this.refreshPresence();
      return;
    }
    const att = ws.deserializeAttachment() as { userId?: string } | null;
    if (!att?.userId) return;
    this.touch(att.userId);
    const error = await this.dispatch(att.userId, parsed as unknown as RoomCommand);
    if (error) ws.send(JSON.stringify({ t: 'error', code: error, message: joinMessage(error) }));
  }

  async webSocketClose(_ws: DoWebSocket): Promise<void> {
    await this.refreshPresence();
    await this.broadcast();
  }

  async webSocketError(): Promise<void> {
    /* 连接异常与关闭同样处理：等下一次事件刷新 presence 即可 */
  }

  /* ---------------- 命令 ---------------- */

  private async onCommandHttp(userId: string, req: Request): Promise<Response> {
    const cmd = (await req.json().catch(() => ({}))) as RoomCommand & { t?: string };
    if (!cmd?.t) return json(400, { error: 'BAD_COMMAND', message: '缺少命令类型' });
    this.touch(userId);
    await this.refreshPresence();
    const error = await this.dispatch(userId, cmd as RoomCommand);
    if (error) return json(409, { error, message: joinMessage(error) });
    return json(200, await this.snapshotFor(userId));
  }

  /** 命令 → 事件 → 状态机；返回错误码（null = 成功） */
  private async dispatch(userId: string, cmd: RoomCommand): Promise<RoomError | null> {
    const room = this.data?.room;
    if (!room) return 'NOT_MEMBER';
    if (room.status === 'closed') return 'ROOM_CLOSED';

    switch (cmd.t) {
      case 'leave': {
        const res = await this.commit({ t: 'leave', userId });
        return res.ok ? null : (res.error ?? 'NOT_MEMBER');
      }
      case 'config': {
        const res = await this.commit({ t: 'config', userId, patch: cmd.patch ?? {} });
        return res.ok ? null : (res.error ?? 'BAD_SETTINGS');
      }
      case 'start': {
        if (room.status !== 'lobby') return 'NOT_LOBBY';
        if (userId !== room.hostId) return 'NOT_HOST';
        const target = await this.pickTarget();
        if (!target) return 'BAD_SETTINGS';
        const res = await this.commit({ t: 'start', userId, targetId: target.id });
        return res.ok ? null : (res.error ?? 'NOT_PLAYING');
      }
      case 'ask': {
        const question = String(cmd.question ?? '').trim();
        if (!question) return 'NOT_PLAYING';
        const ticket = crypto.randomUUID();
        const started = await this.commit({ t: 'ask-start', userId, ticket });
        if (!started.ok) return started.error ?? 'NOT_PLAYING';
        await this.runAskAndCommit(userId, ticket, question);
        return null;
      }
      case 'guess': {
        const name = String(cmd.name ?? '').trim();
        if (!name) return 'NOT_PLAYING';
        const target = this.target();
        const correct = target ? guessMatches(target, name) : false;
        const res = await this.commit({ t: 'guess', userId, correct });
        return res.ok ? null : (res.error ?? 'NOT_PLAYING');
      }
      case 'abandon': {
        const res = await this.commit({ t: 'abandon', userId });
        return res.ok ? null : (res.error ?? 'NOT_PLAYING');
      }
      case 'open-vote': {
        const res = await this.commit({ t: 'open-vote', userId });
        return res.ok ? null : (res.error ?? 'NOT_HOST');
      }
      case 'cast-vote': {
        const res = await this.commit({ t: 'cast-vote', userId });
        return res.ok ? null : (res.error ?? 'NO_VOTE');
      }
      case 'cancel-vote': {
        const res = await this.commit({ t: 'cancel-vote', userId });
        return res.ok ? null : (res.error ?? 'NO_VOTE');
      }
      default:
        return 'NOT_PLAYING';
    }
  }

  /** 一问的完整往返：调模型 → 结算 → 广播。失败退轮，房间照常 */
  private async runAskAndCommit(userId: string, ticket: string, question: string): Promise<void> {
    const room = this.data!.room;
    const target = this.target();
    if (!target) {
      await this.commit({ t: 'ask-fail', userId, ticket });
      return;
    }

    const cacheKey = `${target.id}::${question.replace(/\s+/g, '')}`;
    const cached = this.answerCache.get(cacheKey);
    if (cached) {
      const member = findMember(room, userId);
      const seq = (member?.history.length ?? 0) + 1;
      await this.commit({ t: 'ask-done', userId, ticket, record: { ...cached, seq, question } });
      return;
    }

    const cred = await this.credential();
    if (!cred) {
      await this.commit({ t: 'ask-fail', userId, ticket });
      this.notify(userId, 'MODEL_NOT_CONFIGURED', '服务端没有配置模型');
      return;
    }

    try {
      const member = findMember(this.data!.room, userId);
      const outcome = await runAsk({
        question,
        target,
        index: await this.ensureIndex(),
        credential: cred,
        seq: (member?.history.length ?? 0) + 1,
        mode: this.data!.room.settings.mode,
        pronoun: this.data!.room.settings.pronoun,
        timeoutMs: 20000,
      });
      if (!outcome.record.transient && !outcome.record.invalid) {
        this.answerCache.set(cacheKey, { ...outcome.record, seq: 0, question: '' });
      }
      await this.refreshPresence();
      await this.commit({ t: 'ask-done', userId, ticket, record: outcome.record, won: outcome.won });
    } catch (err) {
      await this.commit({ t: 'ask-fail', userId, ticket });
      const e = err as AiError;
      this.notify(userId, `AI_${e?.code ?? 'UNKNOWN'}`, e?.message ?? '模型调用失败');
    }
  }

  /* ---------------- 投影与广播 ---------------- */

  private async snapshotFor(userId: string) {
    const room = this.data!.room;
    // finished 后要下发人物卡：索引可能还没加载（实例被回收重启过），必须先补
    let target: Character | undefined;
    if (room.status === 'finished') {
      target = this.target() ?? (await this.ensureIndex(), this.target());
    }
    return projectRoom(room, userId, Date.now(), { target: target ?? null });
  }

  private async broadcast(): Promise<void> {
    const room = this.data?.room;
    if (!room) return;
    // finished 后的广播必须带人物卡（复盘）；索引未加载则先补——这是异步的，
    // 所以广播整体异步化，commit 里用 await 串行
    let target: Character | undefined;
    if (room.status === 'finished') {
      target = this.target() ?? (await this.ensureIndex(), this.target());
    }
    const now = Date.now();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as { userId?: string } | null;
      if (!att?.userId) continue;
      try {
        ws.send(JSON.stringify({ t: 'snapshot', room: projectRoom(room, att.userId, now, {
          target: target ?? null,
        }) }));
      } catch {
        /* 连接已断，等 close 事件 */
      }
    }
  }

  private notify(userId: string, code: string, message: string): void {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as { userId?: string } | null;
      if (att?.userId !== userId) continue;
      try {
        ws.send(JSON.stringify({ t: 'error', code, message }));
      } catch {
        /* ignore */
      }
    }
  }

  /* ---------------- 状态机包装 ---------------- */

  private async commit(ev: RoomEvent): Promise<ReduceResult> {
    const data = this.data;
    if (!data) return { ok: false, room: undefined as unknown as Room, effects: [], error: 'NOT_MEMBER' };
    const res = applyEvent(data.room, ev, { now: Date.now() });
    if (!res.ok) return res;

    this.data = { ...data, room: res.room, lastActivityAt: Date.now() };
    await this.save();
    // 目录只在关键字段变化时才真正写 D1（见 upsertDirectory 的 key 比较）
    await this.upsertDirectory(false);

    if (res.effects.some((e) => e.t === 'archive')) await this.archive();
    if (res.effects.some((e) => e.t === 'broadcast')) await this.broadcast();
    if (res.effects.some((e) => e.t === 'close')) await this.closeRoom();
    return res;
  }

  /**
   * 在线状态刷新：WS 连接 + 30s 内的轮询请求都算在线。
   * 每次"要读在线人数"的动作前都刷新一遍，投票分母因此永远是最新的。
   */
  private async refreshPresence(): Promise<void> {
    const data = this.data;
    if (!data) return;
    const now = Date.now();
    const live = new Set<string>();
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment() as { userId?: string } | null;
      if (att?.userId) live.add(att.userId);
    }
    for (const m of data.room.members) {
      if (m.status === 'left') continue;
      const online = live.has(m.userId) || now - (this.seen.get(m.userId) ?? 0) < PRESENCE_WINDOW_MS;
      if (m.online === online) continue;
      const res = await this.commit({ t: 'presence', userId: m.userId, online });
      if (!res.ok || !this.data) return;
    }
  }

  private touch(userId: string): void {
    if (userId) this.seen.set(userId, Date.now());
  }

  /* ---------------- 持久化 ---------------- */

  private async load(): Promise<void> {
    if (this.data) return;
    const stored = await this.state.storage.get<StoredRoom>('room');
    this.data = stored ?? null;
  }

  private async save(): Promise<void> {
    if (!this.data) return;
    await this.state.storage.put('room', this.data);
  }

  private async closeRoom(): Promise<void> {
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.close(1000, 'room closed');
      } catch {
        /* ignore */
      }
    }
    await this.upsertDirectory(true);
    await this.state.storage.delete('room');
    this.data = null;
  }

  /* ---------------- 人物索引与模型 ---------------- */

  private async ensureIndex(): Promise<CharacterIndex> {
    if (this.index) return this.index;
    const list = await loadTargetsFromD1(this.env.DB);
    this.index = new CharacterIndex(list);
    return this.index;
  }

  private target() {
    const id = this.data?.room.targetId;
    if (!id || !this.index) return undefined;
    return this.index.get(id);
  }

  private async pickTarget() {
    const index = await this.ensureIndex();
    const s = this.data!.room.settings;
    return index.pick({
      difficulty: s.difficulty,
      polity: s.polity,
      region: s.region,
      worldEra: s.worldEra,
      cnShare: s.cnShare,
    });
  }

  /** 服务端模型凭据：默认取 env；后台改过 LLM 设置时以 D1 为准 */
  private async credential(): Promise<AiCredential | null> {
    try {
      const row = await this.env.DB.prepare("SELECT v FROM app_settings WHERE k = 'llm'")
        .bind()
        .first<{ v: string }>();
      if (row) {
        const parsed = JSON.parse(row.v) as { baseURL?: string; model?: string; apiKey?: string };
        const key = parsed.apiKey ?? this.env.AI_API_KEY;
        if (parsed.baseURL && parsed.model && key) {
          return { kind: 'byok', baseURL: parsed.baseURL, apiKey: key, model: parsed.model, temperature: 0.1 };
        }
      }
    } catch {
      /* 落回 env */
    }
    if (!this.env.AI_BASE_URL || !this.env.AI_API_KEY || !this.env.AI_MODEL) return null;
    return {
      kind: 'byok',
      baseURL: this.env.AI_BASE_URL,
      apiKey: this.env.AI_API_KEY,
      model: this.env.AI_MODEL,
      temperature: 0.1,
    };
  }

  /* ---------------- D1：目录与账本 ---------------- */

  /** 大厅目录只在关键字段变化时才写，避免每问一次就落一行 */
  private async upsertDirectory(force: boolean): Promise<void> {
    const data = this.data;
    if (!data) return;
    const room = data.room;
    const key = [
      room.status,
      room.members.filter((m) => m.status !== 'left').length,
      room.winnerId ?? '',
      room.endReason ?? '',
      data.listed ? 1 : 0,
    ].join('|');
    if (!force && key === this.lastDirKey) return;
    this.lastDirKey = key;

    const now = Date.now();
    const players = room.members.filter((m) => m.status !== 'left').length;
    await this.env.DB.prepare(
      `INSERT INTO rooms (
         id, code, host_user_id, host_name, status, listed, max_players, turn_limit,
         difficulty, polity, region, world_era, cn_share, mode, player_count,
         target_id, started_at, ended_at, winner_user_id, winner_name,
         end_reason, end_vote_json, created_at, updated_at
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status, player_count = excluded.player_count,
         target_id = excluded.target_id, started_at = excluded.started_at,
         ended_at = excluded.ended_at, winner_user_id = excluded.winner_user_id,
         winner_name = excluded.winner_name, end_reason = excluded.end_reason,
         end_vote_json = excluded.end_vote_json, updated_at = excluded.updated_at`,
    )
      .bind(
        data.id,
        room.code,
        room.hostId,
        findMember(room, room.hostId)?.name ?? '',
        room.status,
        data.listed ? 1 : 0,
        room.settings.maxPlayers,
        room.settings.turnLimit,
        room.settings.difficulty,
        room.settings.polity,
        room.settings.region,
        room.settings.worldEra,
        room.settings.cnShare,
        room.settings.mode,
        players,
        room.status === 'finished' ? room.targetId : null,
        room.startedAt,
        room.endedAt,
        room.winnerId,
        room.winnerId ? (findMember(room, room.winnerId)?.name ?? '') : null,
        room.endReason,
        room.endedVote ? JSON.stringify(room.endedVote) : null,
        room.createdAt,
        now,
      )
      .run();
  }

  /**
   * 结算落账：每位参赛者一条 games 行（复用单人历史/后台的全部链路）。
   * 观战者不落账——他们本来就没有问答。
   */
  private async archive(): Promise<void> {
    const data = this.data;
    if (!data || data.archived) return;
    const room = data.room;
    // 账本必须落：索引未加载（实例重启过）时先补，不能静默放弃
    const target = this.target() ?? (await this.ensureIndex(), this.target());
    if (!target) return;

    await this.upsertDirectory(true);

    const ranked = room.members
      .filter((m) => m.status !== 'left')
      .sort((a, b) => {
        if (a.userId === room.winnerId) return -1;
        if (b.userId === room.winnerId) return 1;
        return b.turnsTotal - b.turnsLeft - (a.turnsTotal - a.turnsLeft);
      });

    const stmts: Array<{ run(): Promise<unknown> }> = [];
    for (const [i, m] of ranked.entries()) {
      const gameId = `${room.code}-${m.userId}`;
      const status = m.userId === room.winnerId ? 'won' : 'revealed';
      stmts.push(
        this.env.DB.prepare(
          `INSERT INTO games (
             id, user_id, user_name, target_id, target_name, target_roles, attribution,
             difficulty, polity, region, world_era, mode, pronoun,
             turns_total, turns_left, turns_used, asks, status,
             started_at, ended_at, updated_at, room_id, finish_rank
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(id) DO UPDATE SET
             turns_left = excluded.turns_left, turns_used = excluded.turns_used,
             asks = excluded.asks, status = excluded.status,
             ended_at = excluded.ended_at, updated_at = excluded.updated_at`,
        ).bind(
          gameId,
          m.userId,
          m.name,
          target.id,
          target.name,
          JSON.stringify(target.roles ?? []),
          'user',
          room.settings.difficulty,
          room.settings.polity,
          room.settings.region,
          room.settings.worldEra,
          room.settings.mode,
          room.settings.pronoun,
          m.turnsTotal,
          m.turnsLeft,
          Math.max(0, m.turnsTotal - m.turnsLeft),
          m.asked,
          status,
          room.startedAt ?? room.createdAt,
          room.endedAt ?? Date.now(),
          Date.now(),
          data.id,
          i + 1,
        ),
      );

      for (const r of m.history) {
        stmts.push(
          this.env.DB.prepare(
            `INSERT OR REPLACE INTO game_turns (
               game_id, seq, question, verdict, text, hint, invalid, failed, hit, basis, calls, ms, asked_at
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).bind(
            gameId,
            r.seq,
            r.question,
            r.verdict,
            r.text,
            r.hint ?? null,
            r.invalid ?? null,
            r.transient ? 1 : 0,
            r.hit ? 1 : 0,
            r.basis,
            r.calls,
            r.ms,
            (room.endedAt ?? Date.now()) - Math.max(0, r.ms),
          ),
        );
      }
    }

    for (let i = 0; i < stmts.length; i += 20) {
      await this.env.DB.batch(stmts.slice(i, i + 20) as never[]);
    }
    this.data = { ...data, archived: true };
    await this.save();
  }

  /* ---------------- 定时任务 ---------------- */

  async alarm(): Promise<void> {
    await this.load();
    const data = this.data;
    if (!data) return;

    const now = Date.now();
    const room = data.room;
    const idle = now - data.lastActivityAt;

    if (room.status === 'closed') {
      await this.state.storage.delete('room');
      this.data = null;
      return;
    }
    if (room.status === 'finished' && idle > SNAPSHOT_KEEP_MS) {
      await this.closeRoom();
      return;
    }
    if (room.status === 'playing' && idle > ROOM.idleSweepMs) {
      await this.commit({ t: 'close', by: 'stale' });
      return;
    }
    // 房主掉线满 60s 需要重算一次"谁能发起投票"，靠一次唤醒把状态推到稳定
    const initiator = voteInitiator(room, now);
    if (room.status === 'playing' && initiator !== room.hostId) await this.broadcast();
    await this.state.storage.setAlarm(now + ALARM_INTERVAL_MS);
  }
}

/* ---------------- 小工具 ---------------- */

function decodeName(raw: string | null): string {
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function joinMessage(code: string | undefined): string {
  switch (code) {
    case 'ROOM_CLOSED':
      return '房间已经关闭';
    case 'ROOM_FULL':
      return '人满了';
    case 'SPECTATOR_FULL':
      return '观战位满了';
    case 'NOT_HOST':
      return '只有房主能做这件事';
    case 'NOT_LOBBY':
      return '对局已经开始，不能再改';
    case 'NOT_PLAYING':
      return '对局不在进行中';
    case 'NO_TURNS':
      return '你的轮次用完了';
    case 'ASK_PENDING':
      return '上一问还在等模型回答';
    case 'TOO_FEW_PLAYERS':
      return '至少要两个人才开始';
    case 'ALREADY_VOTED':
      return '你已经投过票了';
    case 'VOTE_OPEN':
      return '已经有一个投票在进行';
    case 'NO_VOTE':
      return '当前没有投票';
    default:
      return '操作失败';
  }
}
