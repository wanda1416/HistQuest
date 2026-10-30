/**
 * 对战（房间）线上冒烟 —— WebSocket 主通道。
 *
 *   node scripts/verify-race-ws.mjs
 *
 * 走的是 Durable Object 的 Hibernation WebSocket：握手 → 首帧快照 → 广播 → 思考态 →
 * WS 提问 → 猜错记账 → 观战者 → 投票 → 复盘广播 → 心跳。
 * 用 Node 自带的 WebSocket（undici）并带 Cookie —— 服务端只认会话 cookie。
 */
import fs from 'node:fs';

const HOST = process.env.HQ_WS_HOST ?? 'cailishi.wyxj.net';
const BASE = process.env.HQ_BASE_URL ?? 'https://cailishi.wyxj.net';
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
  const sc = res.headers.get('set-cookie');
  return { status: res.status, data, cookie: sc ? sc.split(';')[0] : null };
}

const adminHeaders = { 'x-hq-admin': '1' };

async function newPlayer(adminCookie, prefix) {
  const inv = await api('/api/admin/invites', { method: 'POST', body: { count: 1 }, cookie: adminCookie, headers: adminHeaders });
  const username = `${prefix}${Date.now().toString(36).slice(-5)}`;
  const reg = await api('/api/auth/register', {
    method: 'POST',
    body: { username, password: 'test-pass-123', invite: inv.data.codes[0] },
  });
  return { username, cookie: reg.cookie };
}

/** 打开房间 WS；返回 send/wait/close 三个动作 */
function openSocket(code, cookie) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${HOST}/api/room/${code}/ws`, { headers: { cookie } });
    const inbox = [];
    const waiters = [];
    const timer = setTimeout(() => reject(new Error('WS 握手超时')), 15000);

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      inbox.push(msg);
      for (const w of waiters.slice()) {
        if (w.match(msg)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(msg);
        }
      }
    };
    ws.onerror = () => reject(new Error('WS 连接失败（检查 cookie 与 Upgrade）'));
    ws.onopen = () => {
      clearTimeout(timer);
      resolve({
        readyState: () => ws.readyState,
        send: (obj) => ws.send(JSON.stringify(obj)),
        last: () => inbox[inbox.length - 1],
        wait: (match, ms = 25000) => {
          const hit = inbox.find(match);
          if (hit) return Promise.resolve(hit);
          return new Promise((res, rej) => {
            const t = setTimeout(() => rej(new Error('等待消息超时')), ms);
            waiters.push({ match, resolve: (m) => { clearTimeout(t); res(m); } });
          });
        },
        close: () => ws.close(),
      });
    };
  });
}

async function main() {
  const login = await api('/api/auth/login', { method: 'POST', body: { username: adminUser, password: adminPass } });
  check(!!login.cookie, '房主登录');

  const second = await newPlayer(login.cookie, 'wsr');
  check(!!second.cookie, '第二玩家注册', `user=${second.username}`);

  const created = await api('/api/rooms', { method: 'POST', body: { settings: { turnLimit: 12, difficulty: 1 } }, cookie: login.cookie });
  const code = created.data.code;
  check(!!code, '建房', `code=${code}`);
  if (!code) return 1;

  const sockA = await openSocket(code, login.cookie);
  check(sockA.readyState() === 1, '房主 WS 握手成功（101）');
  const first = await sockA.wait((m) => m.t === 'snapshot');
  check(first.room?.me?.role === 'host', 'WS 首帧快照', `role=${first.room?.me?.role} status=${first.room?.status}`);

  const sockB = await openSocket(code, second.cookie);
  const joined = await sockA.wait((m) => m.t === 'snapshot' && m.room?.players?.length === 2);
  check(joined.room.players.length === 2, '第二人进房时房主收到广播');

  sockA.send({ t: 'start' });
  const playing = await sockB.wait((m) => m.t === 'snapshot' && m.room?.status === 'playing');
  check(playing.room.status === 'playing', '开局广播到所有连接', `turns=${playing.room.me.turnsLeft}`);

  sockA.send({ t: 'ask', question: '他是男性吗' });
  await sockB.wait((m) => m.t === 'snapshot' && m.room?.players?.some((p) => p.thinking));
  check(true, '对手能看到"思考中"');

  const answered = await sockA.wait((m) => m.t === 'snapshot' && m.room?.me?.history?.length === 1, 30000);
  check(answered.room.me.history.length === 1, 'WS 提问拿到回答', `verdict=${answered.room.me.history[0].verdict} 剩 ${answered.room.me.turnsLeft} 轮`);
  check(!JSON.stringify(sockB.last()).includes('他是男性吗'), '对手的广播里没有房主的问题原文');

  sockA.send({ t: 'guess', name: '秦始皇' });
  const guessed = await sockA.wait((m) => m.t === 'snapshot' && m.room?.me?.guesses === 1);
  check(guessed.room.me.guesses === 1, 'WS 猜错被记账', `剩 ${guessed.room.me.turnsLeft} 轮`);

  const spectator = await newPlayer(login.cookie, 'wsp');
  const sockC = await openSocket(code, spectator.cookie);
  const specView = await sockC.wait((m) => m.t === 'snapshot');
  check(specView.room.me.role === 'spectator', 'WS 中途加入 = 观战者');
  check(specView.room.me.history === undefined, '观战者快照没有历史字段');
  check(!JSON.stringify(specView).includes('他是男性吗'), '观战者看不到别人的问题');

  sockA.send({ t: 'open-vote' });
  await sockB.wait((m) => m.t === 'snapshot' && m.room?.vote?.votes === 1);
  sockB.send({ t: 'cast-vote' });
  const done = await sockC.wait((m) => m.t === 'snapshot' && m.room?.status === 'finished');
  check(done.room.status === 'finished', 'WS 投票过半 → 立即结束', `reason=${done.room.endReason}`);
  check(!!done.room.reveal?.character?.name, '结束后观战者也收到揭晓', `目标=${done.room.reveal?.character?.name}`);
  check(JSON.stringify(done.room).includes('他是男性吗'), '复盘广播包含全部问答');

  sockA.send({ t: 'ping' });
  await new Promise((r) => setTimeout(r, 800));
  check(sockA.readyState() === 1, 'ping 心跳后连接仍在线');

  sockA.close();
  sockB.close();
  sockC.close();

  console.log(`\n房间码 ${code} · 失败项 ${failures}`);
  return failures;
}

main()
  .then((f) => setTimeout(() => process.exit(f ? 1 : 0), 300))
  .catch((err) => {
    console.error('ERROR', err?.message ?? err);
    process.exit(1);
  });
