import type { State } from './store.ts';
import { loadVaultSecret, normalizeQuestion } from './store.ts';
import type { HistorySummary, RecordView } from '../shared/protocol.ts';
import { WORLD_ERAS, type TargetCategory } from '../shared/domain.ts';
import { encodeManagementKey, keyFromBase64 } from './vault.ts';

export const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const VERDICT_LABEL: Record<string, string> = { yes: '是', no: '否', unknown: '无法判断' };

function fmtYear(year: number | null): string {
  if (year === null || year === undefined) return '不详';
  return year < 0 ? `公元前 ${Math.abs(year)} 年` : `${year} 年`;
}

/**
 * 顶栏用户菜单的开合。
 * 放在模块里而不是 store：这是纯 UI 瞬时状态，进 store 会污染领域状态，
 * 也会和并行开发中的房间状态互相踩。
 */
let menuOpen = false;

export function toggleMenu(): void {
  menuOpen = !menuOpen;
}

export function closeMenu(): void {
  menuOpen = false;
}

export function isMenuOpen(): boolean {
  return menuOpen;
}

/** 对局上下文：只在局中/揭晓时出现，让顶栏有信息而不是一排按钮 */
function topbarContext(s: State): string {
  const session = s.session;
  if (!session) return '';
  if (s.view !== 'game' && s.view !== 'reveal') return '';

  const parts: string[] = [];
  parts.push(s.view === 'reveal' ? '已揭晓' : `剩 ${session.turnsLeft} 问`);
  parts.push({ strict: '精确', guided: '解说', assist: '辅助' }[session.mode] ?? '精确');
  const scope = session.polity ?? session.worldEra;
  if (scope) parts.push(scope);

  return `<span class="topbar-context">${parts
    .map((p) => `<span>${esc(p)}</span>`)
    .join('<i class="dot"></i>')}</span>`;
}

function userMenu(s: State): string {
  const user = s.meta?.user;
  if (!user) return '';
  const model = s.config?.model;
  const admin = user.role === 'admin';

  return `
    <div class="menu">
      <button class="btn btn-ghost menu-trigger" data-action="toggle-menu"
        aria-haspopup="menu" aria-expanded="${menuOpen ? 'true' : 'false'}">
        <span class="chip-dot"></span>
        <span class="chip-label">${esc(user.username)}</span>
        <span class="menu-caret" aria-hidden="true">▾</span>
      </button>
      ${
        menuOpen
          ? `<div class="menu-panel" role="menu">
               <p class="menu-head">
                 ${esc(user.username)}
                 ${admin ? '<span class="menu-role">管理员</span>' : ''}
                 ${model ? `<small>模型 ${esc(model)}</small>` : ''}
               </p>
               <button class="menu-item" role="menuitem" data-action="go-setup">我的设置</button>
               ${
                 admin
                   ? `<a class="menu-item" role="menuitem" href="/admin.html" target="_blank" rel="noopener">
                        管理后台<small>新窗口打开</small>
                      </a>`
                   : ''
               }
               <div class="menu-sep"></div>
               <button class="menu-item is-danger" role="menuitem" data-action="logout">登出</button>
             </div>`
          : ''
      }
    </div>`;
}

function topbar(s: State): string {
  const user = s.meta?.user;
  const authEnabled = Boolean(s.meta?.authEnabled);

  // 右侧只留两个锚点：历史（常用）+ 用户菜单（低频操作收进二级）。
  // 未登录时仅一个「登录」；单机 JSON 模式没有账号，保留「设置」。
  const actions = user
    ? `<button class="btn btn-ghost" data-action="go-rooms">对战</button><button class="btn btn-ghost" data-action="go-history">历史</button>${userMenu(s)}`
    : authEnabled
      ? `<button class="btn btn-ghost" data-action="go-auth">登录</button>`
      : `<button class="btn btn-ghost" data-action="go-setup">设置</button>`;

  return `
  <header class="topbar">
    <a class="brand brand-link" href="#/" data-action="go-home" title="回到首页">
      <span class="seal">猜</span>
      <span class="brand-text">
        <span class="brand-title">猜历史</span>
        <span class="brand-sub">是/否提问 · 猜人物</span>
      </span>
    </a>
    ${topbarContext(s)}
    <div class="topbar-actions">${actions}</div>
  </header>`;
}

function notice(s: State): string {
  if (!s.notice) return '';
  return `<div class="notice notice-${s.notice.kind}">${esc(s.notice.text)}</div>`;
}

