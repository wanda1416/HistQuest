import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config, serverModelReady } from '../config.ts';
import type { CharacterIndex } from '../core/index.ts';
import { CharacterStore, readCharacters } from './characters.ts';
import type { CharacterStoreLike } from './characters-sqlite.ts';
import { SqliteCharacterStore, importCharacters } from './characters-sqlite.ts';
import { createAdminRoutes } from './admin.ts';
import { integrityCheck, openDatabase, tableCount } from './db.ts';
import { createRoutes } from './routes.ts';
import { SoloStore } from './solo.ts';
import { log } from './util.ts';

export interface AppOptions {
  charactersFile?: string;
  /** 传 null 关闭会话持久化（测试用） */
  sessionsFile?: string | null;
  /** 后台写入前的备份目录（测试用临时目录） */
  backupDir?: string;
  /** 数据库文件；不传时按 store 模式决定（测试用 :memory:） */
  dbFile?: string;
  /** 存储后端；默认 sqlite，HQ_STORE=json 可回滚到 JSON */
  store?: 'sqlite' | 'json';
}

export interface CreatedApp {
  app: express.Express;
  index: CharacterIndex;
  store: CharacterStoreLike;
  solo: SoloStore;
  db: DatabaseSync | null;
}

export function createApp(options: AppOptions = {}): CreatedApp {
  const charactersFile = options.charactersFile ?? config.paths.characters;
  const sessionsFile = options.sessionsFile === undefined ? config.paths.sessions : options.sessionsFile;
  const backupDir = options.backupDir ?? config.admin.backupDir;

  const mode = options.store ?? (process.env.HQ_STORE === 'json' ? 'json' : 'sqlite');
  // 测试默认关闭了会话持久化：此时用内存库，避免污染真实 data/hq.db
  const dbFile =
    options.dbFile ?? (sessionsFile === null ? ':memory:' : config.paths.db);

  let db: DatabaseSync | null = null;
  let store: CharacterStoreLike;

  if (mode === 'sqlite') {
    db = openDatabase({ file: dbFile });

    const check = integrityCheck(db);
    if (!check.ok) log('db.integrity.failed', { detail: check.detail });

    // 首次启动：从 JSON 自动迁移，原文件保留作为种子与回滚点
    if (tableCount(db, 'characters') === 0 && fs.existsSync(charactersFile)) {
      const legacy = readCharacters(charactersFile);
      const imported = importCharacters(db, legacy);
      try {
        fs.copyFileSync(charactersFile, `${charactersFile}.migrated`);
      } catch {
        /* 副本写不进去不影响迁移结果 */
      }
      log('db.migrated', { characters: imported, source: charactersFile });
    }

    store = new SqliteCharacterStore({ db, backupDir, backupKeep: config.admin.backupKeep });
  } else {
    store = new CharacterStore({
      file: charactersFile,
      backupDir,
      backupKeep: config.admin.backupKeep,
    });
  }

  const solo = new SoloStore(store.index, {
    turns: config.soloTurns,
    file: db ? null : sessionsFile,
    db: db ?? undefined,
  });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use('/api/admin', createAdminRoutes({ store, solo, token: config.admin.token }));
  app.use('/api', createRoutes({ getIndex: () => store.index, solo }));

  app.get('/admin', (_req: Request, res: Response) => {
    res.redirect('/admin.html');
  });

  if (fs.existsSync(config.paths.dist)) {
    app.use(express.static(config.paths.dist, { index: 'index.html' }));
    app.get(/^\/(?!api).*/, (_req: Request, res: Response) => {
      res.sendFile(path.join(config.paths.dist, 'index.html'));
    });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log('app.error', { message: err.message });
    if (res.headersSent) return;
    res.status(500).json({ error: 'SERVER_ERROR', message: '服务器内部错误' });
  });

  return { app, index: store.index, store, solo, db };
}

if (import.meta.filename === process.argv[1] || process.env.HQ_STANDALONE === '1') {
  const { app, store, solo, db } = createApp();
  const host = process.env.HOST ?? '127.0.0.1';

  const shutdown = (): void => {
    solo.flush();
    db?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.listen(config.port, host, () => {
    log('listen', {
      host,
      port: config.port,
      characters: store.activeCount,
      store: db ? 'sqlite' : 'json',
      serverModelReady: serverModelReady(),
      distServed: fs.existsSync(config.paths.dist),
      adminToken: Boolean(config.admin.token),
    });
  });
}
