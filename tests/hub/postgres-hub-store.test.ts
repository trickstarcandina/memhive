import { describe, it, expect } from 'vitest';
import { PostgresHubStore } from '../../src/hub/store/postgres.js';
import { hubPgMigrations } from '../../src/hub/store/migrations-pg.js';
import { hubStoreContract } from './hub-store-contract.js';
import { Pool } from 'pg';

describe('dims validation', () => {
  it('rejects non-integer, out-of-range and injected dims', () => {
    for (const bad of [0, -1, 1.5, 16001, NaN, '4); DROP TABLE x; --' as unknown as number]) {
      expect(() => hubPgMigrations(bad)).toThrow(/invalid embedding dims/);
      expect(() => new PostgresHubStore('postgres://x@127.0.0.1:1/x', { dims: bad })).toThrow(/invalid embedding dims/);
    }
    expect(() => hubPgMigrations(null)).not.toThrow();
    expect(() => hubPgMigrations(1536)).not.toThrow();
  });
});

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  describe.skip('postgres hub store (set TEST_DATABASE_URL to run)', () => { it('skipped', () => {}); });
} else {
  // the suite drops the public schema: only allow throwaway databases
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!dbName.includes('test') && !process.env.CI) throw new Error(`refusing to DROP SCHEMA on database "${dbName}": name must contain "test" (or set CI)`);
  const open = (dims: number | null) => async () => {
    const pool = new Pool({ connectionString: url });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;');
    await pool.end();
    return new PostgresHubStore(url, { dims });
  };
  hubStoreContract('postgres', open(4));
  hubStoreContract('postgres (dims null, real[])', open(null), { dims: null });

  describe('postgres specifics', () => {
    it('concurrent pushes to one project keep the log gap-free and ordered', async () => {
      const s = await open(4)(); await s.migrate();
      const { hsess, hobs } = await import('./hub-store-contract.js');
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      await Promise.all(Array.from({ length: 20 }, (_, i) => s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, title: 't' + i })])));
      const log = await s.listSyncLog(p.id, 0, 100);
      expect(log).toHaveLength(21);
      expect(log.map((e) => e.seq)).toEqual([...log.map((e) => e.seq)].sort((x, y) => x - y));
      await s.close();
    });
    it('refuses to start when dims differ', async () => {
      const s = await open(4)(); await s.migrate(); await s.close();
      const other = new PostgresHubStore(url, { dims: 8 });
      await expect(other.migrate()).rejects.toThrow('hub embedding dims is 4 in the database but MEMHIVE_EMBED_DIMS=8; set MEMHIVE_EMBED_DIMS=4 or run "memhive serve --reset-vectors"');
      await other.close();
      const none = new PostgresHubStore(url, { dims: null });
      await expect(none.migrate()).rejects.toThrow(/dims is 4 in the database but MEMHIVE_EMBED_DIMS=;/);
      await none.close();
      const same = new PostgresHubStore(url, { dims: 4, resetVectors: true }); await same.migrate();   // no conflict: reset is a no-op
      const pool = new Pool({ connectionString: url });
      expect((await pool.query(`SELECT value FROM hub_meta WHERE key = 'embedding_dims'`)).rows[0].value).toBe('4');
      await pool.end(); await same.close();
    });
    it('--reset-vectors recreates the column', async () => {
      const { hsess, hobs } = await import('./hub-store-contract.js');
      const s = await open(4)(); await s.migrate();
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      const o = hobs({ projectId: p.id, sessionId: a.id, embedding: [1, 0, 0, 0], embeddingModel: 'm' }); await s.insertObservations([o]); await s.close();
      const r = new PostgresHubStore(url, { dims: 8, resetVectors: true }); await r.migrate();
      const pool = new Pool({ connectionString: url });
      const typ = async () => (await pool.query(`SELECT format_type(atttypid, atttypmod) t FROM pg_attribute WHERE attrelid = 'observations'::regclass AND attname = 'embedding'`)).rows[0].t;
      expect(await typ()).toBe('vector(8)');
      expect((await pool.query(`SELECT value FROM hub_meta WHERE key = 'embedding_dims'`)).rows[0].value).toBe('8');
      expect((await r.getObservations([o.id]))[0]).toMatchObject({ title: o.title, embedding: null, embeddingModel: null });
      const o8 = hobs({ projectId: p.id, sessionId: a.id, embedding: [1, 0, 0, 0, 0, 0, 0, 1], embeddingModel: 'm' });
      expect(await r.insertObservations([o8])).toEqual([o8.id]); await r.close();
      const again = new PostgresHubStore(url, { dims: 8 }); await again.migrate(); await again.close();   // later starts accept the new dims
      const toNull = new PostgresHubStore(url, { dims: null, resetVectors: true }); await toNull.migrate(); await toNull.close();
      expect(await typ()).toBe('real[]');
      await pool.end();
    });
    it('indexes sessions and summaries by project', async () => {
      const s = await open(4)(); await s.migrate(); await s.close();
      const pool = new Pool({ connectionString: url });
      const names = (await pool.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`)).rows.map((r) => r.indexname); await pool.end();
      expect(names).toEqual(expect.arrayContaining(['summaries_project', 'sessions_project', 'sync_log_project']));
    });
    it('rejects non-finite vectors', async () => {
      const s = await open(4)(); await s.migrate();
      const { hsess, hobs } = await import('./hub-store-contract.js');
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      await expect(s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, embedding: [NaN, 0, 0, 0] })])).rejects.toThrow(/invalid_embedding/);
      await s.close();
    });
  });
}
