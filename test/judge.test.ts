import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import { judgeByIndex, guessMatches, normalizeGuess } from '../src/core/judge.ts';
import { CharacterIndex, dynastyScope, normalizeDynasty } from '../src/core/index.ts';
import { extractDynasty } from '../src/core/dynasty.ts';

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];

const index = new CharacterIndex(list);
const byName = (name: string): Character => {
  const c = list.find((x) => x.name === name);
  assert.ok(c, `索引里应该有 ${name}`);
  return c;
};

const libai = byName('李白');
const qingzhao = byName('李清照');
const libing = byName('李冰');

const v = (c: Character, attr: string, value: unknown, op?: string) =>
  judgeByIndex(c, { attr: attr as never, value: value as never, op: op as never }).verdict;

test('朝代归一：唐朝/唐代/唐 视为同义', () => {
  assert.equal(normalizeDynasty('唐朝'), '唐');
  assert.equal(normalizeDynasty('唐代'), '唐');
  assert.equal(normalizeDynasty('唐'), '唐');
  assert.equal(normalizeDynasty('三国时期'), '三国');
});

test('朝代分组：宋覆盖北宋与南宋', () => {
  assert.deepEqual(dynastyScope('宋'), ['北宋', '南宋']);
  assert.deepEqual(dynastyScope('汉'), ['西汉', '东汉']);
});

test('验收3：问"他是唐朝人吗"与索引一致', () => {
  assert.equal(v(libai, 'dynasty', '唐'), 'yes');
  assert.equal(v(libai, 'dynasty', '唐代'), 'yes');
  assert.equal(v(libai, 'dynasty', '宋'), 'no');
});

test('朝代：北宋人物答"宋朝"应为是', () => {
  assert.equal(qingzhao.dynasty, '北宋');
  assert.equal(v(qingzhao, 'dynasty', '宋'), 'yes');
  assert.equal(v(qingzhao, 'dynasty', '南宋'), 'yes');
});

test('无法识别的朝代 → unknown，不瞎猜', () => {
  assert.equal(v(libai, 'dynasty', '银河帝国'), 'unknown');
});

test('严格史学分期：曹操算东汉，不算三国', () => {
  const caocao = byName('曹操');
  assert.equal(caocao.dynasty, '东汉');
  assert.equal(v(caocao, 'dynasty', '三国'), 'no');
  assert.equal(v(caocao, 'dynasty', '东汉'), 'yes');
  assert.equal(v(caocao, 'dynasty', '汉'), 'yes');
  // 关羽卒于 220 年、周瑜卒于 210 年，同样在三国之前
  assert.equal(v(byName('关羽'), 'dynasty', '三国'), 'no');
  assert.equal(v(byName('周瑜'), 'dynasty', '三国'), 'no');
});

test('真正活跃于三国时期的人物仍判为三国', () => {
  assert.equal(v(byName('刘备'), 'dynasty', '三国'), 'yes');
  assert.equal(v(byName('诸葛亮'), 'dynasty', '三国'), 'yes');
  assert.equal(v(byName('司马懿'), 'dynasty', '三国'), 'yes');
});

test('性别判定', () => {
  assert.equal(v(libai, 'gender', 'male'), 'yes');
  assert.equal(v(libai, 'gender', 'female'), 'no');
  assert.equal(v(byName('武则天'), 'gender', 'female'), 'yes');
});

test('是否皇帝', () => {
  assert.equal(v(byName('武则天'), 'emperor', true), 'yes');
  assert.equal(v(libai, 'emperor', true), 'no');
});

test('身份判定：诗人是、将军不是', () => {
  assert.equal(v(libai, 'role', '诗人'), 'yes');
  assert.equal(v(libai, 'role', '将军'), 'no');
  assert.equal(v(byName('关羽'), 'role', '武将'), 'yes');
});

test('籍贯判定', () => {
  assert.equal(v(byName('杜甫'), 'birthplace', '河南'), 'yes');
  assert.equal(v(libai, 'birthplace', '四川'), 'no');
});

test('生年不详时回 unknown 而不是否', () => {
  assert.equal(libing.birth, null);
  assert.equal(v(libing, 'birthEra', 'bc'), 'unknown');
});

test('名字字数 / 含字', () => {
  assert.equal(v(libai, 'nameLength', 2), 'yes');
  assert.equal(v(libai, 'nameLength', 3), 'no');
  assert.equal(v(libai, 'nameContains', '李'), 'yes');
  assert.equal(v(libai, 'nameContains', '杜'), 'no');
});

test('享年判定', () => {
  assert.equal(v(byName('杜甫'), 'lifespan', 50, 'gte'), 'yes');
  assert.equal(v(byName('杜甫'), 'lifespan', 80, 'gte'), 'no');
});

test('在世判定：索引内全为已故', () => {
  assert.equal(v(libai, 'alive', true), 'no');
});

test('事迹判定：收录答是，未收录回 unknown', () => {
  assert.equal(v(libai, 'event', '静夜思'), 'yes');
  assert.equal(v(libai, 'event', '量子力学'), 'unknown');
});

test('时序判定：唐朝之前 / 之后', () => {
  const liubang = byName('刘邦');
  const sushi = byName('苏轼');
  assert.equal(v(liubang, 'eraBefore', '唐'), 'yes');
  assert.equal(v(liubang, 'eraAfter', '唐'), 'no');
  // 李白本人就在唐朝，既不算之前也不算之后
  assert.equal(v(libai, 'eraBefore', '唐'), 'no');
  assert.equal(v(libai, 'eraAfter', '唐'), 'no');
  assert.equal(v(sushi, 'eraBefore', '唐'), 'no');
  assert.equal(v(sushi, 'eraAfter', '唐'), 'yes');
});

test('时序判定：生卒缺失或朝代认不出时回 unknown', () => {
  assert.equal(v(libing, 'eraBefore', '唐'), 'unknown');
  assert.equal(v(libai, 'eraBefore', '银河帝国'), 'unknown');
});

test('猜测归一化与别名匹配', () => {
  assert.equal(normalizeGuess('我猜是李白吧？'), '李白');
  assert.equal(guessMatches(libai, '李太白'), true);
  assert.equal(guessMatches(libai, '诗仙'), true);
  assert.equal(guessMatches(libai, '杜甫'), false);
});

test('索引能按朝代取样', () => {
  const c = index.pick({ dynasty: '唐', difficulty: 1, rng: () => 0.5 });
  assert.ok(['唐'].includes(c.dynasty));
});

test('问句朝代提取：不会被公元前里的元误导', () => {
  assert.equal(extractDynasty('他是元朝人吗'), '元');
  assert.equal(extractDynasty('他生在公元前吗'), null);
  assert.equal(extractDynasty('他是唐朝人吗'), '唐');
  assert.equal(extractDynasty('他是北宋人吗'), '北宋');
  assert.equal(extractDynasty('他是三国人物吗'), '三国');
  assert.equal(extractDynasty('他当过皇帝吗'), null);
});
