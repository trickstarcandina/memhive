import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startHub } from '../../src/hub/server.js';
import { generateApiKey } from '../../src/hub/auth.js';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { obs, sess } from '../store/store-contract.js';
import { hubStores } from './hub-stores.js';
import type { HubStore } from '../../src/hub/store/types.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
describe.each(hubStores('tomb'))('$name', ({ open }) => {
  let hub: Awaited<ReturnType<typeof startHub>>; let hubUrl: string; let hs: HubStore;
  const keys: Record<string, string> = {};
  const client = (user: string) => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    saveCredentials(home, { hubs: { [hubUrl]: { key: keys[user], user } } });
    const store = new SqliteStore(':memory:', { dims: null }); store.migrate();
    const p = store.getOrCreateProject('github.com/t/tomb', 'tomb'); store.setProjectHub(p.id, hubUrl);
    return { store, project: store.getProject(p.id)!, engine: new SyncEngine({ store, home, logger: silent, embedDims: null }, { debounceMs: 10 }) };
  };
  beforeAll(async () => {
    hs = await open(null);
    hub = await startHub(hs, { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000 }, silent);
    hubUrl = `http://127.0.0.1:${hub.port}`;
    for (const u of ['alice', 'bob']) { await hs.createUser(u); const k = generateApiKey(); await hs.createApiKey(u, 'l', k.hash); keys[u] = k.raw; }
  });
  afterAll(async () => { await hub.close(); });

  it('an owner forget is pushed, relayed to a teammate, and the row is not pulled back', async () => {
    const a = client('alice'); const b = client('bob');
    const s = sess(a.project.id, { userId: 'alice' }); a.store.upsertSession(s);
    const keep = obs({ projectId: a.project.id, sessionId: s.id, userId: 'alice', title: 'stays' });
    const gone = obs({ projectId: a.project.id, sessionId: s.id, userId: 'alice', title: 'secret pasted by mistake' });
    a.store.insertObservations([keep, gone]);
    await a.engine.push(a.project); expect(await b.engine.pull(b.project, 3000)).toBe(3);

    a.store.deleteObservations([gone.id]);
    const r = await a.engine.push(a.project);
    expect(r!.accepted.tombstones).toBe(1); expect(r!.rejected).toEqual([]);
    expect(a.store.listPendingTombstones(a.project.id, 10)).toEqual([]);
    expect(await hs.getObservations([gone.id])).toEqual([]);

    expect(await b.engine.pull(b.project, 3000)).toBe(1);
    expect(b.store.getObservations([gone.id])).toEqual([]); expect(b.store.getObservations([keep.id])).toHaveLength(1);
    expect(b.store.forgottenIds(b.project.id, [gone.id]).size).toBe(1);
    expect(b.store.listPendingTombstones(b.project.id, 10)).toEqual([]);   // a pulled tombstone is never pushed back
    a.engine.close(); b.engine.close();
  });

  it("a teammate's tombstone is rejected not_owner and the row stays on the hub", async () => {
    const a = client('alice'); const b = client('bob');
    const s = sess(a.project.id, { userId: 'alice' }); a.store.upsertSession(s);
    const o = obs({ projectId: a.project.id, sessionId: s.id, userId: 'alice' }); a.store.insertObservations([o]);
    await a.engine.push(a.project); await b.engine.pull(b.project, 3000);
    b.store.deleteObservations([o.id]);   // queued like an own row would be
    const r = await b.engine.push(b.project);
    expect(r!.rejected).toEqual([{ id: o.id, reason: 'not_owner' }]);
    expect(b.store.listPendingTombstones(b.project.id, 10)).toEqual([]);   // not retried
    expect(await hs.getObservations([o.id])).toHaveLength(1);
    a.engine.close(); b.engine.close();
  });

  it('a session tombstone removes the session and its rows on every client', async () => {
    const a = client('alice'); const b = client('bob');
    const s = sess(a.project.id, { userId: 'alice' }); a.store.upsertSession(s);
    const o = obs({ projectId: a.project.id, sessionId: s.id, userId: 'alice' }); a.store.insertObservations([o]);
    await a.engine.push(a.project); await b.engine.pull(b.project, 3000);
    a.store.deleteSession(s.id); await a.engine.push(a.project);
    await b.engine.pull(b.project, 3000);
    expect(b.store.getSession(s.id)).toBeNull(); expect(b.store.getObservations([o.id])).toEqual([]);
    a.engine.close(); b.engine.close();
  });
});

describe('protocol 1 hub', () => {
  it('keeps tombstones pending, warns once, and skips pulled rows that were forgotten', async () => {
    const hubUrl = 'http://127.0.0.1:9';
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    saveCredentials(home, { hubs: { [hubUrl]: { key: 'mh_' + 'A'.repeat(43), user: 'alice' } } });
    const store = new SqliteStore(':memory:', { dims: null }); store.migrate();
    const p = store.getOrCreateProject('github.com/t/p1', 'p1'); store.setProjectHub(p.id, hubUrl);
    const s = sess(p.id, { userId: 'alice', syncedAt: null }); store.upsertSession(s);
    const o = obs({ projectId: p.id, sessionId: s.id, userId: 'alice' }); store.insertObservations([o]);
    store.markSynced('sessions', [s.id], new Date().toISOString()); store.markSynced('observations', [o.id], new Date().toISOString());
    store.deleteObservations([o.id]);
    const bodies: any[] = []; const warns: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/v1/config')) return new Response(JSON.stringify({ version: 'x', protocol: 1, embedding_model: null, embedding_dims: null, body_limit: 2_000_000 }), { status: 200 });
      if (u.endsWith('/v1/sync/push')) { bodies.push(JSON.parse(String(init!.body))); return new Response(JSON.stringify({ accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [] }), { status: 200 }); }
      // An old hub still relays the forgotten row (from a teammate who never got the tombstone).
      return new Response(JSON.stringify({ sessions: [], observations: [{ ...o, origin: 'hub' }], summaries: [], next_seq: 1, has_more: false, max_seq: 1 }), { status: 200 });
    }) as unknown as typeof fetch;
    const engine = new SyncEngine({ store, home, logger: { ...silent, warn(m: string) { warns.push(m); } }, embedDims: null, fetchImpl });
    const project = store.getProject(p.id)!;
    await engine.push(project, { force: true }); await engine.push(project, { force: true });
    expect(bodies).toEqual([]);   // nothing else to send, and tombstones are not sent to a protocol 1 hub
    expect(store.listPendingTombstones(p.id, 10).map((t) => t.id)).toEqual([o.id]);
    expect(warns.filter((w) => w.includes('tombstones'))).toHaveLength(1);
    expect(await engine.pull(project, 3000)).toBe(0);
    expect(store.getObservations([o.id])).toEqual([]);
    await engine.close();
  });
});
