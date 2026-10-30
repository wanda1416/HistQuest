import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { before, after } from 'node:test';
import { createApp } from '../src/server/index.ts';
import { startMockLlm, type MockLlm } from './fixtures/mock-llm.ts';

/**
 * 对局历史验收：
 * 1. 问答逐条落库（含提问原文与判定），不是只留一句摘要
 * 2. 玩家只能看到自己的局；管理员能看到全部用户的局
 * 3. 会话过期/被清理后历史仍在（这是"用数据库保存对话历史"的核心诉求）
 * 4. 结局判定：猜中 / 次数用尽 / 主动放弃 / 进行中
 */

let mock: MockLlm;
let base = '';
let closeServer: () => void;
let db: DatabaseSync | null = null;

before(async () => {
  mock = await startMockLlm();
  const created = createApp({ sessionsFile: null });
  db = created.db;
  await new Promise<void>((resolve) => {
    const server = created.app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      base = `http://127.0.0.1:${addr.port}`;
      closeServer = () => server.close();
      resolve();
    });
  });
});

after(async () => {
  closeServer?.();
  await mock?.close();
});

interface Res {
  status: number;
  body: Record<string, unknown>;
  cookie: string | null;
}

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    cookie: setCookie[0] ? setCookie[0].split(';')[0]! : null,
  };
}

const post = (path: string, body: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body), ...(cookie ? { cookie } : {}) });

const aiConfig = () => ({ baseURL: mock.url, apiKey: 'sk-history-abcdef', model: 'mock' });

interface HistoryItem {
  id: string;
  result: string;
  turnsUsed: number;
  turnsTotal: number;
  userName?: string | null;
  target: { name: string } | null;
}

let aliceCookie = '';
let bobCookie = '';
let aliceGameId = '';
let guestGameId = '';

test('游客也能开局，但历史里没有归属', async () => {
  const start = await post('/api/solo', { difficulty: 1, polity: '唐', aiConfig: aiConfig() });
  assert.equal(start.status, 201);
  guestGameId = start.body.gameId as string;

  const ask = await post(`/api/solo/${guestGameId}/ask`, {
    question: '他是唐朝人吗',
    aiConfig: aiConfig(),
  });
  assert.equal(ask.status, 200);

  const mine = await call('/api/history/mine');
  assert.equal(mine.status, 401);
  assert.equal(mine.body.error, 'LOGIN_REQUIRED');
});

test('登录用户的问答逐条入库，并在「我的历史」里可见', async () => {
  const reg = await post('/api/auth/register', { username: 'alice', password: 'passw0rd!' });
  aliceCookie = reg.cookie!;

  const start = await post(
    '/api/solo',
    { difficulty: 2, polity: '唐', turns: 10, aiConfig: aiConfig() },
    aliceCookie,
  );
  assert.equal(start.status, 201);
  aliceGameId = start.body.gameId as string;

  await post(`/api/solo/${aliceGameId}/ask`, { question: '他是唐朝人吗', aiConfig: aiConfig() }, aliceCookie);
  await post(`/api/solo/${aliceGameId}/ask`, { question: '他当过皇帝吗', aiConfig: aiConfig() }, aliceCookie);
  // 无效问法也要留痕（那是真实对话的一部分），但不计次
  await post(`/api/solo/${aliceGameId}/ask`, { question: '他是唐朝人吗还是宋朝人', aiConfig: aiConfig() }, aliceCookie);
  const reveal = await post(`/api/solo/${aliceGameId}/reveal`, {}, aliceCookie);
  assert.equal(reveal.status, 200);

  const mine = await call('/api/history/mine', { cookie: aliceCookie });
  assert.equal(mine.status, 200);
  const items = mine.body.items as HistoryItem[];
  const game = items.find((g) => g.id === aliceGameId);
  assert.ok(game, '刚打完的这一局应出现在我的历史里');
  assert.equal(game!.result, 'abandoned', '还有余量就揭晓 = 主动放弃');
  assert.equal(game!.turnsTotal, 10);
  assert.equal(game!.turnsUsed, 2, '无效问法不扣次数');
  assert.equal(game!.target?.name.length! > 0, true, '已结束的局要给目标人物，便于复盘');

  const detail = await call(`/api/history/mine/${aliceGameId}`, { cookie: aliceCookie });
  assert.equal(detail.status, 200);
  const turns = detail.body.turns as Array<{ seq: number; question: string; verdict: string; invalid?: string }>;
  assert.equal(turns.length, 3, '三次提问全部落库');
  assert.equal(turns[0]!.question, '他是唐朝人吗');
  assert.ok(turns[0]!.verdict);
  assert.equal(turns[2]!.invalid, 'format');
});

