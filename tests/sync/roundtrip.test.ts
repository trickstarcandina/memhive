import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { startHub } from '../../src/hub/server.js';
import { generateApiKey } from '../../src/hub/auth.js';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { loadCredentials, saveCredentials } from '../../src/sync/credentials.js';
import { obs, sess } from '../store/store-contract.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
let hub: Awaited<ReturnType<typeof startHub>>; let hubUrl: string;
const keys: Record<string, string> = {};
const client = (user: string, key: string, dims: number | null) => {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { [hubUrl]: { key, user } } });
  const store = new SqliteStore(':memory:', { dims }); store.migrate();
  const project = store.getOrCreateProject('github.com/t/r', 'r'); store.setProjectHub(project.id, hubUrl);
  const engine = new SyncEngine({ store, home, logger: silent, embedDims: dims, embedModel: 'm' }, { debounceMs: 10 });
  return { home, store, project: store.getProject(project.id)!, engine, user };
};

beforeAll(async () => {
  const hs = new SqliteHubStore(':memory:', { dims: 2 }); await hs.migrate();
  hub = await startHub(hs, { port: 0, embeddingModel: 'm', embeddingDims: 2, bodyLimit: 2_000_000 }, silent);
  hubUrl = `http://127.0.0.1:${hub.port}`;
  for (const u of ['alice', 'bob']) { await hs.createUser(u); const k = generateApiKey(); await hs.createApiKey(u, 'l', k.hash); keys[u] = k.raw; }
});
afterAll(async () => { await hub.close(); });

