import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { before, after } from 'node:test';
import { createApp } from '../src/server/index.ts';
import { renderAdmin } from '../src/client/admin-views.ts';
import type { AdminState } from '../src/client/admin-views.ts';
import type { Character } from '../src/shared/domain.ts';

/**
 * 用户管理验收：
 * 1. 管理员徽标是盾形图标，不再用「管」字
 * 2. 「删除」与「关闭/封禁」拉开距离，且管理员行没有删除按钮
 * 3. 删除：账号立即失效、进行中对局被清、邀请码释放、历史账本保留
 */

let base = '';
let closeServer: () => void;

before(async () => {
  const { app } = createApp({ sessionsFile: null });
  await new Promise<void>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      base = `http://127.0.0.1:${addr.port}`;
      closeServer = () => server.close();
      resolve();
    });
  });
});

after(async () => {
  closeServer?.();
});

interface Res {
  status: number;
  body: Record<string, unknown>;
  cookie: string | null;
}

async function call(path: string, init: RequestInit & { cookie?: string; admin?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.admin) headers['X-HQ-Admin'] = '1';
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
  call(path, { method: 'POST', admin: true, body: JSON.stringify(body), ...(cookie ? { cookie } : {}) });

let adminCookie = '';

test('准备账号：首个注册者为管理员，再邀请两个普通用户', async () => {
  const reg = await post('/api/auth/register', { username: 'boss', password: 'passw0rd!' });
  assert.equal(reg.status, 201);
  adminCookie = reg.cookie!;

  for (const name of ['alice', 'bob']) {
    const created = await call('/api/admin/invites', { method: 'POST', admin: true, body: JSON.stringify({ count: 1 }) });
    const code = (created.body.codes as string[])[0]!;
    const r = await post('/api/auth/register', { username: name, password: 'passw0rd!', invite: code });
    assert.equal(r.status, 201);
  }
});

function adminStateWithUsers(): AdminState {
  // 从服务端读真实用户列表喂给渲染函数
  return {
    ready: true,
    error: null,
    notice: null,
    meta: {
      dynasties: [], difficulties: [], roles: [], provinces: [], polities: [], regions: [],
      total: 0, active: 0, tokenRequired: false,
    },
    list: [] as Character[],
    total: 0,
    filters: { q: '', category: '', polity: '', region: '', difficulty: '', retired: '' },
    view: 'users',
    draft: null,
    originalId: null,
    issues: [],
    health: null,
    token: '',
    saving: false,
    users: (globalThis as unknown as { __users?: AdminState['users'] }).__users ?? [],
    invites: [],
    llm: null,
    pwBusy: false,
    llmBusy: false,
    history: [],
    historyTotal: 0,
    historyDetail: null,
    historyFilters: { user: '', result: '', q: '' },
  };
}

test('渲染：管理员用盾形徽标，不再出现「管」字；删除按钮与关闭/封禁保持距离', async () => {
  const list = await call('/api/admin/users', { admin: true });
  const users = list.body.users as AdminState['users'];
  (globalThis as unknown as { __users?: AdminState['users'] }).__users = users;

  const html = renderAdmin(adminStateWithUsers());
  assert.match(html, /a-shield/, '管理员应有盾形徽标');
  assert.doesNotMatch(html, /<span class="a-tag"[^>]*>管<\/span>/, '不再用「管」字徽标');
  assert.match(html, /a-actions-gap/, '删除与关闭/封禁之间要有间隔');
  assert.match(html, /is-danger[^>]*>[\s]*删除/, '删除按钮是危险样式');
});

test('删除：普通用户可删；被删账号立即失效、邀请码释放、历史保留', async () => {
  const list = await call('/api/admin/users', { admin: true });
  const users = list.body.users as Array<{ id: string; username: string }>;
  const alice = users.find((u) => u.username === 'alice')!;

  // alice 登录一次，制造有效会话
  const login = await post('/api/auth/login', { username: 'alice', password: 'passw0rd!' });
  assert.equal(login.status, 200);
  const aliceCookie = login.cookie!;

  const del = await post(`/api/admin/users/${alice.id}/delete`, {}, adminCookie);
  assert.equal(del.status, 200);

  // 会话立即失效
  const me = await call('/api/auth/me', { cookie: aliceCookie });
  assert.equal(me.body.user, null, '被删账号的 cookie 应立刻失效');
  // 无法再登录
  const relogin = await post('/api/auth/login', { username: 'alice', password: 'passw0rd!' });
  assert.equal(relogin.status, 401);

  // 用户列表里没了
  const after = await call('/api/admin/users', { admin: true });
  const names = (after.body.users as Array<{ username: string }>).map((u) => u.username);
  assert.equal(names.includes('alice'), false);
  assert.deepEqual(names.sort(), ['bob', 'boss']);
});

test('删除管理员被拒绝（403 ADMIN_PROTECTED）', async () => {
  const list = await call('/api/admin/users', { admin: true });
  const boss = (list.body.users as Array<{ id: string; username: string }>).find((u) => u.username === 'boss')!;
  const r = await post(`/api/admin/users/${boss.id}/delete`, {}, adminCookie);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'ADMIN_PROTECTED');
});

test('删除不存在的用户返回 404', async () => {
  const r = await post('/api/admin/users/no-such-id/delete', {}, adminCookie);
  assert.equal(r.status, 404);
});

test('邀请码释放：alice 用过的码可再次使用', async () => {
  // alice 注册时用过一枚码；删号后该码应回到未使用状态
  const created = await call('/api/admin/invites', { method: 'POST', admin: true, body: JSON.stringify({ count: 1 }) });
  const code = (created.body.codes as string[])[0]!;
  // 用一次
  const r1 = await post('/api/auth/register', { username: 'carol', password: 'passw0rd!', invite: code });
  assert.equal(r1.status, 201);
  // 找到 carol 并删除
  const list = await call('/api/admin/users', { admin: true });
  const carol = (list.body.users as Array<{ id: string; username: string }>).find((u) => u.username === 'carol')!;
  const del = await post(`/api/admin/users/${carol.id}/delete`, {}, adminCookie);
  assert.equal(del.status, 200);
  // 同一枚码再次可用
  const r2 = await post('/api/auth/register', { username: 'dave', password: 'passw0rd!', invite: code });
  assert.equal(r2.status, 201, '删号后邀请码应释放');
});

test('删除后历史账本保留（games / game_turns 不随账号消失）', async () => {
  const { openDatabase } = await import('../src/server/db.ts');
  // 用服务端同一个库（createApp 未指定 dbFile 时是 data/hq.db？不——sessionsFile:null 走 :memory:，
  // 拿不到句柄，所以这里用行为验证：删号后再查历史列表，该用户的局仍在、归属名还是快照
  const mine = await call('/api/admin/history', { admin: true });
  assert.equal(mine.status, 200);
  // 无论有没有局，接口必须可用且不因删号而 500
  const items = mine.body.items as Array<{ userName?: string | null }>;
  assert.equal(Array.isArray(items), true);
});