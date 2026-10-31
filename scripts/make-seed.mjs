#!/usr/bin/env node
// 生成 workers/seed.ts：把三类题库（人物/事件/物品）内联成 Worker 可打包的模块。
// 部署后首次请求时导入 D1（此后以 D1 为准，本地 JSON 不再参与线上逻辑）。
import fs from 'node:fs';

const characters = JSON.parse(fs.readFileSync('data/characters.json', 'utf8'));
const events = JSON.parse(fs.readFileSync('data/events.json', 'utf8')).map((c) => ({
  ...c,
  category: 'event',
}));
const items = JSON.parse(fs.readFileSync('data/items.json', 'utf8')).map((c) => ({
  ...c,
  category: 'item',
}));
const list = [...characters, ...events, ...items];

const out = `// 自动生成：node scripts/make-seed.mjs。勿手改。
import type { Character } from '../src/shared/domain.ts';

export const SEED_CHARACTERS: Character[] = ${JSON.stringify(list)};
`;
fs.writeFileSync('workers/seed.ts', out);
console.log(
  `workers/seed.ts: ${list.length} 条（人物 ${characters.length} / 事件 ${events.length} / 物品 ${items.length}）`,
);
