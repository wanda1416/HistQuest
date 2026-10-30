import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { judgeByIndex } from '../src/core/judge.ts';

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];

const index = new CharacterIndex(list);
const byName = (name: string): Character => {
  const found = list.find((c) => c.name === name);
  assert.ok(found, `索引里应有 ${name}`);
  return found;
};

test('世界人物已入库，且覆盖多个文明圈', () => {
  const world = list.filter((c) => c.region !== 'cn');
  assert.ok(world.length >= 50, `世界人物应不少于 50，实际 ${world.length}`);

  const regions = new Set(world.map((c) => c.region));
  for (const region of ['europe', 'west-asia', 'south-asia', 'east-asia', 'americas', 'africa']) {
    assert.ok(regions.has(region as Character['region']), `缺少 ${region} 的人物`);
  }
});

test('世界人物都划分了时期，且时期数量与中国朝代相当', () => {
  const world = list.filter((c) => c.region !== 'cn');
  assert.ok(world.every((c) => c.worldEra), '每个世界人物都应有 worldEra');

  const eras = new Set(world.map((c) => c.worldEra));
  assert.ok(eras.size >= 15, `时期数量应与中国朝代相当，实际 ${eras.size}`);
});

  test('中国人物不带世界时期', () => {
  assert.ok(list.filter((c) => c.region === 'cn').every((c) => !c.worldEra));
  });

  test('单选世界时可按时期精确筛选', () => {
  for (let i = 0; i < 10; i++) {
    assert.equal(index.pick({ worldEra: '古希腊' }).worldEra, '古希腊');
    assert.equal(index.pick({ worldEra: '19 世纪下半叶', cnShare: 1 }).worldEra, '19 世纪下半叶');
  }
  });

  test('中国人物保留朝代枚举，世界人物使用政权名', () => {
  assert.equal(byName('李白').polity, '唐');
  assert.equal(byName('凯撒').polity, '罗马共和国');
  assert.equal(byName('凯撒').country, '意大利');
  assert.equal(byName('华盛顿').polity, '美国');
});

test('抽样：cnShare=1 只出中国人物，cnShare=0 只出世界人物', () => {
  for (let i = 0; i < 30; i++) {
    assert.equal(index.pick({ cnShare: 1 }).region, 'cn');
    assert.notEqual(index.pick({ cnShare: 0 }).region, 'cn');
  }
});

test('抽样：cnShare=0.5 时中国人物大致占一半', () => {
  const rounds = 400;
  let cn = 0;
  for (let i = 0; i < rounds; i++) {
    if (index.pick({ cnShare: 0.5 }).region === 'cn') cn += 1;
  }
  assert.ok(cn > rounds * 0.35 && cn < rounds * 0.65, `中国占比 ${cn}/${rounds} 偏离 50% 太远`);
});

test('抽样：指定政权或文明圈时忽略占比', () => {
  for (let i = 0; i < 20; i++) {
    assert.equal(index.pick({ polity: '唐', cnShare: 0 }).polity, '唐');
    assert.equal(index.pick({ region: 'europe', cnShare: 1 }).region, 'europe');
  }
});

test('世纪判定：覆盖生卒年区间即算经历过', () => {
  const napoleon = byName('拿破仑');
  assert.equal(judgeByIndex(napoleon, { attr: 'century', value: 18 }).verdict, 'yes');
  assert.equal(judgeByIndex(napoleon, { attr: 'century', value: 19 }).verdict, 'yes');
  assert.equal(judgeByIndex(napoleon, { attr: 'century', value: 17 }).verdict, 'no');

  const archimedes = byName('阿基米德');
  assert.equal(judgeByIndex(archimedes, { attr: 'century', value: -3 }).verdict, 'yes');
  assert.equal(judgeByIndex(archimedes, { attr: 'century', value: -2 }).verdict, 'no');
});

test('非中国朝代不做硬裁定，交给模型', () => {
  const caesar = byName('凯撒');
  const outcome = judgeByIndex(caesar, { attr: 'dynasty', value: '罗马共和国' });
  assert.equal(outcome.verdict, 'unknown');
});

test('国籍判定按文明圈，而不是恒定为中国', () => {
  assert.equal(judgeByIndex(byName('李白'), { attr: 'nationality', value: true }).verdict, 'yes');
  assert.equal(judgeByIndex(byName('牛顿'), { attr: 'nationality', value: true }).verdict, 'no');
  assert.equal(judgeByIndex(byName('牛顿'), { attr: 'nationality', value: false }).verdict, 'yes');
});
