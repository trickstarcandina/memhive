import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { SQLITE_MIGRATIONS } from '../../src/store/sqlite/migrations.js';
import { SqliteHubStore } from '../../src/hub/store/sqlite.js';
import { HUB_SQLITE_MIGRATIONS } from '../../src/hub/store/migrations-sqlite.js';
import { PostgresHubStore } from '../../src/hub/store/postgres.js';
import { hubPgMigrations } from '../../src/hub/store/migrations-pg.js';
import { pgTestDb } from '../helpers/pg.js';
import { obs, sess } from './store-contract.js';

const dbFile = () => path.join(mkdtempSync(path.join(tmpdir(), 'mh-mig-')), 'm.db');
const OBS_ID = '01900000-0000-7000-8000-0000abcdef12';

/** A database left by an older memhive: migrations 1..version applied by hand, with a few rows written at v1. */
function oldDb(file: string, version: number, migrations = SQLITE_MIGRATIONS): void {
  const raw = new Database(file);
  raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  migrations.slice(0, version).forEach((sql, i) => {
    raw.exec(sql);
    raw.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(i + 1, 'x');
  });
  if (migrations === SQLITE_MIGRATIONS) {
    raw
      .prepare("INSERT INTO projects VALUES ('p', 'github.com/a/b', 'b', 'https://hub', '2026-01-01T00:00:00.000Z')")
      .run();
    raw
      .prepare(
        "INSERT INTO sessions(id, project_id, user_id, host, host_session_id, cwd, started_at) VALUES ('s', 'p', 'u', 'claude-code', 'h1', '/w', '2026-01-01T00:00:00.000Z')"
      )
      .run();
    raw
      .prepare(
        "INSERT INTO observations(id, project_id, session_id, user_id, type, title, narrative, created_at) VALUES (?, 'p', 's', 'u', 'decision', 'Chose SQLite', 'old row', '2026-01-01T00:00:00.000Z')"
      )
      .run(OBS_ID);
    raw.prepare("INSERT INTO sync_state(project_id, pull_cursor) VALUES ('p', 42)").run();
  }
  raw.close();
}

const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
const schema = (db: Database.Database) =>
  db.prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
const versions = (db: Database.Database) =>
  (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>).map(
    (r) => r.version
  );
const all = SQLITE_MIGRATIONS.map((_, i) => i + 1);

