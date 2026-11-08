import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { HubClient, HubError } from '../../src/sync/client.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { handleRoute } from '../../src/daemon/routes.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import type { DaemonContext } from '../../src/daemon/context.js';
import { obs, sess } from '../store/store-contract.js';

const hubUrl = 'http://127.0.0.1:9';
const engines: SyncEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) void e.close();
});

// A hub stub: every endpoint answers 200 with the given body (or a real-looking config).
function setup(reply: { pull?: string; push?: string; pullStatus?: number }) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { [hubUrl]: { key: 'mh_' + 'A'.repeat(43), user: 'alice' } } });
  const store = new SqliteStore(':memory:', { dims: null });
  store.migrate();
  const { key, name } = projectKeyFor(home);
  const p = store.getOrCreateProject(key, name);
  store.setProjectHub(p.id, hubUrl);
  const s = sess(p.id, { userId: 'alice' });
  store.upsertSession(s);
  store.insertObservations([obs({ projectId: p.id, sessionId: s.id, userId: 'alice' })]);
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/v1/config'))
      return new Response(
        JSON.stringify({
          version: 'x',
          protocol: 1,
          embedding_model: null,
          embedding_dims: null,
          body_limit: 2_000_000,
        }),
        { status: 200 }
      );
    if (u.includes('/v1/sync/pull')) return new Response(reply.pull ?? '{}', { status: reply.pullStatus ?? 200 });
    return new Response(reply.push ?? '{}', { status: 200 });
  }) as unknown as typeof fetch;
  const warns: string[] = [];
  const logger = {
    info() {},
    debug() {},
    error() {},
    warn(m: string) {
      warns.push(m);
    },
  };
  const engine = new SyncEngine({ store, home, logger, embedDims: null, fetchImpl });
  engines.push(engine);
  return { home, store, project: store.getProject(p.id)!, engine, calls, warns };
}
const pushCalls = (c: string[]) => c.filter((u) => u.endsWith('/v1/sync/push')).length;

describe('malformed hub responses', () => {
  it.each([
    ['html', '<html>portal</html>'],
    ['empty object', '{}'],
    [
      'sessions is a string',
      JSON.stringify({ sessions: 'x', observations: [], summaries: [], next_seq: 1, has_more: false, max_seq: 1 }),
    ],
  ])('200 with %s on pull: no throw, cursor kept, backoff set', async (_n, body) => {
    const t = setup({ pull: body });
    expect(await t.engine.pull(t.project, 1000)).toBe(0);
    expect(t.store.getPullCursor(t.project.id)).toBe(0);
    expect(t.warns.some((w) => w.includes('pull failed'))).toBe(true);
    // backoff applies to the project: a non-forced push makes no request
    expect(await t.engine.push(t.project)).toBeNull();
    expect(pushCalls(t.calls)).toBe(0);
  });
  it.each([
    ['html', '<html>portal</html>'],
    ['empty object', '{}'],
    [
      'rejected is a string',
      JSON.stringify({ accepted: { sessions: 1, observations: 1, summaries: 0 }, rejected: 'x' }),
    ],
  ])('200 with %s on push: no throw, rows stay unsynced, backoff set', async (_n, body) => {
    const t = setup({ push: body });
    expect(await t.engine.push(t.project)).toBeNull();
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(1);
    expect(t.store.listUnsynced('sessions', t.project.id, 10)).toHaveLength(1);
    expect(await t.engine.push(t.project)).toBeNull();
    expect(pushCalls(t.calls)).toBe(1); // backing off
  });
  it('HubClient throws bad_response for a 2xx that is not the expected shape', async () => {
    const c = new HubClient(
      hubUrl,
      'k',
      (async () => new Response('<html>', { status: 200 })) as unknown as typeof fetch
    );
    await expect(c.me()).rejects.toMatchObject({ name: 'HubError', code: 'bad_response', status: 200 });
    const c2 = new HubClient(
      hubUrl,
      'k',
      (async () => new Response('<html>', { status: 502 })) as unknown as typeof fetch
    );
    await expect(c2.me()).rejects.toEqual(new HubError('hub 502', 502, 'http_error'));
  });
  it('hub error text loses terminal escapes and is capped before it is shown or stored', async () => {
    const c = new HubClient(
      hubUrl,
      'k',
      (async () =>
        new Response(JSON.stringify({ error: { code: 'x\u001b', message: '\u001b[31mX\u009b' + 'y'.repeat(1000) } }), {
          status: 400,
        })) as unknown as typeof fetch
    );
    const e = await c.me().then(
      () => {
        throw new Error('resolved');
      },
      (x: HubError) => x
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    expect(e.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(e.message.startsWith('?[31mX?')).toBe(true);
    expect(e.message.length).toBeLessThanOrEqual(300);
    expect(e.code).toBe('x?');
    const t = setup({
      pullStatus: 503,
      pull: JSON.stringify({ error: { code: 'bad', message: '\u001b]0;pwned\u0007' } }),
    });
    const r = await t.engine.syncNow(t.project);
    expect(r.error).toContain('?]0;pwned?');
    expect(r.error).not.toContain('\u001b');
  });
  it('hub client refuses redirects and caps the response at 4x body_limit', async () => {
    let redirected = false;
    const red = new HubClient(hubUrl, 'k', (async (_u: string, init?: RequestInit) => {
      redirected = init?.redirect === 'error';
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch);
    await expect(red.me()).rejects.toThrow('fetch failed');
    expect(redirected).toBe(true);
    const big = JSON.stringify({
      sessions: [],
      observations: [],
      summaries: [],
      next_seq: 1,
      has_more: false,
      max_seq: 1,
      pad: 'x'.repeat(5000),
    });
    const t = setup({ pull: big });
    (t.engine as any).hubCfg.set(hubUrl, {
      cfg: { embedding_model: null, embedding_dims: null, body_limit: 1000 },
      at: Date.now(),
    });
    expect(await t.engine.pull(t.project, 1000)).toBe(0);
    expect(t.warns.some((w) => w.includes('pull failed'))).toBe(true);
    expect(t.store.getSyncState(t.project.id).lastError).toContain('over 4000 bytes');
    expect(t.store.getSyncState(t.project.id).backoffUntil).not.toBeNull();
  });
  it('/v1/sync returns a structured result with the error, not a 500', async () => {
    const t = setup({ pull: '<html>', push: '<html>' });
    const ctx = {
      store: t.store,
      sync: t.engine,
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      excludedCwd: () => false,
    } as unknown as DaemonContext;
    const r = await handleRoute(ctx, 'POST', new URL('http://x/v1/sync'), { cwd: t.home });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ pushed: null, pulled: 0, error: expect.stringContaining('unexpected response') });
  });
});
