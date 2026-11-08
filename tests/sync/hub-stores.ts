import { Pool } from 'pg';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { PostgresHubStore } from '../../src/hub/store/postgres.js';
import type { HubStore } from '../../src/hub/store/types.js';

export interface HubStoreKind { name: string; open(dims: number | null): Promise<HubStore> }

/**
 * The SQLite hub always; the Postgres hub when TEST_DATABASE_URL is set. Each test file passes its own suffix and gets its
 * own database, because test files run in parallel and every open() drops that database's public schema.
 */
export function hubStores(suffix: string): HubStoreKind[] {
  const kinds: HubStoreKind[] = [{ name: 'sqlite hub', open: async (dims) => { const s = new SqliteHubStore(':memory:', { dims }); await s.migrate(); return s; } }];
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return kinds;
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!dbName.includes('test') && !process.env.CI) throw new Error(`refusing to run against database "${dbName}": name must contain "test" (or set CI)`);
  const name = `memhive_test_sync_${suffix}`; const own = new URL(url); own.pathname = '/' + name;
  let created = false;
  kinds.push({ name: 'postgres hub', open: async (dims) => {
    if (!created) {
      const admin = new Pool({ connectionString: url });
      try { if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount) await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
      created = true;
    }
    const pool = new Pool({ connectionString: own.toString() });
    try { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;'); } finally { await pool.end(); }
    const s = new PostgresHubStore(own.toString(), { dims }); await s.migrate(); return s;
  } });
  return kinds;
}
