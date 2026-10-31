import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDatabase } from '../src/server/db.ts';
import { createD1 } from './fixtures/d1-sqlite.ts';
import { handleTranscribe } from '../workers/asr.ts';

/**
 * ASR 路由的离线测试：mock 上游 /v1/audio/transcriptions，
 * 验证鉴权、配额、格式校验、透传与响应投影。
 */

/** mock 的 OpenAI 兼容识别端点：回显固定文字，可注入故障 */
function startMockAsr(opts: { status?: number; text?: string } = {}): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c;
      });
      req.on('end', () => {
        if (opts.status && opts.status !== 200) {
          res.writeHead(opts.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'mock failure' }));
          return;
        }
        // 校验透传的模型名
        if (!raw.includes('name="model"')) {
          res.writeHead(500).end('missing model');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ text: opts.text ?? '  他是唐朝人吗 ' }));
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
      // 测试结束后由 closeServer 清理；这里保留引用
      (server as unknown as { __keep?: boolean }).__keep = true;
      mockServers.add(server);
    });
  });
}

const mockServers = new Set<http.Server>();
test.after(async () => {
  for (const s of mockServers) {
    await new Promise<void>((done) => s.close(() => done()));
  }
});

const db = openDatabase({ file: ':memory:' });
const d1 = createD1(db);

/** 造一个登录用户行（users 表由 db.ts 迁移建好） */
async function makeUser(id: string, role: 'user' | 'admin' = 'user') {
  await d1
    .prepare(
      `INSERT INTO users (id, username, password_hash, role, allow_server_key, banned, created_at, updated_at)
       VALUES (?,?,?,?,1,0,?,?) ON CONFLICT(id) DO NOTHING`,
    )
    .bind(id, `user-${id}`, 'x', role, Date.now(), Date.now())
    .run();
}

/** mock 的 Workers AI 绑定：始终返回固定文字（不触发即不调用） */
function makeAiBinding(calls: { n: number } = { n: 0 }) {
  return {
    calls,
    run: async (model: string, input: { audio: ArrayBuffer }) => {
      if (model !== '@cf/openai/whisper') throw new Error('unexpected model');
      if (input.audio.byteLength === 0) throw new Error('empty audio');
      calls.n += 1;
      return { text: ' Workers AI 识别结果 ' };
    },
  };
}

function makeEnv(patch: Record<string, string | undefined> = {}, ai?: ReturnType<typeof makeAiBinding>) {
  return {
    DB: d1,
    AI_BASE_URL: patch.AI_BASE_URL,
    AI_API_KEY: patch.AI_API_KEY ?? 'sk-asr-test',
    AI_MODEL: patch.AI_MODEL ?? 'mock-chat',
    AI_ASR_MODEL: patch.AI_ASR_MODEL,
    ...(ai ? { AI: ai } : {}),
  };
}

const audioFile = new File([new Uint8Array([1, 2, 3, 4])], 'speech.webm', { type: 'audio/webm' });

function makeRequest(env: { baseURL?: string }, audio: File | null): Request {
  const form = new FormData();
  if (audio) form.append('audio', audio, 'speech.webm');
  // 不手动设 content-type：boundary 由 fetch 运行时生成，写死会解析失败
  return new Request('https://hq.test/api/ai/transcribe', { method: 'POST', body: form });
}

const json = async (res: Response) => (await res.json()) as Record<string, unknown> & { text?: string };

test('asr：未配置模型 → 503 ASR_NOT_CONFIGURED，不消耗配额', async () => {
  await makeUser('u1');
  const res = await handleTranscribe(makeRequest({}, audioFile), makeEnv({ AI_ASR_MODEL: undefined }), {
    id: 'u1',
    username: 'a',
    role: 'user',
    allowServerKey: true,
  } as never);
  assert.equal(res.status, 503);
  const body = await json(res);
  assert.equal(body.error, 'ASR_NOT_CONFIGURED');
  const row = await d1.prepare('SELECT asks_today FROM users WHERE id = ?').bind('u1').first<{ asks_today: number }>();
  assert.equal(row!.asks_today, 0, '失败请求不扣配额');
});

