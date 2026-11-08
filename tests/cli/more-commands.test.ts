import { describe, it, expect, afterEach, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { searchCommand } from '../../src/cli/commands/search.js';
import { embedCommand } from '../../src/cli/commands/embed.js';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { readDaemonInfo } from '../../src/daemon/info.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import { obs, sess } from '../store/store-contract.js';

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } }; };
const baseEnv = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' };

let servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  servers = [];
  vi.unstubAllEnvs(); vi.restoreAllMocks();
});
const listen = async (h: http.RequestListener): Promise<string> => {
  const s = http.createServer(h); servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};
// Fake OpenAI-compatible server: chat -> {"ok":true}, embeddings -> 2-dim vectors.
const fakeLlm = (opts: { chatStatus?: number } = {}) => listen((req, res) => {
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/embeddings')) {
      const input: string[] = JSON.parse(body).input;
      res.end(JSON.stringify({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) }));
    } else if (opts.chatStatus && opts.chatStatus !== 200) { res.statusCode = opts.chatStatus; res.end('{"error":"nope"}'); }
    else res.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
});

function seed(ctx: ReturnType<typeof createDaemonContext>, cwd: string, titles: string[], userId = 'local') {
  const { key, name } = projectKeyFor(cwd);
  const p = ctx.store.getOrCreateProject(key, name); const a = sess(p.id); ctx.store.upsertSession(a);
  const list = titles.map((title) => obs({ projectId: p.id, sessionId: a.id, title, userId }));
  ctx.store.insertObservations(list);
  return list;
}

describe('search with data', () => {
  it('prints a populated index table, honours --user and --type', async () => {
    const home = mkHome(); const cwd = mkHome();
    const ctx = createDaemonContext(home, baseEnv);
    seed(ctx, cwd, ['Fixed zebra parser'], 'alice'); seed(ctx, cwd, ['Another zebra note'], 'bob');
    const h = await startDaemon(ctx, { port: 0 });
    let r = io();
    expect(await searchCommand(['zebra'], r.io, { home, cwd })).toBe(0);
    let text = r.out.join('');
    expect(text).toContain('| ID | Time | Type | Title | User | ~tokens |');
    expect(text).toContain('Fixed zebra parser'); expect(text).toContain('Another zebra note');
    r = io();
    expect(await searchCommand(['zebra', '--user', 'bob'], r.io, { home, cwd })).toBe(0);
    text = r.out.join('');
    expect(text).toContain('Another zebra note'); expect(text).not.toContain('Fixed zebra parser');
    r = io();
    expect(await searchCommand(['zebra', '--type', 'bugfix'], r.io, { home, cwd })).toBe(0);
    expect(r.out.join('')).toContain('No observations');
    r = io();
    expect(await searchCommand(['zebra', '--limit', '1'], r.io, { home, cwd })).toBe(0);
    expect(r.out.join('').trim().split('\n')).toHaveLength(3);   // header, separator, one row
    await h.close();
  });
  it('search without a query prints usage and exits 1', async () => {
    const r = io();
    expect(await searchCommand([], r.io, { home: mkHome() })).toBe(1);
    expect(r.err.join('')).toContain('usage: memhive search');
  });
});

describe('embed command', () => {
  it('backfills missing embeddings and reports the count', async () => {
    const base = await fakeLlm();
    const home = mkHome(); const cwd = mkHome();
    const ctx = createDaemonContext(home, { ...baseEnv, MEMHIVE_EMBED_BASE_URL: base, MEMHIVE_EMBED_MODEL: 'bge', MEMHIVE_EMBED_DIMS: '2' });
    const list = seed(ctx, cwd, ['one', 'two', 'three']);
    const h = await startDaemon(ctx, { port: 0 });
    const r = io();
    expect(await embedCommand([], r.io, { home })).toBe(0);
    expect(r.out.join('')).toBe('embedded 3 observations\n');
    expect(ctx.store.listMissingEmbedding(10)).toHaveLength(0);
    expect(ctx.store.getObservations([list[0].id])[0].embeddingModel).toBe('bge');
    const again = io();
    expect(await embedCommand(['--rebuild'], again.io, { home })).toBe(0);
    expect(again.out.join('')).toContain('Restart the daemon');
    expect(again.out.join('')).toContain('embedded 0 observations');
    await h.close();
  });
  it('reports 0 when no embedder is configured', async () => {
    const home = mkHome();
    const h = await startDaemon(createDaemonContext(home, baseEnv), { port: 0 });
    const r = io();
    expect(await embedCommand([], r.io, { home })).toBe(0);
    expect(r.out.join('')).toBe('embedded 0 observations\n');
    await h.close();
  });
});

