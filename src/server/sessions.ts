import type { SoloSession } from '../shared/domain.ts';

/**
 * 对局会话的持久化：接口与常量。
 *
 * 本文件被 Node 与 Workers **两端**引用（workers/d1.ts 要 import
 * SESSION_TTL_MS 与 SessionPersistence），所以禁止 import `node:*`。
 * Node 侧的三个实现（Sqlite / Json / Memory）在 `sessions-node.ts`。
 */

export interface SessionPersistence {
  load(): SoloSession[] | Promise<SoloSession[]>;
  /** 按 id 加载单条（Workers 多 isolate 兜底）；Node 实现可不提供 */
  loadOne?(id: string): Promise<SoloSession | null> | SoloSession | null;
  /** 允许异步实现（D1）；Node 端实现保持同步 */
  save(session: SoloSession): void | Promise<void>;
  flush(): void | Promise<void>;
}

export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
