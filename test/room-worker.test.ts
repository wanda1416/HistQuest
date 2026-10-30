import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/server/db.ts';
import { createD1 } from './fixtures/d1-sqlite.ts';
import { startMockLlm, type MockLlm } from './fixtures/mock-llm.ts';
import { seedCharactersIntoD1 } from '../workers/d1.ts';
import type { Character } from '../src/shared/domain.ts';

/**
 * 对战房间的离线集成测试：在同一个进程里直接实例化 Durable Object，
 * 用假 storage + 假 D1 + 假模型跑完整的一局。
 *
 * 起因：`room-do.ts` 里的 SQL（rooms 目录、games 账本）和"效果 → 副作用"的接线
 * 只有真跑一遍才暴露问题；core 的单元测试覆盖不到这一层。
 */

const db = openDatabase({ file: ':memory:' });
const d1 = createD1(db);
const mock: MockLlm = await startMockLlm();

const CHARACTERS: Character[] = [
  {
    id: 'li_bai',
    name: '李白',
    aliases: ['李太白', '诗仙'],
    region: 'cn',
    polity: '唐',
    gender: 'male',
    birth: 701,
    death: 762,
    birthplace: '碎叶城',
    birthProvince: '西域',
    roles: ['诗人'],
    tags: ['浪漫主义'],
    emperor: false,
    notable: '诗仙',
    difficulty: 1,
  },
];

/** DO storage 的最小替身：一个 Map */
class FakeStorage {
  private map = new Map<string, unknown>();
  alarmAt: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<boolean> {
    return this.map.delete(key);
  }
  async setAlarm(at: number): Promise<void> {
    this.alarmAt = at;
  }
}

function makeState() {
  const storage = new FakeStorage();
  return {
    storage,
    acceptWebSocket(): void {
      /* 本测试只走 HTTP 通道 */
    },
    getWebSockets(): never[] {
      return [];
    },
  };
}

const env = {
  DB: d1,
  AI_BASE_URL: mock.url,
  AI_API_KEY: 'sk-room-test-000000',
  AI_MODEL: 'mock',
};

/** 懒加载：room-do 顶层声明了 WebSocketPair 类型，导入本身不该触发任何运行时依赖 */
const { RoomDo } = await import('../workers/room-do.ts');

