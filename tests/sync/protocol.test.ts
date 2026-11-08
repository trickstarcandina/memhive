import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { handleRoute } from '../../src/daemon/routes.js';
import type { DaemonContext } from '../../src/daemon/context.js';
import { obs, sess } from '../store/store-contract.js';

const hubUrl = 'http://127.0.0.1:9';
function setup(config: Record<string, unknown>) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { [hubUrl]: { key: 'mh_' + 'A'.repeat(43), user: 'alice' } } });
  const store = new SqliteStore(':memory:', { dims: null });
  store.migrate();
  const p = store.getOrCreateProject('github.com/t/proto', 'proto');
  store.setProjectHub(p.id, hubUrl);
  const s = sess(p.id, { userId: 'alice', cwd: '/home/alice/secret-client/app', branch: 'acme-ticket-42' });
  store.upsertSession(s);
  store.insertObservations([obs({ projectId: p.id, sessionId: s.id, userId: 'alice' })]);
  const bodies: any[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/v1/config')) return new Response(JSON.stringify(config), { status: 200 });
    if (u.endsWith('/v1/sync/push')) {
      const b = JSON.parse(String(init!.body));
      bodies.push(b);
      return new Response(
        JSON.stringify({
          accepted: { sessions: b.sessions.length, observations: b.observations.length, summaries: b.summaries.length },
          rejected: [],
        }),
        { status: 200 }
      );
    }
    return new Response(
      JSON.stringify({ sessions: [], observations: [], summaries: [], next_seq: 0, has_more: false, max_seq: 0 }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  const warns: string[] = [];
  const engine = new SyncEngine({
    store,
    home,
    logger: {
      info() {},
      debug() {},
      error() {},
      warn(m: string) {
        warns.push(m);
      },
    },
    embedDims: null,
    fetchImpl,
  });
  return { store, project: store.getProject(p.id)!, engine, bodies, urls, warns };
}
const base = { version: 'x', embedding_model: null, embedding_dims: null, body_limit: 2_000_000 };

describe('hub protocol', () => {
  it('a hub with a newer protocol: no push or pull, hub_protocol error in sync output and status', async () => {
    const t = setup({ ...base, protocol: 3 });
    const r = await t.engine.syncNow(t.project);
    expect(r.pushed).toBeNull();
    expect(r.pulled).toBe(0);
    expect(r.error).toMatch(/^hub_protocol: .*protocol 3.*upgrade memhive/);
    expect(t.urls.filter((u) => !u.endsWith('/v1/config'))).toEqual([]);
    const ctx = {
      store: t.store,
      sync: t.engine,
      observer: { authFailed: false },
      pausedUntil: () => null,
    } as unknown as DaemonContext;
    const st = (await handleRoute(ctx, 'GET', new URL('http://x/v1/status'), undefined)).body as {
      hubErrors: Array<{ hub: string; error: string }>;
    };
    expect(st.hubErrors).toEqual([{ hub: hubUrl, error: expect.stringContaining('hub_protocol') }]);
  });
  it.each([
    ['missing', {}],
    ['lower', { protocol: 0 }],
  ])('a hub with a %s protocol: warn once, sync goes on', async (_n, extra) => {
    const t = setup({ ...base, ...extra });
    const r = await t.engine.syncNow(t.project);
    expect(r.error).toBeUndefined();
    expect(r.pushed!.accepted.observations).toBe(1);
    await t.engine.syncNow(t.project);
    expect(t.warns.filter((w) => w.includes('older than this client'))).toHaveLength(1);
    expect(t.engine.hubErrors()).toEqual([]);
  });
  it('push bodies never carry the local cwd, branch or local bookkeeping', async () => {
    const t = setup({ ...base, protocol: 1 });
    const [o] = t.store.listRecentObservations(t.project.id, 1);
    t.store.setPinned(o.id, true);
    t.store.bumpSeen(o.id, new Date().toISOString());
    await t.engine.push(t.project);
    expect(t.bodies[0].sessions).toHaveLength(1);
    expect(t.bodies[0].sessions[0].cwd).toBe(''); // present but empty: protocol 1 hubs require the field
    expect(t.bodies[0].sessions[0]).not.toHaveProperty('branch');
    expect(JSON.stringify(t.bodies)).not.toContain('acme-ticket');
    for (const k of ['pinned', 'seenCount', 'lastSeenAt']) expect(t.bodies[0].observations[0]).not.toHaveProperty(k);
    expect(t.store.getSession(t.bodies[0].sessions[0].id)!.branch).toBe('acme-ticket-42');
    expect(JSON.stringify(t.bodies)).not.toContain('secret-client');
    expect(t.store.getSession(t.bodies[0].sessions[0].id)!.cwd).toBe('/home/alice/secret-client/app'); // kept locally
  });
  it('a push passes the 0.1.2 hub session check (protocol 1 hubs require a string cwd)', async () => {
    // Copied from the 0.1.2 hub (src/hub/routes.ts, /v1/sync/push): a session failing it was rejected as invalid_row,
    // and every observation under it as unknown_session.
    const isStr = (v: unknown) => typeof v === 'string';
    const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));
    const t = setup({ ...base, protocol: 1 });
    await t.engine.push(t.project);
    const [s] = t.bodies[0].sessions;
    expect(
      [s.host, s.hostSessionId, s.cwd].every(isStr) && isIso(s.startedAt) && (s.endedAt == null || isIso(s.endedAt))
    ).toBe(true);
  });
});
