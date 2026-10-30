/**
 * 路由冒烟：地址栏带对局 id、刷新/换标签页/未登录登录后回到原局、任何页面都能回首页。
 * 用假模型跑，不需要真实 LLM；需要本机装有 Edge（playwright-core 用 channel: msedge）。
 *
 *   node scripts/verify-router.ts      # 截图落在 .tmp/screens/router-*.png
 *//**
 * 针对「地址栏带对局 id」与「首页按钮」的浏览器冒烟。
 * 用假模型跑通，不依赖真实 LLM；只验证交互与 URL。
 */
process.env.AI_BASE_URL = 'http://127.0.0.1:4100/v1';
process.env.AI_API_KEY = 'sk-smoke-router';
process.env.AI_MODEL = 'mock';

const { chromium } = await import('playwright-core');
const { createApp } = await import('../src/server/index.ts');
const { startMockLlm } = await import('../test/fixtures/mock-llm.ts');

const PORT = 3105;
const OUT = '.tmp/screens';
const fs = await import('node:fs');
fs.mkdirSync(OUT, { recursive: true });

const mock = await startMockLlm(4100);
const { app } = createApp({ sessionsFile: null });
const server = app.listen(PORT, '127.0.0.1');
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx1 = await browser.newContext();
const page = await ctx1.newPage();
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console: ${m.text()}`);
});

const hash = () => new URL(page.url()).hash;
const step = async (name: string): Promise<void> => {
  await page.screenshot({ path: `${OUT}/router-${name}.png`, fullPage: true });
  console.log(`[shot] ${name} url=${page.url().replace(base, '')}`);
};

await page.goto(base, { waitUntil: 'networkidle' });
await page.waitForSelector('[data-role="auth-form"]');
console.log('1) 未登录落在登录页，hash =', JSON.stringify(hash()));


await page.click('[data-action="auth-toggle"]');   // 切到注册（首账号免邀请码）
await page.waitForSelector('#invite');
await page.fill('#username', 'smoke');
await page.fill('#password', 'passw0rd!');
await page.click('[data-role="auth-form"] button[type="submit"]');

await page.waitForSelector('[data-action="start-game"]');
console.log('2) 注册后进入首页，hash =', JSON.stringify(hash()));

await page.click('[data-action="start-game"]');
await page.waitForSelector('[data-role="ask-input"]');
const gameHash = hash();
console.log('3) 开局后 hash =', JSON.stringify(gameHash));
if (!/^#\/game\/[A-Za-z0-9-]{4,64}$/.test(gameHash)) problems.push(`开局后地址栏不是 #/game/<id>：${gameHash}`);
await step('game');

await page.fill('[data-role="ask-input"]', '他是唐朝人吗');
await page.press('[data-role="ask-input"]', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('.turn-a').length >= 1, undefined, { timeout: 20000 });
console.log('4) 提问成功，问答条数 =', await page.locator('.turn-a').count());

await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-role="ask-input"]', { timeout: 15000 });
const afterReload = hash();
const turnsAfterReload = await page.locator('.turn-a').count();
console.log('5) 刷新后 hash =', JSON.stringify(afterReload), '问答条数 =', turnsAfterReload);
if (afterReload !== gameHash) problems.push(`刷新后 hash 变了：${gameHash} -> ${afterReload}`);
if (turnsAfterReload < 1) problems.push('刷新后对局记录丢了');
await step('after-reload');

// 顶栏：设置收在用户菜单里（不再是一排平级按钮）
if ((await page.locator('.topbar [data-action="go-setup"]').count()) > 0) {
  problems.push('设置仍然直接露在顶栏，没有收进用户菜单');
}
await page.click('[data-action="toggle-menu"]');
await page.waitForSelector('.menu-panel');
console.log('6) 打开用户菜单，菜单项 =', (await page.locator('.menu-item').allInnerTexts()).join(' / '));
await step('menu');
await page.click('.menu-item:has-text("我的设置")');
await page.waitForSelector('[data-role="config-form"]');
console.log('6b) 从菜单进入设置页，hash =', JSON.stringify(hash()));
await step('setup');

