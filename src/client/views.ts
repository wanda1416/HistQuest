import type { State } from './store.ts';
import type { RecordView } from '../shared/protocol.ts';

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const VERDICT_LABEL: Record<string, string> = { yes: '是', no: '否', unknown: '无法判断' };

function fmtYear(year: number | null): string {
  if (year === null || year === undefined) return '不详';
  return year < 0 ? `公元前 ${Math.abs(year)} 年` : `${year} 年`;
}

function topbar(s: State): string {
  const model = s.config?.model;
  return `
  <header class="topbar">
    <div class="brand">
      <span class="seal">猜</span>
      <div>
        <h1 class="brand-title">猜历史</h1>
        <p class="brand-sub">二十问 · 猜人物</p>
      </div>
    </div>
    <div class="topbar-actions">
      ${
        model
          ? `<span class="chip"><i class="chip-dot"></i>${esc(model)}</span>`
          : `<span class="chip chip-off"><i class="chip-dot"></i>未接模型</span>`
      }
      <button class="btn btn-ghost" data-action="go-setup">设置</button>
    </div>
  </header>`;
}

function notice(s: State): string {
  if (!s.notice) return '';
  return `<div class="notice notice-${s.notice.kind}">${esc(s.notice.text)}</div>`;
}

function shell(s: State, body: string): string {
  return `${topbar(s)}<main class="stage">${notice(s)}${body}</main>`;
}

/* ---------------- 设置 / 引导 ---------------- */

function setupView(s: State): string {
  const c = s.config;
  const isFirst = !c;
  const t = s.testResult;

  const testLine = t
    ? t.ok
      ? `<p class="testline ok">连接正常，响应 ${t.latencyMs} ms</p>`
      : `<p class="testline fail">${esc(t.message ?? '连接失败')}</p>`
    : '';

  return shell(
    s,
    `
    <section class="setup split">
      <div class="split-main">
        <div class="setup-intro">
          <p class="eyebrow">${isFirst ? '开始之前' : '设置'}</p>
          <h2>${isFirst ? '先接上你的模型' : '模型与连接'}</h2>
          <p class="lede">这个游戏靠模型把你的问题翻译成"可判定的事实提问"，所以没有模型就无法开局。密钥只保存在本机浏览器里，只发给你自己运行的这服务。</p>
        </div>

        <form class="panel" data-role="config-form">
          <div class="field">
            <label class="field-label" for="baseURL">API 地址</label>
            <input class="input" id="baseURL" name="baseURL" placeholder="https://api.deepseek.com/v1"
              value="${esc(c?.baseURL ?? '')}" autocomplete="off" spellcheck="false" />
            <p class="field-hint">OpenAI 兼容端点。填域名即可，缺少 /v1 会自动补上。</p>
          </div>

          <div class="field">
            <label class="field-label" for="apiKey">API 密钥</label>
            <input class="input" id="apiKey" name="apiKey" type="password" placeholder="sk-..."
              value="${esc(c?.apiKey ?? '')}" autocomplete="off" spellcheck="false" />
            <p class="field-hint">只存在本机 localStorage；不会出现在日志、地址栏或任何分享内容里。</p>
          </div>

          <div class="field-row">
            <div class="field">
              <label class="field-label" for="model">模型名</label>
              <input class="input" id="model" name="model" placeholder="deepseek-chat"
                value="${esc(c?.model ?? '')}" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field field-narrow">
              <label class="field-label" for="temperature">温度</label>
              <input class="input" id="temperature" name="temperature" type="number" min="0" max="1" step="0.1"
                value="${esc(c?.temperature ?? 0.1)}" />
            </div>
          </div>

          ${testLine}

          <div class="actions">
            <button type="button" class="btn btn-ghost" data-action="test-ai">测试连接</button>
            <button type="submit" class="btn btn-primary">保存并进入</button>
            ${isFirst ? '' : '<button type="button" class="btn btn-text" data-action="back">返回</button>'}
          </div>
        </form>

        <p class="footnote">人物库 ${s.meta?.characterCount ?? 0} 位，均为已故历史人物。判定只依据索引里的人工资讯，模型不负责编事实。</p>
      </div>

      <aside class="aside-card">
        <h3>为什么必须先接模型</h3>
        <p>索引只提供"事实"。把一句中文问法翻译成"朝代 / 身份 / 籍贯"这类可判定字段，是模型在做的事——它不认识目标人物，只做翻译。</p>
        <h3>密钥去了哪里</h3>
        <ul>
          <li>只存在这台设备的浏览器</li>
          <li>只发给你自己运行的服务</li>
          <li>不写日志、不进地址栏</li>
          <li>不会出现在分享内容里</li>
        </ul>
      </aside>
    </section>`,
  );
}

/* ---------------- 开局 ---------------- */

