import { existsSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';
import { readDaemonInfo } from '../../src/daemon/info.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import type { HookEvent } from '../../src/hooks/types.js';
import { deadUrl } from '../helpers/closed-port.js';
import { waitFor } from '../helpers/wait.js';

const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
let handle: Awaited<ReturnType<typeof startDaemon>>;
let client: DaemonClient;
const ev = (p: Partial<HookEvent>): HookEvent => ({
  host: 'claude-code',
  hostEvent: 'SessionStart',
  hostSessionId: 'h1',
  cwd: home,
  event: 'session-start',
  at: new Date().toISOString(),
  ...p,
});

beforeAll(async () => {
  const ctx = createDaemonContext(home, {
    MEMHIVE_LLM_PROVIDER: 'openai-compat',
    MEMHIVE_LLM_BASE_URL: deadUrl,
    MEMHIVE_LLM_MODEL: 'x',
  });
  ctx.observer['deps'].provider = {
    complete: async () =>
      JSON.stringify({ observations: [{ type: 'decision', title: 'Chose SQLite', facts: ['wal'] }] }),
  };
  handle = await startDaemon(ctx, { port: 0, idleMs: 60000 });
  client = new DaemonClient(handle.info);
});
afterAll(async () => {
  await handle.close();
});

describe('daemon', { shuffle: false }, () => {
  // one daemon; later tests read what earlier ones recorded
  it('writes daemon.json and answers healthz', async () => {
    expect(readDaemonInfo(home)!.port).toBe(handle.info.port);
    expect(await client.health()).toBe(true);
  });
  it('healthz does not reveal the pid, and the proof still binds it', async () => {
    const j = await (await fetch(`http://127.0.0.1:${handle.info.port}/healthz?nonce=n`)).json();
    expect(j).not.toHaveProperty('pid');
    expect(await new DaemonClient({ ...handle.info, pid: handle.info.pid + 1 }).health()).toBe(false);
  });
  it('rejects a foreign Host header even with the token (DNS rebinding)', async () => {
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        const r = httpRequest(
          {
            host: '127.0.0.1',
            port: handle.info.port,
            path: '/v1/status',
            headers: { host, 'x-memhive-daemon-token': handle.info.token },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode!);
          }
        );
        r.on('error', reject);
        r.end();
      });
    expect(await status(`evil.example:${handle.info.port}`)).toBe(401);
    expect(await status(`localhost:${handle.info.port}`)).toBe(200);
    expect(await status(`127.0.0.1:${handle.info.port}`)).toBe(200);
  });
  it('rejects requests without token', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.info.port}/v1/search?q=x&project_key=k`);
    expect(res.status).toBe(401);
  });
  it('session start returns a context block and creates the session', async () => {
    const r = await client.request<{ context: string }>('POST', '/v1/sessions/start', ev({}));
    expect(r.context).toContain('memhive ·');
  });
  it('events flow to the observer and become searchable', async () => {
    await client.request(
      'POST',
      '/v1/events',
      ev({ hostEvent: 'UserPromptSubmit', event: 'prompt', prompt: 'pick a database' })
    );
    await client.request(
      'POST',
      '/v1/events',
      ev({
        hostEvent: 'PostToolUse',
        event: 'tool',
        tool: { name: 'Read', input: { file_path: 'a' }, output: 'b', failed: false },
      })
    );
    await client.request('POST', '/v1/events', ev({ hostEvent: 'Stop', event: 'stop' }));
    const key = (await client.request<any>('GET', '/v1/project?cwd=' + encodeURIComponent(home))).project.key;
    const s = await waitFor(
      async () => {
        const r = await client.request<{ observations: any[] }>(
          'GET',
          `/v1/search?q=sqlite&project_key=${encodeURIComponent(key)}`
        );
        return r.observations.length ? r : null;
      },
      { what: 'observation searchable' }
    );
    expect(s.observations[0].title).toBe('Chose SQLite');
    const id8 = s.observations[0].id.slice(0, 8);
    const g = await client.request<{ observations: any[] }>(
      'GET',
      `/v1/observations?ids=${id8}&project_key=${encodeURIComponent(key)}`
    );
    expect(g.observations[0].id).toBe(s.observations[0].id);
    const t = await client.request<{ observations: any[] }>(
      'GET',
      `/v1/timeline?anchor=${id8}&before=2&after=2&project_key=${encodeURIComponent(key)}`
    );
    expect(t.observations).toHaveLength(1);
  });
  it('save_memory stores a manual observation', async () => {
    const key = (await client.request<any>('GET', '/v1/project?cwd=' + encodeURIComponent(home))).project.key;
    const r = await client.request<{ observation: any }>('POST', '/v1/memories', {
      projectKey: key,
      text: 'Always run migrations before tests',
      title: 'Migrations first',
    });
    expect(r.observation.type).toBe('discovery');
    expect(r.observation.facts).toEqual(['Always run migrations before tests']);
  });
  it('save_memory rejects text or title over the MCP caps', async () => {
    const key = (await client.request<any>('GET', '/v1/project?cwd=' + encodeURIComponent(home))).project.key;
    await expect(
      client.request('POST', '/v1/memories', { projectKey: key, text: 'x'.repeat(20001) })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      client.request('POST', '/v1/memories', { projectKey: key, text: 'ok', title: 't'.repeat(2001) })
    ).rejects.toMatchObject({ status: 400 });
  });
  it('unknown route is 404', async () => {
    await expect(client.request('GET', '/nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('daemon lock and authenticated health', () => {
  const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };
  it('second daemon on the same home refuses and leaves the first daemon.json intact', async () => {
    const h2 = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const first = await startDaemon(createDaemonContext(h2, env), { port: 0 });
    const ctx2 = createDaemonContext(h2, env);
    await expect(startDaemon(ctx2, { port: 0 })).rejects.toMatchObject({ name: 'DaemonAlreadyRunning' });
    ctx2.store.close();
    expect(readDaemonInfo(h2)!.token).toBe(first.info.token);
    await first.close();
    expect(readDaemonInfo(h2)).toBeNull();
    expect(existsSync(path.join(h2, 'daemon.lock'))).toBe(false);
  });
  it('replaces a stale lock from a dead pid', async () => {
    const h2 = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(h2, 'daemon.lock'), '999999');
    const d = await startDaemon(createDaemonContext(h2, env), { port: 0 });
    await d.close();
  });
  it('two starters on one stale lock: exactly one daemon wins, the breaker lock is cleaned up', async () => {
    const h2 = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(h2, 'daemon.lock'), '999999');
    const c1 = createDaemonContext(h2, env);
    const c2 = createDaemonContext(h2, env);
    const r = await Promise.allSettled([startDaemon(c1, { port: 0 }), startDaemon(c2, { port: 0 })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(existsSync(path.join(h2, 'daemon.lock.break'))).toBe(false);
    for (const x of r) if (x.status === 'fulfilled') await x.value.close();
    for (const [i, x] of r.entries()) if (x.status === 'rejected') [c1, c2][i].store.close();
  });
  it('a breaker lock left by a crash does not block startup forever', async () => {
    const h2 = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(h2, 'daemon.lock'), '999999');
    writeFileSync(path.join(h2, 'daemon.lock.break'), '999998');
    utimesSync(path.join(h2, 'daemon.lock.break'), new Date(Date.now() - 60000), new Date(Date.now() - 60000));
    const d = await startDaemon(createDaemonContext(h2, env), { port: 0 });
    await d.close();
  });
  it('a squatter answering ok without a valid proof is treated as dead', async () => {
    const srv = createServer((_q, r) => {
      r.setHeader('content-type', 'application/json');
      r.end(JSON.stringify({ ok: true, pid: process.pid, proof: 'x' }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as any).port;
    expect(await new DaemonClient({ port, pid: process.pid, token: 't', startedAt: '' }).health()).toBe(false);
    await new Promise((r) => srv.close(r));
  });
});

describe('user id per linked hub', () => {
  it('a project linked to a hub records the user of that hub; an unlinked one the default user', () => {
    const h2 = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const linkedDir = mkdtempSync(path.join(tmpdir(), 'mh-linked-'));
    const plainDir = mkdtempSync(path.join(tmpdir(), 'mh-plain-'));
    saveCredentials(h2, {
      hubs: { 'https://a.example': { key: 'mh_a', user: 'alice' }, 'https://b.example': { key: 'mh_b', user: 'bob' } },
    });
    const ctx = createDaemonContext(h2, {
      MEMHIVE_LLM_PROVIDER: 'openai-compat',
      MEMHIVE_LLM_BASE_URL: deadUrl,
      MEMHIVE_LLM_MODEL: 'x',
    });
    try {
      const { key, name } = projectKeyFor(linkedDir);
      ctx.store.setProjectHub(ctx.store.getOrCreateProject(key, name).id, 'https://b.example');
      const linked = ctx.resolveSession(ev({ hostSessionId: 'l1', cwd: linkedDir }))!;
      expect(linked.ctx.userId).toBe('bob');
      expect(ctx.store.getSession(linked.ctx.sessionId)!.userId).toBe('bob');
      expect(ctx.resolveSession(ev({ hostSessionId: 'p1', cwd: plainDir }))!.ctx.userId).toBe('alice');
    } finally {
      ctx.store.close();
    }
  });
});
