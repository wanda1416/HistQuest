import test from 'node:test';
import assert from 'node:assert/strict';
import {
  authHashOf,
  decodeManagementKey,
  deriveKeys,
  encodeManagementKey,
  generateKey,
  keyFromBase64,
  keyToBase64,
  openPayload,
  sealPayload,
  unwrapDataKey,
  vaultIdFromAuthHash,
  wrapDataKey,
  type VaultPayload,
} from '../src/client/vault.ts';

const payload: VaultPayload = {
  version: 1,
  aiConfig: { baseURL: 'https://api.example.com/v1', apiKey: 'sk-test-123456', model: 'test-model' },
  prefs: { pronoun: 'neutral', turns: 20 },
  questions: ['他是唐朝人吗'],
  savedAt: 1700000000000,
};

test('管理密钥编解码往返', () => {
  const secret = generateKey();
  const code = encodeManagementKey(secret);
  assert.match(code, /^[A-Z2-9-]+$/);
  assert.deepEqual(decodeManagementKey(code), secret);
});

test('管理密钥忽略大小写与分隔符', () => {
  const secret = generateKey();
  const code = encodeManagementKey(secret);
  assert.deepEqual(decodeManagementKey(code.toLowerCase().replace(/-/g, ' ')), secret);
});

test('非法管理密钥返回 null', () => {
  assert.equal(decodeManagementKey(''), null);
  assert.equal(decodeManagementKey('ABC'), null, '长度不足');
  assert.equal(decodeManagementKey('IOIO-IOIO-IOIO-IOIO'), null, '含易混字符 I/O');
});

test('管理密钥 Base64 往返', () => {
  const secret = generateKey();
  assert.deepEqual(keyFromBase64(keyToBase64(secret)), secret);
  assert.equal(keyFromBase64('not-base64'), null);
});

test('HKDF 派生：同一密钥结果稳定，authKey 与 kek 不同', async () => {
  const secret = generateKey();
  const first = await deriveKeys(secret);
  const second = await deriveKeys(secret);

  assert.deepEqual(first.authKey, second.authKey);
  assert.deepEqual(first.kek, second.kek);
  assert.notDeepEqual(first.authKey, first.kek);
});

test('不同管理密钥派生出不同的 authKey', async () => {
  const a = await deriveKeys(generateKey());
  const b = await deriveKeys(generateKey());
  assert.notDeepEqual(a.authKey, b.authKey);
});

test('authHash 稳定，vaultId 取前 16 字节', async () => {
  const { authKey } = await deriveKeys(generateKey());
  const hash = await authHashOf(authKey);

  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(vaultIdFromAuthHash(hash).length, 32);
  assert.ok(hash.startsWith(vaultIdFromAuthHash(hash)));
});

test('数据密钥包裹/解包往返', async () => {
  const { kek } = await deriveKeys(generateKey());
  const dek = generateKey();

  const wrapped = await wrapDataKey(kek, dek);
  assert.deepEqual(await unwrapDataKey(kek, wrapped), dek);
});

test('错误 KEK 无法解包数据密钥', async () => {
  const a = await deriveKeys(generateKey());
  const b = await deriveKeys(generateKey());
  const wrapped = await wrapDataKey(a.kek, generateKey());

  await assert.rejects(() => unwrapDataKey(b.kek, wrapped));
});

test('载荷加解密往返，两次密文不同（随机 IV）', async () => {
  const dek = generateKey();
  const first = await sealPayload(dek, payload);
  const second = await sealPayload(dek, payload);

  assert.notEqual(first, second);
  assert.deepEqual(await openPayload(dek, first), payload);
});

test('错误数据密钥无法解密', async () => {
  const blob = await sealPayload(generateKey(), payload);
  await assert.rejects(() => openPayload(generateKey(), blob), /解密失败/);
});

test('篡改密文会被 GCM 拦住', async () => {
  const dek = generateKey();
  const sealed = JSON.parse(await sealPayload(dek, payload)) as { iv: string; ct: string };
  const bytes = atob(sealed.ct).split('');
  bytes[0] = bytes[0] === 'A' ? 'B' : 'A';
  sealed.ct = btoa(bytes.join(''));

  await assert.rejects(() => openPayload(dek, JSON.stringify(sealed)));
});

test('轮换管理密钥：数据密钥不变，旧密文仍可解', async () => {
  const oldSecret = generateKey();
  const newSecret = generateKey();
  const dek = generateKey();

  const blob = await sealPayload(dek, payload);
  const oldWrapped = await wrapDataKey((await deriveKeys(oldSecret)).kek, dek);
  const newWrapped = await wrapDataKey((await deriveKeys(newSecret)).kek, dek);

  // 新管理密钥解出的是同一把数据密钥，因此旧 blob 不需要重新加密
  assert.deepEqual(await unwrapDataKey((await deriveKeys(newSecret)).kek, newWrapped), dek);
  assert.deepEqual(await unwrapDataKey((await deriveKeys(oldSecret)).kek, oldWrapped), dek);
  assert.deepEqual(await openPayload(dek, blob), payload);
});
