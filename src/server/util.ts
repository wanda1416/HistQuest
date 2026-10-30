import { scrubSecret } from '../ai/client.ts';

/** 所有服务端日志统一走这里：密钥一律抹掉，且不打印请求体 */
export function log(event: string, detail: Record<string, unknown> = {}): void {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(detail)) {
    if (/key|token|secret|authorization/i.test(k)) {
      safe[k] = '***';
      continue;
    }
    safe[k] = typeof v === 'string' ? scrubSecret(v) : v;
  }
  const line = Object.keys(safe).length ? `${event} ${JSON.stringify(safe)}` : event;
  console.log(`[${new Date().toISOString()}] ${line}`);
}

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();
  private readonly capacity: number;
  private readonly refillPerSecond: number;

  constructor(capacity = 20, refillPerSecond = 0.5) {
    this.capacity = capacity;
    this.refillPerSecond = refillPerSecond;
  }

  take(key: string): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.capacity, updated: now };
    const elapsed = (now - bucket.updated) / 1000;
    bucket.tokens = Math.min(this.capacity, bucket.tokens + elapsed * this.refillPerSecond);
    bucket.updated = now;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      return false;
    }
    bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    return true;
  }
}
