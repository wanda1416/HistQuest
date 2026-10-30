import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import { config, serverModelReady } from '../config.ts';
import { CharacterIndex } from '../core/index.ts';
import type { Character } from '../shared/domain.ts';
import { createRoutes } from './routes.ts';
import { SoloStore } from './solo.ts';
import { log } from './util.ts';

function buildIndex(file: string): CharacterIndex {
  const raw = fs.readFileSync(file, 'utf8');
  const list = JSON.parse(raw) as Character[];
  return new CharacterIndex(list);
}

export interface AppOptions {
  charactersFile?: string;
  /** 传 null 关闭会话持久化（测试用） */
  sessionsFile?: string | null;
}

export function createApp(options: AppOptions = {}) {
  const charactersFile = options.charactersFile ?? config.paths.characters;
  const sessionsFile = options.sessionsFile === undefined ? config.paths.sessions : options.sessionsFile;

  const index = buildIndex(charactersFile);
  const solo = new SoloStore(index, { turns: config.soloTurns, file: sessionsFile });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.use('/api', createRoutes({ index, solo }));

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

  return { app, index, solo };
}

if (import.meta.filename === process.argv[1] || process.env.HQ_STANDALONE === '1') {
  const { app, index } = createApp();
  const host = process.env.HOST ?? '127.0.0.1';
  app.listen(config.port, host, () => {
    log('listen', {
      host,
      port: config.port,
      characters: index.size,
      serverModelReady: serverModelReady(),
      distServed: fs.existsSync(config.paths.dist),
    });
  });
}
