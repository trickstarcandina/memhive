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
