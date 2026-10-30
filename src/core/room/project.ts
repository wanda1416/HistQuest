import type { AnswerRecord, Character } from '../../shared/domain.ts';
import type { RecordView } from '../../shared/protocol.ts';
import type {
  MemberRole,
  Room,
  RoomMeView,
  RoomPlayerView,
  RoomReveal,
  RoomRevealPlayer,
  RoomSnapshot,
  RoomVoteView,
} from '../../shared/room.ts';
import { findMember, voteInitiator, voteTally } from './reducer.ts';
import { flagHistory, sessionNotes } from './review.ts';

/**
 * 唯一下行出口（对战版）。
 *
 * 与 server/dto.ts 同一条原则：**白名单生成**，不是"把敏感字段删掉"。
 * 对手视角里根本不存在 question / verdict / text 字段——没有可漏的东西。
 *
 * 三种视角：
 *   player    自己的问答 + 所有人的进度
 *   spectator 只有进度，一段问答都没有（中途加入者）
 *   finished  全员完整问答 + 目标人物 + 可疑标记（审查用）
 */

/** 与 server/dto.ts 的 projectRecord 同形；放这里是为了不反向依赖 server 层 */
function toRecordView(r: AnswerRecord): RecordView {
  const view: RecordView = { seq: r.seq, question: r.question, verdict: r.verdict, text: r.text };
  if (r.hint) view.hint = r.hint;
  if (r.invalid) view.invalid = r.invalid;
  return view;
}

/** transient（超时/坏 JSON）不进回顾：那不是玩家问的东西 */
function visibleHistory(history: AnswerRecord[]): RecordView[] {
  return history.filter((r) => !r.transient).map(toRecordView);
}

/** 排名：已猜中 > 轮次用得多（进程更深）> 猜错少 > 先加入 */
function rankMembers(room: Room) {
  return room.members
    .filter((m) => m.status !== 'left')
    .slice()
    .sort((a, b) => {
      if (a.userId === room.winnerId) return -1;
      if (b.userId === room.winnerId) return 1;
      const aUsed = a.turnsTotal - a.turnsLeft;
      const bUsed = b.turnsTotal - b.turnsLeft;
      if (aUsed !== bUsed) return bUsed - aUsed;
      if (a.guesses !== b.guesses) return a.guesses - b.guesses;
      return a.joinedAt - b.joinedAt;
    });
}

function voteView(room: Room, viewerId: string): RoomVoteView | null {
  if (!room.vote) return null;
  const { onlineCount, need, valid } = voteTally(room);
  return {
    byName: findMember(room, room.vote.by)?.name ?? '',
    votes: valid.length,
    need,
    onlineCount,
    voters: valid.map((uid) => findMember(room, uid)?.name ?? ''),
    mine: room.vote.votes.includes(viewerId),
  };
}

function revealOf(
  room: Room,
  character: Character,
  ranked: ReturnType<typeof rankMembers>,
): RoomReveal {
  const players: RoomRevealPlayer[] = ranked.map((m, i) => ({
    userId: m.userId,
    name: m.name,
    rank: i + 1,
    status: m.status,
    turnsUsed: Math.max(0, m.turnsTotal - m.turnsLeft),
    turnsTotal: m.turnsTotal,
    guesses: m.guesses,
    history: visibleHistory(m.history),
    flags: flagHistory(m.history),
    notes: sessionNotes(m.history),
  }));
  return {
    character,
    winnerId: room.winnerId,
    endReason: room.endReason,
    players,
    vote: room.endedVote,
    spectators: room.spectators.length,
  };
}

export function projectRoom(
  room: Room,
  viewerId: string,
  now: number,
  opts: { target?: Character | null } = {},
): RoomSnapshot {
  const member = findMember(room, viewerId);
  const mine = member && member.status !== 'left' ? member : undefined;
  const spec = room.spectators.find((s) => s.userId === viewerId);
  const role: MemberRole = mine ? (mine.userId === room.hostId ? 'host' : 'player') : 'spectator';

  const ranked = rankMembers(room);
  const players: RoomPlayerView[] = ranked.map((m, i) => ({
    userId: m.userId,
    name: m.name,
    isHost: m.userId === room.hostId,
    status: m.status,
    turnsUsed: Math.max(0, m.turnsTotal - m.turnsLeft),
    turnsTotal: m.turnsTotal,
    turnsLeft: m.turnsLeft,
    guesses: m.guesses,
    online: m.online,
    thinking: m.pending !== null,
    rank: i + 1,
  }));

  let me: RoomMeView;
  if (mine) {
    me = {
      userId: mine.userId,
      name: mine.name,
      role,
      status: mine.status,
      turnsLeft: mine.turnsLeft,
      turnsTotal: mine.turnsTotal,
      guesses: mine.guesses,
      pending: mine.pending !== null,
      canOpenVote:
        room.status === 'playing' &&
        !room.vote &&
        voteInitiator(room, now) === mine.userId,
      history: visibleHistory(mine.history),
    };
  } else {
    // 观战者 / 路人：连自己的历史都没有（本来就没有）
    me = { userId: viewerId, name: spec?.name ?? '', role: 'spectator' };
  }

  const snapshot: RoomSnapshot = {
    code: room.code,
    status: room.status,
    serverNow: now,
    settings: room.settings,
    hostId: room.hostId,
    me,
    players,
    spectators: room.spectators.length,
    vote: voteView(room, viewerId),
    winnerId: room.winnerId,
    endReason: room.endReason,
    startedAt: room.startedAt,
    endedAt: room.endedAt,
  };

  // 目标人物只在这一刻进入下行，且只在房间结束后
  if (room.status === 'finished' && opts.target) {
    snapshot.reveal = revealOf(room, opts.target, ranked);
  }
  return snapshot;
}

/**
 * 大厅列表行：只给"能用来决定进不进"的字段。
 * 进行中的房间不下发目标、不下发任何人的问答。
 */
export function roomListItem(room: Room): {
  code: string;
  hostName: string;
  status: Room['status'];
  players: number;
  maxPlayers: number;
  turnLimit: number;
  difficulty: number;
  createdAt: number;
} {
  return {
    code: room.code,
    hostName: findMember(room, room.hostId)?.name ?? '',
    status: room.status,
    players: room.members.filter((m) => m.status !== 'left').length,
    maxPlayers: room.settings.maxPlayers,
    turnLimit: room.settings.turnLimit,
    difficulty: room.settings.difficulty,
    createdAt: room.createdAt,
  };
}
