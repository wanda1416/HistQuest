import test from 'node:test';
import assert from 'node:assert/strict';
import { getState } from '../src/client/store.ts';
import { renderApp } from '../src/client/views.ts';
import { renderAdmin } from '../src/client/admin-views.ts';
import type { AdminState } from '../src/client/admin-views.ts';
import type { HistoryDetail, HistorySummary } from '../src/shared/protocol.ts';

/**
 * 历史界面的渲染冒烟：字符串模板不需要浏览器，直接断言产出里有关键内容。
 * （真浏览器冒烟见 scripts/verify-ui.ts，需要真实模型与浏览器环境）
 */

const summary: HistorySummary = {
  id: 'g1',
  status: 'revealed',
  result: 'abandoned',
  category: 'character',
  difficulty: 2,
  mode: 'strict',
  polity: '唐',
  region: null,
  worldEra: null,
  turnsTotal: 10,
  turnsUsed: 2,
  turnsLeft: 8,
  startedAt: Date.now() - 60_000,
  endedAt: Date.now(),
  userName: 'alice',
  owner: 'user',
  target: { name: '李白', polity: '唐', roles: ['诗人'] },
};

const detail: HistoryDetail = {
  ...summary,
  id: 'g1',
  userId: 'u1',
  turns: [
    { seq: 1, question: '他是唐朝人吗', verdict: 'yes', text: '是。' },
    { seq: 2, question: '他是诗人吗', verdict: 'yes', text: '是。', hint: '「诗人」包含词人。' },
  ],
};

test('玩家历史列表：显示结局、目标、问数与「查看」入口', () => {
  const html = renderApp({
    ...getState(),
    ready: true,
    view: 'history',
    meta: {
      dynasties: [],
      difficulties: [],
      maxTurns: 20,
      serverModelReady: true,
      characterCount: 184,
      regions: [],
      authEnabled: true,
      user: { username: 'alice', role: 'user', allowServerKey: true },
    },
    history: [summary],
    historyTotal: 1,
    historyDetail: null,
  });

  assert.match(html, /对局与问答记录/);
  assert.match(html, /猜中|放弃/);
  assert.match(html, /李白/);
  assert.match(html, /用了 2 \/ 10 问/);
  assert.match(html, /data-action="open-history" data-id="g1"/);
});

test('玩家历史详情：逐条渲染提问与判定，进行中的局不显示目标', () => {
  const html = renderApp({
    ...getState(),
    ready: true,
    view: 'history',
    meta: {
      dynasties: [],
      difficulties: [],
      maxTurns: 20,
      serverModelReady: true,
      characterCount: 184,
      regions: [],
      authEnabled: true,
      user: { username: 'alice', role: 'user', allowServerKey: true },
    },
    history: [summary],
    historyTotal: 1,
    historyDetail: detail,
  });

  assert.match(html, /他是唐朝人吗/);
  assert.match(html, /「诗人」包含词人/);
  assert.match(html, /data-action="history-back"/);

  const playing = renderApp({
    ...getState(),
    ready: true,
    view: 'history',
    meta: {
      dynasties: [],
      difficulties: [],
      maxTurns: 20,
      serverModelReady: true,
      characterCount: 184,
      regions: [],
      authEnabled: true,
      user: { username: 'alice', role: 'user', allowServerKey: true },
    },
    history: null,
    historyTotal: 0,
    historyDetail: { ...detail, status: 'playing', result: 'playing', target: null, endedAt: null },
  });
  assert.match(playing, /还没结束/);
  assert.doesNotMatch(playing, /李白/);
});

test('未登录时历史页给出登录提示，而不是空白', () => {
  const html = renderApp({ ...getState(), ready: true, view: 'history', meta: null });
  assert.match(html, /登录后才能保存和查看自己的对局历史/);
});

const adminBase: AdminState = {
  ready: true,
  error: null,
  notice: null,
  meta: {
    dynasties: ['唐'],
    difficulties: [{ level: 1, label: '入门' }],
    roles: [],
    provinces: [],
    polities: [],
    regions: [],
    total: 184,
    active: 184,
    tokenRequired: false,
  },
  list: [],
  total: 0,
  filters: { q: '', category: '', polity: '', region: '', difficulty: '', retired: '' },
  view: 'history',
  draft: null,
  originalId: null,
  issues: [],
  health: null,
  token: '',
  saving: false,
  users: [],
  invites: [],
  llm: null,
  pwBusy: false,
  llmBusy: false,
  history: [{ ...summary, userName: null, owner: 'guest' }],
  historyTotal: 1,
  historyDetail: null,
  historyFilters: { user: '', result: '', q: '' },
};

test('后台历史列表：游客局标「游客」，进行中的局不显示目标', () => {
  const html = renderAdmin(adminBase);
  assert.match(html, /对局历史（全部玩家 · 1 局）/);
  assert.match(html, /游客/);
  assert.match(html, /data-action="open-history" data-id="g1"/);

  const playing = renderAdmin({
    ...adminBase,
    history: [{ ...summary, status: 'playing', result: 'playing', target: null, userName: 'alice' }],
  });
  assert.doesNotMatch(playing, /李白/);
});

test('归属未记录的老局不标「游客」', () => {
  const html = renderAdmin({
    ...adminBase,
    history: [{ ...summary, userName: null, owner: 'unknown' }],
  });
  assert.match(html, /归属未记录/);
  assert.doesNotMatch(html, /游客/, '查不到归属的老局不能被打成游客');
});

test('后台历史详情：表格里给出每条提问与回答', () => {
  const html = renderAdmin({ ...adminBase, historyDetail: detail });
  assert.match(html, /对局详情/);
  assert.match(html, /他是唐朝人吗/);
  assert.match(html, /data-action="history-back"/);
});
