import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { AiCredential, AnswerMode, AnswerRecord, PronounStyle, SoloSession } from '../shared/domain.ts';
import type { AskRes, GuessRes, RevealRes } from '../shared/protocol.ts';
import type { CharacterIndex } from '../core/index.ts';
import { guessMatches } from '../core/judge.ts';
import { runAsk } from '../core/engine.ts';
import { projectHistory } from './dto.ts';
import { log } from './util.ts';

export type SoloErrorCode = 'NOT_FOUND' | 'NOT_PLAYING' | 'NO_TURNS';

export class SoloError extends Error {
  readonly code: SoloErrorCode;
  constructor(code: SoloErrorCode, message: string) {
    super(message);
    this.name = 'SoloError';
    this.code = code;
  }
}

export interface SoloStoreOptions {
  turns: number;
  /** 传 null 关闭持久化（测试用） */
  file?: string | null;
}

export interface CreateInput {
  difficulty: number;
  dynasty: string | null;
  mode?: AnswerMode;
  pronoun?: PronounStyle;
  rng?: () => number;
}

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export class SoloStore {
  private sessions = new Map<string, SoloSession>();
  private answerCache = new Map<string, AnswerRecord>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private index: CharacterIndex;
  private readonly opts: SoloStoreOptions;

  constructor(index: CharacterIndex, opts: SoloStoreOptions) {
    this.index = index;
    this.opts = opts;
    this.load();
  }

  create(input: CreateInput): SoloSession {
    const target = this.index.pick({
      difficulty: input.difficulty,
      dynasty: input.dynasty,
      rng: input.rng,
    });

    const now = Date.now();
    const session: SoloSession = {
      id: randomBytes(12).toString('hex'),
      targetId: target.id,
      difficulty: input.difficulty,
      dynasty: input.dynasty,
      mode: input.mode ?? 'strict',
      pronoun: input.pronoun ?? 'normal',
      turnsLeft: this.opts.turns,
      status: 'playing',
      history: [],
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(session.id, session);
    this.persist();
    log('solo.create', { id: session.id, difficulty: input.difficulty, dynasty: input.dynasty, mode: session.mode });
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
    const session = this.require(id);
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
      this.persist();
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

  guess(id: string, name: string): GuessRes {
    const session = this.require(id);
    if (session.status !== 'playing') throw new SoloError('NOT_PLAYING', '本局已结束');

    const target = this.index.get(session.targetId);
    if (!target) throw new SoloError('NOT_FOUND', '目标人物丢失');

    if (guessMatches(target, name)) {
      session.status = 'won';
      session.updatedAt = Date.now();
      this.persist();
      log('solo.win', { id });
      return { correct: true, status: session.status, turnsLeft: session.turnsLeft };
    }

    session.turnsLeft = Math.max(0, session.turnsLeft - 1);
    if (session.turnsLeft === 0) session.status = 'revealed';
    session.updatedAt = Date.now();
    this.persist();
    return {
      correct: false,
      status: session.status,
      turnsLeft: session.turnsLeft,
      hint: '不是这个人。',
    };
  }

  reveal(id: string): RevealRes {
    const session = this.require(id);
    const target = this.index.get(session.targetId);
    if (!target) throw new SoloError('NOT_FOUND', '目标人物丢失');

    if (session.status === 'playing') {
      session.status = 'revealed';
      session.updatedAt = Date.now();
      this.persist();
    }

    const turnsUsed = session.history.filter((r) => !r.transient && !r.invalid).length;
    return {
      character: target,
      status: session.status,
      turnsUsed,
      history: projectHistory(session.history),
    };
  }

  private applyRecord(session: SoloSession, record: AnswerRecord): AskRes {
    session.history.push(record);
    session.updatedAt = Date.now();

    if (!record.transient && !record.invalid) {
      session.turnsLeft = Math.max(0, session.turnsLeft - 1);
      if (session.turnsLeft === 0) session.status = 'revealed';
    }

    this.persist();

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
    const file = this.opts.file;
    if (!file || !fs.existsSync(file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SoloSession[];
      const now = Date.now();
      for (const s of raw) {
        if (now - s.updatedAt < SESSION_TTL_MS) this.sessions.set(s.id, s);
      }
      log('solo.load', { count: this.sessions.size });
    } catch {
      log('solo.load.failed', {});
    }
  }

  private persist(): void {
    const file = this.opts.file;
    if (!file) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify([...this.sessions.values()]), 'utf8');
      } catch (err) {
        log('solo.persist.failed', { message: (err as Error).message });
      }
    }, 200);
    this.saveTimer.unref?.();
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
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const file = this.opts.file;
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify([...this.sessions.values()]), 'utf8');
    } catch {
      /* ignore */
    }
  }
}
