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
afterEach(() => {
  vi.restoreAllMocks();
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const config = { version: 'x', protocol: 1, embedding_model: null, embedding_dims: null, body_limit: 2_000_000 };
const empty = { sessions: [], observations: [], summaries: [] };

// Engine against a scripted hub: pull(since, call#) and push(call#) decide each answer.
function setup(h: {
  pull?: (since: number, n: number, limit: number) => unknown;
  push?: (n: number, body: any) => Response | Promise<Response>;
  config?: Record<string, unknown>;
}) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { [hubUrl]: { key: 'mh_' + 'A'.repeat(43), user: 'alice' } } });
  const store = new SqliteStore(':memory:', { dims: null });
  store.migrate();
  const p = store.getOrCreateProject('github.com/t/edges', 'edges');
  store.setProjectHub(p.id, hubUrl);
  const pulls: number[] = [];
  const limits: number[] = [];
  let pushes = 0;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const u = new URL(String(url));
    if (u.pathname === '/v1/config') return json(h.config ?? config);
    if (u.pathname === '/v1/sync/pull') {
      const since = Number(u.searchParams.get('since'));
      const limit = Number(u.searchParams.get('limit'));
      pulls.push(since);
      limits.push(limit);
      const r = h.pull!(since, pulls.length, limit);
      if (r instanceof Error) throw r;
      return r instanceof Response ? r : json(r);
    }
    pushes++;
    return h.push!(pushes, JSON.parse(String(init?.body)));
  }) as unknown as typeof fetch;
  const engine = new SyncEngine({ store, home, logger: silent, embedDims: null, fetchImpl });
  return { home, store, project: store.getProject(p.id)!, engine, pulls, limits, pushes: () => pushes, fetchImpl };
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
    const s = hubSess();
    const o = hubObs(s.id);
    const t = setup({
      pull: (since) =>
        since === 0
          ? { sessions: [s], observations: [o], summaries: [], next_seq: 5, has_more: true, max_seq: 10 }
          : new TypeError('fetch failed'),
    });
    expect(await t.engine.pull(t.project, 2000)).toBe(2);
    expect(t.store.getPullCursor(t.project.id)).toBe(5);
    expect(t.store.getObservations([o.id])).toHaveLength(1);
    await t.engine.pull(t.project, 2000);
    expect(t.pulls).toEqual([0, 5, 5]); // resumes from page 1's cursor
  });
  it('epoch flips mid-pagination: one reset, no duplicates, no second reset in the same call', async () => {
    const s = hubSess();
    const a = hubObs(s.id);
    const b = hubObs(s.id);
    // call 1: old epoch, row a. Then the hub is recreated (e2) with a and b. Then it flips again (e3).
    const t = setup({
      pull: (since, n) => {
        if (n === 1)
          return {
            sessions: [s],
            observations: [a],
            summaries: [],
            next_seq: 1,
            has_more: true,
            max_seq: 1,
            epoch: 'e1',
          };
        if (n === 2) return { ...empty, next_seq: 3, has_more: true, max_seq: 3, epoch: 'e2' }; // since=1 under a new epoch: reset
        if (n === 3)
          return {
            sessions: [s],
            observations: [a, b],
            summaries: [],
            next_seq: 2,
            has_more: true,
            max_seq: 3,
            epoch: 'e2',
          };
        return { ...empty, next_seq: since + 1, has_more: true, max_seq: 9, epoch: 'e3' };
      },
    });
    const reset = vi.spyOn(t.store, 'resetProjectSync');
    await t.engine.pull(t.project, 2000);
    expect(reset).toHaveBeenCalledTimes(1);
    expect(t.pulls).toEqual([0, 1, 0, 2]);
    expect(
      t.store
        .listRecentObservations(t.project.id, 10)
        .map((o) => o.id)
        .sort()
    ).toEqual([a.id, b.id].sort());
    expect(t.store.getHubEpoch(t.project.id)).toBe('e2'); // e3 not stored: the next pull resets for it
    await t.engine.pull(t.project, 2000);
    expect(reset).toHaveBeenCalledTimes(2);
  });
});