// 品牌区就是首页入口
const brand = page.locator('a.brand-link[data-action="go-home"]');
if ((await brand.count()) === 0) {
  problems.push('品牌区不是首页链接');
} else {
  await brand.click();
  await page.waitForSelector('[data-action="start-game"]');
  console.log('7) 点品牌「猜历史」回到首页，hash =', JSON.stringify(hash()));
  await step('home');
}

// 同一个浏览器上下文（带 cookie）直接打开对局链接也应还原
const page1 = await ctx1.newPage();
await page1.goto(`${base}/${gameHash}`, { waitUntil: 'networkidle' });
await page1.waitForSelector('[data-role="ask-input"]', { timeout: 15000 });
console.log('8) 同账号新标签页打开对局链接，问答条数 =', await page1.locator('.turn-a').count());
await page1.screenshot({ path: `${OUT}/router-shared-link.png`, fullPage: true });

// 未登录（无 cookie 的隔离上下文）打开对局链接：先去登录，登录后回到这一局
const ctx = await browser.newContext();
const page2 = await ctx.newPage();
await page2.goto(`${base}/${gameHash}`, { waitUntil: 'networkidle' });
const needLogin = (await page2.locator('[data-role="auth-form"]').count()) > 0;
console.log('9) 未登录打开对局链接，是否要求登录 =', needLogin, 'hash =', JSON.stringify(new URL(page2.url()).hash));
if (!needLogin) problems.push('未登录打开对局链接时没有要求登录');
await page2.fill('#username', 'smoke');
await page2.fill('#password', 'passw0rd!');
await page2.click('[data-role="auth-form"] button[type="submit"]');
await page2.waitForSelector('[data-role="ask-input"]', { timeout: 20000 });
console.log('10) 登录后回到原对局，hash =', JSON.stringify(new URL(page2.url()).hash), '问答条数 =', await page2.locator('.turn-a').count());
if (new URL(page2.url()).hash !== gameHash) problems.push('登录后没有回到原来的对局');
await page2.screenshot({ path: `${OUT}/router-login-then-game.png`, fullPage: true });
await ctx.close();

// 首页刷新不应被拽回旧对局
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('[data-action="start-game"]');
console.log('11) 首页刷新后仍在首页，hash =', JSON.stringify(hash()));

// ---------- 结算路径 ----------
// 12) 放弃并揭晓：必须真的出人物卡（线上曾因服务端少 await 返回 {}，点了像没反应）
await page.click('[data-action="start-game"]');
await page.waitForSelector('[data-action="reveal"]');
const id12 = new URL(page.url()).hash.split('/').pop();
await page.click('[data-action="reveal"]');
await page.waitForSelector('.reveal-card', { timeout: 20000 });
const revealHash = new URL(page.url()).hash;
console.log('12) 放弃并揭晓 → 人物卡出现，hash =', JSON.stringify(revealHash));
if (revealHash !== `#/reveal/${id12}`) problems.push(`揭晓后地址不对：${revealHash}`);
await page.screenshot({ path: `${OUT}/router-reveal.png`, fullPage: true });

// 13) 模型答「猜中了」：应自动结算，不停在对局页
await page.click('[data-action="new-game"]');
await page.waitForSelector('[data-action="start-game"]');
await page.click('[data-action="start-game"]');
await page.waitForSelector('[data-role="ask-input"]');
const id13 = new URL(page.url()).hash.split('/').pop();
await page.route('**/api/solo/*/ask', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      accepted: true,
      seq: 1,
      verdict: 'yes',
      text: '没错，就是他。恭喜你猜中了！',
      turnsLeft: 19,
      status: 'won',
    }),
  });
});
await page.fill('[data-role="ask-input"]', '他是李白吗');
await page.press('[data-role="ask-input"]', 'Enter');
await page.waitForSelector('.reveal-card', { timeout: 20000 });
const wonHash = new URL(page.url()).hash;
console.log('13) 答「猜中了」→ 自动结算，hash =', JSON.stringify(wonHash));
if (wonHash !== `#/reveal/${id13}`) problems.push(`猜中后没有结算到揭晓页：${wonHash}`);
await page.screenshot({ path: `${OUT}/router-won.png`, fullPage: true });
await page.unroute('**/api/solo/*/ask');

await browser.close();
server.close();
await mock.close();

console.log(problems.length ? `\n有问题：\n- ${problems.join('\n- ')}` : '\n全部通过');
process.exit(problems.length ? 1 : 0);
