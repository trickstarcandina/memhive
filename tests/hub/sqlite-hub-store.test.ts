import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { hubStoreContract } from './hub-store-contract.js';
hubStoreContract('sqlite', async () => new SqliteHubStore(':memory:', { dims: 4 }));

import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hobs, hsess } from './hub-store-contract.js';

describe('sqlite hub dims guard', () => {
  const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'mh-hubdims-')), 'hub.db');
  it('refuses to start when dims differ', async () => {
    const f = file(); const s = new SqliteHubStore(f, { dims: 4 }); await s.migrate(); await s.close();
    const other = new SqliteHubStore(f, { dims: 8 });
    await expect(other.migrate()).rejects.toThrow('hub embedding dims is 4 in the database but MEMHIVE_EMBED_DIMS=8; set MEMHIVE_EMBED_DIMS=4 or run "memhive serve --reset-vectors"');
    await other.close();
    const again = new SqliteHubStore(f, { dims: 4 }); await again.migrate(); await again.close();
  });
  it('--reset-vectors recreates the column', async () => {
    const f = file(); const s = new SqliteHubStore(f, { dims: 4 }); await s.migrate();
    const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
    const o = hobs({ projectId: p.id, sessionId: a.id, embedding: [1, 0, 0, 0], embeddingModel: 'm' }); await s.insertObservations([o]); await s.close();
    const r = new SqliteHubStore(f, { dims: 8, resetVectors: true }); await r.migrate();
    expect((await r.getObservations([o.id]))[0]).toMatchObject({ embedding: null, embeddingModel: null });
    await r.close();
    const db = new Database(f); expect((db.prepare(`SELECT value FROM hub_meta WHERE key = 'embedding_dims'`).get() as any).value).toBe('8'); db.close();
    const later = new SqliteHubStore(f, { dims: 8 }); await later.migrate(); await later.close();
  });
  it('a database from before hub_meta is judged by a stored vector', async () => {
    const f = file(); const s = new SqliteHubStore(f, { dims: 4 }); await s.migrate();
    const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
    await s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, embedding: [1, 0, 0, 0], embeddingModel: 'm' })]); await s.close();
    const db = new Database(f); db.exec(`DELETE FROM hub_meta`); db.close();
    const other = new SqliteHubStore(f, { dims: 8 }); await expect(other.migrate()).rejects.toThrow(/dims is 4 in the database/); await other.close();
  });
});

it('sqlite hub indexes sessions and summaries by project', async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'mh-hubidx-')), 'hub.db'); const s = new SqliteHubStore(f, { dims: null }); await s.migrate(); await s.close();
  const db = new Database(f); const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`).all() as any[]).map((r) => r.name); db.close();
  expect(names).toEqual(expect.arrayContaining(['summaries_project', 'sessions_project', 'sync_log_project']));
});
