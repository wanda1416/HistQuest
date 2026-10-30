import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { Character } from '../src/shared/domain.ts';
import type { RecordView } from '../src/shared/protocol.ts';
import { formatTranscript, transcriptForGame, transcriptForReview } from '../src/client/format.ts';

const history: RecordView[] = [
  { seq: 1, question: '他是唐朝人吗？', verdict: 'yes', text: '是。' },
  { seq: 2, question: '他当过皇帝吗？', verdict: 'no', text: '不是。' },
  {
    seq: 3,
    question: '他很伟大吗？',
    verdict: 'unknown',
    text: '无法判断，请提问客观事实。',
    hint: '只回答客观事实。',
  },
  {
    seq: 4,
    question: '他是唐朝前还是唐朝后的人物',
    verdict: 'unknown',
    text: '这是「A 还是 B」的选择问句，我只能回答是或否。',
    invalid: 'format',
  },
];

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];
const qingzhao = list.find((c) => c.name === '李清照')!;

test('对局记录：严格的「提问 / 回应」两行格式', () => {
  const text = transcriptForGame(history);
  const lines = text.split('\n');
  assert.equal(lines[0], '提问：他是唐朝人吗？');
  assert.equal(lines[1], '回应：是。');
  assert.equal(lines[2], '');
  assert.equal(lines[3], '提问：他当过皇帝吗？');
  assert.equal(lines[4], '回应：不是。');
});

test('解说口径以「提示：」单列一行', () => {
  const text = transcriptForGame(history);
  assert.ok(text.includes('提示：只回答客观事实。'), text);
});

test('改问法的记录也保留在记录里', () => {
  const text = transcriptForGame(history);
  assert.ok(text.includes('提问：他是唐朝前还是唐朝后的人物'));
  assert.ok(text.includes('回应：这是「A 还是 B」的选择问句'));
});

test('对局中复制绝不能出现答案', () => {
  const text = transcriptForGame(history);
  assert.equal(text.includes('李清照'), false);
  assert.equal(text.includes('北宋'), false);
  assert.equal(text.includes('目标：'), false);
});

test('揭晓后复制带人物卡与用问数', () => {
  const text = transcriptForReview(history, qingzhao, 4);
  assert.ok(text.startsWith('猜历史 · 对局记录'), text);
  assert.ok(text.includes('目标：李清照'), text);
  assert.ok(text.includes('有效提问：4 次'), text);
  // 人物卡之后仍然是严格的问答块
  assert.ok(text.includes('\n\n提问：他是唐朝人吗？\n回应：是。'), text);
});

test('空记录返回空串而不是空白杂质', () => {
  assert.equal(formatTranscript([]), '');
});
