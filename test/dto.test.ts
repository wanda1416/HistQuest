import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { SoloStore } from '../src/server/solo.ts';
import {
  containsCharacterName,
  findForbiddenKeys,
  forbidden,
  projectRecord,
  projectSession,
} from '../src/server/dto.ts';

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];
const index = new CharacterIndex(list);
const libai = list.find((c) => c.name === '李白')!;

test('验收2：会话 DTO 不含任何答案字段', () => {
  const store = new SoloStore(index, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  const view = projectSession(s);

  assert.deepEqual(findForbiddenKeys(view), []);
  for (const key of ['targetId', 'target', 'apiKey', 'name', 'aliases', 'notable']) {
    assert.equal(key in view, false, `不应包含 ${key}`);
  }
});

test('会话 DTO 里不出现目标人物的姓名或别名', async () => {
  const store = new SoloStore(index, { turns: 20, file: null });
  const s = store.create({ difficulty: 1, polity: null });
  const view = projectSession(s);
  assert.equal(containsCharacterName(view, index.get(s.targetId)!), false);
});

test('回答记录投影会剥掉 basis / calls / query', () => {
  const record = {
    seq: 1,
    question: '他是唐朝人吗',
    query: { attr: 'dynasty' as const, value: '唐' },
    verdict: 'yes' as const,
    text: '是。',
    basis: 'index.dynasty' as const,
    calls: 1,
    ms: 12,
  };
  const view = projectRecord(record);
  assert.deepEqual(Object.keys(view).sort(), ['question', 'seq', 'text', 'verdict']);
});

test('揭晓允许出现姓名，但仍不允许出现 targetId 与 basis', () => {
  const payload = {
    character: libai,
    status: 'revealed',
    turnsUsed: 3,
    history: [{ seq: 1, question: 'q', verdict: 'yes', text: '是。' }],
  };
  assert.deepEqual(findForbiddenKeys(payload, forbidden.reveal), []);
});