describe('client sqlite migrations', () => {
  it.each(SQLITE_MIGRATIONS.slice(0, -1).map((_, i) => i + 1))(
    'a database at v%i upgrades to the current schema and keeps its rows',
    (v) => {
      const file = dbFile();
      oldDb(file, v);
      const s = new SqliteStore(file, { dims: 4, model: 'm' });
      s.migrate();
      const db = new Database(file);
      try {
        expect(versions(db)).toEqual(all);
        const tables = (
          db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>
        ).map((r) => r.name);
        expect(tables).toEqual(expect.arrayContaining(['tombstones', 'sync_quarantine', 'vec_observations']));
        expect(columns(db, 'sync_state')).toEqual(
          expect.arrayContaining([
            'hub_epoch',
            'backoff_until',
            'backoff_ms',
            'strikes',
            'last_error',
            'last_push_at',
            'last_pull_at',
            'last_error_at',
          ])
        );
        expect(columns(db, 'observations')).toEqual(
          expect.arrayContaining(['short_id', 'seen_count', 'last_seen_at', 'pinned', 'push_attempts'])
        );
        expect(columns(db, 'sessions')).toEqual(expect.arrayContaining(['origin', 'branch', 'push_attempts']));
        expect(db.prepare("SELECT v FROM vec_meta WHERE k = 'model'").get()).toEqual({ v: 'm' });
        expect(db.prepare("SELECT v FROM vec_meta WHERE k = 'dims'").get()).toEqual({ v: '4' });
      } finally {
        db.close();
      }
      // the old rows read through the current code paths
      expect(s.getObservations([OBS_ID])[0]).toMatchObject({ title: 'Chose SQLite', seenCount: 1, pinned: false });
      expect(s.resolveIdPrefix('abcdef12')).toBe(OBS_ID);
      expect(s.searchObservationsFts('sqlite', { projectId: 'p', limit: 5 }).map((h) => h.id)).toEqual([OBS_ID]);
      expect(s.getPullCursor('p')).toBe(42);
      expect(s.getSyncState('p')).toMatchObject({ strikes: 0 });
      s.setHubEpoch('p', 'e1');
      expect(s.getHubEpoch('p')).toBe('e1');
      expect(s.deleteObservations([OBS_ID])).toBe(1);
      expect(s.listPendingTombstones('p', 10).map((t) => t.id)).toEqual([OBS_ID]);
      s.resetProjectSync('p');
      expect(s.getPullCursor('p')).toBe(0);
      s.close();
    }
  );

  it('a second migrate() changes nothing', () => {
    const file = dbFile();
    oldDb(file, 1);
    let s = new SqliteStore(file, { dims: 4, model: 'm' });
    s.migrate();
    s.close();
    const snap = () => {
      const db = new Database(file);
      try {
        return {
          schema: schema(db),
          versions: db.prepare('SELECT * FROM schema_migrations').all(),
          obs: db.prepare('SELECT COUNT(*) c FROM observations').get(),
          meta: db.prepare('SELECT * FROM vec_meta ORDER BY k').all(),
        };
      } finally {
        db.close();
      }
    };
    const before = snap();
    s = new SqliteStore(file, { dims: 4, model: 'm' });
    s.migrate();
    s.migrate();
    s.close();
    expect(snap()).toEqual(before);
  });

  it('a migration that fails midway rolls back and leaves schema_migrations unchanged', () => {
    const file = dbFile();
    oldDb(file, SQLITE_MIGRATIONS.length);
    // test-only: a bad migration appended to the shared array, removed again below
    SQLITE_MIGRATIONS.push(
      'CREATE TABLE half_done (x INTEGER); ALTER TABLE observations ADD COLUMN ok INTEGER; THIS IS NOT SQL;'
    );
    try {
      const s = new SqliteStore(file, { dims: null });
      expect(() => s.migrate()).toThrow(/syntax error/);
      s.close();
    } finally {
      SQLITE_MIGRATIONS.pop();
    }
    const db = new Database(file);
    try {
      expect(versions(db)).toEqual(all);
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBeUndefined();
      expect(columns(db, 'observations')).not.toContain('ok');
    } finally {
      db.close();
    }
    const s = new SqliteStore(file, { dims: null });
    s.migrate();
    s.close(); // and the real migrations still run clean
  });

  it('vectors: dims set, then unset, then set again keeps the table and its vectors', () => {
    const file = dbFile();
    let s = new SqliteStore(file, { dims: 4, model: 'm' });
    s.migrate();
    const p = s.getOrCreateProject('k', 'n');
    const a = sess(p.id);
    s.upsertSession(a);
    const o = obs({ projectId: p.id, sessionId: a.id });
    s.insertObservations([o]);
    s.setObservationEmbedding(o.id, [1, 0, 0, 0], 'm');
    s.close();
    s = new SqliteStore(file, { dims: null });
    s.migrate();
    expect(s.searchObservationsVector([1, 0, 0, 0], { projectId: p.id, limit: 1 })).toEqual([]);
    s.close();
    s = new SqliteStore(file, { dims: 4, model: 'm' });
    s.migrate();
    expect(s.searchObservationsVector([1, 0, 0, 0], { projectId: p.id, limit: 1 })[0].id).toBe(o.id);
    expect(s.listMissingEmbedding(10)).toEqual([]);
    s.close();
  });

  it('vec_meta says 1024 but sqlite-vec fails to load: the vector table is not dropped', () => {
    const file = dbFile();
    let s = new SqliteStore(file, { dims: 1024, model: 'm' });
    s.migrate();
    const p = s.getOrCreateProject('k', 'n');
    const a = sess(p.id);
    s.upsertSession(a);
    const o = obs({ projectId: p.id, sessionId: a.id });
    s.insertObservations([o]);
    const v = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
    s.setObservationEmbedding(o.id, v, 'm');
    s.close();
    const warn: string[] = [];
    s = new SqliteStore(file, {
      dims: 1024,
      model: 'm',
      loadVec: () => {
        throw new Error('no vec0 for this platform');
      },
      warn: (m) => warn.push(m),
    });
    s.migrate();
    expect(s.vectorsDegraded).toBe(true);
    expect(warn.join()).toMatch(/sqlite-vec failed to load/);
    expect(s.getObservations([o.id])[0].embeddingModel).toBe('m');
    s.close();
    const db = new Database(file);
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'vec_observations'").get()).toBeDefined();
    } finally {
      db.close();
    }
    s = new SqliteStore(file, { dims: 1024, model: 'm' });
    s.migrate();
    expect(s.searchObservationsVector(v, { projectId: p.id, limit: 1 })[0].id).toBe(o.id);
    s.close();
  });
});