function call(room: ReturnType<typeof makeRoom>, path: string, init: {
  method?: string;
  userId?: string;
  name?: string;
  body?: unknown;
} = {}) {
  return room.fetch(
    new Request(`https://room${path}`, {
      method: init.method ?? 'GET',
      headers: {
        'x-hq-user-id': init.userId ?? 'u1',
        ...(init.name ? { 'x-hq-user-name': encodeURIComponent(init.name) } : {}),
        ...(init.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    }),
  );
}

function makeRoom() {
  // 每次换一个全新的 DO 实例 + storage，等价于"房间被驱逐后重新装载"
  return new RoomDo(makeState() as never, env as never);
}

const json = async (res: Response) => (await res.json()) as Record<string, never> & any;

before(async () => {
  // 一次性的老库：characters 表由 openDatabase 建好，这里灌一个人物
  await seedCharactersIntoD1(d1 as never, CHARACTERS);
});

after(async () => {
  await mock.close();
});

test('房间 DO：建房 → 加入 → 开局 → 提问 → 投票结束 → 落账', async () => {
  const room = makeRoom();

  const created = await call(room, '/new', {
    method: 'POST',
    userId: 'u1',
    name: '甲',
    body: { code: 'RM0001', settings: { turnLimit: 10, difficulty: 1 }, listed: true },
  });
  assert.equal(created.status, 201);
  const snapshot = await json(created);
  assert.equal(snapshot.status, 'lobby');
  assert.equal(snapshot.me.role, 'host');
  assert.equal(snapshot.settings.turnLimit, 10);

  const joined = await json(
    await call(room, '/join', { method: 'POST', userId: 'u2', name: '乙' }),
  );
  assert.equal(joined.players.length, 2);

  const started = await json(
    await call(room, '/cmd', { method: 'POST', userId: 'u1', body: { t: 'start' } }),
  );
  assert.equal(started.status, 'playing');
  assert.equal(started.me.turnsLeft, 10, '轮次按房间设置下发');

  // 真调一次假模型：走的是和线上完全相同的 runAsk 链路
  const asked = await json(
    await call(room, '/cmd', { method: 'POST', userId: 'u1', body: { t: 'ask', question: '他是唐朝人吗' } }),
  );
  assert.equal(asked.me.history.length, 1, '问答要落到自己的轨道里');
  assert.equal(asked.me.turnsLeft, 9, '有效提问扣 1 轮');
  assert.ok(['yes', 'no', 'unknown'].includes(asked.me.history[0].verdict));

  // 对手视角：进度可见、问答不可见
  const viewB = await json(await call(room, '/snapshot', { userId: 'u2' }));
  const aView = viewB.players.find((p: { userId: string }) => p.userId === 'u1');
  assert.equal(aView.turnsUsed, 1);
  assert.equal(JSON.stringify(viewB).includes('他是唐朝人吗'), false, '不得下发对手的问题原文');
  assert.equal(viewB.reveal, undefined);

  // 投票：房主发起 1/2 不通过，第二人附议即结束
  const vote1 = await json(
    await call(room, '/cmd', { method: 'POST', userId: 'u1', body: { t: 'open-vote' } }),
  );
  assert.equal(vote1.status, 'playing');
  assert.equal(vote1.vote.votes, 1);
  assert.equal(vote1.vote.need, 2);

  const finished = await json(
    await call(room, '/cmd', { method: 'POST', userId: 'u2', body: { t: 'cast-vote' } }),
  );
  assert.equal(finished.status, 'finished');
  assert.equal(finished.endReason, 'vote');

  // 复盘：目标人物与全员问答都下发
  const review = await json(await call(room, '/snapshot', { userId: 'u2' }));
  assert.equal(review.reveal.character.name, '李白');
  assert.equal(review.reveal.players.some((p: { history: unknown[] }) => p.history.length === 1), true);
  assert.equal(JSON.stringify(review).includes('他是唐朝人吗'), true, '结束后能看到别人的问答');
  assert.ok(review.reveal.vote, '投票现场快照要留下来');

  /* ---- 落账：rooms 目录 + 每位参赛者一条 games 行 ---- */
  const roomRow = await d1.prepare('SELECT code, status, end_reason, target_id FROM rooms WHERE code = ?')
    .bind('RM0001')
    .first<{ code: string; status: string; end_reason: string; target_id: string }>();
  assert.ok(roomRow, '目录表要有一行');
  assert.equal(roomRow!.status, 'finished');
  assert.equal(roomRow!.end_reason, 'vote');
  assert.equal(roomRow!.target_id, 'li_bai', '结束后目录里才写目标人物');

  const games = await d1
    .prepare('SELECT id, user_name, target_name, status, turns_used, asks, room_id, finish_rank FROM games ORDER BY finish_rank')
    .bind()
    .all<Record<string, unknown>>();
  assert.equal(games.results.length, 2, '每位参赛者一条对局记录');
  const g0 = games.results[0]! as Record<string, string | number>;
  assert.equal(g0.target_name, '李白');
  assert.equal(g0.turns_used, 1);
  assert.equal(g0.asks, 1);
  assert.ok(g0.room_id, 'room_id 要把账本指回房间');
  assert.equal(g0.finish_rank, 1);

  const turns = await d1
    .prepare('SELECT game_id, seq, question, verdict FROM game_turns')
    .bind()
    .all<Record<string, unknown>>();
  assert.equal(turns.results.length, 1, '逐条问答要进账本');
  assert.equal(turns.results[0]!.question, '他是唐朝人吗');

  /* ---- 历史投影：对战局要带 roomId / finishRank，别再显示"放弃" ---- */
  const { rowToSummary } = await import('../src/server/history.ts');
  const row = await d1.prepare('SELECT * FROM games WHERE finish_rank = 1').bind().first<Record<string, unknown>>();
  assert.ok(row, '第 1 名的账本行要存在');
  const summary = rowToSummary(row as never);
  assert.equal(summary.roomId, row!.room_id, 'roomId 要进投影');
  assert.equal(summary.finishRank, 1);
  // 结局语义保持不变（revealed+余量=abandoned），但前端用 finishRank 覆盖显示
  assert.equal(summary.result, 'abandoned');

  // 单人局没有这两个字段：JSON 里不应出现 undefined 键
  const soloRow = { ...row, room_id: null, finish_rank: null };
  const soloSummary = rowToSummary(soloRow as never);
  assert.equal('roomId' in soloSummary, false, '单人局不带 roomId');
  assert.equal('finishRank' in soloSummary, false, '单人局不带 finishRank');
});

test('房间 DO：状态存进 storage，换一个实例（模拟驱逐）能接着打', async () => {
  const room = makeRoom();
  await call(room, '/new', {
    method: 'POST',
    userId: 'u1',
    name: '甲',
    body: { code: 'RM0002', settings: { turnLimit: 12, difficulty: 1 } },
  });
  await call(room, '/join', { method: 'POST', userId: 'u2', name: '乙' });
  await call(room, '/cmd', { method: 'POST', userId: 'u1', body: { t: 'start' } });

  const state = makeState();
  const first = new RoomDo(state as never, env as never);
  await call(first, '/new', {
    method: 'POST',
    userId: 'u1',
    name: '甲',
    body: { code: 'RM0003', settings: { turnLimit: 12, difficulty: 1 } },
  });
  await call(first, '/join', { method: 'POST', userId: 'u2', name: '乙' });
  await call(first, '/cmd', { method: 'POST', userId: 'u1', body: { t: 'start' } });

  // 同一个 storage，新的实例
  const rebooted = new RoomDo(state as never, env as never);
  const snap = await json(await call(rebooted, '/snapshot', { userId: 'u1' }));
  assert.equal(snap.status, 'playing', '房间状态必须从 storage 里恢复');
  assert.equal(snap.me.turnsLeft, 12);
  assert.equal(snap.players.length, 2);
});

test('房间 DO：未登录 / 不存在的房间给出明确错误', async () => {
  const room = makeRoom();
  const noAuth = await room.fetch(new Request('https://room/snapshot'));
  assert.equal(noAuth.status, 401);

  const missing = await call(room, '/snapshot', { userId: 'u9' });
  assert.equal(missing.status, 404, '没有这间房就该是 404，而不是空房间');
  const body = await json(missing);
  assert.equal(body.error, 'NOT_FOUND');
});

test('房间 DO：房主以外的玩家不能开局', async () => {
  const room = makeRoom();
  await call(room, '/new', { method: 'POST', userId: 'u1', name: '甲', body: { code: 'RM0004' } });
  await call(room, '/join', { method: 'POST', userId: 'u2', name: '乙' });
  const res = await call(room, '/cmd', { method: 'POST', userId: 'u2', body: { t: 'start' } });
  assert.equal(res.status, 409);
  const body = await json(res);
  assert.equal(body.error, 'NOT_HOST');
});
