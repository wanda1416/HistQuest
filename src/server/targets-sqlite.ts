import type { DatabaseSync } from 'node:sqlite';
import { DYNASTIES, REGIONS, WORLD_ERAS, type Character, type TargetCategory } from '../shared/domain.ts';
import { CharacterIndex } from '../core/index.ts';
import {
  buildHealthMatrices,
  collectVocab,
  normalizeCharacter,
  serializeTargets,
  targetEraFacts,
  validateCharacter,
  validateLibrary,
  type Issue,
} from '../core/schema.ts';
import type { HealthItem, HealthReport, SaveResult } from './targets.ts';
import { vacuumInto, pruneBackups } from './db.ts';

/**
 * 人物库的 SQLite 实现。
 *
 * 与 JSON 版（targets.ts）保持同一套公开方法，createApp 按配置二选一。
 * 内存里仍保留全量列表：184 人量级下，每次写入后重建索引比增量维护更简单可靠。
 */

export interface TargetStoreLike {
  readonly index: CharacterIndex;
  readonly total: number;
  readonly activeCount: number;
  /** 各类别在库数量（人物/事件/物品） */
  readonly categories: Record<TargetCategory, number>;
  list(): Character[];
  find(id: string): Character | undefined;
  check(raw: unknown, idToUpdate?: string | null): { character: Character; issues: Issue[] };
  create(raw: unknown): SaveResult;
  update(id: string, raw: unknown): SaveResult;
  setRetired(id: string, retired: boolean): SaveResult;
  health(): HealthReport;
  exportText(): string;
  vocab(): ReturnType<typeof collectVocab>;
}

interface CharacterRow {
  id: string;
  name: string;
  region: string;
  polity: string;
  polity_alt: string;
  /** 类别化补充事实（性别/籍贯/现藏等）：v8 起人物专用列并入此 JSON */
  facts: string | null;
  birth: number | null;
  death: number | null;
  roles: string;
  tags: string;
  notable: string;
  difficulty: number;
  external_id: string | null;
  retired: number;
  category?: string | null;
}

const UPSERT_COLUMNS = [
  'id',
  'category',
  'name',
  'region',
  'polity',
  'polity_alt',
  'facts',
  'birth',
  'death',
  'roles',
  'tags',
  'notable',
  'difficulty',
  'external_id',
  'retired',
  'updated_at',
] as const;

/** 直接往空库写入（迁移用：此时还不能构造 TargetStore，因为索引不允许空库） */
export function importTargets(db: DatabaseSync, list: Character[]): number {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const c of list) insertRow(db, c);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return list.length;
}

function insertRow(db: DatabaseSync, c: Character): void {
  const cols = UPSERT_COLUMNS.join(', ');
  const placeholders = UPSERT_COLUMNS.map(() => '?').join(', ');
  db.prepare(`INSERT INTO targets (${cols}) VALUES (${placeholders})`).run(
    ...toParams(c, Date.now()),
  );
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO target_aliases (target_id, alias) VALUES (?, ?)',
  );
  for (const alias of c.aliases) stmt.run(c.id, alias);
}

export interface SqliteStoreOptions {
  db: DatabaseSync;
  backupDir: string;
  backupKeep?: number;
}

export class SqliteTargetStore implements TargetStoreLike {
  private readonly db: DatabaseSync;
  private readonly backupDir: string;
  private readonly backupKeep: number;
  private all: Character[] = [];
  private idx!: CharacterIndex;

  constructor(opts: SqliteStoreOptions) {
    this.db = opts.db;
    this.backupDir = opts.backupDir;
    this.backupKeep = Math.max(1, opts.backupKeep ?? 20);
    this.reload();
  }

  get index(): CharacterIndex {
    return this.idx;
  }

  get total(): number {
    return this.all.length;
  }

  get activeCount(): number {
    return this.idx.size;
  }

  get categories(): Record<TargetCategory, number> {
    const out: Record<TargetCategory, number> = { character: 0, event: 0, item: 0 };
    for (const c of this.all) out[c.category ?? 'character'] += 1;
    return out;
  }

  list(): Character[] {
    return this.all.map(clone);
  }

  find(id: string): Character | undefined {
    const found = this.all.find((c) => c.id === id);
    return found ? clone(found) : undefined;
  }

