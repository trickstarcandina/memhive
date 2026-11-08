import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { readDaemonInfo, writeDaemonInfo } from '../../src/daemon/info.js';
import { SqliteStore } from '../../src/store/sqlite/store.js';
import { projectKeyFor } from '../../src/shared/project-key.js';

const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' };
const until = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 10)); } };

describe('idle shutdown (G10)', () => {
  it('waits for a running summary, then removes daemon.json and the lock and closes the store', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const ctx = createDaemonContext(home, env);
    const summary = JSON.stringify({ request: 'slow summary request', learned: 'l', completed: 'c', next_steps: 'n' });
    (ctx.observer as any).deps.provider = { complete: () => new Promise((r) => setTimeout(() => r(summary), 300)) };
    const h = await startDaemon(ctx, { port: 0, idleMs: 50 });
    const r = ctx.resolveSession({ host: 'claude-code', hostEvent: 'SessionEnd', hostSessionId: 'idle-1', cwd: home, event: 'session-end', at: new Date().toISOString() })!;
    ctx.observer.onPrompt(r.ctx, 'a prompt long enough to be summarized at the end');
    void ctx.observer.onSessionEnd(r.ctx, '2026-11-09T00:00:00.000Z');
    await until(() => !existsSync(path.join(home, 'daemon.json')));
    await h.close();   // the same close the idle timer started
    expect(existsSync(path.join(home, 'daemon.lock'))).toBe(false);
    expect(() => ctx.store.countSessions('x')).toThrow();   // closed
    const s = new SqliteStore(path.join(home, 'memhive.db'), { dims: null }); s.migrate();
    const p = s.getProjectByKey(projectKeyFor(home).key)!;
    expect(s.listRecentSummaries(p.id, 5).map((x) => x.request)).toEqual(['slow summary request']);
    expect(s.getSession(r.ctx.sessionId)!.endedAt).toBe('2026-11-09T00:00:00.000Z');
    s.close();
  });
  it("never deletes a successor's daemon.json", async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const h = await startDaemon(createDaemonContext(home, env), { port: 0, idleMs: 50 });
    const successor = { port: 1, pid: process.pid, token: 'successor-token', startedAt: new Date().toISOString() };
    writeDaemonInfo(home, successor);
    await new Promise((r) => setTimeout(r, 150));
    await h.close();
    expect(readDaemonInfo(home)).toEqual(successor);
    expect(existsSync(path.join(home, 'daemon.lock'))).toBe(false);
  });
});

it('observer close gives up on stuck work after its cap', { retry: 2 }, async () => {
  const ctx = createDaemonContext(mkdtempSync(path.join(tmpdir(), 'mh-')), env);
  (ctx.observer as any).deps.provider = { complete: () => new Promise(() => {}) };
  const r = ctx.resolveSession({ host: 'claude-code', hostEvent: 'Stop', hostSessionId: 'stuck', cwd: tmpdir(), event: 'stop', at: new Date().toISOString() })!;
  ctx.observer.onPrompt(r.ctx, 'a prompt long enough to be summarized at the end');
  void ctx.observer.onStop(r.ctx);
  const t0 = Date.now(); await ctx.observer.close(100);
  expect(Date.now() - t0).toBeLessThan(1000);
  ctx.store.close();
});
