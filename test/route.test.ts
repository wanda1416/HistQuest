import test from 'node:test';
import assert from 'node:assert/strict';
import { isShowing, parseRoute, routeHash } from '../src/client/route.ts';

/**
 * 对局必须能从地址栏还原：刷新、换标签页、粘链接都靠这个路由。
 * 这里只测纯解析与规范化，DOM 行为由 main.ts 的 applyRoute 负责。
 */

test('空地址与 #/ 视为首页', () => {
  assert.deepEqual(parseRoute(''), { view: 'lobby' });
  assert.deepEqual(parseRoute('#'), { view: 'lobby' });
  assert.deepEqual(parseRoute('#/'), { view: 'lobby' });
});

test('对局与揭晓都带 id', () => {
  assert.deepEqual(parseRoute('#/game/abcdef123456'), { view: 'game', id: 'abcdef123456' });
  assert.deepEqual(parseRoute('#/reveal/abcdef123456'), { view: 'reveal', id: 'abcdef123456' });
});

test('历史列表与详情', () => {
  assert.deepEqual(parseRoute('#/history'), { view: 'history', id: null });
  assert.deepEqual(parseRoute('#/history/abcdef123456'), { view: 'history', id: 'abcdef123456' });
});

test('设置与登录页', () => {
  assert.deepEqual(parseRoute('#/setup'), { view: 'setup' });
  assert.deepEqual(parseRoute('#/auth'), { view: 'auth' });
});

test('认不出的地址返回 null，交给默认落点处理', () => {
  assert.equal(parseRoute('#/nope'), null);
  assert.equal(parseRoute('#/game'), null, '缺 id 不算对局路由');
  assert.equal(parseRoute('#/game/../../etc'), null);
  assert.equal(parseRoute('#/game/ab'), null, 'id 太短，不像服务端生成的 id');
  assert.equal(parseRoute('#/game/abcdef123456/extra'), null);
  assert.equal(parseRoute('#/history/abcdef123456/extra'), null);
});

test('路由 → hash 往返一致', () => {
  const routes = [
    { view: 'lobby' as const },
    { view: 'setup' as const },
    { view: 'auth' as const },
    { view: 'game' as const, id: 'abcdef123456' },
    { view: 'reveal' as const, id: 'abcdef123456' },
    { view: 'history' as const, id: null },
    { view: 'history' as const, id: 'abcdef123456' },
  ];
  for (const r of routes) {
    assert.deepEqual(parseRoute(routeHash(r)), r, `${routeHash(r)} 应能解析回原路由`);
  }
});

test('isShowing：视图和 id 都对得上才算已经显示', () => {
  const game = { view: 'game' as const, id: 'abc123456' };
  assert.equal(isShowing(game, { view: 'game', gameId: 'abc123456' }), true);
  assert.equal(isShowing(game, { view: 'reveal', gameId: 'abc123456' }), false, '揭晓态不等于对局态');
  assert.equal(isShowing(game, { view: 'game', gameId: 'other12345' }), false);

  const reveal = { view: 'reveal' as const, id: 'abc123456' };
  assert.equal(isShowing(reveal, { view: 'reveal', gameId: 'abc123456' }), true);
  assert.equal(isShowing(reveal, { view: 'game', gameId: 'abc123456' }), false);

  const list = { view: 'history' as const, id: null };
  assert.equal(isShowing(list, { view: 'history', historyId: null }), true);
  assert.equal(isShowing(list, { view: 'history', historyId: 'abc123456' }), false);
});
