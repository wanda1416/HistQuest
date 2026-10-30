/**
 * 对战（房间）线上冒烟 —— HTTP 通道。
 *
 *   node scripts/verify-race-api.mjs
 *
 * 会真的在线上建房、注册两个测试账号、问两三个问题（消耗服务端模型额度），
 * 并在 D1 留下测试房间。凭据从 .local/ 读，与部署脚本同一套。
 *
 * 覆盖：建房 → 两人进房 → 开局 → 提问 → 对手视角无问答 → 观战者无历史 →
 *       投票过半结束 → 复盘全员可见 → 落账（rooms + games）
 */
import fs from 'node:fs';

const BASE = process.env.HQ_BASE_URL ?? 'https://cailishi.wyxj.net';
const adminUser = fs.readFileSync('.local/admin_user.txt', 'utf8').trim();
const adminPass = fs.readFileSync('.local/admin_password.txt', 'utf8').trim();

let failures = 0;
function check(ok, label, extra = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  if (!ok) failures += 1;
}

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
    data = text.slice(0, 300);
  }
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}

const adminHeaders = { 'x-hq-admin': '1' };

async function newPlayer(adminCookie, prefix) {
  const inv = await api('/api/admin/invites', {
    method: 'POST',
    body: { count: 1 },
    cookie: adminCookie,
    headers: adminHeaders,
  });
  const username = `${prefix}${Date.now().toString(36).slice(-5)}`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'test-pass-123', invite: inv.data.codes[0] },
  });
  return { username, cookie: reg.cookie, status: reg.status };
}

async function main() {
  const login = await api('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPass } });
  check(login.status === 200 && !!login.cookie, '房主登录', `status=${login.status}`);
  const A = login.cookie;

  const second = await newPlayer(A, 'race');
  check(second.status === 201 && !!second.cookie, '第二玩家注册', `user=${second.username}`);
  const B = second.cookie;

  const created = await api('/api/rooms', { method: 'POST', body: { settings: { turnLimit: 10, difficulty: 1 } }, cookie: A });
  const code = created.data?.code;
  check(created.status === 201 && !!code, '建房', `code=${code}`);
  if (!code) return 1;

  const joinA = await api(`/api/room/${code}/join`, { method: 'POST', cookie: A });
  const joinB = await api(`/api/room/${code}/join`, { method: 'POST', cookie: B });
  check(joinA.data?.me?.role === 'host', '房主进房', `role=${joinA.data?.me?.role}`);
  check(joinB.data?.players?.length === 2, '第二玩家进房', `players=${joinB.data?.players?.length}`);

  const list = await api('/api/rooms', { cookie: B });
  check((list.data?.items ?? []).some((r) => r.code === code), '大厅列表里有这个房');

  const started = await api(`/api/room/${code}/cmd`, { method: 'POST', body: { t: 'start' }, cookie: A });
  check(started.data?.status === 'playing', '房主开局', `status=${started.data?.status}`);
  check(started.data?.me?.turnsLeft === 10, '轮次按房主设置下发', `turnsLeft=${started.data?.me?.turnsLeft}`);

  const asked = await api(`/api/room/${code}/cmd`, { method: 'POST', body: { t: 'ask', question: '他是男性吗' }, cookie: A });
  const askedOk = asked.data?.me?.history?.length === 1;
  check(askedOk, '房主提问（真调模型）', askedOk ? `verdict=${asked.data.me.history[0].verdict} 剩 ${asked.data.me.turnsLeft} 轮` : '');

  const viewB = await api(`/api/room/${code}`, { cookie: B });
  const aView = (viewB.data?.players ?? []).find((p) => p.isHost);
  check(aView?.turnsUsed === 1, '对手能看到已用轮次', `turnsUsed=${aView?.turnsUsed}/${aView?.turnsTotal}`);
  check(!JSON.stringify(viewB.data).includes('他是男性吗'), '对手视角没有房主的问题原文');
  check(viewB.data?.reveal === undefined, '进行中没有 reveal');

  const askedB = await api(`/api/room/${code}/cmd`, { method: 'POST', body: { t: 'ask', question: '他是诗人吗' }, cookie: B });
  check(askedB.data?.me?.history?.length === 1, '第二玩家提问', `剩 ${askedB.data?.me?.turnsLeft} 轮`);

  const spectator = await newPlayer(A, 'watch');
  const specJoin = await api(`/api/room/${code}/join`, { method: 'POST', cookie: spectator.cookie });
  check(specJoin.data?.me?.role === 'spectator', '中途加入变成观战者', `role=${specJoin.data?.me?.role}`);
  check(specJoin.data?.me?.history === undefined, '观战者拿不到任何问答字段');
  check(!JSON.stringify(specJoin.data).includes('他是男性吗'), '观战者看不到别人的问题');

  const specAsk = await api(`/api/room/${code}/cmd`, { method: 'POST', body: { t: 'ask', question: '他是唐朝人吗' }, cookie: spectator.cookie });
  check(specAsk.status >= 400, '观战者提问被拒', `status=${specAsk.status} error=${specAsk.data?.error}`);

  const vote1 = await api(`/api/room/${code}/cmd`, { method: 'POST', body: { t: 'open-vote' }, cookie: A });
  check(vote1.data?.vote?.votes === 1 && vote1.data?.status === 'playing', '投票发起（未过半）', `${vote1.data?.vote?.votes}/${vote1.data?.vote?.need}`);

  const vote2 = await api(`/api/room/${code}/cmd`, { method: 'POST', body: { t: 'cast-vote' }, cookie: B });
  check(vote2.data?.status === 'finished', '过半后立即结束', `reason=${vote2.data?.endReason}`);

  const reviewA = await api(`/api/room/${code}`, { cookie: A });
  const reviewB = await api(`/api/room/${code}`, { cookie: B });
  const reviewC = await api(`/api/room/${code}`, { cookie: spectator.cookie });
  check(!!reviewA.data?.reveal?.character?.name, '结束后揭晓目标人物', `目标=${reviewA.data?.reveal?.character?.name}`);
  check(JSON.stringify(reviewB.data).includes('他是男性吗'), '复盘里能看到每个人的问答');
  check(!!reviewC.data?.reveal, '观战者结束后也能看复盘');
  check(!!reviewA.data?.reveal?.vote, '复盘留下投票现场快照');

  const hist = await api('/api/history/mine', { cookie: B });
  const race = (hist.data?.items ?? []).find((g) => g.id.startsWith(code));
  check(!!race, '对战局进了个人历史', race ? `result=${race.result} turns=${race.turnsUsed}` : '');

  const adminHist = await api('/api/admin/history?limit=5', { cookie: A, headers: adminHeaders });
  check((adminHist.data?.items ?? []).some((g) => g.id.startsWith(code)), '管理员后台也能看到对战局');

  console.log(`\n房间码 ${code} · 目标「${reviewA.data?.reveal?.character?.name}」· 失败项 ${failures}`);
  return failures;
}

main()
  .then((f) => process.exit(f ? 1 : 0))
  .catch((err) => {
    console.error('ERROR', err);
    process.exit(1);
  });
