/**
 * 测试入口：显式收集 test/*.test.ts 再交给 node --test。
 * 避免依赖 shell 通配（Windows 下 npm 用 cmd，不会展开 *），也避免误跑 fixtures。
 */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const testDir = path.join(root, 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => path.join('test', f));

const child = spawn(process.execPath, ['--test', ...files], {
  cwd: root,
  stdio: 'inherit',
});

child.on('exit', (code) => process.exit(code ?? 0));
