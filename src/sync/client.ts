import type { PushBody, PushResult, PullResult } from '../hub/routes.js';

export class HubError extends Error { constructor(message: string, public readonly status: number, public readonly code: string) { super(message); this.name = 'HubError'; } }

export class HubClient {
  private fetchImpl: typeof fetch;
  constructor(private hubUrl: string, private key: string, fetchImpl?: typeof fetch) { this.fetchImpl = fetchImpl ?? fetch; }
  private async req<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10000): Promise<T> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.hubUrl + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      const text = await res.text(); let json: any = {}; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
      if (!res.ok) throw new HubError(json?.error?.message ?? `hub ${res.status}`, res.status, json?.error?.code ?? 'http_error');
      return json as T;
    } finally { clearTimeout(t); }
  }
  config() { return this.req<{ version: string; embedding_model: string | null; embedding_dims: number | null }>('GET', '/v1/config'); }
  me() { return this.req<{ user: string }>('GET', '/v1/me'); }
  push(body: PushBody, timeoutMs = 15000) { return this.req<PushResult>('POST', '/v1/sync/push', body, timeoutMs); }
  pull(projectKey: string, since: number, limit = 500, timeoutMs = 10000) { return this.req<PullResult>('GET', `/v1/sync/pull?project_key=${encodeURIComponent(projectKey)}&since=${since}&limit=${limit}`, undefined, timeoutMs); }
}
