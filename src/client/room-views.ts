import type { State } from './store.ts';
import type { RoomPlayerView, RoomReveal, RoomSnapshot } from '../shared/room.ts';
import { ROOM } from '../shared/room.ts';
import { esc, shell, voiceButton } from './views.ts';

/**
 * 对战的四个屏幕：大厅 / 房间（未开局）/ 对抗 / 复盘。
 *
 * 一条硬规则：**对手的问答在客户端根本不存在**——服务端投影就不生成那些字段，
 * 所以这里也不需要"隐藏逻辑"，没有可隐藏的东西。
 */

const VERDICT_LABEL: Record<string, string> = { yes: '是', no: '否', unknown: '无法判断' };

const DIFF_LABEL: Record<number, string> = { 1: '入门', 2: '进阶', 3: '考据' };

const SCOPE_LABEL: Record<string, string> = { cn: '中国', world: '世界', mixed: '混合' };

const STATUS_LABEL: Record<string, string> = {
  waiting: '未开局',
  playing: '在局',
  guessed: '已猜中',
  exhausted: '轮次用尽',
  gave_up: '已放弃',
  left: '已离开',
};

const END_LABEL: Record<string, string> = {
  guess: '有人猜中',
  vote: '投票结束',
  exhausted: '全员轮次用尽',
  'last-man': '只剩一人',
  stale: '闲置清理',
  'host-closed': '房主关闭',
};

function noticeLine(s: State): string {
  if (!s.roomError) return '';
  return `<div class="notice notice-error">${esc(s.roomError)}</div>`;
}

function channelChip(s: State): string {
  const map: Record<string, [string, string]> = {
    ws: ['实时', 'chip-live'],
    polling: ['轮询', 'chip-slow'],
    connecting: ['连接中', 'chip-slow'],
    off: ['未连接', 'chip-off'],
  };
  const [label, cls] = map[s.roomChannel] ?? ['未连接', 'chip-off'];
  return `<span class="chip ${cls}"><i class="chip-dot"></i>${esc(label)}</span>`;
}

export function renderRoomApp(s: State): string {
  switch (s.view) {
    case 'room':
      return roomView(s);
    case 'race':
      return raceView(s);
    case 'review':
      return reviewView(s);
    default:
      return roomsView(s);
  }
}

/* ---------------- 大厅 ---------------- */

function createForm(s: State): string {
  const turnOptions = [10, 15, 20, 30, 40, 50].filter((t) => t >= ROOM.turnMin && t <= ROOM.turnMax);
  const turnChips = turnOptions
    .map(
      (t) => `<button class="chip-select chip-sm ${s.roomTurnLimit === t ? 'is-active' : ''}"
        data-action="pick-room-turns" data-value="${t}">${t} 轮</button>`,
    )
    .join('');

  const diffChips = [1, 2, 3]
    .map(
      (d) => `<button class="chip-select chip-sm ${s.roomDifficulty === d ? 'is-active' : ''}"
        data-action="pick-room-difficulty" data-value="${d}">${esc(DIFF_LABEL[d])}</button>`,
    )
    .join('');

  const modeChips = [
    { value: 'strict', title: '精确' },
    { value: 'guided', title: '解说' },
  ]
    .map(
      (m) => `<button class="chip-select chip-sm ${s.roomMode === m.value ? 'is-active' : ''}"
        data-action="pick-room-mode" data-value="${m.value}">${esc(m.title)}</button>`,
    )
    .join('');

  const scopeChips = ['mixed', 'cn', 'world']
    .map(
      (v) => `<button class="chip-select chip-sm ${s.roomScope === v ? 'is-active' : ''}"
        data-action="pick-room-scope" data-value="${v}">${esc(SCOPE_LABEL[v])}</button>`,
    )
    .join('');

  const targetScopeChips = [
    { value: 'global', label: '公共题库' },
    { value: 'host', label: '我的题库' },
  ]
    .map(
      (v) => `<button class="chip-select chip-sm ${s.roomTargetScope === v.value ? 'is-active' : ''}"
        data-action="pick-room-target-scope" data-value="${v.value}">${esc(v.label)}</button>`,
    )
    .join('');

  return `
  <div class="panel room-create">
    <div class="group">
      <span class="group-label">每人轮次</span>
      <div class="chips">${turnChips}</div>
      <p class="field-hint">同一目标、各问各的，轮次用完就出局；猜错也算一轮。</p>
    </div>
    <div class="group">
      <span class="group-label">难度</span>
      <div class="chips">${diffChips}</div>
    </div>
    <div class="group">
      <span class="group-label">回答模式</span>
      <div class="chips">${modeChips}</div>
    </div>
    <div class="group">
      <span class="group-label">人物范围</span>
      <div class="chips">${scopeChips}</div>
    </div>
    <div class="group">
      <span class="group-label">谜底范围</span>
      <div class="chips">${targetScopeChips}</div>
      <p class="field-hint">「我的题库」= 从你自定义题库里已通过审核的条目中随机选谜底。</p>
    </div>
    <div class="group">
      <span class="group-label">公开</span>
      <div class="chips">
        <button class="chip-select chip-sm ${s.roomListed ? 'is-active' : ''}"
          data-action="toggle-room-listed" data-value="1">列在大厅</button>
        <button class="chip-select chip-sm ${s.roomListed ? '' : 'is-active'}"
          data-action="toggle-room-listed" data-value="0">只发链接</button>
      </div>
    </div>
    <div class="actions">
      <button class="btn btn-primary" data-action="create-room" ${s.roomBusy ? 'disabled' : ''}>
        ${s.roomBusy ? '正在建房…' : '开一间房'}
      </button>
    </div>
  </div>`;
}

