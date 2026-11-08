import { describe, it, expect } from 'vitest';
import { Pool } from 'pg';
import { PostgresHubStore, toTsQuery } from '../../src/hub/store/postgres.js';
import { hobs, hsess } from './hub-store-contract.js';

describe('toTsQuery (pure)', () => {
  it.each([
    ['hello world', `'hello' & 'world'`],
    ['  ', ''],
    ['', ''],
    ['!!! ??? &&&', ''],
    ['Auth: "Token" OR jwt*', `'auth' & 'token' & 'or' & 'jwt'`],
    ['Đăng nhập lỗi', `'đăng' & 'nhập' & 'lỗi'`],
    ['a-b_c', `'a' & 'b_c'`],
    ['dup DUP dup', `'dup'`],
    ["o'brien", `'o' & 'brien'`],
    ['(a | b) & !c <-> d :* \\', `'a' & 'b' & 'c' & 'd'`],
  ])('%j -> %j', (i, o) => expect(toTsQuery(i)).toBe(o));

  it('caps at 16 distinct tokens', () => {
    const q = toTsQuery(Array.from({ length: 40 }, (_, i) => 't' + i).join(' '));
    expect(q.split(' & ')).toHaveLength(16);
    expect(q.startsWith(`'t0' & 't1'`)).toBe(true);
  });
  it('never emits a quote that is not part of the wrapping pair', () => {
    for (const input of [`'; DROP TABLE x; --`, `'' ''`, `\\' & \\'`]) {
      for (const tok of toTsQuery(input).split(' & ').filter(Boolean)) expect(tok).toMatch(/^'[^']+'$/);
    }
  });
});

const url = process.env.TEST_DATABASE_URL;
if (!url) {
  describe.skip('postgres toTsQuery + seq concurrency (set TEST_DATABASE_URL to run)', () => { it('skipped', () => {}); });
} else {
  // own database: test files run in parallel and the other postgres suite drops the public schema of TEST_DATABASE_URL
  const extraName = 'memhub_test_extra';
  const base = new URL(url);
  const adminUrl = url;
  base.pathname = '/' + extraName;
  const extraUrl = base.toString();
  const dbName = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!dbName.includes('test') && !process.env.CI) throw new Error(`refusing to run against database "${dbName}": name must contain "test" (or set CI)`);
  const ensureDb = async () => {
    const admin = new Pool({ connectionString: adminUrl });
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [extraName]);
    if (!rowCount) await admin.query(`CREATE DATABASE ${extraName}`);
    await admin.end();
  };
  const fresh = async (): Promise<PostgresHubStore> => {
    await ensureDb();
    const pool = new Pool({ connectionString: extraUrl });
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public; CREATE EXTENSION IF NOT EXISTS vector;');
    await pool.end();
    const s = new PostgresHubStore(extraUrl, { dims: 4 }); await s.migrate(); return s;
  };

  describe('postgres toTsQuery through real to_tsquery', () => {
    it('hostile and punctuation-heavy input never throws and still matches', async () => {
      const s = await fresh();
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      await s.insertObservations([
        hobs({ projectId: p.id, sessionId: a.id, title: "O'Brien fixed the Đăng nhập bug" }),
        hobs({ projectId: p.id, sessionId: a.id, title: 'unrelated note' }),
      ]);
      const f = { projectId: p.id, limit: 10 };
      for (const q of [`o'brien`, `Đăng nhập`, `"bug" OR (fix*)`, `!!bug`, `bug & | ! ( ) : \\ '`, `'; DROP TABLE observations; --`]) {
        await expect(s.searchObservationsFts(q, f)).resolves.toBeInstanceOf(Array);
      }
      expect((await s.searchObservationsFts(`o'brien`, f)).map((o) => o.title)).toEqual(["O'Brien fixed the Đăng nhập bug"]);
      expect(await s.searchObservationsFts('Đăng nhập', f)).toHaveLength(1);
      expect(await s.searchObservationsFts('!!! ???', f)).toEqual([]);   // no tokens -> empty, no SQL error
      expect(await s.searchObservationsFts('', f)).toEqual([]);
      expect(await s.searchObservationsFts('unrelated bug', f)).toEqual([]);   // AND semantics
      await s.close();
    });
  });

  describe('postgres sync_log seq under concurrency', () => {
    it('concurrent writers on one project yield seqs 1..N with no gaps or duplicates', async () => {
      const s = await fresh();
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      const N = 40;
      await Promise.all(Array.from({ length: N }, (_, i) => s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, title: 't' + i })])));
      const seqs = (await s.listSyncLog(p.id, 0, 1000)).map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: N + 1 }, (_, i) => i + 1));
      expect(await s.maxSeq(p.id)).toBe(N + 1);
      await s.close();
    });

    it('a puller advancing its cursor during concurrent commits never skips a seq (two pools)', async () => {
      const writer1 = await fresh();
      const writer2 = new PostgresHubStore(extraUrl, { dims: 4 });
      const reader = new PostgresHubStore(extraUrl, { dims: 4 });
      const p = await writer1.getOrCreateProject('k', 'n'); const a = hsess(p.id); await writer1.upsertSessions([a]);
      const N = 60; let done = false;
      const writers = Promise.all(Array.from({ length: N }, (_, i) => (i % 2 ? writer1 : writer2).insertObservations([hobs({ projectId: p.id, sessionId: a.id, title: 'c' + i })]))).then(() => { done = true; });
      const seen: number[] = []; let cursor = 0;
      const drain = async () => { for (const e of await reader.listSyncLog(p.id, cursor, 7)) { seen.push(e.seq); cursor = e.seq; } };
      while (!done) await drain();
      await writers;
      for (let i = 0; i < 20; i++) await drain();
      expect(seen).toEqual(Array.from({ length: N + 1 }, (_, i) => i + 1));
      await Promise.all([writer1.close(), writer2.close(), reader.close()]);
    });

    it('writes to different projects interleave (global sequence): each log is strictly increasing, seqs never repeat', async () => {
      const s = await fresh();
      const p1 = await s.getOrCreateProject('k1', 'n1'); const p2 = await s.getOrCreateProject('k2', 'n2');
      const a1 = hsess(p1.id); const a2 = hsess(p2.id);
      await Promise.all([s.upsertSessions([a1]), s.upsertSessions([a2])]);
      await Promise.all(Array.from({ length: 20 }, (_, i) => s.insertObservations([hobs({ projectId: i % 2 ? p1.id : p2.id, sessionId: i % 2 ? a1.id : a2.id, title: 'x' + i })])));
      const l1 = (await s.listSyncLog(p1.id, 0, 100)).map((e) => e.seq); const l2 = (await s.listSyncLog(p2.id, 0, 100)).map((e) => e.seq);
      expect(l1).toHaveLength(11); expect(l2).toHaveLength(11);
      for (const l of [l1, l2]) expect(l).toEqual([...l].sort((x, y) => x - y));
      expect(new Set([...l1, ...l2]).size).toBe(22);
      expect(await s.maxSeq(p1.id)).toBe(l1[l1.length - 1]);
      await s.close();
    });
  });
}
