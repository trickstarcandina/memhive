import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { OpenAICompatProvider } from '../../src/providers/openai-compat.js';
import { OpenAICompatEmbedder } from '../../src/providers/embedder.js';
import { ProviderError } from '../../src/providers/types.js';

const KEY = 'sk-SECRET-key-1234567890';
const req = { system: 'S', user: 'U', maxTokens: 5 };
const json = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

let server: http.Server | undefined;
afterEach(async () => {
  if (server) { server.closeAllConnections(); const s = server; server = undefined; await new Promise((r) => s.close(r)); }
});
const listen = async (h: http.RequestListener): Promise<string> => {
  server = http.createServer(h);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
};
const caught = async (p: Promise<unknown>): Promise<ProviderError> => { try { await p; } catch (e) { return e as ProviderError; } throw new Error('did not reject'); };

describe('provider failure kinds', () => {
  it('anthropic: timeout against a hanging local server is transport and hides the key', async () => {
    const base = await listen(() => { /* never respond */ });
    const e = await caught(new AnthropicProvider({ apiKey: KEY, model: 'm', baseUrl: base, timeoutMs: 80 }).complete(req));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.kind).toBe('transport');
    expect(e.message).not.toContain(KEY);
  });
  it('openai-compat: timeout is transport and hides the key', async () => {
    const base = await listen(() => { /* hang */ });
    const e = await caught(new OpenAICompatProvider({ baseUrl: base, apiKey: KEY, model: 'm', timeoutMs: 80 }).complete(req));
    expect(e.kind).toBe('transport');
    expect(e.message).not.toContain(KEY);
  });
  it('embedder: timeout is transport and hides the key', async () => {
    const base = await listen(() => { /* hang */ });
    const e = await caught(new OpenAICompatEmbedder({ baseUrl: base, apiKey: KEY, model: 'm', dims: 2, timeoutMs: 80 }).embed(['a']));
    expect(e.kind).toBe('transport');
    expect(e.message).not.toContain(KEY);
  });
  it('fetch rejection (connection refused / dns) is transport for all three', async () => {
    const boom = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    for (const p of [
      new AnthropicProvider({ apiKey: KEY, model: 'm', fetch: boom }).complete(req),
      new OpenAICompatProvider({ baseUrl: 'http://x', apiKey: KEY, model: 'm', fetch: boom }).complete(req),
      new OpenAICompatEmbedder({ baseUrl: 'http://x', apiKey: KEY, model: 'm', dims: 2, fetch: boom }).embed(['a']),
    ]) {
      const e = await caught(p);
      expect(e.kind).toBe('transport');
      expect(e.message).not.toContain(KEY);
    }
  });
  it('real connection refused is transport', async () => {
    const base = await listen(() => {});
    const s = server!; server = undefined;
    await new Promise((r) => s.close(r));
    const e = await caught(new OpenAICompatProvider({ baseUrl: base, apiKey: KEY, model: 'm', timeoutMs: 1000 }).complete(req));
    expect(e.kind).toBe('transport');
    expect(e.message).not.toContain(KEY);
  });
  it('5xx is transport, 402 quota, 403 auth, 404 other', async () => {
    const kinds: Array<[number, string]> = [[500, 'transport'], [503, 'transport'], [402, 'quota'], [403, 'auth'], [404, 'other']];
    for (const [status, kind] of kinds) {
      const e = await caught(new AnthropicProvider({ apiKey: KEY, model: 'm', fetch: json(status, { error: 'x' }) }).complete(req));
      expect(e).toMatchObject({ kind, status });
      expect(e.message).not.toContain(KEY);
    }
  });
  it('anthropic: 200 without text is bad_response', async () => {
    for (const body of [{}, { content: [] }, { content: [{ type: 'tool_use' }] }]) {
      const e = await caught(new AnthropicProvider({ apiKey: KEY, model: 'm', fetch: json(200, body) }).complete(req));
      expect(e).toMatchObject({ kind: 'bad_response', status: 200 });
    }
  });
  it('openai-compat: 200 with missing/empty/non-string content is bad_response', async () => {
    for (const body of [{}, { choices: [] }, { choices: [{ message: { content: '' } }] }, { choices: [{ message: { content: 5 } }] }]) {
      const e = await caught(new OpenAICompatProvider({ baseUrl: 'http://x', apiKey: KEY, model: 'm', fetch: json(200, body) }).complete(req));
      expect(e.kind).toBe('bad_response');
    }
  });
  it('non-JSON 200 body is bad_response', async () => {
    const f = (async () => new Response('<html>nope</html>', { status: 200 })) as unknown as typeof fetch;
    expect((await caught(new OpenAICompatProvider({ baseUrl: 'http://x', model: 'm', fetch: f }).complete(req))).kind).toBe('bad_response');
    expect((await caught(new AnthropicProvider({ apiKey: KEY, model: 'm', fetch: f }).complete(req))).kind).toBe('bad_response');
  });
  it('embedder: wrong count, wrong dims, non-array data and http errors are classified', async () => {
    const mk = (f: typeof fetch) => new OpenAICompatEmbedder({ baseUrl: 'http://x', apiKey: KEY, model: 'm', dims: 2, fetch: f });
    expect((await caught(mk(json(200, { data: [] })).embed(['a']))).kind).toBe('bad_response');
    expect((await caught(mk(json(200, { data: 'x' })).embed(['a']))).kind).toBe('bad_response');
    expect((await caught(mk(json(200, { data: [{ index: 0, embedding: [1] }] })).embed(['a']))).kind).toBe('bad_response');
    expect((await caught(mk(json(401, {})).embed(['a']))).kind).toBe('auth');
    expect((await caught(mk(json(429, {})).embed(['a']))).kind).toBe('quota');
    expect(await mk(json(200, {})).embed([])).toEqual([]);
  });
  it('embedder sorts results by index', async () => {
    const e = new OpenAICompatEmbedder({ baseUrl: 'http://x', model: 'm', dims: 1, fetch: json(200, { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }) });
    expect(await e.embed(['a', 'b'])).toEqual([[1], [2]]);
  });
  it('sends the key only in the auth header, never in url or body', async () => {
    const seen: Array<{ url: string; headers: any; body: string }> = [];
    const f = (async (url: any, init: any) => { seen.push({ url: String(url), headers: init.headers, body: String(init.body) }); return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }); }) as unknown as typeof fetch;
    await new OpenAICompatProvider({ baseUrl: 'http://x/v1', apiKey: KEY, model: 'm', fetch: f }).complete(req);
    expect(seen[0].headers.authorization).toBe(`Bearer ${KEY}`);
    expect(seen[0].url).not.toContain(KEY);
    expect(seen[0].body).not.toContain(KEY);
  });

  // BUG: http error bodies are interpolated into the message (anthropic.ts:17, openai-compat.ts:19), so a server/proxy that echoes the credential leaks it into errors/logs.
  it.fails('error message does not leak a key echoed by the server error body', async () => {
    const echo = json(401, { error: { message: `invalid api key ${KEY}` } });
    const e1 = await caught(new AnthropicProvider({ apiKey: KEY, model: 'm', fetch: echo }).complete(req));
    expect(e1.message).not.toContain(KEY);
    const e2 = await caught(new OpenAICompatProvider({ baseUrl: 'http://x', apiKey: KEY, model: 'm', fetch: echo }).complete(req));
    expect(e2.message).not.toContain(KEY);
  });
});