test('asr：正常识别 → 透传模型名、返回去空格文字、扣 1 配额', async () => {
  await makeUser('u2');
  const upstream = await startMockAsr();
  const res = await handleTranscribe(
    makeRequest({ baseURL: upstream }, audioFile),
    makeEnv({ AI_BASE_URL: upstream, AI_ASR_MODEL: 'SenseVoiceSmall' }),
    { id: 'u2', username: 'b', role: 'user', allowServerKey: true } as never,
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.text, '他是唐朝人吗', '识别文字要去首尾空格');
  assert.equal(typeof body.ms, 'number');
  const row = await d1.prepare('SELECT asks_today FROM users WHERE id = ?').bind('u2').first<{ asks_today: number }>();
  assert.equal(row!.asks_today, 1, '一次识别扣一次配额');
});

test('asr：Workers AI 绑定优先于外部端点（免费档，零密钥）', async () => {
  await makeUser('u5');
  const calls = { n: 0 };
  // 外部上游不该被调用：故意给一个会 500 的地址，若走到了就会 502
  const upstream = await startMockAsr({ status: 500 });
  const res = await handleTranscribe(
    makeRequest({ baseURL: upstream }, audioFile),
    makeEnv({ AI_BASE_URL: upstream, AI_ASR_MODEL: 'm' }, makeAiBinding(calls)),
    { id: 'u5', username: 'f', role: 'user', allowServerKey: true } as never,
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.text, 'Workers AI 识别结果', '走 Workers AI 且文字去空格');
  assert.equal(calls.n, 1, 'AI.run 被调用一次');
});

test('asr：Workers AI 失败 → 回落外部端点', async () => {
  await makeUser('u6');
  const upstream = await startMockAsr();
  const brokenAi = {
    run: async () => {
      throw new Error('neurons exhausted');
    },
  };
  const res = await handleTranscribe(
    makeRequest({ baseURL: upstream }, audioFile),
    makeEnv({ AI_BASE_URL: upstream, AI_ASR_MODEL: 'm' }, brokenAi as never),
    { id: 'u6', username: 'g', role: 'user', allowServerKey: true } as never,
  );
  assert.equal(res.status, 200);
  const body = await json(res);
  assert.equal(body.text, '他是唐朝人吗', '回落到外部端点拿到识别文字');
});

test('asr：管理员不限配额', async () => {
  await makeUser('boss', 'admin');
  const upstream = await startMockAsr();
  const res = await handleTranscribe(
    makeRequest({ baseURL: upstream }, audioFile),
    makeEnv({ AI_BASE_URL: upstream, AI_ASR_MODEL: 'm' }),
    { id: 'boss', username: 'c', role: 'admin', allowServerKey: true } as never,
  );
  assert.equal(res.status, 200);
  const row = await d1.prepare('SELECT asks_today FROM users WHERE id = ?').bind('boss').first<{ asks_today: number }>();
  assert.equal(Number(row!.asks_today ?? 0), 0, '管理员不走配额扣减（无限）');
});

test('asr：上游故障 → 502，配额照扣（上游已收到请求）', async () => {
  await makeUser('u3');
  const upstream = await startMockAsr({ status: 500 });
  const res = await handleTranscribe(
    makeRequest({ baseURL: upstream }, audioFile),
    makeEnv({ AI_BASE_URL: upstream, AI_ASR_MODEL: 'm' }),
    { id: 'u3', username: 'd', role: 'user', allowServerKey: true } as never,
  );
  assert.equal(res.status, 502);
  const row = await d1.prepare('SELECT asks_today FROM users WHERE id = ?').bind('u3').first<{ asks_today: number }>();
  assert.equal(Number(row!.asks_today ?? 0), 1, '上游已收到请求，配额不退（与单人 ask 的 429 语义一致）');
});

test('asr：拒绝超大与非音频请求', async () => {
  await makeUser('u4');
  const upstream = await startMockAsr();
  const env = makeEnv({ AI_BASE_URL: upstream, AI_ASR_MODEL: 'm' });
  const user = { id: 'u4', username: 'e', role: 'user', allowServerKey: true } as never;

  const big = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'big.webm', { type: 'audio/webm' });
  const tooBig = await handleTranscribe(makeRequest({ baseURL: upstream }, big), env, user);
  assert.equal(tooBig.status, 413);

  const notAudio = new File([new Uint8Array([1])], 'x.txt', { type: 'text/plain' });
  const wrongType = await handleTranscribe(makeRequest({ baseURL: upstream }, notAudio), env, user);
  assert.equal(wrongType.status, 415);

  const noAudio = await handleTranscribe(makeRequest({ baseURL: upstream }, null), env, user);
  assert.equal(noAudio.status, 400);
});
