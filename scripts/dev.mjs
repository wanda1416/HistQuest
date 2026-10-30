/**
 * 开发启动器：同时运行 Node 服务端（原生 TS，热重启）与 Vite 客户端（HMR）。
 * 不依赖 concurrently，避免多一个第三方包。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');

const children = [];

function run(label, args) {
  const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${label}] 进程退出，code=${code}`);
    }
  });
  children.push(child);
  return child;
}

run('server', ['--watch', 'src/server/index.ts']);
run('vite', [viteBin]);

function shutdown() {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
