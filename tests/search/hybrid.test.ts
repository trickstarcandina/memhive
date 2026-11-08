import { it, expect } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { hybridSearch } from '../../src/search/hybrid.js';
import { obs, sess } from '../store/store-contract.js';

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
