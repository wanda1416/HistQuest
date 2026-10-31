/** 后台类别化编辑冒烟：新建事件 → 表单按类别变形 → 保存 → 列表徽标/筛选 */
process.env.AI_BASE_URL = 'http://127.0.0.1:4100/v1';
process.env.AI_API_KEY = 'sk-admin-edit';
process.env.AI_MODEL = 'mock';

const { chromium } = await import('playwright-core');
const { createApp } = await import('../src/server/index.ts');
const fs = await import('node:fs');

const PORT = 3108;
const created = createApp({ sessionsFile: null });
const server = created.app.listen(PORT, '127.0.0.1');
const base = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage();
const problems: string[] = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));

await page.goto(`${base}/admin.html`, { waitUntil: 'networkidle' });
await page.waitForSelector('.a-table');

// 1) 新增按钮按类别三分
const btns = page.locator('[data-action="create"]');
console.log('1) 新增按钮:', await btns.allInnerTexts());
if ((await btns.count()) !== 3) problems.push('应有三个新增按钮（人物/事件/物品）');

// 2) 类别筛选
await page.selectOption('[data-field="filter-category"]', 'event');
await page.waitForTimeout(400);
const listed = await page.locator('tbody tr').count();
console.log('2) 筛选事件后列表行数:', listed);
if (listed !== 40) problems.push(`事件筛选应显示 40 行，实际 ${listed}`);
await page.selectOption('[data-field="filter-category"]', '');
await page.waitForTimeout(300);

// 3) 新建事件：表单变形
await page.click('[data-action="create"][data-category="event"]');
await page.waitForSelector('#f-birth');
const headText = await page.locator('.a-form-head h2').innerText();
console.log('3) 表单标题:', headText);
if (!headText.includes('事件')) problems.push('新建事件标题未按类别显示');
for (const absent of ['#f-gender', '#f-emperor', '#f-death']) {
  if ((await page.locator(absent).count()) > 0) problems.push(`事件表单不应出现 ${absent}`);
}
const birthLabel = await page.locator('label[for="f-birth"]').innerText();
console.log('   年份字段标签:', birthLabel);
if (!birthLabel.includes('发生年份')) problems.push('事件年份标签不对');
await page.screenshot({ path: '.tmp/screens/admin-edit-event.png', fullPage: true });

// 4) 填写并保存
await page.fill('#f-id', 'ev-smoke-001');
await page.fill('#f-name', '测试事件·冒烟');
await page.fill('#f-aliases', '');
await page.selectOption('#f-polity', '唐');
await page.fill('#f-birth', '700');
await page.fill('#f-birthplace', '测试地点（今 nowhere）');
await page.fill('#f-birthProvince', '河北');
// 类型：从 datalist 建议里点一个（战役）
await page.click('.a-chips .a-chip:has-text("战役")');
await page.fill('#f-tags', '冒烟');
await page.fill('#f-notable', '用于冒烟测试的虚构事件条目，保存后即被删除。');
await page.click('[data-action="save"]');
await page.waitForTimeout(900);
const notice = (await page.locator('.a-notice').first().innerText().catch(() => '')) || '';
console.log('4) 保存提示:', notice);
if (!notice.includes('创建') && !notice.includes('已')) problems.push(`保存未成功：${notice}`);

// 5) 列表出现新条目（带事件徽标）
await page.click('[data-action="go-list"]');
await page.waitForSelector('.a-table');
await page.selectOption('[data-field="filter-category"]', 'event');
await page.waitForTimeout(400);
const row = page.locator('tr', { hasText: '测试事件·冒烟' });
console.log('5) 列表中新条目行数:', await row.count(), '，事件徽标:', await row.locator('.a-pill:has-text("事件")').count());
if ((await row.count()) !== 1) problems.push('保存后列表未出现新事件');

// 6) 清理：下线该条（后台无人物删除端点；冒烟库是一次性内存库，不影响真实数据）
await fetch(`${base}/api/admin/characters/ev-smoke-001/retire`, {
  method: 'POST', headers: { 'X-HQ-Admin': '1', 'Content-Type': 'application/json' }, body: '{"retired":true}',
});
console.log('6) 测试条目已下线（冒烟库为内存库，随进程结束销毁）');

await browser.close();
server.close();
console.log(problems.length ? `\n有问题：\n- ${problems.join('\n- ')}` : '\n全部通过');
process.exit(problems.length ? 1 : 0);
