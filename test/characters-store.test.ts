import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Character } from '../src/shared/domain.ts';
import { CharacterStore } from '../src/server/characters.ts';

function setup(backupKeep = 20) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-store-'));
  const file = path.join(dir, 'characters.json');
  fs.copyFileSync(new URL('../data/characters.json', import.meta.url), file);
  const backupDir = path.join(dir, 'backups');
  const store = new CharacterStore({ file, backupDir, backupKeep });
  const cleanup = (): void => fs.rmSync(dir, { recursive: true, force: true });
  return { file, backupDir, store, cleanup };
}

const newPerson = {
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
};

test('更新人物：写盘、备份、索引同步', () => {
  const { file, backupDir, store, cleanup } = setup();
  try {
    const libai = store.find('libai');
    assert.ok(libai);

    const result = store.update('libai', { ...libai, notable: '改过的代表事迹' });
    assert.equal(result.ok, true, JSON.stringify(result.issues));

    assert.equal(store.find('libai')!.notable, '改过的代表事迹');
    assert.ok(fs.readFileSync(file, 'utf8').includes('改过的代表事迹'));
    assert.equal(fs.readdirSync(backupDir).length, 1);
    assert.equal(store.total, 184);
  } finally {
    cleanup();
  }
});

test('校验不过的更新不落盘', () => {
  const { file, store, cleanup } = setup();
  try {
    const before = fs.readFileSync(file, 'utf8');
    const libai = store.find('libai')!;
    const result = store.update('libai', { ...libai, roles: [] });

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'roles_empty'));
    assert.equal(fs.readFileSync(file, 'utf8'), before, '文件不应被改写');
  } finally {
    cleanup();
  }
});

test('id 创建后不可修改', () => {
  const { store, cleanup } = setup();
  try {
    const libai = store.find('libai')!;
    const result = store.update('libai', { ...libai, id: 'another_id' });

    assert.equal(result.ok, false);
    assert.ok(result.issues.some((i) => i.code === 'id_immutable'));
    assert.ok(store.find('libai'));
  } finally {
    cleanup();
  }
});

test('新增与软删除：下线后不参与抽样，但仍能揭晓', () => {
  const { store, cleanup } = setup();
  try {
    const created = store.create(newPerson);
    assert.equal(created.ok, true, JSON.stringify(created.issues));
    assert.equal(store.total, 185);
    assert.equal(store.activeCount, 185);
    assert.equal(store.index.get('test_person')!.name, '测试君');

    const retired = store.setRetired('test_person', true);
    assert.equal(retired.ok, true);
    assert.equal(store.total, 185);
    assert.equal(store.activeCount, 184);
    assert.equal(store.index.get('test_person')!.retired, true, 'get 仍能取到，保证在途对局可揭晓');

    const restored = store.setRetired('test_person', false);
    assert.equal(restored.ok, true);
    assert.equal(store.activeCount, 185);
  } finally {
    cleanup();
  }
});

test('备份数量受 backupKeep 限制', () => {
  const { backupDir, store, cleanup } = setup(2);
  try {
    for (let i = 0; i < 4; i++) {
      const libai = store.find('libai')!;
      const result = store.update('libai', { ...libai, notable: `第 ${i} 版` });
      assert.equal(result.ok, true, JSON.stringify(result.issues));
    }
    assert.equal(fs.readdirSync(backupDir).length, 2);
  } finally {
    cleanup();
  }
});

test('导出文本可以解析回当前内存数据', () => {
  const { store, cleanup } = setup();
  try {
    store.create(newPerson);
    const parsed = JSON.parse(store.exportText()) as Character[];
    assert.deepEqual(parsed, store.list());
  } finally {
    cleanup();
  }
});

test('健康报告能发现存量的空朝代与字段缺失', () => {
  const { store, cleanup } = setup();
  try {
    const health = store.health();
    assert.equal(health.total, 184);
    assert.equal(health.active, 184);
    assert.equal(health.retired, 0);
    assert.ok(health.items.every((i) => i.id && i.name));
    assert.ok(Array.isArray(health.matrix) && health.matrix.length > 0);
    // 数据里李冰没有生年、籍贯，应被记为提醒
    assert.ok(health.items.some((i) => i.id === 'libing' && i.code === 'birth_missing'));
  } finally {
    cleanup();
  }
});
