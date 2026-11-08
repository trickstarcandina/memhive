import { pgTestDb } from '../helpers/pg.js';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { PostgresHubStore } from '../../src/hub/store/postgres.js';
import type { HubStore } from '../../src/hub/store/types.js';

export interface HubStoreKind { name: string; open(dims: number | null): Promise<HubStore> }

/**
 * The SQLite hub always; the Postgres hub when TEST_DATABASE_URL is set. Each test file passes its own suffix and gets its
 * own database (see tests/helpers/pg.ts).
 */
export function hubStores(suffix: string): HubStoreKind[] {
  const kinds: HubStoreKind[] = [{ name: 'sqlite hub', open: async (dims) => { const s = new SqliteHubStore(':memory:', { dims }); await s.migrate(); return s; } }];
  const db = pgTestDb(`sync_${suffix}`);
  if (!db) return kinds;
  kinds.push({ name: 'postgres hub', open: async (dims) => { await db.reset(); const s = new PostgresHubStore(db.url, { dims }); await s.migrate(); return s; } });
  return kinds;
}
