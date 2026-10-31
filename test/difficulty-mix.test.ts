import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { DIFFICULTY_MIX } from '../src/core/index.ts';

/**
 * 难度配比抽样验收：
 * 选 N 难度不是"只抽 N 难度"，而是按 DIFFICULTY_MIX 的权重在 1..N 各档间
 * 加权抽样（入门/进阶/考据 = 保底/适中/偏难），题目难度才不会两极分化。
 * 某一档缺失时，其权重按比例摊给剩余档。
 */

const list: Character[] = [];
// 每档 100 条，共 300：分布足够让统计断言稳定
for (let d = 1; d <= 3; d++) {
  for (let i = 0; i < 100; i++) {
    list.push({
      id: `d${d}_${i}`,
      name: `难度${d}条目${i}`,
      aliases: [],
      region: 'cn',
      polity: '唐',
      gender: 'male',
      birth: 700,
      death: 800,
      birthplace: null,
      birthProvince: null,
      roles: ['测试'],
      tags: [],
      emperor: false,
      notable: '',
      difficulty: d,
    });
  }
}
const index = new CharacterIndex(list);

/** 可重复的伪随机（mulberry32）：确定性但覆盖整个 [0,1) 区间 */
function seededRng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('配比表：入门只抽入门；进阶 4:6；考据 2:3:5', () => {
  assert.deepEqual(DIFFICULTY_MIX[1], { 1: 10 });
  assert.deepEqual(DIFFICULTY_MIX[2], { 1: 4, 2: 6 });
  assert.deepEqual(DIFFICULTY_MIX[3], { 1: 2, 3: 5, 2: 3 });
});

test('抽样分布符合配比（2000 次大样本）', () => {
  const N = 2000;
  const tally = (difficulty: number): Record<number, number> => {
    const count: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    const rng = seededRng(42 + difficulty * 1000); // 每个 difficulty 一条独立序列，循环内持续推进
    for (let i = 0; i < N; i++) {
      const c = index.pick({ difficulty, rng });
      count[c.difficulty] = (count[c.difficulty] ?? 0) + 1;
    }
    return count;
  };

  const d1 = tally(1);
  assert.equal(d1[1], N, '选入门 → 全部是入门');

  const d2 = tally(2);
  const p2 = d2[2] / N;
  assert.ok(p2 > 0.52 && p2 < 0.68, `选进阶 → 进阶约占 60%（实际 ${(p2 * 100).toFixed(1)}%）`);
  assert.ok(d2[3] === 0, '选进阶 → 不应出现考据');

  const d3 = tally(3);
  const p31 = d3[1] / N;
  const p32 = d3[2] / N;
  const p33 = d3[3] / N;
  assert.ok(p31 > 0.12 && p31 < 0.28, `考据 → 入门约 20%（实际 ${(p31 * 100).toFixed(1)}%）`);
  assert.ok(p32 > 0.24 && p32 < 0.36, `考据 → 进阶约 30%（实际 ${(p32 * 100).toFixed(1)}%）`);
  assert.ok(p33 > 0.44 && p33 < 0.56, `考据 → 考据约 50%（实际 ${(p33 * 100).toFixed(1)}%）`);
});

test('缺档回退：池中只有入门时，选考据也抽入门（权重摊给剩余档）', () => {
  const onlyEasy = new CharacterIndex(list.filter((c) => c.difficulty === 1));
  const seen = new Set<number>();
  for (let i = 0; i < 200; i++) {
    const c = onlyEasy.pick({ difficulty: 3, rng: () => Math.random() });
    seen.add(c.difficulty);
  }
  assert.deepEqual([...seen], [1], '缺失档权重摊给入门 → 只抽到入门');
});

test('完全空池返回不崩溃（由 pick 的全量兜底处理）', () => {
  // pick 在 pool 空时会兜底 this.list，这里验证不抛异常
  const c = index.pick({ difficulty: 3, polity: '不存在朝代' });
  assert.ok(c, '应从全量池兜底返回一条');
});
