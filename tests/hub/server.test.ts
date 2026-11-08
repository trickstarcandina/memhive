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
