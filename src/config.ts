import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/** 零依赖读取 .env（已存在的环境变量优先） */
function loadEnvFile(): void {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    const key = m[1]!;
    const value = m[2]!.trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile();

function num(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  rootDir: ROOT,
  port: num(process.env.PORT, 3000),
  paths: {
    characters: path.join(ROOT, 'data', 'characters.json'),
    sessions: path.join(ROOT, 'data', 'sessions.json'),
    /** SQLite 主库；首次启动会从 characters.json 自动迁移 */
    db: process.env.HQ_DB ?? path.join(ROOT, 'data', 'hq.db'),
    dist: path.join(ROOT, 'dist'),
  },
  ai: {
    baseURL: process.env.AI_BASE_URL ?? '',
    apiKey: process.env.AI_API_KEY ?? '',
    model: process.env.AI_MODEL ?? '',
    temperature: num(process.env.AI_TEMPERATURE, 0.1),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 6000),
  },
  wikiProvider: process.env.WIKI_PROVIDER ?? 'local',
  /** 服务端允许的轮次上限；每局可在 10 到该值之间自选 */
  soloTurns: num(process.env.SOLO_TURNS, 50),
  admin: {
    /** 非回环访问管理接口时需要的令牌；为空则只允许本机访问 */
    token: process.env.ADMIN_TOKEN ?? '',
    backupDir: path.join(ROOT, 'data', 'backups'),
    backupKeep: num(process.env.ADMIN_BACKUP_KEEP, 20),
  },
};

/** 服务端是否具备可用模型（M2 多人模式依赖；M1 单人走 BYOK 不受影响） */
export function serverModelReady(): boolean {
  return Boolean(config.ai.baseURL && config.ai.apiKey && config.ai.model);
}
