import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { HubClient } from '../../src/sync/client.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { obs, sess } from '../store/store-contract.js';

const hubUrl = 'http://127.0.0.1:9';
const engines: SyncEngine[] = [];
afterEach(() => {
  for (const e of engines.splice(0)) void e.close();
});
const page = (p: Record<string, unknown[]>, seq = 1) =>
  JSON.stringify({
    sessions: [],
    observations: [],
    summaries: [],
    tombstones: [],
    ...p,
    next_seq: seq,
    has_more: false,
    max_seq: seq,
  });

// A stub hub: /v1/config answers `config`, every pull answers the next queued page (then an empty one).
function setup(config: Record<string, unknown> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { [hubUrl]: { key: 'mh_' + 'A'.repeat(43), user: 'alice' } } });
  const store = new SqliteStore(':memory:', { dims: null });
  store.migrate();
  const a = store.getOrCreateProject('github.com/t/a', 'a');
  store.setProjectHub(a.id, hubUrl);
  const pages: string[] = [];
  const fetchImpl = (async (url: string) => {
    const u = String(url);
    if (u.includes('/v1/config'))
      return new Response(
        JSON.stringify({
          version: 'x',
          protocol: 2,
          embedding_model: null,
          embedding_dims: null,
          body_limit: 2_000_000,
          ...config,
        }),
        { status: 200 }
      );
    if (u.includes('/v1/sync/pull')) return new Response(pages.shift() ?? page({}, 0), { status: 200 });
    return new Response(JSON.stringify({ accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [] }), {
      status: 200,
    });
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
  return { store, project: store.getProject(a.id)!, engine, pages, warns };
}

describe('final review follow-ups (sync)', () => {
  it('m1: a hub body_limit lifts the response cap to 32 MB at most', async () => {
    const t = setup({ body_limit: 1e12 });
    const client = new HubClient(
      hubUrl,
      'k',
      (async () =>
        new Response(
          JSON.stringify({
            version: 'x',
            protocol: 2,
            embedding_model: null,
            embedding_dims: null,
            body_limit: 1e12,
          }),
          { status: 200 }
        )) as unknown as typeof fetch
    );
    await (t.engine as any).hubConfig(client, 'http://other');
    expect(client.maxBytes).toBe(32 * 1024 * 1024);
    const small = new HubClient(
      hubUrl,
      'k',
      (async () =>
        new Response(
          JSON.stringify({ version: 'x', protocol: 2, embedding_model: null, embedding_dims: null, body_limit: 1000 }),
          { status: 200 }
        )) as unknown as typeof fetch
    );
    await (t.engine as any).hubConfig(small, 'http://small');
    expect(small.maxBytes).toBe(4000); // an honest small limit still narrows it
  });

  it('m2: a pulled observation or summary whose session belongs to another project is quarantined', async () => {
    const t = setup();
    const b = t.store.getOrCreateProject('github.com/t/b', 'b');
    const sb = sess(b.id, { userId: 'alice' });
    t.store.upsertSession(sb);
    const planted = obs({ projectId: t.project.id, sessionId: sb.id, userId: 'mallory', title: 'planted' });
    const sum = {
      id: '01900000-0000-7000-8000-00000000abcd',
      sessionId: sb.id,
      userId: 'mallory',
      request: 'r',
      learned: 'l',
      completed: 'c',
      nextSteps: 'n',
      createdAt: new Date().toISOString(),
    };
    t.pages.push(page({ observations: [planted], summaries: [sum] }));
    await t.engine.pull(t.project, 1000);
    expect(t.store.getObservations([planted.id])).toEqual([]);
    expect(t.store.hasSummaries([sum.id]).size).toBe(0);
    const q = t.store.getSyncState(t.project.id).quarantined;
    expect(q).toBe(2);
  });

  it('m2: timeline stays inside the anchor project', () => {
    const t = setup();
    const b = t.store.getOrCreateProject('github.com/t/b', 'b');
    const sb = sess(b.id);
    t.store.upsertSession(sb);
    const theirs = obs({ projectId: b.id, sessionId: sb.id, title: 'project b', createdAt: '2026-01-01T00:00:00Z' });
    // a row of project A pointing at project B's session (an older client accepted these from a hub)
    const anchor = obs({ projectId: t.project.id, sessionId: sb.id, title: 'a', createdAt: '2026-01-02T00:00:00Z' });
    t.store.insertObservations([theirs, anchor]);
    expect(t.store.timeline(anchor.id, 5, 5).map((o) => o.id)).toEqual([anchor.id]);
  });

  it('m3: a pulled tombstone deletes hub rows only; local rows stay and one warning is logged', async () => {
    const t = setup();
    const mine = sess(t.project.id, { userId: 'alice' });
    t.store.upsertSession(mine);
    const myObs = obs({ projectId: t.project.id, sessionId: mine.id, userId: 'alice' });
    const theirSess = sess(t.project.id, { userId: 'bob', origin: 'hub', syncedAt: '2026-01-01T00:00:00Z' });
    t.store.upsertSession(theirSess);
    const theirObs = obs({
      projectId: t.project.id,
      sessionId: theirSess.id,
      userId: 'bob',
      origin: 'hub',
      syncedAt: '2026-01-01T00:00:00Z',
    });
    t.store.insertObservations([myObs, theirObs]);
    const at = new Date().toISOString();
    const tombs = [
      { id: myObs.id, tbl: 'observation', deleted_at: at },
      { id: mine.id, tbl: 'session', deleted_at: at },
      { id: theirObs.id, tbl: 'observation', deleted_at: at },
    ];
    t.pages.push(page({ tombstones: tombs }, 1), page({ tombstones: tombs }, 2));
    await t.engine.pull(t.project, 1000);
    await t.engine.pull(t.project, 1000);
    expect(t.store.getSession(mine.id)).not.toBeNull();
    expect(t.store.getObservations([myObs.id])).toHaveLength(1);
    expect(t.store.getObservations([theirObs.id])).toEqual([]);
    expect(t.store.listPendingTombstones(t.project.id, 10)).toEqual([]); // nothing queued for push either
    expect(t.warns.filter((w) => w.includes('local'))).toHaveLength(1);
    // the kept row is not hidden from a later pull or import of itself either
    expect(t.store.forgottenIds(t.project.id, 'observation', [myObs.id]).size).toBe(0);
  });

  it('m9: a row removed by retention is remembered, so a hub reset does not pull it back', async () => {
    const t = setup();
    const s = sess(t.project.id, { userId: 'bob', origin: 'hub', syncedAt: '2026-01-01T00:00:00Z' });
    t.store.upsertSession(s);
    const old = obs({
      projectId: t.project.id,
      sessionId: s.id,
      userId: 'bob',
      type: 'discovery',
      origin: 'hub',
      syncedAt: '2026-01-01T00:00:00Z',
      createdAt: '2020-01-01T00:00:00Z',
    });
    t.store.insertObservations([old]);
    expect(t.store.deleteExpired({ discovery: '2025-01-01T00:00:00Z' })).toBe(1);
    t.store.resetProjectSync(t.project.id); // what a hub reset does
    expect(t.store.listPendingTombstones(t.project.id, 10)).toEqual([]); // local only: never pushed, not even after a reset
    t.pages.push(page({ sessions: [{ ...s, cwd: '' }], observations: [old] }));
    await t.engine.pull(t.project, 1000);
    expect(t.store.getObservations([old.id])).toEqual([]);
  });
});
