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
import { hubStores } from './hub-stores.js';
import type { HubStore } from '../../src/hub/store/types.js';
import { waitFor } from '../helpers/wait.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
describe.each(hubStores('rt'))('$name', ({ open }) => {
  let hub: Awaited<ReturnType<typeof startHub>>;
  let hubUrl: string;
  let hs: HubStore;
  const keys: Record<string, string> = {};
  const client = (user: string, key: string, dims: number | null) => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    saveCredentials(home, { hubs: { [hubUrl]: { key, user } } });
    const store = new SqliteStore(':memory:', { dims });
    store.migrate();
    const project = store.getOrCreateProject('github.com/t/r', 'r');
    store.setProjectHub(project.id, hubUrl);
    const engine = new SyncEngine(
      { store, home, logger: silent, embedDims: dims, embedModel: 'm' },
      { debounceMs: 10 }
    );
    return { home, store, project: store.getProject(project.id)!, engine, user };
  };

  beforeAll(async () => {
    hs = await open(2);
    hub = await startHub(hs, { port: 0, embeddingModel: 'm', embeddingDims: 2, bodyLimit: 2_000_000 }, silent);
    hubUrl = `http://127.0.0.1:${hub.port}`;
    for (const u of ['alice', 'bob']) {
      await hs.createUser(u);
      const k = generateApiKey();
      await hs.createApiKey(u, 'l', k.hash);
      keys[u] = k.raw;
    }
  });
  afterAll(async () => {
    await hub.close();
  });

  describe('sync round trip', { shuffle: false }, () => {
    // a scripted conversation between clients A and B
    it('A pushes, B pulls, origin=hub, vectors carried, idempotent, cursor advances', async () => {
      const a = client('alice', keys.alice, 2);
      const b = client('bob', keys.bob, 2);
      const s = sess(a.project.id, { userId: 'alice' });
      a.store.upsertSession(s);
      const o = obs({
        projectId: a.project.id,
        sessionId: s.id,
        userId: 'alice',
        title: 'Shared decision',
        type: 'decision',
      });
      a.store.insertObservations([o]);
      a.store.setObservationEmbedding(o.id, [0.5, 0.5], 'm');
      a.store.insertSummaries([
        {
          id: o.id.replace(/.$/, '0'),
          projectId: a.project.id,
          sessionId: s.id,
          userId: 'alice',
          request: 'r',
          learned: '',
          completed: '',
          nextSteps: '',
          createdAt: new Date().toISOString(),
          origin: 'local',
          syncedAt: null,
        },
      ]);
      const pushed = await a.engine.push(a.project);
      expect(pushed!.accepted).toEqual({ sessions: 1, observations: 1, summaries: 1 });
      expect(a.store.listUnsynced('observations', a.project.id, 10)).toHaveLength(0);
      expect((await a.engine.push(a.project))!.accepted.observations).toBe(0);

      expect(await b.engine.pull(b.project, 3000)).toBe(3);
      const got = b.store.getObservations([o.id])[0];
      expect(got).toMatchObject({ title: 'Shared decision', origin: 'hub', userId: 'alice' });
      expect(got.syncedAt).not.toBeNull();
      expect(got.embeddingModel).toBe('m');
      expect(b.store.searchObservationsVector([0.5, 0.5], { projectId: b.project.id, limit: 1 })[0].id).toBe(o.id);
      expect(b.store.listRecentSummaries(b.project.id, 1)[0].request).toBe('r');
      expect(b.store.getPullCursor(b.project.id)).toBeGreaterThan(0);
      expect(await b.engine.pull(b.project, 3000)).toBe(0);
      expect(b.store.listUnsynced('observations', b.project.id, 10)).toHaveLength(0); // pulled rows are never pushed back
      expect(b.store.listUnsynced('sessions', b.project.id, 10)).toHaveLength(0);
      a.engine.close();
      b.engine.close();
    });
    it('a pulled session that ends on the hub is updated locally; its cwd is never relayed', async () => {
      const a = client('alice', keys.alice, 2);
      const b = client('bob', keys.bob, 2);
      const s = sess(a.project.id, { userId: 'alice', cwd: '/a' });
      a.store.upsertSession(s);
      await a.engine.push(a.project);
      await b.engine.pull(b.project, 3000);
      expect(b.store.getSession(s.id)).toMatchObject({ endedAt: null, cwd: '' });
      a.store.upsertSession({ ...s, cwd: '/a2', endedAt: '2026-02-02T00:00:00.000Z' });
      await a.engine.push(a.project);
      await b.engine.pull(b.project, 3000);
      expect(b.store.getSession(s.id)).toMatchObject({ endedAt: '2026-02-02T00:00:00.000Z', cwd: '', origin: 'hub' });
      expect(b.store.getSession(s.id)!.syncedAt).not.toBeNull();
      a.engine.close();
      b.engine.close();
    });
    it('getObservationEmbeddings returns only ids with a vector', () => {
      const a = client('alice', keys.alice, 2);
      const s = sess(a.project.id);
      a.store.upsertSession(s);
      const o1 = obs({ projectId: a.project.id, sessionId: s.id });
      const o2 = obs({ projectId: a.project.id, sessionId: s.id });
      a.store.insertObservations([o1, o2]);
      a.store.setObservationEmbedding(o1.id, [0.25, 0.75], 'm');
      const m = a.store.getObservationEmbeddings([o1.id, o2.id]);
      expect([...m.keys()]).toEqual([o1.id]);
      expect(m.get(o1.id)).toEqual([0.25, 0.75]);
      a.engine.close();
    });
    it('pulled vector with other dims is stored without a vector', async () => {
      const c = client('bob', keys.bob, 3);
      expect(await c.engine.pull(c.project, 3000)).toBeGreaterThan(0);
      expect(c.store.listMissingEmbedding(10).length).toBeGreaterThan(0);
      expect(
        c.store
          .getObservations(c.store.listMissingEmbedding(10).map((o) => o.id))
          .every((o) => o.embeddingModel === null)
      ).toBe(true);
      c.engine.close();
    });
    it('schedulePush debounces and pushes', async () => {
      const a = client('alice', keys.alice, 2);
      const s = sess(a.project.id);
      a.store.upsertSession(s);
      a.store.insertObservations([obs({ projectId: a.project.id, sessionId: s.id, title: 'debounced' })]);
      a.engine.schedulePush(a.project.id);
      a.engine.schedulePush(a.project.id);
      await waitFor(() => a.store.listUnsynced('observations', a.project.id, 10).length === 0, {
        what: 'debounced push',
      });
      a.engine.close();
    });
    it('a row whose vector the hub cannot take is kept: it reaches the hub without a vector', async () => {
      const a = client('alice', keys.alice, 2);
      const s = sess(a.project.id);
      a.store.upsertSession(s);
      const o = obs({ projectId: a.project.id, sessionId: s.id, title: 'other embedder' });
      a.store.insertObservations([o]);
      a.store.setObservationEmbedding(o.id, [1, 0], 'other-model');
      const r = await a.engine.push(a.project);
      expect(r!.accepted.observations).toBe(1);
      expect(r!.rejected).toEqual([]);
      expect(a.store.listUnsynced('observations', a.project.id, 10)).toHaveLength(0);
      const b = client('bob', keys.bob, 2);
      await b.engine.pull(b.project, 3000);
      expect(b.store.getObservations([o.id])[0]).toMatchObject({ title: 'other embedder', embeddingModel: null });
      a.engine.close();
      b.engine.close();
    });
    it('against a hub without an embedder vectors are dropped, rows kept; other rejects are marked synced', async () => {
      const hs = new SqliteHubStore(':memory:', { dims: null });
      await hs.migrate();
      const h2 = await startHub(
        hs,
        { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000 },
        silent
      );
      await hs.createUser('carol');
      const k = generateApiKey();
      await hs.createApiKey('carol', 'l', k.hash);
      try {
        const url2 = `http://127.0.0.1:${h2.port}`;
        const a = client('carol', k.raw, 2);
        saveCredentials(a.home, { hubs: { [url2]: { key: k.raw, user: 'carol' } } });
        a.store.setProjectHub(a.project.id, url2);
        const s = sess(a.project.id);
        a.store.upsertSession(s);
        const o = obs({ projectId: a.project.id, sessionId: s.id });
        a.store.insertObservations([o]);
        a.store.setObservationEmbedding(o.id, [1, 0], 'm');
        const r = await a.engine.push(a.store.getProject(a.project.id)!);
        expect(r!.accepted.observations).toBe(1);
        expect(r!.rejected).toEqual([]);
        a.engine.close();
      } finally {
        await h2.close();
      }
    });
    it('pulled observations are re-redacted and length-capped', async () => {
      const a = client('alice', keys.alice, 2);
      const b = client('bob', keys.bob, 2);
      const s = sess(a.project.id, { userId: 'alice' });
      a.store.upsertSession(s);
      const secret = 'ghp_' + 'Z'.repeat(36);
      // stored raw on A (a client that skips redaction, or curl): B must not keep the secret
      const o = obs({
        projectId: a.project.id,
        sessionId: s.id,
        userId: 'alice',
        title: `leak ${secret}`,
        facts: [`token ${secret}`],
        narrative: secret,
      });
      a.store.insertObservations([o]);
      a.store.insertSummaries([
        {
          id: o.id.replace(/.$/, '1'),
          projectId: a.project.id,
          sessionId: s.id,
          userId: 'alice',
          request: secret,
          learned: '',
          completed: '',
          nextSteps: '',
          createdAt: new Date().toISOString(),
          origin: 'local',
          syncedAt: null,
        },
      ]);
      await a.engine.push(a.project);
      await b.engine.pull(b.project, 3000);
      const got = b.store.getObservations([o.id])[0];
      expect(JSON.stringify(got)).not.toContain(secret);
      expect(got.title).toBe('leak <redacted>');
      expect(JSON.stringify(b.store.listRecentSummaries(b.project.id, 50))).not.toContain(secret);
      // an older or hostile hub sending rows past the caps: clipped, not dropped
      const big = {
        ...obs({ projectId: 'x', sessionId: s.id, userId: 'mallory' }),
        title: 't'.repeat(5000),
        narrative: 'n'.repeat(50_000),
        facts: Array.from({ length: 300 }, () => 'f'.repeat(9000)),
        embedding: null,
      };
      const page = {
        sessions: [],
        observations: [big],
        summaries: [],
        next_seq: 1_000_000,
        has_more: false,
        max_seq: 1_000_000,
      };
      const fake = (async (url: string, init?: RequestInit) =>
        String(url).includes('/v1/sync/pull')
          ? new Response(JSON.stringify(page), { status: 200 })
          : fetch(url, init)) as typeof fetch;
      const e2 = new SyncEngine({
        store: b.store,
        home: b.home,
        logger: silent,
        embedDims: 2,
        embedModel: 'm',
        fetchImpl: fake,
      });
      expect(await e2.pull(b.project, 3000)).toBe(1);
      const clipped = b.store.getObservations([big.id])[0];
      expect(clipped.title).toHaveLength(1000);
      expect(clipped.narrative).toHaveLength(20_000);
      expect(clipped.facts).toHaveLength(100);
      expect(clipped.facts[0]).toHaveLength(4000);
      a.engine.close();
      b.engine.close();
      await e2.close();
    });
    it('resend after lost response is idempotent', async () => {
      // the hub commits, then the response is lost (daemon crash before markSynced): the next push resends the same rows
      const a = client('alice', keys.alice, 2);
      let lose = true;
      const lossy = (async (url: string, init?: RequestInit) => {
        const r = await fetch(url, init);
        if (lose && String(url).endsWith('/v1/sync/push')) {
          lose = false;
          throw new TypeError('fetch failed');
        }
        return r;
      }) as typeof fetch;
      const e = new SyncEngine({
        store: a.store,
        home: a.home,
        logger: silent,
        embedDims: 2,
        embedModel: 'm',
        fetchImpl: lossy,
      });
      const s = sess(a.project.id, { userId: 'alice' });
      a.store.upsertSession(s);
      const o = obs({ projectId: a.project.id, sessionId: s.id, userId: 'alice', title: 'once' });
      a.store.insertObservations([o]);
      expect(await e.push(a.project)).toBeNull();
      expect(a.store.listUnsynced('observations', a.project.id, 10)).toHaveLength(1);
      const hp = (await hs.getProjectByKey(a.project.key))!;
      const logged = (await hs.listSyncLog(hp.id, 0, 1000)).length;
      expect(await e.push(a.project, { force: true })).not.toBeNull();
      expect(a.store.listUnsynced('observations', a.project.id, 10)).toHaveLength(0);
      expect(await hs.getObservations([o.id])).toHaveLength(1);
      expect((await hs.listSyncLog(hp.id, 0, 1000)).length).toBe(logged);
      await e.close();
      a.engine.close();
    });
    it('401 marks authFailed and stops pushing; unlinked project is ignored', async () => {
      const bad = client('eve', 'mh_' + 'A'.repeat(43), 2);
      const s = sess(bad.project.id);
      bad.store.upsertSession(s);
      expect(await bad.engine.push(bad.project)).toBeNull();
      expect(loadCredentials(bad.home).hubs[hubUrl].authFailed).toBe(true);
      expect(bad.store.listUnsynced('sessions', bad.project.id, 10)).toHaveLength(1);
      expect(await bad.engine.push(bad.project)).toBeNull();
      expect(await bad.engine.pull(bad.project, 1000)).toBe(0);
      const a = client('alice', keys.alice, 2);
      a.store.setProjectHub(a.project.id, null);
      expect(await a.engine.push(a.store.getProject(a.project.id)!)).toBeNull();
      bad.engine.close();
      a.engine.close();
    });
  });
});
