import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import Database from 'better-sqlite3';
import { SQLITE_MIGRATIONS } from '../../src/store/sqlite/migrations.js';
import { storeContract, obs, sess } from './store-contract.js';

storeContract('sqlite', () => new SqliteStore(':memory:', { dims: 4 }));

describe('sqlite vector table lifecycle', () => {
  it('rebuilds the vec table and clears models when dims change', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'm.db');
    let s = new SqliteStore(file, { dims: 4 });
    s.migrate();
    const p = s.getOrCreateProject('k', 'n');
    const a = sess(p.id);
    s.upsertSession(a);
    const o = obs({ projectId: p.id, sessionId: a.id });
    s.insertObservations([o]);
    s.setObservationEmbedding(o.id, [1, 0, 0, 0], 'm4');
    s.close();
    s = new SqliteStore(file, { dims: 2 });
    s.migrate();
    expect(s.listMissingEmbedding(10).map((x) => x.id)).toEqual([o.id]);
    s.setObservationEmbedding(o.id, [1, 0], 'm2');
    expect(s.searchObservationsVector([1, 0], { projectId: p.id, limit: 1 })[0].id).toBe(o.id);
    s.close();
  });
  it('works without a vector table', () => {
    const s = new SqliteStore(':memory:', { dims: null });
    s.migrate();
    const p = s.getOrCreateProject('k', 'n');
    expect(s.searchObservationsVector([1], { projectId: p.id, limit: 1 })).toEqual([]);
    s.close();
  });
});

describe('sqlite migration 2 (session origin)', () => {
  it('backfills origin=hub on existing sessions that only hold pulled rows', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'm.db');
    const raw = new Database(file);
    raw.exec(SQLITE_MIGRATIONS[0]);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    raw.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run('x');
    raw.prepare("INSERT INTO projects VALUES ('p', 'k', 'n', NULL, 'x')").run();
    for (const id of ['pulled', 'mine', 'empty'])
      raw
        .prepare(
          "INSERT INTO sessions(id, project_id, user_id, host, host_session_id, cwd, started_at) VALUES (?, 'p', 'u', 'h', ?, '/', 'x')"
        )
        .run(id, id);
    const ins = raw.prepare(
      "INSERT INTO observations(id, project_id, session_id, user_id, type, title, created_at, origin) VALUES (?, 'p', ?, 'u', 'discovery', 't', 'x', ?)"
    );
    ins.run('o1', 'pulled', 'hub');
    ins.run('o2', 'mine', 'local');
    raw.close();
    const s = new SqliteStore(file, { dims: null });
    s.migrate();
    expect(['pulled', 'mine', 'empty'].map((id) => s.getSession(id)!.origin)).toEqual(['hub', 'local', 'local']);
    s.close();
  });
});

describe('sqlite migration 7 (short_id)', () => {
  it('an older database resolves 8-char short ids and head prefixes by index after the upgrade', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'm.db');
    const raw = new Database(file);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    SQLITE_MIGRATIONS.slice(0, 5).forEach((sql, i) => {
      raw.exec(sql);
      raw.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(i + 1, 'x');
    });
    raw.prepare("INSERT INTO projects VALUES ('p', 'k', 'n', NULL, 'x')").run();
    raw
      .prepare(
        "INSERT INTO sessions(id, project_id, user_id, host, host_session_id, cwd, started_at) VALUES ('s', 'p', 'u', 'h', 'hs', '/', 'x')"
      )
      .run();
    const ids = ['0190aaaa-bbbb-7ccc-8ddd-eeeeffff0001', '0190aaaa-bbbb-7ccc-8ddd-eeee12345678'];
    for (const id of ids)
      raw
        .prepare(
          "INSERT INTO observations(id, project_id, session_id, user_id, type, title, created_at) VALUES (?, 'p', 's', 'u', 'discovery', 't', 'x')"
        )
        .run(id);
    raw.close();
    const s = new SqliteStore(file, { dims: null });
    s.migrate();
    expect(s.resolveIdPrefix('ffff0001')).toBe(ids[0]);
    expect(s.resolveIdPrefix('12345678')).toBe(ids[1]);
    expect(s.resolveIdPrefix('FFFF0001')).toBe(ids[0]);
    expect(s.resolveIdPrefix('0190aaaa')).toBeNull(); // ambiguous head
    expect(s.resolveIdPrefix('0190aaaa-bbbb-7ccc-8ddd-eeeeff')).toBe(ids[0]);
    expect(s.resolveIdPrefix('5678')).toBe(ids[1]); // other tail lengths still work
    const db = (s as any).db as Database.Database;
    const plan = (sql: string) =>
      db
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((r: any) => r.detail)
        .join(' ');
    expect(plan("SELECT id FROM observations WHERE short_id = 'x'")).toContain('observations_short_id');
    expect(plan("SELECT * FROM sessions WHERE project_id = 'p' AND synced_at IS NULL")).toContain('sessions_unsynced');
    s.close();
  });
});