function roomRows(s: State): string {
  if (s.rooms === null) return `<p class="field-hint">正在载入房间…</p>`;
  if (!s.rooms.length) {
    return `<p class="field-hint">还没有公开的房间。开一间，把链接或房号发给朋友。</p>`;
  }
  return s.rooms
    .map(
      (r) => `
    <li class="room-row">
      <div class="room-row-main">
        <span class="room-code">${esc(r.code)}</span>
        <span class="room-meta">
          房主 ${esc(r.hostName || '—')} · ${r.players}/${r.maxPlayers} 人 ·
          ${r.turnLimit} 轮 · ${esc(DIFF_LABEL[r.difficulty] ?? '')}
          ${r.status === 'playing' ? '<b class="room-tag">已开局</b>' : ''}
        </span>
      </div>
      <div class="room-row-actions">
        ${
          r.status === 'playing'
            ? `<button class="btn btn-ghost btn-sm" data-action="watch-room" data-code="${esc(r.code)}">观战</button>`
            : `<button class="btn btn-primary btn-sm" data-action="enter-room" data-code="${esc(r.code)}">加入</button>`
        }
      </div>
    </li>`,
    )
    .join('');
}

export function roomsView(s: State): string {
  return shell(
    s,
    `
    ${noticeLine(s)}
    <section class="rooms">
      <div class="rooms-head">
        <div>
          <p class="eyebrow">对战</p>
          <h2>同一个目标，谁先猜中谁赢</h2>
          <p class="lede">每人一条自己的提问轨道，轮次各自计算；对手只看得见你用了几轮，看不见你问了什么。结束后全员公开问答，用于复盘。</p>
        </div>
      </div>

      <div class="rooms-split">
        <div>
          <form class="join-form" data-role="join-form">
            <label class="field-label" for="joinCode">有房号？直接进</label>
            <div class="join-row">
              <input class="input input-code" id="joinCode" name="code" maxlength="12"
                placeholder="6 位房号，例如 K7M2QP" value="${esc(s.joinCode)}" autocomplete="off" />
              <button type="submit" class="btn btn-primary" ${s.roomBusy ? 'disabled' : ''}>加入</button>
            </div>
          </form>

          <h3 class="section-title">公开房间</h3>
          <ul class="room-list">${roomRows(s)}</ul>
          <div class="actions">
            <button class="btn btn-text" data-action="refresh-rooms">刷新</button>
          </div>
        </div>

        <aside>
          ${createForm(s)}
          <div class="aside-card">
            <h3>规则</h3>
            <ol>
              <li>全员同一个目标人物，各自独立提问</li>
              <li>每人轮次由房主开局前设定（${ROOM.turnMin}–${ROOM.turnMax}）</li>
              <li>第一个猜中的人赢，房间立即结算</li>
              <li>没人猜中时，房主可发起结束投票，在线人数过半同意即揭晓</li>
              <li>结束前看不到对手的问答，只看得到他用了几轮</li>
            </ol>
          </div>
        </aside>
      </div>
    </section>`,
  );
}

