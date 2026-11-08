import { it, expect } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { hybridSearch } from '../../src/search/hybrid.js';
import { obs, sess } from '../store/store-contract.js';
import { formatFull, formatIndex } from '../../src/mcp/format.js';

it('merges fts and vector hits; falls back to fts without embedder', async () => {
  const s = new SqliteStore(':memory:', { dims: 2 }); s.migrate();
  const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
  const o1 = obs({ projectId: p.id, sessionId: a.id, title: 'JWT expiry bug' });
  const o2 = obs({ projectId: p.id, sessionId: a.id, title: 'Postgres chosen' });
  s.insertObservations([o1, o2]);
  s.setObservationEmbedding(o1.id, [0, 1], 'm'); s.setObservationEmbedding(o2.id, [1, 0], 'm');
  const embedder = { model: 'm', dims: 2, embed: async () => [[1, 0]] };
  const r = await hybridSearch(s, embedder, 'jwt', { projectId: p.id, limit: 10 });
  expect(r.map((o) => o.id).sort()).toEqual([o1.id, o2.id].sort());
  const r2 = await hybridSearch(s, null, 'jwt', { projectId: p.id, limit: 10 });
  expect(r2.map((o) => o.id)).toEqual([o1.id]);
  const r3 = await hybridSearch(s, { ...embedder, embed: async () => { throw new Error('down'); } }, 'jwt', { projectId: p.id, limit: 10 });
  expect(r3.map((o) => o.id)).toEqual([o1.id]);
  s.close();
});

it('fuses session summaries as a third list; results carry kind; a type filter leaves summaries out', async () => {
  const s = new SqliteStore(':memory:', { dims: null }); s.migrate();
  const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
  const o = obs({ projectId: p.id, sessionId: a.id, title: 'Redis cache warmed at boot', type: 'decision' });
  s.insertObservations([o]);
  s.insertSummaries([{ id: '0190aaaa-bbbb-7ccc-8ddd-eeee5ab5ab5a', projectId: p.id, sessionId: a.id, userId: 'local', request: 'speed up redis startup', learned: 'redis warm-up takes 4 s', completed: '', nextSteps: 'measure', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null }]);
  const r = await hybridSearch(s, null, 'redis', { projectId: p.id, limit: 10 });
  expect(r.map((x) => x.kind).sort()).toEqual(['observation', 'summary']);
  expect((await hybridSearch(s, null, 'redis', { projectId: p.id, type: 'decision', limit: 10 })).map((x) => x.kind)).toEqual(['observation']);
  const idx = formatIndex(r);
  expect(idx).toMatch(/\| #5ab5ab5a \| .* \| session-summary \| speed up redis startup \|/);
  const full = formatFull([], s.getSummaries(['0190aaaa-bbbb-7ccc-8ddd-eeee5ab5ab5a']));
  expect(full).toContain('session-summary · speed up redis startup'); expect(full).toContain('Learned: redis warm-up takes 4 s'); expect(full).toContain('Next steps: measure');
  expect(s.resolveSummaryIdPrefix('5ab5ab5a')).toBe('0190aaaa-bbbb-7ccc-8ddd-eeee5ab5ab5a');
  s.close();
});
