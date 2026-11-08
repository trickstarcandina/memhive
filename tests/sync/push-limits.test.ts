import { describe, it, expect, afterEach } from 'vitest';
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
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

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
