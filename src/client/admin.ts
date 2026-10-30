import type { Character } from '../shared/domain.ts';
import type { Issue } from '../core/schema.ts';
import type { HistoryDetail, HistorySummary } from '../shared/protocol.ts';
import { renderAdmin } from './admin-views.ts';
import type { AdminMeta, AdminState, AdminUserRow, AdminInviteRow, HealthReport } from './admin-views.ts';

const root = document.getElementById('admin')!;
const TOKEN_KEY = 'hq.adminToken';

let state: AdminState = {
  ready: false,
  error: null,
  notice: null,
  meta: null,
  list: [],
  total: 0,
  filters: { q: '', polity: '', region: '', difficulty: '', retired: '' },
  view: 'list',
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
  history: [],
  historyTotal: 0,
  historyDetail: null,
  historyFilters: { user: '', result: '', q: '' },
};

function render(): void {
  const y = window.scrollY;
  root.innerHTML = renderAdmin(state);
  window.scrollTo(0, y);
}

function setState(patch: Partial<AdminState>): void {
  state = { ...state, ...patch };
  render();
}

/* ---------------- 请求 ---------------- */

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers: Record<string, string> = { 'X-HQ-Admin': '1' };
  if (method !== 'GET') headers['Content-Type'] = 'application/json';
  if (state.token) headers.Authorization = `Bearer ${state.token}`;

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new Error('连不上本地服务，确认它还在运行');
  }

  const data = (await res.json().catch(() => null)) as
    | (Record<string, unknown> & { message?: string; issues?: Issue[] })
    | null;

  if (!res.ok) {
    const err = new Error(
      res.status === 403
        ? '管理接口拒绝访问：本机以外的请求需要在顶栏填入 ADMIN_TOKEN'
        : String(data?.message ?? `请求失败（${res.status}）`),
    ) as Error & { issues?: Issue[] };
    if (Array.isArray(data?.issues)) err.issues = data.issues;
    throw err;
  }
  return data as T;
}

async function loadMeta(): Promise<void> {
  const meta = await request<AdminMeta>('/api/admin/meta');
  setState({ meta });
}

async function loadUsers(): Promise<void> {
  const res = await request<{ total: number; users: AdminUserRow[] }>('/api/admin/users');
  setState({ users: res.users });
}

async function loadInvites(): Promise<void> {
  const res = await request<{ total: number; invites: AdminInviteRow[] }>('/api/admin/invites');
  setState({ invites: res.invites });
}

async function loadLlm(): Promise<void> {
  const res = await request<{ baseURL: string; model: string; hasKey: boolean; maxTurns: number }>('/api/admin/llm');
  setState({ llm: res });
}

async function loadHistory(): Promise<void> {
  const qs = new URLSearchParams();
  if (state.historyFilters.user) qs.set('user', state.historyFilters.user);
  if (state.historyFilters.result) qs.set('result', state.historyFilters.result);
  if (state.historyFilters.q) qs.set('q', state.historyFilters.q);
  const res = await request<{ total: number; items: HistorySummary[] }>(
    `/api/admin/history?${qs.toString()}`,
  );
  setState({ history: res.items, historyTotal: res.total, historyDetail: null });
}

async function openHistoryGame(id: string): Promise<void> {
  const detail = await request<HistoryDetail>(`/api/admin/history/${encodeURIComponent(id)}`);
  setState({ historyDetail: detail });
}

async function loadList(): Promise<void> {
  const qs = new URLSearchParams();
  if (state.filters.q) qs.set('q', state.filters.q);
  if (state.filters.polity) qs.set('polity', state.filters.polity);
  if (state.filters.region) qs.set('region', state.filters.region);
  if (state.filters.difficulty) qs.set('difficulty', state.filters.difficulty);
  if (state.filters.retired) qs.set('retired', state.filters.retired);

  const data = await request<{ total: number; items: Character[] }>(
    `/api/admin/characters?${qs.toString()}`,
  );
  setState({ list: data.items, total: data.total });
}

/* ---------------- 表单同步 ---------------- */

