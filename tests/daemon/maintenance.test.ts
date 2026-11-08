import { describe, it, expect } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { runMaintenance } from '../../src/daemon/maintenance.js';
import { newId } from '../../src/shared/ids.js';
import { obs, sess } from '../store/store-contract.js';

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as never;
const DAY = 864e5;

describe('maintenance: prompts', () => {
  it('keeps the last 5 prompts per session and drops prompts of sessions ended over 7 days ago', () => {
    const store = new SqliteStore(':memory:', { dims: null }); store.migrate();
    const p = store.getOrCreateProject('k', 'n'); const now = Date.now();
    const live = sess(p.id); const old = sess(p.id); const recent = sess(p.id);
    for (const s of [live, old, recent]) store.upsertSession(s);
    store.endSession(old.id, new Date(now - 8 * DAY).toISOString());
    store.endSession(recent.id, new Date(now - 2 * DAY).toISOString());
    const add = (sid: string, i: number) => store.insertPrompt({ id: newId(), sessionId: sid, text: `p${i}`, createdAt: new Date(now - (100 - i) * 1000).toISOString() });
    for (let i = 0; i < 8; i++) add(live.id, i);
    add(old.id, 1); add(recent.id, 1);
    runMaintenance({ store, logger }, now);
    const db = (store as any).db;
    const texts = (sid: string) => db.prepare('SELECT text FROM prompts WHERE session_id = ? ORDER BY created_at').all(sid).map((r: any) => r.text);
    expect(texts(live.id)).toEqual(['p3', 'p4', 'p5', 'p6', 'p7']);
    expect(texts(old.id)).toEqual([]); expect(texts(recent.id)).toEqual(['p1']);
    expect(store.latestPrompt(live.id)!.text).toBe('p7');
    store.close();
  });
});

describe('maintenance: retention', () => {
  it('expires by type (else default), never pinned rows, and only rows nothing in a hub still needs', () => {
    const store = new SqliteStore(':memory:', { dims: 2, model: 'm' }); store.migrate();
    const now = Date.now(); const ago = (d: number) => new Date(now - d * DAY).toISOString();
    const local = store.getOrCreateProject('local', 'l'); const linked = store.getOrCreateProject('linked', 'k'); store.setProjectHub(linked.id, 'https://hub');
    const a = sess(local.id); const b = sess(linked.id); store.upsertSession(a); store.upsertSession(b);
    const mk = (p: string, s: string, title: string, type: any, days: number, extra: object = {}) => ({ ...obs({ projectId: p, sessionId: s, title, type, createdAt: ago(days) }), ...extra });
    const rows = [
      mk(local.id, a.id, 'old-discovery', 'discovery', 200), mk(local.id, a.id, 'young-discovery', 'discovery', 100),
      mk(local.id, a.id, 'old-decision', 'decision', 400), mk(local.id, a.id, 'pinned', 'discovery', 400),
      mk(local.id, a.id, 'seen-lately', 'discovery', 400, { lastSeenAt: ago(1) }),
      mk(linked.id, b.id, 'linked-unsynced', 'discovery', 400), mk(linked.id, b.id, 'linked-synced', 'discovery', 400, { syncedAt: ago(399) }),
    ];
    store.insertObservations(rows);
    store.setObservationEmbedding(rows[0].id, [1, 0], 'm');
    (store as any).db.prepare('UPDATE observations SET last_seen_at = ? WHERE title = ?').run(ago(1), 'seen-lately');
    expect(store.setPinned(rows[3].id, true)).toBe(true); expect(store.setPinned('nope', true)).toBe(false);
    runMaintenance({ store, logger, settings: { retentionDays: { default: 365, discovery: 180 } } }, now);
    const left = store.listRecentObservations(local.id, 20).concat(store.listRecentObservations(linked.id, 20)).map((o) => o.title).sort();
    expect(left).toEqual(['linked-unsynced', 'pinned', 'seen-lately', 'young-discovery']);
    expect(store.getObservationEmbeddings([rows[0].id]).size).toBe(0);
    runMaintenance({ store, logger, settings: { retentionDays: { default: null } } }, now + 1000 * DAY);
    expect(store.countObservations(local.id)).toBe(3);   // default null keeps everything
    store.close();
  });
});

it('a fresh daemon with default settings never deletes rows', async () => {
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const { createDaemonContext } = await import('../../src/daemon/server.js');
  const ctx = createDaemonContext(mkdtempSync(path.join(tmpdir(), 'mh-')), { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' });
  const p = ctx.store.getOrCreateProject('k', 'n'); const a = sess(p.id); ctx.store.upsertSession(a);
  ctx.store.insertObservations((['discovery', 'decision', 'bugfix'] as const).map((type) => obs({ projectId: p.id, sessionId: a.id, type, title: type, createdAt: new Date(Date.now() - 5 * 365 * DAY).toISOString() })));
  runMaintenance(ctx);
  expect(ctx.store.countObservations(p.id)).toBe(3);
  ctx.store.close();
});

it('retention deletes at most maxChunks x 500 rows per call', () => {
  const store = new SqliteStore(':memory:', { dims: null }); store.migrate();
  const p = store.getOrCreateProject('k', 'n'); const a = sess(p.id); store.upsertSession(a);
  store.insertObservations(Array.from({ length: 1200 }, () => obs({ projectId: p.id, sessionId: a.id, createdAt: new Date(Date.now() - 400 * DAY).toISOString() })));
  const cut = { discovery: new Date(Date.now() - 365 * DAY).toISOString() };
  expect(store.deleteExpired(cut, 1)).toBe(500); expect(store.deleteExpired(cut)).toBe(700);
  store.close();
});