function lobbyView(s: State): string {
  const meta = s.meta;
  const difficulties = meta?.difficulties ?? [
    { level: 1, label: '入门', desc: '' },
    { level: 2, label: '进阶', desc: '' },
    { level: 3, label: '考据', desc: '' },
  ];

  const diffChips = difficulties
    .map(
      (d) => `
      <button class="chip-select ${s.difficulty === d.level ? 'is-active' : ''}"
        data-action="pick-difficulty" data-value="${d.level}">
        <b>${esc(d.label)}</b><span>${esc(d.desc)}</span>
      </button>`,
    )
    .join('');

  const dynasties = ['不限', ...(meta?.dynasties ?? [])];
  const dynChips = dynasties
    .map((d) => {
      const value = d === '不限' ? '' : d;
      const active = d === '不限' ? s.dynasty === null : s.dynasty === d;
      return `<button class="chip-select chip-sm ${active ? 'is-active' : ''}"
        data-action="pick-dynasty" data-value="${esc(value)}">${esc(d)}</button>`;
    })
    .join('');

  const modeChips = [
    { value: 'strict', title: '精确', desc: '只回 是 / 否 / 无法判断' },
    { value: 'guided', title: '解说', desc: '答案后补一句判定口径' },
  ]
    .map(
      (m) => `
      <button class="chip-select ${s.mode === m.value ? 'is-active' : ''}"
        data-action="pick-mode" data-value="${m.value}">
        <b>${esc(m.title)}</b><span>${esc(m.desc)}</span>
      </button>`,
    )
    .join('');

  return shell(
    s,
    `
    <section class="lobby split">
      <div class="split-main">
        <div class="lobby-head">
          <p class="eyebrow">开局</p>
          <h2>锁定一个人物</h2>
          <p class="lede">选好范围后，服务端会随机挑一位并锁死，整局不变——刷新、关页面再回来，答案都是同一个人。</p>
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
          <span class="group-label">朝代</span>
          <div class="chips chips-wrap">${dynChips}</div>
        </div>

        <div class="lobby-actions">
          <button class="btn btn-primary btn-lg" data-action="start-game" ${s.pending ? 'disabled' : ''}>
            ${s.pending ? '正在开局…' : '开局'}
          </button>
          <span class="muted">默认 ${meta?.maxTurns ?? 20} 问</span>
        </div>
      </div>

      <aside class="aside-card">
        <h3>规则</h3>
        <ol>
          <li>每一问只能用"是 / 否"回答</li>
          <li>每问消耗一次机会</li>
          <li>猜错同样扣一次</li>
          <li>主观评价会被直接挡掉</li>
        </ol>
        <h3>小技巧</h3>
        <p>先定朝代和性别，再收窄到身份，最后一问确认代表作——二十问通常够用。</p>
      </aside>
    </section>`,
  );
}

/* ---------------- 对局 ---------------- */

function turnView(r: RecordView): string {
  const isFormat = r.invalid === 'format';
  const cls = r.invalid ? (isFormat ? 'v-format' : 'v-invalid') : `v-${r.verdict}`;
  const label = r.invalid ? (isFormat ? '改问法' : '无效') : (VERDICT_LABEL[r.verdict] ?? '');
  const hint = r.hint ? `<span class="hint">${esc(r.hint)}</span>` : '';
  const variant = isFormat ? 'is-format' : r.invalid ? 'is-invalid' : '';
  return `
    <div class="turn turn-q"><p>${esc(r.question)}</p></div>
    <div class="turn turn-a ${variant}">
      <span class="verdict ${cls}">${esc(label)}</span>
      <p>${esc(r.text)}${hint}</p>
    </div>`;
}

function examples(): string {
  const samples = ['他是唐朝人吗？', '他当过皇帝吗？', '他是诗人吗？', '他名字是两个字吗？', '他活在公元后吗？'];
  return `<div class="examples"><p class="examples-title">试试这样问</p><div class="chips chips-wrap">
    ${samples.map((q) => `<button class="chip-select chip-sm" data-action="fill-example" data-value="${esc(q)}">${esc(q)}</button>`).join('')}
  </div></div>`;
}

