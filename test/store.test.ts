import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQuestion } from '../src/client/store.ts';

test('去重归一化：忽略首尾标点与空白', () => {
  const base = normalizeQuestion('他是唐朝人吗');
  assert.equal(normalizeQuestion('他是唐朝人吗？'), base);
  assert.equal(normalizeQuestion('  他是唐朝人吗。 '), base);
  assert.equal(normalizeQuestion('他是唐朝人吗！'), base);
});

test('去重归一化：不同问题不会被误判为同一条', () => {
  assert.notEqual(normalizeQuestion('他是唐朝人吗'), normalizeQuestion('他是宋朝人吗'));
  assert.notEqual(normalizeQuestion('他当过皇帝吗'), normalizeQuestion('他是皇帝吗'));
});

test('去重归一化：内部空格被折叠', () => {
  assert.equal(normalizeQuestion('他 是 唐朝人 吗'), '他是唐朝人吗');
});

test('空输入不会崩', () => {
  assert.equal(normalizeQuestion(''), '');
  assert.equal(normalizeQuestion('   '), '');
});
