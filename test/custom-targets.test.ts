import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/server/db.ts';
import { createCustomTargetStore } from '../src/server/custom-targets.ts';
import { newGlobalCustomId as newGlobalId, customToCharacter as toCharacter } from '../src/shared/custom-targets.ts';
import { createChallengeService } from '../src/server/challenges.ts';
import { validateCharacter } from '../src/core/schema.ts';
import type { CustomTarget } from '../src/server/custom-targets.ts';

function makeStore() {
  const db = openDatabase({ file: ':memory:' });
  const store = createCustomTargetStore(db);
  return { db, store };
}

const base = {
  category: 'character' as const,
  name: '岳飞',
  aliases: ['岳武穆', '岳鹏举'],
  summary: '南宋抗金名将，率岳家军屡破金军，后被秦桧以「莫须有」罪名害死于风波亭，追谥武穆。',
  region: 'cn' as const,
  polity: '南宋',
  worldEra: null,
  gender: 'male',
  birth: 1104,
  death: 1142,
  birthplace: '相州汤阴',
  difficulty: 2,
};

function makeTarget(userId: string, overrides: Partial<CustomTarget> = {}): CustomTarget {
  const now = Date.now();
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    userId,
    ...base,
    status: 'draft',
    reviewNote: null,
    globalId: null,
    shareCode: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

test('自定义题库：CRUD 全流程', () => {
  const { store } = makeStore();
  const t = makeTarget('u1');
  store.insert(t);

  // 用户自己的列表可见
  assert.equal(store.listByUser('u1').length, 1);
  assert.equal(store.listByUser('u2').length, 0);

  // 别名 JSON 往返
  assert.deepEqual(store.get(t.id, 'u1')!.aliases, ['岳武穆', '岳鹏举']);

  // 只有草稿可编辑，且只能改本人的
  store.updateDraft(t.id, 'u2', { ...base, name: '改名' });
  assert.equal(store.get(t.id, 'u1')!.name, '岳飞');
  store.updateDraft(t.id, 'u1', { ...base, name: '岳飞（改）' });
  assert.equal(store.get(t.id, 'u1')!.name, '岳飞（改）');

  // 提交后不可再编辑、不可删除
  store.setStatus(t.id, 'u1', 'submitted');
  store.updateDraft(t.id, 'u1', { ...base, name: '再改' });
  assert.equal(store.get(t.id, 'u1')!.name, '岳飞（改）');
  store.remove(t.id, 'u1');
  assert.notEqual(store.get(t.id, 'u1'), null);
});

test('自定义题库：审核队列与通过/驳回', () => {
  const { store } = makeStore();
  const a = makeTarget('u1');
  const b = makeTarget('u2');
  store.insert(a);
  store.insert(b);
  assert.equal(store.listSubmitted().length, 0);

  store.setStatus(a.id, 'u1', 'submitted');
  store.setStatus(b.id, 'u2', 'submitted');
  assert.deepEqual(store.listSubmitted().map((t) => t.id).sort(), [a.id, b.id].sort());

  // 驳回带意见
  const rejected = store.review(a.id, 'rejected', '描述太短，请补充生平细节');
  assert.equal(rejected!.status, 'rejected');
  assert.equal(rejected!.reviewNote, '描述太短，请补充生平细节');
  assert.equal(store.listSubmitted().length, 1);

  // 只能审 submitted 状态
  assert.equal(store.review(a.id, 'approved', null), null);

  const approved = store.review(b.id, 'approved', null);
  assert.equal(approved!.status, 'approved');
  assert.equal(store.listSubmitted().length, 0);
});

test('自定义题库：校验规则', () => {
  const { store } = makeStore();
  assert.deepEqual(store.validate(base), []);

  const errs = store.validate({ ...base, name: '短', summary: '太短', difficulty: 9, category: 'movie' as never, region: 'cn', polity: '' });
  assert.ok(errs.some((e) => e.includes('名称')));
  assert.ok(errs.some((e) => e.includes('描述')));
  assert.ok(errs.some((e) => e.includes('难度')));
  assert.ok(errs.some((e) => e.includes('类别')));
  assert.ok(errs.some((e) => e.includes('朝代')));

  // 事件必须带年份；人物必须选性别
  assert.ok(store.validate({ ...base, category: 'event', birth: null }).some((e) => e.includes('发生年份')));
  assert.ok(store.validate({ ...base, gender: '' }).some((e) => e.includes('性别')));
  assert.ok(store.validate({ ...base, birth: 926, death: 885 }).some((e) => e.includes('卒年')));
});

test('自定义题库：出题（挑战链接）', () => {
  const { store } = makeStore();
  const t = makeTarget('u1');
  store.insert(t);

  // 草稿生成挑战码 → 状态变为 shared
  const code = store.createChallengeCode(t.id, 'u1');
  assert.ok(code, '应生成挑战码');
  assert.equal(code!.length, 6);
  const shared = store.get(t.id, 'u1')!;
  assert.equal(shared.status, 'shared');
  assert.equal(shared.shareCode, code);

  // 幂等：重复出题返回原码
  assert.equal(store.createChallengeCode(t.id, 'u1'), code);

  // shared 不可编辑、不可删除、不可再提交
  store.updateDraft(t.id, 'u1', { ...base, name: '改名' });
  assert.equal(store.get(t.id, 'u1')!.name, '岳飞');
  store.remove(t.id, 'u1');
  assert.notEqual(store.get(t.id, 'u1'), null);

  // 按 code 查询：复制入全局前（global_id 未写）不可开局；不存在的码查不到
  assert.equal(store.getByCode(code!), null);
  assert.equal(store.getByCode('ZZZZZZ'), null);

  // 模拟审核通过写 global_id 后，getByCode 才能给出开局用的全局 id
  store.setGlobalId(t.id, 'custom-abc12345');
  const resolved = store.getByCode(code!);
  assert.equal(resolved!.globalId, 'custom-abc12345');

  // 其他用户的草稿出不了题
  const other = makeTarget('u2');
  store.insert(other);
  assert.equal(store.createChallengeCode(other.id, 'u1'), null);
});

test('挑战服务：登记 / 解析 / 出题人额度扣减', () => {
  const db = openDatabase({ file: ':memory:' });
  const challenges = createChallengeService(db);
  // 造一个出题人（默认 allow_server_key=1、每日额度 -1）
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, allow_server_key, banned, asks_today, quota_day, daily_quota, created_at, updated_at) VALUES ('u9','出题人','x','user',1,0,0,0,-1,?,?)",
  ).run(Date.now(), Date.now());

  const code = challenges.registerRandom('u9', { difficulty: 2, category: 'mixed' });
  assert.equal(code.length, 6);

  const resolved = challenges.resolve(code);
  assert.equal(resolved!.creatorId, 'u9');
  assert.equal(resolved!.creatorName, '出题人');
  assert.equal(resolved!.globalId, null);
  assert.equal(resolved!.settings.category, 'mixed');
  assert.equal(challenges.resolve('ZZZZZZ'), null);

  assert.equal(challenges.quotaOk(code), true);
  assert.deepEqual(challenges.chargeAsk(code), { ok: true });

  // 管理员放出的链接同样扣管理员额度（自己开玩才豁免）
  db.prepare("UPDATE users SET role = 'admin' WHERE id = 'u9'").run();
  assert.equal(challenges.quotaOk(code), true);
  assert.deepEqual(challenges.chargeAsk(code), { ok: true });
  const after = db.prepare('SELECT asks_today FROM users WHERE id = ?').get('u9') as unknown as { asks_today: number };
  assert.equal(after.asks_today, 2, '管理员的挑战链接也要扣管理员额度');

  // mine：带出被玩局数
  const mine = challenges.mine('u9');
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.mode, 'random');
  assert.equal(mine[0]!.plays, 0);
});

