import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DaemonInfo } from './info.js';
import { MAX_RESPONSE_BYTES, readBodyCapped } from '../shared/http.js';

/** HMAC over the nonce and the daemon pid: proves the listener knows the token and is the pid in daemon.json. */
export const healthProof = (token: string, nonce: string, pid: number): string => createHmac('sha256', token).update(`${nonce}:${pid}`).digest('hex');

export class DaemonError extends Error { constructor(message: string, public readonly status: number) { super(message); this.name = 'DaemonError'; } }

export class DaemonClient {
  private fetchImpl: typeof fetch;
  constructor(private info: DaemonInfo, fetchImpl?: typeof fetch) { this.fetchImpl = fetchImpl ?? fetch; }
  get baseUrl(): string { return `http://127.0.0.1:${this.info.port}`; }
  async request<T = unknown>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 5000): Promise<T> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.baseUrl + path, { method, headers: { 'content-type': 'application/json', 'x-memhive-daemon-token': this.info.token }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal, redirect: 'error' });
      const text = await readBodyCapped(res, MAX_RESPONSE_BYTES);
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
      const r = await this.fetchImpl(`${this.baseUrl}/healthz?nonce=${nonce}`, { signal: ctl.signal, redirect: 'error' });
      if (!r.ok) return false;
      const j = JSON.parse(await readBodyCapped(r, 64 * 1024)) as { ok?: boolean; proof?: string };
      if (j.ok !== true || typeof j.proof !== 'string') return false;
      const want = Buffer.from(healthProof(this.info.token, nonce, this.info.pid));
      const got = Buffer.from(j.proof);
      return got.length === want.length && timingSafeEqual(got, want);
    } catch { return false; } finally { clearTimeout(t); }
  }
}