describe('push failure backoff', () => {
  // Decision: a fetch that rejects (connection refused, DNS, timeout) backs off like a 5xx and keeps every row.
  it('push network error keeps rows and applies backoff', async () => {
    const t = setup({
      push: () => {
        throw new TypeError('fetch failed');
      },
    });
    const s = sess(t.project.id, { userId: 'alice' });
    t.store.upsertSession(s);
    t.store.insertObservations([obs({ projectId: t.project.id, sessionId: s.id, userId: 'alice' })]);
    expect(await t.engine.push(t.project)).toBeNull();
    expect(await t.engine.push(t.project)).toBeNull();
    expect(t.pushes()).toBe(1);
    expect(t.store.listUnsynced('observations', t.project.id, 10)).toHaveLength(1);
    expect(t.store.getSyncState(t.project.id)).toMatchObject({
      backoffMs: 30_000,
      lastError: expect.stringContaining('fetch failed'),
    });
  });
  it.each([408, 429, 502, 503])('%i backs off on the ladder 30 s -> 600 s, rows kept', async (status) => {
    const t = setup({ push: () => json({ error: { code: 'x', message: 'busy' } }, status) });
    const s = sess(t.project.id, { userId: 'alice' });
    t.store.upsertSession(s);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const steps: number[] = [];
    for (let i = 0; i < 7; i++) {
      expect(await t.engine.push(t.project)).toBeNull();
      const st = t.store.getSyncState(t.project.id);
      steps.push(st.backoffMs!);
      expect(st.backoffUntil).toBe(now + st.backoffMs!);
      expect(await t.engine.push(t.project)).toBeNull(); // inside the window: no request
      now = st.backoffUntil! + 1;
    }
    expect(steps.map((ms) => ms / 1000)).toEqual([30, 60, 120, 240, 480, 600, 600]);
    expect(t.pushes()).toBe(7);
    expect(t.store.listUnsynced('sessions', t.project.id, 10)).toHaveLength(1);
  });
});

