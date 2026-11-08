import { describe, it, expect } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { runMaintenance } from '../../src/daemon/maintenance.js';
import { newId } from '../../src/shared/ids.js';
import { sess } from '../store/store-contract.js';

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
