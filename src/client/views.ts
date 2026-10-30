import type { State } from './store.ts';
import { normalizeQuestion } from './store.ts';
import type { RecordView } from '../shared/protocol.ts';
import { WORLD_ERAS } from '../shared/domain.ts';

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
      <a class="btn btn-ghost" href="/admin.html" target="_blank" rel="noopener">管理</a>
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
          <p class="lede">模型用自己的历史知识回答你的问题，人物资料只用来校对。所以没有模型就无法开局。密钥只保存在本机浏览器里，只发给你自己运行的这服务。</p>
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

          <div class="field">
            <label class="field-label" for="model">模型名</label>
            <input class="input" id="model" name="model" placeholder="deepseek-chat"
              value="${esc(c?.model ?? '')}" autocomplete="off" spellcheck="false" />
            <p class="field-hint">判定调用固定用温度 0，保证同一问题答案稳定。</p>
          </div>

          ${testLine}

          <label class="switch-row">
            <input type="checkbox" name="neutralPronoun" ${s.pronoun === 'neutral' ? 'checked' : ''} />
            <span class="switch-text">
              <b>用「TA」代替他 / 她</b>
              <small>回答里不出现"他/她"，避免一个字就把性别卖了。只影响新开的局。</small>
            </span>
          </label>

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
        <p>判定靠模型的历史知识：问"他杀过韩信吗"，它得知道韩信是谁杀的。人物资料只是校对依据，模型拿不准时才以资料为准。</p>
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

  const polities = ['不限', ...(meta?.dynasties ?? [])];
  const polityChips = polities
    .map((d) => {
      const value = d === '不限' ? '' : d;
      const active = d === '不限' ? s.polity === null : s.polity === d;
      return `<button class="chip-select chip-sm ${active ? 'is-active' : ''}"
        data-action="pick-polity" data-value="${esc(value)}">${esc(d)}</button>`;
    })
    .join('');

  const scopeChips = [
    { value: 'cn', title: '中国', desc: '只抽中国人物' },
    { value: 'world', title: '世界', desc: '只抽外国人物' },
    { value: 'mixed', title: '混合', desc: '中外按比例' },
  ]
    .map(
      (m) => `
      <button class="chip-select ${s.scope === m.value ? 'is-active' : ''}"
        data-action="pick-scope" data-value="${m.value}">
        <b>${esc(m.title)}</b><span>${esc(m.desc)}</span>
      </button>`,
    )
    .join('');

  const eraChips = ['不限', ...WORLD_ERAS]
    .map((era) => {
      const value = era === '不限' ? '' : era;
      const active = era === '不限' ? s.worldEra === null : s.worldEra === era;
      return `<button class="chip-select chip-sm ${active ? 'is-active' : ''}"
        data-action="pick-era" data-value="${esc(value)}">${esc(era)}</button>`;
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

  const maxTurns = meta?.maxTurns ?? 20;
  const turnOptions = [10, 15, 20, 30, 40, 50].filter((t) => t <= maxTurns);
  const turns = s.turns ?? maxTurns;
  const turnChips = turnOptions
    .map(
      (t) => `
      <button class="chip-select chip-sm ${turns === t ? 'is-active' : ''}"
        data-action="pick-turns" data-value="${t}">${t} 问</button>`,
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
          <span class="group-label">人物范围</span>
          <div class="chips">${scopeChips}</div>
        </div>

        ${
          s.scope === 'mixed'
            ? `<div class="group">
                 <span class="group-label">中国人物占比 <b data-role="cn-share-label">${Math.round(s.cnShare * 100)}%</b></span>
                 <input class="share-range" type="range" min="0" max="100" step="10"
                   value="${Math.round(s.cnShare * 100)}" data-field="cn-share" />
               </div>`
            : ''
        }

        ${
          s.scope === 'mixed'
            ? ''
            : `<div class="group">
                 <span class="group-label">时期</span>
                 <div class="chips chips-wrap">${s.scope === 'cn' ? polityChips : eraChips}</div>
               </div>`
        }

        <div class="group">
          <span class="group-label">提问轮次</span>
          <div class="chips">${turnChips}</div>
        </div>

        <div class="lobby-actions">
          <button class="btn btn-primary btn-lg" data-action="start-game" ${s.pending ? 'disabled' : ''}>
            ${s.pending ? '正在开局…' : '开局'}
          </button>
          <span class="muted">本局 ${turns} 问，上限 ${maxTurns}</span>
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
        <p>先定时期和性别，再收窄到身份，最后一问确认代表作——通常够用。</p>
      </aside>
    </section>`,
  );
}

/* ---------------- 对局 ---------------- */

function turnView(r: RecordView, canSave: boolean): string {
  const isFormat = Boolean(r.invalid);
  const cls = isFormat ? 'v-format' : `v-${r.verdict}`;
  const label = isFormat ? '改问法' : (VERDICT_LABEL[r.verdict] ?? '');
  const hint = r.hint ? `<span class="hint">${esc(r.hint)}</span>` : '';
  const save = canSave
    ? `<button class="q-save" data-action="save-question" data-value="${esc(r.question)}" title="加入常用问题">＋常用</button>`
    : '';
  return `
    <div class="turn turn-q"><p>${esc(r.question)}</p>${save}</div>
    <div class="turn turn-a ${isFormat ? 'is-format' : ''}">
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
  const savedSet = new Set(s.saved.map(normalizeQuestion));

  const log = session.history.length
    ? session.history
        .map((r) => turnView(r, !r.invalid && !savedSet.has(normalizeQuestion(r.question))))
        .join('')
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
          ${session.polity ? `<i class="dot"></i><span>${esc(session.polity)}</span>` : ''}
          ${session.mode === 'guided' ? '<i class="dot"></i><span>解说</span>' : ''}
          ${
            session.history.length
              ? `<button class="btn btn-text btn-copy" data-action="copy-log">${s.copied ? '已复制' : '复制记录'}</button>`
              : ''
          }
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

      ${pinnedPanel(s)}
    </section>
    ${s.guessOpen ? guessDialog(s) : ''}`,
  );
}

function pinnedPanel(s: State): string {
  // 空列表整栏不渲染：小屏上空状态会白占一屏高度
  if (!s.saved.length) return '';

  const items = s.saved
    .map(
      (q) => `
      <li class="pinned-item">
        <button class="pinned-q" data-action="use-question" data-value="${esc(q)}" title="填入输入框">${esc(q)}</button>
        <button class="pinned-drop" data-action="drop-question" data-value="${esc(q)}" title="从常用问题移除">×</button>
      </li>`,
    )
    .join('');

  return `
    <aside class="pinned">
      <div class="pinned-head">
        <span>常用问题</span>
        <span class="pinned-count">${s.saved.length}</span>
      </div>
      <ul class="pinned-list">${items}</ul>
    </aside>`;
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
    ['政权', c.polityAlt?.length ? `${c.polity}（亦经历 ${c.polityAlt.join('、')}）` : c.polity],
    ['身份', c.roles.join('、') || '—'],
    ['生卒', `${fmtYear(c.birth)} — ${fmtYear(c.death)}`],
    ['籍贯', c.birthplace ?? '不详'],
  ]
    .map(([k, v]) => `<div class="fact"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');

  const review = r.history.length
    ? r.history
        .map((h) => {
          const cls = h.invalid ? 'v-format' : `v-${h.verdict}`;
          const label = h.invalid ? '改问法' : VERDICT_LABEL[h.verdict];
          const hint = h.hint ? `<p class="review-hint">${esc(h.hint)}</p>` : '';
          return `
        <li class="review-item">
          <div class="review-line">
            <span class="review-q">${esc(h.question)}</span>
            <span class="verdict ${cls}">${esc(label)}</span>
          </div>
          <p class="review-a">${esc(h.text)}</p>
          ${hint}
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
        <p class="reveal-identity">${esc(c.polity)}${c.country ? ` · 今属 ${esc(c.country)}` : ''}${c.aliases.length ? ` · 又称 ${esc(c.aliases.slice(0, 2).join('、'))}` : ''}</p>
        <dl class="facts">${facts}</dl>
        <p class="notable">${esc(c.notable)}</p>
        <div class="reveal-actions">
          <button class="btn btn-primary" data-action="new-game">再来一局</button>
          <button class="btn btn-ghost" data-action="go-setup">设置</button>
        </div>
      </div>

      <div class="review">
        <div class="review-title">
          <h3>对局回顾 <span class="muted">· 用了 ${r.turnsUsed} 问</span></h3>
          <button class="btn btn-text btn-copy" data-action="copy-review">${s.copied ? '已复制' : '复制记录'}</button>
        </div>
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
