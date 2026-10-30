import {
  ROOM,
  defaultRoomSettings,
  normalizeSettings,
  type EndedVote,
  type EndReason,
  type Room,
  type RoomEffect,
  type RoomError,
  type RoomEvent,
  type RoomMember,
  type RoomSettings,
} from '../../shared/room.ts';

/**
 * 房间状态机：纯逻辑、零 IO。
 *
 * 为什么必须写成纯函数：抢答、投票动态分母、掉线、全员用尽这些并发场景用真实
 * Durable Object 极难复现，写成 reduce(room, event, now) 后可以用假时钟把
 * 每一种竞态都写成一条测试。
 *
 * 调用约定：applyEvent 返回**新的** Room（入参不被修改）；
 * ok=false 表示这次事件被拒，room 原样返回，effects 为空。
 */

export interface RoomCtx {
  now: number;
}

export interface ReduceResult {
  ok: boolean;
  room: Room;
  effects: RoomEffect[];
  error?: RoomError;
}

/** 新建房间：房主自动成为第一个参赛者 */
export function createRoom(input: {
  code: string;
  hostId: string;
  hostName: string;
  settings?: Partial<RoomSettings>;
  now: number;
}): Room {
  const member: RoomMember = {
    userId: input.hostId,
    name: input.hostName,
    role: 'host',
    status: 'waiting',
    turnsTotal: 0,
    turnsLeft: 0,
    guesses: 0,
    asked: 0,
    history: [],
    pending: null,
    online: true,
    joinedAt: input.now,
    finishedAt: null,
  };
  return {
    code: input.code,
    status: 'lobby',
    settings: normalizeSettings(input.settings ?? {}, defaultRoomSettings()),
    hostId: input.hostId,
    members: [member],
    spectators: [],
    targetId: null,
    createdAt: input.now,
    startedAt: null,
    endedAt: null,
    winnerId: null,
    endReason: null,
    vote: null,
    endedVote: null,
    hostOfflineAt: null,
  };
}

/* ---------------- 查询辅助（也供投影层复用） ---------------- */

export function findMember(room: Room, userId: string): RoomMember | undefined {
  return room.members.find((m) => m.userId === userId);
}

/** 参赛者中"没有离开"的人：包含已用尽、已放弃 */
export function aliveMembers(room: Room): RoomMember[] {
  return room.members.filter((m) => m.status !== 'left');
}

/** 还在竞争的人：还有轮次、还没猜中 */
export function activeMembers(room: Room): RoomMember[] {
  return room.members.filter((m) => m.status === 'playing');
}

export function onlineAlive(room: Room): RoomMember[] {
  return aliveMembers(room).filter((m) => m.online);
}

/** 结束投票的实时口径：分母 = 在线在局玩家，阈值 = 严格过半 */
export function voteTally(room: Room): { onlineCount: number; need: number; valid: string[] } {
  const alive = onlineAlive(room);
  const need = alive.length > 0 ? Math.floor(alive.length / 2) + 1 : 0;
  const valid = room.vote
    ? room.vote.votes.filter((uid) => alive.some((m) => m.userId === uid))
    : [];
  return { onlineCount: alive.length, need, valid };
}

/** 房主掉线后，谁可以发起结束投票（默认：最早加入的在线参赛者） */
export function voteInitiator(room: Room, now: number): string | null {
  if (room.hostOfflineAt === null) return room.hostId;
  if (now - room.hostOfflineAt < ROOM.hostHandoverMs) return room.hostId;
  const candidates = onlineAlive(room).sort((a, b) => a.joinedAt - b.joinedAt);
  return candidates[0]?.userId ?? room.hostId;
}

/* ---------------- 主入口 ---------------- */

