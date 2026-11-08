import { createHash, randomBytes } from 'node:crypto';
export function generateApiKey(): { raw: string; hash: string } {
  const raw = 'mh_' + randomBytes(32).toString('base64url');
  return { raw, hash: hashApiKey(raw) };
}
export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();
  constructor(
    private limit: number,
    private windowMs: number
  ) {}
  allow(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b || now - b.start >= this.windowMs) {
      this.buckets.set(key, { start: now, count: 1 });
      return true;
    }
    if (b.count >= this.limit) return false;
    b.count++;
    return true;
  }
}
/** Insertion-ordered map trimmed to max entries: the oldest go first. */
export const remember = <V>(m: Map<string, V>, k: string, v: V, max: number): void => {
  m.delete(k);
  m.set(k, v);
  if (m.size > max) m.delete(m.keys().next().value!);
};
/** Failed authentications per client in fixed windows; the client map is bounded so the limiter cannot be used to exhaust memory. */
export class AuthThrottle {
  private buckets = new Map<string, { start: number; count: number }>();
  constructor(
    private limit = 30,
    private windowMs = 60_000,
    private maxClients = 10_000
  ) {}
  failed(client: string, now = Date.now()): void {
    const b = this.buckets.get(client);
    remember(
      this.buckets,
      client,
      b && now - b.start < this.windowMs ? { start: b.start, count: b.count + 1 } : { start: now, count: 1 },
      this.maxClients
    );
  }
  /** Seconds until this client may try unknown keys again; 0 when not throttled. */
  wait(client: string, now = Date.now()): number {
    const b = this.buckets.get(client);
    if (!b || now - b.start >= this.windowMs || b.count < this.limit) return 0;
    return Math.max(1, Math.ceil((b.start + this.windowMs - now) / 1000));
  }
  get size(): number {
    return this.buckets.size;
  }
}
