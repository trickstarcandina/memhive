import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { Observer } from '../../src/observer/observer.js';
import { ProviderError } from '../../src/providers/types.js';
import { createDaemonContext } from '../../src/daemon/server.js';
import { handleRoute } from '../../src/daemon/routes.js';
import { obs, sess } from './store-contract.js';
import { deadUrl } from '../helpers/closed-port.js';

const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'm.db');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
function seed(s: SqliteStore, n = 1) {
  const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
  const rows = Array.from({ length: n }, (_, i) => obs({ projectId: p.id, sessionId: a.id, title: `t${i}`, createdAt: new Date(Date.now() - i * 1000).toISOString() }));
  s.insertObservations(rows); return { p, rows };
}

describe('embeddings: model and dims bookkeeping', () => {
  it('a model change at the same dims resets the vector table and re-queues every row', () => {
    const f = file();
    let s = new SqliteStore(f, { dims: 2, model: 'a' }); s.migrate();
    const { p, rows: [o] } = seed(s); s.setObservationEmbedding(o.id, [1, 0], 'a');
    expect(s.listMissingEmbedding(10, 'a')).toEqual([]); s.close();
    s = new SqliteStore(f, { dims: 2, model: 'a' }); s.migrate();
    expect(s.searchObservationsVector([1, 0], { projectId: p.id, limit: 1 })).toHaveLength(1); s.close();   // same model: kept
    s = new SqliteStore(f, { dims: 2, model: 'b' }); s.migrate();
    expect(s.searchObservationsVector([1, 0], { projectId: p.id, limit: 1 })).toEqual([]);
    expect(s.listMissingEmbedding(10, 'b').map((x) => x.id)).toEqual([o.id]);
    expect(s.getObservations([o.id])[0].embeddingModel).toBeNull();
    s.close();
  });
  it('a table from before the model was recorded resets only if its rows name another model', () => {
    const f = file();
    let s = new SqliteStore(f, { dims: 2 }); s.migrate();
    const { p, rows: [o] } = seed(s); s.setObservationEmbedding(o.id, [1, 0], 'old'); s.close();
    s = new SqliteStore(f, { dims: 2, model: 'old' }); s.migrate();
    expect(s.searchObservationsVector([1, 0], { projectId: p.id, limit: 1 })).toHaveLength(1); s.close();
    const raw = new Database(f); raw.prepare("DELETE FROM vec_meta WHERE k = 'model'").run(); raw.close();
    s = new SqliteStore(f, { dims: 2, model: 'new' }); s.migrate();
    expect(s.searchObservationsVector([1, 0], { projectId: p.id, limit: 1 })).toEqual([]);
    s.close();
  });
  it('listMissingEmbedding also matches rows embedded with another model, NULLs first, and honours exclude', () => {
    const s = new SqliteStore(':memory:', { dims: null }); s.migrate();
    const { rows } = seed(s, 3);
    s.setObservationEmbedding(rows[0].id, [], 'other'); s.setObservationEmbedding(rows[1].id, [], 'cur');
    expect(s.listMissingEmbedding(10, 'cur').map((x) => x.id)).toEqual([rows[2].id, rows[0].id]);
    expect(s.listMissingEmbedding(10).map((x) => x.id)).toEqual([rows[2].id]);
    expect(s.listMissingEmbedding(10, 'cur', [rows[2].id]).map((x) => x.id)).toEqual([rows[0].id]);
    s.close();
  });
  it('the missing-embedding query uses the partial index; synchronous is NORMAL', () => {
    const s = new SqliteStore(file(), { dims: null }); s.migrate();
    const db = (s as any).db as Database.Database;
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM observations WHERE embedding_model IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 5').all().map((r: any) => r.detail).join(' ');
    expect(plan).toContain('USING INDEX observations_missing_embedding'); expect(plan).not.toContain('TEMP B-TREE');
    const stale = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM observations WHERE (embedding_model < ? OR embedding_model > ?) ORDER BY created_at DESC LIMIT 5').all('m', 'm').map((r: any) => r.detail).join(' ');
    expect(stale).not.toMatch(/SCAN observations(?! USING)/);
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    s.close();
  });
  it('setObservationEmbeddings writes a batch in one transaction: a bad row writes none', () => {
    const s = new SqliteStore(':memory:', { dims: 2, model: 'm' }); s.migrate();
    const { rows } = seed(s, 2);
    expect(() => s.setObservationEmbeddings([{ id: rows[0].id, vec: [1, 0], model: 'm' }, { id: rows[1].id, vec: [1, 0, 0], model: 'm' }])).toThrow(/dims/);
    expect(s.listMissingEmbedding(10, 'm')).toHaveLength(2);
    s.setObservationEmbeddings(rows.map((o) => ({ id: o.id, vec: [0, 1], model: 'm' })));
    expect(s.listMissingEmbedding(10, 'm')).toHaveLength(0);
    s.close();
  });
});

