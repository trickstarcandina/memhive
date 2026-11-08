import { describe, it } from 'vitest';
import { PostgresHubStore } from '../../src/hub/store/postgres.js';
import { hubStoreContract } from './hub-store-contract.js';
import { Pool } from 'pg';

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  describe.skip('postgres hub store (set TEST_DATABASE_URL to run)', () => { it('skipped', () => {}); });
} else {
  hubStoreContract('postgres', async () => {
    const pool = new Pool({ connectionString: url });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;');
    await pool.end();
    return new PostgresHubStore(url, { dims: 4 });
  });
}