function splitList(value: string): string[] {
  const out: string[] = [];
  for (const part of value.split(/[,，、\n]/)) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function syncDraftField(field: string, el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): void {
  const d = state.draft;
  if (!d) return;

  switch (field) {
    case 'id':
      d.id = el.value.trim();
      break;
    case 'name':
      d.name = el.value.trim();
      break;
    case 'aliases':
      d.aliases = splitList(el.value);
      break;
    case 'tags':
      d.tags = splitList(el.value);
      break;
    case 'polity':
      d.polity = el.value;
      break;
    case 'worldEra':
      d.worldEra = (el.value || undefined) as Character['worldEra'];
      break;
    case 'region':
      d.region = el.value as Character['region'];
      break;
    case 'country':
      d.country = el.value.trim() || null;
      break;
    case 'gender':
      d.gender = el.value as Character['gender'];
      break;
    case 'emperor':
      d.emperor = (el as HTMLInputElement).checked;
      break;
    case 'birth':
      d.birth = el.value === '' ? null : Number(el.value);
      break;
    case 'death':
      d.death = el.value === '' ? null : Number(el.value);
      break;
    case 'birthplace':
      d.birthplace = el.value.trim() || null;
      break;
    case 'birthProvince':
      d.birthProvince = el.value.trim() || null;
      break;
    case 'notable':
      d.notable = el.value;
      break;
    case 'difficulty':
      d.difficulty = Number(el.value);
      break;
    case 'externalId':
      d.externalId = el.value.trim() || undefined;
      break;
    default:
      break;
  }
}

function handleField(el: HTMLElement): void {
  const field = el.getAttribute('data-field');
  if (!field) return;

  if (field === 'token') {
    state.token = (el as HTMLInputElement).value.trim();
    return;
  }
  if (field === 'user-quota') {
    // 失焦（change 事件）时保存
    const id = el.getAttribute('data-id');
    const value = Number((el as HTMLInputElement).value);
    if (!id || !Number.isFinite(value)) return;
    void request(`/api/admin/users/${id}/quota`, {
      method: 'POST',
      body: JSON.stringify({ quota: Math.max(-1, Math.round(value)) }),
    })
      .then(() => {
        setState({ notice: { kind: 'ok', text: '配额已更新' } });
        void loadUsers();
      })
      .catch((err: Error) => setState({ notice: { kind: 'err', text: err.message } }));
    return;
  }
  if (field === 'q') {
    state.filters.q = (el as HTMLInputElement).value.trim();
    return;
  }
  if (field === 'history-user') {
    state.historyFilters.user = (el as HTMLInputElement).value.trim();
    return;
  }
  if (field === 'history-q') {
    state.historyFilters.q = (el as HTMLInputElement).value.trim();
    return;
  }
  if (field === 'history-result') {
    state.historyFilters.result = (el as HTMLSelectElement).value;
    void loadHistory();
    return;
  }
  if (field === 'filter-polity') {
    state.filters.polity = (el as HTMLSelectElement).value;
    void loadList();
    return;
  }
  if (field === 'filter-region') {
    state.filters.region = (el as HTMLSelectElement).value;
    void loadList();
    return;
  }
  if (field === 'filter-difficulty') {
    state.filters.difficulty = (el as HTMLSelectElement).value;
    void loadList();
    return;
  }
  if (field === 'filter-retired') {
    state.filters.retired = (el as HTMLSelectElement).value;
    void loadList();
    return;
  }

  syncDraftField(field, el as HTMLInputElement);
}

/* ---------------- 动作 ---------------- */

function newDraft(): void {
  setState({
    view: 'edit',
    originalId: null,
    issues: [],
    notice: null,
    draft: {
      id: `h${Math.random().toString(16).slice(2, 8)}`,
      name: '',
      aliases: [],
      region: 'cn',
      polity: '唐',
      gender: 'male',
      birth: null,
      death: null,
      birthplace: null,
      birthProvince: null,
      roles: [],
      tags: [],
      emperor: false,
      notable: '',
      difficulty: 2,
    },
  });
}

async function openCharacter(id: string): Promise<void> {
  try {
    const data = await request<{ character: Character }>(
      `/api/admin/characters/${encodeURIComponent(id)}`,
    );
    setState({ view: 'edit', draft: data.character, originalId: id, issues: [], notice: null });
  } catch (err) {
    setState({ notice: { kind: 'err', text: (err as Error).message } });
  }
}

async function saveDraft(): Promise<void> {
  if (!state.draft || state.saving) return;
  const isNew = state.originalId === null;
  setState({ saving: true, issues: [], notice: null });

  try {
    const path = isNew
      ? '/api/admin/characters'
      : `/api/admin/characters/${encodeURIComponent(state.originalId!)}`;
    const data = await request<{ character: Character; issues: Issue[] }>(path, {
      method: isNew ? 'POST' : 'PUT',
      body: JSON.stringify(state.draft),
    });

    setState({
      saving: false,
      draft: data.character,
      originalId: data.character.id,
      issues: data.issues,
      notice: { kind: 'ok', text: isNew ? '已创建，索引已热更新' : '已保存，索引已热更新' },
    });
    await loadMeta();
    await loadList();
  } catch (err) {
    const e = err as Error & { issues?: Issue[] };
    setState({
      saving: false,
      issues: e.issues ?? [],
      notice: { kind: 'err', text: e.message },
    });
  }
}

async function toggleRetire(next: boolean): Promise<void> {
  if (!state.originalId) return;
  try {
    const data = await request<{ character: Character }>(
      `/api/admin/characters/${encodeURIComponent(state.originalId)}/retire`,
      { method: 'POST', body: JSON.stringify({ retired: next }) },
    );
    setState({
      draft: data.character,
      notice: { kind: 'ok', text: next ? '已下线，不会再被抽到（在途对局仍可揭晓）' : '已恢复上架' },
    });
    await loadMeta();
    await loadList();
  } catch (err) {
    setState({ notice: { kind: 'err', text: (err as Error).message } });
  }
}

async function loadHealth(): Promise<void> {
  try {
    const health = await request<HealthReport>('/api/admin/health');
    setState({ view: 'health', health, draft: null, originalId: null, issues: [] });
  } catch (err) {
    setState({ notice: { kind: 'err', text: (err as Error).message } });
  }
}

async function exportJson(): Promise<void> {
  try {
    const res = await fetch('/api/admin/export', { headers: { 'X-HQ-Admin': '1' } });
    if (!res.ok) throw new Error(`导出失败（${res.status}）`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'characters.json';
    link.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    setState({ notice: { kind: 'err', text: (err as Error).message } });
  }
}

/* ---------------- 事件 ---------------- */

root.addEventListener('click', async (event) => {
  const el = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'go-list':
      setState({ view: 'list', draft: null, originalId: null, issues: [], notice: null });
      syncHash('list');
      void loadList();
      break;
    case 'go-users':
      await loadUsers();
      setState({ view: 'users' });
      syncHash('users');
      break;
    case 'go-invites':
      await loadInvites();
      setState({ view: 'invites' });
      syncHash('invites');
      break;
    case 'go-history':
      await loadHistory();
      setState({ view: 'history' });
      syncHash('history');
      break;
    case 'reload-history':
      await loadHistory();
      break;
    case 'open-history':
      if (el.dataset.id) {
        try {
          await openHistoryGame(el.dataset.id);
        } catch (err) {
          setState({ notice: { kind: 'err', text: (err as Error).message } });
        }
      }
      break;
    case 'history-back':
      setState({ historyDetail: null });
      break;
    case 'go-settings':
      await loadLlm();
      setState({ view: 'settings' });
      syncHash('settings');
      break;
    case 'user-server-key':
    case 'user-ban': {
      const id = el.dataset.id ?? '';
      const on = el.dataset.on === '1';
      const kind = action === 'user-server-key' ? 'server-key' : 'ban';
      await request(`/api/admin/users/${id}/${kind}`, { method: 'POST', body: JSON.stringify({ on }) });
      await loadUsers();
      setState({ view: 'users', notice: { kind: 'ok', text: kind === 'ban' ? (on ? '已封禁' : '已解封') : (on ? '已开启站方模型' : '已关闭站方模型') } });
      break;
    }
    case 'invite-create': {
      const count = Number(el.dataset.count) || 1;
      const res = await request<{ codes: string[] }>('/api/admin/invites', { method: 'POST', body: JSON.stringify({ count }) });
      await loadInvites();
      setState({ view: 'invites', notice: { kind: 'ok', text: `已生成：${res.codes.join('、')}` } });
      break;
    }
    case 'go-health':
      syncHash('health');
      void loadHealth();
      break;
    case 'reload':
      void loadList();
      break;
    case 'create':
      newDraft();
      break;
    case 'export':
      void exportJson();
      break;
    case 'edit':
      if (el.dataset.id) void openCharacter(el.dataset.id);
      break;
    case 'toggle-role': {
      const d = state.draft;
      const value = el.dataset.value ?? '';
      if (!d || !value) break;
      d.roles = d.roles.includes(value) ? d.roles.filter((r) => r !== value) : [...d.roles, value];
      render();
      break;
    }
    case 'toggle-alt': {
      const d = state.draft;
      const value = el.dataset.value ?? '';
      if (!d || !value) break;
      const list = d.polityAlt ?? [];
      d.polityAlt = list.includes(value) ? list.filter((x: string) => x !== value) : [...list, value];
      render();
      break;
    }
    case 'add-role': {
      const d = state.draft;
      const input = root.querySelector<HTMLInputElement>('[data-field="role-custom"]');
      const value = input?.value.trim() ?? '';
      if (!d || !value) break;
      if (!d.roles.includes(value)) d.roles = [...d.roles, value];
      if (input) input.value = '';
      render();
      break;
    }
    case 'save':
      void saveDraft();
      break;
    case 'retire':
      void toggleRetire(el.dataset.value === 'true');
      break;
    case 'save-token':
      try {
        if (state.token) sessionStorage.setItem(TOKEN_KEY, state.token);
        else sessionStorage.removeItem(TOKEN_KEY);
      } catch {
        /* 隐私模式忽略 */
      }
      setState({ notice: { kind: 'ok', text: '令牌已更新' }, error: null });
      void boot(true);
      break;
    default:
      break;
  }
});

const onField = (event: Event): void => {
  const el = event.target as HTMLElement;
  if (!el || typeof el.getAttribute !== 'function') return;
  handleField(el);
};

root.addEventListener('input', onField);
root.addEventListener('change', onField);

root.addEventListener('keydown', (event) => {
  const el = event.target as HTMLElement;
  if (event.key !== 'Enter') return;
  const field = el.getAttribute('data-field');
  if (field === 'q') {
    event.preventDefault();
    void loadList();
  }
  if (field === 'history-user' || field === 'history-q') {
    event.preventDefault();
    void loadHistory();
  }
});

root.addEventListener('submit', (event) => {
  event.preventDefault();
  const form = event.target as HTMLFormElement;
  const role = form.dataset.role;
  if (role === 'admin-pw-form') {
    void changePassword(
      (form.querySelector('[name=current]') as HTMLInputElement)?.value ?? '',
      (form.querySelector('[name=next]') as HTMLInputElement)?.value ?? '',
    );
    return;
  }
  if (role === 'admin-llm-form') {
    void saveLlm(
      (form.querySelector('[name=baseURL]') as HTMLInputElement)?.value?.trim() ?? '',
      (form.querySelector('[name=model]') as HTMLInputElement)?.value?.trim() ?? '',
      (form.querySelector('[name=apiKey]') as HTMLInputElement)?.value ?? '',
    );
    return;
  }
  void saveDraft();
});

/* 系统设置：改密与 LLM 配置 */
async function changePassword(current: string, next: string): Promise<void> {
  if (next.length < 8) {
    setState({ notice: { kind: 'err', text: '新密码至少 8 位' } });
    return;
  }
  setState({ pwBusy: true, notice: null });
  try {
    await request('/api/admin/change-password', { method: 'POST', body: JSON.stringify({ current, next }) });
    setState({ pwBusy: false, notice: { kind: 'ok', text: '密码已修改，下次登录用新密码' } });
  } catch (err) {
    setState({ pwBusy: false, notice: { kind: 'err', text: (err as Error).message } });
  }
}

async function saveLlm(baseURL: string, model: string, apiKey: string): Promise<void> {
  setState({ llmBusy: true, notice: null });
  try {
    await request('/api/admin/llm', {
      method: 'POST',
      body: JSON.stringify({ baseURL, model, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) }),
    });
    await loadLlm();
    setState({ llmBusy: false, notice: { kind: 'ok', text: 'LLM 配置已保存并生效' } });
  } catch (err) {
    setState({ llmBusy: false, notice: { kind: 'err', text: (err as Error).message } });
  }
}


