import { Pool } from 'pg';

/**
 * A Postgres database of this test file's own, `memhive_test_<name>`, created next to TEST_DATABASE_URL on first use.
 * Test files run in parallel and every reset() drops the public schema, so two files must never share a database.
 * Returns null when TEST_DATABASE_URL is unset.
 */
export function pgTestDb(name: string): { url: string; reset(): Promise<void> } | null {
  const base = process.env.TEST_DATABASE_URL;
  if (!base) return null;
  // reset() drops a schema: only ever run next to a throwaway database
  const baseName = decodeURIComponent(new URL(base).pathname.slice(1));
  if (!baseName.includes('test') && !process.env.CI) throw new Error(`refusing to run against database "${baseName}": name must contain "test" (or set CI)`);
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`bad test database suffix "${name}"`);
  const db = `memhive_test_${name}`;
  const u = new URL(base); u.pathname = '/' + db;
  const url = u.toString();
  let created: Promise<void> | null = null;
  const create = async () => {
    const admin = new Pool({ connectionString: base });
    try {
      if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [db])).rowCount) {
        // a concurrent run of the same file may win the race
        await admin.query(`CREATE DATABASE ${db}`).catch((e: { code?: string }) => { if (e.code !== '42P04' && e.code !== '23505') throw e; });
      }
    } finally { await admin.end(); }
  };
  return {
    url,
    async reset() {
      await (created ??= create());
      const pool = new Pool({ connectionString: url });
      try { await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;'); } finally { await pool.end(); }
    },
  };
}
