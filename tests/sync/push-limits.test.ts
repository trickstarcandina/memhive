import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { startHub } from '../../src/hub/server.js';
import { generateApiKey } from '../../src/hub/auth.js';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { obs, sess } from '../store/store-contract.js';
import { newId } from '../../src/shared/ids.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const DEFAULT_LIMIT = 2 * 1024 * 1024;
const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const c of closers.splice(0)) await c(); });

async function setup(opts: { dims: number | null; bodyLimit?: number; fetchImpl?: (real: typeof fetch) => typeof fetch }) {
  const hs = new SqliteHubStore(':memory:', { dims: opts.dims }); await hs.migrate();
  const hub = await startHub(hs, { port: 0, embeddingModel: opts.dims ? 'm' : null, embeddingDims: opts.dims, bodyLimit: opts.bodyLimit ?? DEFAULT_LIMIT }, silent);
  closers.push(() => hub.close());
  await hs.createUser('alice'); const k = generateApiKey(); await hs.createApiKey('alice', 'l', k.hash);
  const hubUrl = `http://127.0.0.1:${hub.port}`;
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { [hubUrl]: { key: k.raw, user: 'alice' } } });
  const store = new SqliteStore(':memory:', { dims: opts.dims }); store.migrate();
  const p = store.getOrCreateProject('github.com/t/limits', 'limits'); store.setProjectHub(p.id, hubUrl);
  const bodies: number[] = []; let pushes = 0;
  const inner = opts.fetchImpl ? opts.fetchImpl(fetch) : fetch;
  const counting: typeof fetch = async (url, init) => {
    if (String(url).endsWith('/v1/sync/push')) { pushes++; bodies.push(Buffer.byteLength(String(init?.body ?? ''))); }
    return inner(url, init);
  };
  const engine = new SyncEngine({ store, home, logger: silent, embedDims: opts.dims, embedModel: 'm', fetchImpl: counting });
  closers.push(() => engine.close());
  const s = sess(p.id, { userId: 'alice' }); store.upsertSession(s);
  return { hs, store, project: store.getProject(p.id)!, engine, session: s, bodies, pushes: () => pushes };
}
const vec = (n: number) => Array.from({ length: n }, () => Math.random() - 0.5);
const addObs = (t: Awaited<ReturnType<typeof setup>>, n: number, dims: number | null, extra: Partial<Parameters<typeof obs>[0]> = {}) => {
  const rows = Array.from({ length: n }, (_, i) => obs({ projectId: t.project.id, sessionId: t.session.id, userId: 'alice', title: `row ${i}`, ...extra }));
  t.store.insertObservations(rows);
  if (dims) for (const o of rows) t.store.setObservationEmbedding(o.id, vec(dims), 'm');
  return rows;
};
// Hides body_limit from /v1/config, as an older hub would.
const hideBodyLimit = (inner: typeof fetch): typeof fetch => async (url, init) => {
  const res = await inner(url, init);
  if (!String(url).endsWith('/v1/config')) return res;
  const { body_limit: _b, ...rest } = await res.json() as Record<string, unknown>;
  return new Response(JSON.stringify(rest), { status: res.status, headers: { 'content-type': 'application/json' } });
};

describe('push batch sizing', () => {
  it('1024-d vectors: >100 rows go in bodies under the default 2 MB limit, all accepted with vectors', async () => {
    const t = await setup({ dims: 1024 });
    const rows = addObs(t, 150, 1024);
    const r = await t.engine.push(t.project);
    expect(r!.accepted.observations).toBe(150); expect(r!.rejected).toEqual([]);
    expect(t.store.listUnsynced('observations', t.project.id, 500)).toHaveLength(0);
    expect(t.pushes()).toBeGreaterThan(1);
    expect(Math.max(...t.bodies)).toBeLessThanOrEqual(DEFAULT_LIMIT * 0.75);
    expect((await t.hs.getObservations([rows[149].id]))[0].embedding).toHaveLength(1024);
  });
  it('413 halves the batch and retries (hub that does not report body_limit)', async () => {
    const t = await setup({ dims: 1024, bodyLimit: 200_000, fetchImpl: hideBodyLimit });
    addObs(t, 40, 1024);
    const r = await t.engine.push(t.project);
    expect(r!.accepted.observations).toBe(40); expect(r!.rejected).toEqual([]);
    expect(t.store.listUnsynced('observations', t.project.id, 500)).toHaveLength(0);
  });
  it('a single row over the limit goes without its vector; still too big, it is marked synced and reported', async () => {
    const t = await setup({ dims: 1024, bodyLimit: 15_000 });
    const [withVec] = addObs(t, 1, 1024);
    let r = await t.engine.push(t.project);
    expect(r!.accepted).toMatchObject({ sessions: 1, observations: 1 });
    expect((await t.hs.getObservations([withVec.id]))[0].embedding).toBeNull();
    const [huge] = addObs(t, 1, null, { narrative: 'x'.repeat(30_000) });
    r = await t.engine.push(t.project);
    expect(r!.rejected).toEqual([{ id: huge.id, reason: 'too_large' }]);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(0);
    expect(await t.hs.getObservations([huge.id])).toEqual([]);
  });
});

