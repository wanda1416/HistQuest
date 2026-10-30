import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { before, after } from 'node:test';
import type { AiCredential, Character } from '../src/shared/domain.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { SoloStore } from '../src/server/solo.ts';
import { startMockLlm, type MockLlm } from './fixtures/mock-llm.ts';

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];
const index = new CharacterIndex(list);
const libai = list.find((c) => c.name === '李白')!;
const onlyLibai = new CharacterIndex([libai]);

let mock: MockLlm;
let cred: AiCredential;

before(async () => {
  mock = await startMockLlm();
  cred = { kind: 'byok', baseURL: mock.url, apiKey: 'sk-test-123456', model: 'mock' };
});

after(async () => {
  await mock?.close();
});

test('开局锁定目标人物，重复读取不变', () => {
  const store = new SoloStore(index, { turns: 20, file: null });
  const s = store.create({ difficulty: 2, polity: '唐', rng: () => 0.3 });
  const again = store.require(s.id);
  assert.equal(again.targetId, s.targetId);
  assert.equal(again.turnsLeft, 20);
});

test('验收1：进程重启后目标人物不变', () => {
  const file = path.join(os.tmpdir(), `hq-solo-${Date.now()}.json`);
  const store1 = new SoloStore(index, { turns: 20, file });
  const s = store1.create({ difficulty: 1, polity: '唐', rng: () => 0.7 });
  store1.flush();

  const store2 = new SoloStore(index, { turns: 20, file });
  assert.equal(store2.require(s.id).targetId, s.targetId);
  fs.rmSync(file, { force: true });
});

test('验收5：猜中别名即获胜', () => {
  const store = new SoloStore(onlyLibai, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  const r = store.guess(s.id, '李太白');
  assert.equal(r.correct, true);
  assert.equal(r.status, 'won');
});

test('猜错扣一次机会', () => {
  const store = new SoloStore(onlyLibai, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  const r = store.guess(s.id, '杜甫');
  assert.equal(r.correct, false);
  assert.equal(r.turnsLeft, 19);
  assert.equal(r.status, 'playing');
});

test('有效提问扣次数，无效提问不扣', async () => {
  const store = new SoloStore(onlyLibai, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });

  const ok = await store.ask(s.id, '他是唐朝人吗', cred);
  assert.equal(ok.accepted, true);
  assert.equal(ok.turnsLeft, 19);

  const long = await store.ask(s.id, '他'.repeat(220), cred);
  assert.equal(long.accepted, false);
  assert.equal(long.invalid, 'format');
  assert.equal(long.turnsLeft, 19, '无效问不应扣次数');
});

test('同一问题第二次直接命中缓存，不再调用模型', async () => {
  const store = new SoloStore(onlyLibai, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  await store.ask(s.id, '他是唐朝人吗', cred);
  const before = mock.callCount();
  const second = await store.ask(s.id, '他是唐朝人吗', cred);
  assert.equal(second.verdict, 'yes');
  assert.equal(mock.callCount(), before, '缓存命中不应产生新调用');
});

test('次数用尽自动进入揭晓态', async () => {
  const store = new SoloStore(onlyLibai, { turns: 1, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  const r = await store.ask(s.id, '他是唐朝人吗', cred);
  assert.equal(r.turnsLeft, 0);
  assert.equal(r.status, 'revealed');
});

test('揭晓返回人物与历史，历史不含判定依据', async () => {
  const store = new SoloStore(onlyLibai, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  await store.ask(s.id, '他是唐朝人吗', cred);
  const reveal = store.reveal(s.id);
  assert.equal(reveal.character.name, '李白');
  assert.equal(reveal.history.length, 1);
  assert.equal('basis' in reveal.history[0]!, false);
});

test('出错时抛明确的业务错误', () => {
  const store = new SoloStore(index, { turns: 20, file: null });
  assert.throws(() => store.require('不存在的id'), /找不到这一局/);
});

test('提问中点名猜中：直接结算为 won，这一问不扣次数', async () => {
  const store = new SoloStore(onlyLibai, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  const before = store.require(s.id).turnsLeft;
  const r = await store.ask(s.id, '他是李白吗', cred);
  assert.equal(r.status, 'won');
  assert.equal(r.verdict, 'yes');
  assert.ok(/恭喜|猜中/.test(r.text), r.text);
  assert.equal(r.turnsLeft, before, '猜中的一问不扣次数');
  const after = store.require(s.id);
  assert.equal(after.status, 'won');
  // 已结束的局不能再问
  await assert.rejects(() => store.ask(s.id, '他是唐朝人吗', cred), /已结束/);
});

test('提问中点名猜错：答否并扣一次', async () => {
  const store = new SoloStore(onlyLibai, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  const r = await store.ask(s.id, '他是杜甫吗', cred);
  assert.equal(r.status, 'playing');
  assert.equal(r.verdict, 'no');
  assert.equal(r.turnsLeft, 19);
});

test('轮次可选：自选 30 问生效，越界被夹到 [10, 上限]', async () => {
  const store = new SoloStore(index, { turns: 50, file: null });
  const a = store.create({ difficulty: 1, polity: null, turns: 30 });
  assert.equal(a.turnsLeft, 30);

  const tooMany = store.create({ difficulty: 1, polity: null, turns: 999 });
  assert.equal(tooMany.turnsLeft, 50, '超过上限夹回上限');

  const tooFew = store.create({ difficulty: 1, polity: null, turns: 3 });
  assert.equal(tooFew.turnsLeft, 10, '低于 10 抬到 10');

  const fallback = store.create({ difficulty: 1, polity: null });
  assert.equal(fallback.turnsLeft, 50, '缺省用服务端默认');
});
