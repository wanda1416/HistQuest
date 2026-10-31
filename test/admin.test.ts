import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/server/index.ts';
import { authorizeAdmin, isLoopback } from '../src/server/admin.ts';

/* ---------------- 纯函数：访问控制 ---------------- */

test('鉴权：本机放行，远程必须带正确令牌', () => {
  assert.equal(isLoopback('127.0.0.1'), true);
  assert.equal(isLoopback('::1'), true);
  assert.equal(isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(isLoopback('192.168.1.20'), false);
  assert.equal(isLoopback(undefined), false);

  assert.equal(authorizeAdmin({ remoteAddress: '127.0.0.1' }, '').ok, true);
  assert.equal(authorizeAdmin({ remoteAddress: '192.168.1.20' }, '').ok, false);
  assert.equal(
    authorizeAdmin({ remoteAddress: '192.168.1.20', authorization: 'Bearer s3cret-token' }, 's3cret-token').ok,
    true,
  );
  assert.equal(
    authorizeAdmin({ remoteAddress: '192.168.1.20', authorization: 'Bearer wrong-token' }, 's3cret-token').ok,
    false,
  );
  assert.equal(authorizeAdmin({ remoteAddress: '192.168.1.20', authorization: 's3cret-token' }, 's3cret-token').ok, false);
});

/* ---------------- HTTP：真实服务 ---------------- */

let base = '';
let tmpDir = '';
let charactersFile = '';
let closeServer: (() => void) | null = null;

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-admin-'));
  charactersFile = path.join(tmpDir, 'characters.json');
  fs.copyFileSync(new URL('../data/characters.json', import.meta.url), charactersFile);

  const { app } = createApp({
    charactersFile,
    sessionsFile: null,
    backupDir: path.join(tmpDir, 'backups'),
  });

  await new Promise<void>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      base = `http://127.0.0.1:${address.port}`;
      closeServer = () => server.close();
      resolve();
    });
  });
});

after(() => {
  closeServer?.();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function api(
  pathname: string,
  init: RequestInit = {},
  withAdminHeader = true,
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = {};
  if (withAdminHeader) headers['X-HQ-Admin'] = '1';
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${pathname}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body };
}

test('缺少 X-HQ-Admin 头一律拒绝', async () => {
  const res = await fetch(`${base}/api/admin/meta`);
  assert.equal(res.status, 403);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'ADMIN_HEADER_REQUIRED');
});

test('meta 返回朝代/身份词表与统计', async () => {
  const { status, body } = await api('/api/admin/meta');
  assert.equal(status, 200);
  assert.equal(body.total, 184);
  assert.equal(body.active, 184);
  assert.ok(body.dynasties.includes('蒙古'), '朝代枚举应已包含蒙古');
  assert.ok(body.roles.includes('诗人'));
});

test('非法人物被拒绝，且文件不被改写', async () => {
  const before = fs.readFileSync(charactersFile, 'utf8');
  const { status, body } = await api('/api/admin/targets', {
    method: 'POST',
    body: JSON.stringify({
      id: 'bad_person',
      name: '坏数据',
      region: 'cn',
      polity: '魏国',
      gender: 'male',
      roles: [],
      notable: '',
      difficulty: 9,
    }),
  });

  assert.equal(status, 400);
  assert.equal(body.error, 'VALIDATION_FAILED');
  assert.ok(body.issues.some((i: { code: string }) => i.code === 'polity_unknown'));
  assert.equal(fs.readFileSync(charactersFile, 'utf8'), before);
});

test('写操作必须使用 application/json', async () => {
  const res = await fetch(`${base}/api/admin/targets`, {
    method: 'POST',
    headers: { 'X-HQ-Admin': '1' },
    body: '{}',
  });
  assert.equal(res.status, 415);
});

test('新增 → 查询 → 修改 → 导出 → 下线', async () => {
  const person = {
    id: 'test_person',
    name: '测试君',
    aliases: ['测试郎'],
    region: 'cn',
    polity: '唐',
    gender: 'male',
    birth: 700,
    death: 760,
    birthplace: '长安（今陕西西安）',
    birthProvince: '陕西',
    roles: ['诗人'],
    tags: ['测试'],
    emperor: false,
    notable: '用于测试的人物',
    difficulty: 2,
  };

  const created = await api('/api/admin/targets', {
    method: 'POST',
    body: JSON.stringify(person),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.character.name, '测试君');

  const fetched = await api('/api/admin/targets/test_person');
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.character.polity, '唐');

  const updated = await api('/api/admin/targets/test_person', {
    method: 'PUT',
    body: JSON.stringify({ ...person, notable: '改过的测试事迹' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.character.notable, '改过的测试事迹');

  const exported = await fetch(`${base}/api/admin/export`, { headers: { 'X-HQ-Admin': '1' } });
  assert.equal(exported.status, 200);
  const text = await exported.text();
  assert.ok(text.includes('改过的测试事迹'));
  assert.ok(text.endsWith(']\n'));

  const retired = await api('/api/admin/targets/test_person/retire', {
    method: 'POST',
    body: JSON.stringify({ retired: true }),
  });
  assert.equal(retired.status, 200);

  const meta = await api('/api/meta', {}, false);
  assert.equal(meta.body.dataCount, 184, '下线后不应计入可抽人物');
});

test('健康报告可访问且返回矩阵', async () => {
  const { status, body } = await api('/api/admin/health');
  assert.equal(status, 200);
  assert.equal(body.total, 185);
  assert.equal(body.active, 184);
  assert.equal(body.retired, 1);
  assert.ok(Array.isArray(body.matrix));
  assert.ok(body.matrix.some((row: { polity: string }) => row.polity === '西晋'));
});