/* ---------------- hash 路由：刷新保持在当前页 ---------------- */

const VIEW_HASH: Record<AdminState['view'], string> = {
  list: 'data',
  edit: 'data',
  health: 'health',
  users: 'users',
  invites: 'invites',
  settings: 'settings',
  history: 'history',
};

const HASH_VIEW: Record<string, AdminState['view']> = {
  data: 'list',
  health: 'health',
  users: 'users',
  invites: 'invites',
  settings: 'settings',
  history: 'history',
};

function syncHash(view: AdminState['view']): void {
  const h = '#' + (VIEW_HASH[view] ?? 'data');
  if (location.hash !== h) history.replaceState(null, '', h);
}

async function viewFromHash(): Promise<void> {
  const key = location.hash.replace('#', '') || 'data';
  const view = HASH_VIEW[key] ?? 'list';
  if (view === 'users') await loadUsers();
  if (view === 'invites') await loadInvites();
  if (view === 'settings') await loadLlm();
  if (view === 'history') await loadHistory();
  setState({ view, notice: null });
}

/* ---------------- 启动 ---------------- */

async function boot(reinitialized = false): Promise<void> {
  if (!reinitialized) {
    try {
      state.token = sessionStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      state.token = '';
    }
  }

  try {
    const meta = await request<AdminMeta>('/api/admin/meta');
    const list = await request<{ total: number; items: Character[] }>('/api/admin/characters');
    setState({
      ready: true,
      error: null,
      meta,
      list: list.items,
      total: list.total,
      view: 'list',
      draft: null,
      originalId: null,
      issues: [],
    });
  } catch (err) {
    setState({ ready: true, error: (err as Error).message });
  }
}

void (async () => {
  await boot();
  if (state.ready && !state.error) await viewFromHash();
})();
window.addEventListener('hashchange', () => {
  if (state.ready) void viewFromHash();
});
