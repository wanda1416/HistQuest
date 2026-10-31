import type { AiCredential, AnswerMode, AnswerRecord, PronounStyle, Region, SoloSession, TargetCategory } from '../shared/domain.ts';
import type { SessionPersistence } from './sessions.ts';
import type { GameRecorder, TargetSnapshot } from './history.ts';
import type { AskRes, GuessRes, RevealRes } from '../shared/protocol.ts';
import type { CharacterIndex } from '../core/index.ts';
import { guessMatches } from '../core/judge.ts';
import { runAsk } from '../core/engine.ts';
import { projectHistory } from './dto.ts';
import { log } from './util.ts';

export type SoloErrorCode = 'NOT_FOUND' | 'NOT_PLAYING' | 'NO_TURNS';

/** 默认 id 生成：两端都有 crypto.randomUUID（Node 19+/Workers 原生） */
function defaultNewId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export class SoloError extends Error {
  readonly code: SoloErrorCode;
  constructor(code: SoloErrorCode, message: string) {
    super(message);
    this.name = 'SoloError';
    this.code = code;
  }
}

export interface SoloStoreOptions {
  /** 服务端允许的最大轮次上限；每局可在 10 到该值之间自选 */
  turns: number;
  /** 默认持久化工厂：Node 侧注入 sessions-node.ts 的实现，Workers 注入 D1 版 */
  persistence?: SessionPersistence;
  /** 未注入 persistence 时用它兜底（不给就是内存版，测试用） */
  makePersistence?: () => SessionPersistence;
  /** 对局归档（永久账本）；不传则只保留 24h 会话，不留历史 */
  history?: GameRecorder;
  /** 预加载的会话列表（Workers：D1 异步读出后注入，跳过同步 load） */
  preloaded?: SoloSession[];
  /** id 生成器（Workers 环境注入 crypto.randomUUID 版本） */
  newId?: () => string;
  /** 异步持久层时等待写完成再返回（Workers：响应后未完成的写会被取消） */
  awaitPersist?: boolean;
}

export interface CreateInput {
  difficulty: number;
  /** 谜底类别：character / event / item / mixed；缺省人物（向后兼容） */
  category?: TargetCategory | 'mixed' | null;
  /** 中国朝代筛选 */
  polity?: string | null;
  /** 文明圈筛选 */
  region?: Region | null;
  /** 世界时期筛选 */
  worldEra?: string | null;
  /** 混合模式下中国人物占比 0–1 */
  cnShare?: number;
  mode?: AnswerMode;
  pronoun?: PronounStyle;
  /** 本局提问轮次，10 到 opts.turns 之间；缺省用 opts.turns */
  turns?: number;
  /** 归属玩家（用户系统）；游客为 null */
  userId?: string | null;
  /** 用户名快照（改名不断联） */
  userName?: string | null;
  rng?: () => number;
}

/** 内存版兜底：测试或显式关闭持久化时用（ Workers/Node 各自注入真实现） */
class MemorySessionPersistence implements SessionPersistence {
  load(): SoloSession[] {
    return [];
  }
  save(): void {}
  flush(): void {}
}

export class SoloStore {
  private sessions = new Map<string, SoloSession>();
  private answerCache = new Map<string, AnswerRecord>();
  private index: CharacterIndex;
  private readonly opts: SoloStoreOptions;
  private readonly persistence: SessionPersistence;

  constructor(index: CharacterIndex, opts: SoloStoreOptions) {
    this.index = index;
    this.opts = opts;
    this.persistence = opts.persistence ?? opts.makePersistence?.() ?? new MemorySessionPersistence();
    if (opts.preloaded) {
      // Workers 环境：D1 异步加载后注入（Node 环境走下面的同步 load）
      for (const s of opts.preloaded) this.sessions.set(s.id, s);
    } else {
      this.load();
    }
  }

