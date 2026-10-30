import type { DatabaseSync } from 'node:sqlite';

/**
 * 用 node:sqlite 模拟 D1：prepare().bind().all/first/run、exec、batch。
 * 目的只有一个——让 Workers 的路由能在离线测试里真跑一遍，
 * 从而拦住"少 await 导致响应体是 {}"这类只有真打接口才暴露的 bug。
 */
export interface ShimBound {
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface ShimD1 {
  prepare(sql: string): { bind(...values: unknown[]): ShimBound };
  exec(sql: string): Promise<unknown>;
  batch(statements: ShimBound[]): Promise<unknown[]>;
}

export function createD1(db: DatabaseSync): ShimD1 {
  const bound = (sql: string, params: unknown[]): ShimBound => ({
    async all<T>() {
      const rows = db.prepare(sql).all(...(params as never[])) as unknown as T[];
      return { results: rows };
    },
    async first<T>() {
      const row = db.prepare(sql).get(...(params as never[])) as unknown as T | undefined;
      return row ?? null;
    },
    async run() {
      const result = db.prepare(sql).run(...(params as never[]));
      return { meta: { changes: Number(result.changes ?? 0) } };
    },
  });

  return {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => bound(sql, values),
    }),
    async exec(sql: string) {
      db.exec(sql);
      return undefined;
    },
    async batch(statements: ShimBound[]) {
      const out: unknown[] = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
  };
}
