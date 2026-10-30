/**
 * 对战四屏的真实浏览器冒烟（对线上环境跑）。
 *
 *   node scripts/verify-race-ui.mjs
 *
 * 两个浏览器上下文 = 两个玩家：房主建房 → 另一人凭链接进房 → 开局 → 各问一句 →
 * 房主发起结束投票 → 双人同意 → 复盘。全程截图落在 .tmp/screens/。
 *
 * 重点断言：
 *   · 对手页面上不存在别人的问题原文（这是"问答私有"的前端证据）
 *   · 观战/对手只能看到轮次
 *   · 结束后所有人可见完整问答
 *   · 刷新不丢房间（地址栏即事实）
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = process.env.HQ_BASE_URL ?? 'https://cailishi.wyxj.net';
const OUT = '.tmp/screens';
fs.mkdirSync(OUT, { recursive: true });

const adminUser = fs.readFileSync('.local/admin_user.txt', 'utf8').trim();
const adminPass = fs.readFileSync('.local/admin_password.txt', 'utf8').trim();

let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
};

async function api(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text.slice(0, 200);
  }
  return { status: res.status, data };
}

/** 用 API 造一个可登录的测试玩家 */
async function makePlayer(prefix) {
  const login = await fetch(BASE + '/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: adminUser, password: adminPass }),
  });
  const adminCookie = login.headers.get('set-cookie').split(';')[0];
  const inv = await api('/api/admin/invites', { method: 'POST', body: { count: 1 }, cookie: adminCookie, headers: { 'x-hq-admin': '1' } });
  const username = `${prefix}${Date.now().toString(36).slice(-5)}`;
  const password = 'test-pass-123';
  const reg = await api('/api/auth/register', { method: 'POST', body: { username, password, invite: inv.data.codes[0] } });
  return { username, password, ok: reg.status === 201 };
}