export function shell(s: State, body: string): string {
  return `${topbar(s)}<main class="stage">${notice(s)}${body}</main>`;
}

/* ---------------- 设置 / 引导 ---------------- */

function syncPanel(s: State): string {
  const keyB64 = loadVaultSecret();
  const key = keyB64 ? keyFromBase64(keyB64) : null;
  const code = key ? encodeManagementKey(key) : '';

  const online = `
    <div class="field">
      <label class="field-label" for="syncCode">管理密钥</label>
      <input class="input" id="syncCode" value="${esc(code)}" spellcheck="false" autocomplete="off" />
      <p class="field-hint">管理密钥只用于认证与恢复，设置另用一把数据密钥加密（它随密钥包裹上传，可轮换管理密钥而不重新加密数据）。丢失后云端数据无法恢复。</p>
    </div>
    <div class="field">
      <label class="field-label" for="syncEndpoint">同步地址</label>
      <input class="input" id="syncEndpoint" name="syncEndpoint" value="${esc(s.syncEndpoint)}"
        placeholder="留空表示当前这台服务" autocomplete="off" spellcheck="false" />
      <p class="field-hint">换设备时填同一台服务的地址，例如 http://127.0.0.1:3000。</p>
    </div>
    ${s.syncMessage ? `<p class="testline ${s.syncError ? 'fail' : 'ok'}">${esc(s.syncMessage)}</p>` : ''}
    <div class="actions">
      <button type="button" class="btn btn-ghost" data-action="vault-generate">生成新管理密钥</button>
      <button type="button" class="btn btn-ghost" data-action="vault-import">使用这段密钥</button>
      <button type="button" class="btn btn-ghost" data-action="vault-push" ${s.syncBusy ? 'disabled' : ''}>上传到云端</button>
      <button type="button" class="btn btn-ghost" data-action="vault-pull" ${s.syncBusy ? 'disabled' : ''}>从云端恢复</button>
    </div>
    <p class="field-hint">最后同步：${s.syncAt ? new Date(s.syncAt).toLocaleString('zh-CN') : '从未'}</p>
  `;

  return `
  <div class="panel sync-panel">
    <div class="field">
      <span class="field-label">设置存储</span>
      <div class="chips">
        <button type="button" class="chip-select chip-sm ${s.syncMode === 'local' ? 'is-active' : ''}"
          data-action="pick-sync-mode" data-value="local">本地</button>
        <button type="button" class="chip-select chip-sm ${s.syncMode === 'online' ? 'is-active' : ''}"
          data-action="pick-sync-mode" data-value="online">在线</button>
      </div>
      <p class="field-hint">${
        s.syncMode === 'local'
          ? '设置只保存在这台设备的浏览器里，不上传任何数据。'
          : '设置在本机加密后上传；服务端只存密文，没有管理密钥无法解密。'
      }</p>
    </div>
    ${s.syncMode === 'online' ? online : ''}
  </div>`;
}

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
          </div>
        </form>

        ${syncPanel(s)}

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
    { value: 'cn', title: '中国', desc: '只抽中国条目' },
    { value: 'world', title: '世界', desc: '只抽外国条目' },
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

  // 谜底类别：人物 / 事件 / 物品 / 混合；空类别禁用（meta 下发各类在库数）
  const catCounts = meta?.categories ?? { character: 0, event: 0, item: 0 };
  const categoryChips = [
    { value: 'character', title: '人物', desc: `${catCounts.character ?? 0} 位` },
    { value: 'event', title: '事件', desc: `${catCounts.event ?? 0} 件` },
    { value: 'item', title: '物品', desc: `${catCounts.item ?? 0} 件` },
    { value: 'mixed', title: '混合', desc: '三类都抽' },
  ]
    .map((m) => {
      const disabled =
        m.value !== 'mixed' && (catCounts[m.value as keyof typeof catCounts] ?? 0) === 0;
      return `<button class="chip-select ${s.category === m.value ? 'is-active' : ''}"
        data-action="pick-category" data-value="${m.value}" ${disabled ? 'disabled title="该类别还没有题目"' : ''}>
        <b>${esc(m.title)}</b><span>${esc(m.desc)}</span>
      </button>`;
    })
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
    { value: 'assist', title: '辅助', desc: '判定后给一点方向提示' },
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
          <h2>锁定一个谜底</h2>
          <p class="lede">选好范围后，服务端会随机挑一位并锁死，整局不变——刷新、关页面再回来，答案都是同一个。</p>
        </div>

        <div class="group">
          <span class="group-label">猜什么</span>
          <div class="chips">${categoryChips}</div>
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
          <span class="group-label">${s.category === 'character' ? '人物范围' : '范围'}</span>
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
          <button class="btn btn-ghost" data-action="go-rooms">找人开局（对战）</button>
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
        <h3>对战怎么玩</h3>
        <p>同一个目标人物，各问各的、互不可见，谁先猜中谁赢；没人猜中就过半投票揭晓，结束后全员公开问答供复盘。</p>
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

