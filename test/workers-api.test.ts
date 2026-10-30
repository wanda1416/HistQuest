import test from 'node:test';
import assert from 'node:assert/strict';
import { before, after } from 'node:test';
import { openDatabase } from '../src/server/db.ts';
import { createD1 } from './fixtures/d1-sqlite.ts';
import { startMockLlm, type MockLlm } from './fixtures/mock-llm.ts';

/**
 * Workers 路由的离线集成测试：用 node:sqlite 冒充 D1，直接调用 bundle 的 fetch。
 *
 * 起因是一个只在线上出现的事故：`json(200, rt.solo.reveal(id))` 少了个 await，
 * 响应体变成 `{}`，客户端拿不到 character 就抛错，表现成"揭晓点了没反应"。
 * 接口测试（Node 版）覆盖不到 Workers 这条路径，所以补在这里。
 */

const db = openDatabase({ file: ':memory:' });
const mock = await startMockLlm();
const ORIGIN = 'https://hq.test';

const env = {
  DB: createD1(db),
  ASSETS: { fetch: async () => new Response('', { status: 404 }) },
  SESSION_SECRET: 'unit-test-secret-0123456789abcdef',
};

const bundle = (await import('../workers/bundle.ts')).default;

let cookie = '';
let gameId = '';

interface Res {
  status: number;
  body: Record<string, unknown>;
}

async function call(path: string, init: { method?: string; body?: unknown; cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await bundle.fetch(
    new Request(`${ORIGIN}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    }),
    env as never,
  );
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

before(() => {
  // Workers 的注册必须用邀请码，这里先塞一个
  db.prepare("INSERT INTO invites (code, created_by, created_at) VALUES ('invite-1', 'test', ?)").run(Date.now());
});

after(async () => {
  await mock.close();
});

test('注册并开局：进度写入 D1（sessions）与账本（games）', async () => {
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { username: 'workeruser', password: 'passw0rd!', invite: 'invite-1' },
  });
  assert.equal(reg.status, 201);
  assert.ok(cookie.startsWith('hq_session='), '应拿到会话 cookie');

  const start = await call('/api/solo', {
    method: 'POST',
    cookie,
    body: {
      difficulty: 1,
      polity: '唐',
      turns: 10,
      aiConfig: { baseURL: mock.url, apiKey: 'sk-workers-test', model: 'mock' },
    },
  });
  assert.equal(start.status, 201);
  gameId = String(start.body.gameId);
  assert.ok(gameId);

  const archived = db.prepare('SELECT user_name, target_name FROM games WHERE id = ?').get(gameId) as {
    user_name: string;
    target_name: string;
  };
  assert.equal(archived.user_name, 'workeruser');
  assert.ok(archived.target_name.length > 0);
});

test('提问返回完整判定（不是空对象）', async () => {
  const r = await call(`/api/solo/${gameId}/ask`, {
    method: 'POST',
    cookie,
    body: { question: '他是唐朝人吗', aiConfig: { baseURL: mock.url, apiKey: 'sk-workers-test', model: 'mock' } },
  });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.verdict, 'string');
  assert.equal(typeof r.body.turnsLeft, 'number');
  assert.equal(String(r.body.text).length > 0, true);
});

test('猜错返回 correct/turnsLeft（曾经的回归点：少 await 变成 {}）', async () => {
  const r = await call(`/api/solo/${gameId}/guess`, {
    method: 'POST',
    cookie,
    body: { name: '一个肯定不存在的人' },
  });
  assert.equal(r.status, 200);
  assert.equal(typeof r.body.correct, 'boolean', 'correct 必须是布尔值，而不是 undefined');
  assert.equal(r.body.correct, false);
  assert.equal(typeof r.body.turnsLeft, 'number', 'turnsLeft 必须是数字');
  assert.equal(r.body.turnsLeft, 8, '开局 10 问，已问 1、猜错扣 1');
});

test('揭晓返回人物卡与问答记录（曾经的回归点：少 await 变成 {}）', async () => {
  const r = await call(`/api/solo/${gameId}/reveal`, { method: 'POST', cookie, body: {} });
  assert.equal(r.status, 200);
  const character = r.body.character as { name?: string; polity?: string } | undefined;
  assert.ok(character, '揭晓必须带 character，否则客户端渲染会抛错');
  assert.equal(typeof character!.name, 'string');
  assert.ok(character!.name!.length > 0);
  assert.equal(Array.isArray(r.body.history), true);
  assert.equal((r.body.history as unknown[]).length, 1);
  assert.equal(r.body.status, 'revealed');
});

test('历史接口按账号返回，且游客身份被拒', async () => {
  const mine = await call('/api/history/mine', { cookie });
  assert.equal(mine.status, 200);
  const items = mine.body.items as Array<{ id: string; owner: string; target: { name: string } | null }>;
  const game = items.find((g) => g.id === gameId);
  assert.ok(game, '自己的局应出现在我的历史里');
  assert.equal(game!.owner, 'user');
  assert.ok(game!.target?.name, '已结束的局要带目标人物');

  const anonymous = await call('/api/history/mine');
  assert.equal(anonymous.status, 401);
});

test('未登录不能开局', async () => {
  const r = await call('/api/solo', {
    method: 'POST',
    body: { difficulty: 1, aiConfig: { baseURL: mock.url, apiKey: 'sk-workers-test', model: 'mock' } },
  });
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'LOGIN_REQUIRED');
});
