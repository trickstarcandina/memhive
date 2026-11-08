import { describe, it, expect, beforeEach } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { obs, sess } from './store-contract.js';
import type { Summary } from '../../src/store/types.js';

const f = (projectId: string) => ({ projectId, limit: 10 });
const summary = (projectId: string, sessionId: string, request: string): Summary => ({ id: crypto.randomUUID(), projectId, sessionId, userId: 'local', request, learned: '', completed: '', nextSteps: '', createdAt: new Date().toISOString(), origin: 'local', syncedAt: null });

describe('forget in the local store', () => {
  let s: SqliteStore; let pid: string; let sid: string;
  beforeEach(() => {
    s = new SqliteStore(':memory:', { dims: 2, model: 'm' }); s.migrate();
    pid = s.getOrCreateProject('github.com/t/f', 'f').id;
    const x = sess(pid); s.upsertSession(x); sid = x.id;
  });

  it('deleteObservations removes the row, its FTS entry and vector, and queues a tombstone', () => {
    const o = obs({ projectId: pid, sessionId: sid, title: 'walrus migration' }); s.insertObservations([o]); s.setObservationEmbedding(o.id, [1, 0], 'm');
    expect(s.searchObservationsFts('walrus', f(pid))).toHaveLength(1);
    expect(s.deleteObservations([o.id, 'not-there'])).toBe(1);
    expect(s.getObservations([o.id])).toEqual([]);
    expect(s.searchObservationsFts('walrus', f(pid))).toEqual([]);
    expect(s.searchObservationsVector([1, 0], f(pid))).toEqual([]);
    expect(s.listPendingTombstones(pid, 10)).toEqual([{ id: o.id, tbl: 'observation', deletedAt: expect.any(String) }]);
    expect(s.forgottenIds(pid, 'observation', [o.id, 'not-there'])).toEqual(new Set([o.id]));
    expect(s.forgottenIds(pid, 'observation', [o.id.toUpperCase()])).toEqual(new Set([o.id.toUpperCase()]));
    s.markTombstonesSynced(pid, [o.id], new Date().toISOString());
    expect(s.listPendingTombstones(pid, 10)).toEqual([]);
    expect(s.forgottenIds(pid, 'observation', [o.id]).size).toBe(1);   // still remembered after it was pushed
  });

  it('deleteSummaries removes the FTS entry (new delete trigger)', () => {
    const m = summary(pid, sid, 'narwhal rollout'); s.insertSummaries([m]);
    expect(s.searchSummariesFts('narwhal', f(pid))).toHaveLength(1);
    expect(s.deleteSummaries([m.id])).toBe(1);
    expect(s.searchSummariesFts('narwhal', f(pid))).toEqual([]);
    expect(s.listPendingTombstones(pid, 10).map((t) => t.tbl)).toEqual(['summary']);
  });

  it('deleteSession cascades to observations, summaries and prompts; only the session tombstone is pushed', () => {
    const o = obs({ projectId: pid, sessionId: sid }); s.insertObservations([o]);
    const m = summary(pid, sid, 'x'); s.insertSummaries([m]);
    s.insertPrompt({ id: crypto.randomUUID(), sessionId: sid, text: 'p', createdAt: new Date().toISOString() });
    expect(s.deleteSession(sid)).toBe(1);
    expect(s.getSession(sid)).toBeNull(); expect(s.getObservations([o.id])).toEqual([]); expect(s.getSummaries([m.id])).toEqual([]);
    expect(s.latestPrompt(sid)).toBeNull();
    expect(s.listPendingTombstones(pid, 10)).toEqual([{ id: sid, tbl: 'session', deletedAt: expect.any(String) }]);
    expect([s.forgottenIds(pid, 'session', [sid]).size, s.forgottenIds(pid, 'observation', [o.id]).size, s.forgottenIds(pid, 'summary', [m.id]).size]).toEqual([1, 1, 1]);
    expect(s.forgottenIds(pid, 'observation', [sid]).size).toBe(0);   // per table: the session id hides no observation
  });

  it('a remembered-only delete (pulled tombstone, forced removal) is never pushed and respects the project', () => {
    const other = s.getOrCreateProject('github.com/t/other', 'other').id;
    const o = obs({ projectId: pid, sessionId: sid }); s.insertObservations([o]);
    const at = new Date().toISOString();
    expect(s.deleteObservations([o.id], { syncedAt: at, projectId: other })).toBe(0);   // another project's tombstone cannot touch it
    expect(s.getObservations([o.id])).toHaveLength(1);
    const ghost = crypto.randomUUID();
    expect(s.deleteObservations([o.id, ghost], { syncedAt: at, projectId: pid })).toBe(1);
    expect(s.listPendingTombstones(pid, 10)).toEqual([]);
    expect(s.forgottenIds(pid, 'observation', [o.id, ghost]).size).toBe(2);   // ids with no row are remembered under projectId
  });

  it('a tombstone in one project never blocks or deletes the same id in another', () => {
    const b = s.getOrCreateProject('github.com/t/b', 'b').id; const bs = sess(b); s.upsertSession(bs);
    const o = obs({ projectId: b, sessionId: bs.id }); s.insertObservations([o]);
    s.deleteObservations([o.id], { syncedAt: new Date().toISOString(), projectId: pid });   // project A's pull names B's id
    expect(s.getObservations([o.id])).toHaveLength(1);
    expect(s.forgottenIds(b, 'observation', [o.id]).size).toBe(0);
    expect(s.deleteObservations([o.id])).toBe(1);   // B's own forget still works with A's tombstone present
    expect(s.listPendingTombstones(b, 10).map((t) => t.id)).toEqual([o.id]);
    s.markTombstonesSynced(pid, [o.id], new Date().toISOString());
    expect(s.listPendingTombstones(b, 10)).toHaveLength(1);
  });

  it('forget purges quarantined raw copies; a project reset re-queues every tombstone', () => {
    const o = obs({ projectId: pid, sessionId: sid }); s.insertObservations([o]);
    s.quarantine(pid, [{ id: o.id, tbl: 'observations', seq: 1, reason: 'x', raw: '{"secret":"hunter2"}' }]);
    s.deleteObservations([o.id]);
    expect(s.listQuarantine(pid, 10)).toEqual([]);
    s.markTombstonesSynced(pid, [o.id], new Date().toISOString());
    s.resetProjectSync(pid);
    expect(s.listPendingTombstones(pid, 10).map((t) => t.id)).toEqual([o.id]);
  });

  it('matchIdPrefix is per project and reports every table it matches', () => {
    const o = obs({ projectId: pid, sessionId: sid, id: '0190aaaa-bbbb-7ccc-8ddd-000011112222' }); s.insertObservations([o]);
    const m = summary(pid, sid, 'x'); m.id = '0190aaaa-bbbb-7ccc-8ddd-000033334444'; s.insertSummaries([m]);
    expect(s.matchIdPrefix(pid, '11112222')).toEqual([{ id: o.id, kind: 'observation' }]);
    expect(s.matchIdPrefix(pid, '33334444')).toEqual([{ id: m.id, kind: 'summary' }]);
    expect(s.matchIdPrefix(pid, '0190aaaa')).toHaveLength(2);   // one in each table: ambiguous
    expect(s.matchIdPrefix(s.getOrCreateProject('k/other', 'o').id, '11112222')).toEqual([]);
  });

  it('updateObservation refreshes FTS and drops the vector for re-embedding', () => {
    const o = obs({ projectId: pid, sessionId: sid, title: 'puffin', narrative: 'old' }); s.insertObservations([o]); s.setObservationEmbedding(o.id, [1, 0], 'm');
    expect(s.updateObservation(o.id, { title: 'new heron title', facts: ['a fact'] })).toBe(true);
    const got = s.getObservations([o.id])[0];
    expect(got).toMatchObject({ title: 'new heron title', facts: ['a fact'], narrative: 'old', embeddingModel: null });
    expect(s.searchObservationsFts('heron', f(pid))).toHaveLength(1);
    expect(s.searchObservationsFts('puffin', f(pid))).toEqual([]);
    expect(s.getObservationEmbeddings([o.id]).size).toBe(0);
    expect(s.listMissingEmbedding(10, 'm').map((x) => x.id)).toEqual([o.id]);
    s.setObservationEmbedding(o.id, [1, 0], 'm');
    expect(s.updateObservation(o.id, { pinned: true })).toBe(true);   // pin only: the vector stays
    expect(s.getObservations([o.id])[0]).toMatchObject({ pinned: true, embeddingModel: 'm' });
    expect(s.updateObservation('nope', { title: 'x' })).toBe(false);
  });
});
