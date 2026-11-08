import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { startHub, ensureAdminKey, createHubStore, hubConfigFromEnv } from '../../src/hub/server.js';
import { generateApiKey } from '../../src/hub/auth.js';
import { hobs, hsess } from './hub-store-contract.js';
import { newId } from '../../src/shared/ids.js';
import { HUB_PROTOCOL, HubConfigInfoSchema, PullResultSchema } from '../../src/hub/wire.js';

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
    const noKey = await call(null, 'GET', '/v1/config');
    expect(noKey.status).toBe(401); expect(noKey.json.error.message).toBe('missing or invalid API key');   // not the daemon's wording
    expect((await call('mh_wrong', 'GET', '/v1/config')).status).toBe(401);
  });
  it('config and me', async () => {
    const cfg = (await call(aliceKey, 'GET', '/v1/config')).json;
    expect(cfg).toMatchObject({ embedding_model: 'bge-m3', embedding_dims: 4, body_limit: 2_000_000, protocol: HUB_PROTOCOL });
    expect(HubConfigInfoSchema.safeParse(cfg).success).toBe(true);
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
    expect(pull.status).toBe(200); expect(PullResultSchema.safeParse(pull.json).success).toBe(true);
    expect(pull.json.sessions[0].userId).toBe('alice');
    expect(pull.json.observations.map((o: any) => o.title)).toEqual(['ok', 'no vec']);
    expect(pull.json.observations[0].embedding).toEqual([1, 0, 0, 0]);
    expect(pull.json.has_more).toBe(false);
    const again = await call(bobKey, 'GET', `/v1/sync/pull?project_key=github.com%2Ft%2Fr&since=${pull.json.next_seq}`);
    expect(again.json.observations).toEqual([]); expect(again.json.next_seq).toBe(pull.json.next_seq);
    const beyond = await call(bobKey, 'GET', `/v1/sync/pull?project_key=github.com%2Ft%2Fr&since=999999`);
    expect(beyond.json.next_seq).toBe(999999); expect(beyond.json.has_more).toBe(false);
    expect(beyond.json.max_seq).toBe(pull.json.next_seq);   // lets a client with a cursor past the end detect a hub reset
    expect((await call(bobKey, 'GET', '/v1/sync/pull?project_key=nope&since=5')).json.max_seq).toBe(0);
    expect(pull.json.epoch).toEqual(expect.any(String));   // the hub project id: a recreated hub gives a new one
    expect((await call(bobKey, 'GET', '/v1/sync/pull?project_key=nope&since=5')).json.epoch).toBeUndefined();
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

describe('ensureAdminKey', () => {
  it('recovers from a crash between creating the admin user and its key', async () => {
    const st = new SqliteHubStore(':memory:', { dims: null }); await st.migrate();
    await st.createUser('admin');
    expect(await ensureAdminKey(st)).toMatch(/^mh_/);
    expect(await ensureAdminKey(st)).toBeNull();
    await st.close();
  });
});

describe('createHubStore', () => {
  it('throws without DATABASE_URL and on unknown scheme', () => {
    expect(() => createHubStore({})).toThrow(/DATABASE_URL/);
    expect(() => createHubStore({ DATABASE_URL: 'mysql://x' })).toThrow(/postgres|sqlite/);
    expect(hubConfigFromEnv({ PORT: '8080', MEMHIVE_EMBED_MODEL: 'm', MEMHIVE_EMBED_DIMS: '8' })).toEqual({ port: 8080, host: '127.0.0.1', trustProxy: false, embeddingModel: 'm', embeddingDims: 8, bodyLimit: 2 * 1024 * 1024 });
    expect(hubConfigFromEnv({ HOST: '0.0.0.0' }).host).toBe('0.0.0.0');
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
    expect(r.json.rejected).toEqual([{ id: sid, reason: 'not_owner' }, { id: o.id, reason: 'unknown_session' }, { id: mine.id, reason: 'unknown_session' }]);
    expect((await store.getSessions([sid]))[0]).toMatchObject({ userId: 'alice', endedAt: null });
    expect((await store.getObservations([o.id]))[0]).toMatchObject({ userId: 'alice', title: 'alice-obs' });
  });
  it('push rejects oversized observation fields', async () => {
    const sid = newId(); const big = (n: number) => 'x'.repeat(n);
    const cases: Array<[string, Record<string, unknown>]> = [
      ['title', { title: big(1001) }], ['subtitle', { subtitle: big(1001) }], ['narrative', { narrative: big(20_001) }],
      ['facts', { facts: Array.from({ length: 101 }, () => 'f') }], ['concepts', { concepts: [big(4001)] }],
      ['filesRead', { filesRead: [big(4001)] }], ['filesModified', { filesModified: Array.from({ length: 101 }, () => 'f') }],
    ];
    const obsRows = cases.map(([, p]) => ({ ...hobs({ projectId: 'x', sessionId: sid }), ...p }));
    const fine = hobs({ projectId: 'x', sessionId: sid, title: big(1000), narrative: big(20_000), facts: Array.from({ length: 100 }, () => big(40)) });
    const sums = (['request', 'learned', 'completed', 'nextSteps'] as const).map((f) => ({ ...sum(sid), [f]: big(20_001) }));
    const sessions = (['host', 'hostSessionId', 'cwd'] as const).map((f) => hsess('x', { [f]: big(1001) }));
    const r = await push(aliceKey, { sessions: [hsess('x', { id: sid }), ...sessions], observations: [...obsRows, fine], summaries: sums });
    expect(r.status).toBe(200);
    expect(r.json.accepted).toEqual({ sessions: 1, observations: 1, summaries: 0 });
    const byId = new Map(r.json.rejected.map((x: any) => [x.id, x]));
    cases.forEach(([field], i) => expect(byId.get(obsRows[i].id)).toEqual({ id: obsRows[i].id, reason: 'invalid_row', field }));
    sums.forEach((m, i) => expect(byId.get(m.id)).toMatchObject({ reason: 'invalid_row', field: ['request', 'learned', 'completed', 'nextSteps'][i] }));
    sessions.forEach((s, i) => expect(byId.get(s.id)).toMatchObject({ reason: 'invalid_row', field: ['host', 'hostSessionId', 'cwd'][i] }));
    expect(JSON.stringify(r.json)).not.toContain('xxxx');   // names the field, never echoes the value
    for (const top of [{ projectKey: big(1001) }, { projectName: big(1001) }, { projectKey: '' }]) {
      const bad = await call(aliceKey, 'POST', '/v1/sync/push', { projectKey: PK, sessions: [], observations: [], summaries: [], ...top });
      expect(bad.status).toBe(400); expect(bad.json.error.code).toBe('bad_push');
    }
  });
  it('the hub never stores or relays session cwd', async () => {
    const sid = newId(); const s = hsess('x', { id: sid, cwd: '/home/alice/clients/acme' });
    expect((await push(aliceKey, { sessions: [s] })).json.accepted.sessions).toBe(1);
    expect((await push(aliceKey, { sessions: [{ ...s, cwd: '/elsewhere' }] })).json.accepted.sessions).toBe(0);   // a cwd change is not a change
    const { cwd: _c, ...noCwd } = s; expect((await push(aliceKey, { sessions: [{ ...noCwd, id: newId() }] })).json.accepted.sessions).toBe(1);   // optional
    const pull = await call(bobKey, 'GET', `/v1/sync/pull?project_key=${encodeURIComponent(PK)}&since=0&limit=1000`);
    expect(JSON.stringify(pull.json)).not.toContain('/home/alice'); expect(pull.json.sessions.find((x: any) => x.id === sid).cwd).toBe('');
    expect(JSON.stringify(await store.getSessions([sid]))).not.toContain('acme');
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
  it('pull page is capped by bytes, not only rows', async () => {
    const limit = 40_000; const { h, key, st } = await open({ bodyLimit: limit });
    const req = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${h.port}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const sid = newId(); const rows = Array.from({ length: 20 }, (_, i) => hobs({ projectId: 'x', sessionId: sid, title: `b${i}`, narrative: 'n'.repeat(5000) }));
    expect((await req('/v1/sync/push', { projectKey: 'k/bytes', projectName: 'b', sessions: [hsess('x', { id: sid })], observations: [], summaries: [] })).status).toBe(200);
    for (let i = 0; i < rows.length; i += 5) expect((await req('/v1/sync/push', { projectKey: 'k/bytes', projectName: 'b', sessions: [], observations: rows.slice(i, i + 5), summaries: [] })).status).toBe(200);
    const seen: string[] = []; let since = 0; let pages = 0;
    for (;;) {
      const res = await req(`/v1/sync/pull?project_key=k%2Fbytes&since=${since}&limit=1000`); const text = await res.text();
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(limit);
      const j = JSON.parse(text); seen.push(...j.observations.map((o: any) => o.title)); since = j.next_seq; pages++;
      if (!j.has_more) break;
    }
    expect(pages).toBeGreaterThan(2); expect(seen).toEqual(rows.map((r) => r.title));
    // a row larger than the page budget still goes alone, so the cursor can move past it
    const p = (await st.getProjectByKey('k/bytes'))!; const huge = hobs({ projectId: p.id, sessionId: sid, title: 'huge', narrative: 'z'.repeat(60_000) });
    await st.insertObservations([huge]);
    const one: any = await (await req(`/v1/sync/pull?project_key=k%2Fbytes&since=${since}`)).json();
    expect(one.observations.map((o: any) => o.title)).toEqual(['huge']); expect(one.has_more).toBe(false); expect(one.next_seq).toBeGreaterThan(since);
    await h.close();
  });
  it('pull vectors=0 omits embeddings', async () => {
    const { h, key } = await open({});
    const req = (path: string, body?: unknown) => fetch(`http://127.0.0.1:${h.port}${path}`, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json() as Promise<any>);
    const sid = newId(); const o = hobs({ projectId: 'x', sessionId: sid, embedding: [1, 0, 0, 0], embeddingModel: 'bge-m3' });
    expect((await req('/v1/sync/push', { projectKey: 'k/v', projectName: 'v', sessions: [hsess('x', { id: sid })], observations: [o], summaries: [] })).accepted.observations).toBe(1);
    expect((await req('/v1/sync/pull?project_key=k%2Fv&since=0')).observations[0].embedding).toEqual([1, 0, 0, 0]);
    const lean = await req('/v1/sync/pull?project_key=k%2Fv&since=0&vectors=0');
    expect(lean.observations).toHaveLength(1); expect(lean.observations[0]).not.toHaveProperty('embedding');
    expect(lean.observations[0].embeddingModel).toBe('bge-m3'); expect(PullResultSchema.safeParse(lean).success).toBe(true);
    await h.close();
  });
  it('hub binds HOST env (default 127.0.0.1)', async () => {
    const st = new SqliteHubStore(':memory:', { dims: null }); await st.migrate();
    const h = await startHub(st, { ...hubConfigFromEnv({}), port: 0 }, silent);
    expect(h.host).toBe('127.0.0.1'); expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
    await h.close();
    const st2 = new SqliteHubStore(':memory:', { dims: null }); await st2.migrate();
    const all = await startHub(st2, { ...hubConfigFromEnv({ HOST: '0.0.0.0' }), port: 0 }, silent);
    expect(all.host).toBe('0.0.0.0'); await all.close();
  });
  it('bad-key flood is throttled before hitting the store', async () => {
    const st = new SqliteHubStore(':memory:', { dims: null }); await st.migrate();
    await st.createUser('u'); const k = generateApiKey(); await st.createApiKey('u', 'l', k.hash);
    const late = generateApiKey(); await st.createApiKey('u', 'late', late.hash);
    let lookups = 0; const auth = st.authenticate.bind(st); st.authenticate = (h: string) => { lookups++; return auth(h); };
    const h = await startHub(st, { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000, trustProxy: true }, silent);
    const me = (key: string, ip = '10.0.0.1') => fetch(`http://127.0.0.1:${h.port}/v1/me`, { headers: { authorization: `Bearer ${key}`, 'x-forwarded-for': `6.6.6.6, ${ip}` } });
    expect((await me(k.raw)).status).toBe(200);
    const same = generateApiKey().raw; for (let i = 0; i < 40; i++) expect((await me(same)).status).toBe(401);
    expect(lookups).toBe(2);   // a repeated bad key is answered from the negative cache, and cache hits do not count as failures
    lookups = 0; const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await me(generateApiKey().raw)).status);
    expect(statuses.filter((x) => x === 401)).toHaveLength(29); expect(statuses.slice(29).every((x) => x === 429)).toBe(true);
    expect(lookups).toBe(29);   // 1 failure was counted already; nothing past the limit reached the store
    const t = await me(generateApiKey().raw); expect(t.status).toBe(429); expect(Number(t.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await t.json() as any).error.code).toBe('rate_limited');
    expect((await me(k.raw)).status).toBe(200);    // a key seen before keeps working for the flooding client
    expect((await me(late.raw)).status).toBe(429);  // trade-off: a key never seen from that client waits out the window
    expect((await me(late.raw, '10.0.0.2')).status).toBe(200);   // another client is not throttled by the flood
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`, { headers: { 'x-forwarded-for': '10.0.0.1' } })).status).toBe(200);
    await h.close();
  });
  it('without MEMHIVE_TRUST_PROXY a forged X-Forwarded-For does not dodge the throttle', async () => {
    const st = new SqliteHubStore(':memory:', { dims: null }); await st.migrate();
    const h = await startHub(st, { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000 }, silent);
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) statuses.push((await fetch(`http://127.0.0.1:${h.port}/v1/me`, { headers: { authorization: `Bearer ${generateApiKey().raw}`, 'x-forwarded-for': `10.1.0.${i}` } })).status);
    expect(statuses.at(-1)).toBe(429);
    await h.close();
  });
  it('an unparsable request URL gets 400 and the hub stays up', async () => {
    const st = new SqliteHubStore(':memory:', { dims: null }); await st.migrate();
    const h = await startHub(st, { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 2_000_000 }, silent);
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => { const r = request({ host: '127.0.0.1', port: h.port, path: '//', method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode!); }); r.on('error', reject); r.end(); });
    expect(status).toBe(400);
    expect((await fetch(`http://127.0.0.1:${h.port}/healthz`)).status).toBe(200);
    await h.close();
  });
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
    expect((await fetch(url, { method: 'POST', headers: { authorization: `Bearer mh_${'B'.repeat(43)}`, 'content-type': 'application/json' }, body: big })).status).toBe(401);   // well-formed but unknown: refused before the body is read
    await fetch(url, { method: 'POST', headers: { authorization: 'Bearer mh_secretwrongkey', 'content-type': 'application/json' }, body: '{}' });
    expect(JSON.stringify(logs)).not.toContain(key); expect(JSON.stringify(logs)).not.toContain('mh_secretwrongkey');
    await h.close();
  });
});