describe('hub sqlite migrations', () => {
  it.each(HUB_SQLITE_MIGRATIONS.slice(0, -1).map((_, i) => i + 1))(
    'a hub at v%i upgrades; a re-run is a no-op',
    async (v) => {
      const file = dbFile();
      oldDb(file, v, HUB_SQLITE_MIGRATIONS);
      let h = new SqliteHubStore(file, { dims: null });
      await h.migrate();
      await h.close();
      const db = new Database(file);
      const before = { schema: schema(db), versions: versions(db) };
      db.close();
      expect(before.versions).toEqual(HUB_SQLITE_MIGRATIONS.map((_, i) => i + 1));
      expect(before.schema).toEqual(
        expect.arrayContaining([
          { type: 'table', name: 'tombstones' },
          { type: 'trigger', name: 'observations_ad' },
        ])
      );
      h = new SqliteHubStore(file, { dims: null });
      await h.migrate();
      await h.migrate();
      await h.close();
      const after = new Database(file);
      try {
        expect({ schema: schema(after), versions: versions(after) }).toEqual(before);
      } finally {
        after.close();
      }
    }
  );
});

const pg = pgTestDb('migrations');
describe.skipIf(!pg)('hub postgres migrations', () => {
  it('two pools migrating at once apply every migration exactly once', async () => {
    await pg!.reset();
    const a = new PostgresHubStore(pg!.url, { dims: 4 });
    const b = new PostgresHubStore(pg!.url, { dims: 4 });
    await Promise.all([a.migrate(), b.migrate()]);
    await a.migrate(); // and a re-run is a no-op
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: pg!.url });
    try {
      const v = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) =>
        Number(r.version)
      );
      expect(v).toEqual(hubPgMigrations(4).map((_, i) => i + 1));
      expect((await pool.query("SELECT to_regclass('public.tombstones') t")).rows[0].t).toBe('tombstones');
    } finally {
      await pool.end();
      await a.close();
      await b.close();
    }
  });
});

