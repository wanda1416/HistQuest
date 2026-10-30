#!/usr/bin/env node
/**
 * 开发启动器：同时运行 Node 服务端（--watch 热重启）与 Vite 客户端（HMR）。
 *
 * 参考 lvjiang 的 dev 脚本结构：
 * 1. 先自检环境（Node 版本、依赖、.env），不合格直接给出修复步骤
 * 2. 服务端端口固定（默认 3000），被占用时直接报错，不隐式换端口
 * 3. 子进程互相看护：任一退出就一起收摊，不留孤儿进程
 * 4. 分级彩色输出，出错信息落在 stderr
 *
 * 用法：
 *   npm run dev                 服务端 + 前端
 *   npm run dev -- --no-vite    只起服务端（调试 API）
 *   npm run dev -- --port 4000  服务端改用 4000
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MIN_NODE = [23, 4];
const DEFAULT_PORT = 3000;

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const info = (msg) => console.log(`${paint(32, '[INFO]')} ${msg}`);
const warn = (msg) => console.log(`${paint(33, '[WARN]')} ${msg}`);
const fail = (msg) => console.error(`${paint(31, '[ERROR]')} ${msg}`);

const HELP = `
猜历史 · 开发启动器

  npm run dev                     服务端 + Vite（HMR）
  npm run dev -- --no-vite        只起服务端
  npm run dev -- --port 4000      服务端改用 4000（默认 3000，不自动顺延）
  npm run dev -- -h               显示本帮助

环境变量：
  PORT              服务端端口，默认 ${DEFAULT_PORT}（不做自动顺延）
  NO_COLOR          设为任意值时关闭彩色输出
`;

function parseArgs(argv) {
  const opts = { noVite: false, port: Number(process.env.PORT) || DEFAULT_PORT, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-vite') opts.noVite = true;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--port') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        fail('--port 需要一个 1–65535 的整数');
        process.exit(2);
      }
      opts.port = value;
    } else if (arg.startsWith('--port=')) {
      const value = Number(arg.slice('--port='.length));
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        fail('--port 需要一个 1–65535 的整数');
        process.exit(2);
      }
      opts.port = value;
    } else {
      warn(`忽略未知参数：${arg}`);
    }
  }
  return opts;
}

function checkNode() {
  const current = process.versions.node.split('.').map(Number);
  const tooOld =
    current[0] < MIN_NODE[0] || (current[0] === MIN_NODE[0] && current[1] < MIN_NODE[1]);

  if (tooOld) {
    fail(`需要 Node.js >= ${MIN_NODE.join('.')}（node:sqlite 免 flag 的最低版本），当前 ${process.version}`);
    fail('修复：');
    fail(`  1. nvm install ${MIN_NODE[0]}`);
    fail(`  2. nvm use ${MIN_NODE[0]}`);
    process.exit(1);
  }
  info(`Node ${process.version}`);
}

function ensureDeps() {
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const expressPkg = path.join(ROOT, 'node_modules', 'express', 'package.json');

  if (fs.existsSync(viteBin) && fs.existsSync(expressPkg)) return viteBin;

  info('未检测到完整依赖，执行 npm install …');
  const result = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    fail('npm install 失败，请检查网络或代理后重试');
    process.exit(1);
  }
  if (!fs.existsSync(viteBin)) {
    fail('依赖安装完成但仍找不到 vite，请删除 node_modules 后重试');
    process.exit(1);
  }
  return viteBin;
}

/** .env 缺失时从示例复制一份，避免首次启动时配置项全是空 */
function ensureEnvFile() {
  const envFile = path.join(ROOT, '.env');
  const example = path.join(ROOT, '.env.example');
  if (fs.existsSync(envFile) || !fs.existsSync(example)) return;
  try {
    fs.copyFileSync(example, envFile);
    info('已从 .env.example 生成 .env（可按需修改）');
  } catch {
    warn('无法创建 .env，将使用默认配置');
  }
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

const children = [];
let stopping = false;

function launch(label, args, extraEnv) {
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  });
  children.push({ label, child });

  child.on('exit', (code, signal) => {
    if (stopping) return;
    const detail = signal ? `signal=${signal}` : `code=${code}`;
    if (code === 0) info(`${label} 正常退出，正在停止其余进程`);
    else fail(`${label} 退出（${detail}），正在停止其余进程`);
    shutdown(code ?? 1);
  });

  child.on('error', (err) => {
    if (stopping) return;
    fail(`${label} 启动失败：${err.message}`);
    shutdown(1);
  });

  return child;
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const { child } of children) {
    if (!child.killed) child.kill();
  }
  // 给子进程一点时间落盘（会话写入、数据库 WAL 收尾）
  setTimeout(() => process.exit(code), 150);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(HELP.trim());
    return;
  }

  checkNode();
  const viteBin = ensureDeps();
  ensureEnvFile();

  if (!(await isPortFree(opts.port))) {
    fail(`端口 ${opts.port} 已被占用，服务端无法启动`);
    fail('处理方式：');
    fail(`  1. 释放端口：netstat -ano | findstr :${opts.port}`);
    fail(`  2. 或换端口：npm run dev -- --port ${opts.port + 1}`);
    process.exit(1);
  }
  const port = opts.port;

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  info(`服务端 http://127.0.0.1:${port}`);
  if (!opts.noVite) {
    info('前端   http://127.0.0.1:5173（端口占用时 Vite 会自动顺延）');
    info('管理台 http://127.0.0.1:5173/admin.html');
  } else {
    warn('已跳过 Vite，仅提供 API 与（若存在）dist 静态资源');
  }
  info('按 Ctrl+C 停止');

  const env = { PORT: String(port), HQ_SERVER_PORT: String(port) };
  launch('server', ['--watch', 'src/server/index.ts'], env);
  if (!opts.noVite) launch('vite', [viteBin], env);
}

main().catch((err) => {
  fail(err instanceof Error ? err.message : String(err));
  shutdown(1);
});
