import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { before, after } from 'node:test';
import { createApp } from '../src/server/index.ts';

/**
 * 账号系统（Node 版）验收：
 * 第一个账号免邀请码且成为管理员、邀请码核销、cookie 会话、封禁、meta 用户态。
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

async function call(path: string, init: RequestInit & { cookie?: string } = {}): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (init.cookie) headers.Cookie = init.cookie;
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  const raw = setCookie[0] ? setCookie[0].split(';')[0]! : null;
  return {
    status: res.status,
    body: (await res.json().catch(() => ({}))) as Record<string, unknown>,
    cookie: raw,
  };
}

const post = (path: string, body: unknown, cookie?: string) =>
  call(path, { method: 'POST', body: JSON.stringify(body), ...(cookie ? { cookie } : {}) });

let adminCookie = '';
let memberCookie = '';

test('库里第一个账号免邀请码注册，并直接成为管理员', async () => {
  const r = await post('/api/auth/register', { username: 'hqboss', password: 'passw0rd!' });
  assert.equal(r.status, 201);
  const user = r.body.user as { username: string; role: string };
  assert.equal(user.username, 'hqboss');
  assert.equal(user.role, 'admin');
  assert.ok(r.cookie, '注册成功应下发会话 cookie');
  adminCookie = r.cookie!;
});

test('meta 反映登录态与账号系统开启', async () => {
  const r = await call('/api/meta', { cookie: adminCookie });
  assert.equal(r.body.authEnabled, true);
  const user = r.body.user as { username: string; role: string };
  assert.equal(user.username, 'hqboss');
  assert.equal(user.role, 'admin');

  const guest = await call('/api/meta');
  assert.equal(guest.body.user, null);
});

test('登录：密码错误 401，正确则拿到 cookie，me 能读回身份', async () => {
  const bad = await post('/api/auth/login', { username: 'hqboss', password: 'wrong-pass' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error, 'BAD_CREDENTIALS');

  const ok = await post('/api/auth/login', { username: 'hqboss', password: 'passw0rd!' });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie);

  const me = await call('/api/auth/me', { cookie: ok.cookie! });
  assert.equal((me.body.user as { username: string }).username, 'hqboss');
});

test('第二个账号必须有邀请码', async () => {
  const noInvite = await post('/api/auth/register', { username: 'friend', password: 'passw0rd!' });
  assert.equal(noInvite.status, 403);
  assert.equal(noInvite.body.error, 'BAD_INVITE');

  const badInvite = await post('/api/auth/register', {
    username: 'friend',
    password: 'passw0rd!',
    invite: 'not-a-real-code',
  });
  assert.equal(badInvite.status, 403);
});

test('管理员生成邀请码 → 朋友凭码注册成功 → 邀请码不可复用', async () => {
  const created = await call('/api/admin/invites', {
    method: 'POST',
    headers: { 'X-HQ-Admin': '1' } as unknown as Record<string, string>,
    body: JSON.stringify({ count: 1 }),
  });
  assert.equal(created.status, 201);
  const code = (created.body.codes as string[])[0]!;

  const reg = await post('/api/auth/register', { username: 'friend', password: 'passw0rd!', invite: code });
  assert.equal(reg.status, 201);
  assert.equal((reg.body.user as { role: string }).role, 'user');
  memberCookie = reg.cookie!;

  const reuse = await post('/api/auth/register', { username: 'friend2', password: 'passw0rd!', invite: code });
  assert.equal(reuse.status, 403);
  assert.equal(reuse.body.error, 'BAD_INVITE');
});

test('用户名占用返回 409', async () => {
  const created = await call('/api/admin/invites', {
    method: 'POST',
    headers: { 'X-HQ-Admin': '1' } as unknown as Record<string, string>,
    body: JSON.stringify({ count: 1 }),
  });
  const code = (created.body.codes as string[])[0]!;
  const dup = await post('/api/auth/register', { username: 'friend', password: 'passw0rd!', invite: code });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error, 'USERNAME_TAKEN');
});

test('后台能列出用户；封禁后该账号的会话立即失效、无法登录', async () => {
  const list = await call('/api/admin/users', { headers: { 'X-HQ-Admin': '1' } });
  assert.equal(list.status, 200);
  const users = list.body.users as Array<{ id: string; username: string }>;
  assert.ok(users.some((u) => u.username === 'friend'));

  const target = users.find((u) => u.username === 'friend')!;
  await call(`/api/admin/users/${target.id}/ban`, {
    method: 'POST',
    headers: { 'X-HQ-Admin': '1' },
    body: JSON.stringify({ on: true }),
  });

  const me = await call('/api/auth/me', { cookie: memberCookie });
  assert.equal(me.body.user, null, '被封禁的账号即使带着旧 cookie 也不再有效');

  const relogin = await post('/api/auth/login', { username: 'friend', password: 'passw0rd!' });
  assert.equal(relogin.status, 403);
  assert.equal(relogin.body.error, 'BANNED');

  // 解封，后续用例还要用它
  await call(`/api/admin/users/${target.id}/ban`, {
    method: 'POST',
    headers: { 'X-HQ-Admin': '1' },
    body: JSON.stringify({ on: false }),
  });
});

test('管理员账号受保护，不允许被封禁', async () => {
  const list = await call('/api/admin/users', { headers: { 'X-HQ-Admin': '1' } });
  const boss = (list.body.users as Array<{ id: string; username: string }>).find((u) => u.username === 'hqboss')!;
  const r = await call(`/api/admin/users/${boss.id}/ban`, {
    method: 'POST',
    headers: { 'X-HQ-Admin': '1' },
    body: JSON.stringify({ on: true }),
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'ADMIN_PROTECTED');
});

test('登出后 cookie 清空', async () => {
  const out = await post('/api/auth/logout', {}, memberCookie);
  assert.equal(out.status, 200);
  assert.equal(out.cookie, 'hq_session=', '登出应下发清空 cookie');
});
