import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import { leaksProfile, neutralizePronoun } from '../src/core/scrub.ts';

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];
const byName = (n: string): Character => list.find((c) => c.name === n)!;

const qingzhao = byName('李清照');

test('越界：回答里出现人物朝代即视为泄漏', () => {
  // 真实事故：问"是唐朝之前吗"，模型答"不是，她是北宋至南宋时期的人物"
  assert.equal(leaksProfile('不是，她是北宋至南宋时期的人物。', qingzhao), true);
  assert.equal(leaksProfile('不是，她生活在北宋。', qingzhao), true);
});

test('越界：出现身份、籍贯、生卒年、姓名也算泄漏', () => {
  assert.equal(leaksProfile('他是一位词人。', qingzhao), true);
  assert.equal(leaksProfile('他生于1084年。', qingzhao), true);
  assert.equal(leaksProfile('他写过《声声慢》。', qingzhao), false, '作品名不算 —— 问作品时就该提到');
});

test('不越界：回答只谈被问的那件事', () => {
  const liubang = byName('刘邦');
  assert.equal(leaksProfile('不是，他没有这段经历。', liubang), false);
  assert.equal(leaksProfile('是，他与项羽长期交战并最终取胜。', liubang), false);
});

test('单字朝代必须带"朝/代"，避免误伤常用字', () => {
  const zhuxi = byName('朱熹'); // 南宋
  assert.equal(leaksProfile('他明白了这个道理。', zhuxi), false, '"明白"不是朝代');
  assert.equal(leaksProfile('他生活在南宋。', zhuxi), true);
});

test('性别词中性化', () => {
  assert.equal(neutralizePronoun('是的，她确实做过。', 'neutral'), '是的，TA确实做过。');
  assert.equal(neutralizePronoun('他们都是他的学生。', 'neutral'), 'TA们都是TA的学生。');
  assert.equal(neutralizePronoun('她还是老样子。', 'normal'), '她还是老样子。');
});

test('泛称也算泄漏：说"宋朝"同样暴露朝代', () => {
  assert.equal(leaksProfile('不是，她生活在宋朝，晚于唐朝。', qingzhao), true);
  const liubang = byName('刘邦');
  assert.equal(leaksProfile('他是汉朝的开国皇帝。', liubang), true);
});
