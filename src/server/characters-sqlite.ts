import type { DatabaseSync } from 'node:sqlite';
import { DYNASTIES, REGIONS, type Character, type TargetCategory } from '../shared/domain.ts';
import { CharacterIndex } from '../core/index.ts';
import {
  collectVocab,
  normalizeCharacter,
  serializeCharacters,
  validateCharacter,
  validateLibrary,
  type Issue,
} from '../core/schema.ts';
import type { HealthItem, HealthReport, SaveResult } from './characters.ts';
import { vacuumInto, pruneBackups } from './db.ts';

/**
 * 人物库的 SQLite 实现。
 *
 * 与 JSON 版（characters.ts）保持同一套公开方法，createApp 按配置二选一。
 * 内存里仍保留全量列表：184 人量级下，每次写入后重建索引比增量维护更简单可靠。
 */

export interface CharacterStoreLike {
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
  world_era: string | null;
  gender: string;
  birth: number | null;
  death: number | null;
  birthplace: string | null;
  country: string | null;
  birth_province: string | null;
  roles: string;
  tags: string;
  emperor: number;
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
  'world_era',
  'gender',
  'birth',
  'death',
  'birthplace',
  'country',
  'birth_province',
  'roles',
  'tags',
  'emperor',
  'notable',
  'difficulty',
  'external_id',
  'retired',
  'updated_at',
] as const;

/** 直接往空库写入（迁移用：此时还不能构造 CharacterStore，因为索引不允许空库） */
export function importCharacters(db: DatabaseSync, list: Character[]): number {
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
  db.prepare(`INSERT INTO characters (${cols}) VALUES (${placeholders})`).run(
    ...toParams(c, Date.now()),
  );
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO character_aliases (character_id, alias) VALUES (?, ?)',
  );
  for (const alias of c.aliases) stmt.run(c.id, alias);
}

export interface SqliteStoreOptions {
  db: DatabaseSync;
  backupDir: string;
  backupKeep?: number;
}

export class SqliteCharacterStore implements CharacterStoreLike {
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
      .prepare('UPDATE characters SET retired = ?, updated_at = ? WHERE id = ?')
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

    const cnRows = this.db
      .prepare(
        `SELECT polity AS key, difficulty AS d, COUNT(*) AS n FROM characters
         WHERE region = 'cn' AND retired = 0 GROUP BY polity, difficulty`,
      )
      .all() as unknown as Array<{ key: string; d: number; n: number }>;
    const regionRows = this.db
      .prepare(
        `SELECT region AS key, difficulty AS d, COUNT(*) AS n FROM characters
         WHERE retired = 0 GROUP BY region, difficulty`,
      )
      .all() as unknown as Array<{ key: string; d: number; n: number }>;

    const matrix = DYNASTIES.map((polity) => {
      const levels: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
      let total = 0;
      for (const row of cnRows.filter((r) => r.key === polity)) {
        levels[String(row.d)] = row.n;
        total += row.n;
      }
      return { polity, levels, total };
    });

    const regionMatrix = REGIONS.map((region) => {
      const levels: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
      let total = 0;
      for (const row of regionRows.filter((r) => r.key === region)) {
        levels[String(row.d)] = row.n;
        total += row.n;
      }
      return { region, levels, total };
    });

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
      emptyDynasties,
      emptyCombos,
    };
  }

  exportText(): string {
    return serializeCharacters(this.all);
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
      .prepare(`UPDATE characters SET ${assignments} WHERE id = ?`)
      .run(...toParams(c, Date.now()).slice(1), c.id);
    this.db.prepare('DELETE FROM character_aliases WHERE character_id = ?').run(c.id);
    this.replaceAliases(c);
  }

  private replaceAliases(c: Character): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO character_aliases (character_id, alias) VALUES (?, ?)');
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
    c.polity,
    JSON.stringify(c.polityAlt ?? []),
    c.worldEra ?? null,
    c.gender,
    c.birth,
    c.death,
    c.birthplace,
    c.country ?? null,
    c.birthProvince,
    JSON.stringify(c.roles),
    JSON.stringify(c.tags),
    c.emperor ? 1 : 0,
    c.notable,
    c.difficulty,
    c.externalId ?? null,
    c.retired ? 1 : 0,
    now,
  ];
}

function readAll(db: DatabaseSync): Character[] {
  const rows = db.prepare('SELECT * FROM characters ORDER BY id').all() as unknown as CharacterRow[];
  const aliasRows = db
    .prepare('SELECT character_id, alias FROM character_aliases ORDER BY character_id, alias')
    .all() as unknown as Array<{ character_id: string; alias: string }>;

  const aliasMap = new Map<string, string[]>();
  for (const row of aliasRows) {
    const list = aliasMap.get(row.character_id) ?? [];
    list.push(row.alias);
    aliasMap.set(row.character_id, list);
  }

  return rows.map((r) => rowToCharacter(r, aliasMap.get(r.id) ?? []));
}

function rowToCharacter(r: CharacterRow, aliases: string[]): Character {
  const alt = safeJson<string[]>(r.polity_alt, []);
  const category = (r.category ?? 'character') as Character['category'];
  return {
    id: r.id,
    ...(category !== 'character' ? { category } : {}),
    name: r.name,
    aliases,
    region: r.region as Character['region'],
    polity: r.polity,
    ...(alt.length ? { polityAlt: alt } : {}),
    ...(r.world_era ? { worldEra: r.world_era as Character['worldEra'] } : {}),
    gender: r.gender as Character['gender'],
    birth: r.birth,
    death: r.death,
    birthplace: r.birthplace,
    ...(r.country ? { country: r.country } : {}),
    birthProvince: r.birth_province,
    roles: safeJson<string[]>(r.roles, []),
    tags: safeJson<string[]>(r.tags, []),
    emperor: r.emperor === 1,
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