// The 0.1.2 hub schema, verbatim (`git show main:src/hub/store/migrations-pg.ts`, dims 4): an upgrade must keep every row.
const PG_012_SCHEMA = `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE projects (id uuid PRIMARY KEY, key text NOT NULL UNIQUE, name text NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE users (name text PRIMARY KEY, created_at timestamptz NOT NULL);
    CREATE TABLE api_keys (id uuid PRIMARY KEY, user_name text NOT NULL REFERENCES users(name), label text NOT NULL, key_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE sessions (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), user_id text NOT NULL, host text NOT NULL, host_session_id text NOT NULL, cwd text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz);
    CREATE TABLE observations (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), session_id uuid NOT NULL, user_id text NOT NULL, type text NOT NULL, title text NOT NULL, subtitle text NOT NULL DEFAULT '',
      facts jsonb NOT NULL DEFAULT '[]', narrative text NOT NULL DEFAULT '', concepts jsonb NOT NULL DEFAULT '[]', files_read jsonb NOT NULL DEFAULT '[]', files_modified jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL, embedding_model text, embedding vector(4),
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || subtitle || ' ' || narrative || ' ' || facts::text || ' ' || concepts::text)) STORED);
    CREATE INDEX observations_project_time ON observations(project_id, created_at);
    CREATE INDEX observations_tsv ON observations USING gin(tsv);
    CREATE TABLE summaries (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), session_id uuid NOT NULL, user_id text NOT NULL, request text NOT NULL, learned text NOT NULL DEFAULT '', completed text NOT NULL DEFAULT '', next_steps text NOT NULL DEFAULT '', created_at timestamptz NOT NULL);
    CREATE TABLE sync_log (seq bigserial PRIMARY KEY, project_id uuid NOT NULL, tbl text NOT NULL, row_id uuid NOT NULL);
    CREATE INDEX sync_log_project ON sync_log(project_id, seq);
`;
const pgUp = pgTestDb('pg_upgrade');
describe.skipIf(!pgUp)('hub postgres upgrade from 0.1.2', () => {
  it('a populated 0.1.2 database migrates in place: cwd dropped, rows, vectors and keys kept', async () => {
    await pgUp!.reset();
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: pgUp!.url });
    const P = '01900000-0000-7000-8000-000000000001';
    const S = '01900000-0000-7000-8000-000000000002';
    const O = '01900000-0000-7000-8000-000000000003';
    const M = '01900000-0000-7000-8000-000000000004';
    const K = '01900000-0000-7000-8000-000000000005';
    const store = new PostgresHubStore(pgUp!.url, { dims: 4 });
    try {
      // what a 0.1.2 hub leaves behind: its migrate() bookkeeping, then rows written through it
      await pool.query('CREATE TABLE schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL)');
      await pool.query(PG_012_SCHEMA);
      await pool.query('INSERT INTO schema_migrations VALUES (1, now())');
      await pool.query(`INSERT INTO projects VALUES ('${P}', 'github.com/t/old', 'old', now());
        INSERT INTO users VALUES ('alice', now());
        INSERT INTO api_keys VALUES ('${K}', 'alice', 'laptop', 'hash-1', now(), NULL);
        INSERT INTO sessions VALUES ('${S}', '${P}', 'alice', 'claude-code', 'h1', '/home/alice/client-x', now(), NULL);
        INSERT INTO observations (id, project_id, session_id, user_id, type, title, created_at, embedding_model, embedding)
          VALUES ('${O}', '${P}', '${S}', 'alice', 'discovery', 'kept title', now(), 'm', '[1,2,3,4]');
        INSERT INTO summaries (id, project_id, session_id, user_id, request, created_at) VALUES ('${M}', '${P}', '${S}', 'alice', 'req', now());
        INSERT INTO sync_log (project_id, tbl, row_id) VALUES ('${P}', 'sessions', '${S}'), ('${P}', 'observations', '${O}'), ('${P}', 'summaries', '${M}');`);
      await store.migrate();
      await store.migrate(); // a second start is a no-op
      const v = (await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows.map((r) =>
        Number(r.version)
      );
      expect(v).toEqual(hubPgMigrations(4).map((_, i) => i + 1));
      const cols = (
        await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'sessions'")
      ).rows.map((r) => r.column_name);
      expect(cols).not.toContain('cwd');
      for (const t of ['tombstones', 'hub_meta'])
        expect((await pool.query('SELECT to_regclass($1) t', [`public.${t}`])).rows[0].t).toBe(t);
      const [s] = await store.getSessions([S]);
      expect(s).toMatchObject({ id: S, userId: 'alice', host: 'claude-code' });
      const [o] = await store.getObservations([O]);
      expect(o).toMatchObject({ title: 'kept title', embeddingModel: 'm', embedding: [1, 2, 3, 4] });
      expect(await store.getSummaries([M])).toHaveLength(1);
      expect(await store.maxSeq(P)).toBe(3);
      expect(await store.authenticate('hash-1')).toEqual({ keyId: K, userName: 'alice' }); // the old key still works
    } finally {
      await store.close();
      await pool.end();
    }
  });
});