  async create(input: CreateInput): Promise<SoloSession> {
    const cnShare = Math.min(1, Math.max(0, input.cnShare ?? 0.5));
    const target = this.index.pick({
      difficulty: input.difficulty,
      category: input.category ?? 'character',
      polity: input.polity ?? null,
      region: input.region ?? null,
      worldEra: input.worldEra ?? null,
      cnShare,
      rng: input.rng,
    });

    const turns = Math.min(this.opts.turns, Math.max(10, Math.round(input.turns ?? this.opts.turns)));
    const now = Date.now();
    const session: SoloSession = {
      id: this.opts.newId ? this.opts.newId() : defaultNewId(),
      targetId: target.id,
      category: target.category ?? 'character',
      difficulty: input.difficulty,
      polity: input.polity ?? null,
      region: input.region ?? null,
      worldEra: input.worldEra ?? null,
      cnShare,
      mode: input.mode ?? 'strict',
      pronoun: input.pronoun ?? 'normal',
      turnsLeft: turns,
      status: 'playing',
      history: [],
      createdAt: now,
      updatedAt: now,
      ...(input.userId ? { userId: input.userId, userName: input.userName ?? null } : {}),
    };

    this.sessions.set(session.id, session);
    await this.persist(session);
    await this.recordStart(session);
    log('solo.create', {
      id: session.id,
      difficulty: input.difficulty,
      polity: session.polity,
      region: session.region,
      cnShare: session.cnShare,
      mode: session.mode,
    });
    return session;
  }

  require(id: string): SoloSession {
    const session = this.sessions.get(id);
    if (!session) throw new SoloError('NOT_FOUND', '找不到这一局，可能已过期');
    return session;
  }

  async ask(
    id: string,
    question: string,
    credential: AiCredential,
    options: { timeoutMs?: number } = {},
  ): Promise<AskRes> {
    const session = await this.requireAsync(id);
    if (session.status !== 'playing') throw new SoloError('NOT_PLAYING', '本局已结束');
    if (session.turnsLeft <= 0) throw new SoloError('NO_TURNS', '提问次数已用完');

    const cacheKey = `${id}::${question.trim()}`;
    const cached = this.answerCache.get(cacheKey);
    if (cached) {
      return this.applyRecord(session, { ...cached, seq: session.history.length + 1 });
    }

    const target = this.index.get(session.targetId);
    if (!target) throw new SoloError('NOT_FOUND', '目标人物丢失');

    const outcome = await runAsk({
      question,
      target,
      index: this.index,
      credential,
      seq: session.history.length + 1,
      mode: session.mode,
      pronoun: session.pronoun,
      timeoutMs: options.timeoutMs,
    });

    if (!outcome.record.transient && !outcome.record.invalid) {
      this.answerCache.set(cacheKey, outcome.record);
    }

    // 玩家在提问中点名猜中：直接结算，这一问不扣次数
    if (outcome.won) {
      session.history.push(outcome.record);
      session.status = 'won';
      session.updatedAt = Date.now();
      await this.persist(session);
      await this.recordTurn(session, outcome.record);
      log('solo.win', { id, via: 'ask' });
      const view: AskRes = {
        accepted: true,
        seq: outcome.record.seq,
        verdict: outcome.record.verdict,
        text: outcome.record.text,
        turnsLeft: session.turnsLeft,
        status: session.status,
      };
      if (outcome.record.hint) view.hint = outcome.record.hint;
      return view;
    }

    return this.applyRecord(session, outcome.record);
  }

  async guess(id: string, name: string): Promise<GuessRes> {
    const session = await this.requireAsync(id);
    if (session.status !== 'playing') throw new SoloError('NOT_PLAYING', '本局已结束');

    const target = this.index.get(session.targetId);
    if (!target) throw new SoloError('NOT_FOUND', '目标人物丢失');

    if (guessMatches(target, name)) {
      session.status = 'won';
      session.updatedAt = Date.now();
      await this.persist(session);
      await this.recordSync(session);
      log('solo.win', { id });
      return { correct: true, status: session.status, turnsLeft: session.turnsLeft };
    }

    session.turnsLeft = Math.max(0, session.turnsLeft - 1);
    if (session.turnsLeft === 0) session.status = 'revealed';
    session.updatedAt = Date.now();
    await this.persist(session);
    await this.recordSync(session);
    return {
      correct: false,
      status: session.status,
      turnsLeft: session.turnsLeft,
      hint: '不是这个人。',
    };
  }

  async reveal(id: string): Promise<RevealRes> {
    const session = await this.requireAsync(id);
    const target = this.index.get(session.targetId);
    if (!target) throw new SoloError('NOT_FOUND', '目标人物丢失');

    if (session.status === 'playing') {
      session.status = 'revealed';
      session.updatedAt = Date.now();
      await this.persist(session);
      await this.recordSync(session);
    }

    const turnsUsed = session.history.filter((r) => !r.transient && !r.invalid).length;
    return {
      character: target,
      status: session.status,
      turnsUsed,
      history: projectHistory(session.history),
    };
  }

