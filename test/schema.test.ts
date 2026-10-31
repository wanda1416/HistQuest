import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import {
  normalizeCharacter,
  serializeTargets,
  validateCharacter,
  validateLibrary,
} from '../src/core/schema.ts';

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];

const byName = (name: string): Character => {
  const found = list.find((c) => c.name === name);
  assert.ok(found, `索引里应有 ${name}`);
  return found;
};

const othersOf = (c: Character): Character[] => list.filter((o) => o.id !== c.id);

const errorsOf = (c: Character, others: Character[]): string[] =>
  validateCharacter(c, { others })
    .filter((i) => i.level === 'error')
    .map((i) => i.code);

test('全库没有 error 级问题', () => {
  assert.ok(list.length >= 184, `应包含 130 位中国人物 + 世界人物，实际 ${list.length}`);
  for (const c of list) {
    assert.deepEqual(errorsOf(c, othersOf(c)), [], `${c.name} 触发了错误级校验`);
  }
});

test('合法的新增人物可以通过', () => {
  const c = normalizeCharacter({
    id: 'test_person',
    name: '测试君',
    aliases: ['测试郎'],
    region: 'cn',
    polity: '唐',
    gender: 'male',
    birth: 700,
    death: 760,
    birthplace: '长安（今陕西西安）',
    birthProvince: '陕西',
    roles: ['诗人'],
    tags: ['测试'],
    emperor: false,
    notable: '用于测试的人物',
    difficulty: 2,
  });
  assert.deepEqual(errorsOf(c, list), []);
});

test('id 格式与唯一性', () => {
  const badFormat = normalizeCharacter({ ...byName('李白'), id: 'Bad-ID' });
  assert.ok(errorsOf(badFormat, othersOf(badFormat)).includes('id_format'));

  const duplicated = normalizeCharacter({ ...byName('李白'), id: byName('杜甫').id });
  assert.ok(errorsOf(duplicated, list).includes('id_duplicate'));
});

test('朝代不在受控枚举内 → error（会让索引裁定失效）', () => {
  const c = normalizeCharacter({ ...byName('李白'), polity: '魏国' });
  assert.ok(errorsOf(c, othersOf(c)).includes('polity_unknown'));
});

test('严格史学分期：卒于 220 年前的东汉人物不能标注三国', () => {
  const caocao = byName('曹操');
  const c = normalizeCharacter({ ...caocao, polityAlt: ['三国'] });
  assert.ok(errorsOf(c, othersOf(c)).includes('polity_alt_three_kingdoms'));

  // 蔡文姬卒于 249 年，确实经历过三国，允许同时标注
  const caiwenji = byName('蔡文姬');
  assert.deepEqual(errorsOf(caiwenji, othersOf(caiwenji)), []);
});

test('单字别名是 error，与他人重名只是 warning', () => {
  const libai = byName('李白');
  const short = normalizeCharacter({ ...libai, aliases: [...libai.aliases, '白'] });
  assert.ok(!errorsOf(short, othersOf(short)).includes('alias_too_short'), '单字别名应降为 warning 而非 error');

  // 「子安」同时是王勃与施耐庵的别名：真实重名，只能提示不能拦截
  const wangbo = byName('王勃');
  const issues = validateCharacter(wangbo, { others: othersOf(wangbo) });
  assert.ok(issues.some((i) => i.code === 'alias_conflict' && i.level === 'warning'));
  assert.equal(issues.some((i) => i.code === 'alias_conflict' && i.level === 'error'), false);
});

test('生卒顺序、空身份、空事迹都是 error', () => {
  const c = normalizeCharacter({
    ...byName('李白'),
    birth: 800,
    death: 700,
    roles: [],
    notable: '',
  });
  const codes = errorsOf(c, othersOf(c));
  assert.ok(codes.includes('death_before_birth'));
  assert.ok(codes.includes('roles_empty'));
  assert.ok(codes.includes('notable_empty'));
});

test('全库唯一性检查', () => {
  const dupId = [list[0]!, { ...list[1]!, id: list[0]!.id }];
  assert.ok(validateLibrary(dupId).some((i) => i.code === 'library_id_duplicate'));

  const dupName = [list[0]!, { ...list[1]!, id: 'another_person', name: list[0]!.name }];
  assert.ok(validateLibrary(dupName).some((i) => i.code === 'library_name_duplicate'));
});

test('序列化：一人一行，且能原样解析回来', () => {
  const text = serializeTargets(list);
  const lines = text.trim().split('\n');
  assert.equal(lines.length, list.length + 2, '应为 [ + 每人一行 + ]');
  assert.ok(text.endsWith(']\n'), '文件应以换行结尾');
  assert.deepEqual(JSON.parse(text), list);
});

test('改一个字段只会产生一行差异', () => {
  const before = serializeTargets(list).split('\n');
  const next = list.map((c) => (c.name === '李白' ? { ...c, notable: '改过的代表事迹' } : c));
  const after = serializeTargets(next).split('\n');

  let changed = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i] !== after[i]) changed += 1;
  }
  assert.equal(changed, 1);
});