describe('embeddings: backfill', () => {
  it('runs batches back to back, at most one per interval, until nothing is left', async () => {
    vi.useFakeTimers();
    try {
      const s = new SqliteStore(':memory:', { dims: 2, model: 'm' }); s.migrate(); seed(s, 10);
      const embed = vi.fn(async (t: string[]) => t.map(() => [1, 0]));
      const o = new Observer({ store: s, provider: { complete: async () => '' }, embedder: { model: 'm', dims: 2, embed }, logger: silent });
      const done = o.backfill({ batch: 4, minIntervalMs: 1000 });
      await vi.advanceTimersByTimeAsync(0);
      expect(s.listMissingEmbedding(20, 'm')).toHaveLength(6);   // first batch at once
      await vi.advanceTimersByTimeAsync(999);
      expect(s.listMissingEmbedding(20, 'm')).toHaveLength(6);   // rate cap
      await vi.advanceTimersByTimeAsync(1);
      expect(s.listMissingEmbedding(20, 'm')).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1000); await done;
      expect(s.listMissingEmbedding(20, 'm')).toHaveLength(0);
      s.close();
    } finally { vi.useRealTimers(); }
  });
  it('stops on a failing batch and skips ids that failed 3 times', async () => {
    const s = new SqliteStore(':memory:', { dims: 2, model: 'm' }); s.migrate(); const { rows } = seed(s, 2);
    const bad = rows[0].id;
    const embed = vi.fn(async (t: string[]) => { if (t.some((x) => x.startsWith('t0'))) throw new Error('nope'); return t.map(() => [1, 0]); });
    const o = new Observer({ store: s, provider: { complete: async () => '' }, embedder: { model: 'm', dims: 2, embed }, logger: silent });
    await o.backfill({ batch: 10, minIntervalMs: 0 });
    expect(s.listMissingEmbedding(10, 'm').map((x) => x.id)).toEqual([bad]);   // batch failed, then the good row went alone
    for (let i = 0; i < 2; i++) await o.backfill({ batch: 10, minIntervalMs: 0 });
    const calls = embed.mock.calls.length;
    await o.backfill({ batch: 10, minIntervalMs: 0 });
    expect(embed.mock.calls.length).toBe(calls);   // failed alone 3 times: skipped from now on
    expect(await o.embedMissing(10)).toBe(0);
    s.close();
  });
  it('an embedder outage (transport error) books no failures and stops at the first batch', async () => {
    const s = new SqliteStore(':memory:', { dims: 2, model: 'm' }); s.migrate(); seed(s, 40);
    let up = false;
    const embed = vi.fn(async (t: string[]) => { if (!up) throw new ProviderError('connect ECONNREFUSED', 'transport'); return t.map(() => [1, 0]); });
    const o = new Observer({ store: s, provider: { complete: async () => '' }, embedder: { model: 'm', dims: 2, embed }, logger: silent });
    for (let i = 0; i < 4; i++) await o.backfill({ batch: 64, minIntervalMs: 0 });
    expect(embed).toHaveBeenCalledTimes(4);   // one call per run, no row-by-row retries
    up = true; expect(await o.embedMissing(100)).toBe(40);   // nobody was skipped
    s.close();
  });
  it('/v1/embed with rebuild drops vectors and embeds everything again', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const ctx = createDaemonContext(home, { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' });
    const embed = vi.fn(async (t: string[]) => t.map(() => [1])); (ctx.observer as any).deps.embedder = { model: 'm', dims: 1, embed };
    const { rows } = seed(ctx.store as SqliteStore, 3);
    for (const o of rows) ctx.store.setObservationEmbedding(o.id, [], 'm');
    expect((await handleRoute(ctx, 'POST', new URL('http://x/v1/embed'), {})).body).toEqual({ embedded: 0 });
    expect((await handleRoute(ctx, 'POST', new URL('http://x/v1/embed'), { rebuild: true })).body).toEqual({ embedded: 3 });
    ctx.store.close();
  });
});
