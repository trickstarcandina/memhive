import { describe, it, expect } from 'vitest';
import { pgTestDb } from '../helpers/pg.js';
import { PostgresHubStore, toTsQuery } from '../../src/hub/store/postgres.js';
import { hobs, hsess } from './hub-store-contract.js';
import { newId } from '../../src/shared/ids.js';

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

const db = pgTestDb('extra');
if (!db) {
  describe.skip('postgres toTsQuery + seq concurrency (set TEST_DATABASE_URL to run)', () => {
    it('skipped', () => {});
  });
} else {
  const extraUrl = db.url;
  const fresh = async (): Promise<PostgresHubStore> => {
    await db.reset();
    const s = new PostgresHubStore(extraUrl, { dims: 4 });
    await s.migrate();
    return s;
  };

  describe('postgres toTsQuery through real to_tsquery', () => {
    it('hostile and punctuation-heavy input never throws and still matches', async () => {
      const s = await fresh();
      const p = await s.getOrCreateProject('k', 'n');
      const a = hsess(p.id);
      await s.upsertSessions([a]);
      await s.insertObservations([
        hobs({ projectId: p.id, sessionId: a.id, title: "O'Brien fixed the Đăng nhập bug" }),
        hobs({ projectId: p.id, sessionId: a.id, title: 'unrelated note' }),
      ]);
      const f = { projectId: p.id, limit: 10 };
      for (const q of [
        `o'brien`,
        `Đăng nhập`,
        `"bug" OR (fix*)`,
        `!!bug`,
        `bug & | ! ( ) : \\ '`,
        `'; DROP TABLE observations; --`,
      ]) {
        await expect(s.searchObservationsFts(q, f)).resolves.toBeInstanceOf(Array);
      }
      expect((await s.searchObservationsFts(`o'brien`, f)).map((o) => o.title)).toEqual([
        "O'Brien fixed the Đăng nhập bug",
      ]);
      expect(await s.searchObservationsFts('Đăng nhập', f)).toHaveLength(1);
      expect(await s.searchObservationsFts('!!! ???', f)).toEqual([]); // no tokens -> empty, no SQL error
      expect(await s.searchObservationsFts('', f)).toEqual([]);
      expect(await s.searchObservationsFts('unrelated bug', f)).toEqual([]); // AND semantics
      await s.close();
    });
  });

  describe('postgres batch insert', () => {
    it('500-row push: sessions, observations and summaries in order, sync_log in input order (timing logged)', async () => {
      const s = await fresh();
      const p = await s.getOrCreateProject('k', 'n');
      const q = await s.getOrCreateProject('k2', 'n2');
      const sessions = Array.from({ length: 50 }, (_, i) => hsess(i % 2 ? p.id : q.id));
      const obs = Array.from({ length: 500 }, (_, i) =>
        hobs({
          projectId: sessions[i % 50].projectId,
          sessionId: sessions[i % 50].id,
          title: 'b' + i,
          facts: ["it's", 'two'],
          embedding: i % 3 ? [i, 0, 0, 1] : null,
          embeddingModel: i % 3 ? 'm' : null,
        })
      );
      const sums = sessions.map((x) => ({
        id: newId(),
        projectId: x.projectId,
        sessionId: x.id,
        userId: 'alice',
        request: 'r',
        learned: '',
        completed: '',
        nextSteps: '',
        createdAt: new Date().toISOString(),
        origin: 'local' as const,
        syncedAt: null,
      }));
      const t0 = performance.now();
      expect(await s.upsertSessions(sessions)).toEqual(sessions.map((x) => x.id));
      expect(await s.insertObservations([...obs, obs[0]])).toEqual(obs.map((o) => o.id));
      expect(await s.insertSummaries(sums)).toEqual(sums.map((x) => x.id));
      console.log(
        `[bench] hub postgres push of 50 sessions + 500 observations + 50 summaries: ${(performance.now() - t0).toFixed(0)} ms`
      );
      const log = [...(await s.listSyncLog(p.id, 0, 1000)), ...(await s.listSyncLog(q.id, 0, 1000))].sort(
        (a, b) => a.seq - b.seq
      );
      expect(log.map((e) => e.rowId)).toEqual([...sessions, ...obs, ...sums].map((x) => x.id));
      const got = await s.getObservations([obs[1].id, obs[3].id]);
      expect(got[0]).toMatchObject({
        title: 'b1',
        facts: ["it's", 'two'],
        embedding: [1, 0, 0, 1],
        embeddingModel: 'm',
      });
      expect(got[1].embedding).toBeNull();
      expect(
        await s.upsertSessions([
          { ...sessions[0], endedAt: '2030-01-01T00:00:00.000Z' },
          sessions[1],
          { ...sessions[0], endedAt: '2030-01-01T00:00:00.000Z' },
        ])
      ).toEqual([sessions[0].id]);
      expect(await s.upsertSessions([])).toEqual([]);
      expect(await s.insertObservations([])).toEqual([]);
      expect(await s.insertSummaries([])).toEqual([]);
      await s.close();
    });
  });

  describe('postgres sync_log seq under concurrency', () => {
    it('concurrent writers on one project yield seqs 1..N with no gaps or duplicates', async () => {
      const s = await fresh();
      const p = await s.getOrCreateProject('k', 'n');
      const a = hsess(p.id);
      await s.upsertSessions([a]);
      const N = 40;
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, title: 't' + i })])
        )
      );
      const seqs = (await s.listSyncLog(p.id, 0, 1000)).map((e) => e.seq);
      expect(seqs).toEqual(Array.from({ length: N + 1 }, (_, i) => i + 1));
      expect(await s.maxSeq(p.id)).toBe(N + 1);
      await s.close();
    });

    it('a puller advancing its cursor during concurrent commits never skips a seq (two pools)', async () => {
      const writer1 = await fresh();
      const writer2 = new PostgresHubStore(extraUrl, { dims: 4 });
      const reader = new PostgresHubStore(extraUrl, { dims: 4 });
      const p = await writer1.getOrCreateProject('k', 'n');
      const a = hsess(p.id);
      await writer1.upsertSessions([a]);
      const N = 60;
      let done = false;
      const writers = Promise.all(
        Array.from({ length: N }, (_, i) =>
          (i % 2 ? writer1 : writer2).insertObservations([hobs({ projectId: p.id, sessionId: a.id, title: 'c' + i })])
        )
      ).then(() => {
        done = true;
      });
      const seen: number[] = [];
      let cursor = 0;
      const drain = async () => {
        for (const e of await reader.listSyncLog(p.id, cursor, 7)) {
          seen.push(e.seq);
          cursor = e.seq;
        }
      };
      while (!done) await drain();
      await writers;
      for (let i = 0; i < 20; i++) await drain();
      expect(seen).toEqual(Array.from({ length: N + 1 }, (_, i) => i + 1));
      await Promise.all([writer1.close(), writer2.close(), reader.close()]);
    });

    it('writes to different projects interleave (global sequence): each log is strictly increasing, seqs never repeat', async () => {
      const s = await fresh();
      const p1 = await s.getOrCreateProject('k1', 'n1');
      const p2 = await s.getOrCreateProject('k2', 'n2');
      const a1 = hsess(p1.id);
      const a2 = hsess(p2.id);
      await Promise.all([s.upsertSessions([a1]), s.upsertSessions([a2])]);
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          s.insertObservations([
            hobs({ projectId: i % 2 ? p1.id : p2.id, sessionId: i % 2 ? a1.id : a2.id, title: 'x' + i }),
          ])
        )
      );
      const l1 = (await s.listSyncLog(p1.id, 0, 100)).map((e) => e.seq);
      const l2 = (await s.listSyncLog(p2.id, 0, 100)).map((e) => e.seq);
      expect(l1).toHaveLength(11);
      expect(l2).toHaveLength(11);
      for (const l of [l1, l2]) expect(l).toEqual([...l].sort((x, y) => x - y));
      expect(new Set([...l1, ...l2]).size).toBe(22);
      expect(await s.maxSeq(p1.id)).toBe(l1[l1.length - 1]);
      await s.close();
    });
  });
}
