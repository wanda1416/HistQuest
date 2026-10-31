import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import { judgeByIndex, guessMatches, normalizeGuess } from '../src/core/judge.ts';
import { CharacterIndex, dynastyScope, normalizeDynasty } from '../src/core/index.ts';
import { extractDynasty, periodsLived } from '../src/core/dynasty.ts';

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
  assert.equal(qingzhao.polity, '北宋');
  assert.equal(v(qingzhao, 'dynasty', '宋'), 'yes');
  assert.equal(v(qingzhao, 'dynasty', '南宋'), 'yes');
});

test('无法识别的朝代 → unknown，不瞎猜', () => {
  assert.equal(v(libai, 'dynasty', '银河帝国'), 'unknown');
});

test('严格史学分期：曹操算东汉，不算三国', () => {
  const caocao = byName('曹操');
  assert.equal(caocao.polity, '东汉');
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

test('生年不详时回 unknown 而不是否', () => {
  assert.equal(libing.birth, null);
  assert.equal(v(libing, 'birthEra', 'bc'), 'unknown');
});

test('猜测归一化与别名匹配', () => {
  assert.equal(normalizeGuess('我猜是李白吧？'), '李白');
  assert.equal(guessMatches(libai, '李白'), true);
  assert.equal(guessMatches(libai, '李太白'), true);
  assert.equal(guessMatches(libai, '诗仙'), true);
  assert.equal(guessMatches(libai, '杜甫'), false);
});

test('猜名必须严格相等，单字与子串都不算', () => {
  // 之前用包含匹配时，这些输入会被判成猜中
  assert.equal(guessMatches(libai, '白'), false, '单字不能命中李白');
  assert.equal(guessMatches(libai, '李'), false, '姓氏不能命中李白');
  assert.equal(guessMatches(libai, '太白'), false, '别名的一部分也不算');
  assert.equal(guessMatches(libai, '李太'), false);

  const kongzi = byName('孔子');
  assert.equal(guessMatches(kongzi, '子'), false, '单字不能命中孔子');
  assert.equal(guessMatches(kongzi, '孔'), false);

  // 口语修饰仍会被 normalizeGuess 去掉，不影响正常猜中
  assert.equal(guessMatches(libai, '我猜是李白吧'), true);
  assert.equal(guessMatches(libai, '李太白啊'), true);
});

test('索引能按朝代取样', () => {
  const c = index.pick({ polity: '唐', difficulty: 1, rng: () => 0.5 });
  assert.ok(['唐'].includes(c.polity));
});

test('问句朝代提取：不会被公元前里的元误导', () => {
  assert.equal(extractDynasty('他是元朝人吗'), '元');
  assert.equal(extractDynasty('他生在公元前吗'), null);
  assert.equal(extractDynasty('他是唐朝人吗'), '唐');
  assert.equal(extractDynasty('他是北宋人吗'), '北宋');
  assert.equal(extractDynasty('他是三国人物吗'), '三国');
  assert.equal(extractDynasty('他当过皇帝吗'), null);
});

test('跨朝代人物：按生卒年与朝代重叠判定', () => {
  // 蒲松龄 1640 年生于明崇祯年间，四轮对话里被答成"不是明朝人物"，错在这里
  assert.equal(v(byName('蒲松龄'), 'dynasty', '明'), 'yes');
  assert.equal(v(byName('蒲松龄'), 'dynasty', '清'), 'yes');
  assert.equal(v(byName('岳飞'), 'dynasty', '北宋'), 'yes');
  assert.equal(v(byName('朱元璋'), 'dynasty', '元'), 'yes');
  assert.equal(v(byName('鲁迅'), 'dynasty', '清'), 'yes');
  // 曹操卒于 220 年，三国始于同年，仍不算三国
  assert.equal(v(byName('曹操'), 'dynasty', '三国'), 'no');
});

test('数据一致性：朝代标注与生卒年覆盖的时期必须吻合', () => {
  const bad: string[] = [];
  for (const c of list) {
    if (c.region !== 'cn') continue;
    if (c.birth === null || c.death === null) continue;
    const lived = periodsLived(c.birth, c.death);
    const declared = new Set([c.polity, ...(c.polityAlt ?? [])]);
    const missing = lived.filter((d) => !declared.has(d));
    // 多（declared 有 lived 没有的）是文化认同：卒于 220 前的荀彧/庞统等
    // 在文化上是三国人物，era 标注多一个不算错——只报「缺」
    if (missing.length) {
      bad.push(`${c.name} 缺[${missing.join(',')}]`);
    }
  }
  assert.deepEqual(bad, [], bad.join(' | '));
});
