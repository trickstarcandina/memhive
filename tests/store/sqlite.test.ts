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

describe('sqlite migration 2 (session origin)', () => {
  it('backfills origin=hub on existing sessions that only hold pulled rows', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'm.db');
    const raw = new Database(file);
    raw.exec(SQLITE_MIGRATIONS[0]);
    raw.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'); raw.prepare('INSERT INTO schema_migrations VALUES (1, ?)').run('x');
    raw.prepare("INSERT INTO projects VALUES ('p', 'k', 'n', NULL, 'x')").run();
    for (const id of ['pulled', 'mine', 'empty']) raw.prepare("INSERT INTO sessions(id, project_id, user_id, host, host_session_id, cwd, started_at) VALUES (?, 'p', 'u', 'h', ?, '/', 'x')").run(id, id);
    const ins = raw.prepare("INSERT INTO observations(id, project_id, session_id, user_id, type, title, created_at, origin) VALUES (?, 'p', ?, 'u', 'discovery', 't', 'x', ?)");
    ins.run('o1', 'pulled', 'hub'); ins.run('o2', 'mine', 'local');
    raw.close();
    const s = new SqliteStore(file, { dims: null }); s.migrate();
    expect(['pulled', 'mine', 'empty'].map((id) => s.getSession(id)!.origin)).toEqual(['hub', 'local', 'local']);
    s.close();
  });
});
