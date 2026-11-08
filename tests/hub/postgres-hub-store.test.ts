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
    it('rejects non-finite vectors', async () => {
      const s = await open(4)(); await s.migrate();
      const { hsess, hobs } = await import('./hub-store-contract.js');
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      await expect(s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, embedding: [NaN, 0, 0, 0] })])).rejects.toThrow(/invalid_embedding/);
      await s.close();
    });
  });
}