export function applyEvent(room: Room, ev: RoomEvent, ctx: RoomCtx): ReduceResult {
  const now = ctx.now;
  const next = cloneRoom(room);
  const reject = (error: RoomError): ReduceResult => ({ ok: false, room, effects: [], error });
  const done = (extra: RoomEffect[] = []): ReduceResult => ({
    ok: true,
    room: next,
    effects: [...extra, { t: 'broadcast' }],
  });

  switch (ev.t) {
    /* ---------- 进房：lobby 是参赛，playing/finished 是观战 ---------- */
    case 'join': {
      if (next.status === 'closed') return reject('ROOM_CLOSED');

      const existing = findMember(next, ev.userId);
      if (existing) {
        if (existing.status !== 'left') {
          existing.online = true;
          existing.name = ev.name || existing.name;
          if (existing.userId === next.hostId) next.hostOfflineAt = null;
          return done();
        }
        // 误点"离开"后回来：还没开局就恢复参赛，已经开打就只能观战
        if (next.status === 'lobby' && aliveMembers(next).length < next.settings.maxPlayers) {
          existing.status = 'waiting';
          existing.online = true;
          existing.name = ev.name || existing.name;
          if (existing.userId === next.hostId) next.hostOfflineAt = null;
          return done();
        }
        if (next.spectators.some((s) => s.userId === ev.userId)) return done();
        if (next.spectators.length >= ROOM.spectatorsMax) return reject('SPECTATOR_FULL');
        next.spectators.push({ userId: ev.userId, name: ev.name, joinedAt: now, online: true });
        return done();
      }

      const spec = next.spectators.find((s) => s.userId === ev.userId);
      if (spec) {
        spec.online = true;
        return done();
      }

      const isLobby = next.status === 'lobby';
      if (isLobby) {
        const seats = aliveMembers(next).length;
        if (seats >= next.settings.maxPlayers) return reject('ROOM_FULL');
        next.members.push({
          userId: ev.userId,
          name: ev.name,
          role: 'player',
          status: 'waiting',
          turnsTotal: 0,
          turnsLeft: 0,
          guesses: 0,
          asked: 0,
          history: [],
          pending: null,
          online: true,
          joinedAt: now,
          finishedAt: null,
        });
        return done();
      }

      // 已开打（或已结束）：只能当观战者，看战况、看不到任何问答
      if (next.spectators.length >= ROOM.spectatorsMax) return reject('SPECTATOR_FULL');
      next.spectators.push({ userId: ev.userId, name: ev.name, joinedAt: now, online: true });
      return done();
    }

    /* ---------- 离房 ---------- */
    case 'leave': {
      const specIdx = next.spectators.findIndex((s) => s.userId === ev.userId);
      if (specIdx >= 0) {
        next.spectators.splice(specIdx, 1);
        return done();
      }

      const m = findMember(next, ev.userId);
      if (!m || m.status === 'left') return reject('NOT_MEMBER');
      m.status = 'left';
      m.pending = null;
      m.online = false;
      m.finishedAt = now;

      // 房主走了：立刻交给最早加入的在线者，避免房间失去开始/发起投票的能力
      if (m.userId === next.hostId) {
        const heir = onlineAlive(next).sort((a, b) => a.joinedAt - b.joinedAt)[0];
        if (heir) {
          next.hostId = heir.userId;
          heir.role = 'host';
          next.hostOfflineAt = null;
        }
      }
      next.vote = next.vote ? { ...next.vote, votes: next.vote.votes.filter((u) => u !== ev.userId) } : null;
      tryPassVote(next, now);
      checkEnd(next, now);
      return done(isFinished(next) ? [{ t: 'archive' }] : []);
    }

    /* ---------- 在线状态 ---------- */
    case 'presence': {
      const m = findMember(next, ev.userId);
      if (!m || m.status === 'left') {
        const spec = next.spectators.find((s) => s.userId === ev.userId);
        if (spec) spec.online = ev.online;
        return done();
      }
      m.online = ev.online;
      if (m.userId === next.hostId) {
        next.hostOfflineAt = ev.online ? null : (next.hostOfflineAt ?? now);
      }
      // 分母随时会变：有人掉线可能让已投的票刚好够线
      const passed = tryPassVote(next, now);
      return done(passed ? [{ t: 'archive' }] : []);
    }

    /* ---------- 改设置（房主、仅 lobby） ---------- */
    case 'config': {
      if (next.status !== 'lobby') return reject('NOT_LOBBY');
      if (ev.userId !== next.hostId) return reject('NOT_HOST');
      next.settings = normalizeSettings(ev.patch, next.settings);
      return done();
    }

    /* ---------- 开局 ---------- */
    case 'start': {
      if (next.status !== 'lobby') return reject('NOT_LOBBY');
      if (ev.userId !== next.hostId) return reject('NOT_HOST');
      if (aliveMembers(next).length < ROOM.playersMin) return reject('TOO_FEW_PLAYERS');
      next.status = 'playing';
      next.startedAt = now;
      next.targetId = ev.targetId;
      for (const m of next.members) {
        if (m.status === 'left') continue;
        m.status = 'playing';
        m.turnsTotal = next.settings.turnLimit;
        m.turnsLeft = next.settings.turnLimit;
        m.guesses = 0;
        m.asked = 0;
        m.history = [];
        m.pending = null;
        m.finishedAt = null;
      }
      return done();
    }

    /* ---------- 提问：先预扣轮次，再出门调模型 ---------- */
    case 'ask-start': {
      if (next.status !== 'playing') return reject('NOT_PLAYING');
      const m = findMember(next, ev.userId);
      if (!m || m.status === 'left') return reject('NOT_MEMBER');
      if (m.status !== 'playing') return reject('NOT_PLAYING');
      if (m.pending) return reject('ASK_PENDING');
      if (m.turnsLeft <= 0) return reject('NO_TURNS');
      m.pending = ev.ticket;
      m.turnsLeft -= 1; // 预扣：防并发双花，invalid/transient 时退还
      return done();
    }

    case 'ask-done': {
      if (next.status !== 'playing') return reject('NOT_PLAYING');
      const m = findMember(next, ev.userId);
      if (!m || m.status === 'left') return reject('NOT_MEMBER');
      if (!m.pending || m.pending !== ev.ticket) return reject('STALE_TICKET');
      m.pending = null;
      m.history.push(ev.record);

      const free = Boolean(ev.record.invalid || ev.record.transient);
      if (free) m.turnsLeft = Math.min(m.turnsTotal, m.turnsLeft + 1);
      else m.asked += 1;

      // 提问中点名猜中：不扣轮（与单人一致），直接结束
      if (ev.won) {
        m.turnsLeft = Math.min(m.turnsTotal, m.turnsLeft + 1);
        m.status = 'guessed';
        m.finishedAt = now;
        finish(next, 'guess', m.userId, now);
        return done([{ t: 'archive' }]);
      }

      if (!free && m.turnsLeft <= 0) {
        m.status = 'exhausted';
        m.finishedAt = now;
      }
      checkEnd(next, now);
      return done(isFinished(next) ? [{ t: 'archive' }] : []);
    }

    case 'ask-fail': {
      const m = findMember(next, ev.userId);
      if (!m || m.pending !== ev.ticket) return reject('STALE_TICKET');
      m.pending = null;
      m.turnsLeft = Math.min(m.turnsTotal, m.turnsLeft + 1); // 模型挂了不算次数
      return done();
    }

    /* ---------- 抢答 ---------- */
    case 'guess': {
      if (next.status !== 'playing') return reject('NOT_PLAYING');
      const m = findMember(next, ev.userId);
      if (!m || m.status !== 'playing') return reject('NOT_PLAYING');
      if (ev.correct) {
        m.status = 'guessed';
        m.finishedAt = now;
        finish(next, 'guess', m.userId, now);
        return done([{ t: 'archive' }]);
      }
      m.guesses += 1;
      m.turnsLeft = Math.max(0, m.turnsLeft - 1);
      if (m.turnsLeft === 0) {
        m.status = 'exhausted';
        m.finishedAt = now;
      }
      checkEnd(next, now);
      return done(isFinished(next) ? [{ t: 'archive' }] : []);
    }

    case 'abandon': {
      if (next.status !== 'playing') return reject('NOT_PLAYING');
      const m = findMember(next, ev.userId);
      if (!m || m.status !== 'playing') return reject('NOT_PLAYING');
      m.status = 'gave_up';
      m.pending = null;
      m.finishedAt = now;
      checkEnd(next, now);
      return done(isFinished(next) ? [{ t: 'archive' }] : []);
    }

    /* ---------- 结束投票 ---------- */
    case 'open-vote': {
      if (next.status !== 'playing') return reject('NOT_PLAYING');
      if (next.vote) return reject('VOTE_OPEN');
      if (ev.userId !== voteInitiator(next, now)) return reject('NOT_HOST');
      next.vote = { by: ev.userId, at: now, votes: [ev.userId] };
      const passed = tryPassVote(next, now);
      return done(passed ? [{ t: 'archive' }] : []);
    }

    case 'cast-vote': {
      if (next.status !== 'playing') return reject('NOT_PLAYING');
      if (!next.vote) return reject('NO_VOTE');
      const m = findMember(next, ev.userId);
      if (!m || m.status === 'left') return reject('NOT_MEMBER');
      if (next.vote.votes.includes(ev.userId)) return reject('ALREADY_VOTED');
      next.vote.votes.push(ev.userId);
      const passed = tryPassVote(next, now);
      return done(passed ? [{ t: 'archive' }] : []);
    }

    case 'cancel-vote': {
      if (!next.vote) return reject('NO_VOTE');
      if (ev.userId !== next.vote.by && ev.userId !== next.hostId) return reject('NOT_HOST');
      next.vote = null;
      return done();
    }

    /* ---------- 关房 ---------- */
    case 'close': {
      if (ev.by === 'host') {
        if (ev.userId !== next.hostId) return reject('NOT_HOST');
        // 已开打就必须走投票；只有还没开局（或已经结束）才允许直接关
        if (next.status === 'playing') return reject('NOT_LOBBY');
      }
      if (next.status === 'closed') return reject('ROOM_CLOSED');
      const effects: RoomEffect[] = [];
      // 还在打就强制结束（stale / system），此时问答要进账本，事后仍可复盘
      if (next.status === 'playing') {
        finish(next, ev.by === 'stale' ? 'stale' : 'host-closed', null, now);
        effects.push({ t: 'archive' });
      }
      next.status = 'closed';
      return { ok: true, room: next, effects: [...effects, { t: 'close' }] };
    }

    default:
      return reject('NOT_MEMBER');
  }
}