/* ---------------- 房间（未开局） ---------------- */

function playerLine(p: RoomPlayerView, isMe: boolean): string {
  return `
    <li class="player-line">
      <span class="player-name">${esc(p.name)}${isMe ? '<small>（我）</small>' : ''}</span>
      ${p.isHost ? '<span class="room-tag">房主</span>' : ''}
      <span class="player-state ${p.online ? 'is-online' : 'is-offline'}">
        ${p.online ? '在线' : '离线'}
      </span>
    </li>`;
}

export function roomView(s: State): string {
  const room = s.room;
  if (!room) return shell(s, `${noticeLine(s)}<p class="field-hint">正在进入房间…</p>`);

  const me = room.me;
  const isHost = me.role === 'host';
  const enough = room.players.length >= ROOM.playersMin;

  const turnChips = [10, 15, 20, 30, 40, 50]
    .map(
      (t) => `<button class="chip-select chip-sm ${room.settings.turnLimit === t ? 'is-active' : ''}"
        data-action="pick-room-turns" data-value="${t}" ${isHost ? '' : 'disabled'}>${t} 轮</button>`,
    )
    .join('');

  const where = room.settings.polity ?? room.settings.worldEra ?? (room.settings.region === 'cn' ? '中国' : room.settings.region ? '世界' : '中外混合');

  return shell(
    s,
    `
    ${noticeLine(s)}
    <section class="room-wait">
      <div class="room-head">
        <div>
          <p class="eyebrow">房间</p>
          <h2 class="room-big-code">${esc(room.code)}</h2>
          <p class="lede">
            ${esc(where)} · 每人 ${room.settings.turnLimit} 轮 ·
            ${esc(DIFF_LABEL[room.settings.difficulty] ?? '')} · ${room.settings.mode === 'guided' ? '解说' : '精确'}
          </p>
        </div>
        <div class="room-head-actions">
          ${channelChip(s)}
          <button class="btn btn-ghost" data-action="copy-room-link">复制邀请链接</button>
          <button class="btn btn-ghost" data-action="go-rooms">回大厅</button>
        </div>
      </div>

      <div class="rooms-split">
        <div class="panel">
          <h3 class="section-title">玩家（${room.players.length}/${room.settings.maxPlayers}）</h3>
          <ul class="player-list">
            ${room.players.map((p) => playerLine(p, p.userId === me.userId)).join('')}
          </ul>
          ${room.spectators ? `<p class="field-hint">另有 ${room.spectators} 位观战者</p>` : ''}

          <div class="group">
            <span class="group-label">每人轮次</span>
            <div class="chips">${turnChips}</div>
            ${isHost ? '' : '<p class="field-hint">只有房主能改设置。</p>'}
          </div>

          <div class="actions">
            ${
              isHost
                ? `<button class="btn btn-primary btn-lg" data-action="room-start" ${enough && !s.roomBusy ? '' : 'disabled'}>
                     ${enough ? '开始对局' : '至少 2 人才能开始'}
                   </button>`
                : `<span class="muted">等房主开始…</span>`
            }
            <button class="btn btn-text" data-action="room-leave">离开房间</button>
          </div>
        </div>

        <aside class="aside-card">
          <h3>怎么算赢</h3>
          <ol>
            <li>点名猜中 → 全场立即结束，你赢</li>
            <li>提问里说中了目标名 → 同样算赢</li>
            <li>猜错扣 1 轮</li>
            <li>轮到用尽就出局，但还在房里看得到后续与复盘</li>
          </ol>
          <h3>看不到什么</h3>
          <p>对手的问题与判定全程不可见，只有轮次和猜错次数；结束之后才一起公开。</p>
        </aside>
      </div>
    </section>`,
  );
}