describe('daemon run', () => {
  it('returns 0 immediately when a daemon already owns the home', async () => {
    const home = mkHome();
    const h = await startDaemon(createDaemonContext(home, baseEnv), { port: 0 });
    vi.stubEnv('MEMHIVE_HOME', home); for (const [k, v] of Object.entries(baseEnv)) vi.stubEnv(k, v);
    expect(await daemonCommand(['run'], io().io, { home })).toBe(0);
    expect(readDaemonInfo(home)!.token).toBe(h.info.token);   // untouched
    await h.close();
  });
  it('serves until SIGTERM, then closes cleanly and exits 0', async () => {
    const home = mkHome();
    vi.stubEnv('MEMHIVE_HOME', home); vi.stubEnv('HOME', home); vi.stubEnv('CODEX_HOME', home); vi.stubEnv('CLAUDE_CONFIG_DIR', home);
    for (const [k, v] of Object.entries(baseEnv)) vi.stubEnv(k, v);
    const before = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
    const exited = new Promise<number | undefined>((resolve) => {
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { resolve(code); return undefined as never; }) as never);
    });
    void daemonCommand(['run'], io().io, { home });
    for (let i = 0; i < 100 && !readDaemonInfo(home); i++) await new Promise((r) => setTimeout(r, 50));
    const info = readDaemonInfo(home);
    expect(info).not.toBeNull();
    expect((await fetch(`http://127.0.0.1:${info!.port}/healthz`)).status).toBe(200);
    process.emit('SIGTERM');
    process.emit('SIGTERM');   // second signal is ignored (stopping guard)
    expect(await exited).toBe(0);
    expect(readDaemonInfo(home)).toBeNull();
    for (const l of process.listeners('SIGTERM')) if (!before.term.includes(l)) process.off('SIGTERM', l);
    for (const l of process.listeners('SIGINT')) if (!before.int.includes(l)) process.off('SIGINT', l);
  });
});

describe('doctor ping', () => {
  it('pings provider and embedder and reports ok', async () => {
    const base = await fakeLlm();
    const r = io();
    const code = await doctorCommand([], r.io, { home: mkHome(), env: { ...baseEnv, MEMHIVE_LLM_BASE_URL: base, MEMHIVE_LLM_API_KEY: 'sk-secret-123', MEMHIVE_EMBED_BASE_URL: base, MEMHIVE_EMBED_MODEL: 'bge', MEMHIVE_EMBED_DIMS: '2' } });
    const text = r.out.join('');
    expect(code).toBe(0);
    expect(text).toContain('ok   provider ping');
    expect(text).toContain('ok   embedder ping: 2 dims');
    expect(text).toContain('all good');
    expect(text).not.toContain('sk-secret-123');
  });
  it('reports FAIL and exits 1 when the provider ping errors, without leaking the key', async () => {
    const base = await fakeLlm({ chatStatus: 500 });
    const r = io();
    const code = await doctorCommand([], r.io, { home: mkHome(), env: { ...baseEnv, MEMHIVE_LLM_BASE_URL: base, MEMHIVE_LLM_API_KEY: 'sk-secret-123' } });
    const text = r.out.join('');
    expect(code).toBe(1);
    expect(text).toContain('FAIL provider ping failed');
    expect(text).toContain('1 problem(s) found');
    expect(text).not.toContain('sk-secret-123');
  });
  it('reports FAIL when the embedder returns the wrong dims', async () => {
    const base = await fakeLlm();
    const r = io();
    const code = await doctorCommand([], r.io, { home: mkHome(), env: { ...baseEnv, MEMHIVE_LLM_BASE_URL: base, MEMHIVE_EMBED_BASE_URL: base, MEMHIVE_EMBED_MODEL: 'bge', MEMHIVE_EMBED_DIMS: '3' } });
    expect(code).toBe(1);
    expect(r.out.join('')).toContain('FAIL embedder ping failed');
  });
});
