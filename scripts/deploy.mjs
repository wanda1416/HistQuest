#!/usr/bin/env node
/**
 * CF Workers 一键部署：build → 种子 → 迁移检查 → deploy → 冒烟。
 *
 *   npm run deploy                 # 完整流程
 *   npm run deploy -- --skip-build # 跳过 vite build（只改了 worker 侧时）
 *   npm run deploy -- --no-smoke   # 部署后不做线上冒烟
 *
 * 为什么要有这个脚本：手工流程是 build → make-seed → d1 迁移 → deploy 四步
 * 散在文档里，其中"先 build 再 deploy（assets 清单按启动时目录生成）"和
 * "老库要补增量迁移"这两个坑靠人记。脚本把它们固化，并在每一步失败时停下来。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const workersDir = path.join(root, 'workers');
const args = new Set(process.argv.slice(2));

const step = (label) => console.log(`\n▶ ${label}`);
const die = (message) => {
  console.error(`\n✗ ${message}`);
  process.exit(1);
};

function run(cmd, cmdArgs, opts = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: opts.cwd ?? root,
    stdio: opts.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    if (opts.capture) process.stdout.write(res.stdout ?? '');
    process.stderr.write(res.stderr ?? '');
    die(`${opts.label ?? cmd} 失败（exit ${res.status}）`);
  }
  return res;
}

/* ---- 0. 前置检查 ---- */

step('前置检查');
if (!fs.existsSync(path.join(workersDir, 'wrangler.toml'))) {
  die('workers/wrangler.toml 不存在。先 cp wrangler.example.toml wrangler.toml 并填写（见 docs/DEPLOY.md §2.1）。');
}
if (process.env.CLOUDFLARE_API_TOKEN && process.env.CLOUDFLARE_API_TOKEN.trim()) {
  console.log('  CLOUDFLARE_API_TOKEN 已设置（API Token 认证）');
} else {
  console.log('  未设置 CLOUDFLARE_API_TOKEN，依赖 wrangler login 的 OAuth 会话');
}
console.log('  OK');

/* ---- 1. 构建 ---- */

if (args.has('--skip-build')) {
  step('跳过 build（--skip-build）');
} else {
  step('vite build（前端 → dist/；必须先于 deploy，assets 清单按启动时目录生成）');
  run('node', ['node_modules/vite/bin/vite.js', 'build'], { label: 'vite build' });
}

/* ---- 2. 人物库种子 ---- */

step('人物库种子（data/characters.json → workers/seed.ts）');
run('node', ['scripts/make-seed.mjs']);

/* ---- 3. D1 迁移检查 ---- */

step('D1 迁移检查（rooms 表 = 对战 schema v8 是否已建）');
// 用 wrangler 查远程 D1；查不到 wrangler 或认证失败时只警告不阻断——
// 迁移可能已经手动跑过（见 docs/DEPLOY.md §2.3 对照表）。
const wranglerCli = path.join(root, 'node_modules', 'wrangler', 'wrangler-dist', 'cli.js');
let roomsTableKnown = null;
const probe = spawnSync(
  process.execPath,
  [wranglerCli, 'd1', 'execute', 'hq', '--remote', '--json', '--command', "SELECT name FROM sqlite_master WHERE type='table' AND name='rooms'"],
  { cwd: workersDir, encoding: 'utf8', timeout: 120_000 },
);
if (probe.status === 0) {
  try {
    const parsed = JSON.parse(probe.stdout.slice(probe.stdout.indexOf('[')));
    roomsTableKnown = (parsed?.[0]?.results ?? []).some((r) => r.name === 'rooms');
  } catch {
    roomsTableKnown = null;
  }
}

if (roomsTableKnown === false) {
  step('缺 rooms 表 → 执行增量迁移 migrations/v8-rooms.sql');
  run(process.execPath, [wranglerCli, 'd1', 'execute', 'hq', '--remote', '--file', 'migrations/v8-rooms.sql'], {
    cwd: workersDir,
    label: 'd1 migrate v8',
  });
} else if (roomsTableKnown === true) {
  console.log('  rooms 表已存在，跳过迁移');
} else {
  console.log('  ⚠ 无法探测远程 D1（未登录或网络不通）。');
  console.log('    若这是上线过的库，确认跑过：npx wrangler d1 execute hq --remote --file=migrations/v8-rooms.sql');
  console.log('    全新库无需处理：首次部署用 schema.sql 全量建库（见 docs/DEPLOY.md §2.3）。');
}

/* ---- 4. 发布 ---- */

step('wrangler deploy');
run(process.execPath, [wranglerCli, 'deploy'], { cwd: workersDir, label: 'wrangler deploy' });

/* ---- 5. 冒烟 ---- */

if (args.has('--no-smoke')) {
  console.log('\n✓ 部署完成（--no-smoke 跳过冒烟）');
  process.exit(0);
}

step('线上冒烟（/api/meta）');
// 从 wrangler.toml 抠自定义域名；没有就用 workers.dev 子域名的占位提示
const toml = fs.readFileSync(path.join(workersDir, 'wrangler.toml'), 'utf8');
const domain = toml.match(/pattern\s*=\s*"([^"]+)"\s*,\s*custom_domain/)?.[1];
const base = domain ? `https://${domain}` : null;

if (!base) {
  console.log('  ⚠ wrangler.toml 没有自定义域名，跳过冒烟。请手动访问 /api/meta 确认。');
  process.exit(0);
}

const ok = await fetch(`${base}/api/meta`, { signal: AbortSignal.timeout(30_000) })
  .then((r) => r.json())
  .then((j) => j?.characterCount > 0 && j?.serverModelReady !== undefined)
  .catch(() => false);

if (!ok) {
  die(`冒烟失败：${base}/api/meta 无响应或缺字段。检查 wrangler tail 日志。`);
}
console.log(`  OK：${base}/api/meta 返回正常`);

console.log(`\n✓ 部署完成：${base}`);
console.log('  全链路冒烟（会消耗模型额度）：node scripts/verify-race-api.mjs');