/* ---------------- 对抗 ---------------- */

function boardRows(room: RoomSnapshot): string {
  const rows = room.players
    .map((p) => {
      const used = Math.min(p.turnsTotal, p.turnsUsed);
      const total = p.turnsTotal || 1;
      const pct = Math.round((used / total) * 100);
      const me = p.userId === room.me.userId;
      const stateTag =
        p.status === 'guessed'
          ? '<b class="room-tag room-tag-win">猜中</b>'
          : p.status === 'exhausted'
            ? '<b class="room-tag">用尽</b>'
            : p.thinking
              ? '<b class="room-tag room-tag-live">思考中</b>'
              : '';
      return `
      <li class="board-row ${me ? 'is-me' : ''}">
        <span class="board-rank">${p.rank}</span>
        <span class="board-name">${esc(p.name)}${me ? '<small>（我）</small>' : ''}${
          p.online ? '' : '<i class="board-offline">离线</i>'
        }</span>
        <span class="board-bar"><i style="width:${pct}%"></i></span>
        <span class="board-turns">${p.turnsUsed}/${p.turnsTotal}</span>
        <span class="board-guess">错 ${p.guesses}</span>
        ${stateTag}
      </li>`;
    })
    .join('');
  return `<ul class="race-board-list">${rows}</ul>`;
}

function myLog(room: RoomSnapshot): string {
  const history = room.me.history ?? [];
  if (!history.length) {
    return `<p class="field-hint">还没有提问。先定时期和性别，再收窄身份。</p>`;
  }
  return `<ol class="race-log">${history
    .map((r) => {
      const isFormat = Boolean(r.invalid);
      const cls = isFormat ? 'v-format' : `v-${r.verdict}`;
      return `
      <li class="race-turn ${cls}">
        <span class="race-seq">${r.seq}</span>
        <div class="race-body">
          <p class="race-q">${esc(r.question)}</p>
          <p class="race-a"><b>${isFormat ? '换个问法' : esc(VERDICT_LABEL[r.verdict] ?? r.verdict)}</b>
            <span>${esc(r.text)}</span></p>
          ${r.hint ? `<p class="race-hint">${esc(r.hint)}</p>` : ''}
        </div>
      </li>`;
    })
    .join('')}</ol>`;
}

function voteBar(room: RoomSnapshot): string {
  const vote = room.vote;
  const me = room.me;
  if (!vote) {
    if (!me.canOpenVote) return '';
    return `
    <div class="vote-bar">
      <p>卡住了？发起结束投票，在线人数过半同意就揭晓。</p>
      <button class="btn btn-ghost" data-action="vote-open">发起结束投票</button>
    </div>`;
  }
  return `
  <div class="vote-bar is-open">
    <p><b>${esc(vote.byName)}</b> 发起了结束投票：<b>${vote.votes}/${vote.need}</b>
      ${vote.onlineCount ? `（在线 ${vote.onlineCount} 人）` : ''}</p>
    <p class="vote-voters">${vote.voters.length ? '已投：' + vote.voters.map(esc).join('、') : '还没有人投票'}</p>
    <div class="actions">
      ${
        vote.mine
          ? '<span class="muted">你已经投了赞成</span>'
          : '<button class="btn btn-primary" data-action="vote-cast">我同意结束</button>'
      }
      ${
        me.role === 'host'
          ? '<button class="btn btn-text" data-action="vote-cancel">撤销投票</button>'
          : ''
      }
    </div>
  </div>`;
}