describe('hub config cache', () => {
  it('is refreshed after a while: a hub that gains an embedder gets vectors without a daemon restart', async () => {
    let hubHasEmbedder = false;
    const t = await setup({ dims: 2, fetchImpl: (inner) => async (url, init) => {
      if (!String(url).endsWith('/v1/config') || hubHasEmbedder) return inner(url, init);
      return new Response(JSON.stringify({ embedding_model: null, embedding_dims: null }), { status: 200 });
    } });
    const [first] = addObs(t, 1, 2);
    await t.engine.push(t.project);
    expect((await t.hs.getObservations([first.id]))[0].embedding).toBeNull();
    hubHasEmbedder = true;
    const later = Date.now() + 11 * 60_000; vi.spyOn(Date, 'now').mockReturnValue(later);
    const [second] = addObs(t, 1, 2);
    await t.engine.push(t.project);
    expect((await t.hs.getObservations([second.id]))[0].embedding).toHaveLength(2);
  });
});

describe('push concurrency', () => {
  it('a debounced push and a manual sync running together send the rows once', async () => {
    const t = await setup({ dims: null });
    addObs(t, 3, null);
    const [a, b] = await Promise.all([t.engine.push(t.project), t.engine.push(t.project, { force: true })]);
    expect(a!.accepted.observations + b!.accepted.observations).toBe(3);
    expect(t.pushes()).toBe(1);
  });
});

describe('push failure handling', () => {
  const failPush = (status: number) => (inner: typeof fetch): typeof fetch => async (url, init) =>
    String(url).endsWith('/v1/sync/push') ? new Response(JSON.stringify({ error: { code: 'x', message: 'x' } }), { status }) : inner(url, init);

  it('a 4xx other than 401/413 marks the batch synced instead of resending it forever', async () => {
    const t = await setup({ dims: null, fetchImpl: failPush(400) });
    addObs(t, 3, null);
    const r = await t.engine.push(t.project);
    expect(r!.accepted.observations).toBe(0); expect(r!.rejected).toHaveLength(4);   // session + 3 observations
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(0);
    expect(t.store.listUnsynced('sessions', t.project.id, 10)).toHaveLength(0);
  });
  it('a 404 (proxy, wrong path, old hub) keeps rows and backs off', async () => {
    const t = await setup({ dims: null, fetchImpl: failPush(404) });
    addObs(t, 2, null);
    expect(await t.engine.push(t.project)).toBeNull();
    expect(await t.engine.push(t.project)).toBeNull();
    expect(t.pushes()).toBe(1);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(2);
  });
  it('a bare proxy 400/403 without a hub error body keeps rows', async () => {
    for (const status of [400, 403]) {
      const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => String(url).endsWith('/v1/sync/push') ? new Response('<html>Forbidden</html>', { status }) : inner(url, init) });
      addObs(t, 1, null);
      expect(await t.engine.push(t.project)).toBeNull();
      expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(1);
    }
  });
  it('a bare 4xx that keeps refusing one row: after 5 tries the batch goes row by row and only that row is given up', async () => {
    const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) =>
      String(url).endsWith('/v1/sync/push') && String(init?.body).includes('POISON') ? new Response('<html>WAF</html>', { status: 403 }) : inner(url, init) });
    const [a] = addObs(t, 1, null); const [bad] = addObs(t, 1, null, { narrative: 'POISON <script>' }); const [c] = addObs(t, 1, null);
    for (let i = 0; i < 4; i++) expect(await t.engine.push(t.project, { force: true })).toBeNull();
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(3);
    const r = await t.engine.push(t.project, { force: true });
    expect(r!.rejected).toEqual([{ id: bad.id, reason: 'http_error' }]);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(0);
    expect((await t.hs.getObservations([a.id, c.id])).map((o) => o.id).sort()).toEqual([a.id, c.id].sort());
    expect(t.engine.blockedProjects()).toEqual([]);
  });
  it('a bare 4xx on every row gives up at most one row per 5 failed tries', async () => {
    const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => String(url).endsWith('/v1/sync/push') ? new Response('<html>Forbidden</html>', { status: 403 }) : inner(url, init) });
    addObs(t, 2, null);
    const push = async (n: number) => { for (let i = 0; i < n; i++) await t.engine.push(t.project, { force: true }); };
    await push(5);   // 5th failure: row by row, the session is given up, the next row fails (strike 1) and backs off
    expect(t.store.listUnsynced('sessions', t.project.id, 10)).toHaveLength(0);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(2);
    await push(3);   // strikes 2-4
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(2);
    await push(1);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(1);
  });
  it('a 404 that persists keeps every row queued and is reported as blocked', async () => {
    const t = await setup({ dims: null, fetchImpl: failPush(404) });
    addObs(t, 2, null);
    for (let i = 0; i < 8; i++) expect(await t.engine.push(t.project, { force: true })).toBeNull();
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(2);
    expect(t.store.listUnsynced('sessions', t.project.id, 10)).toHaveLength(1);
    expect(t.engine.blockedProjects()).toEqual([t.project.id]);
  });
  it('a 5xx keeps rows and backs off; a manual sync (force) still tries', async () => {
    const t = await setup({ dims: null, fetchImpl: failPush(500) });
    addObs(t, 2, null);
    expect(await t.engine.push(t.project)).toBeNull();
    expect(t.pushes()).toBe(1);
    expect(await t.engine.push(t.project)).toBeNull();
    expect(t.pushes()).toBe(1);   // backing off: no request
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(2);
    expect(await t.engine.push(t.project, { force: true })).toBeNull();
    expect(t.pushes()).toBe(2);
  });
});