function gameView(s: State): string {
  const session = s.session;
  if (!session) return lobbyView(s);

  const max = s.meta?.maxTurns ?? 20;
  const ratio = Math.max(0, Math.min(1, session.turnsLeft / max));
  const asked = session.history.filter((h) => !h.invalid).length;

  const log = session.history.length
    ? session.history.map(turnView).join('')
    : examples();

  const thinking = s.pending
    ? `<div class="turn turn-a turn-thinking"><span class="verdict v-wait">判定中</span><p class="thinking"><i></i><i></i><i></i></p></div>`
    : '';

  return shell(
    s,
    `
    <section class="board">
      <aside class="rail">
        <div class="target">
          <div class="target-seal">？</div>
          <div>
            <p class="target-label">目标人物</p>
            <p class="target-hint">开局已锁定</p>
          </div>
        </div>

        <div class="counter">
          <span class="counter-num">${session.turnsLeft}</span>
          <span class="counter-label">剩余提问</span>
          <div class="counter-bar"><i style="width:${Math.round(ratio * 100)}%"></i></div>
        </div>

        <div class="rail-actions">
          <button class="btn btn-primary" data-action="open-guess" ${s.pending ? 'disabled' : ''}>我猜是…</button>
          <button class="btn btn-ghost" data-action="reveal" ${s.pending ? 'disabled' : ''}>放弃并揭晓</button>
        </div>

        <p class="rail-note">只有能被"是/否"回答的问题才算线索。主观评价会被直接挡掉。</p>
      </aside>

      <section class="stream">
        <div class="stream-head">
          <span>第 <b>${asked + (s.pending ? 1 : 0)}</b> 问</span>
          <i class="dot"></i>
          <span>${esc(diffLabel(s))}</span>
          ${session.dynasty ? `<i class="dot"></i><span>${esc(session.dynasty)}</span>` : ''}
          ${session.mode === 'guided' ? '<i class="dot"></i><span>解说</span>' : ''}
        </div>

        <div class="log" data-role="log">
          ${log}
          ${thinking}
        </div>

        <form class="composer" data-role="ask-form">
          <input class="composer-input" name="question" data-role="ask-input" maxlength="200"
            placeholder="问一个能用是/否回答的问题…" autocomplete="off" ${s.pending ? 'disabled' : ''} />
          <button class="btn btn-send" type="submit" ${s.pending ? 'disabled' : ''}>问</button>
        </form>
      </section>
    </section>
    ${s.guessOpen ? guessDialog(s) : ''}`,
  );
}

function diffLabel(s: State): string {
  const d = s.session?.difficulty ?? s.difficulty;
  const found = s.meta?.difficulties.find((x) => x.level === d);
  return found ? found.label : `难度 ${d}`;
}

function guessDialog(s: State): string {
  return `
  <div class="dialog-mask" data-mask="1">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="猜人物">
      <p class="eyebrow">抢答</p>
      <h3 class="dialog-title">你猜是谁？</h3>
      <p class="dialog-hint">猜错会消耗一次提问机会。别名也算对。</p>
      <input class="input" name="guess" data-role="guess-input" placeholder="输入人物姓名" autocomplete="off" />
      ${s.guessError ? `<p class="testline fail">${esc(s.guessError)}</p>` : ''}
      <div class="dialog-actions">
        <button class="btn btn-text" data-action="close-guess">取消</button>
        <button class="btn btn-primary" data-action="do-guess">提交</button>
      </div>
    </div>
  </div>`;
}

/* ---------------- 揭晓 ---------------- */

function revealView(s: State): string {
  const r = s.reveal;
  if (!r) return gameView(s);
  const c = r.character;
  const won = r.status === 'won';

  const facts = [
    ['朝代', c.dynasty],
    ['身份', c.roles.join('、') || '—'],
    ['生卒', `${fmtYear(c.birth)} — ${fmtYear(c.death)}`],
    ['籍贯', c.birthplace ?? '不详'],
  ]
    .map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');

  const review = r.history.length
    ? r.history
        .map((h) => {
          const isFormat = h.invalid === 'format';
          const cls = h.invalid ? (isFormat ? 'v-format' : 'v-invalid') : `v-${h.verdict}`;
          const label = h.invalid ? (isFormat ? '改问法' : '无效') : VERDICT_LABEL[h.verdict];
          return `
        <li>
          <span class="review-q">${esc(h.question)}</span>
          <span class="verdict ${cls}">${esc(label)}</span>
        </li>`;
        })
        .join('')
    : '<li class="muted">这一局没有提问就结束了。</li>';

  return shell(
    s,
    `
    <section class="reveal">
      <div class="reveal-card">
        <span class="ribbon">${won ? '猜中' : '揭晓'}</span>
        <div class="seal seal-lg">${esc(c.name.slice(0, 1))}</div>
        <h2 class="reveal-name">${esc(c.name)}</h2>
        <p class="reveal-identity">${esc(c.dynasty)}${c.aliases.length ? ` · 又称 ${esc(c.aliases.slice(0, 2).join('、'))}` : ''}</p>
        <dl class="facts">${facts}</dl>
        <p class="notable">${esc(c.notable)}</p>
        <div class="reveal-actions">
          <button class="btn btn-primary" data-action="new-game">再来一局</button>
          <button class="btn btn-ghost" data-action="go-setup">设置</button>
        </div>
      </div>

      <div class="review">
        <h3>对局回顾 <span class="muted">· 用了 ${r.turnsUsed} 问</span></h3>
        <ol class="review-list">${review}</ol>
      </div>
    </section>`,
  );
}

export function renderApp(s: State): string {
  if (!s.ready) {
    return `<div class="boot"><div class="boot-seal">猜</div><p>正在载入…</p></div>`;
  }
  switch (s.view) {
    case 'setup':
      return setupView(s);
    case 'lobby':
      return lobbyView(s);
    case 'reveal':
      return revealView(s);
    default:
      return gameView(s);
  }
}
