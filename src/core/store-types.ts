import type { Character } from '../shared/domain.ts';
import type { CharacterIndex } from './index.ts';
import type { Issue } from './schema.ts';

/**
 * 人物库存储的共享类型（Node JSON 版 / SQLite 版 / D1 版共用）。
 * 放 core 层：workers 的 tsconfig 不含 node:fs 依赖文件。
 */

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
