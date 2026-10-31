import type { Character, Verdict } from '../shared/domain.ts';
import { DYNASTIES, WORLD_ERAS } from '../shared/domain.ts';
import type { HistoryDetail, HistorySummary } from '../shared/protocol.ts';
import { CharacterIndex, dynastyScope } from '../core/index.ts';
import { judgeByIndex } from '../core/judge.ts';
import { charLen, type Issue } from '../core/schema.ts';

/** 后台页面的状态与渲染（纯字符串模板，与玩家端 views.ts 同一套路） */

export interface AdminMeta {
  dynasties: string[];
  difficulties: Array<{ level: number; label: string }>;
  roles: string[];
  /** 各类别的类型词（人物=身份；事件=战役…；物品=青铜器…） */
  types?: { character: string[]; event: string[]; item: string[] };
  provinces: string[];
  polities: string[];
  regions: Array<{ value: string; label: string }>;
  total: number;
  categories?: { character: number; event: number; item: number };
  active: number;
  tokenRequired: boolean;
}

export interface HealthItem extends Issue {
  id: string;
  name: string;
}

export interface HealthReport {
  total: number;
  active: number;
  retired: number;
  errors: number;
  warnings: number;
  items: HealthItem[];
  matrix: Array<{ polity: string; levels: Record<string, number>; total: number }>;
  regionMatrix: Array<{ region: string; levels: Record<string, number>; total: number }>;
  emptyDynasties: string[];
  emptyCombos: Array<{ polity: string; difficulty: number }>;
}

export interface Notice {
  kind: 'ok' | 'err' | 'info';
  text: string;
}

export interface AdminState {
  ready: boolean;
  error: string | null;
  notice: Notice | null;
  meta: AdminMeta | null;
  list: Character[];
  total: number;
  filters: { q: string; category: string; polity: string; region: string; difficulty: string; retired: string };
  view: 'list' | 'edit' | 'health' | 'users' | 'invites' | 'settings' | 'history';
  draft: Character | null;
  /** 正在编辑的原始 id；新建时为 null */
  originalId: string | null;
  issues: Issue[];
  health: HealthReport | null;
  token: string;
  saving: boolean;
  users: AdminUserRow[];
  invites: AdminInviteRow[];
  llm: { baseURL: string; model: string; hasKey: boolean; maxTurns: number } | null;
  pwBusy: boolean;
  llmBusy: boolean;
  history: HistorySummary[];
  historyTotal: number;
  historyDetail: HistoryDetail | null;
  historyFilters: { user: string; result: string; q: string };
}

export interface AdminUserRow {
  id: string;
  username: string;
  role: string;
  allowServerKey: boolean;
  banned: boolean;
  createdAt: number;
  asksToday: number;
  dailyQuota?: number | null;
}

export interface AdminInviteRow {
  code: string;
  createdAt: number;
  usedAt: number | null;
  usedByName: string | null;
}

const esc = (value: unknown): string =>
  String(value ?? '').replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );

const VERDICT_LABEL: Record<Verdict, string> = { yes: '是', no: '否', unknown: '无法判断' };

/* ---------------- 外壳 ---------------- */

/** 各视图的标题与副标题：与当前标签保持一致 */
function headerFor(s: AdminState): { title: string; sub: string } {
  const meta = s.meta;
  // 类别拆分展示：264 条里并非全是「人物」
  const stats = meta
    ? (() => {
        const cat = meta.categories;
        const breakdown = cat
          ? `（人物 ${cat.character} / 事件 ${cat.event} / 物品 ${cat.item}）`
          : '';
        return `条目 ${meta.total} · 在库 ${meta.active} ${breakdown}`;
      })()
    : '加载中';
  switch (s.view) {
    case 'users':
      return { title: '管理后台', sub: `用户 ${s.users.length} 位` };
    case 'history':
      return { title: '管理后台', sub: `对局记录 ${s.historyTotal} 局` };
    case 'invites':
      return {
        title: '管理后台',
        sub: `邀请码 ${s.invites.length} 个 · 未用 ${s.invites.filter((i) => !i.usedAt).length} 个`,
      };
    case 'settings':
      return { title: '管理后台', sub: '账号与站方模型' };
    case 'health':
      return { title: '管理后台', sub: '数据健康' };
    case 'edit': {
      const label = { character: '人物', event: '事件', item: '物品' }[s.draft?.category ?? 'character'];
      return { title: '管理后台', sub: s.originalId ? `编辑：${s.draft?.name ?? ''}` : `新增${label}` };
    }
    default:
      return { title: '管理后台', sub: stats };
  }
}

