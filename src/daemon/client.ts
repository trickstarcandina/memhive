import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DaemonInfo } from './info.js';

export class DaemonError extends Error { constructor(message: string, public readonly status: number) { super(message); this.name = 'DaemonError'; } }

export class DaemonClient {
  private fetchImpl: typeof fetch;
  constructor(private info: DaemonInfo, fetchImpl?: typeof fetch) { this.fetchImpl = fetchImpl ?? fetch; }
  get baseUrl(): string { return `http://127.0.0.1:${this.info.port}`; }
  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl + path, { method, headers: { 'content-type': 'application/json', 'x-memhub-daemon-token': this.info.token }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) throw new DaemonError(json?.error?.message ?? `daemon ${res.status}`, res.status);
      return json as T;
    } finally { clearTimeout(t); }
  }
  // Proves the listener knows the token (HMAC over a fresh nonce) so a squatter on the port is treated as dead.
  async health(timeoutMs = 200): Promise<boolean> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const nonce = randomBytes(16).toString('hex');
      const r = await this.fetchImpl(`${this.baseUrl}/healthz?nonce=${nonce}`, { signal: ctl.signal });
      if (!r.ok) return false;
      const j = (await r.json()) as { ok?: boolean; pid?: number; proof?: string };
      if (j.ok !== true || j.pid !== this.info.pid || typeof j.proof !== 'string') return false;
      const want = Buffer.from(createHmac('sha256', this.info.token).update(nonce).digest('hex'));
      const got = Buffer.from(j.proof);
      return got.length === want.length && timingSafeEqual(got, want);
    } catch { return false; } finally { clearTimeout(t); }
  }
}