  check(raw: unknown, idToUpdate: string | null = null): { character: Character; issues: Issue[] } {
    const character = normalizeCharacter(raw);
    if (idToUpdate && !character.id) character.id = idToUpdate;

    const others = idToUpdate ? this.all.filter((c) => c.id !== idToUpdate) : this.all;
    const issues = validateCharacter(character, { others });

    if (idToUpdate && character.id !== idToUpdate) {
      issues.unshift({
        level: 'error',
        field: 'id',
        code: 'id_immutable',
        message: 'id 创建后不可修改：会让进行中的对局找不到目标人物',
      });
    }
    return { character, issues };
  }

  create(raw: unknown): SaveResult {
    return this.commit(raw, null);
  }

  update(id: string, raw: unknown): SaveResult {
    return this.commit(raw, id);
  }

  setRetired(id: string, retired: boolean): SaveResult {
    const current = this.all.find((c) => c.id === id);
    if (!current) {
      return {
        ok: false,
        issues: [{ level: 'error', field: 'id', code: 'not_found', message: `找不到 id 为「${id}」的人物` }],
      };
    }
    this.backup();
    this.db
      .prepare('UPDATE targets SET retired = ?, updated_at = ? WHERE id = ?')
      .run(retired ? 1 : 0, Date.now(), id);
    this.reload();

    const next = this.all.find((c) => c.id === id)!;
    return { ok: true, issues: [], character: next, index: this.idx };
  }

  health(): HealthReport {
    const items: HealthItem[] = [];
    for (const c of this.all) {
      const others = this.all.filter((o) => o.id !== c.id);
      for (const issue of validateCharacter(c, { others })) {
        items.push({ ...issue, id: c.id, name: c.name });
      }
    }

    const active = this.idx.list;

    const matricesFor = (cat: TargetCategory | 'all') =>
      buildHealthMatrices(cat === 'all' ? active : active.filter((x) => (x.category ?? 'character') === cat));
    const combined = matricesFor('all');
    const matrix = combined.matrix;
    const regionMatrix = combined.regionMatrix;
    const worldEraMatrix = combined.worldEraMatrix;
    const byCategory = {
      character: { total: this.all.filter((x) => (x.category ?? 'character') === 'character').length, active: active.filter((x) => (x.category ?? 'character') === 'character').length, ...matricesFor('character') },
      event: { total: this.all.filter((x) => (x.category ?? 'character') === 'event').length, active: active.filter((x) => (x.category ?? 'character') === 'event').length, ...matricesFor('event') },
      item: { total: this.all.filter((x) => (x.category ?? 'character') === 'item').length, active: active.filter((x) => (x.category ?? 'character') === 'item').length, ...matricesFor('item') },
    };
    const emptyDynasties = matrix.filter((m) => m.total === 0).map((m) => m.polity);
    const emptyCombos: HealthReport['emptyCombos'] = [];
    for (const m of matrix) {
      if (m.total === 0) continue;
      for (const level of [1, 2, 3]) {
        if (m.levels[String(level)] === 0) emptyCombos.push({ polity: m.polity, difficulty: level });
      }
    }

    return {
      total: this.all.length,
      active: active.length,
      retired: this.all.length - active.length,
      errors: items.filter((i) => i.level === 'error').length,
      warnings: items.filter((i) => i.level === 'warning').length,
      items,
      matrix,
      regionMatrix,
      worldEraMatrix,
      emptyDynasties,
      emptyCombos,
    };
  }

  exportText(): string {
    return serializeTargets(this.all);
  }

  vocab(): ReturnType<typeof collectVocab> {
    return collectVocab(this.all);
  }

  /** 从 JSON 导入（自动迁移或后台导入） */
  importFrom(list: Character[]): { imported: number; skipped: string[] } {
    const existing = new Set(this.all.map((c) => c.id));
    const skipped: string[] = [];
    let imported = 0;

    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of list) {
        if (existing.has(item.id)) {
          skipped.push(item.id);
          continue;
        }
        this.insert(item);
        imported += 1;
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    if (imported > 0) this.reload();
    return { imported, skipped };
  }

  private commit(raw: unknown, idToUpdate: string | null): SaveResult {
    const { character, issues } = this.check(raw, idToUpdate);
    if (issues.some((i) => i.level === 'error')) {
      return { ok: false, issues };
    }

    const next = idToUpdate
      ? this.all.map((c) => (c.id === idToUpdate ? character : c))
      : [...this.all, character];

    const libraryErrors = validateLibrary(next).filter((i) => i.level === 'error');
    if (libraryErrors.length) {
      return { ok: false, issues: libraryErrors };
    }

    this.backup();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (idToUpdate) this.replace(character);
      else this.insert(character);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    this.reload();
    return { ok: true, issues, character };
  }