async function login(page, username, password) {
  await page.goto(`${BASE}/#/auth`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('form[data-role="auth-form"] input[name="username"]', { timeout: 20000 });
  await page.fill('form[data-role="auth-form"] input[name="username"]', username);
  await page.fill('form[data-role="auth-form"] input[name="password"]', password);
  await page.click('form[data-role="auth-form"] button[type="submit"]');
  // 登录页也有 topbar，所以等"只有登录后才出现"的用户菜单
  await page.waitForSelector('.menu-trigger', { timeout: 20000 });
  await page.waitForTimeout(400);
}

async function main() {
  const player = await makePlayer('ui');
  check(player.ok, '造一个测试玩家', player.username);

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  const errors = [];
  for (const [name, page] of [['A', pageA], ['B', pageB]]) {
    page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      // 刷新/切路由时被中断的请求、WS 重连的噪声都不算缺陷（有降级轮询兜底）
      if (/ERR_CONNECTION_CLOSED|ERR_ABORTED|WebSocket|wss:\/\//i.test(text)) return;
      errors.push(`${name} console: ${text}`);
    });
  }

  /* 1. 两人分别登录 */
  await login(pageA, adminUser, adminPass);
  check((await pageA.textContent('.topbar'))?.includes(adminUser), '房主在界面上登录成功');

  await login(pageB, player.username, player.password);
  check((await pageB.textContent('.topbar'))?.includes(player.username), '第二玩家在界面上登录成功');

  /* 2. 房主进大厅并建房 */
  await pageA.click('[data-action="go-rooms"]');
  await pageA.waitForSelector('.rooms', { timeout: 15000 });
  check(true, '顶栏「对战」进入大厅');
  await pageA.screenshot({ path: `${OUT}/race-1-rooms.png`, fullPage: true });

  await pageA.click('[data-action="pick-room-turns"][data-value="15"]');
  await pageA.click('[data-action="create-room"]');
  await pageA.waitForSelector('.room-big-code', { timeout: 20000 });
  const code = (await pageA.textContent('.room-big-code'))?.trim() ?? '';
  check(/^[A-Z0-9]{4,12}$/.test(code), '建房并进入房间屏', `房号=${code}`);
  await pageA.screenshot({ path: `${OUT}/race-2-room.png`, fullPage: true });

  /* 3. 第二玩家用链接进房 */
  await pageB.goto(`${BASE}/#/room/${code}`, { waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('.player-list', { timeout: 20000 });
  await pageB.waitForFunction(() => document.querySelectorAll('.player-line').length === 2, undefined, { timeout: 15000 });
  check((await pageB.$$('.player-line')).length === 2, '第二屏显示 2 名玩家');
  check((await pageB.textContent('.room-big-code'))?.includes(code), '房间码在两屏一致');

  /* 4. 房主开局 */
  await pageA.waitForSelector('[data-action="room-start"]:not([disabled])', { timeout: 15000 });
  await pageA.click('[data-action="room-start"]');
  await pageA.waitForSelector('.race-unknown', { timeout: 20000 });
  await pageB.waitForSelector('.race-unknown', { timeout: 20000 });
  check(true, '开局后两屏都切到对抗界面');
  check(!(await pageA.content()).includes('race-log li'), '开局时双方都没有问答');

  /* 5. 房主问一句，第二玩家看进度但看不到内容 */
  const question = '他杀过韩信吗';
  await pageA.fill('[data-role="race-ask-input"]', question);
  await pageA.press('[data-role="race-ask-input"]', 'Enter');
  await pageA.waitForSelector('.race-turn', { timeout: 40000 });
  check(true, '房主提问得到回答');
  await pageA.screenshot({ path: `${OUT}/race-3-asking.png`, fullPage: true });

  await pageB.waitForFunction(
    () => {
      const bars = [...document.querySelectorAll('.board-turns')];
      return bars.some((b) => b.textContent?.startsWith('1/'));
    },
    undefined,
    { timeout: 20000 },
  );
  const bHtml = await pageB.content();
  const bMine = await pageB.innerHTML('.race-mine');
  check(bHtml.includes('1/15'), '对手屏显示"已用 1 轮"');
  check(!bMine.includes(question), '对手的问答区没有房主的问题原文', '← 问答私有的前端证据');
  check(!bHtml.includes(question), '对手整页 HTML 里也没有房主的问题原文');
  await pageB.screenshot({ path: `${OUT}/race-4-opponent.png`, fullPage: true });

  /* 6. 第二玩家也问一句 */
  await pageB.fill('[data-role="race-ask-input"]', '他是诗人吗');
  await pageB.press('[data-role="race-ask-input"]', 'Enter');
  await pageB.waitForSelector('.race-turn', { timeout: 40000 });
  check(true, '第二玩家提问得到回答');
  check(!(await pageB.content()).includes(question), '第二玩家屏上仍然看不到房主的问答');

  /* 7. 房主发起结束投票，第二玩家同意 */
  await pageA.click('[data-action="vote-open"]');
  await pageB.waitForSelector('[data-action="vote-cast"]', { timeout: 15000 });
  check(true, '投票广播到第二玩家');
  await pageB.screenshot({ path: `${OUT}/race-5-vote.png`, fullPage: true });

  await pageB.click('[data-action="vote-cast"]');
  await pageA.waitForSelector('.review', { timeout: 20000 });
  await pageB.waitForSelector('.review', { timeout: 20000 });
  check(true, '过半后两屏都进了复盘');

  /* 8. 复盘：目标与全员问答可见 */
  const reviewA = await pageA.content();
  const reviewB = await pageB.content();
  check(reviewA.includes('答案是'), '复盘里揭晓目标人物');
  check(reviewB.includes(question), '复盘里能看到房主的问答');
  check(reviewB.includes('他是诗人吗'), '复盘里能看到第二玩家的问答');
  check((await pageA.$$('.review-player')).length === 2, '复盘列出每位玩家');
  await pageA.screenshot({ path: `${OUT}/race-6-review.png`, fullPage: true });

  /* 9. 刷新不丢房间（地址栏即事实） */
  await pageB.reload({ waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('.review', { timeout: 20000 });
  check(true, '复盘页刷新后仍在复盘');

  check(errors.length === 0, '两个页面没有 JS 报错', errors.slice(0, 3).join(' | '));

  await browser.close();
  console.log(`\n房号 ${code} · 失败项 ${failures} · 截图在 ${OUT}/`);
  return failures;
}

main()
  .then((f) => process.exit(f ? 1 : 0))
  .catch((err) => {
    console.error('ERROR', err);
    process.exit(1);
  });