describe('sync round trip', () => {
  it('A pushes, B pulls, origin=hub, vectors carried, idempotent, cursor advances', async () => {
    const a = client('alice', keys.alice, 2); const b = client('bob', keys.bob, 2);
    const s = sess(a.project.id, { userId: 'alice' }); a.store.upsertSession(s);
    const o = obs({ projectId: a.project.id, sessionId: s.id, userId: 'alice', title: 'Shared decision', type: 'decision' });
    a.store.insertObservations([o]); a.store.setObservationEmbedding(o.id, [0.5, 0.5], 'm');
    a.store.insertSummaries([{ id: o.id.replace(/.$/, '0'), projectId: a.project.id, sessionId: s.id, userId: 'alice', request: 'r', learned: '', completed: '', nextSteps: '', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null }]);
    const pushed = await a.engine.push(a.project);
    expect(pushed!.accepted).toEqual({ sessions: 1, observations: 1, summaries: 1 });
    expect(a.store.listUnsynced('observations', a.project.id, 10)).toHaveLength(0);
    expect((await a.engine.push(a.project))!.accepted.observations).toBe(0);

    expect(await b.engine.pull(b.project, 3000)).toBe(3);
    const got = b.store.getObservations([o.id])[0];
    expect(got).toMatchObject({ title: 'Shared decision', origin: 'hub', userId: 'alice' });
    expect(got.syncedAt).not.toBeNull(); expect(got.embeddingModel).toBe('m');
    expect(b.store.searchObservationsVector([0.5, 0.5], { projectId: b.project.id, limit: 1 })[0].id).toBe(o.id);
    expect(b.store.listRecentSummaries(b.project.id, 1)[0].request).toBe('r');
    expect(b.store.getPullCursor(b.project.id)).toBeGreaterThan(0);
    expect(await b.engine.pull(b.project, 3000)).toBe(0);
    expect(b.store.listUnsynced('observations', b.project.id, 10)).toHaveLength(0);   // pulled rows are never pushed back
    expect(b.store.listUnsynced('sessions', b.project.id, 10)).toHaveLength(0);
    a.engine.close(); b.engine.close();
  });
  it('a pulled session that ends on the hub is updated locally; its cwd is never relayed', async () => {
    const a = client('alice', keys.alice, 2); const b = client('bob', keys.bob, 2);
    const s = sess(a.project.id, { userId: 'alice', cwd: '/a' }); a.store.upsertSession(s);
    await a.engine.push(a.project); await b.engine.pull(b.project, 3000);
    expect(b.store.getSession(s.id)).toMatchObject({ endedAt: null, cwd: '' });
    a.store.upsertSession({ ...s, cwd: '/a2', endedAt: '2026-02-02T00:00:00.000Z' });
    await a.engine.push(a.project); await b.engine.pull(b.project, 3000);
    expect(b.store.getSession(s.id)).toMatchObject({ endedAt: '2026-02-02T00:00:00.000Z', cwd: '', origin: 'hub' });
    expect(b.store.getSession(s.id)!.syncedAt).not.toBeNull();
    a.engine.close(); b.engine.close();
  });
  it('getObservationEmbeddings returns only ids with a vector', () => {
    const a = client('alice', keys.alice, 2);
    const s = sess(a.project.id); a.store.upsertSession(s);
    const o1 = obs({ projectId: a.project.id, sessionId: s.id }); const o2 = obs({ projectId: a.project.id, sessionId: s.id });
    a.store.insertObservations([o1, o2]); a.store.setObservationEmbedding(o1.id, [0.25, 0.75], 'm');
    const m = a.store.getObservationEmbeddings([o1.id, o2.id]);
    expect([...m.keys()]).toEqual([o1.id]); expect(m.get(o1.id)).toEqual([0.25, 0.75]);
    a.engine.close();
  });
  it('pulled vector with other dims is stored without a vector', async () => {
    const c = client('bob', keys.bob, 3);
    expect(await c.engine.pull(c.project, 3000)).toBeGreaterThan(0);
    expect(c.store.listMissingEmbedding(10).length).toBeGreaterThan(0);
    expect(c.store.getObservations(c.store.listMissingEmbedding(10).map((o) => o.id)).every((o) => o.embeddingModel === null)).toBe(true);
    c.engine.close();
  });
  it('schedulePush debounces and pushes', async () => {
    const a = client('alice', keys.alice, 2);
    const s = sess(a.project.id); a.store.upsertSession(s);
    a.store.insertObservations([obs({ projectId: a.project.id, sessionId: s.id, title: 'debounced' })]);
    a.engine.schedulePush(a.project.id); a.engine.schedulePush(a.project.id);
    await new Promise((r) => setTimeout(r, 150));
    expect(a.store.listUnsynced('observations', a.project.id, 10)).toHaveLength(0);
    a.engine.close();
  });
  it('a row whose vector the hub cannot take is kept: it reaches the hub without a vector', async () => {
    const a = client('alice', keys.alice, 2);
    const s = sess(a.project.id); a.store.upsertSession(s);
    const o = obs({ projectId: a.project.id, sessionId: s.id, title: 'other embedder' });
    a.store.insertObservations([o]); a.store.setObservationEmbedding(o.id, [1, 0], 'other-model');
    const r = await a.engine.push(a.project);
    expect(r!.accepted.observations).toBe(1); expect(r!.rejected).toEqual([]);
    expect(a.store.listUnsynced('observations', a.project.id, 10)).toHaveLength(0);
    const b = client('bob', keys.bob, 2);
    await b.engine.pull(b.project, 3000);
    expect(b.store.getObservations([o.id])[0]).toMatchObject({ title: 'other embedder', embeddingModel: null });
    a.engine.close(); b.engine.close();
  });
  it('against a hub without an embedder vectors are dropped, rows kept; other rejects are marked synced', async () => {
    const hs = new SqliteHubStore(':memory:', { dims: null }); await hs.migrate();
    const h2 = await startHub(hs, { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000 }, silent);
    await hs.createUser('carol'); const k = generateApiKey(); await hs.createApiKey('carol', 'l', k.hash);
    try {
      const url2 = `http://127.0.0.1:${h2.port}`;
      const a = client('carol', k.raw, 2); saveCredentials(a.home, { hubs: { [url2]: { key: k.raw, user: 'carol' } } });
      a.store.setProjectHub(a.project.id, url2);
      const s = sess(a.project.id); a.store.upsertSession(s);
      const o = obs({ projectId: a.project.id, sessionId: s.id }); a.store.insertObservations([o]); a.store.setObservationEmbedding(o.id, [1, 0], 'm');
      const r = await a.engine.push(a.store.getProject(a.project.id)!);
      expect(r!.accepted.observations).toBe(1); expect(r!.rejected).toEqual([]);
      a.engine.close();
    } finally { await h2.close(); }
  });
  it('401 marks authFailed and stops pushing; unlinked project is ignored', async () => {
    const bad = client('eve', 'mh_' + 'A'.repeat(43), 2);
    const s = sess(bad.project.id); bad.store.upsertSession(s);
    expect(await bad.engine.push(bad.project)).toBeNull();
    expect(loadCredentials(bad.home).hubs[hubUrl].authFailed).toBe(true);
    expect(bad.store.listUnsynced('sessions', bad.project.id, 10)).toHaveLength(1);
    expect(await bad.engine.push(bad.project)).toBeNull();
    expect(await bad.engine.pull(bad.project, 1000)).toBe(0);
    const a = client('alice', keys.alice, 2);
    a.store.setProjectHub(a.project.id, null);
    expect(await a.engine.push(a.store.getProject(a.project.id)!)).toBeNull();
    bad.engine.close(); a.engine.close();
  });
});
