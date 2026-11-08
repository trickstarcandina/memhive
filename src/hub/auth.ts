import { createHash, randomBytes } from 'node:crypto';
export function generateApiKey(): { raw: string; hash: string } { const raw = 'mh_' + randomBytes(32).toString('base64url'); return { raw, hash: hashApiKey(raw) }; }
export function hashApiKey(raw: string): string { return createHash('sha256').update(raw).digest('hex'); }
export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();
  constructor(private limit: number, private windowMs: number) {}
  allow(key: string, now = Date.now()): boolean {
    const b = this.buckets.get(key);
    if (!b || now - b.start >= this.windowMs) { this.buckets.set(key, { start: now, count: 1 }); return true; }
    if (b.count >= this.limit) return false;
    b.count++; return true;
  }
}