function shell(s: AdminState, body: string): string {
  const head = headerFor(s);
  const meta = s.meta;

  return `
  <header class="a-top">
    <div class="a-topbar">
      <div class="a-brand">
        <span class="a-seal">管</span>
        <div>
          <h1 class="a-title">${esc(head.title)}</h1>
          <p class="a-sub">${esc(head.sub)}</p>
        </div>
      </div>
      ${
        meta?.tokenRequired
          ? `<div class="a-token">
               <input type="password" data-field="token" placeholder="ADMIN_TOKEN" value="${esc(s.token)}" />
               <button class="a-btn" data-action="save-token">应用</button>
             </div>`
          : '<span class="a-muted">仅本机可访问</span>'
      }
    </div>
    <nav class="a-tabs">
      <button class="a-tab ${s.view === 'list' || s.view === 'edit' ? 'is-active' : ''}" data-action="go-list">数据管理</button>
      <button class="a-tab ${s.view === 'health' ? 'is-active' : ''}" data-action="go-health">数据健康</button>
      <button class="a-tab ${s.view === 'users' ? 'is-active' : ''}" data-action="go-users">用户管理</button>
      <button class="a-tab ${s.view === 'history' ? 'is-active' : ''}" data-action="go-history">对局历史</button>
      <button class="a-tab ${s.view === 'invites' ? 'is-active' : ''}" data-action="go-invites">邀请码</button>
      <button class="a-tab ${s.view === 'settings' ? 'is-active' : ''}" data-action="go-settings">系统设置</button>
      <span class="a-tabs-spacer"></span>
      <a class="a-tab a-link" href="/">返回游戏</a>
    </nav>
  </header>
  ${s.notice ? `<div class="a-notice is-${s.notice.kind === 'ok' ? 'ok' : s.notice.kind === 'err' ? 'err' : ''}">${esc(s.notice.text)}</div>` : ''}
  ${s.error ? `<div class="a-notice is-err">${esc(s.error)}</div>` : ''}
  ${body}`;
}

/* ---------------- 列表 ---------------- */