test('挑战服务：额度用完显示截止', () => {
  const db = openDatabase({ file: ':memory:' });
  const challenges = createChallengeService(db);
  db.prepare(
    "INSERT INTO users (id, username, password_hash, role, allow_server_key, banned, asks_today, quota_day, daily_quota, created_at, updated_at) VALUES ('u9','出题人','x','user',1,0,0,0,2,?,?)",
  ).run(Date.now(), Date.now());
  const code = challenges.registerRandom('u9', { difficulty: 1, category: 'character' });
  assert.deepEqual(challenges.chargeAsk(code), { ok: true });
  assert.deepEqual(challenges.chargeAsk(code), { ok: true });
  const third = challenges.chargeAsk(code)!;
  assert.equal(third.ok, false);
  assert.match(third.message ?? '', /截止|额度/);
  assert.equal(challenges.quotaOk(code), false);
});


test('自定义题库：审核通过后可复制为合法全局条目', () => {

  const { store } = makeStore();
  const t = makeTarget('u1');
  store.insert(t);
  store.setStatus(t.id, 'u1', 'submitted');
  const current = store.getById(t.id)!;

  const character = toCharacter(current, newGlobalId());
  assert.ok(character.id.startsWith('custom-'));
  assert.equal(character.notable, current.summary);
  assert.ok(character.roles.length > 0);

  // 生成的全局条目必须能过 validateCharacter（others = 空库）
  const issues = validateCharacter(character, { others: [] });
  const errors = issues.filter((i) => i.level === 'error');
  assert.deepEqual(errors, []);
});
