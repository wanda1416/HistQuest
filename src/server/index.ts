import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config, serverModelReady } from '../config.ts';
import { CharacterStore } from './characters.ts';
import { createAdminRoutes } from './admin.ts';
import { createRoutes } from './routes.ts';
import { SoloStore } from './solo.ts';
import { log } from './util.ts';

export interface AppOptions {
  charactersFile?: string;
  /** 传 null 关闭会话持久化（测试用） */
  sessionsFile?: string | null;
  /** 后台写入前的备份目录（测试用临时目录） */
  backupDir?: string;
}

export function createApp(options: AppOptions = {}) {
  const charactersFile = options.charactersFile ?? config.paths.characters;
  const sessionsFile = options.sessionsFile === undefined ? config.paths.sessions : options.sessionsFile;
  const backupDir = options.backupDir ?? config.admin.backupDir;

  const store = new CharacterStore({
    file: charactersFile,
    backupDir,
    backupKeep: config.admin.backupKeep,
  });
  const solo = new SoloStore(store.index, { turns: config.soloTurns, file: sessionsFile });

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

  return { app, index: store.index, store, solo };
}

if (import.meta.filename === process.argv[1] || process.env.HQ_STANDALONE === '1') {
  const { app, store, solo } = createApp();
  const host = process.env.HOST ?? '127.0.0.1';

  const shutdown = (): void => {
    solo.flush();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  app.listen(config.port, host, () => {
    log('listen', {
      host,
      port: config.port,
      characters: store.activeCount,
      serverModelReady: serverModelReady(),
      distServed: fs.existsSync(config.paths.dist),
      adminToken: Boolean(config.admin.token),
    });
  });
}
