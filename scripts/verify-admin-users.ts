/** 后台用户管理冒烟：盾形徽标、删除按钮位置与确认框 */
process.env.AI_BASE_URL = 'http://127.0.0.1:4100/v1';
process.env.AI_API_KEY = 'sk-admin_smoke';
process.env.AI_MODEL = 'mock';

const { chromium } = await import('playwright-core');
const { createApp } = await import('../src/server/index.ts');

const PORT = 3107;
const created = createApp({ sessionsFile: null });
const server = created.app.listen(PORT, '127.0.0.1');
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: 'networkidle' });
// 首个账号 = 管理员
await page.click('[data-action="auth-toggle"]');   // 切到注册（首账号免邀请码）
await page.waitForSelector('#invite');
await page.fill('#username', 'admin_smoke');
await page.fill('#password', 'passw0rd!');
await page.click('[data-role="auth-form"] button[type="submit"]');
await page.waitForTimeout(1200);
const authErr = await page.locator('.testline').count();
if (authErr > 0) console.log('   auth 页提示:', await page.locator('.testline').first().innerText());
await page.waitForSelector('[data-action="start-game"]');

// 造两个普通用户（经 API，带会话 cookie 不行——管理接口走 loopback 放行 + X-HQ-Admin）
for (const name of ['alice', 'bob']) {
  const invite = await fetch(`${base}/api/admin/invites`, {
    method: 'POST', headers: { 'X-HQ-Admin': '1', 'Content-Type': 'application/json' }, body: '{"count":1}',
  });
  const code = ((await invite.json()) as { codes: string[] }).codes[0]!;
  await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: name, password: 'passw0rd!', invite: code }),
  });
}

await page.goto(`${base}/admin.html#users`, { waitUntil: 'networkidle' });
await page.waitForSelector('.a-table');

// 1) 管理员行：盾形徽标，没有「管」字徽标，没有删除按钮
const adminRow = page.locator('tr', { hasText: 'admin_smoke' });
if ((await adminRow.locator('.a-shield').count()) === 0) problems.push('管理员行缺少盾形徽标');
if ((await adminRow.locator('.a-tag').count()) > 0) problems.push('仍存在「管」字徽标');
if ((await adminRow.locator('[data-action="user-delete"]').count()) > 0) problems.push('管理员行不应有删除按钮');
console.log('1) 管理员行：盾徽 =', await adminRow.locator('.a-shield').count(), '，无删除按钮');

// 2) 普通行：删除按钮存在，且与「封禁」横向距离 ≥ 24px（视觉隔离）
const bobRow = page.locator('tr', { hasText: 'bob' });
const delBtn = bobRow.locator('[data-action="user-delete"]');
if ((await delBtn.count()) !== 1) problems.push('普通用户行缺少删除按钮');
const banBox = await bobRow.locator('[data-action="user-ban"]').boundingBox();
const delBox = await delBtn.boundingBox();
if (banBox && delBox) {
  const gap = delBox.x - (banBox.x + banBox.width);
  console.log('2) 「封禁」→「删除」的水平间距 =', Math.round(gap), 'px');
  if (gap < 24) problems.push(`删除按钮与封禁间距只有 ${Math.round(gap)}px，隔离不够`);
} else {
  problems.push('拿不到按钮位置');
}
await page.screenshot({ path: '.tmp/screens/admin-users.png', fullPage: true });

// 3) 删除：确认框出现；取消则不删
let dialogMessage = '';
page.once('dialog', (d) => {
  dialogMessage = d.message();
  void d.dismiss();
});
await delBtn.click();
await page.waitForTimeout(600);
if (!dialogMessage.includes('不可恢复')) problems.push('删除确认框没有说明不可恢复');
const stillThere = await page.locator('tr', { hasText: 'bob' }).count();
if (stillThere === 0) problems.push('取消后用户仍被删除了');
console.log('3) 确认框（取消）→ bob 仍在 =', stillThere > 0);

// 4) 确认删除 → 行消失
page.once('dialog', (d) => void d.accept());
await bobRow.locator('[data-action="user-delete"]').click();
await page.waitForTimeout(800);
const gone = await page.locator('tr', { hasText: 'bob' }).count();
console.log('4) 确认删除 → bob 行移除 =', gone === 0);
if (gone !== 0) problems.push('确认删除后用户没有消失');

await page.screenshot({ path: '.tmp/screens/admin-users-after.png', fullPage: true });
await browser.close();
server.close();

console.log(problems.length ? `\n有问题：\n- ${problems.join('\n- ')}` : '\n全部通过');
process.exit(problems.length ? 1 : 0);