describe('pull robustness', () => {
  it('a cursor past the hub max_seq (hub reset) restarts the pull and re-queues local rows for push', async () => {
    const t = await setup({ dims: null });
    addObs(t, 1, null);
    await t.engine.push(t.project);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(0);
    t.store.setPullCursor(t.project.id, 999);
    await t.engine.pull(t.project, 2000);
    expect(t.store.getPullCursor(t.project.id)).toBe(await t.hs.maxSeq((await t.hs.getProjectByKey(t.project.key))!.id));
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(1);
    expect(t.store.listUnsynced('sessions', t.project.id, 10)).toHaveLength(1);
  });
  it('two pulls started together from a cursor past max_seq reset the project once', async () => {
    const t = await setup({ dims: null });
    addObs(t, 1, null);
    await t.engine.push(t.project);
    t.store.setPullCursor(t.project.id, 999);
    const reset = vi.spyOn(t.store, 'resetProjectSync');
    await Promise.all([t.engine.pull(t.project, 2000), t.engine.pull(t.project, 2000)]);
    expect(reset).toHaveBeenCalledTimes(1);
  });
  it('a hub that always reports max_seq below the cursor triggers one reset, and pull() terminates', async () => {
    let pulls = 0;
    const page = (since: number) => ({ sessions: [], observations: [], summaries: [], next_seq: since + 1, has_more: true, max_seq: since - 1 });
    const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => {
      if (!String(url).includes('/v1/sync/pull')) return inner(url, init);
      pulls++; return new Response(JSON.stringify(page(Number(new URL(String(url)).searchParams.get('since')))), { status: 200 });
    } });
    const reset = vi.spyOn(t.store, 'resetProjectSync');
    t.store.setPullCursor(t.project.id, 50);
    await t.engine.pull(t.project, 300);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(pulls).toBeGreaterThan(1);
  });
  it('a new hub epoch (hub recreated and already past our cursor) restarts the pull once and re-queues local rows', async () => {
    let fake: unknown = null;
    const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => fake && String(url).includes('/v1/sync/pull') ? new Response(JSON.stringify(fake), { status: 200 }) : inner(url, init) });
    addObs(t, 1, null);
    await t.engine.push(t.project);
    await t.engine.pull(t.project, 2000);
    const hubId = (await t.hs.getProjectByKey(t.project.key))!.id;
    expect(t.store.getHubEpoch(t.project.id)).toBe(hubId);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(0);
    fake = { sessions: [], observations: [], summaries: [], next_seq: 5000, has_more: false, max_seq: 5000, epoch: 'new-hub' };
    const reset = vi.spyOn(t.store, 'resetProjectSync');
    await t.engine.pull(t.project, 2000);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(t.store.getHubEpoch(t.project.id)).toBe('new-hub');
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(1);
    await t.engine.pull(t.project, 2000);
    expect(reset).toHaveBeenCalledTimes(1);   // same epoch again: no second reset
  });
  it('the first epoch seen is stored without a reset, and a hub without epoch never resets on it', async () => {
    let page: Record<string, unknown> = { sessions: [], observations: [], summaries: [], next_seq: 50, has_more: false, max_seq: 50 };
    const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => String(url).includes('/v1/sync/pull') ? new Response(JSON.stringify(page), { status: 200 }) : inner(url, init) });
    const reset = vi.spyOn(t.store, 'resetProjectSync');
    t.store.setPullCursor(t.project.id, 50);
    await t.engine.pull(t.project, 1000);
    expect(t.store.getHubEpoch(t.project.id)).toBeNull();
    page = { ...page, epoch: 'e1' };
    await t.engine.pull(t.project, 1000);
    expect(t.store.getHubEpoch(t.project.id)).toBe('e1');
    expect(reset).not.toHaveBeenCalled();
  });
  it('a max_seq that is not a safe non-negative integer is ignored', async () => {
    for (const max_seq of [-1, 1.5, 'x', 1e300]) {
      const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => String(url).includes('/v1/sync/pull') ? new Response(JSON.stringify({ sessions: [], observations: [], summaries: [], next_seq: 50, has_more: false, max_seq }), { status: 200 }) : inner(url, init) });
      const reset = vi.spyOn(t.store, 'resetProjectSync');
      t.store.setPullCursor(t.project.id, 50);
      await t.engine.pull(t.project, 1000);
      expect(reset).not.toHaveBeenCalled();
    }
  });
  it('a pulled session never rewrites a local session of another project or user', async () => {
    let page: unknown = null;
    const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => String(url).includes('/v1/sync/pull') ? new Response(JSON.stringify(page), { status: 200 }) : inner(url, init) });
    const other = t.store.getOrCreateProject('github.com/t/other', 'other');
    const mine = sess(t.project.id, { userId: 'bob', origin: 'hub', cwd: '/b' });
    const foreign = sess(other.id, { userId: 'bob', origin: 'hub', cwd: '/o' });
    t.store.upsertSession(mine); t.store.upsertSession(foreign);
    page = { sessions: [{ ...foreign, projectId: 'x', cwd: '/evil', endedAt: '2030-01-01T00:00:00.000Z' }, { ...mine, userId: 'mallory', cwd: '/evil', endedAt: '2030-01-01T00:00:00.000Z' }], observations: [], summaries: [], next_seq: 3, has_more: false };
    await t.engine.pull(t.project, 2000);
    expect(t.store.getSession(foreign.id)).toMatchObject({ projectId: other.id, cwd: '/o', endedAt: null });
    expect(t.store.getSession(mine.id)).toMatchObject({ userId: 'bob', cwd: '/b', endedAt: null });
  });
  it('a pulled row that cannot be stored is skipped; the rest apply and the cursor advances', async () => {
    const good = { id: newId(), projectId: 'x', userId: 'bob', host: 'codex', hostSessionId: 'h', cwd: '/b', startedAt: new Date().toISOString(), endedAt: null, syncedAt: null };
    const bad = { ...good, id: newId(), hostSessionId: 'h2', host: null };   // NOT NULL violation locally
    const o = obs({ projectId: 'x', sessionId: good.id, userId: 'bob', title: 'pulled ok' });
    const page = { sessions: [bad, good], observations: [{ ...o, embedding: null }], summaries: [], next_seq: 7, has_more: false };
    const t = await setup({ dims: null, fetchImpl: (inner) => async (url, init) => String(url).includes('/v1/sync/pull') ? new Response(JSON.stringify(page), { status: 200 }) : inner(url, init) });
    expect(await t.engine.pull(t.project, 2000)).toBe(2);
    expect(t.store.getSession(bad.id)).toBeNull();
    expect(t.store.getSession(good.id)).toMatchObject({ origin: 'hub' });
    expect(t.store.getObservations([o.id])[0]).toMatchObject({ title: 'pulled ok', origin: 'hub' });
    expect(t.store.getPullCursor(t.project.id)).toBe(7);
  });
});
