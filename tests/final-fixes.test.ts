import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, readFileSync, statSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../src/mcp/server.js';
import { DaemonError } from '../src/daemon/client.js';
import { SqliteStore } from '../src/store/sqlite/store.js';
import { Observer, type SessionCtx } from '../src/observer/observer.js';
import { getAdapter } from '../src/hooks/adapters/index.js';
import { stripPrivate, sanitizePrompt } from '../src/hooks/sanitize.js';
import { createDaemonContext } from '../src/daemon/server.js';
import { createLogger } from '../src/shared/logger.js';
import { saveSettings, DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { sess, obs } from './store/store-contract.js';

const mode = (p: string) => statSync(p).mode & 0o777;
const tmp = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const silent = { info() {}, warn() {}, error() {}, debug() {} };

async function callWith(deps: Parameters<typeof createMcpServer>[0], name: string, args: Record<string, unknown>) {
  const server = createMcpServer(deps);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); const c = new Client({ name: 't', version: '0' }); await c.connect(b);
  const r: any = await c.callTool({ name, arguments: args }); await c.close(); return r;
}

describe('mcp reconnect', () => {
  const good = (seen: string[]) => ({ request: async (_m: string, p: string) => { seen.push(p); return { observations: [] }; } }) as any;
  it('retries once on connection failure via reconnect', async () => {
    const seen: string[] = [];
    const dead = { request: async () => { throw new TypeError('fetch failed'); } } as any;
    const reconnect = vi.fn(async () => good(seen));
    const r = await callWith({ client: dead, cwd: '/x', reconnect }, 'get_observations', { ids: ['abcd1234'] });
    expect(r.isError).toBeFalsy(); expect(reconnect).toHaveBeenCalledTimes(1); expect(seen).toHaveLength(1);
  });
  it('retries once on 401', async () => {
    const seen: string[] = [];
    const stale = { request: async () => { throw new DaemonError('unauthorized', 401); } } as any;
    const r = await callWith({ client: stale, cwd: '/x', reconnect: async () => good(seen) }, 'get_observations', { ids: ['abcd1234'] });
    expect(r.isError).toBeFalsy(); expect(seen).toHaveLength(1);
  });
  it('does not retry other daemon errors', async () => {
    const reconnect = vi.fn(async () => null);
    const bad = { request: async () => { throw new DaemonError('nope', 500); } } as any;
    const r = await callWith({ client: bad, cwd: '/x', reconnect }, 'get_observations', { ids: ['abcd1234'] });
    expect(r.isError).toBe(true); expect(reconnect).not.toHaveBeenCalled();
  });
  it('accepts a leading # on ids', async () => {
    const seen: string[] = [];
    const r = await callWith({ client: good(seen), cwd: '/x' }, 'get_observations', { ids: ['#abcd1234'] });
    expect(r.isError).toBeFalsy(); expect(seen[0]).toContain('ids=abcd1234');
  });
});

