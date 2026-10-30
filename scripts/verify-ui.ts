/**
 * UI 冒烟：用真实浏览器 + 真实模型跑一遍"配置 → 开局 → 提问 → 猜 → 揭晓"。
 * 仅开发期使用，不参与产品逻辑。
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import type { Browser, Page } from 'playwright-core';
import { createApp } from '../src/server/index.ts';

const OUT = '.tmp/screens';
const PORT = 3100;
const LLM_BASE = process.env.HQ_BASE ?? 'http://127.0.0.1:7863/v1';
const LLM_KEY = process.env.HQ_KEY ?? 'test_key';
const LLM_MODEL = process.env.HQ_MODEL ?? 'cn:deepseek-v4.1-flash';

fs.mkdirSync(OUT, { recursive: true });

const problems: string[] = [];

async function waitAnswered(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      if (document.querySelector('.turn-thinking')) return false;
      return (
        document.querySelectorAll('.turn-a').length === document.querySelectorAll('.turn-q').length
      );
    },
    undefined,
    { timeout: 40000 },
  );
}

async function main(): Promise<void> {
  const { app } = createApp({ sessionsFile: null });
  const server = app.listen(PORT, '127.0.0.1');
  const base = `http://127.0.0.1:${PORT}`;

  const browser: Browser = await chromium.launch({ channel: 'msedge', headless: true });

  const watch = (page: Page): void => {
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(`console: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  };

  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  watch(page);
  await page.goto(base, { waitUntil: 'networkidle' });
  await page.screenshot({ path: `${OUT}/01-setup.png`, fullPage: true });

  await page.fill('#baseURL', LLM_BASE);
  await page.fill('#apiKey', LLM_KEY);
  await page.fill('#model', LLM_MODEL);
  await page.click('[data-action="test-ai"]');
  await page.waitForSelector('.testline.ok', { timeout: 30000 });
  await page.screenshot({ path: `${OUT}/02-setup-ok.png`, fullPage: true });

  await page.click('button[type="submit"]');
  await page.waitForSelector('.lobby', { timeout: 5000 });
  await page.click('[data-action="pick-difficulty"][data-value="1"]');
  await page.click('[data-action="pick-mode"][data-value="guided"]');
  await page.click('[data-action="pick-dynasty"][data-value="唐"]');
  await page.screenshot({ path: `${OUT}/03-lobby.png`, fullPage: true });

  await page.click('[data-action="start-game"]');
  await page.waitForSelector('.board', { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/04-game-empty.png`, fullPage: true });

  const questions = ['他是唐朝人吗？', '他当过皇帝吗？', '他是诗人吗？', '他是唐朝前的人物还是唐朝后的人物'];
  for (const q of questions) {
    await page.fill('[data-role="ask-input"]', q);
    await page.press('[data-role="ask-input"]', 'Enter');
    await waitAnswered(page);
  }
  await page.screenshot({ path: `${OUT}/05-game-answers.png`, fullPage: true });

  await page.click('[data-action="open-guess"]');
  await page.waitForSelector('[data-role="guess-input"]');
  await page.fill('[data-role="guess-input"]', '一个不存在的人');
  await page.screenshot({ path: `${OUT}/06-guess-dialog.png`, fullPage: true });
  await page.click('[data-action="do-guess"]');
  await page.waitForSelector('.notice-info', { timeout: 10000 });

  await page.click('[data-action="reveal"]');
  await page.waitForSelector('.reveal-card', { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/07-reveal.png`, fullPage: true });

  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('.reveal-card', { timeout: 10000 });
  await page.screenshot({ path: `${OUT}/08-reload.png`, fullPage: true });

  const mobile = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  watch(mobile);
  await mobile.addInitScript(
    ([url, key, model]) => {
      localStorage.setItem(
        'hq.aiConfig',
        JSON.stringify({ baseURL: url, apiKey: key, model }),
      );
    },
    [LLM_BASE, LLM_KEY, LLM_MODEL],
  );
  await mobile.goto(base, { waitUntil: 'networkidle' });
  await mobile.waitForSelector('.lobby', { timeout: 10000 });
  await mobile.screenshot({ path: `${OUT}/09-mobile-lobby.png`, fullPage: true });

  await mobile.click('[data-action="start-game"]');
  await mobile.waitForSelector('.board', { timeout: 10000 });
  await mobile.fill('[data-role="ask-input"]', '他是唐朝人吗？');
  await mobile.press('[data-role="ask-input"]', 'Enter');
  await waitAnswered(mobile);
  await mobile.screenshot({ path: `${OUT}/10-mobile-game.png`, fullPage: true });

  await browser.close();
  server.close();

  if (problems.length) {
    console.log('发现页面问题：');
    for (const p of problems) console.log(' -', p);
  } else {
    console.log('无页面错误');
  }
}

await main();
