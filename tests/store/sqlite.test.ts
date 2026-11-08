import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { storeContract, obs, sess } from './store-contract.js';

storeContract('sqlite', () => new SqliteStore(':memory:', { dims: 4 }));

describe('sqlite vector table lifecycle', () => {
  it('rebuilds the vec table and clears models when dims change', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'm.db');
    let s = new SqliteStore(file, { dims: 4 }); s.migrate();
    const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
    const o = obs({ projectId: p.id, sessionId: a.id }); s.insertObservations([o]);
    s.setObservationEmbedding(o.id, [1, 0, 0, 0], 'm4'); s.close();
    s = new SqliteStore(file, { dims: 2 }); s.migrate();
    expect(s.listMissingEmbedding(10).map((x) => x.id)).toEqual([o.id]);
    s.setObservationEmbedding(o.id, [1, 0], 'm2');
    expect(s.searchObservationsVector([1, 0], { projectId: p.id, limit: 1 })[0].id).toBe(o.id);
    s.close();
  });
  it('works without a vector table', () => {
    const s = new SqliteStore(':memory:', { dims: null }); s.migrate();
    const p = s.getOrCreateProject('k', 'n');
    expect(s.searchObservationsVector([1], { projectId: p.id, limit: 1 })).toEqual([]);
    s.close();
  });
});