export function raceView(s: State): string {
  const room = s.room;
  if (!room) return shell(s, `${noticeLine(s)}<p class="field-hint">正在进入房间…</p>`);

  const me = room.me;
  const spectator = me.role === 'spectator';
  const outOfTurns = (me.turnsLeft ?? 0) <= 0;
  const locked = spectator || me.status !== 'playing' || outOfTurns || Boolean(me.pending) || s.roomBusy;

  const statusLine = spectator
    ? `<p class="field-hint">你在观战：看得到每个人的进度，看不到任何人的问答。</p>`
    : outOfTurns
      ? `<p class="field-hint">你的轮次用完了，可以继续看别人打到最后。</p>`
      : '';

  return shell(
    s,
    `
    ${noticeLine(s)}
    <section class="race">
      <div class="race-head">
        <div class="race-target">
          <p class="eyebrow">目标人物</p>
          <h2 class="race-unknown">？？？</h2>
          <p class="field-hint">房间 ${esc(room.code)} · 每人 ${room.settings.turnLimit} 轮${spectator ? ' · 观战中' : ''}</p>
        </div>
        <div class="race-meter">
          <span class="meter-label">我的轮次</span>
          <span class="meter-value">${me.turnsLeft ?? 0}<small>/${me.turnsTotal ?? 0}</small></span>
          <span class="meter-guess">猜错 ${me.guesses ?? 0}</span>
        </div>
        <div class="room-head-actions">
          ${channelChip(s)}
          <button class="btn btn-ghost" data-action="go-rooms">大厅</button>
        </div>
      </div>

      ${spectator ? '' : voteBar(room)}

      ${statusLine}

      <div class="race-split">
        <div class="panel race-board">
          <h3 class="section-title">进度榜</h3>
          ${boardRows(room)}
          <p class="field-hint">只公开"用了几轮、猜错几次、是否在思考"；问答对别人不可见。</p>
        </div>

        <div class="panel race-mine">
          <h3 class="section-title">我的问答</h3>
          ${spectator ? '<p class="field-hint">观战者没有自己的问答。</p>' : myLog(room)}
          ${
            spectator
              ? ''
              : `<form class="ask-form" data-role="race-ask-form">
                   ${voiceButton(s, 'race-voice')}
                   <input class="input" data-role="race-ask-input" name="question"
                     placeholder="用是/否能回答的问题，例如「他是男性吗」"
                     ${locked ? 'disabled' : ''} autocomplete="off" />
                   <button type="submit" class="btn btn-primary" ${locked ? 'disabled' : ''}>
                     ${me.pending ? '思考中…' : '提问'}
                   </button>
                 </form>
                 <div class="actions">
                   <button class="btn btn-ghost" data-action="race-guess-open" ${
                     locked ? 'disabled' : ''
                   }>我猜是…</button>
                   <button class="btn btn-text" data-action="race-abandon" ${
                     locked ? 'disabled' : ''
                   }>放弃本局</button>
                 </div>`
          }
        </div>
      </div>

      ${s.raceGuessOpen ? guessModal(s) : ''}
    </section>`,
  );
}

