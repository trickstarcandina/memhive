import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createDaemonContext } from '../../src/daemon/server.js';
import { handleRoute } from '../../src/daemon/routes.js';
import { runHook } from '../../src/hooks/hook-command.js';
import { createMcpServer } from '../../src/mcp/server.js';
import { DaemonError } from '../../src/daemon/client.js';
import { pauseCommand } from '../../src/cli/commands/pause.js';
import { pausedUntil, pauseReader, writePause } from '../../src/shared/optout.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import type { HookEvent } from '../../src/hooks/types.js';

const env = (extra: Record<string, string> = {}) => ({ MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x', ...extra });
const mk = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const ev = (cwd: string, p: Partial<HookEvent> = {}): HookEvent => ({ host: 'claude-code', hostEvent: 'SessionStart', hostSessionId: 'h-' + Math.random(), cwd, event: 'session-start', at: new Date().toISOString(), ...p });
const url = (p: string) => new URL('http://x' + p);

async function feed(ctx: ReturnType<typeof createDaemonContext>, cwd: string) {
  const sid = 'h-' + Math.random();
  const start = await handleRoute(ctx, 'POST', url('/v1/sessions/start'), ev(cwd, { hostSessionId: sid }));
  for (const e of [{ event: 'prompt', prompt: 'please remember this' }, { event: 'tool', tool: { name: 'Edit', input: { f: 'a' }, output: 'ok' } }] as const) {
    expect((await handleRoute(ctx, 'POST', url('/v1/events'), ev(cwd, { hostSessionId: sid, ...e } as Partial<HookEvent>))).status).toBe(202);
  }
  return start.body as { context: string; excluded?: boolean };
}

describe('opt-out', () => {
  it('MEMHIVE_DISABLED: the hook exits 0 without reading stdin, logging or contacting the daemon', async () => {
    const home = mk(); let calls = 0;
    const code = await runHook(['claude-code', 'SessionStart'], {
      home, env: { MEMHIVE_DISABLED: '1' },
      readStdin: async () => { calls++; return '{}'; }, ensureDaemon: (async () => { calls++; return null; }) as never, fetchImpl: (async () => { calls++; return new Response('{}'); }) as never, stdout: () => { calls++; },
    });
    expect(code).toBe(0); expect(calls).toBe(0);
    expect(() => statSync(path.join(home, 'logs'))).toThrow();
  });

  it('MEMHIVE_DISABLED: MCP tools answer "memhive disabled" without a daemon', async () => {
    const server = createMcpServer({ client: null, cwd: mk(), env: { MEMHIVE_DISABLED: '1' }, reconnect: async () => { throw new Error('must not connect'); } });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
    const c = new Client({ name: 't', version: '0' }); await c.connect(b);
    for (const [name, args] of [['search', { query: 'x' }], ['save_memory', { text: 'x' }]] as const) {
      const r = await c.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
      expect(r.content[0].text).toContain('memhive disabled'); expect(r.isError).toBeFalsy();
    }
    await c.close();
  });

  it('an excluded project gets an empty context and records nothing', async () => {
    const home = mk(); const repo = mk();
    const key = projectKeyFor(repo).key;
    const ctx = createDaemonContext(home, env({ MEMHIVE_EXCLUDE_PROJECTS: `nope/*, ${key}` }));
    const flushed: string[] = []; ctx.observer.onTool = () => { flushed.push('tool'); }; ctx.observer.onPrompt = () => { flushed.push('prompt'); };
    const r = await feed(ctx, repo);
    expect(r).toEqual({ context: '', excluded: true });
    expect(flushed).toEqual([]); expect(ctx.store.getProjectByKey(key)).toBeNull();
    expect((await handleRoute(ctx, 'GET', url(`/v1/status?cwd=${encodeURIComponent(repo)}`), undefined)).body).toMatchObject({ excluded: true, paused_until: null });
    ctx.store.close();
  });

  it('excludeProjects globs also match the repo root path; .memhive.json disabled excludes too', async () => {
    const home = mk(); const parent = mk(); const a = path.join(parent, 'a'); const b = mk();
    mkdirSync(a);
    writeFileSync(path.join(b, '.memhive.json'), JSON.stringify({ disabled: true }));
    const ctx = createDaemonContext(home, env({ MEMHIVE_EXCLUDE_PROJECTS: `${parent}/**` }));
    expect((await feed(ctx, a)).excluded).toBe(true);
    expect((await feed(ctx, b)).excluded).toBe(true);
    const ok = mk(); expect((await feed(ctx, ok)).context).toContain('memhive ·');
    ctx.store.close();
  });

  it('.memhive.json project override changes the key the daemon records under', async () => {
    const home = mk(); const repo = mk();
    const natural = projectKeyFor(repo).key;
    writeFileSync(path.join(repo, '.memhive.json'), JSON.stringify({ project: `${natural}/pkg` }));
    const ctx = createDaemonContext(home, env());
    await feed(ctx, repo);
    expect(ctx.store.getProjectByKey(`${natural}/pkg`)).not.toBeNull(); expect(ctx.store.getProjectByKey(natural)).toBeNull();
    ctx.store.close();
  });

  it('pause / resume: state.json, not settings.json; the daemon treats paused like disabled', async () => {
    const home = mk(); const out: string[] = []; const io = { stdout: (s: string) => out.push(s), stderr: (s: string) => out.push(s) };
    expect(await pauseCommand(['1h'], io, { home })).toBe(0);
    expect(JSON.parse(readFileSync(path.join(home, 'state.json'), 'utf8')).pausedUntil).toMatch(/^\d{4}-/);
    expect(() => statSync(path.join(home, 'settings.json'))).toThrow();
    expect(statSync(path.join(home, 'state.json')).mode & 0o777).toBe(0o600);
    const until = pausedUntil(home)!; expect(until - Date.now()).toBeGreaterThan(36e5 - 5000);
    const ctx = createDaemonContext(home, env());
    expect((await feed(ctx, mk())).excluded).toBe(true);
    expect(((await handleRoute(ctx, 'GET', url('/v1/status'), undefined)).body as { paused_until: string }).paused_until).toBe(new Date(until).toISOString());
    expect(await pauseCommand([], io, { home })).toBe(0); expect(pausedUntil(home)).toBe(Infinity);
    expect(await pauseCommand(['soon'], io, { home })).toBe(1);
    expect(await pauseCommand([], io, { home, resume: true })).toBe(0); expect(pausedUntil(home)).toBeNull();
    expect(out.join('')).toContain('memhive resumed');
    ctx.store.close();
  });

  it('the daemon re-reads the pause at most every 5 s; an expired pause is no pause', () => {
    const home = mk(); const read = pauseReader(home, 5000);
    expect(read()).toBeNull();
    writePause(home, Date.now() + 60_000);
    expect(read()).toBeNull();   // cached
    expect(pauseReader(home, 5000)()).not.toBeNull();
    writePause(home, Date.now() - 1);
    expect(pausedUntil(home)).toBeNull();
  });

  it('MEMHIVE_DISABLED in the daemon env records nothing', async () => {
    const ctx = createDaemonContext(mk(), env({ MEMHIVE_DISABLED: '1' }));
    expect((await feed(ctx, mk())).excluded).toBe(true);
    expect(((await handleRoute(ctx, 'GET', url('/v1/status'), undefined)).body as { paused_until: string }).paused_until).toBe('indefinite');
    ctx.store.close();
  });
});

describe('opt-out covers MCP writes (M5)', () => {
  const mcp = async (home: string, cwd: string, extra: Record<string, string> = {}) => {
    const ctx = createDaemonContext(home, env(extra));
    const client = { request: async (m: 'GET' | 'POST', p: string, body?: unknown) => { const r = await handleRoute(ctx, m, new URL('http://x' + p), body); if (r.status >= 400) throw new DaemonError((r.body as any).error.message, r.status); return r.body; } } as never;
    const server = createMcpServer({ client, cwd });
    const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(a);
    const c = new Client({ name: 't', version: '0' }); await c.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => (await c.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean });
    return { ctx, c, call };
  };
  it('save_memory in an excluded project (settings or .memhive.json) saves nothing and creates no project row', async () => {
    const repo = mk(); const key = projectKeyFor(repo).key;
    const t = await mcp(mk(), repo, { MEMHIVE_EXCLUDE_PROJECTS: key });
    const r = await t.call('save_memory', { text: 'secret plan' });
    expect(r.isError).toBeFalsy(); expect(r.content[0].text).toContain('does not record this project');
    expect((await t.call('search', { query: 'secret' })).content[0].text).toContain('does not record this project');
    expect(t.ctx.store.getProjectByKey(key)).toBeNull();
    await t.c.close(); t.ctx.store.close();
    const repo2 = mk(); writeFileSync(path.join(repo2, '.memhive.json'), JSON.stringify({ disabled: true }));
    const t2 = await mcp(mk(), repo2);
    expect((await t2.call('save_memory', { text: 'secret plan' })).content[0].text).toContain('does not record this project');
    expect(t2.ctx.store.getProjectByKey(projectKeyFor(repo2).key)).toBeNull();
    await t2.c.close(); t2.ctx.store.close();
  });
  it('save_memory while paused saves nothing; a plain project lookup never creates a row', async () => {
    const home = mk(); const repo = mk(); writePause(home, Infinity);
    const t = await mcp(home, repo);
    expect((await t.call('save_memory', { text: 'later' })).content[0].text).toContain('paused');
    expect(t.ctx.store.getProjectByKey(projectKeyFor(repo).key)).toBeNull();
    writePause(home, null);
    const t2 = await mcp(home, repo);
    expect((await t2.call('search', { query: 'x' })).content[0].text).toContain('No observations');
    expect(t2.ctx.store.getProjectByKey(projectKeyFor(repo).key)).toBeNull();
    await t.c.close(); await t2.c.close(); t.ctx.store.close(); t2.ctx.store.close();
  });
});
