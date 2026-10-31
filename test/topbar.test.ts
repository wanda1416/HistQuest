import test from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../src/client/store.ts';
import { closeMenu, renderApp, toggleMenu } from '../src/client/views.ts';
import type { MetaRes, MetaUser, SessionView } from '../src/shared/protocol.ts';

/**
 * 顶栏信息架构：品牌即首页、右侧只留「历史 + 用户菜单」、低频操作收进二级。
 * 这些是纯模板输出，不需要浏览器（真浏览器冒烟见 scripts/verify-router.ts）。
 */

const meta = (user: MetaUser | null): MetaRes => ({
  dynasties: [],
  difficulties: [],
  maxTurns: 20,
  serverModelReady: true,
  characterCount: 184,
  regions: [],
  authEnabled: true,
  user,
});

const member: MetaUser = { username: 'alice', role: 'user', allowServerKey: true };
const admin: MetaUser = { username: 'boss', role: 'admin', allowServerKey: true };

const session: SessionView = {
  gameId: 'g1abcdefg',
  category: 'character',
  status: 'playing',
  turnsLeft: 12,
  difficulty: 2,
  polity: '唐',
  region: null,
  worldEra: null,
  cnShare: 0.5,
  mode: 'strict',
  pronoun: 'neutral',
  history: [],
};

function render(patch: Record<string, unknown>): string {
  return renderApp({ ...getState(), ready: true, ...patch } as never);
}

test('品牌区就是首页入口，且不再写死「二十问」', () => {
  closeMenu();
  const html = render({ view: 'setup', meta: meta(member) });
  assert.match(html, /<a class="brand brand-link" href="#\/" data-action="go-home"/);
  assert.match(html, /是\/否提问 · 猜人物/);
  assert.doesNotMatch(html, /二十问/);
  // 顶栏不再有单独的「首页」按钮
  assert.equal(html.includes('>首页<'), false);
});

test('登录后：顶栏直接可见的只有「历史」，其余收进用户菜单', () => {
  closeMenu();
  const closed = render({ view: 'lobby', meta: meta(member) });
  assert.match(closed, /data-action="go-history"/);
  assert.match(closed, /data-action="toggle-menu"/);
  assert.equal(closed.includes('data-action="go-setup"'), false, '设置应收进菜单');
  assert.equal(closed.includes('data-action="logout"'), false, '登出应收进菜单');
  assert.equal(closed.includes('/admin.html'), false, '管理后台应收进菜单');
  assert.match(closed, /aria-expanded="false"/);

  toggleMenu();
  const opened = render({ view: 'lobby', meta: meta(member) });
  assert.match(opened, /data-action="go-setup"[\s\S]*我的设置/);
  assert.match(opened, /data-action="logout"[\s\S]*登出/);
  assert.match(opened, /aria-expanded="true"/);
  assert.equal(opened.includes('管理后台'), false, '普通用户不该看到管理后台');
  closeMenu();
});

test('管理员菜单里才有「管理后台」', () => {
  closeMenu();
  toggleMenu();
  const html = render({ view: 'lobby', meta: meta(admin) });
  assert.match(html, /href="\/admin.html"[\s\S]*管理后台/);
  assert.match(html, /管理员/);
  closeMenu();
});

test('未登录只给「登录」，没有账号相关入口', () => {
  closeMenu();
  const html = render({ view: 'auth', meta: meta(null) });
  assert.match(html, /data-action="go-auth"[\s\S]*登录/);
  assert.equal(html.includes('data-action="go-history"'), false);
  assert.equal(html.includes('data-action="logout"'), false);
});

test('对局中顶栏显示剩余问数、模式与范围', () => {
  closeMenu();
  const html = render({ view: 'game', meta: meta(member), session });
  assert.match(html, /topbar-context/);
  assert.match(html, /剩 12 问/);
  assert.match(html, /精确/);
  assert.match(html, /唐/);
});

test('非对局页面不显示对局上下文', () => {
  closeMenu();
  const html = render({ view: 'lobby', meta: meta(member), session: null });
  assert.equal(html.includes('topbar-context'), false);
});