test('进行中的局能看到自己的问答，但看不到目标人物', async () => {
  const start = await post('/api/solo', { difficulty: 1, polity: '唐', aiConfig: aiConfig() }, aliceCookie);
  const id = start.body.gameId as string;
  await post(`/api/solo/${id}/ask`, { question: '他是唐朝人吗', aiConfig: aiConfig() }, aliceCookie);

  const mine = await call('/api/history/mine', { cookie: aliceCookie });
  const game = (mine.body.items as HistoryItem[]).find((g) => g.id === id);
  assert.ok(game);
  assert.equal(game!.result, 'playing');
  assert.equal(game!.target, null, '进行中的局绝不能下发目标人物');
});

test('次数用尽记为 lost', async () => {
  const start = await post('/api/solo', { difficulty: 1, turns: 10, aiConfig: aiConfig() }, aliceCookie);
  const id = start.body.gameId as string;
  for (let i = 0; i < 10; i++) {
    await post(`/api/solo/${id}/guess`, { name: `不存在的人物${i}` }, aliceCookie);
  }
  const detail = await call(`/api/history/mine/${id}`, { cookie: aliceCookie });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.status, 'revealed');
  assert.equal(detail.body.result, 'lost');
  assert.equal(detail.body.turnsLeft ?? 0, 0);
});

test('别人看不到我的局（403），管理员能看到全部用户', async () => {
  const invite = await call('/api/admin/invites', {
    method: 'POST',
    headers: { 'X-HQ-Admin': '1' },
    body: JSON.stringify({ count: 1 }),
  });
  const code = (invite.body.codes as string[])[0]!;
  const reg = await post('/api/auth/register', { username: 'bob', password: 'passw0rd!', invite: code });
  bobCookie = reg.cookie!;

  const peek = await call(`/api/history/mine/${aliceGameId}`, { cookie: bobCookie });
  assert.equal(peek.status, 403);

  const bobMine = await call('/api/history/mine', { cookie: bobCookie });
  assert.equal(bobMine.status, 200);
  assert.equal((bobMine.body.items as HistoryItem[]).length, 0);

  const all = await call('/api/admin/history', { headers: { 'X-HQ-Admin': '1' } });
  assert.equal(all.status, 200);
  const items = all.body.items as HistoryItem[];
  assert.ok(items.some((g) => g.id === aliceGameId && g.userName === 'alice'));
  assert.ok(
    items.some((g) => g.id === guestGameId && (g.userName ?? null) === null),
    '游客的局也要能在后台看到（归属为空）',
  );

  const onlyMine = await call('/api/admin/history?user=alice', { headers: { 'X-HQ-Admin': '1' } });
  const filtered = onlyMine.body.items as HistoryItem[];
  assert.ok(filtered.length > 0);
  assert.ok(filtered.every((g) => g.userName === 'alice'));

  const abandoned = await call('/api/admin/history?result=abandoned', { headers: { 'X-HQ-Admin': '1' } });
  assert.ok((abandoned.body.items as HistoryItem[]).every((g) => g.result === 'abandoned'));

  const adminDetail = await call(`/api/admin/history/${aliceGameId}`, { headers: { 'X-HQ-Admin': '1' } });
  assert.equal(adminDetail.status, 200);
  assert.equal(adminDetail.body.userName, 'alice');
  assert.equal((adminDetail.body.turns as unknown[]).length, 3);
});

test('会话被清理后历史仍在（历史不寄生在 24h 会话上）', async () => {
  assert.ok(db, '测试应使用 SQLite 内存库');
  db!.exec('DELETE FROM sessions');

  const mine = await call('/api/history/mine', { cookie: aliceCookie });
  assert.equal(mine.status, 200);
  assert.ok(
    (mine.body.items as HistoryItem[]).some((g) => g.id === aliceGameId),
    'sessions 清空后仍应能从 games / game_turns 读到完整历史',
  );

  const detail = await call(`/api/history/mine/${aliceGameId}`, { cookie: aliceCookie });
  assert.equal(detail.status, 200);
  assert.equal((detail.body.turns as unknown[]).length, 3);
});

test('未启用 JSON 存储时历史接口有明确降级（这里验证 db 模式下的边界行为）', async () => {
  const notFound = await call(`/api/history/mine/does-not-exist`, { cookie: aliceCookie });
  assert.equal(notFound.status, 404);
});
