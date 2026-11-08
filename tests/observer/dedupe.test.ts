import { describe, it, expect, vi } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { Observer, type SessionCtx } from '../../src/observer/observer.js';
import { obs, sess } from '../store/store-contract.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const tool = { name: 'Edit', input: { f: 'a' }, output: 'ok', at: new Date().toISOString() };
const reply = (o: object[]) => JSON.stringify({ observations: o });

function setup(answers: string[], embedder: any = null) {
  const store = new SqliteStore(':memory:', { dims: embedder ? 2 : null, model: embedder?.model }); store.migrate();
  const p = store.getOrCreateProject('k', 'proj'); const s = sess(p.id); store.upsertSession(s);
  const ctx: SessionCtx = { sessionId: s.id, projectId: p.id, projectName: 'proj', userId: 'local' };
  const complete = vi.fn(async () => answers.shift() ?? reply([]));
  const observer = new Observer({ store, provider: { complete }, embedder, logger: silent }, { flushCount: 1 });
  const run = async () => { observer.onTool(ctx, tool); await observer.flushAll(); await new Promise((r) => setTimeout(r, 0)); await observer.flushAll(); };
  return { store, ctx, p, s, run };
}

describe('observation dedupe', () => {
  it('the same observation twice gives one row with seen_count 2', async () => {
    const same = { type: 'decision', title: 'Use pnpm workspaces for the monorepo', facts: ['x'] };
    const t = setup([reply([same]), reply([same])]);
    await t.run(); await t.run();
    const rows = t.store.listRecentObservations(t.p.id, 10);
    expect(rows).toHaveLength(1); expect(rows[0].seenCount).toBe(2); expect(rows[0].lastSeenAt).not.toBeNull();
  });
  it('another type, a title with new words, or an old row is not a duplicate', async () => {
    const t = setup([reply([{ type: 'bugfix', title: 'Use pnpm workspaces' }, { type: 'decision', title: 'Use pnpm workspaces and turbo' }])]);
    t.store.insertObservations([obs({ projectId: t.p.id, sessionId: t.s.id, type: 'decision', title: 'Use pnpm workspaces' }), obs({ projectId: t.p.id, sessionId: t.s.id, type: 'bugfix', title: 'Use pnpm workspaces', createdAt: new Date(Date.now() - 40 * 864e5).toISOString() })]);
    await t.run();
    expect(t.store.countObservations(t.p.id)).toBe(4);
  });
  it('a near-identical vector (cosine >= 0.92) is a duplicate even with other words', async () => {
    const embedder = { model: 'm', dims: 2, embed: vi.fn(async (x: string[]) => x.map((s) => (s.startsWith('Totally') ? [1, 0.1] : [1, 0]))) };
    const t = setup([reply([{ type: 'discovery', title: 'Config lives in settings.json' }]), reply([{ type: 'discovery', title: 'Totally different words here' }])], embedder);
    await t.run(); await t.run();
    const rows = t.store.listRecentObservations(t.p.id, 10);
    expect(rows).toHaveLength(1); expect(rows[0].seenCount).toBe(2);
  });
});
