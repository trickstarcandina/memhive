import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { DaemonClient } from '../../src/daemon/client.js';
import { readDaemonInfo } from '../../src/daemon/info.js';
import type { HookEvent } from '../../src/hooks/types.js';

const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
let handle: Awaited<ReturnType<typeof startDaemon>>; let client: DaemonClient;
const ev = (p: Partial<HookEvent>): HookEvent => ({ host: 'claude-code', hostEvent: 'SessionStart', hostSessionId: 'h1', cwd: home, event: 'session-start', at: new Date().toISOString(), ...p });

beforeAll(async () => {
  const ctx = createDaemonContext(home, { MEMHUB_LLM_PROVIDER: 'openai-compat', MEMHUB_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHUB_LLM_MODEL: 'x' });
  ctx.observer['deps'].provider = { complete: async () => JSON.stringify({ observations: [{ type: 'decision', title: 'Chose SQLite', facts: ['wal'] }] }) };
  handle = await startDaemon(ctx, { port: 0, idleMs: 60000 });
  client = new DaemonClient(handle.info);
});
afterAll(async () => { await handle.close(); });

describe('daemon', () => {
  it('writes daemon.json and answers healthz', async () => {
    expect(readDaemonInfo(home)!.port).toBe(handle.info.port);
    expect(await client.health()).toBe(true);
  });
  it('rejects requests without token', async () => {
    const res = await fetch(`http://127.0.0.1:${handle.info.port}/v1/search?q=x&project_key=k`);
    expect(res.status).toBe(401);
  });
  it('session start returns a context block and creates the session', async () => {
    const r = await client.request<{ context: string }>('POST', '/v1/sessions/start', ev({}));
    expect(r.context).toContain('memhub ·');
  });
  it('events flow to the observer and become searchable', async () => {
    await client.request('POST', '/v1/events', ev({ hostEvent: 'UserPromptSubmit', event: 'prompt', prompt: 'pick a database' }));
    await client.request('POST', '/v1/events', ev({ hostEvent: 'PostToolUse', event: 'tool', tool: { name: 'Read', input: { file_path: 'a' }, output: 'b', failed: false } }));
    await client.request('POST', '/v1/events', ev({ hostEvent: 'Stop', event: 'stop' }));
    await new Promise((r) => setTimeout(r, 50));
    const key = (await client.request<any>('GET', '/v1/project?cwd=' + encodeURIComponent(home))).project.key;
    const s = await client.request<{ observations: any[] }>('GET', `/v1/search?q=sqlite&project_key=${encodeURIComponent(key)}`);
    expect(s.observations[0].title).toBe('Chose SQLite');
    const id8 = s.observations[0].id.slice(0, 8);
    const g = await client.request<{ observations: any[] }>('GET', `/v1/observations?ids=${id8}`);
    expect(g.observations[0].id).toBe(s.observations[0].id);
    const t = await client.request<{ observations: any[] }>('GET', `/v1/timeline?anchor=${id8}&before=2&after=2`);
    expect(t.observations).toHaveLength(1);
  });
  it('save_memory stores a manual observation', async () => {
    const key = (await client.request<any>('GET', '/v1/project?cwd=' + encodeURIComponent(home))).project.key;
    const r = await client.request<{ observation: any }>('POST', '/v1/memories', { projectKey: key, text: 'Always run migrations before tests', title: 'Migrations first' });
    expect(r.observation.type).toBe('discovery');
    expect(r.observation.facts).toEqual(['Always run migrations before tests']);
  });
  it('unknown route is 404', async () => {
    await expect(client.request('GET', '/nope')).rejects.toMatchObject({ status: 404 });
  });
});
