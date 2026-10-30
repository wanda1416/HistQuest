/**
 * 用真实模型探测作答质量：属性归类、判定、是否泄漏姓名、延迟。
 * 用法：node scripts/probe-model.ts [model]
 */
import fs from 'node:fs';
import type { AiCredential, Character } from '../src/shared/domain.ts';
import { CharacterIndex } from '../src/core/index.ts';
import { modelAnswer } from '../src/core/answerer.ts';

const BASE = process.env.HQ_BASE ?? 'http://127.0.0.1:7863/v1';
const KEY = process.env.HQ_KEY ?? 'test_key';
const MODEL = process.argv[2] ?? process.env.HQ_MODEL ?? 'cn:deepseek-v4.1-flash';

const list = JSON.parse(
  fs.readFileSync(new URL('../data/characters.json', import.meta.url), 'utf8'),
) as Character[];
const index = new CharacterIndex(list);
const target = list.find((c) => c.name === '刘邦')!;

const QUESTIONS = [
  '他跟项羽打过仗吗？',
  '他当过亭长吗？',
  '他是平民出身吗？',
  '他统一过全国吗？',
  '他杀过韩信吗？',
  '他是不是很厉害？',
  '他是唐朝人吗？',
  '他生活在唐朝之前吗？',
];

const cred: AiCredential = { kind: 'byok', baseURL: BASE, apiKey: KEY, model: MODEL, temperature: 0 };
const names = [target.name, ...target.aliases];

let total = 0;
console.log(`=== ${MODEL} / 目标：${target.name} ===`);

for (const q of QUESTIONS) {
  const t0 = Date.now();
  try {
    const ans = await modelAnswer(cred, target, index.brief(target), q, { timeoutMs: 30000 });
    const ms = Date.now() - t0;
    total += ms;
    const leak = names.some((n) => ans.text.includes(n)) ? ' ⚠️泄漏姓名' : '';
    console.log(
      `${String(ms).padStart(5)}ms  ${q.padEnd(16)} → ${ans.verdict.padEnd(7)} ${ans.attr}/${String(ans.value)}  「${ans.text}」${leak}`,
    );
  } catch (err) {
    const ms = Date.now() - t0;
    total += ms;
    console.log(`${String(ms).padStart(5)}ms  ${q.padEnd(16)} → 失败：${(err as Error).message}`);
  }
}

console.log(`平均 ${Math.round(total / QUESTIONS.length)}ms`);