function guessModal(s: State): string {
  return `
  <div class="dialog-mask" data-mask="race-guess">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="猜人物">
      <h2 class="dialog-title">你猜是谁？</h2>
      <p class="dialog-hint">猜错扣 1 轮；猜中即全场结束。</p>
      ${s.raceGuessError ? `<p class="testline fail">${esc(s.raceGuessError)}</p>` : ''}
      <input class="input" data-role="race-guess-input" placeholder="人物姓名或别称" autocomplete="off" />
      <div class="dialog-actions">
        <button class="btn btn-text" data-action="race-guess-close">取消</button>
        <button class="btn btn-primary" data-action="race-guess-submit">提交</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 复盘 ---------------- */

function revealCard(reveal: RoomReveal): string {
  const c = reveal.character;
  const years =
    c.birth !== null || c.death !== null
      ? `${c.birth === null ? '?' : c.birth}—${c.death === null ? '?' : c.death}`
      : '生卒不详';
  return `
  <div class="panel reveal-card">
    <p class="eyebrow">答案是</p>
    <h2 class="reveal-name">${esc(c.name)}</h2>
    <p class="reveal-meta">${esc(c.polity)} · ${esc(years)} · ${esc(c.roles.join('、') || '—')}</p>
    ${c.aliases.length ? `<p class="field-hint">别称：${esc(c.aliases.join('、'))}</p>` : ''}
    <p class="reveal-notable">${esc(c.notable)}</p>
  </div>`;
}

function reviewPlayer(p: RoomReveal['players'][number], isWinner: boolean): string {
  const flagMap = new Map(p.flags.map((f) => [f.seq, f.reasons]));
  const rows = p.history
    .map((r) => {
      const reasons = flagMap.get(r.seq) ?? [];
      const isFormat = Boolean(r.invalid);
      return `
      <li class="review-turn ${reasons.length ? 'is-flag' : ''} ${isFormat ? 'v-format' : `v-${r.verdict}`}">
        <span class="race-seq">${r.seq}</span>
        <div class="race-body">
          <p class="race-q">${esc(r.question)}</p>
          <p class="race-a"><b>${isFormat ? '换个问法' : esc(VERDICT_LABEL[r.verdict] ?? r.verdict)}</b>
            <span>${esc(r.text)}</span></p>
          ${reasons.length ? `<p class="flag-line">⚠ ${esc(reasons.map(flagLabel).join('、'))}</p>` : ''}
        </div>
      </li>`;
    })
    .join('');

  return `
  <div class="panel review-player">
    <h3 class="review-head">
      <span class="board-rank">${p.rank}</span>
      ${esc(p.name)}
      ${isWinner ? '<b class="room-tag room-tag-win">赢家</b>' : ''}
      <small>用了 ${p.turnsUsed}/${p.turnsTotal} 轮 · 猜错 ${p.guesses} 次 · ${esc(STATUS_LABEL[p.status] ?? '')}</small>
    </h3>
    ${p.notes.length ? `<ul class="review-notes">${p.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    ${p.history.length ? `<ol class="race-log">${rows}</ol>` : '<p class="field-hint">这一局没有提问。</p>'}
  </div>`;
}

function flagLabel(reason: string): string {
  const map: Record<string, string> = {
    override: '指令覆盖',
    'ask-answer': '直接索答',
    encode: '编码绕过',
    structure: '结构注入',
    long: '超长问句',
    repeat: '反复重问',
  };
  return map[reason] ?? reason;
}

export function reviewView(s: State): string {
  const room = s.room;
  if (!room) return shell(s, `${noticeLine(s)}<p class="field-hint">正在载入复盘…</p>`);
  const reveal = room.reveal;
  if (!reveal) return shell(s, `${noticeLine(s)}<p class="field-hint">这一局还没结束。</p>`);

  const winner = reveal.players.find((p) => p.userId === reveal.winnerId);

  return shell(
    s,
    `
    ${noticeLine(s)}
    <section class="review">
      <div class="review-top">
        <div>
          <p class="eyebrow">复盘</p>
          <h2>${winner ? `${esc(winner.name)} 猜中了` : esc(END_LABEL[reveal.endReason ?? ''] ?? '本局结束')}</h2>
          <p class="lede">本局问答现在对所有人可见——包括中途加入的观战者。可疑提问带 ⚠ 标记，供人工复核。</p>
        </div>
        <div class="room-head-actions">
          <button class="btn btn-ghost" data-action="copy-review-room">复制复盘</button>
          <button class="btn btn-ghost" data-action="go-rooms">回大厅</button>
        </div>
      </div>

      <div class="review-grid">
        <div>${revealCard(reveal)}</div>
        <div class="panel review-meta">
          <h3 class="section-title">结算</h3>
          <ul class="kv">
            <li><span>结束方式</span><b>${esc(END_LABEL[reveal.endReason ?? ''] ?? '—')}</b></li>
            <li><span>房间</span><b>${esc(room.code)}</b></li>
            <li><span>参赛</span><b>${reveal.players.length} 人</b></li>
            <li><span>观战</span><b>${reveal.spectators} 人</b></li>
            ${
              reveal.vote
                ? `<li><span>投票</span><b>在线 ${reveal.vote.onlineCount} 人，需 ${reveal.vote.need} 票</b></li>`
                : ''
            }
          </ul>
          <p class="field-hint">对局记录已进「历史」，管理员也能在后台查到逐条问答。</p>
        </div>
      </div>

      <div class="review-list">
        ${reveal.players
          .map((p) => reviewPlayer(p, p.userId === reveal.winnerId))
          .join('')}
      </div>
    </section>`,
  );
}
