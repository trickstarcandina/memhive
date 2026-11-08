import { describe, it, expect, vi } from 'vitest';
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
  it("other users' rows excluded from context with scope mine (and the deprecated includeOtherUsers=0)", async () => {
    const on = seeded();
    const r1 = (await handleRoute(on.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(on.home))).body as { context: string };
    expect(r1.context).toContain('Mallory note'); expect(r1.context).toContain('Alice note');
    const off = seeded({ MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS: '0' });
    expect(off.ctx.settings.context.scope).toBe('mine');
    const mineScope = seeded({ MEMHIVE_CONTEXT_SCOPE: 'mine' });
    const r3 = (await handleRoute(mineScope.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(mineScope.home))).body as { context: string };
    expect(r3.context).not.toContain('Mallory note'); expect(r3.context).toContain('Alice note'); mineScope.ctx.store.close();
    const r2 = (await handleRoute(off.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(off.home))).body as { context: string };
    expect(r2.context).not.toContain('Mallory note'); expect(r2.context).toContain('Alice note');
    on.ctx.store.close(); off.ctx.store.close();
  });
  it('scope mine keeps own rows captured under another name (before login, or renamed)', async () => {
    const off = seeded({ MEMHIVE_CONTEXT_INCLUDE_OTHER_USERS: '0' });
    const old = sess(off.project.id, { userId: 'local' }); off.ctx.store.upsertSession(old);
    off.ctx.store.insertObservations([obs({ projectId: off.project.id, sessionId: old.id, userId: 'local', title: 'Before login note' })]);
    const r = (await handleRoute(off.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(off.home))).body as { context: string };
    expect(r.context).toContain('Before login note'); expect(r.context).not.toContain('Mallory note');
    off.ctx.store.close();
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
      if (String(url).endsWith('/v1/config')) return new Response(JSON.stringify({ version: 'x', protocol: 1, embedding_model: null, embedding_dims: null, body_limit: 2_000_000 }), { status: 200 });
      return new Response(JSON.stringify({ accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [] }), { status: 200 });
    }) as typeof fetch;
    return { ...s, pulls: () => pulls };
  }
  const startAt = async (s: ReturnType<typeof linked>) => {
    const t0 = Date.now(); const r = await handleRoute(s.ctx, 'POST', new URL('http://x/v1/sessions/start'), start(s.home));
    return { ms: Date.now() - t0, context: (r.body as { context: string }).context };
  };

  it('session start does not wait for a slow hub', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const s = linked(5000); s.ctx.store.setPullCursor(s.project.id, 1);   // pulled before
    let r;
    try {
      r = await startAt(s);   // resolves with no timer advanced: the route does not wait on the hub
      expect(r.ms).toBe(0);
      expect(s.pulls()).toBe(0);
      await vi.advanceTimersByTimeAsync(20_000); await s.ctx.sync!.close();
    } finally { vi.useRealTimers(); }
    s.ctx.store.close();
  });
  it('first pull waits up to 1 s', { retry: 2 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const slow = linked(5000);
    try {
      let done = false; const p = startAt(slow).then((x) => { done = true; return x; });
      await vi.advanceTimersByTimeAsync(990); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(20); expect(done).toBe(true);
      expect((await p).ms).toBe(1000);
      await vi.advanceTimersByTimeAsync(20_000); await slow.ctx.sync!.close();   // let the slow pull finish before the store goes
    } finally { vi.useRealTimers(); }
    slow.ctx.store.close();
    const fast = linked(20);
    let r;
    r = await startAt(fast);
    expect(r.ms).toBeLessThan(900);
    expect(r.context).toContain('Pulled from hub');
    await fast.ctx.sync!.close(); fast.ctx.store.close();
  });
  it('no pull while backing off or logged out; close() awaits a background pull', async () => {
    const out = linked(10); out.ctx.store.setPullCursor(out.project.id, 1);
    saveCredentials(out.home, { hubs: {} });   // logged out
    await startAt(out); await out.ctx.sync!.close();
    expect(out.pulls()).toBe(0);
    const failed = linked(10); failed.ctx.store.setPullCursor(failed.project.id, 1);
    saveCredentials(failed.home, { hubs: { [hubUrl]: { key: 'mh_' + 'A'.repeat(43), user: 'alice', authFailed: true } } });
    await startAt(failed); await failed.ctx.sync!.close();
    expect(failed.pulls()).toBe(0);
    out.ctx.store.close(); failed.ctx.store.close();
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