function examples(category: TargetCategory | 'mixed'): string {
  // mixed 用三类通用的中性问题：示例本身不能暗示类别
  const samples =
    category === 'event'
      ? ['它发生在唐朝吗？', '它和战争有关吗？', '它发生在公元前吗？', '主角是皇帝吗？', '它改变了历史走向吗？']
      : category === 'item'
        ? ['它是青铜器吗？', '它是唐朝的东西吗？', '它出土于河南吗？', '它现在藏在博物馆吗？', '它有一千年以上历史吗？']
        : category === 'character'
          ? ['他是唐朝人吗？', '他当过皇帝吗？', '他是诗人吗？', '他名字是两个字吗？', '他活在公元后吗？']
          : ['它与唐朝有关吗？', '它在公元 1500 年之前吗？', '它是真实存在过的吗？', '它和战争有关吗？', '它的名字是三个字吗？'];
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
    : examples(session.category ?? 'character');

  // 乐观渲染：已提交的问题先上屏，答案槽显示判定中，响应后原位替换
  const pendingTurn = s.pendingQuestion
    ? `<div class="turn turn-q"><p>${esc(s.pendingQuestion)}</p></div>
       <div class="turn turn-a turn-thinking"><span class="verdict v-wait">判定中</span><p class="thinking"><i></i><i></i><i></i></p></div>`
    : '';

  return shell(
    s,
    `
    <section class="board">
      <aside class="rail">
        <div class="target">
          <div class="target-seal">？</div>
          <div>
            <p class="target-label">目标${
              // mixed 不揭示类别：「目标事件」等于告诉玩家这次抽到了事件
              session.category === 'mixed' ? '' : ({ character: '人物', event: '事件', item: '物品' }[session.category] ?? '')
            }</p>
            <p class="target-hint">开局已锁定</p>
          </div>
        </div>

        <div class="counter">
          <span class="counter-num">${session.turnsLeft}</span>
          <span class="counter-label">剩余提问</span>
          <div class="counter-bar"><i style="width:${Math.round(ratio * 100)}%"></i></div>
        </div>

        <div class="rail-actions">
          <button class="btn btn-primary" data-action="open-guess" ${s.pending ? 'disabled' : ''}>${
            session.category === 'mixed'
              ? '我猜…'
              : session.category === 'event'
                ? '我猜是哪件事…'
                : session.category === 'item'
                  ? '我猜是哪件…'
                  : '我猜是…'
          }</button>
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
          ${
            session.mode !== 'strict'
              ? `<i class="dot"></i><span>${{ guided: '解说', assist: '辅助' }[session.mode] ?? ''}</span>`
              : ''
          }
          ${
            session.history.length
              ? `<button class="btn btn-text btn-copy" data-action="copy-log">${s.copied ? '已复制' : '复制记录'}</button>`
              : ''
          }
        </div>

        <div class="log" data-role="log">
          ${log}
          ${pendingTurn}
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
  const cat = s.session?.category ?? 'character';
  // mixed 中性：弹窗不能暗示类别
  const ariaLabel = cat === 'mixed' ? '抢答' : cat === 'event' ? '猜事件' : cat === 'item' ? '猜物品' : '猜人物';
  const title = cat === 'character' ? '你猜是谁？' : '你猜是什么？';
  const placeholder =
    cat === 'mixed'
      ? '输入名称'
      : cat === 'event'
        ? '输入事件名称'
        : cat === 'item'
          ? '输入物品名称'
          : '输入人物姓名';
  return `
  <div class="dialog-mask" data-mask="1">
    <div class="dialog" role="dialog" aria-modal="true" aria-label="${ariaLabel}">
      <p class="eyebrow">抢答</p>
      <h3 class="dialog-title">${title}</h3>
      <p class="dialog-hint">猜错会消耗一次提问机会。别称也算对。</p>
      <input class="input" name="guess" data-role="guess-input" placeholder="${placeholder}" autocomplete="off" />
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
  // 残缺响应（例如服务端把 Promise 序列化成了 {}）不能让整页渲染抛错卡死
  if (!c) {
    return shell(
      s,
      `<section class="panel">
         <p class="eyebrow">揭晓</p>
         <h2>这一局的揭晓数据不完整</h2>
         <p class="muted">刷新页面，或到「历史」里找到这一局查看完整问答。</p>
         <div class="actions">
           <button class="btn btn-primary" data-action="go-history">打开历史</button>
         </div>
       </section>`,
    );
  }
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

/* ---------------- 我的历史 ---------------- */

const RESULT_LABEL: Record<string, string> = {
  won: '猜中',
  lost: '次数用尽',
  abandoned: '放弃',
  playing: '进行中',
};

function fmtTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function historyRow(g: HistorySummary): string {
  const scope = g.polity ?? g.worldEra ?? (g.region ? REGION_LABEL_CLIENT[g.region] ?? g.region : '不限');
  const target = g.target ? `目标 · ${esc(g.target.name)}（${esc(g.target.polity)}）` : '目标未揭晓';

  // 对战局：结局标签换成"对战"语义，结果用名次表达（第 1 名 = 赢）
  const isRace = Boolean(g.roomId);
  const resultTag = isRace
    ? `<span class="verdict history-result is-race">对战</span>`
    : `<span class="verdict history-result is-${esc(g.result)}">${esc(RESULT_LABEL[g.result] ?? g.result)}</span>`;
  const raceBadge =
    isRace && typeof g.finishRank === 'number'
      ? `<span class="verdict history-result ${g.finishRank === 1 ? 'is-won' : 'is-race'}">第 ${g.finishRank} 名</span>`
      : '';

  const action =
    g.result === 'playing' && !isRace
      ? `<button class="btn btn-ghost" data-action="resume-history" data-id="${esc(g.id)}">继续这局</button>`
      : `<button class="btn btn-ghost" data-action="open-history" data-id="${esc(g.id)}">查看</button>`;
  return `
    <li class="history-item">
      <div class="history-main">
        <div class="history-head">
          ${resultTag}
          ${raceBadge}
          <span class="history-target">${target}</span>
        </div>
        <div class="history-meta">
          <span>${fmtTime(g.startedAt)}</span>
          <i class="dot"></i><span>${esc(scope)}</span>
          <i class="dot"></i><span>用了 ${g.turnsUsed} / ${g.turnsTotal} 问</span>
          <i class="dot"></i><span>${esc(difficultyLabel(g.difficulty))}</span>
        </div>
      </div>
      ${action}
    </li>`;
}

const REGION_LABEL_CLIENT: Record<string, string> = {
  cn: '中国',
  europe: '欧洲',
  'west-asia': '西亚北非',
  'south-asia': '南亚',
  'east-asia': '东亚',
  africa: '撒哈拉以南非洲',
  americas: '美洲',
  oceania: '大洋洲',
};

function difficultyLabel(level: number): string {
  return level === 1 ? '入门' : level === 2 ? '进阶' : level === 3 ? '考据' : `难度 ${level}`;
}

function historyTurnView(r: { seq: number; question: string; verdict: string; text: string; hint?: string; invalid?: string; failed?: boolean }): string {
  const cls = r.invalid ? 'v-format' : r.failed ? 'v-wait' : `v-${r.verdict}`;
  const label = r.invalid ? '改问法' : r.failed ? '调用失败' : (VERDICT_LABEL[r.verdict] ?? '');
  const hint = r.hint ? `<span class="hint">${esc(r.hint)}</span>` : '';
  return `
    <div class="turn turn-q"><p>${esc(r.question)}</p></div>
    <div class="turn turn-a ${r.invalid ? 'is-format' : ''}">
      <span class="verdict ${cls}">${esc(label)}</span>
      <p>${esc(r.text)}${hint}</p>
    </div>`;
}

function historyDetailHead(g: NonNullable<State['historyDetail']>): string {
  const facts = g.target
    ? `<dl class="facts">
         <div class="fact"><dt>人物</dt><dd>${esc(g.target.name)}</dd></div>
         <div class="fact"><dt>政权</dt><dd>${esc(g.target.polity || '—')}</dd></div>
         <div class="fact"><dt>身份</dt><dd>${esc(g.target.roles.join('、') || '—')}</dd></div>
         <div class="fact"><dt>结果</dt><dd>${esc(RESULT_LABEL[g.result] ?? g.result)}</dd></div>
       </dl>`
    : `<p class="history-note">这局还没结束，目标人物暂不显示。</p>`;

  return `
    <div class="history-detail-head">
      <button class="btn btn-text" data-action="history-back">← 返回列表</button>
      <h2 class="history-detail-title">${esc(fmtTime(g.startedAt))} 的对局</h2>
      <p class="history-meta">
        用了 ${g.turnsUsed} / ${g.turnsTotal} 问
        <i class="dot"></i>${esc(difficultyLabel(g.difficulty))}
        <i class="dot"></i>${g.mode === 'guided' ? '解说模式' : '精确模式'}
      </p>
      ${facts}
    </div>`;
}

function historyView(s: State): string {
  if (!s.meta?.user) {
    return shell(
      s,
      `<section class="panel"><p class="muted">登录后才能保存和查看自己的对局历史。</p>
       <div class="actions"><button class="btn btn-primary" data-action="back">返回</button></div></section>`,
    );
  }

  const detail = s.historyDetail;
  if (detail) {
    const turns = detail.turns.length
      ? detail.turns.map(historyTurnView).join('')
      : '<p class="muted">这一局没有提问。</p>';
    return shell(
      s,
      `<section class="history-view">
         ${historyDetailHead(detail)}
         <div class="panel history-log">${turns}</div>
       </section>`,
    );
  }

  const list = s.history;
  const body = !list
    ? '<p class="muted">正在载入…</p>'
    : list.length
      ? `<ul class="history-list">${list.map(historyRow).join('')}</ul>
         ${s.historyTotal > list.length ? `<p class="muted">共 ${s.historyTotal} 局，显示最近 ${list.length} 局。</p>` : ''}`
      : '<p class="muted">还没有对局记录。开局打一局，这里就会留下完整问答。</p>';

  return shell(
    s,
    `<section class="history-view">
       <div class="history-toolbar">
         <div>
           <p class="eyebrow">我的历史</p>
           <h2>对局与问答记录</h2>
         </div>
         <button class="btn btn-ghost" data-action="go-history">刷新</button>
       </div>
       ${s.historyError ? `<p class="testline fail">${esc(s.historyError)}</p>` : ''}
       <div class="panel">${body}</div>
     </section>`,
  );
}

function authView(s: State): string {
  const isLogin = s.authMode === 'login';
  return shell(
    s,
    `
    <section class="setup">
      <div class="setup-intro">
        <p class="eyebrow">${isLogin ? '欢迎回来' : '加入'}</p>
        <h2>${isLogin ? '登录' : '注册账号'}</h2>
        <p class="lede">${
          isLogin
            ? '登录后可直接使用站方模型开局；也可以在设置里填自己的（BYOK）。'
            : '需要邀请码（本机第一个账号除外——它直接成为管理员）。注册后每日可玩站方模型，也可在设置里填自己的模型；历史会跟着账号走。'
        }</p>
      </div>

      <form class="panel" data-role="auth-form">
        <div class="field">
          <label class="field-label" for="username">用户名</label>
          <input class="input" id="username" name="username" placeholder="2-20 位，字母数字或中文"
            autocomplete="username" />
        </div>
        <div class="field">
          <label class="field-label" for="password">密码</label>
          <input class="input" id="password" name="password" type="password" placeholder="至少 8 位"
            autocomplete="${isLogin ? 'current-password' : 'new-password'}" />
        </div>
        ${
          isLogin
            ? ''
            : `<div class="field">
                 <label class="field-label" for="invite">邀请码</label>
                 <input class="input" id="invite" name="invite" placeholder="找管理员要；库里的第一个账号可留空" autocomplete="off" />
                 <p class="field-hint">架设这台服务的人：空库时第一个注册的账号直接成为管理员，不需要邀请码。</p>
               </div>`
        }
        ${s.authError ? `<p class="testline fail">${esc(s.authError)}</p>` : ''}
        <div class="actions">
          <button type="submit" class="btn btn-primary" ${s.authBusy ? 'disabled' : ''}>
            ${s.authBusy ? '请稍候…' : isLogin ? '登录' : '注册并登录'}
          </button>
          <button type="button" class="btn btn-text" data-action="auth-toggle">
            ${isLogin ? '没有账号？用邀请码注册' : '已有账号？去登录'}
          </button>
        </div>
      </form>

      <p class="footnote">开局需要账号，这样每一局都能在「历史」里找回；自带模型（BYOK）的也请先登录。</p>
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
    case 'auth':
      return authView(s);
    case 'lobby':
      return lobbyView(s);
    case 'reveal':
      return revealView(s);
    case 'history':
      return historyView(s);
    default:
      return gameView(s);
  }
}