/* ---------------- 内部 ---------- */

function finish(room: Room, reason: EndReason, winnerId: string | null, now: number): void {
  if (reason === 'vote' && room.vote) {
    const tally = voteTally(room);
    const ended: EndedVote = {
      by: room.vote.by,
      onlineCount: tally.onlineCount,
      need: tally.need,
      onlineIds: onlineAlive(room).map((m) => m.userId),
    };
    room.endedVote = ended;
  }
  room.status = 'finished';
  room.endReason = reason;
  room.winnerId = winnerId;
  room.endedAt = now;
  room.vote = null;
  for (const m of room.members) {
    m.pending = null; // 在飞的问答作废：房间已结束，晚到的结果一律丢弃
    if (m.status === 'waiting') m.status = 'gave_up';
  }
}

function tryPassVote(room: Room, now: number): boolean {
  if (room.status !== 'playing' || !room.vote) return false;
  const { onlineCount, need, valid } = voteTally(room);
  if (onlineCount > 0 && valid.length >= need) {
    finish(room, 'vote', null, now);
    return true;
  }
  return false;
}

/** 结束条件（按优先级）：只剩 1 人 → 没人还在竞争 → 继续 */
function checkEnd(room: Room, now: number): void {
  if (room.status !== 'playing') return;
  const alive = aliveMembers(room);
  if (alive.length <= 1) {
    finish(room, 'last-man', null, now);
    return;
  }
  if (activeMembers(room).length === 0) finish(room, 'exhausted', null, now);
}

/** 类型收窄会挡住 oom.status === 'finished' 的比较，统一走这里 */
function isFinished(room: Room): boolean {
  return room.status === 'finished';
}

function cloneMember(m: RoomMember): RoomMember {
  return { ...m, history: m.history.slice() };
}

function cloneRoom(r: Room): Room {
  return {
    ...r,
    settings: { ...r.settings },
    members: r.members.map(cloneMember),
    spectators: r.spectators.map((s) => ({ ...s })),
    vote: r.vote ? { ...r.vote, votes: r.vote.votes.slice() } : null,
    endedVote: r.endedVote ? { ...r.endedVote, onlineIds: r.endedVote.onlineIds.slice() } : null,
  };
}
