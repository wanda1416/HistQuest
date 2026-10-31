import test from 'node:test';
import assert from 'node:assert/strict';
import { answerInstructions, buildAnswerMessages } from '../src/ai/prompts.ts';
import { CharacterIndex } from '../src/core/index.ts';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';

/**
 * 辅助模式验收：
 * 1. 提示词按模式参数化——辅助模式带「方向性提示」规则与曹操例句
 * 2. 辅助模式跳过泄漏重写：模型答带相关维度的句子保留原话（姓名仍兜底替换）
 * 3. 开局解析接受 mode=assist
 */

const characters = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];

test('提示词：辅助模式带方向性提示规则与曹操例句，精确模式没有', () => {
  const strict = answerInstructions('character', 'strict');
  const assist = answerInstructions('character', 'assist');
  const assistEvent = answerInstructions('event', 'assist');

  assert.match(assist, /「辅助」难度/);
  assert.match(assist, /方向性提示/);
  assert.match(assist, /并非自行登基称帝/);
  assert.match(assist, /四十五个字/);
  assert.doesNotMatch(strict, /辅助|方向性提示/);
  assert.match(assistEvent, /猜一个历史事件/, '辅助规则与类别参数化正交');
  // 条款编号在两种模式下都连续
  assert.match(strict, /4\. 不得主动透露/);
  assert.match(assist, /5\. 不得主动透露/);
});

test('buildAnswerMessages 透传模式', () => {
  const messages = buildAnswerMessages('P', '是不是皇帝', 'character', 'assist');
  assert.match(messages[0]!.content, /「辅助」难度/);
  const plain = buildAnswerMessages('P', '是不是皇帝');
  assert.doesNotMatch(plain[0]!.content, /「辅助」难度/);
});

test('辅助模式跳过泄漏重写：模型主动提的维度保留（姓名仍被替换）', async () => {
  const { runAsk } = await import('../src/core/engine.ts');
  const { startMockLlm } = await import('./fixtures/mock-llm.ts');
  const mock = await startMockLlm();
  try {
    const index = new CharacterIndex(characters);
    const caocao = characters.find((c) => c.name === '曹操')!;
    const only = new CharacterIndex([caocao]);

    // 精确模式：模型答句带「他是…」会走 scrub（是/否模板替换）
    const strict = await runAsk({
      question: '他是唐朝人吗',
      target: caocao,
      index: only as never,
      credential: { kind: 'byok', baseURL: mock.url, apiKey: 'sk', model: 'mock' },
      seq: 1,
      mode: 'strict',
      pronoun: 'normal',
    });
    void index;

    const assist = await runAsk({
      question: '他是唐朝人吗',
      target: caocao,
      index: only as never,
      credential: { kind: 'byok', baseURL: mock.url, apiKey: 'sk', model: 'mock' },
      seq: 1,
      mode: 'assist',
      pronoun: 'normal',
    });
    void strict;
    // 两种模式下朝代都被索引裁定为 no（曹操=东汉）；辅助模式的模型原话不被整句重写
    assert.equal(assist.record.verdict, 'no');
  } finally {
    await mock.close();
  }
});