describe('review follow-ups', () => {
  it('an oversized pull response halves the limit within the call; nothing is stored until a page fits', async () => {
    const s = hubSess();
    const o = hubObs(s.id);
    // a 0.1-style hub: ignores the byte budget, so only a small limit gives a page under 4 x body_limit (4000 bytes)
    const t = setup({
      config: { ...config, body_limit: 1000 },
      pull: (_since, _n, limit) =>
        limit > 100
          ? { ...empty, pad: 'x'.repeat(5000), next_seq: 9, has_more: false, max_seq: 9 }
          : { sessions: [s], observations: [o], summaries: [], next_seq: 9, has_more: false, max_seq: 9 },
    });
    expect(await t.engine.pull(t.project, 2000)).toBe(2);
    expect(t.limits).toEqual([500, 250, 125, 62]);
    expect(t.store.getPullCursor(t.project.id)).toBe(9);
    expect(t.store.getSyncState(t.project.id)).toMatchObject({ backoffUntil: null, lastError: null });
  });
  it('still oversized at the floor of 25 rows: backs off, cursor kept', async () => {
    const t = setup({
      config: { ...config, body_limit: 1000 },
      pull: () => ({ ...empty, pad: 'x'.repeat(5000), next_seq: 9, has_more: false, max_seq: 9 }),
    });
    expect(await t.engine.pull(t.project, 2000)).toBe(0);
    expect(t.limits).toEqual([500, 250, 125, 62, 31, 25]);
    expect(t.store.getPullCursor(t.project.id)).toBe(0);
    expect(t.store.getSyncState(t.project.id)).toMatchObject({
      backoffMs: 30_000,
      lastError: expect.stringContaining('response'),
    });
  });
  it('a malformed pulled row is quarantined; the other rows and the cursor apply', async () => {
    const s = hubSess();
    const good = hubObs(s.id);
    const badType = { ...hubObs(s.id), type: 'brand-new-type' };
    const badId = { ...hubObs(s.id), id: 'x'.repeat(300) };
    const badDate = { ...hubObs(s.id), createdAt: 'yesterday' };
    const orphan = hubObs('0f0f0f0f-0000-4000-8000-000000000000');
    const t = setup({
      pull: () => ({
        sessions: [s],
        observations: [good, badType, badId, badDate, orphan],
        summaries: [],
        next_seq: 4,
        has_more: false,
        max_seq: 4,
      }),
    });
    expect(await t.engine.pull(t.project, 2000)).toBe(2);
    expect(t.store.getObservations([good.id])).toHaveLength(1);
    expect(t.store.getPullCursor(t.project.id)).toBe(4);
    expect(t.store.getSyncState(t.project.id).quarantined).toBe(4);
    const q = t.store.listQuarantine(t.project.id, 10);
    expect(q.map((r) => r.reason).sort()).toEqual(
      ['malformed: createdAt', 'malformed: id', 'malformed: type', 'unknown session'].sort()
    );
    expect(JSON.parse(q.find((r) => r.reason === 'malformed: type')!.raw)).toMatchObject({
      id: badType.id,
      type: 'brand-new-type',
    });
    expect(q.every((r) => r.seq === 4 && r.tbl === 'observations')).toBe(true);
  });
  it('quarantined raw rows are stored with secrets redacted, still as JSON', async () => {
    const s = hubSess();
    const key = 'sk-ant-api03-' + 'Q'.repeat(40);
    const bad = {
      ...hubObs(s.id),
      type: 'brand-new-type',
      title: `leaked ${key}`,
      facts: [`token=${'z'.repeat(24)}`],
      extra: { nested: `password = "${'p'.repeat(12)}"` },
    };
    const t = setup({
      pull: () => ({ sessions: [s], observations: [bad], summaries: [], next_seq: 2, has_more: false, max_seq: 2 }),
    });
    await t.engine.pull(t.project, 2000);
    const [q] = t.store.listQuarantine(t.project.id, 10);
    expect(q.raw).not.toContain('Q'.repeat(40));
    expect(q.raw).not.toContain('z'.repeat(24));
    expect(q.raw).not.toContain('p'.repeat(12));
    expect(JSON.parse(q.raw)).toMatchObject({ id: bad.id, type: 'brand-new-type' });
  });
  it('the quarantine keeps the newest 1000 rows per project', () => {
    const t = setup({});
    t.store.quarantine(
      t.project.id,
      Array.from({ length: 1005 }, (_, i) => ({
        id: 'r' + i,
        tbl: 'observations' as const,
        seq: i,
        reason: 'x',
        raw: '{}',
      }))
    );
    expect(t.store.getSyncState(t.project.id).quarantined).toBe(1000);
    expect(t.store.listQuarantine(t.project.id, 1)[0].id).toBe('r1004');
    expect(t.store.listQuarantine(t.project.id, 1000).some((r) => r.id === 'r4')).toBe(false);
  });
  it('a SQLite error other than a constraint aborts the page: nothing applied, cursor kept, backoff', async () => {
    const s = hubSess();
    const o = hubObs(s.id);
    const t = setup({
      pull: () => ({ sessions: [s], observations: [o], summaries: [], next_seq: 4, has_more: false, max_seq: 4 }),
    });
    vi.spyOn(t.store, 'insertObservations').mockImplementation(() => {
      throw Object.assign(new Error('database or disk is full'), { code: 'SQLITE_FULL' });
    });
    expect(await t.engine.pull(t.project, 2000)).toBe(0);
    expect(t.store.getPullCursor(t.project.id)).toBe(0);
    expect(t.store.getSession(s.id)).toBeNull(); // rolled back with the page
    expect(t.store.getSyncState(t.project.id)).toMatchObject({ quarantined: 0, backoffMs: 30_000 });
  });
  it('pulled userId is redacted, stripped of control characters and capped', async () => {
    const s = { ...hubSess(), userId: '\u001b[31m' + 'u'.repeat(500) };
    const t = setup({
      pull: () => ({ sessions: [s], observations: [], summaries: [], next_seq: 1, has_more: false, max_seq: 1 }),
    });
    await t.engine.pull(t.project, 2000);
    const got = t.store.getSession(s.id)!.userId;
    expect(got.length).toBe(200);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
    expect(got).not.toMatch(/[\u0000-\u001f]/);
  });
  it('last_error is cleared by the next success and carries last_error_at', async () => {
    let fail = true;
    const t = setup({
      pull: () => (fail ? new TypeError('fetch failed') : { ...empty, next_seq: 1, has_more: false, max_seq: 1 }),
    });
    await t.engine.pull(t.project, 2000);
    expect(t.store.getSyncState(t.project.id)).toMatchObject({
      lastError: expect.stringContaining('fetch failed'),
      lastErrorAt: expect.any(Number),
    });
    fail = false;
    await t.engine.pull(t.project, 2000);
    expect(t.store.getSyncState(t.project.id)).toMatchObject({ lastError: null, lastErrorAt: null });
  });
  it('rows a hub keeps refusing for size: skipped after 5 tries (rows behind them go), given up after 20', async () => {
    const t = setup({
      push: (_n, b) =>
        json({
          accepted: { sessions: b.sessions.length, observations: 0, summaries: 0 },
          rejected: b.observations
            .filter((o: any) => o.title.startsWith('BIG'))
            .map((o: any) => ({ id: o.id, reason: 'invalid_row', field: 'narrative' })),
        }),
    });
    const s = sess(t.project.id, { userId: 'alice' });
    t.store.upsertSession(s);
    t.store.markSynced('sessions', [s.id], 'x');
    const big = Array.from({ length: 200 }, (_, i) =>
      obs({ projectId: t.project.id, sessionId: s.id, userId: 'alice', title: 'BIG ' + i })
    );
    const ok = obs({ projectId: t.project.id, sessionId: s.id, userId: 'alice', title: 'ok' });
    t.store.insertObservations([...big, ok]);
    for (let i = 0; i < 5; i++) await t.engine.push(t.project);
    expect(t.store.getObservations([ok.id])[0].syncedAt).toBeNull(); // starved behind 200 refused rows
    await t.engine.push(t.project);
    expect(t.store.getObservations([ok.id])[0].syncedAt).not.toBeNull();
    expect(t.store.listUnsynced('observations', t.project.id, 500)).toHaveLength(200);
    // past 5 tries a new process (daemon restart) tries once more, then skips them again; 20 tries in total give them up
    let last: Awaited<ReturnType<SyncEngine['push']>> | undefined;
    for (let r = 0; r < 15; r++) {
      const e = new SyncEngine({
        store: t.store,
        home: t.home,
        logger: silent,
        embedDims: null,
        fetchImpl: t.fetchImpl,
      });
      for (let i = 0; i < 2; i++) {
        const r2 = await e.push(t.project);
        if (r2?.rejected.length) last = r2;
      }
      if (r < 14) expect(t.store.listUnsynced('observations', t.project.id, 500)).toHaveLength(200);
    }
    expect(t.store.listUnsynced('observations', t.project.id, 500)).toHaveLength(0);
    expect(last!.rejected.filter((x) => x.reason === 'given_up')).toHaveLength(200);
  });
  it('close() waits at most 10 s for a hung background pull; the config fetch counts against the pull deadline', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      // a hub that never answers and ignores aborts
      const t = setup({ pull: () => new Promise(() => {}) as never });
      (t.engine as unknown as { deps: { fetchImpl: typeof fetch } }).deps.fetchImpl = (() =>
        new Promise(() => {})) as unknown as typeof fetch;
      t.store.setPullCursor(t.project.id, 1);
      await t.engine.startPull(t.project);
      let closed = false;
      const c = t.engine.close().then(() => {
        closed = true;
      });
      await vi.advanceTimersByTimeAsync(9_900);
      expect(closed).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      await c;
      expect(closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
