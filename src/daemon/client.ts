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
  async health(timeoutMs = 200): Promise<boolean> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try { const r = await this.fetchImpl(this.baseUrl + '/healthz', { signal: ctl.signal }); return r.ok; } catch { return false; } finally { clearTimeout(t); }
  }
}
