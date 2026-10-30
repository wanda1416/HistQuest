/**
 * 测试与联调用的 OpenAI 兼容假模型。
 * 只实现 /v1/chat/completions，行为由问句里的"标记词"驱动（坏JSON / 超时 / 终审失败）。
 * 注意：这是测试夹具，不是游戏的一种运行模式。
 */
import http from 'node:http';

const DYN_RE =
  /(春秋|战国|秦|西汉|东汉|三国|西晋|东晋|南北朝|隋|唐|北宋|南宋|宋|五代|元|明|清|近代|汉|晋)/;
const PLACE_RE =
  /(北京|上海|天津|重庆|四川|河南|山东|陕西|江苏|浙江|安徽|湖北|湖南|江西|福建|广东|河北|山西|云南|海南|蒙古|西域|甘肃|辽宁|广西|贵州)/;
const ROLE_RE = /(诗人|词人|画家|书法家|将军|皇帝|医学家|科学家|文学家|思想家|刺客|僧人|政治家|军事家)/;
const SUBJECTIVE_RE = /(伟大|厉害|了不起|优秀|聪明|有趣|好人|坏人)/;

function extractQuestion(text: string): string {
  const m = text.match(/<<<QUESTION>>>([\s\S]*?)<<<END>>>/);
  return (m?.[1] ?? text).trim();
}

export function fakeParse(question: string): Record<string, unknown> {
  const q = question.trim();
  if (SUBJECTIVE_RE.test(q)) return { attr: 'other', value: null, subjective: true };

  const len = q.match(/([两二三四五2-5])\s*个?字/);
  if (len && /名字|姓名/.test(q)) {
    const map: Record<string, number> = { 两: 2, 二: 2, 三: 3, 四: 4, 五: 5 };
    const n = map[len[1]!] ?? Number(len[1]);
    return { attr: 'nameLength', value: n };
  }

  const surname = q.match(/姓([\u4e00-\u9fa5])/);
  if (surname) return { attr: 'nameContains', value: surname[1] };

  const age = q.match(/(\d+)\s*岁/);
  if (age) return { attr: 'lifespan', value: Number(age[1]), op: /不到|以内/.test(q) ? 'lte' : 'gte' };

  if (/还活着|在世|活着吗/.test(q)) return { attr: 'alive', value: true };
  if (/中国人|中国籍/.test(q)) return { attr: 'nationality', value: true };
  if (/公元前/.test(q)) return { attr: 'birthEra', value: 'bc' };
  if (/皇帝|君主|登基|在位/.test(q)) return { attr: 'emperor', value: true };

  const relative = /(之前|以前|之前吗)/.test(q) ? 'eraBefore' : /(之后|以后)/.test(q) ? 'eraAfter' : null;
  if (relative) {
    const span = q.match(DYN_RE);
    if (span) return { attr: relative, value: span[1] };
  }

  const dyn = q.match(DYN_RE);
  if (dyn) return { attr: 'dynasty', value: dyn[1] };

  const role = q.match(ROLE_RE);
  if (role) return { attr: 'role', value: role[1] };

  const place = q.match(PLACE_RE);
  if (place) return { attr: 'birthplace', value: place[1] };

  if (/(性别|是男|是女|男性|女性|男的|女的)/.test(q)) {
    return { attr: 'gender', value: /女/.test(q) ? 'female' : 'male' };
  }

  const book = q.match(/《([^》]+)》/);
  if (book) return { attr: 'event', value: book[1] };
  const wrote = q.match(/写过(.{2,8}?)[吗呢]?$/);
  if (wrote) return { attr: 'event', value: wrote[1] };

  return { attr: 'other', value: null };
}

/**
 * 故障注入用的假模型：只用于确定性地复现"非法 JSON / 超时 / 终审不可用"这三条降级路径。
 * 正常链路一律用真模型测（见 test/live.test.ts）。
 */
function decide(messages: Array<{ role: string; content: string }>): { content: string; delayMs: number } {
  const allText = messages.map((m) => m.content).join('\n');
  const question = extractQuestion(allText);

  if (allText.includes('问句解析器')) {
    if (question.includes('坏JSON')) return { content: '这个我不好说', delayMs: 0 };
    if (question.includes('超时')) return { content: '', delayMs: 12000 };
    return { content: JSON.stringify(fakeParse(question)), delayMs: 0 };
  }

  if (allText.includes('判定器')) {
    // 用固定脚本模拟"模型作答"，便于断言引擎的覆盖逻辑
    if (question.includes('坏JSON')) return { content: '这个我不好说', delayMs: 0 };
    if (question.includes('超时')) return { content: '', delayMs: 12000 };
    if (question.includes('泄漏')) {
      return {
        content: JSON.stringify({ attr: 'other', value: null, verdict: 'yes', text: '是的，他就是李白。' }),
        delayMs: 0,
      };
    }
    if (question.includes('不知道')) {
      return {
        content: JSON.stringify({ attr: 'other', value: null, verdict: 'unknown', text: '' }),
        delayMs: 0,
      };
    }
    const bare = question.replace(/公元前|公元/g, '');
    const rel = /(之前|以前)/.test(bare) ? 'eraBefore' : /(之后|以后)/.test(bare) ? 'eraAfter' : null;
    if (rel) {
      const span = bare.match(DYN_RE);
      if (span) {
        return {
          content: JSON.stringify({ attr: rel, value: span[1], verdict: 'yes', text: '是，时间上确实如此。' }),
          delayMs: 0,
        };
      }
    }
    const dyn = bare.match(DYN_RE);
    if (dyn) {
      // 故意一律答 yes，用于验证朝代被索引改写的覆盖逻辑
      return {
        content: JSON.stringify({
          attr: 'dynasty',
          value: dyn[1],
          verdict: 'yes',
          text: '是，那个朝代的人。',
        }),
        delayMs: 0,
      };
    }
    if (/(活过|岁)/.test(question)) {
      return {
        content: JSON.stringify({ attr: 'lifespan', value: 60, verdict: 'yes', text: '是，他活过了。' }),
        delayMs: 0,
      };
    }
    return {
      content: JSON.stringify({ attr: 'other', value: null, verdict: 'yes', text: '是，确实如此。' }),
      delayMs: 0,
    };
  }

  return { content: '可用', delayMs: 0 };
}

export interface MockLlm {
  url: string;
  close: () => Promise<void>;
  callCount: () => number;
}

export function startMockLlm(port = 0): Promise<MockLlm> {
  let calls = 0;
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      calls += 1;
      let payload: { messages?: Array<{ role: string; content: string }> } = {};
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = {};
      }
      const messages = payload.messages ?? [];
      const { content, delayMs } = decide(messages);

      const send = () => {
        const body = JSON.stringify({
          id: 'mock',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(body);
      };

      if (delayMs > 0) setTimeout(send, delayMs);
      else send();
    });
  });

  return new Promise((resolve) => {
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      resolve({
        url: `http://127.0.0.1:${actualPort}/v1`,
        close: () =>
          new Promise<void>((done) => {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            server.close(() => done());
          }),
        callCount: () => calls,
      });
    });
  });
}

if (process.argv[1]?.endsWith('mock-llm.ts')) {
  const port = Number(process.argv[2] ?? 4000);
  startMockLlm(port).then((m) => {
    console.log(`mock llm listening: ${m.url}`);
  });
}
