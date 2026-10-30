import fs from 'node:fs';
import path from 'node:path';
import { DYNASTIES, REGIONS, type Character } from '../shared/domain.ts';
import { CharacterIndex } from '../core/index.ts';
import {
  collectVocab,
  normalizeCharacter,
  serializeCharacters,
  validateCharacter,
  validateLibrary,
  type Issue,
} from '../core/schema.ts';

/**
 * 人物库的读写层：校验 → 备份 → 原子写 → 重建索引。
 *
 * 两条硬规则：
 * 1. 任何 error 级校验问题都不落盘；
 * 2. 索引重建后由调用方替换进 SoloStore，否则编辑要重启才生效。
 */

export interface CharacterStoreOptions {
  file: string;
  backupDir: string;
  backupKeep?: number;
}

export interface SaveResult {
  ok: boolean;
  issues: Issue[];
  character?: Character;
  index?: CharacterIndex;
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

const BACKUP_RE = /^characters-\d{8}-\d{6}-\d{3}(-\d+)?\.json$/;

export class CharacterStore {
  private all: Character[];
  private idx: CharacterIndex;
  private readonly file: string;
  private readonly backupDir: string;
  private readonly backupKeep: number;

  constructor(opts: CharacterStoreOptions) {
    this.file = opts.file;
    this.backupDir = opts.backupDir;
    this.backupKeep = Math.max(1, opts.backupKeep ?? 20);
    this.all = readCharacters(this.file);
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

  /** 全量（含已下线）：编辑页要能看到 retired 记录 */
  list(): Character[] {
    return this.all.map(clone);
  }

  find(id: string): Character | undefined {
    const found = this.all.find((c) => c.id === id);
    return found ? clone(found) : undefined;
  }

  /** 干跑校验：不写盘，供后台保存前预检 */
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

  /**
   * 软删除只切换 retired 标志，不做完整校验：
   * 下线一条本身有问题的数据，恰恰是后台应该能做的操作。
   */
  setRetired(id: string, retired: boolean): SaveResult {
    const current = this.all.find((c) => c.id === id);
    if (!current) {
      return {
        ok: false,
        issues: [{ level: 'error', field: 'id', code: 'not_found', message: `找不到 id 为「${id}」的人物` }],
      };
    }
    const next = this.all.map((c) => (c.id === id ? { ...c, ...(retired ? { retired: true } : { retired: undefined }) } : c));
    this.persist(next);
    return { ok: true, issues: [], character: next.find((c) => c.id === id)!, index: this.idx };
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
    const matrix = DYNASTIES.map((polity) => {
      const levels: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
      let total = 0;
      for (const c of active) {
        if (c.region !== 'cn' || c.polity !== polity) continue;
        total += 1;
        const key = String(c.difficulty);
        if (levels[key] !== undefined) levels[key] += 1;
      }
      return { polity, levels, total };
    });

    const regionMatrix = REGIONS.map((region) => {
      const levels: Record<string, number> = { '1': 0, '2': 0, '3': 0 };
      let total = 0;
      for (const c of active) {
        if (c.region !== region) continue;
        total += 1;
        const key = String(c.difficulty);
        if (levels[key] !== undefined) levels[key] += 1;
      }
      return { region, levels, total };
    });

    const emptyDynasties = matrix.filter((m) => m.total === 0).map((m) => m.polity);
    const emptyCombos: Array<{ polity: string; difficulty: number }> = [];
    for (const m of matrix) {
      if (m.total === 0) continue;
      for (const level of [1, 2, 3]) {
        if (m.levels[String(level)] === 0) emptyCombos.push({ polity: m.polity, difficulty: level });
      }
    }

    return {
      total: this.all.length,
      active: this.idx.size,
      retired: this.all.length - this.idx.size,
      errors: items.filter((i) => i.level === 'error').length,
      warnings: items.filter((i) => i.level === 'warning').length,
      items,
      matrix,
      regionMatrix,
      emptyDynasties,
      emptyCombos,
    };
  }

  /** 导出用：当前内存中的规范快照 */
  exportText(): string {
    return serializeCharacters(this.all);
  }

  vocab(): { roles: string[]; provinces: string[]; polities: string[] } {
    return collectVocab(this.all);
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

    this.persist(next);
    return { ok: true, issues, character };
  }

  private persist(next: Character[]): void {
    this.backup();
    writeAtomically(this.file, serializeCharacters(next));
    this.all = next;
    this.idx = new CharacterIndex(next);
  }

  /** 写前快照，最多保留 backupKeep 份 */
  private backup(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      fs.mkdirSync(this.backupDir, { recursive: true });
      const stamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.(\d{3})Z$/, '-$1')
        .replace('T', '-');

      // 同一毫秒内连续保存时追加序号，避免前一份备份被覆盖
      let target = path.join(this.backupDir, `characters-${stamp}.json`);
      let seq = 0;
      while (fs.existsSync(target)) {
        seq += 1;
        target = path.join(this.backupDir, `characters-${stamp}-${seq}.json`);
      }
      fs.copyFileSync(this.file, target);

      const files = fs
        .readdirSync(this.backupDir)
        .filter((f) => BACKUP_RE.test(f))
        .map((f) => ({ name: f, time: fs.statSync(path.join(this.backupDir, f)).mtimeMs }))
        .sort((a, b) => a.time - b.time || a.name.localeCompare(b.name));

      const drop = files.slice(0, Math.max(0, files.length - this.backupKeep));
      for (const f of drop) {
        try {
          fs.rmSync(path.join(this.backupDir, f.name), { force: true });
        } catch {
          /* 备份清理失败不影响本次保存 */
        }
      }
    } catch (err) {
      // 备份失败必须让保存失败：没有回滚点的写入是危险的
      throw new Error(`备份失败，已取消保存：${(err as Error).message}`);
    }
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

function readCharacters(file: string): Character[] {
  const raw = fs.readFileSync(file, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error('人物库必须是 JSON 数组');
  return parsed.map((item) => normalizeCharacter(item));
}

function writeAtomically(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

export { writeAtomically, readCharacters };
