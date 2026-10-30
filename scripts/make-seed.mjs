#!/usr/bin/env node
// 生成 workers/seed.ts：把 data/characters.json 内联成 Worker 可打包的模块。
// 部署后首次请求时导入 D1（people 库此后以 D1 为准，本地 JSON 不再参与线上逻辑）。
import fs from 'node:fs';

const list = JSON.parse(fs.readFileSync('data/characters.json', 'utf8'));
const out = `// 自动生成：npm run build:workers 时刷新。勿手改。
import type { Character } from '../src/shared/domain.ts';

export const SEED_CHARACTERS: Character[] = ${JSON.stringify(list)};
`;
fs.writeFileSync('workers/seed.ts', out);
console.log(`workers/seed.ts: ${list.length} characters`);
