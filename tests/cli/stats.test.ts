import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { statsCommand } from '../../src/cli/commands/stats.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { obs, sess } from '../store/store-contract.js';
import { deadUrl } from '../helpers/closed-port.js';

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
const io = () => { let out = ''; return { io: { stdout: (s: string) => { out += s; }, stderr: () => {} }, text: () => out }; };

describe('memhive stats', () => {
  it('counts per project, type and origin; --project narrows; --json is the route shape', async () => {
    const home = mkHome();
    const ctx = createDaemonContext(home, env);
    const a = ctx.store.getOrCreateProject('github.com/acme/app', 'app'); ctx.store.setProjectHub(a.id, 'https://hub.example.com');
    const b = ctx.store.getOrCreateProject('github.com/acme/lib', 'lib');
    const sa = sess(a.id); ctx.store.upsertSession(sa); const sb = sess(b.id); ctx.store.upsertSession(sb);
    ctx.store.insertObservations([
      obs({ projectId: a.id, sessionId: sa.id, type: 'bugfix' }), obs({ projectId: a.id, sessionId: sa.id, type: 'bugfix', userId: 'bob', origin: 'hub', syncedAt: 'x' }),
      obs({ projectId: a.id, sessionId: sa.id, type: 'decision' }), obs({ projectId: b.id, sessionId: sb.id }),
    ]);
    ctx.store.setPinned(ctx.store.listRecentObservations(a.id, 1)[0].id, true);
    ctx.store.insertSummaries([{ id: 'sum-1', projectId: a.id, sessionId: sa.id, userId: 'local', request: 'r', learned: '', completed: '', nextSteps: '', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null }]);
    ctx.store.updateSyncState(a.id, { lastPushAt: Date.parse('2026-11-01T00:00:00Z') });
    ctx.observer.counters.calls = 5; ctx.observer.counters.failures = 2;
    const h = await startDaemon(ctx, { port: 0 });
    try {
      let r = io(); expect(await statsCommand([], r.io, { home })).toBe(0);
      expect(r.text()).toMatch(/^database \d+\.\d MB\n/);
      expect(r.text()).toContain('github.com/acme/app (linked to https://hub.example.com): 3 observations (2 own, 1 team), 1 sessions, 1 summaries, 1 pinned');
      expect(r.text()).toContain('  by type: bugfix 2, decision 1');
      expect(r.text()).toContain('  last push 2026-11-01T00:00:00.000Z, last pull never');
      expect(r.text()).toContain('github.com/acme/lib: 1 observations (1 own, 0 team)');
      expect(r.text()).toMatch(/observer since daemon start \(.*\): 5 provider calls, 2 failed/);
      r = io(); expect(await statsCommand(['--project', 'github.com/acme/lib', '--json'], r.io, { home })).toBe(0);
      const j = JSON.parse(r.text());
      expect(j.db_bytes).toBeGreaterThan(0);
      expect(j.projects).toHaveLength(1);
      expect(j.projects[0]).toMatchObject({ key: 'github.com/acme/lib', observations: { local: 1, hub: 0 }, byType: { discovery: 1 }, unsynced: { observations: 1 }, missingEmbedding: 1 });
      expect(j.observer).toMatchObject({ calls: 5, failures: 2 });
      r = io(); await statsCommand(['--project', 'nope'], r.io, { home });
      expect(r.text()).toContain('no project nope');
    } finally { await h.close(); }
  });
});