  private insert(c: Character): void {
    insertRow(this.db, c);
  }

  private replace(c: Character): void {
    const assignments = UPSERT_COLUMNS.filter((col) => col !== 'id')
      .map((col) => `${col} = ?`)
      .join(', ');
    this.db
      .prepare(`UPDATE targets SET ${assignments} WHERE id = ?`)
      .run(...toParams(c, Date.now()).slice(1), c.id);
    this.db.prepare('DELETE FROM target_aliases WHERE target_id = ?').run(c.id);
    this.replaceAliases(c);
  }

  private replaceAliases(c: Character): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO target_aliases (target_id, alias) VALUES (?, ?)');
    for (const alias of c.aliases) stmt.run(c.id, alias);
  }

  private reload(): void {
    this.all = readAll(this.db);
    this.idx = new CharacterIndex(this.all);
  }

  private backup(): void {
    if (this.all.length === 0) return;
    try {
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.(\d{3})Z$/, '-$1')
        .replace('T', '-');
      vacuumInto(this.db, `${this.backupDir}/hq-${stamp}.db`);
      pruneBackups(this.backupDir, this.backupKeep);
    } catch (err) {
      // 与 JSON 版一致：没有回滚点的写入是危险的
      throw new Error(`备份失败，已取消保存：${(err as Error).message}`);
    }
  }
}

function toParams(c: Character, now: number): Array<string | number | null> {
  return [
    c.id,
    c.category ?? 'character',
    c.name,
    c.region,
    // era：中国=朝代，世界=时期（见 schema.targetEraFacts）
    targetEraFacts(c).era,
    JSON.stringify(c.polityAlt ?? []),
    // 人物专用便利字段折叠进 facts JSON（v8 起存储层不再有独立列）
    JSON.stringify(targetEraFacts(c).facts),
    c.birth,
    c.death,
    JSON.stringify(c.roles),
    JSON.stringify(c.tags),
    c.notable,
    c.difficulty,
    c.externalId ?? null,
    c.retired ? 1 : 0,
    now,
  ];
}

/** Character 便利字段 → facts JSON（存储层合并；读取时往返水合） */
function readAll(db: DatabaseSync): Character[] {
  const rows = db.prepare('SELECT * FROM targets ORDER BY id').all() as unknown as CharacterRow[];
  const aliasRows = db
    .prepare('SELECT target_id, alias FROM target_aliases ORDER BY target_id, alias')
    .all() as unknown as Array<{ target_id: string; alias: string }>;

  const aliasMap = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = aliasMap.get(row.target_id) ?? [];
    list.push(row.alias);
    aliasMap.set(row.target_id, list);
  }

  return rows.map((r) => rowToCharacter(r, aliasMap.get(r.id) ?? []));
}

function rowToCharacter(r: CharacterRow, aliases: string[]): Character {
  const alt = safeJson<string[]>(r.polity_alt, []);
  const category = (r.category ?? 'character') as Character['category'];
  const facts = safeJson<Record<string, unknown>>(r.facts ?? null, {});
  return {
    id: r.id,
    ...(category !== 'character' ? { category } : {}),
    name: r.name,
    aliases,
    region: r.region as Character['region'],
    polity: r.polity,
    ...(alt.length ? { polityAlt: alt } : {}),
    // 非中国条目 polity 即时期（v8 合并 world_era 后）
    ...(r.region !== 'cn' && r.polity ? { worldEra: r.polity as Character['worldEra'] } : {}),
    // 人物专用便利字段从 facts 往返水合（v8 起存储层无独立列）
    gender: ((facts.gender as string) ?? 'male') as Character['gender'],
    emperor: Boolean(facts.emperor),
    birth: r.birth,
    death: r.death,
    birthplace: (facts.birthplace ?? null) as string | null,
    birthProvince: (facts.province ?? null) as string | null,
    ...(facts.regime ? { regime: facts.regime as string } : {}),
    ...(facts.country ? { country: facts.country as string } : {}),
    roles: safeJson<string[]>(r.roles, []),
    tags: safeJson<string[]>(r.tags, []),
    notable: r.notable,
    difficulty: r.difficulty,
    ...(r.external_id ? { externalId: r.external_id } : {}),
    ...(r.retired === 1 ? { retired: true } : {}),
  };
}

function safeJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clone(c: Character): Character {
  return {
    ...c,
    aliases: [...c.aliases],
    ...(c.polityAlt ? { polityAlt: [...c.polityAlt] } : {}),
    roles: [...c.roles],
    tags: [...c.tags],
  };
}
