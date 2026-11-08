import { z } from 'zod';
import { HubConfigInfoSchema, MeResultSchema, PullResultSchema, PushResultSchema, type PushBody, type PushResult } from '../hub/wire.js';

// Hub-supplied text reaches the terminal (`memhive sync`) and the logs: no control characters (terminal escapes), bounded length.
export const safeHubText = (v: unknown): string => String(v).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 300);

export class HubError extends Error { constructor(message: string, public readonly status: number, public readonly code: string) { super(message); this.name = 'HubError'; } }

// Older hubs omit version, protocol and body_limit; the engine treats a missing protocol as "older hub", not as an error.
export const ClientHubConfigSchema = HubConfigInfoSchema.partial({ version: true, protocol: true, body_limit: true });
export type HubConfigInfo = z.infer<typeof ClientHubConfigSchema>;
// The envelope is checked here; rows are checked one by one in the engine, so one bad row cannot stall the cursor.
// max_seq and epoch are optional for older hubs.
const ClientPullSchema = PullResultSchema.extend({ sessions: z.array(z.unknown()), observations: z.array(z.unknown()), summaries: z.array(z.unknown()), max_seq: z.number().optional() });
export type ClientPullResult = z.infer<typeof ClientPullSchema>;

export class HubClient {
  private fetchImpl: typeof fetch;
  constructor(private hubUrl: string, private key: string, fetchImpl?: typeof fetch) { this.fetchImpl = fetchImpl ?? fetch; }
  private async req<T>(schema: z.ZodType<T>, method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10000): Promise<T> {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.fetchImpl(this.hubUrl + path, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${this.key}` }, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl.signal });
      const text = await res.text(); let json: any; let parsed = true;
      try { json = text ? JSON.parse(text) : {}; } catch { json = {}; parsed = false; }
      if (!res.ok) throw new HubError(json?.error?.message != null ? safeHubText(json.error.message) : `hub ${res.status}`, res.status, json?.error?.code != null ? safeHubText(json.error.code).slice(0, 64) : 'http_error');
      // A 2xx that is not the hub's JSON (captive portal, HTML error page, a proxy) must not be read as an empty page.
      const r = parsed ? schema.safeParse(json) : null;
      if (!r?.success) throw new HubError(`hub sent an unexpected response for ${path.split('?')[0]}`, res.status, 'bad_response');
      return r.data;
    } finally { clearTimeout(t); }
  }
  config() { return this.req(ClientHubConfigSchema, 'GET', '/v1/config'); }
  me() { return this.req(MeResultSchema, 'GET', '/v1/me'); }
  push(body: PushBody, timeoutMs = 15000): Promise<PushResult> { return this.req(PushResultSchema, 'POST', '/v1/sync/push', body, timeoutMs); }
  pull(projectKey: string, since: number, limit = 500, timeoutMs = 10000): Promise<ClientPullResult> { return this.req(ClientPullSchema, 'GET', `/v1/sync/pull?project_key=${encodeURIComponent(projectKey)}&since=${since}&limit=${limit}`, undefined, timeoutMs); }
}
