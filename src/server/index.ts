import fs from 'node:fs';
import http from 'node:http';
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
import { createAuthRoutes, ensureAdmin, ensureSessionSecret, readUser, takeQuota } from './auth.ts';
import { integrityCheck, openDatabase, tableCount } from './db.ts';
import { SqliteHistoryStore } from './history.ts';
import { createRoutes } from './routes.ts';
import { createSettingsRoutes } from './settings.ts';
import { SoloStore } from './solo.ts';
import { log } from './util.ts';

/**
 * 开发期反向代理：把非 /api 请求转给 Vite，让 3000 成为唯一入口。
 * HMR 的 WebSocket 由浏览器直连 Vite（见 vite.config 的 hmr.clientPort），不经过这里。
 */
function mountDevProxy(app: express.Express, port: number): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith('/api')) return next();

    const proxyReq = http.request(
      {
        host: '127.0.0.1',
        port,
        path: req.originalUrl,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${port}` },
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );

    proxyReq.on('error', () => {
      if (res.headersSent) return;
      res.status(502).type('text/plain').send('Vite 还没准备好，稍等一秒再刷新');
    });

    req.pipe(proxyReq);
  });
}

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
  /** 覆盖会话签名密钥（测试用；默认取环境变量或库内自动生成） */
  sessionSecret?: string;
}

export interface CreatedApp {
  app: express.Express;
  index: CharacterIndex;
  store: CharacterStoreLike;
  solo: SoloStore;
  db: DatabaseSync | null;
  /** 启动期异步任务（预置管理员）：监听前 await 一次即可 */
  ready: Promise<void>;
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

  const history = db ? new SqliteHistoryStore(db) : null;

  const solo = new SoloStore(store.index, {
    turns: config.soloTurns,
    file: db ? null : sessionsFile,
    db: db ?? undefined,
    history: history ?? undefined,
  });

  // 账号系统只在 SQLite 模式可用：JSON 模式没有 db，历史与账号一并关闭
  const sessionSecret = db
    ? ensureSessionSecret(db, options.sessionSecret ?? config.auth.secret)
    : '';
  const getUser = db
    ? (req: Request) => readUser(db, req, sessionSecret)
    : undefined;
  const quota = db ? (user: Parameters<typeof takeQuota>[1]) => takeQuota(db, user, config.auth.dailyQuota) : undefined;

  const ready = db
    ? ensureAdmin(db, config.auth.adminUser, config.auth.adminPassword)
    : Promise.resolve();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));

  app.use('/api/auth', db ? createAuthRoutes({ db, secret: sessionSecret }) : (_req, res) => {
    res.status(503).json({ error: 'AUTH_DISABLED', message: 'JSON 存储模式下没有账号系统' });
  });
  app.use('/api/admin', createAdminRoutes({ store, solo, token: config.admin.token, db, history, getUser }));
  app.use('/api/settings', createSettingsRoutes({ db }));
  app.use('/api', createRoutes({ getIndex: () => store.index, solo, history, getUser, quota }));

  app.get('/admin', (_req: Request, res: Response) => {
    res.redirect('/admin.html');
  });

  const devProxyPort = Number(process.env.HQ_DEV_PROXY) || 0;
  if (devProxyPort > 0) {
    // 开发模式：前端由 Vite 提供，3000 作为唯一入口
    mountDevProxy(app, devProxyPort);
  } else if (fs.existsSync(config.paths.dist)) {
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

  return { app, index: store.index, store, solo, db, ready };
}

if (import.meta.filename === process.argv[1] || process.env.HQ_STANDALONE === '1') {
  const { app, store, solo, db, ready } = createApp();
  const host = process.env.HOST ?? '127.0.0.1';

  const shutdown = (): void => {
    solo.flush();
    db?.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await ready;
  app.listen(config.port, host, () => {
    log('listen', {
      host,
      port: config.port,
      characters: store.activeCount,
      store: db ? 'sqlite' : 'json',
      serverModelReady: serverModelReady(),
      auth: Boolean(db),
      devProxy: process.env.HQ_DEV_PROXY ?? '',
      distServed: !process.env.HQ_DEV_PROXY && fs.existsSync(config.paths.dist),
      adminToken: Boolean(config.admin.token),
    });
  });
}
