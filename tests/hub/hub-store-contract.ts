import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HubDimsMismatch } from '../../src/hub/store/types.js';
import type { HubStore, HubObservation } from '../../src/hub/store/types.js';
import type { Session, Summary } from '../../src/store/types.js';
import { newId } from '../../src/shared/ids.js';
import { handleHubRoute } from '../../src/hub/routes.js';

export const hobs = (p: Partial<HubObservation> & { projectId: string; sessionId: string }): HubObservation => ({
  id: newId(), userId: 'alice', type: 'discovery', title: 'T', subtitle: '', facts: ['f'], narrative: '', concepts: [], filesRead: [], filesModified: [],
  createdAt: new Date().toISOString(), embeddingModel: null, origin: 'local', syncedAt: null, embedding: null, ...p,
});
export const hsess = (projectId: string, p: Partial<Session> = {}): Session => ({ id: newId(), projectId, userId: 'alice', host: 'claude-code', hostSessionId: 'h' + Math.random(), cwd: '/w', startedAt: new Date().toISOString(), endedAt: null, syncedAt: null, ...p });

export function hubStoreContract(name: string, open: () => Promise<HubStore>, opts: { dims?: number | null } = {}): void {
  describe(`${name} hub store`, () => {
    let s: HubStore;
    beforeEach(async () => { s = await open(); await s.migrate(); });
    afterEach(async () => { await s.close(); });

    it('projects', async () => {
      const p = await s.getOrCreateProject('github.com/a/b', 'b');
      expect((await s.getOrCreateProject('github.com/a/b', 'x')).id).toBe(p.id);
      expect(await s.getProjectByKey('nope')).toBeNull();
    });

    it('sessions upsert twice without duplication', async () => {
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id);
      expect(await s.upsertSessions([a])).toEqual([a.id]);
      await s.upsertSessions([{ ...a, endedAt: '2026-01-01T00:00:00.000Z' }]);
      const got = await s.getSessions([a.id]);
      expect(got).toHaveLength(1); expect(got[0].endedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('observations with and without vectors, duplicates ignored', async () => {
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      const o1 = hobs({ projectId: p.id, sessionId: a.id, title: 'with vec', embedding: [1, 0, 0, 0], embeddingModel: 'm' });
      const o2 = hobs({ projectId: p.id, sessionId: a.id, title: 'no vec' });
      expect(await s.insertObservations([o1, o2])).toEqual([o1.id, o2.id]);
      expect(await s.insertObservations([o1])).toEqual([]);
      const got = await s.getObservations([o2.id, o1.id]);
      expect(got.map((o) => o.title)).toEqual(['no vec', 'with vec']);
      expect(got[1].embedding).toEqual([1, 0, 0, 0]); expect(got[0].embedding).toBeNull();
    });

    it('summaries', async () => {
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      const sm: Summary = { id: newId(), projectId: p.id, sessionId: a.id, userId: 'alice', request: 'r', learned: '', completed: '', nextSteps: '', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null };
      expect(await s.insertSummaries([sm, sm])).toEqual([sm.id]);
      expect((await s.getSummaries([sm.id]))[0].request).toBe('r');
    });

    it('sync log is written atomically and idempotently', async () => {
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id);
      const o = hobs({ projectId: p.id, sessionId: a.id });
      const sm: Summary = { id: newId(), projectId: p.id, sessionId: a.id, userId: 'alice', request: 'r', learned: '', completed: '', nextSteps: '', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null };
      const push = async () => [await s.upsertSessions([a]), await s.insertObservations([o]), await s.insertSummaries([sm])];
      expect(await push()).toEqual([[a.id], [o.id], [sm.id]]);
      const first = await s.listSyncLog(p.id, 0, 10);
      expect(first.map((e) => [e.table, e.rowId])).toEqual([['sessions', a.id], ['observations', o.id], ['summaries', sm.id]]);
      expect(first[0].seq).toBeLessThan(first[2].seq);
      expect(await push()).toEqual([[], [], []]);
      expect(await s.listSyncLog(p.id, 0, 10)).toEqual(first);
      expect(await s.maxSeq(p.id)).toBe(first[2].seq);
      expect((await s.listSyncLog(p.id, first[0].seq, 10)).map((e) => e.rowId)).toEqual([o.id, sm.id]);
      expect(await s.listSyncLog(p.id, 10_000, 10)).toEqual([]);
      expect(await s.listSyncLog(p.id, 0, 1)).toHaveLength(1);
      const q = await s.getOrCreateProject('k2', 'n2');
      expect(await s.listSyncLog(q.id, 0, 10)).toEqual([]);
      expect(await s.maxSeq(q.id)).toBe(0);
    });

    it('same session from two machines: one row, one log entry per real change', async () => {
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id);
      await s.upsertSessions([a]);
      expect(await s.upsertSessions([a])).toEqual([]);
      expect(await s.upsertSessions([{ ...a, endedAt: '2026-01-02T00:00:00.000Z' }])).toEqual([a.id]);
      expect(await s.upsertSessions([{ ...a, endedAt: '2026-01-01T00:00:00.000Z' }])).toEqual([]); // older end does not win
      expect((await s.getSessions([a.id]))[0].endedAt).toBe('2026-01-02T00:00:00.000Z');
      expect(await s.upsertSessions([{ ...a, userId: 'mallory', endedAt: '2026-02-01T00:00:00.000Z' }])).toEqual([]); // foreign owner ignored
      expect((await s.getSessions([a.id]))[0].userId).toBe('alice');
      expect(await s.listSyncLog(p.id, 0, 10)).toHaveLength(2);
    });

    it.skipIf(opts.dims === null)('dims mismatch rejects only that row', async () => {
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      const bad = hobs({ projectId: p.id, sessionId: a.id, embedding: [1, 2], embeddingModel: 'm' });
      const good = hobs({ projectId: p.id, sessionId: a.id, embedding: [1, 0, 0, 0], embeddingModel: 'm' });
      const err = await s.insertObservations([bad, good]).catch((e) => e);
      expect(err).toBeInstanceOf(HubDimsMismatch); expect(err.rowId).toBe(bad.id); expect(err.inserted).toEqual([good.id]);
      expect(await s.getObservations([bad.id, good.id])).toHaveLength(1);
      expect((await s.listSyncLog(p.id, 0, 10)).map((e) => e.rowId)).toEqual([a.id, good.id]);
    });

    it('concurrent getOrCreateProject yields one project', async () => {
      const [x, y] = await Promise.all([s.getOrCreateProject('k', 'n'), s.getOrCreateProject('k', 'n')]);
      expect(x.id).toBe(y.id);
    });

    it('fts search', async () => {
      const p = await s.getOrCreateProject('k', 'n'); const a = hsess(p.id); await s.upsertSessions([a]);
      await s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, title: 'Rotate JWT secret', type: 'decision' })]);
      expect(await s.searchObservationsFts('jwt', { projectId: p.id, limit: 5 })).toHaveLength(1);
      expect(await s.searchObservationsFts('jwt', { projectId: p.id, type: 'bugfix', limit: 5 })).toHaveLength(0);
      expect(Array.isArray(await s.searchObservationsFts('a: "b" OR * ) ( NEAR', { projectId: p.id, limit: 5 }))).toBe(true);
    });

    it('push route: rows the DB would refuse are rejected per row (invalid_row), NUL is stripped, never a 500', async () => {
      const cfg = { port: 0, embeddingModel: null, embeddingDims: null, bodyLimit: 1 };
      const route = (body: unknown) => handleHubRoute(s, cfg, { keyId: 'k', userName: 'alice' }, 'POST', new URL('http://h/v1/sync/push'), body);
      const good = hsess('x'); const noHost = { ...hsess('x'), host: undefined }; const badStart = hsess('x', { startedAt: 'yesterday' });
      const ok1 = hobs({ projectId: 'x', sessionId: good.id, title: 'nul\u0000title', facts: ['a\u0000b'] });
      const badTime = hobs({ projectId: 'x', sessionId: good.id, createdAt: '2026-13-45 nope' });
      const badFacts = { ...hobs({ projectId: 'x', sessionId: good.id }), facts: 'x' };
      const sumBad: Summary = { id: newId(), projectId: 'x', sessionId: good.id, userId: 'u', request: 'r', learned: '', completed: '', nextSteps: '', createdAt: 'not-a-date', origin: 'local', syncedAt: null };
      const r = await route({ projectKey: 'k/v', projectName: 'v', sessions: [good, noHost, badStart], observations: [ok1, badTime, badFacts], summaries: [sumBad] });
      expect(r.status).toBe(200);
      const body = r.body as { accepted: Record<string, number>; rejected: Array<{ id: string; reason: string }> };
      expect(body.accepted).toEqual({ sessions: 1, observations: 1, summaries: 0 });
      expect(body.rejected.filter((x) => x.reason === 'invalid_row').map((x) => x.id).sort()).toEqual([noHost.id, badStart.id, badTime.id, badFacts.id, sumBad.id].sort());
      const [stored] = await s.getObservations([ok1.id]);
      expect(stored.title).toBe('nultitle'); expect(stored.facts).toEqual(['ab']);
      const search = await handleHubRoute(s, cfg, { keyId: 'k', userName: 'alice' }, 'GET', new URL('http://h/v1/search?project_key=k%2Fv&q=nultitle&since=garbage'), undefined);
      expect((search.body as { observations: unknown[] }).observations).toHaveLength(1);   // a malformed since is ignored, not passed to the DB
    });

    it('rotate, list and remove users, list projects', async () => {
      await s.createUser('alice'); await s.createUser('bob');
      const k = await s.createApiKey('alice', 'laptop', 'h1'); await s.createApiKey('bob', 'desk', 'h2');
      const n = await s.rotateApiKey(k.id, 'h3');
      expect(n).toMatchObject({ userName: 'alice', label: 'laptop', revokedAt: null }); expect(n!.id).not.toBe(k.id);
      expect(await s.authenticate('h1')).toBeNull(); expect(await s.authenticate('h3')).toEqual({ keyId: n!.id, userName: 'alice' });
      expect(await s.rotateApiKey(k.id, 'h4')).toBeNull(); expect(await s.authenticate('h4')).toBeNull();
      const p = await s.getOrCreateProject('github.com/a/b', 'b'); await s.getOrCreateProject('github.com/a/empty', 'empty');
      const a = hsess(p.id, { startedAt: '2026-03-01T00:00:00.000Z', endedAt: '2026-03-02T00:00:00.000Z' }); await s.upsertSessions([a]);
      await s.insertObservations([hobs({ projectId: p.id, sessionId: a.id, createdAt: '2026-03-01T10:00:00.000Z' }), hobs({ projectId: p.id, sessionId: a.id, createdAt: '2026-03-01T11:00:00.000Z' })]);
      const users = await s.listUsers();
      expect(users.map((u) => [u.name, u.activeKeys, u.observations])).toEqual([['alice', 1, 2], ['bob', 1, 0]]);
      expect(users[0].lastSeen).toBe('2026-03-02T00:00:00.000Z'); expect(users[1].lastSeen).toBeNull();
      const projects = await s.listProjects();
      expect(projects.map((x) => [x.key, x.observations, x.sessions, x.summaries])).toEqual([['github.com/a/b', 2, 1, 0], ['github.com/a/empty', 0, 0, 0]]);
      expect(projects[0].lastActivity).toBe('2026-03-01T11:00:00.000Z'); expect(projects[1].lastActivity).toBeNull();
      await s.createApiKey('alice', 'second', 'h5');
      expect(await s.removeUser('alice')).toEqual({ revokedKeys: 2, observations: 2, sessions: 1, summaries: 0 });
      expect(await s.authenticate('h3')).toBeNull(); expect(await s.authenticate('h5')).toBeNull(); expect(await s.authenticate('h2')).not.toBeNull();
      expect(await s.getObservations((await s.listSyncLog(p.id, 0, 10)).filter((e) => e.table === 'observations').map((e) => e.rowId))).toHaveLength(2);   // rows stay
      expect(await s.removeUser('nobody')).toBeNull();
    });

    it('users and keys', async () => {
      expect(await s.countUsers()).toBe(0);
      await s.createUser('alice'); await s.createUser('alice');
      expect(await s.countUsers()).toBe(1);
      const k = await s.createApiKey('alice', 'laptop', 'hash1');
      expect(await s.authenticate('hash1')).toEqual({ keyId: k.id, userName: 'alice' });
      expect(await s.authenticate('nope')).toBeNull();
      expect((await s.listApiKeys()).map((x) => x.label)).toEqual(['laptop']);
      expect(await s.revokeApiKey(k.id)).toBe(true);
      expect(await s.revokeApiKey(k.id)).toBe(false);
      expect(await s.authenticate('hash1')).toBeNull();
    });
  });
}
