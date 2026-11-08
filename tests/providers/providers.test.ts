import { describe, it, expect } from 'vitest';
import { AnthropicProvider } from '../../src/providers/anthropic.js';
import { OpenAICompatProvider } from '../../src/providers/openai-compat.js';
import { OpenAICompatEmbedder } from '../../src/providers/embedder.js';
import { ProviderError } from '../../src/providers/types.js';
import { createProvider, createEmbedder } from '../../src/providers/factory.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';

const fakeFetch = (handler: (url: string, init: RequestInit) => { status: number; body: unknown }) =>
  (async (url: any, init: any) => {
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

describe('AnthropicProvider', () => {
  it('posts messages and returns text', async () => {
    let seen: any;
    const p = new AnthropicProvider({
      apiKey: 'k',
      model: 'claude-haiku-5-5',
      fetch: fakeFetch((url, init) => {
        seen = { url, init };
        return { status: 200, body: { content: [{ type: 'text', text: '{"ok":1}' }] } };
      }),
    });
    expect(await p.complete({ system: 'S', user: 'U', maxTokens: 10 })).toBe('{"ok":1}');
    expect(seen.url).toBe('https://api.anthropic.com/v1/messages');
    expect(seen.init.headers['x-api-key']).toBe('k');
    expect(JSON.parse(seen.init.body)).toMatchObject({
      model: 'claude-haiku-5-5',
      system: 'S',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'U' }],
    });
  });
  it('maps 401 to auth and 429 to quota', async () => {
    const p = new AnthropicProvider({ apiKey: 'k', model: 'm', fetch: fakeFetch(() => ({ status: 401, body: {} })) });
    await expect(p.complete({ system: '', user: '', maxTokens: 1 })).rejects.toMatchObject({
      kind: 'auth',
      status: 401,
    });
    const q = new AnthropicProvider({ apiKey: 'k', model: 'm', fetch: fakeFetch(() => ({ status: 429, body: {} })) });
    await expect(q.complete({ system: '', user: '', maxTokens: 1 })).rejects.toMatchObject({ kind: 'quota' });
  });
});

describe('OpenAICompatProvider', () => {
  it('retries once without response_format on 400', async () => {
    const calls: any[] = [];
    const p = new OpenAICompatProvider({
      baseUrl: 'http://llm/v1/',
      model: 'm',
      fetch: fakeFetch((url, init) => {
        const b = JSON.parse(String(init.body));
        calls.push(b);
        return b.response_format
          ? { status: 400, body: { error: 'response_format unsupported' } }
          : { status: 200, body: { choices: [{ message: { content: 'hi' } }] } };
      }),
    });
    expect(await p.complete({ system: 'S', user: 'U', maxTokens: 5 })).toBe('hi');
    expect(calls).toHaveLength(2);
    expect(calls[1].response_format).toBeUndefined();
  });
  it('builds url without double slash', async () => {
    let seen = '';
    const p = new OpenAICompatProvider({
      baseUrl: 'http://llm/v1/',
      model: 'm',
      fetch: fakeFetch((url) => {
        seen = url;
        return { status: 200, body: { choices: [{ message: { content: 'x' } }] } };
      }),
    });
    await p.complete({ system: '', user: '', maxTokens: 1 });
    expect(seen).toBe('http://llm/v1/chat/completions');
  });
});

describe('OpenAICompatEmbedder', () => {
  it('returns vectors and validates dims', async () => {
    const e = new OpenAICompatEmbedder({
      baseUrl: 'http://e/v1',
      model: 'bge',
      dims: 2,
      fetch: fakeFetch(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1, 2] }] } })),
    });
    expect(await e.embed(['a'])).toEqual([[1, 2]]);
    const bad = new OpenAICompatEmbedder({
      baseUrl: 'http://e/v1',
      model: 'bge',
      dims: 3,
      fetch: fakeFetch(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1, 2] }] } })),
    });
    await expect(bad.embed(['a'])).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('factory', () => {
  it('builds from settings', () => {
    expect(
      createProvider({ ...DEFAULT_SETTINGS, llm: { provider: 'anthropic', model: 'm', apiKey: 'k' } })
    ).toBeInstanceOf(AnthropicProvider);
    expect(
      createProvider({ ...DEFAULT_SETTINGS, llm: { provider: 'openai-compat', model: 'm', baseUrl: 'http://x' } })
    ).toBeInstanceOf(OpenAICompatProvider);
    expect(createEmbedder(DEFAULT_SETTINGS)).toBeNull();
    expect(createEmbedder({ ...DEFAULT_SETTINGS, embed: { baseUrl: 'http://e', model: 'b', dims: 4 } })!.dims).toBe(4);
  });
  it('throws a ProviderError(auth) when anthropic key missing', () => {
    expect(() => createProvider({ ...DEFAULT_SETTINGS, llm: { provider: 'anthropic', model: 'm' } })).toThrow(
      ProviderError
    );
  });
});
