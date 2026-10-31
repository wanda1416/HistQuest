import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { before } from 'node:test';
import { CharacterIndex } from '../src/core/index.ts';
import { answerInstructions, buildAnswerMessages } from '../src/ai/prompts.ts';
import type { Character } from '../src/shared/domain.ts';

/**
 * 谜底类别（人物/事件/物品）验收：
 * 1. 三类种子能合入同一索引，按类别抽题互不串池，mixed 均匀抽
 * 2. 资料卡按类别换字段标签（事件=发生时间/地点；物品=年代/出土地/现藏）
 * 3. 提示词按类别参数化（称谓与代词），人物类保持原文案
 */

const characters = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];
const events = (JSON.parse(
  fs.readFileSync(new URL('../data/events.json', import.meta.url), 'utf8'),
) as Character[]).map((c) => ({ ...c, category: 'event' as const }));
const items = (JSON.parse(
  fs.readFileSync(new URL('../data/items.json', import.meta.url), 'utf8'),
) as Character[]).map((c) => ({ ...c, category: 'item' as const }));

let index: CharacterIndex;

before(() => {
  index = new CharacterIndex([...characters, ...events, ...items]);
});

test('三类种子合入同一索引，类别计数正确', () => {
  const counts = index.categoryCounts();
  assert.equal(counts.character, characters.length);
  assert.ok(counts.event >= 40, `事件至少 40 条，实际 ${counts.event}`);
  assert.ok(counts.item >= 40, `物品至少 40 条，实际 ${counts.item}`);
});

test('按类别抽题不串池', () => {
  for (let i = 0; i < 20; i++) {
    const e = index.pick({ category: 'event', rng: () => (i + 0.5) / 20 });
    assert.equal(e.category, 'event');
    const it = index.pick({ category: 'item', rng: () => (i + 0.5) / 20 });
    assert.equal(it.category, 'item');
    const c = index.pick({ category: 'character', rng: () => (i + 0.5) / 20 });
    assert.equal(c.category ?? 'character', 'character');
  }
});

test('mixed 抽题会覆盖多个类别', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 60; i++) {
    const t = index.pick({ category: 'mixed', rng: () => i / 60 });
    seen.add(t.category ?? 'character');
  }
  assert.ok(seen.has('event') && seen.has('item'), `mixed 应能抽到事件与物品，实际 ${[...seen].join(',')}`);
});

test('事件资料卡用事件字段标签', () => {
  const ev = index.pick({ category: 'event', rng: () => 0.1 });
  const brief = index.brief(ev);
  assert.match(brief, /^名称：/);
  assert.match(brief, /时期：/);
  assert.match(brief, /经过与结果：/);
  assert.doesNotMatch(brief, /性别：|生卒：|籍贯：/);
});

test('物品资料卡用物品字段标签', () => {
  const it = index.pick({ category: 'item', rng: () => 0.2 });
  const brief = index.brief(it);
  assert.match(brief, /^名称：/);
  assert.match(brief, /制造年代：/);
  assert.match(brief, /简介：/);
  assert.doesNotMatch(brief, /性别：|事迹：/);
});

test('提示词按类别参数化', () => {
  const character = answerInstructions('character');
  const event = answerInstructions('event');
  const item = answerInstructions('item');

  assert.match(character, /猜一位历史人物/);
  assert.match(event, /猜一个历史事件/);
  assert.match(item, /猜一件历史物品/);
  assert.match(event, /用"它"指代/);
  assert.match(item, /用"它"指代/);
  // 事件/物品的例句要贴合类别
  assert.match(event, /赤壁之战/);
  assert.match(item, /司母戊鼎|清明上河图/);
  // 人物类保持他/她
  assert.match(character, /他\/她/);

  // buildAnswerMessages 把类别指令放进消息
  const messages = buildAnswerMessages('PROFILE-TEXT', '它是赤壁之战吗', 'event');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!.content, /猜一个历史事件/);
  assert.match(messages[0]!.content, /PROFILE-TEXT/);
});

test('事件也能走朝代确定性裁定（polity 语义通用）', async () => {
  const { judgeByIndex } = await import('../src/core/judge.ts');
  const chibi = events.find((e) => e.name === '赤壁之战')!;
  const outcome = judgeByIndex(chibi, { attr: 'dynasty', value: '东汉' });
  assert.equal(outcome.verdict, 'yes', '赤壁之战（东汉）问「发生在汉朝吗」应裁定为是');
  const outcome2 = judgeByIndex(chibi, { attr: 'dynasty', value: '唐' });
  assert.equal(outcome2.verdict, 'no');
});
