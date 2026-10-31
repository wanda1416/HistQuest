import { DYNASTIES, REGIONS, WORLD_ERAS, type Character, type TargetCategory } from '../src/shared/domain.ts';
import { CharacterIndex } from '../src/core/index.ts';
import {
  buildHealthMatrices,
  collectVocab,
  normalizeCharacter,
  serializeTargets,
  targetEraFacts,
  validateCharacter,
  validateLibrary,
  type Issue,
} from '../src/core/schema.ts';
import type { D1Database } from './d1.ts';
import { loadTargetsFromD1 } from './d1.ts';
import type { HealthItem, HealthReport, SaveResult } from '../src/core/store-types.ts';

/**
 * 人物库的 D1 实现（Workers）。
 * 与 SqliteTargetStore 同一套方法/同一策略：内存全量列表，
 * 写入时同步 D1 并整体重建索引——184 人量级下这比增量维护更简单可靠。
 * 区别：无备份文件（D1 自带时间旅行恢复），写操作为异步。
 */

interface D1TargetStoreOptions {
  db: D1Database;
}

const UPSERT_COLUMNS = [
  'id', 'category', 'name', 'region', 'polity', 'polity_alt', 'facts',
  'birth', 'death', 'roles',
  'tags', 'notable', 'difficulty', 'external_id', 'retired', 'updated_at',
] as const;

function toParams(c: Character, now: number): Array<string | number | null> {
  // era 统一存"处于什么时期"（中国=朝代，世界=时期）；人物专用便利字段
  // 折叠进 facts JSON（与 Node 端 targets-sqlite 同一套拆分，见 schema.targetEraFacts）
  const { era, facts } = targetEraFacts(c);
  return [
    c.id,
    c.category ?? 'character',
    c.name,
    c.region,
    era,
    JSON.stringify(c.polityAlt ?? []),
    JSON.stringify(facts),
    c.birth ?? null,
    c.death ?? null,
    JSON.stringify(c.roles),
    JSON.stringify(c.tags),
    c.notable,
    c.difficulty,
    null,
    c.retired ? 1 : 0,
    now,
  ];
}

const clone = (c: Character): Character => JSON.parse(JSON.stringify(c));

export class D1TargetStore {
  private readonly db: D1Database;
  private all: Character[] = [];
  private idx!: CharacterIndex;

  constructor(opts: D1TargetStoreOptions) {
    this.db = opts.db;
  }

  /** 异步初始化（Worker 启动路径调用） */
  async init(seed: Character[]): Promise<void> {
    this.all = await loadTargetsFromD1(this.db);
    if (this.all.length === 0 && seed.length > 0) {
      const { seedTargetsIntoD1 } = await import('./d1.ts');
      await seedTargetsIntoD1(this.db, seed);
      this.all = await loadTargetsFromD1(this.db);
    }
    this.idx = new CharacterIndex(this.all);
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

  async create(raw: unknown): Promise<SaveResult> {
    return this.commit(raw, null);
  }

  async update(id: string, raw: unknown): Promise<SaveResult> {
    return this.commit(raw, id);
  }

  async setRetired(id: string, retired: boolean): Promise<SaveResult> {
    const current = this.all.find((c) => c.id === id);
    if (!current) {
      return {
        ok: false,
        issues: [{ level: 'error', field: 'id', code: 'not_found', message: `找不到 id 为「${id}」的人物` }],
      };
    }
    await this.db
      .prepare('UPDATE targets SET retired = ?, updated_at = ? WHERE id = ?')
      .bind(retired ? 1 : 0, Date.now(), id)
      .run();
    await this.reload();
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
      byCategory,
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

  private async commit(raw: unknown, idToUpdate: string | null): Promise<SaveResult> {
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

    const now = Date.now();
    const cols = UPSERT_COLUMNS.join(', ');
    const placeholders = UPSERT_COLUMNS.map(() => '?').join(', ');
    const params = toParams(character, now);

    await this.db
      .prepare(
        `INSERT INTO targets (${cols}) VALUES (${placeholders})
         ON CONFLICT(id) DO UPDATE SET ${
           UPSERT_COLUMNS.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')
         }`,
      )
      .bind(...params)
      .run();
    await this.db.prepare('DELETE FROM target_aliases WHERE character_id = ?').bind(character.id).run();
    const aliasStmts = character.aliases.map((a) =>
      this.db
        .prepare('INSERT OR IGNORE INTO target_aliases (character_id, alias) VALUES (?, ?)')
        .bind(character.id, a),
    );
    if (aliasStmts.length > 0) await this.db.batch(aliasStmts);

    await this.reload();
    return { ok: true, issues, character, index: this.idx };
  }

  private async reload(): Promise<void> {
    this.all = await loadTargetsFromD1(this.db);
    this.idx = new CharacterIndex(this.all);
  }
}
