import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Store, Observation, Session, Summary } from '../../src/store/types.js';
import { newId, shortId } from '../../src/shared/ids.js';

export const obs = (p: Partial<Observation> & { projectId: string; sessionId: string }): Observation => ({
  id: newId(), userId: 'local', type: 'discovery', title: 'T', subtitle: 'S', facts: ['f1'], narrative: 'N', concepts: ['c'],
  filesRead: [], filesModified: [], createdAt: new Date().toISOString(), embeddingModel: null, origin: 'local', syncedAt: null, ...p,
});
export const sess = (projectId: string, p: Partial<Session> = {}): Session => ({
  id: newId(), projectId, userId: 'local', host: 'claude-code', hostSessionId: 'h-' + Math.random(), cwd: '/w', startedAt: new Date().toISOString(), endedAt: null, syncedAt: null, ...p,
});

export function storeContract(name: string, open: () => Store): void {
  describe(`${name} store contract`, () => {
    let s: Store;
    beforeEach(() => { s = open(); s.migrate(); });
    afterEach(() => s.close());

    it('migrate is idempotent', () => { s.migrate(); s.migrate(); });

    it('projects: get or create, by key, hub url', () => {
      const p = s.getOrCreateProject('github.com/a/b', 'b');
      expect(s.getOrCreateProject('github.com/a/b', 'other').id).toBe(p.id);
      expect(s.getProjectByKey('github.com/a/b')!.name).toBe('b');
      s.setProjectHub(p.id, 'https://hub');
      expect(s.getProject(p.id)!.hubUrl).toBe('https://hub');
      s.setProjectHub(p.id, null);
      expect(s.getProject(p.id)!.hubUrl).toBeNull();
    });

    it('sessions: upsert, lookup by host, end', () => {
      const p = s.getOrCreateProject('k', 'n');
      const a = sess(p.id, { hostSessionId: 'x' });
      s.upsertSession(a);
      s.upsertSession({ ...a, cwd: '/changed' });
      expect(s.getSession(a.id)!.cwd).toBe('/changed');
      expect(s.getSessionByHost('claude-code', 'x')!.id).toBe(a.id);
      s.endSession(a.id, '2026-01-01T00:00:00.000Z');
      expect(s.getSession(a.id)!.endedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(s.countSessions(p.id)).toBe(1);
    });

    it('sessions: an upsert with another project or user never touches the existing row', () => {
      const p = s.getOrCreateProject('k', 'n'); const q = s.getOrCreateProject('k2', 'n2');
      const a = sess(p.id, { hostSessionId: 'own', userId: 'alice' });
      s.upsertSession(a);
      s.upsertSession({ ...a, projectId: q.id, cwd: '/forged', endedAt: '2026-01-01T00:00:00.000Z' });
      s.upsertSession({ ...a, userId: 'mallory', cwd: '/forged', endedAt: '2026-01-01T00:00:00.000Z' });
      expect(s.getSession(a.id)).toMatchObject({ projectId: p.id, userId: 'alice', cwd: a.cwd, endedAt: null });
    });

    it('prompts: latest', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      s.insertPrompt({ id: newId(), sessionId: a.id, text: 'one', createdAt: '2026-01-01T00:00:00Z' });
      s.insertPrompt({ id: newId(), sessionId: a.id, text: 'two', createdAt: '2026-01-02T00:00:00Z' });
      expect(s.latestPrompt(a.id)!.text).toBe('two');
    });

    it('observations: insert ignores duplicates, get keeps order, prefix resolve', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      const o1 = obs({ projectId: p.id, sessionId: a.id, title: 'first' });
      const o2 = obs({ projectId: p.id, sessionId: a.id, title: 'second' });
      s.insertObservations([o1, o2]);
      s.insertObservations([{ ...o1, title: 'dup' }]);
      expect(s.getObservations([o2.id, o1.id]).map((o) => o.title)).toEqual(['second', 'first']);
      expect(s.resolveIdPrefix(o1.id.slice(0, 30))).toBe(o1.id);
      expect(s.resolveIdPrefix(shortId(o1.id))).toBe(o1.id);
      expect(s.resolveIdPrefix('abc')).toBeNull();
      expect(s.resolveIdPrefix('zzzzzzzz')).toBeNull();
      expect(s.countObservations(p.id)).toBe(2);
      expect(s.lastActivity(p.id)).toBe(o2.createdAt);
      expect(s.listRecentObservations(p.id, 1)[0].id).toBe(o2.id);
      expect(s.listSessionObservations(a.id, 10)).toHaveLength(2);
    });

    it('resolveIdPrefix: ambiguous prefix returns null', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      const [x, y] = ['0190aaaa-0000-7000-8000-000000000001', '0190aaaa-0000-7000-8000-000000000002'];
      s.insertObservations([obs({ projectId: p.id, sessionId: a.id, id: x }), obs({ projectId: p.id, sessionId: a.id, id: y })]);
      expect(s.resolveIdPrefix('0190aaaa')).toBeNull();
      expect(s.resolveIdPrefix(x)).toBe(x);
    });

    it('fts search with filters', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      s.insertObservations([
        obs({ projectId: p.id, sessionId: a.id, type: 'bugfix', title: 'Fixed JWT expiry check', createdAt: '2026-01-05T00:00:00Z' }),
        obs({ projectId: p.id, sessionId: a.id, type: 'decision', title: 'Use Postgres for hub', createdAt: '2026-01-01T00:00:00Z' }),
      ]);
      expect(s.searchObservationsFts('jwt', { projectId: p.id, limit: 10 })).toHaveLength(1);
      expect(s.searchObservationsFts('jwt', { projectId: p.id, type: 'decision', limit: 10 })).toHaveLength(0);
      expect(s.searchObservationsFts('postgres', { projectId: p.id, since: '2026-01-02T00:00:00Z', limit: 10 })).toHaveLength(0);
      expect(s.searchObservationsFts('auth: "token" OR jwt*', { projectId: p.id, limit: 10 })).toBeDefined(); // must not throw
    });

    it('timeline around anchor within same session', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      const list = [1, 2, 3, 4, 5].map((i) => obs({ projectId: p.id, sessionId: a.id, title: `o${i}`, createdAt: `2026-01-0${i}T00:00:00Z` }));
      s.insertObservations(list);
      expect(s.timeline(list[2].id, 1, 1).map((o) => o.title)).toEqual(['o2', 'o3', 'o4']);
    });

    it('summaries insert/list/search', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      const sm: Summary = { id: newId(), projectId: p.id, sessionId: a.id, userId: 'local', request: 'add login', learned: 'x', completed: 'y', nextSteps: 'z', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null };
      s.insertSummaries([sm]); s.insertSummaries([sm]);
      expect(s.listRecentSummaries(p.id, 5)).toHaveLength(1);
      expect(s.searchSummariesFts('login', { projectId: p.id, limit: 5 })).toHaveLength(1);
    });

    it('sync bookkeeping', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      const o = obs({ projectId: p.id, sessionId: a.id }); s.insertObservations([o]);
      expect(s.listUnsynced('observations', p.id, 10).map((x) => x.id)).toEqual([o.id]);
      expect(s.listUnsynced('sessions', p.id, 10).map((x) => x.id)).toEqual([a.id]);
      s.markSynced('observations', [o.id], '2026-01-01T00:00:00Z');
      expect(s.listUnsynced('observations', p.id, 10)).toHaveLength(0);
      expect(s.getPullCursor(p.id)).toBe(0);
      s.setPullCursor(p.id, 42);
      expect(s.getPullCursor(p.id)).toBe(42);
      expect(s.getHubEpoch(p.id)).toBeNull();
      s.setHubEpoch(p.id, 'e1');
      expect(s.getHubEpoch(p.id)).toBe('e1');
      expect(s.getPullCursor(p.id)).toBe(42);
      s.resetProjectSync(p.id);
      expect(s.getHubEpoch(p.id)).toBeNull();
    });

    it('relink reset: only local-origin rows become unsynced, pulled sessions are never pushed, cursor is 0', () => {
      const p = s.getOrCreateProject('k', 'n'); const mine = sess(p.id); const theirs = sess(p.id, { userId: 'bob', origin: 'hub', syncedAt: 'pulled' });
      s.upsertSession(mine); s.upsertSession(theirs);
      expect(s.getSession(theirs.id)!.origin).toBe('hub'); expect(s.getSession(mine.id)!.origin).toBe('local');
      s.insertObservations([obs({ projectId: p.id, sessionId: theirs.id, userId: 'bob', origin: 'hub', syncedAt: 'pulled' })]);
      expect(s.listUnsynced('sessions', p.id, 10).map((x) => x.id)).toEqual([mine.id]);
      s.markSynced('sessions', [mine.id], 'old-hub'); s.setPullCursor(p.id, 99);
      s.resetProjectSync(p.id);
      expect(s.getPullCursor(p.id)).toBe(0);
      expect(s.listUnsynced('sessions', p.id, 10).map((x) => x.id)).toEqual([mine.id]);
      expect(s.getSession(theirs.id)!.syncedAt).toBe('pulled');
      expect(s.listUnsynced('observations', p.id, 10)).toHaveLength(0);
    });

    it('embeddings: missing list and set', () => {
      const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
      const o = obs({ projectId: p.id, sessionId: a.id }); s.insertObservations([o]);
      expect(s.listMissingEmbedding(10).map((x) => x.id)).toEqual([o.id]);
      s.setObservationEmbedding(o.id, [1, 0, 0, 0], 'test-4');
      expect(s.listMissingEmbedding(10)).toHaveLength(0);
      expect(s.getObservations([o.id])[0].embeddingModel).toBe('test-4');
      const hits = s.searchObservationsVector([1, 0, 0, 0], { projectId: p.id, limit: 5 });
      expect(hits[0].id).toBe(o.id);
    });

    describe('search filters and isolation', () => {
      const setup = () => {
        const p1 = s.getOrCreateProject('k1', 'n1'); const p2 = s.getOrCreateProject('k2', 'n2');
        const a1 = sess(p1.id); const a2 = sess(p2.id); s.upsertSession(a1); s.upsertSession(a2);
        return { p1, p2, a1, a2 };
      };

      it('vector search is isolated per project partition', () => {
        const { p1, p2, a1, a2 } = setup();
        const o1 = obs({ projectId: p1.id, sessionId: a1.id }); const o2 = obs({ projectId: p2.id, sessionId: a2.id });
        s.insertObservations([o1, o2]);
        s.setObservationEmbedding(o1.id, [1, 0, 0, 0], 'm'); s.setObservationEmbedding(o2.id, [1, 0, 0, 0], 'm');
        expect(s.searchObservationsVector([1, 0, 0, 0], { projectId: p1.id, limit: 10 }).map((h) => h.id)).toEqual([o1.id]);
        expect(s.searchObservationsVector([1, 0, 0, 0], { projectId: p2.id, limit: 10 }).map((h) => h.id)).toEqual([o2.id]);
      });

      it('vector search with a selective filter still fills the limit when the matches are far away (G18)', () => {
        const { p1, a1 } = setup();
        const near = Array.from({ length: 300 }, () => obs({ projectId: p1.id, sessionId: a1.id, type: 'discovery' }));
        const far = Array.from({ length: 5 }, () => obs({ projectId: p1.id, sessionId: a1.id, type: 'bugfix' }));
        s.insertObservations([...near, ...far]);
        s.setObservationEmbeddings([...near.map((o, i) => ({ id: o.id, vec: [1, i / 1000, 0, 0], model: 'm' })), ...far.map((o) => ({ id: o.id, vec: [0, 0, 0, 1], model: 'm' }))]);
        const hits = s.searchObservationsVector([1, 0, 0, 0], { projectId: p1.id, type: 'bugfix', limit: 5 });
        expect(hits.map((h) => h.id).sort()).toEqual(far.map((o) => o.id).sort());
        expect(s.searchObservationsVector([1, 0, 0, 0], { projectId: p1.id, type: 'refactor', limit: 5 })).toEqual([]);
      });

      it('vector search honours type, userId and since filters', () => {
        const { p1, a1 } = setup();
        const a = obs({ projectId: p1.id, sessionId: a1.id, type: 'bugfix', userId: 'alice', createdAt: '2026-01-01T00:00:00Z' });
        const b = obs({ projectId: p1.id, sessionId: a1.id, type: 'decision', userId: 'bob', createdAt: '2026-02-01T00:00:00Z' });
        s.insertObservations([a, b]);
        s.setObservationEmbedding(a.id, [1, 0, 0, 0], 'm'); s.setObservationEmbedding(b.id, [0, 1, 0, 0], 'm');
        const ids = (f: object) => s.searchObservationsVector([1, 0, 0, 0], { projectId: p1.id, limit: 10, ...f }).map((h) => h.id).sort();
        expect(ids({})).toEqual([a.id, b.id].sort());
        expect(ids({ type: 'decision' })).toEqual([b.id]);
        expect(ids({ type: 'bugfix' })).toEqual([a.id]);
        expect(ids({ userId: 'alice' })).toEqual([a.id]);
        expect(ids({ userId: 'nobody' })).toEqual([]);
        expect(ids({ since: '2026-01-15T00:00:00Z' })).toEqual([b.id]);
      });

      it('fts search honours userId filter', () => {
        const { p1, a1 } = setup();
        s.insertObservations([
          obs({ projectId: p1.id, sessionId: a1.id, userId: 'alice', title: 'shared widget' }),
          obs({ projectId: p1.id, sessionId: a1.id, userId: 'bob', title: 'shared widget' }),
        ]);
        expect(s.searchObservationsFts('widget', { projectId: p1.id, limit: 10 })).toHaveLength(2);
        expect(s.searchObservationsFts('widget', { projectId: p1.id, userId: 'alice', limit: 10 })).toHaveLength(1);
        expect(s.searchObservationsFts('widget', { projectId: p1.id, userId: 'zed', limit: 10 })).toHaveLength(0);
      });

      it('summaries fts honours userId and since filters', () => {
        const { p1, a1 } = setup();
        const mk = (userId: string, createdAt: string): Summary => ({ id: newId(), projectId: p1.id, sessionId: a1.id, userId, request: 'refactor gizmo', learned: '', completed: '', nextSteps: '', createdAt, origin: 'local', syncedAt: null });
        s.insertSummaries([mk('alice', '2026-01-01T00:00:00Z'), mk('bob', '2026-03-01T00:00:00Z')]);
        expect(s.searchSummariesFts('gizmo', { projectId: p1.id, limit: 10 })).toHaveLength(2);
        expect(s.searchSummariesFts('gizmo', { projectId: p1.id, userId: 'bob', limit: 10 })).toHaveLength(1);
        expect(s.searchSummariesFts('gizmo', { projectId: p1.id, since: '2026-02-01T00:00:00Z', limit: 10 })).toHaveLength(1);
      });

      it('summaries sync bookkeeping: unsynced, markSynced, relink reset', () => {
        const { p1, a1 } = setup();
        const sm: Summary = { id: newId(), projectId: p1.id, sessionId: a1.id, userId: 'local', request: 'r', learned: '', completed: '', nextSteps: '', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null };
        const hubSm: Summary = { ...sm, id: newId(), userId: 'bob', origin: 'hub', syncedAt: 'pulled' };
        s.insertSummaries([sm, hubSm]);
        expect(s.listUnsynced('summaries', p1.id, 10).map((x) => x.id)).toEqual([sm.id]);
        s.markSynced('summaries', [sm.id], '2026-01-01T00:00:00Z');
        expect(s.listUnsynced('summaries', p1.id, 10)).toHaveLength(0);
        s.resetProjectSync(p1.id);
        expect(s.listUnsynced('summaries', p1.id, 10).map((x) => x.id)).toEqual([sm.id]);
      });
    });
  });
}