  private async applyRecord(session: SoloSession, record: AnswerRecord): Promise<AskRes> {
    session.history.push(record);
    session.updatedAt = Date.now();

    if (!record.transient && !record.invalid) {
      session.turnsLeft = Math.max(0, session.turnsLeft - 1);
      if (session.turnsLeft === 0) session.status = 'revealed';
    }

    await this.persist(session);
    await this.recordTurn(session, record);

    const view: AskRes = {
      accepted: !record.invalid && !record.transient,
      seq: record.seq,
      verdict: record.verdict,
      text: record.text,
      turnsLeft: session.turnsLeft,
      status: session.status,
    };
    if (record.hint) view.hint = record.hint;
    if (record.invalid) view.invalid = record.invalid;
    return view;
  }

  private load(): void {
    try {
      const result = this.persistence.load();
      // D1 实现返回 Promise：Workers 路径不走这里（preloaded 注入），但保持类型安全
      const list = Array.isArray(result) ? result : [];
      for (const s of list) this.sessions.set(s.id, s);
      if (list.length) log('solo.load', { count: this.sessions.size });
    } catch {
      log('solo.load.failed', {});
    }
  }

  /* ---------------- 对局归档 ---------------- */

  private targetSnapshot(session: SoloSession): TargetSnapshot {
    const c = this.index.get(session.targetId);
    return { name: c?.name ?? session.targetId, roles: c?.roles ?? [] };
  }

  private recordStart(session: SoloSession): void | Promise<void> {
    return this.record((rec) => rec.start(session, this.targetSnapshot(session)));
  }

  private recordTurn(session: SoloSession, record: AnswerRecord): void | Promise<void> {
    return this.record((rec) => rec.turn(session, this.targetSnapshot(session), record));
  }

  private recordSync(session: SoloSession): void | Promise<void> {
    return this.record((rec) => rec.sync(session, this.targetSnapshot(session)));
  }

  /** 归档写失败不该拖垮对局：只记日志，玩家照常继续 */
  private record(write: (rec: GameRecorder) => void | Promise<void>): void | Promise<void> {
    const rec = this.opts.history;
    if (!rec) return;
    try {
      const out = write(rec);
      if (out && typeof (out as Promise<void>).then === 'function') {
        const p = (out as Promise<void>).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('solo.history.failed', { message: (err as Error)?.message ?? 'async' });
        });
        if (this.opts.awaitPersist) return p;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('solo.history.sync-failed', { message: (err as Error).message });
    }
  }

  private persist(session: SoloSession): void | Promise<void> {
    try {
      const out = this.persistence.save(session);
      if (out && typeof (out as Promise<void>).then === 'function') {
        const p = (out as Promise<void>).catch((err: unknown) => {
          // eslint-disable-next-line no-console
          console.error('solo.persist.failed', {
            message: (err as Error)?.message ?? 'async',
            stack: String((err as Error)?.stack ?? '').slice(0, 300),
            cause: String((err as Error)?.cause ?? '').slice(0, 200),
          });
        });
        // 等待模式下返回 Promise（Workers：响应返回后未完成的写会被运行时取消）
        if (this.opts.awaitPersist) return p;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('solo.persist.sync-failed', { message: (err as Error).message });
    }
  }

  /**
   * 内存未命中时从持久层兜底加载（Workers 多 isolate：开局与提问
   * 可能落在不同 isolate，各自内存 Map 不共享，D1 才是 source of truth）。
   */
  async requireAsync(id: string): Promise<SoloSession> {
    const hit = this.sessions.get(id);
    if (hit) return hit;
    const loader = this.persistence.loadOne?.bind(this.persistence);
    if (!loader) throw new SoloError('NOT_FOUND', '找不到这一局，可能已过期');
    const loaded = await loader(id);
    if (!loaded) throw new SoloError('NOT_FOUND', '找不到这一局，可能已过期');
    this.sessions.set(loaded.id, loaded);
    return loaded;
  }

  /**
   * 后台编辑后热替换索引。缓存必须一并清空：
   * 否则同一问题还会拿到编辑前的旧答案。
   */
  reloadIndex(index: CharacterIndex): void {
    this.index = index;
    this.answerCache.clear();
  }

  /** 测试/优雅退出用 */
  flush(): void {
    this.persistence.flush();
  }
}