function filtersView(s: AdminState): string {
  const meta = s.meta;
  if (!meta) return '<p class="a-muted">先在顶栏填入 ADMIN_TOKEN 再试。</p>';
  const polityOptions = ['', ...meta.dynasties]
    .map((d) => `<option value="${esc(d)}" ${s.filters.polity === d ? 'selected' : ''}>${esc(d || '全部朝代')}</option>`)
    .join('');
  const regionOptions = ['', ...meta.regions.map((r) => r.value)]
    .map((value) => {
      const label = value ? (meta.regions.find((r) => r.value === value)?.label ?? value) : '全部文明圈';
      return `<option value="${esc(value)}" ${s.filters.region === value ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
  const diffOptions = [
    ['', '全部难度'],
    ['1', '入门'],
    ['2', '进阶'],
    ['3', '考据'],
  ]
    .map(([v, label]) => `<option value="${v}" ${s.filters.difficulty === v ? 'selected' : ''}>${label}</option>`)
    .join('');
  const retireOptions = [
    ['', '全部状态'],
    ['0', '在库'],
    ['1', '已下线'],
  ]
    .map(([v, label]) => `<option value="${v}" ${s.filters.retired === v ? 'selected' : ''}>${label}</option>`)
    .join('');
  const categoryOptions = [
    ['', '全部类别'],
    ['character', '人物'],
    ['event', '事件'],
    ['item', '物品'],
  ]
    .map(([v, label]) => `<option value="${v}" ${s.filters.category === v ? 'selected' : ''}>${label}</option>`)
    .join('');

  return `
  <div class="a-filters">
    <input type="search" data-field="q" value="${esc(s.filters.q)}" placeholder="搜姓名 / 别名 / id" />
    <select data-field="filter-category">${categoryOptions}</select>
    <select data-field="filter-polity">${polityOptions}</select>
    <select data-field="filter-region">${regionOptions}</select>
    <select data-field="filter-difficulty">${diffOptions}</select>
    <select data-field="filter-retired">${retireOptions}</select>
    <button class="a-btn" data-action="reload">刷新</button>
    <button class="a-btn is-primary" data-action="create" data-category="character">新增人物</button>
    <button class="a-btn is-primary" data-action="create" data-category="event">新增事件</button>
    <button class="a-btn is-primary" data-action="create" data-category="item">新增物品</button>
    <button class="a-btn" data-action="export">导出 JSON</button>
  </div>`;
}

function listView(s: AdminState): string {
  const rows = s.list
    .map((c) => {
      const lifespan = c.birth !== null && c.death !== null;
      const cat = c.category ?? 'character';
      const catBadge =
        cat === 'event'
          ? ' <span class="a-pill">事件</span>'
          : cat === 'item'
            ? ' <span class="a-pill">物品</span>'
            : '';
      return `
      <tr data-action="edit" data-id="${esc(c.id)}" class="${c.retired ? 'is-retired' : ''}">
        <td>
          <span class="a-name">${esc(c.name)}</span>${catBadge}
          ${c.retired ? ' <span class="a-pill">已下线</span>' : ''}
        </td>
        <td class="a-muted">${esc(c.id)}</td>
        <td>${esc(c.polity)}${c.country ? `<span class="a-muted"> · ${esc(c.country)}</span>` : ''}${c.polityAlt?.length ? `<span class="a-muted"> · ${esc(c.polityAlt.join('、'))}</span>` : ''}</td>
        <td><div class="a-tagrow">${c.roles.map((r) => `<span class="a-pill">${esc(r)}</span>`).join('')}</div></td>
        <td>${c.difficulty}</td>
        <td>${lifespan ? `${c.birth} — ${c.death}` : '<span class="a-pill is-bad">生卒不全</span>'}</td>
      </tr>`;
    })
    .join('');

  return `
  ${filtersView(s)}
  <p class="a-muted">共 ${s.total} 条${s.list.length !== s.total ? `，当前显示 ${s.list.length} 条` : ''}</p>
  <table class="a-table">
    <thead>
      <tr><th>名称</th><th>id</th><th>时期</th><th>身份/类型</th><th>难度</th><th>生卒·年份</th></tr>
    </thead>
    <tbody>${rows || '<tr><td colspan="6" class="a-muted">没有匹配的人物</td></tr>'}</tbody>
  </table>`;
}

/* ---------------- 编辑 ---------------- */

function fieldIssues(s: AdminState, field: string): string {
  return s.issues
    .filter((i) => i.field === field)
    .map((i) => `<p class="a-issue is-${i.level}">${esc(i.message)}</p>`)
    .join('');
}

function field(
  s: AdminState,
  name: string,
  label: string,
  control: string,
  hint?: string,
): string {
  return `
  <div class="a-field">
    <label class="a-label" for="f-${name}">${esc(label)}</label>
    ${control}
    ${hint ? `<p class="a-hint">${esc(hint)}</p>` : ''}
    ${fieldIssues(s, name)}
  </div>`;
}

function textInput(s: AdminState, name: string, value: string, extra = ''): string {
  return `<input class="a-input" id="f-${name}" data-field="${name}" value="${esc(value)}" ${extra} />`;
}

function roleChips(s: AdminState): string {
  const selected = s.draft!.roles;
  // 建议词按类别分桶：人物=身份（诗人/皇帝…），事件=战役/条约…，物品=青铜器/书画…
  const cat = s.draft!.category ?? 'character';
  const suggest = s.meta?.types?.[cat as 'character' | 'event' | 'item'] ?? s.meta!.roles;
  const chips = suggest
    .map(
      (r) => `<button type="button" class="a-chip ${selected.includes(r) ? 'is-on' : ''}"
        data-action="toggle-role" data-value="${esc(r)}">${esc(r)}</button>`,
    )
    .join('');
  const placeholder = cat === 'character' ? '新增身份词' : '新增类型词';
  const listAttr = cat === 'character' ? '' : ' list="type-list"';
  return `
  <div class="a-chips">
    ${chips}
    <input class="a-input" id="f-role-custom" data-field="role-custom" placeholder="${placeholder}"${listAttr} style="width:120px" />
    <button type="button" class="a-btn" data-action="add-role">添加</button>
  </div>
  ${fieldIssues(s, 'roles')}`;
}

function altChips(s: AdminState): string {
  const selected = s.draft!.polityAlt ?? [];
  const chips = DYNASTIES.map(
    (d) => `<button type="button" class="a-chip ${selected.includes(d) ? 'is-on' : ''}"
      data-action="toggle-alt" data-value="${esc(d)}">${esc(d)}</button>`,
  ).join('');
  return `<div class="a-chips">${chips}</div>${fieldIssues(s, 'polityAlt')}`;
}

function checks(c: Character): Array<{ q: string; verdict: Verdict; expect: 'yes' | 'no' }> {
  const out: Array<{ q: string; verdict: Verdict; expect: 'yes' | 'no' }> = [];
  const yes = (query: { attr: string; value: unknown }, q: string): void => {
    out.push({ q, verdict: judgeByIndex(c, query as never).verdict, expect: 'yes' });
  };
  // 问句按类别：人物「他是 X 朝人吗」；事件「它发生在 X 吗」；物品「它是 X 代的吗」
  const cat = c.category ?? 'character';
  const q = (dynasty: string): string =>
    cat === 'event' ? `它发生在「${dynasty}」（${dynastyScope(dynasty)?.join('、') ?? dynasty}）吗` : cat === 'item' ? `它是「${dynasty}」代的吗` : `他是「${dynasty}」人吗`;

  if (c.region === 'cn' && c.polity) {
    yes({ attr: 'dynasty', value: c.polity }, q(c.polity));
    for (const alt of c.polityAlt ?? []) yes({ attr: 'dynasty', value: alt }, q(alt));

    if (c.polity === '东汉') {
      out.push({
        q: cat === 'character' ? '他是三国人物吗（严格分期应为否）' : '严格分期不属于三国（应答否）',
        verdict: judgeByIndex(c, { attr: 'dynasty', value: '三国' }).verdict,
        expect: 'no',
      });
    }
  }
  return out;
}

function previewPane(s: AdminState): string {
  const c = s.draft!;
  let profile = '';
  try {
    const idx = new CharacterIndex([{ ...c, retired: false }]);
    profile = idx.brief({ ...c, retired: false });
  } catch {
    profile = '（人物资料不足，无法生成资料卡）';
  }

  const rows = checks(c)
    .map((row) => {
      const good = row.verdict === row.expect;
      return `<div class="a-checkrow">
        <span>${esc(row.q)}</span>
        <span class="a-verdict ${good ? 'is-ok' : 'is-bad'}">${esc(VERDICT_LABEL[row.verdict])}</span>
      </div>`;
    })
    .join('');

  return `
  <aside class="a-preview">
    <div class="a-card">
      <h3>模型看到的资料卡</h3>
      <p class="a-profile">${esc(profile)}</p>
    </div>
    <div class="a-card">
      <h3>朝代判定预演（索引强制裁定）</h3>
      ${rows || '<p class="a-muted">填好朝代后显示</p>'}
    </div>
  </aside>`;
}

function editView(s: AdminState): string {
  const c = s.draft!;
  const isNew = s.originalId === null;
  const meta = s.meta;
  if (!meta) return '<p class="a-muted">先在顶栏填入 ADMIN_TOKEN 再试。</p>';

  // 类别：编辑中锁定（新建由「新增」按钮带入选定类别）
  const cat = c.category ?? 'character';
  const isCharacter = cat === 'character';
  const CAT_LABEL: Record<string, string> = { character: '人物', event: '事件', item: '物品' };
  const nameWord = isCharacter ? '姓名' : '名称';
  const birthWord = isCharacter ? '生年' : cat === 'event' ? '发生年份' : '制造年代（约）';
  const placeWord = isCharacter ? '籍贯（古地名 + 今地名）' : cat === 'event' ? '发生地点（含今属地名）' : '出土地（传世品填「传世」）';
  const notableWord = isCharacter ? '代表事迹' : cat === 'event' ? '经过与结果' : '简介';
  const rolesWord = isCharacter ? '身份' : '类型';
  // 类型 datalist：从同类别条目收集（自由输入，不设白名单）
  const typeOptions = (meta.types?.[cat] ?? [])
    .map((t) => `<option value="${esc(t)}"></option>`)
    .join('');

  const polityValues = c.region === 'cn' ? [...DYNASTIES] : meta.polities;
  const polityOptions = polityValues
    .map((d) => `<option value="${esc(d)}" ${c.polity === d ? 'selected' : ''}>${esc(d)}</option>`)
    .join('');
  const regionOptions = meta.regions
    .map(
      (r) =>
        `<option value="${esc(r.value)}" ${c.region === r.value ? 'selected' : ''}>${esc(r.label)}</option>`,
    )
    .join('');
  const polityList = meta.polities.map((p) => `<option value="${esc(p)}"></option>`).join('');

  const diffOptions = meta.difficulties
    .map((d) => `<option value="${d.level}" ${c.difficulty === d.level ? 'selected' : ''}>${d.label}（${d.level}）</option>`)
    .join('');

  const provinceList = meta.provinces
    .map((p) => `<option value="${esc(p)}"></option>`)
    .join('');

  const rootIssues = s.issues
    .filter((i) => !['id', 'name', 'aliases', 'region', 'polity', 'polityAlt', 'worldEra', 'gender', 'birth', 'death', 'birthplace', 'country', 'birthProvince', 'roles', 'tags', 'emperor', 'notable', 'difficulty', 'externalId'].includes(i.field))
    .map((i) => `<p class="a-issue is-${i.level}">${esc(i.message)}</p>`)
    .join('');

  return `
  <section class="a-edit">
    <form class="a-form" onsubmit="return false">
      <div class="a-form-head">
        <h2>${isNew ? `新增${CAT_LABEL[cat]}` : esc(c.name || c.id)}</h2>
        <span class="a-muted">${isNew ? `类别：${CAT_LABEL[cat]}（创建后不可改） · id 不可修改` : '在库' + (c.retired ? ' · 已下线' : '')}</span>
      </div>
      ${rootIssues}

      <div class="a-section">
        <h3>标识</h3>
        <div class="a-grid2">
          ${field(
            s,
            'id',
            'id（小写字母/数字/下划线）',
            textInput(s, 'id', c.id, isNew ? '' : 'disabled'),
            isNew ? '保存后不可修改：进行中的对局靠它找回目标人物' : '已锁定',
          )}
          ${field(s, 'name', nameWord, textInput(s, 'name', c.name), isCharacter ? '2–5 字，全库唯一' : '2–10 字，全库唯一')}
        </div>
        ${field(
          s,
          'aliases',
          '别名（逗号分隔）',
          textInput(s, 'aliases', c.aliases.join('、'), 'placeholder="如：李太白、诗仙"'),
          '每项至少 2 字；单字别名会命中大量无关猜名',
        )}
        ${fieldIssues(s, 'aliases')}
      </div>

      <div class="a-section">
        <h3>归属</h3>
        <div class="a-grid2">
          <div class="a-field">
            <label class="a-label" for="f-region">文明圈</label>
            <select class="a-select" id="f-region" data-field="region">${regionOptions}</select>
            <p class="a-hint">决定抽样权重与筛选；只有中国区做朝代硬裁定</p>
            ${fieldIssues(s, 'region')}
          </div>
          <div class="a-field">
            <label class="a-label" for="f-polity">${c.region === 'cn' ? '朝代' : '政权 / 国家'}</label>
            ${
              c.region === 'cn'
                ? `<select class="a-select" id="f-polity" data-field="polity">${polityOptions}</select>`
                : `<input class="a-input" id="f-polity" data-field="polity" list="polity-list" value="${esc(c.polity)}" />
                   <datalist id="polity-list">${polityList}</datalist>`
            }
            <p class="a-hint">${
              c.region === 'cn'
                ? `索引会强制用这里裁定「${
                    cat === 'event' ? '它发生在 X 吗' : cat === 'item' ? '它是 X 代的吗' : '他是 X 人吗'
                  }」`
                : '世界政权的判定交给模型，这里只做资料卡'
            }</p>
            ${fieldIssues(s, 'polity')}
          </div>
          ${
            c.region === 'cn'
              ? ''
              : `<div class="a-field">
                   <label class="a-label" for="f-worldEra">时期</label>
                   <select class="a-select" id="f-worldEra" data-field="worldEra">
                     ${['', ...WORLD_ERAS]
                       .map(
                         (e) =>
                           `<option value="${esc(e)}" ${(c.worldEra ?? '') === e ? 'selected' : ''}>${esc(e || '未划分')}</option>`,
                       )
                       .join('')}
                   </select>
                   <p class="a-hint">单选「世界」开局时按这里筛选</p>
                   ${fieldIssues(s, 'worldEra')}
                 </div>`
          }
          <div class="a-field">
            <label class="a-label" for="f-country">${isCharacter ? '今属国家/地区' : cat === 'item' ? '现藏机构 / 所在国' : '（事件不使用）'}</label>
            <input class="a-input" id="f-country" data-field="country" value="${esc(c.country ?? '')}" ${cat === 'event' ? 'disabled' : ''} />
            ${fieldIssues(s, 'country')}
          </div>
          ${
            isCharacter
              ? `<div class="a-field">
                   <label class="a-label" for="f-gender">性别</label>
                   <select class="a-select" id="f-gender" data-field="gender">
                     <option value="male" ${c.gender === 'male' ? 'selected' : ''}>男</option>
                     <option value="female" ${c.gender === 'female' ? 'selected' : ''}>女</option>
                   </select>
                   ${fieldIssues(s, 'gender')}
                 </div>`
              : ''
          }
        </div>
        ${
          isCharacter && c.region === 'cn'
            ? `<div class="a-field">
                 <span class="a-label">还经历过哪些朝代（多选）</span>
                 ${altChips(s)}
                 <p class="a-hint">只放人物实际经历过的时期；按严格分期，东汉人物不能选三国</p>
               </div>`
            : ''
        }
        ${
          isCharacter
            ? `<div class="a-field">
                 <label class="a-check">
                   <input type="checkbox" id="f-emperor" data-field="emperor" ${c.emperor ? 'checked' : ''} />
                   当过皇帝（须与身份里的「皇帝」一致）
                 </label>
                 ${fieldIssues(s, 'emperor')}
               </div>`
            : ''
        }
      </div>

      <div class="a-section">
        <h3>${isCharacter ? '生平' : '时地'}</h3>
        <div class="a-grid2">
          ${field(s, 'birth', `${birthWord}（公元前用负数）`, `<input class="a-input" id="f-birth" data-field="birth" type="number" step="1" value="${c.birth ?? ''}" />`, isCharacter ? '' : cat === 'event' ? '必填：年份是事件最重要的可判定维度' : '存疑就取通行说法的整数')}
          ${isCharacter ? field(s, 'death', '卒年（公元前用负数）', `<input class="a-input" id="f-death" data-field="death" type="number" step="1" value="${c.death ?? ''}" />`) : ''}
        </div>
        <div class="a-grid2">
          ${field(s, 'birthplace', placeWord, textInput(s, 'birthplace', c.birthplace ?? ''), isCharacter ? '如：沛国谯（今安徽亳州）' : cat === 'item' ? '如：河南安阳（殷墟出土）；传世品填「传世」' : '如：赤壁（今湖北赤壁市西北）')}
          ${field(
            s,
            'birthProvince',
            '今省份',
            `<input class="a-input" id="f-birthProvince" data-field="birthProvince" list="province-list" value="${esc(c.birthProvince ?? '')}" />
             <datalist id="province-list">${provinceList}</datalist>`,
          )}
        </div>
      </div>

      <div class="a-section">
        <h3>内容</h3>
        <div class="a-field">
          <span class="a-label">${rolesWord}（可多选）</span>
          ${roleChips(s)}
          ${
            !isCharacter
              ? `<datalist id="type-list">${typeOptions}</datalist>
                 <p class="a-hint">建议从上方建议词中选同类条目用过的类型，保持题库一致；也可直接输入新类型</p>`
              : ''
          }
        </div>
        ${field(s, 'tags', '关键词（逗号分隔）', textInput(s, 'tags', c.tags.join('、')), '会作为资料卡关键词与事迹匹配依据')}
        ${field(
          s,
          'notable',
          notableWord,
          `<textarea class="a-textarea" id="f-notable" data-field="notable">${esc(c.notable)}</textarea>`,
          isCharacter ? '一句话讲清这个人是谁、做过什么' : '一句话 factual 描述，不含主观评价（伟大/著名会被 AI 拒答）',
        )}
        <div class="a-grid2">
          <div class="a-field">
            <label class="a-label" for="f-difficulty">难度</label>
            <select class="a-select" id="f-difficulty" data-field="difficulty">${diffOptions}</select>
            ${fieldIssues(s, 'difficulty')}
          </div>
          ${field(s, 'externalId', '外部 id（可选）', textInput(s, 'externalId', c.externalId ?? ''), '如 wikidata:Q7071')}
        </div>
      </div>

      <div class="a-actions">
        <button type="button" class="a-btn is-primary" data-action="save" ${s.saving ? 'disabled' : ''}>
          ${s.saving ? '保存中…' : '保存'}
        </button>
        <button type="button" class="a-btn" data-action="go-list">取消</button>
        <span class="a-spacer"></span>
        ${
          s.originalId
            ? c.retired
              ? `<button type="button" class="a-btn" data-action="retire" data-value="false">恢复上架</button>`
              : `<button type="button" class="a-btn is-danger" data-action="retire" data-value="true">下线（不参与抽样）</button>`
            : ''
        }
      </div>
    </form>
    ${previewPane(s)}
  </section>`;
}

/* ---------------- 健康 ---------------- */

function healthView(s: AdminState): string {
  const h = s.health;
  if (!h) return '<p class="a-muted">正在加载…</p>';

  const header = `<tr><th>朝代</th><th>入门</th><th>进阶</th><th>考据</th><th>合计</th></tr>`;
  const rows = h.matrix
    .map((m) => {
      const cell = (level: number): string =>
        `<td class="${m.levels[String(level)] === 0 ? 'is-zero' : ''}">${m.levels[String(level)]}</td>`;
      return `<tr>
        <td>${esc(m.polity)}${m.total === 0 ? ' <span class="a-pill is-bad">无人物</span>' : ''}</td>
        ${cell(1)}${cell(2)}${cell(3)}
        <td>${m.total}</td>
      </tr>`;
    })
    .join('');

  const regionRows = h.regionMatrix
    .map((m) => {
      const label = s.meta?.regions.find((r) => r.value === m.region)?.label ?? m.region;
      const cell = (level: number): string =>
        `<td class="${m.levels[String(level)] === 0 ? 'is-zero' : ''}">${m.levels[String(level)]}</td>`;
      return `<tr>
        <td>${esc(label)}${m.total === 0 ? ' <span class="a-pill is-bad">无人物</span>' : ''}</td>
        ${cell(1)}${cell(2)}${cell(3)}
        <td>${m.total}</td>
      </tr>`;
    })
    .join('');

  const sorted = [...h.items].sort((a, b) => (a.level === b.level ? a.id.localeCompare(b.id) : a.level === 'error' ? -1 : 1));
  const items = sorted
    .map(
      (i) => `<li>
        <span class="a-who" data-action="edit" data-id="${esc(i.id)}">${esc(i.name)}</span>
        <span class="a-pill ${i.level === 'error' ? 'is-bad' : ''}">${i.level === 'error' ? '错误' : '提醒'}</span>
        <span>${esc(i.message)}</span>
      </li>`,
    )
    .join('');

  return `
  <div class="a-stats">
    <div class="a-stat"><b>${h.total}</b><span>人物总数</span></div>
    <div class="a-stat"><b>${h.active}</b><span>在库（可被抽中）</span></div>
    <div class="a-stat"><b>${h.retired}</b><span>已下线</span></div>
    <div class="a-stat ${h.errors ? 'is-bad' : ''}"><b>${h.errors} / ${h.warnings}</b><span>错误 / 提醒</span></div>
  </div>

  ${
    h.emptyDynasties.length
      ? `<div class="a-notice is-err">这些朝代没有任何人物，玩家选中后会抽到别的朝代：${esc(h.emptyDynasties.join('、'))}</div>`
      : ''
  }

  <div class="a-card" style="margin-bottom:16px">
    <h3>朝代 × 难度分布（红色为 0，该组合会退化为跨难度抽样）</h3>
    <table class="a-matrix">
      <thead>${header}</thead>
      <tbody>${rows}</tbody>
    </table>
  </div>

  <div class="a-card" style="margin-bottom:16px">
    <h3>文明圈 × 难度分布（混合模式按中国占比加权）</h3>
    <table class="a-matrix">
      <thead><tr><th>文明圈</th><th>入门</th><th>进阶</th><th>考据</th><th>合计</th></tr></thead>
      <tbody>${regionRows}</tbody>
    </table>
  </div>

  <div class="a-card">
    <h3>校验结果（${h.errors} 个错误、${h.warnings} 个提醒）</h3>
    <ul class="a-issue-list">${items || '<li class="a-muted">没有发现问题</li>'}</ul>
  </div>`;
}

/* ---------------- 对局历史（管理员视角） ---------------- */

const RESULT_TEXT: Record<string, string> = {
  won: '猜中',
  lost: '次数用尽',
  abandoned: '放弃',
  playing: '进行中',
};

/** 对战局的结局文案：结果用名次表达，"放弃"这个词在对战里没有意义 */
function raceResultText(g: HistorySummary): string {
  const rank = typeof g.finishRank === 'number' ? `第 ${g.finishRank} 名` : '';
  const reason = g.result === 'won' ? '猜中' : '未猜中';
  return rank ? `${reason} · ${rank}` : reason;
}

function resultCell(g: HistorySummary): string {
  if (g.roomId) {
    const cls = g.result === 'won' ? 'is-ok' : '';
    return `<span class="a-pill ${cls}">对战 · ${esc(raceResultText(g))}</span>`;
  }
  return `<span class="a-pill ${g.result === 'won' ? 'is-ok' : g.result === 'lost' ? 'is-bad' : ''}">${esc(RESULT_TEXT[g.result] ?? g.result)}</span>`;
}

/** 归属展示：登录玩家 / 明确游客 / 迁移回填查不到归属的三者不能混为一谈 */
function ownerLabel(g: HistorySummary): string {
  if (g.userName) return g.userName;
  return g.owner === 'unknown' ? '归属未记录' : '游客';
}

function ownerCell(g: HistorySummary): string {
  if (g.owner === 'unknown') {
    return '<span class="a-muted" title="迁移回填的老局：当时还没有记录账号归属">归属未记录</span>';
  }
  return '<span class="a-muted">游客</span>';
}

function historyDetailPane(d: HistoryDetail): string {
  const turns = d.turns.length
    ? d.turns
        .map((t) => {
          const cls = t.invalid ? 'is-bad' : t.failed ? '' : 'is-ok';
          const label = t.invalid
            ? '改问法'
            : t.failed
              ? '调用失败'
              : (VERDICT_LABEL[t.verdict] ?? t.verdict);
          return `<tr>
            <td class="a-muted">${t.seq}</td>
            <td>${esc(t.question)}</td>
            <td><span class="a-pill ${cls}">${esc(label)}</span></td>
            <td>${esc(t.text)}${t.hint ? `<br /><small class="a-muted">${esc(t.hint)}</small>` : ''}</td>
          </tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="a-muted">这一局没有提问</td></tr>';

  return `
  <section class="a-panel">
    <div class="a-row" style="justify-content:space-between;align-items:center">
      <h2 class="a-h2">对局详情</h2>
      <button class="a-btn" data-action="history-back">返回列表</button>
    </div>
    <p class="a-muted">
      ${esc(new Date(d.startedAt).toLocaleString('zh-CN'))}
      · 玩家 ${esc(ownerLabel(d))}
      · ${esc(d.roomId ? `对战 · ${raceResultText(d)}` : (RESULT_TEXT[d.result] ?? d.result))}
      · 用了 ${d.turnsUsed} / ${d.turnsTotal} 问
      · 难度 ${d.difficulty}
      ${d.target ? ` · 目标 <b>${esc(d.target.name)}</b>（${esc(d.target.polity)}）` : ' · 目标未揭晓（进行中）'}
    </p>
    <table class="a-table">
      <thead><tr><th>#</th><th>提问</th><th>判定</th><th>回答</th></tr></thead>
      <tbody>${turns}</tbody>
    </table>
  </section>`;
}

function historyView(s: AdminState): string {
  if (s.historyDetail) return historyDetailPane(s.historyDetail);

  const rows = s.history
    .map(
      (g) => `<tr>
        <td>${esc(new Date(g.startedAt).toLocaleString('zh-CN'))}</td>
        <td>${g.userName ? esc(g.userName) : ownerCell(g)}</td>
        <td>${resultCell(g)}</td>
        <td>${g.target ? esc(g.target.name) : '<span class="a-muted">—</span>'}</td>
        <td>${g.turnsUsed} / ${g.turnsTotal}</td>
        <td>${g.difficulty}</td>
        <td><button class="a-btn a-btn-sm" data-action="open-history" data-id="${esc(g.id)}">查看记录</button></td>
      </tr>`,
    )
    .join('');

  const resultOptions = [
    ['', '全部结局'],
    ['won', '猜中'],
    ['lost', '次数用尽'],
    ['abandoned', '放弃'],
    ['playing', '进行中'],
  ]
    .map(([v, label]) => `<option value="${v}" ${s.historyFilters.result === v ? 'selected' : ''}>${label}</option>`)
    .join('');

  return `
  <section class="a-panel">
    <h2 class="a-h2">对局历史（全部玩家 · ${s.historyTotal} 局）</h2>
    <div class="a-filters">
      <input type="search" data-field="history-user" value="${esc(s.historyFilters.user)}" placeholder="按用户名筛选" />
      <input type="search" data-field="history-q" value="${esc(s.historyFilters.q)}" placeholder="搜目标人物 / 用户名" />
      <select data-field="history-result">${resultOptions}</select>
      <button class="a-btn" data-action="reload-history">刷新</button>
    </div>
    <table class="a-table">
      <thead><tr><th>开局时间</th><th>玩家</th><th>结局</th><th>目标</th><th>问数</th><th>难度</th><th>操作</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="a-muted">还没有对局记录</td></tr>'}</tbody>
    </table>
    <p class="a-hint">进行中的局不显示目标人物，避免从后台反推答案；完整问答点「查看记录」。</p>
  </section>`;
}

/* ---------------- 入口 ---------------- */

export function renderAdmin(s: AdminState): string {
  if (!s.ready) {
    return `<div class="a-top"><div class="a-topbar"><div class="a-brand"><span class="a-seal">管</span><div><h1 class="a-title">管理后台</h1><p class="a-sub">正在载入…</p></div></div></div></div>`;
  }

  // meta 未就绪（如远程访问未带令牌被 403）：给出可操作的引导，而不是死转
  if (!s.meta) {
    return `<div class="a-top"><div class="a-topbar"><div class="a-brand"><span class="a-seal">管</span>
      <div><h1 class="a-title">管理后台</h1><p class="a-sub">${esc(s.error ?? '未能加载')}</p></div></div>
      <div class="a-token">
        <input type="password" data-field="token" placeholder="ADMIN_TOKEN" value="${esc(s.token)}" />
        <button class="a-btn" data-action="save-token">连接</button>
      </div></div></div>`;
  }

  const body =
    s.view === 'edit' && s.draft
      ? editView(s)
      : s.view === 'health'
        ? healthView(s)
        : s.view === 'users'
          ? usersView(s)
          : s.view === 'invites'
            ? invitesView(s)
            : s.view === 'settings'
              ? settingsView(s)
              : s.view === 'history'
                ? historyView(s)
                : listView(s);

  return shell(s, body);
}

export { charLen };

/* ---------------- 用户管理 ---------------- */

function usersView(s: AdminState): string {
  if (!s.users.length && s.ready) {
    return `<section class="a-panel"><p class="a-muted">正在加载用户…</p></section>`;
  }
  const rows = s.users
    .map((u) => {
      const isAdmin = u.role === 'admin';
      // 管理员：不可操作，用徽标说明原因
      const actions = isAdmin
        ? '<span class="a-muted">管理员不受限</span>'
        : `
        <button class="a-btn a-btn-sm" data-action="user-server-key" data-id="${esc(u.id)}" data-on="${u.allowServerKey ? '0' : '1'}">
          ${u.allowServerKey ? '关闭' : '开启'}
        </button>
        <button class="a-btn a-btn-sm" data-action="user-ban" data-id="${esc(u.id)}" data-on="${u.banned ? '0' : '1'}">
          ${u.banned ? '解封' : '封禁'}
        </button>
        <span class="a-actions-gap"></span>
        <button class="a-btn a-btn-sm is-danger" data-action="user-delete" data-id="${esc(u.id)}" data-name="${esc(u.username)}">
          删除
        </button>`;
      const quotaCell = isAdmin ? '∞' : `
        <input class="a-input a-input-sm" type="number" min="-1" max="10000"
          value="${u.dailyQuota ?? -1}" data-field="user-quota" data-id="${esc(u.id)}"
          title="-1=默认500，0=禁用，>0=自定义" />`;
      const stateBadges = [
        u.banned ? '<span class="a-pill is-bad">已封禁</span>' : '',
        !u.allowServerKey && !isAdmin ? '<span class="a-pill">站方模型已关</span>' : '',
      ]
        .filter(Boolean)
        .join(' ');
      return `
    <tr${u.banned ? ' class="is-banned"' : ''}>
      <td>
        <span class="a-user">
          <span class="a-avatar" aria-hidden="true">${esc(u.username.slice(0, 1).toUpperCase())}</span>
          <span class="a-user-main">
            <span class="a-user-name">${esc(u.username)}${
              isAdmin ? '<span class="a-shield" title="管理员账号" aria-label="管理员">🛡</span>' : ''
            }</span>
            <span class="a-user-sub">${stateBadges || '&nbsp;'}</span>
          </span>
        </span>
      </td>
      <td>${u.asksToday}</td>
      <td>${quotaCell}</td>
      <td>${isAdmin ? '—' : u.allowServerKey ? '允许' : '禁止'}</td>
      <td>${actions}</td>
    </tr>`;
    })
    .join('');

  return `
  <section class="a-panel">
    <h2 class="a-h2">用户（${s.users.length}）</h2>
    <p class="a-muted">配额：-1 = 跟随默认（500/天），0 = 禁用站方模型，&gt;0 = 每日上限。只对站方 Key 计数，BYOK 不限。</p>
    <table class="a-table">
      <thead><tr><th>用户名</th><th>今日已问</th><th>每日配额</th><th>站方模型</th><th>操作</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="a-hint">「删除」不可恢复：账号立即失效、进行中的对局被清掉、邀请码释放；历史账本保留（历史里的人物名是快照）。管理员账号受保护，不可删除。</p>
  </section>`;
}

/* ---------------- 邀请码 ---------------- */

function invitesView(s: AdminState): string {
  const rows = s.invites
    .map(
      (i) => `
    <tr>
      <td><code>${esc(i.code)}</code></td>
      <td>${i.usedAt ? `已被 ${esc(i.usedByName ?? '?')} 使用` : '<span class="a-ok">未使用</span>'}</td>
      <td>${new Date(i.createdAt).toLocaleString('zh-CN')}</td>
    </tr>`,
    )
    .join('');

  return `
  <section class="a-panel">
    <h2 class="a-h2">邀请码</h2>
    <div class="a-row">
      <button class="a-btn" data-action="invite-create" data-count="1">生成 1 个</button>
      <button class="a-btn" data-action="invite-create" data-count="5">生成 5 个</button>
    </div>
    <table class="a-table">
      <thead><tr><th>邀请码</th><th>状态</th><th>创建时间</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="3" class="a-muted">还没有邀请码</td></tr>'}</tbody>
    </table>
  </section>`;
}

/* ---------------- 系统设置 ---------------- */

function settingsView(s: AdminState): string {
  const llm = s.llm;
  return `
  <section class="a-panel">
    <h2 class="a-h2">修改管理员密码</h2>
    <form data-role="admin-pw-form" class="a-form">
      <label class="a-label">当前密码 <input class="a-input" type="password" name="current" required /></label>
      <label class="a-label">新密码（至少 8 位） <input class="a-input" type="password" name="next" required minlength="8" /></label>
      <button class="a-btn" type="submit" ${s.pwBusy ? 'disabled' : ''}>${s.pwBusy ? '提交中…' : '修改密码'}</button>
    </form>
  </section>

  <section class="a-panel">
    <h2 class="a-h2">LLM 服务商（站方模型）</h2>
    <p class="a-muted">修改后立即生效（新配置存 D1）。API Key 留空 = 沿用部署时的 secret，不会回显。</p>
    <form data-role="admin-llm-form" class="a-form">
      <label class="a-label">API 地址 <input class="a-input" name="baseURL" placeholder="https://api.deepseek.com/v1" value="${esc(llm?.baseURL ?? '')}" required /></label>
      <label class="a-label">模型名 <input class="a-input" name="model" placeholder="deepseek-flash" value="${esc(llm?.model ?? '')}" required /></label>
      <label class="a-label">API Key（留空不改） <input class="a-input" type="password" name="apiKey" placeholder="${llm?.hasKey ? '已配置（不回显）' : '未配置'}" /></label>
      <button class="a-btn" type="submit" ${s.llmBusy ? 'disabled' : ''}>${s.llmBusy ? '保存中…' : '保存'}</button>
    </form>
  </section>`;
}
