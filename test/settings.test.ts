import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../src/server/db.ts';
import { createSettingsRoutes } from '../src/server/settings.ts';

const AUTH = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64');
const OTHER_AUTH = Buffer.from('fedcba9876543210fedcba9876543210').toString('base64');
const WRAPPED = '{"iv":"aaaa","ct":"bbbb"}';

let db: DatabaseSync;
let base = '';
let closeServer: (() => void) | null = null;

before(async () => {
  db = openDatabase({ file: ':memory:' });

  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRoutes({ db }));

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
  db?.close();
});

async function api(
  path: string,
  init: RequestInit = {},
  auth: string | null = AUTH,
): Promise<{ status: number; body: Record<string, any> }> {
  const headers: Record<string, string> = {};
  if (auth) headers['X-Vault-Auth'] = auth;
  if (init.body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${base}${path}`, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, body };
}

test('缺少或格式错误的鉴权头返回 401', async () => {
  const missing = await api('/api/settings/vault', {}, null);
  assert.equal(missing.status, 401);

  const bad = await api('/api/settings/vault', {}, 'short');
  assert.equal(bad.status, 401);
});

test('未创建时返回 404', async () => {
  const res = await api('/api/settings/vault');
  assert.equal(res.status, 404);
  assert.equal(res.body.error, 'VAULT_NOT_FOUND');
});

test('首次上传缺少数据密钥返回 400', async () => {
  const res = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: 0, blob: '{"iv":"x","ct":"y"}' }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'MISSING_DEK');
});

test('首次上传 baseVersion 不为 0 返回 409', async () => {
  const res = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: 3, blob: '{"iv":"x","ct":"y"}', wrappedDek: WRAPPED }),
  });
  assert.equal(res.status, 409);
});

test('创建成功并返回版本 1', async () => {
  const put = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: 0, blob: '{"iv":"x","ct":"y"}', wrappedDek: WRAPPED }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.version, 1);
});

test('同一管理密钥可以读回密文与包裹的数据密钥', async () => {
  const get = await api('/api/settings/vault');
  assert.equal(get.status, 200);
  assert.equal(get.body.version, 1);
  assert.equal(get.body.blob, '{"iv":"x","ct":"y"}');
  assert.equal(get.body.wrappedDek, WRAPPED);
});

test('不同的管理密钥读不到别人的设置', async () => {
  const get = await api('/api/settings/vault', {}, OTHER_AUTH);
  assert.equal(get.status, 404, 'vaultId 由 authKey 派生，换密钥即换记录');
});

test('版本冲突返回 409 并带回云端版本', async () => {
  const conflict = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: 0, blob: '{"iv":"a","ct":"b"}', wrappedDek: WRAPPED }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error, 'VERSION_CONFLICT');
  assert.equal(conflict.body.version, 1);
});

test('基于正确版本上传可以递增，并可轮换包裹的数据密钥', async () => {
  const nextWrapped = '{"iv":"cccc","ct":"dddd"}';
  const put = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: 1, blob: '{"iv":"n","ct":"m"}', wrappedDek: nextWrapped }),
  });
  assert.equal(put.status, 200);
  assert.equal(put.body.version, 2);

  const get = await api('/api/settings/vault');
  assert.equal(get.body.wrappedDek, nextWrapped, '新的 KEK 包裹结果被保存');
  assert.equal(get.body.blob, '{"iv":"n","ct":"m"}');
});

test('空密文与超大密文被拒绝', async () => {
  const empty = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: 2, blob: '', wrappedDek: WRAPPED }),
  });
  assert.equal(empty.status, 400);

  const huge = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: 2, blob: 'x'.repeat(70 * 1024), wrappedDek: WRAPPED }),
  });
  assert.equal(huge.status, 413);
});

test('版本号不合法被拒绝', async () => {
  const res = await api('/api/settings/vault', {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: -1, blob: '{"iv":"a","ct":"b"}', wrappedDek: WRAPPED }),
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'BAD_VERSION');
});

test('JSON 存储模式下同步接口返回 503', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', createSettingsRoutes({ db: null }));

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  const res = await fetch(`http://127.0.0.1:${address.port}/api/settings/vault`, {
    headers: { 'X-Vault-Auth': AUTH },
  });
  const body = (await res.json()) as { error: string };

  assert.equal(res.status, 503);
  assert.equal(body.error, 'SYNC_DISABLED');
  server.close();
});