describe('observer', () => {
  it('Stop then SessionEnd summarizes once', async () => {
    vi.useFakeTimers();
    try {
      const sum = JSON.stringify({ request: 'r', learned: 'l', completed: 'c', next_steps: 'n' });
      const complete = vi.fn().mockResolvedValue(sum);
      const store = new SqliteStore(':memory:', { dims: null }); store.migrate();
      const p = store.getOrCreateProject('k', 'proj'); const s = sess(p.id); store.upsertSession(s);
      const ctx: SessionCtx = { sessionId: s.id, projectId: p.id, projectName: 'proj', userId: 'local' };
      const o = new Observer({ store, provider: { complete }, embedder: null, logger: silent });
      o.onPrompt(ctx, 'implement the login flow please');
      await o.onStop(ctx); await o.onSessionEnd(ctx);
      expect(complete).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it('drops sessions idle for over 30 min', async () => {
    vi.useFakeTimers();
    try {
      const store = new SqliteStore(':memory:', { dims: null }); store.migrate();
      const o = new Observer({ store, provider: { complete: async () => '' }, embedder: null, logger: silent });
      const c = (id: string): SessionCtx => ({ sessionId: id, projectId: 'p', projectName: 'n', userId: 'u' });
      o.onTool(c('a'), { name: 'Read', input: {}, output: '', at: new Date().toISOString() });
      await vi.advanceTimersByTimeAsync(31 * 60 * 1000);
      o.onTool(c('b'), { name: 'Read', input: {}, output: '', at: new Date().toISOString() });
      expect(o.sessionCount).toBe(1);
    } finally { vi.useRealTimers(); }
  });
});

describe('prompt sanitizing', () => {
  it('redacts secrets in stored prompts via the adapter', () => {
    const a = getAdapter('claude-code')!;
    const fx = JSON.parse(readFileSync(new URL('./fixtures/claude-code/user-prompt-submit.json', import.meta.url), 'utf8'));
    const e = a.parse({ ...fx, prompt: 'use sk-ant-api03-abcdefghijklmnopqrstuvwx and password=hunter2xyz' }, new Date())!;
    expect(e.prompt).not.toContain('sk-ant'); expect(e.prompt).not.toContain('hunter2xyz'); expect(e.prompt).toContain('<redacted>');
  });
  it('caps prompts at 16000 chars plus marker', () => {
    const out = sanitizePrompt('x '.repeat(20000));
    expect(out.length).toBeLessThan(16200); expect(out).toContain('<elided');
  });
  it('bare <private without > fails closed', () => {
    expect(stripPrivate('keep <private secret')).toBe('keep ');
    expect(stripPrivate('keep <private')).toBe('keep ');
  });
});

describe('file modes', () => {
  it('home 0700, logs 0700, db 0600, settings 0600', () => {
    const home = path.join(tmp(), 'mh-home');
    const ctx = createDaemonContext(home, {});
    createLogger(home, 'x', {}).info('hi');
    expect(mode(home)).toBe(0o700); expect(mode(path.join(home, 'logs'))).toBe(0o700);
    ctx.store.close();
    saveSettings(home, DEFAULT_SETTINGS);
    expect(mode(path.join(home, 'settings.json'))).toBe(0o600);
    expect(existsSync(path.join(home, 'memhub.db'))).toBe(true);
    expect(mode(path.join(home, 'memhub.db'))).toBe(0o600);
  });
  it('tightens an existing loose home', () => {
    const home = tmp(); chmodSync(home, 0o755);
    writeFileSync(path.join(home, 'settings.json'), '{}');
    createDaemonContext(home, {}).store.close();
    expect(mode(home)).toBe(0o700);
  });
  it('leaves the mode of a shared directory MEMHUB_HOME points at', () => {
    const home = tmp(); chmodSync(home, 0o755);
    writeFileSync(path.join(home, 'notes.txt'), 'not memhub');
    createDaemonContext(home, {}).store.close();
    expect(mode(home)).toBe(0o755);
  });
});

describe('store', () => {
  it('duplicate observation id is ignored; sqlite-vec load failure falls back to FTS only', () => {
    const warn = vi.fn();
    const s = new SqliteStore(':memory:', { dims: 4, warn, loadVec: () => { throw new Error('no ext'); } }); s.migrate();
    expect(warn).toHaveBeenCalled();
    const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
    const o = obs({ projectId: p.id, sessionId: a.id });
    s.insertObservations([o, o]);
    expect(s.countObservations(p.id)).toBe(1);
    expect(s.searchObservationsVector([1, 0, 0, 0], { projectId: p.id, limit: 1 })).toEqual([]);
    s.setObservationEmbedding(o.id, [1, 0, 0, 0], 'm');
    expect(s.listMissingEmbedding(5)).toHaveLength(1);
  });
  it('ties on created_at order by rowid DESC', () => {
    const s = new SqliteStore(':memory:', { dims: null }); s.migrate();
    const p = s.getOrCreateProject('k', 'n'); const a = sess(p.id); s.upsertSession(a);
    const at = '2026-01-01T00:00:00.000Z';
    const list = ['a', 'b', 'c'].map((t) => obs({ projectId: p.id, sessionId: a.id, title: t, createdAt: at }));
    s.insertObservations(list);
    expect(s.listRecentObservations(p.id, 3).map((x) => x.title)).toEqual(['c', 'b', 'a']);
    expect(s.listSessionObservations(a.id, 3).map((x) => x.title)).toEqual(['c', 'b', 'a']);
  });
});
