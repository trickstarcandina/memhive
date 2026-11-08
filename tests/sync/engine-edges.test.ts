import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SyncEngine } from '../../src/sync/engine.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { obs, sess } from '../store/store-contract.js';

const hubUrl = 'http://127.0.0.1:9';
const silent = { info() {}, warn() {}, error() {}, debug() {} };
afterEach(() => { vi.restoreAllMocks(); });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const config = { version: 'x', protocol: 1, embedding_model: null, embedding_dims: null, body_limit: 2_000_000 };
const empty = { sessions: [], observations: [], summaries: [] };

// Engine against a scripted hub: pull(since, call#) and push(call#) decide each answer.
function setup(h: { pull?: (since: number, n: number) => unknown; push?: (n: number) => Response | Promise<Response> }) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { [hubUrl]: { key: 'mh_' + 'A'.repeat(43), user: 'alice' } } });
  const store = new SqliteStore(':memory:', { dims: null }); store.migrate();
  const p = store.getOrCreateProject('github.com/t/edges', 'edges'); store.setProjectHub(p.id, hubUrl);
  const pulls: number[] = []; let pushes = 0;
  const fetchImpl = (async (url: string) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/config') return json(config);
    if (u.pathname === '/v1/sync/pull') { const since = Number(u.searchParams.get('since')); pulls.push(since); const r = h.pull!(since, pulls.length); if (r instanceof Error) throw r; return json(r); }
    pushes++; return h.push!(pushes);
  }) as unknown as typeof fetch;
  const engine = new SyncEngine({ store, home, logger: silent, embedDims: null, fetchImpl });
  return { store, project: store.getProject(p.id)!, engine, pulls, pushes: () => pushes };
}
const hubSess = () => ({ ...sess('x', { userId: 'bob' }), cwd: '' });
const hubObs = (sessionId: string) => ({ ...obs({ projectId: 'x', sessionId, userId: 'bob' }), embedding: null });

describe('pull edge cases', () => {
  it('has_more without progress stops after one page', async () => {
    const t = setup({ pull: (since) => ({ ...empty, next_seq: since, has_more: true, max_seq: 100 }) });
    t.store.setPullCursor(t.project.id, 7);
    await t.engine.pull(t.project, 2000);
    expect(t.pulls).toEqual([7]);
  });
  it('failure on page 2 keeps page 1 progress', async () => {
    const s = hubSess(); const o = hubObs(s.id);
    const t = setup({ pull: (since) => since === 0 ? { sessions: [s], observations: [o], summaries: [], next_seq: 5, has_more: true, max_seq: 10 } : new TypeError('fetch failed') });
    expect(await t.engine.pull(t.project, 2000)).toBe(2);
    expect(t.store.getPullCursor(t.project.id)).toBe(5);
    expect(t.store.getObservations([o.id])).toHaveLength(1);
    await t.engine.pull(t.project, 2000);
    expect(t.pulls).toEqual([0, 5, 5]);   // resumes from page 1's cursor
  });
  it('epoch flips mid-pagination: one reset, no duplicates, no second reset in the same call', async () => {
    const s = hubSess(); const a = hubObs(s.id); const b = hubObs(s.id);
    // call 1: old epoch, row a. Then the hub is recreated (e2) with a and b. Then it flips again (e3).
    const t = setup({ pull: (since, n) => {
      if (n === 1) return { sessions: [s], observations: [a], summaries: [], next_seq: 1, has_more: true, max_seq: 1, epoch: 'e1' };
      if (n === 2) return { ...empty, next_seq: 3, has_more: true, max_seq: 3, epoch: 'e2' };   // since=1 under a new epoch: reset
      if (n === 3) return { sessions: [s], observations: [a, b], summaries: [], next_seq: 2, has_more: true, max_seq: 3, epoch: 'e2' };
      return { ...empty, next_seq: since + 1, has_more: true, max_seq: 9, epoch: 'e3' };
    } });
    const reset = vi.spyOn(t.store, 'resetProjectSync');
    await t.engine.pull(t.project, 2000);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(t.pulls).toEqual([0, 1, 0, 2]);
    expect(t.store.listRecentObservations(t.project.id, 10).map((o) => o.id).sort()).toEqual([a.id, b.id].sort());
    expect(t.store.getHubEpoch(t.project.id)).toBe('e2');   // e3 not stored: the next pull resets for it
    await t.engine.pull(t.project, 2000);
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe('push failure backoff', () => {
  // Decision: a fetch that rejects (connection refused, DNS, timeout) backs off like a 5xx and keeps every row.
  it('push network error keeps rows and applies backoff', async () => {
    const t = setup({ push: () => { throw new TypeError('fetch failed'); } });
    const s = sess(t.project.id, { userId: 'alice' }); t.store.upsertSession(s);
    t.store.insertObservations([obs({ projectId: t.project.id, sessionId: s.id, userId: 'alice' })]);
    expect(await t.engine.push(t.project)).toBeNull();
    expect(await t.engine.push(t.project)).toBeNull();
    expect(t.pushes()).toBe(1);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(1);
    expect(t.store.getSyncState(t.project.id)).toMatchObject({ backoffMs: 30_000, lastError: expect.stringContaining('fetch failed') });
  });
  it.each([408, 429, 502, 503])('%i backs off on the ladder 30 s -> 600 s, rows kept', async (status) => {
    const t = setup({ push: () => json({ error: { code: 'x', message: 'busy' } }, status) });
    const s = sess(t.project.id, { userId: 'alice' }); t.store.upsertSession(s);
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const steps: number[] = [];
    for (let i = 0; i < 7; i++) {
      expect(await t.engine.push(t.project)).toBeNull();
      const st = t.store.getSyncState(t.project.id); steps.push(st.backoffMs!);
      expect(st.backoffUntil).toBe(now + st.backoffMs!);
      expect(await t.engine.push(t.project)).toBeNull();   // inside the window: no request
      now = st.backoffUntil! + 1;
    }
    expect(steps.map((ms) => ms / 1000)).toEqual([30, 60, 120, 240, 480, 600, 600]);
    expect(t.pushes()).toBe(7);
    expect(t.store.listUnsynced('sessions', t.project.id, 10)).toHaveLength(1);
  });
});

