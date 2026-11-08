import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonContext } from '../../src/daemon/server.js';
import { handleRoute } from '../../src/daemon/routes.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import { deadUrl } from '../helpers/closed-port.js';

const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
const mk = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const url = (p: string) => new URL('http://x' + p);

describe('final review follow-ups (daemon)', () => {
  it('m4: /v1/sync and /v1/projects/link refuse an excluded project and create no row', async () => {
    const home = mk();
    const repo = mk();
    writeFileSync(path.join(repo, '.memhive.json'), JSON.stringify({ disabled: true }));
    const ctx = createDaemonContext(home, env);
    try {
      const sync = await handleRoute(ctx, 'POST', url('/v1/sync'), { cwd: repo });
      expect(sync).toMatchObject({ status: 409, body: { error: { code: 'excluded' } } });
      const link = await handleRoute(ctx, 'POST', url('/v1/projects/link'), {
        cwd: repo,
        hubUrl: 'https://hub.example',
      });
      expect(link).toMatchObject({ status: 409, body: { error: { code: 'excluded' } } });
      expect(ctx.store.getProjectByKey(projectKeyFor(repo).key)).toBeNull();
      // unlinking stays possible, so a project linked before it was excluded can be cut off from the hub
      expect((await handleRoute(ctx, 'POST', url('/v1/projects/link'), { cwd: repo, hubUrl: null })).status).toBe(200);
    } finally {
      ctx.store.close();
    }
  });

  it('m5: an imported session cwd and branch are redacted like every other imported field', async () => {
    const home = mk();
    const ctx = createDaemonContext(home, env);
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    try {
      const id = '01900000-0000-7000-8000-000000000001';
      const r = await handleRoute(ctx, 'POST', url('/v1/import'), {
        projectKey: 'github.com/t/imp',
        rows: [
          {
            kind: 'session',
            id,
            userId: 'alice',
            host: 'claude-code',
            hostSessionId: 'h1',
            cwd: `/work/${secret}<private>client</private>`,
            branch: `fix-${secret}`,
            startedAt: '2026-01-01T00:00:00Z',
            endedAt: null,
          },
        ],
      });
      expect(r.status).toBe(200);
      const s = ctx.store.getSession(id)!;
      expect(s.cwd).not.toContain(secret);
      expect(s.cwd).not.toContain('client');
      expect(s.branch).not.toContain(secret);
    } finally {
      ctx.store.close();
    }
  });
});
