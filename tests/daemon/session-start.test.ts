import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonContext } from '../../src/daemon/server.js';
import { handleRoute } from '../../src/daemon/routes.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import type { HookEvent } from '../../src/hooks/types.js';
import { obs, sess } from '../store/store-contract.js';

const env = (extra: Record<string, string> = {}) => ({ MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x', ...extra });
const start = (home: string): HookEvent => ({ host: 'claude-code', hostEvent: 'SessionStart', hostSessionId: 'h-' + Math.random(), cwd: home, event: 'session-start', at: new Date().toISOString() });

function seeded(extra: Record<string, string> = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
  saveCredentials(home, { hubs: { 'http://127.0.0.1:9': { key: 'mh_' + 'A'.repeat(43), user: 'alice' } } });
  const ctx = createDaemonContext(home, env(extra));
  const { key, name } = projectKeyFor(home); const p = ctx.store.getOrCreateProject(key, name);
  const mine = sess(p.id, { userId: 'alice' }); const theirs = sess(p.id, { userId: 'mallory', origin: 'hub' });
  ctx.store.upsertSession(mine); ctx.store.upsertSession(theirs);
  ctx.store.insertObservations([obs({ projectId: p.id, sessionId: mine.id, userId: 'alice', title: 'Alice note' }), obs({ projectId: p.id, sessionId: theirs.id, userId: 'mallory', title: 'Mallory note', origin: 'hub' })]);
  return { home, ctx, project: p };
}

describe('session start context', () => {
  it("other users' rows excluded from context when includeOtherUsers=false", async () => {
    const on = seeded();
    const r1 = (await handleRoute(on.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(on.home))).body as { context: string };
    expect(r1.context).toContain('Mallory note'); expect(r1.context).toContain('Alice note');
    const off = seeded({ MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS: '0' });
    expect(off.ctx.settings.context.includeOtherUsers).toBe(false);
    const r2 = (await handleRoute(off.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(off.home))).body as { context: string };
    expect(r2.context).not.toContain('Mallory note'); expect(r2.context).toContain('Alice note');
    on.ctx.store.close(); off.ctx.store.close();
  });
});

describe('session start pull', () => {
  const hubUrl = 'http://127.0.0.1:9';
  // A hub whose every request takes delayMs; pull pages carry one teammate observation.
  function linked(delayMs: number) {
    const s = seeded(); s.ctx.store.setProjectHub(s.project.id, hubUrl);
    const hs = sess(s.project.id, { userId: 'bob' });
    const o = { ...obs({ projectId: s.project.id, sessionId: hs.id, userId: 'bob', title: 'Pulled from hub' }), embedding: null };
    const page = { sessions: [{ ...hs, cwd: '' }], observations: [o], summaries: [], next_seq: 3, has_more: false, max_seq: 3 };
    let pulls = 0;
    (s.ctx.sync as any).deps.fetchImpl = (async (url: string) => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (String(url).includes('/v1/sync/pull')) { pulls++; return new Response(JSON.stringify(page), { status: 200 }); }
      return new Response(JSON.stringify({ accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [] }), { status: 200 });
    }) as typeof fetch;
    return { ...s, pulls: () => pulls };
  }
  const startAt = async (s: ReturnType<typeof linked>) => {
    const t0 = Date.now(); const r = await handleRoute(s.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(s.home));
    return { ms: Date.now() - t0, context: (r.body as { context: string }).context };
  };

  it('session start does not wait for a slow hub', async () => {
    const s = linked(5000); s.ctx.store.setPullCursor(s.project.id, 1);   // pulled before
    const r = await startAt(s);
    expect(r.ms).toBeLessThan(500);
    expect(s.pulls()).toBe(0);   // still in flight
    s.ctx.sync!.close(); s.ctx.store.close();   // close() is awaited by the daemon; here the store just goes away
  });
  it('first pull waits up to 1 s', async () => {
    const slow = linked(5000);
    let r = await startAt(slow);
    expect(r.ms).toBeGreaterThanOrEqual(950); expect(r.ms).toBeLessThan(1500);
    const fast = linked(20);
    r = await startAt(fast);
    expect(r.ms).toBeLessThan(900);
    expect(r.context).toContain('Pulled from hub');
    await fast.ctx.sync!.close(); fast.ctx.store.close();
  });
  it('no pull while backing off or logged out; close() awaits a background pull', async () => {
    const s = linked(100); s.ctx.store.setPullCursor(s.project.id, 1);
    (s.ctx.sync as any).backoff.set(s.project.id, { until: Date.now() + 60_000, delayMs: 30_000, strikes: 0 });
    await startAt(s); await s.ctx.sync!.close();
    expect(s.pulls()).toBe(0);
    const t = linked(100); t.ctx.store.setPullCursor(t.project.id, 1);
    await startAt(t); await t.ctx.sync!.close();
    expect(t.pulls()).toBe(1);
    t.ctx.store.close(); s.ctx.store.close();
  });
});
