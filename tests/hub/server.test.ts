import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { startHub, ensureAdminKey, createHubStore, hubConfigFromEnv } from '../../src/hub/server.js';
import { generateApiKey } from '../../src/hub/auth.js';
import { hobs, hsess } from './hub-store-contract.js';
import { newId } from '../../src/shared/ids.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
let hub: Awaited<ReturnType<typeof startHub>>; let store: SqliteHubStore; let aliceKey: string; let bobKey: string;
const base = () => `http://127.0.0.1:${hub.port}`;
const call = async (key: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(base() + path, { method, headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() };
};

beforeAll(async () => {
  store = new SqliteHubStore(':memory:', { dims: 4 }); await store.migrate();
  const admin = await ensureAdminKey(store); expect(admin).toMatch(/^mh_/); expect(await ensureAdminKey(store)).toBeNull();
  await store.createUser('alice'); const a = generateApiKey(); await store.createApiKey('alice', 'l', a.hash); aliceKey = a.raw;
  await store.createUser('bob'); const b = generateApiKey(); await store.createApiKey('bob', 'l', b.hash); bobKey = b.raw;
  hub = await startHub(store, { port: 0, embeddingModel: 'bge-m3', embeddingDims: 4, bodyLimit: 2_000_000 }, silent);
});
afterAll(async () => { await hub.close(); });

describe('hub http', () => {
  it('healthz is public, everything else needs a key', async () => {
    expect((await call(null, 'GET', '/healthz')).status).toBe(200);
    expect((await call(null, 'GET', '/v1/config')).status).toBe(401);
    expect((await call('mh_wrong', 'GET', '/v1/config')).status).toBe(401);
  });
  it('config and me', async () => {
    expect((await call(aliceKey, 'GET', '/v1/config')).json).toMatchObject({ embedding_model: 'bge-m3', embedding_dims: 4 });
    expect((await call(aliceKey, 'GET', '/v1/me')).json).toEqual({ user: 'alice' });
  });
  it('push assigns user from key, rejects model mismatch and bad dims per row, pull returns rows in order', async () => {
    const sid = newId(); const o1 = hobs({ projectId: 'x', sessionId: sid, userId: 'spoof', title: 'ok', embedding: [1, 0, 0, 0], embeddingModel: 'bge-m3' });
    const o2 = hobs({ projectId: 'x', sessionId: sid, title: 'wrong model', embedding: [1, 0, 0, 0], embeddingModel: 'other' });
    const o3 = hobs({ projectId: 'x', sessionId: sid, title: 'wrong dims', embedding: [1, 0], embeddingModel: 'bge-m3' });
    const o4 = hobs({ projectId: 'x', sessionId: sid, title: 'no vec' });
    const push = await call(aliceKey, 'POST', '/v1/sync/push', { projectKey: 'github.com/t/r', projectName: 'r', sessions: [hsess('x', { id: sid, userId: 'spoof' })], observations: [o1, o2, o3, o4], summaries: [] });
    expect(push.status).toBe(200);
    expect(push.json.accepted).toEqual({ sessions: 1, observations: 2, summaries: 0 });
    expect(push.json.rejected.map((r: any) => r.id).sort()).toEqual([o2.id, o3.id].sort());
    expect(push.json.rejected[0].reason).toBe('embedding_model_mismatch');
    const pull = await call(bobKey, 'GET', '/v1/sync/pull?project_key=github.com%2Ft%2Fr&since=0');
    expect(pull.status).toBe(200);
    expect(pull.json.sessions[0].userId).toBe('alice');
    expect(pull.json.observations.map((o: any) => o.title)).toEqual(['ok', 'no vec']);
    expect(pull.json.observations[0].embedding).toEqual([1, 0, 0, 0]);
    expect(pull.json.has_more).toBe(false);
    const again = await call(bobKey, 'GET', `/v1/sync/pull?project_key=github.com%2Ft%2Fr&since=${pull.json.next_seq}`);
    expect(again.json.observations).toEqual([]); expect(again.json.next_seq).toBe(pull.json.next_seq);
    const beyond = await call(bobKey, 'GET', `/v1/sync/pull?project_key=github.com%2Ft%2Fr&since=999999`);
    expect(beyond.json.next_seq).toBe(999999); expect(beyond.json.has_more).toBe(false);
  });
  it('re-pushing the same session from another machine is idempotent', async () => {
    const sid = newId(); const s = hsess('x', { id: sid });
    const body = { projectKey: 'github.com/t/r', projectName: 'r', sessions: [s], observations: [], summaries: [] };
    expect((await call(aliceKey, 'POST', '/v1/sync/push', body)).status).toBe(200);
    expect((await call(aliceKey, 'POST', '/v1/sync/push', { ...body, sessions: [{ ...s, endedAt: '2026-01-01T00:00:00.000Z' }] })).status).toBe(200);
    expect((await store.getSessions([sid]))).toHaveLength(1);
  });
  it('search is fts and project scoped', async () => {
    const r = await call(bobKey, 'GET', '/v1/search?project_key=github.com%2Ft%2Fr&q=vec');
    expect(r.json.observations.map((o: any) => o.title)).toContain('no vec');
  });
  it('bad json and unknown routes', async () => {
    const res = await fetch(base() + '/v1/sync/push', { method: 'POST', headers: { authorization: `Bearer ${aliceKey}`, 'content-type': 'application/json' }, body: '{nope' });
    expect(res.status).toBe(400);
    expect((await call(aliceKey, 'GET', '/v1/nothing')).status).toBe(404);
  });
  it('rate limits', async () => {
    const k = generateApiKey(); await store.createUser('spam'); await store.createApiKey('spam', 'l', k.hash);
    let last = 200; for (let i = 0; i < 61; i++) last = (await call(k.raw, 'GET', '/v1/me')).status;
    expect(last).toBe(429);
  });
});

describe('createHubStore', () => {
  it('throws without DATABASE_URL and on unknown scheme', () => {
    expect(() => createHubStore({})).toThrow(/DATABASE_URL/);
    expect(() => createHubStore({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres|sqlite/);
    expect(hubConfigFromEnv({ PORT: '8080', MEMHUB_EMBED_MODEL: 'm', MEMHUB_EMBED_DIMS: '8' })).toEqual({ port: 8080, embeddingModel: 'm', embeddingDims: 8, bodyLimit: 2 * 1024 * 1024 });
  });
});

describe('hub push hardening', () => {
  const PK = 'github.com/t/hard';
  const push = (key: string, body: object) => call(key, 'POST', '/v1/sync/push', { projectKey: PK, projectName: 'hard', sessions: [], observations: [], summaries: [], ...body });
  const sum = (sessionId: string, id = newId()) => ({ id, projectId: 'x', sessionId, userId: 'u', request: 'r', learned: '', completed: '', nextSteps: '', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null });

  it('rejects orphan observations and summaries instead of 500', async () => {
    const o = hobs({ projectId: 'x', sessionId: newId(), title: 'orphan' }); const m = sum(newId());
    const r = await push(aliceKey, { observations: [o], summaries: [m] });
    expect(r.status).toBe(200);
    expect(r.json.accepted).toEqual({ sessions: 0, observations: 0, summaries: 0 });
    expect(r.json.rejected).toEqual(expect.arrayContaining([{ id: o.id, reason: 'unknown_session' }, { id: m.id, reason: 'unknown_session' }]));
  });
  it('rejects malformed ids per row, never drops silently', async () => {
    const bad = '-'.repeat(36); const sid = newId();
    const r = await push(aliceKey, { sessions: [hsess('x', { id: bad }), hsess('x', { id: sid })], observations: [hobs({ projectId: 'x', sessionId: sid, id: bad }), hobs({ projectId: 'x', sessionId: bad })], summaries: [sum(sid, bad)] });
    expect(r.json.accepted.sessions).toBe(1);
    expect(r.json.rejected.filter((x: any) => x.reason === 'invalid_id')).toHaveLength(4);
  });
  it("another user cannot overwrite or attach to someone else's rows", async () => {
    const sid = newId(); const s = hsess('x', { id: sid, cwd: '/alice' }); const o = hobs({ projectId: 'x', sessionId: sid, title: 'alice-obs' });
    expect((await push(aliceKey, { sessions: [s], observations: [o] })).json.accepted).toMatchObject({ sessions: 1, observations: 1 });
    const mine = hobs({ projectId: 'x', sessionId: sid, title: 'bob-on-alice-session' });
    const r = await push(bobKey, { sessions: [{ ...s, cwd: '/bob', endedAt: '2030-01-01T00:00:00.000Z' }], observations: [{ ...o, title: 'hijacked' }, mine] });
    expect(r.json.accepted).toEqual({ sessions: 0, observations: 0, summaries: 0 });
    expect(r.json.rejected.map((x: any) => x.reason)).toEqual(['unknown_session', 'unknown_session']);
    expect((await store.getSessions([sid]))[0]).toMatchObject({ userId: 'alice', cwd: '/alice', endedAt: null });
    expect((await store.getObservations([o.id]))[0]).toMatchObject({ userId: 'alice', title: 'alice-obs' });
  });
  it('invalid vectors are rejected per row', async () => {
    const sid = newId(); const bad = hobs({ projectId: 'x', sessionId: sid, title: 'nan', embedding: [1, 'a' as any, 0, 0], embeddingModel: 'bge-m3' });
    const r = await push(aliceKey, { sessions: [hsess('x', { id: sid })], observations: [bad] });
    expect(r.json.rejected).toEqual([{ id: bad.id, reason: 'invalid_vector' }]);
  });
  it('pull paginates with has_more and caps limit at 1000', async () => {
    const sid = newId(); const rows = Array.from({ length: 1001 }, (_, i) => hobs({ projectId: 'x', sessionId: sid, title: `p${i}` }));
    const pk = 'github.com/t/pages';
    expect((await call(aliceKey, 'POST', '/v1/sync/push', { projectKey: pk, projectName: 'p', sessions: [hsess('x', { id: sid })], observations: rows, summaries: [] })).json.accepted.observations).toBe(1001);
    const p1 = await call(bobKey, 'GET', `/v1/sync/pull?project_key=${encodeURIComponent(pk)}&since=0&limit=2`);
    expect(p1.json.has_more).toBe(true); expect(p1.json.sessions.length + p1.json.observations.length).toBe(2);
    const big = await call(bobKey, 'GET', `/v1/sync/pull?project_key=${encodeURIComponent(pk)}&since=0&limit=5000`);
    expect(big.json.sessions.length + big.json.observations.length).toBe(1000); expect(big.json.has_more).toBe(true);
    const nan = await call(bobKey, 'GET', `/v1/sync/pull?project_key=${encodeURIComponent(pk)}&since=abc&limit=xyz`);
    expect(nan.status).toBe(200);
  });
});

describe('hub isolated servers', () => {
  const open = async (cfg: Partial<Parameters<typeof startHub>[1]> & { dims?: number }, logs: unknown[] = []) => {
    const st = new SqliteHubStore(':memory:', { dims: cfg.dims ?? 4 }); await st.migrate();
    await st.createUser('u'); const k = generateApiKey(); await st.createApiKey('u', 'l', k.hash);
    const log = { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a), error: (...a: unknown[]) => logs.push(a), debug: (...a: unknown[]) => logs.push(a) };
    const h = await startHub(st, { port: 0, embeddingModel: 'bge-m3', embeddingDims: 4, bodyLimit: 2_000_000, ...cfg }, log);
    return { h, key: k.raw, st };
  };
  it('HubDimsMismatch from the store keeps valid rows and rejects the bad row', async () => {
    const { h, key } = await open({ embeddingModel: null, embeddingDims: 2, dims: 4 });
    const sid = newId(); const ok = hobs({ projectId: 'x', sessionId: sid, title: 'plain' }); const bad = hobs({ projectId: 'x', sessionId: sid, title: 'vec', embedding: [1, 0] });
    const res = await fetch(`http://127.0.0.1:${h.port}/v1/sync/push`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ projectKey: 'k/r', projectName: 'r', sessions: [hsess('x', { id: sid })], observations: [ok, bad], summaries: [] }) });
    const j: any = await res.json();
    expect(res.status).toBe(200); expect(j.accepted.observations).toBe(1); expect(j.rejected).toEqual([{ id: bad.id, reason: 'embedding_model_mismatch' }]);
    await h.close();
  });
  it('enforces body limit (413) and 401 before buffering without a key; raw keys never reach logs', async () => {
    const logs: unknown[] = []; const { h, key } = await open({ bodyLimit: 100 }, logs);
    const url = `http://127.0.0.1:${h.port}/v1/sync/push`; const big = JSON.stringify({ pad: 'x'.repeat(500) });
    expect((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: big })).status).toBe(413);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: big })).status).toBe(401);
    await fetch(url, { method: 'POST', headers: { authorization: 'Bearer mh_secretwrongkey', 'content-type': 'application/json' }, body: '{}' });
    expect(JSON.stringify(logs)).not.toContain(key); expect(JSON.stringify(logs)).not.toContain('mh_secretwrongkey');
    await h.close();
  });
});
