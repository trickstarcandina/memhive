import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { searchCommand } from '../../src/cli/commands/search.js';
import { editCommand, showCommand } from '../../src/cli/commands/observation.js';
import { forgetCommand } from '../../src/cli/commands/forget.js';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { statsCommand } from '../../src/cli/commands/stats.js';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { healthProof } from '../../src/daemon/client.js';
import { writeDaemonInfo } from '../../src/daemon/info.js';
import { VERSION } from '../../src/shared/version.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { projectKeyFor } from '../../src/shared/project-key.js';
import { obs, sess } from '../store/store-contract.js';

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) }, text: () => out.join(''), errText: () => err.join('') }; };
const baseEnv = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' };

const home = mkHome(); const cwd = mkHome();
let h: Awaited<ReturnType<typeof startDaemon>>; let ctx: ReturnType<typeof createDaemonContext>;
let mine: ReturnType<typeof obs>; let old: ReturnType<typeof obs>; let theirs: ReturnType<typeof obs>; let other: ReturnType<typeof obs>;

beforeAll(async () => {
  ctx = createDaemonContext(home, baseEnv);
  const { key, name } = projectKeyFor(cwd);
  const p = ctx.store.getOrCreateProject(key, name); const s = sess(p.id); ctx.store.upsertSession(s);
  const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString();
  mine = obs({ projectId: p.id, sessionId: s.id, title: 'Zebra parser fixed', type: 'bugfix', createdAt: day(1) });
  old = obs({ projectId: p.id, sessionId: s.id, title: 'Old zebra decision', type: 'decision', createdAt: day(20) });
  theirs = obs({ projectId: p.id, sessionId: s.id, title: 'Bob zebra note', userId: 'bob', origin: 'hub', syncedAt: day(0), createdAt: day(2) });
  ctx.store.insertObservations([mine, old, theirs]);
  const q = ctx.store.getOrCreateProject('github.com/acme/other', 'other'); const s2 = sess(q.id); ctx.store.upsertSession(s2);
  other = obs({ projectId: q.id, sessionId: s2.id, title: 'Zebra in another repo', createdAt: day(3) });
  ctx.store.insertObservations([other]);
  h = await startDaemon(ctx, { port: 0 });
});
afterAll(async () => { await h.close(); });

const ids = (json: string) => (JSON.parse(json).results as Array<{ id: string; kind: string }>).map((r) => r.id);

describe('search flags', () => {
  it('--json gives stable results with kind; --project and --all-projects choose the scope', async () => {
    let r = io(); expect(await searchCommand(['zebra', '--json'], r.io, { home, cwd })).toBe(0);
    const res = JSON.parse(r.text()).results;
    expect(res.every((x: { kind: string }) => x.kind === 'observation')).toBe(true);
    expect(ids(r.text()).sort()).toEqual([mine.id, old.id, theirs.id].sort());
    r = io(); await searchCommand(['zebra', '--json', '--project', 'github.com/acme/other'], r.io, { home, cwd });
    expect(ids(r.text())).toEqual([other.id]);
    r = io(); await searchCommand(['zebra', '--json', '--all-projects'], r.io, { home, cwd });
    expect(ids(r.text())).toHaveLength(4);
    r = io(); expect(await searchCommand(['zebra', '--all-projects', '--project', 'x'], r.io, { home, cwd })).toBe(2);
  });
  it('--offset pages; an empty query with --since or --type lists the newest rows', async () => {
    let r = io(); await searchCommand(['zebra', '--json', '--limit', '1'], r.io, { home, cwd });
    const first = ids(r.text());
    r = io(); await searchCommand(['zebra', '--json', '--limit', '1', '--offset', '1'], r.io, { home, cwd });
    expect(ids(r.text())).toHaveLength(1); expect(ids(r.text())).not.toEqual(first);
    r = io(); expect(await searchCommand(['--since', '7d', '--json'], r.io, { home, cwd })).toBe(0);
    expect(ids(r.text())).toEqual([mine.id, theirs.id]);   // newest first, the 20-day-old row is left out
    r = io(); await searchCommand(['--type', 'decision', '--json'], r.io, { home, cwd });
    expect(ids(r.text())).toEqual([old.id]);
    r = io(); expect(await searchCommand(['--type', 'nope'], r.io, { home, cwd })).toBe(2);
    r = io(); expect(await searchCommand(['q', '--offset', '-1'], r.io, { home, cwd })).toBe(2);
  });
  it('recent lists the newest observations of the project', async () => {
    let r = io(); expect(await searchCommand(['--limit', '2'], r.io, { home, cwd, recent: true })).toBe(0);
    expect(r.text()).toContain('Zebra parser fixed'); expect(r.text()).toContain('Bob zebra note'); expect(r.text()).not.toContain('Old zebra');
    r = io(); await searchCommand(['--json', '--all-projects'], r.io, { home, cwd, recent: true });
    expect(ids(r.text())).toHaveLength(4);
  });
});

describe('show', () => {
  it('prints full rows by short id, --json, and exits 1 when nothing matches', async () => {
    let r = io(); expect(await showCommand([`#${mine.id.slice(-8)}`], r.io, { home, cwd })).toBe(0);
    expect(r.text()).toContain('Zebra parser fixed'); expect(r.text()).toContain('N');
    r = io(); expect(await showCommand([mine.id, '--json'], r.io, { home, cwd })).toBe(0);
    expect(JSON.parse(r.text())).toMatchObject({ observations: [{ id: mine.id }], summaries: [] });
    r = io(); expect(await showCommand(['deadbeef'], r.io, { home, cwd })).toBe(1);
    r = io(); expect(await showCommand([], r.io, { home, cwd })).toBe(2);
  });
  it('is scoped to the current project unless --project or --all-projects', async () => {
    let r = io(); expect(await showCommand([other.id.slice(-8)], r.io, { home, cwd })).toBe(1);
    expect(r.text()).not.toContain('Zebra in another repo');
    r = io(); expect(await showCommand([other.id.slice(-8), '--project', 'github.com/acme/other'], r.io, { home, cwd })).toBe(0);
    expect(r.text()).toContain('Zebra in another repo');
    r = io(); expect(await showCommand([other.id.slice(-8), '--all-projects'], r.io, { home, cwd })).toBe(0);
  });
  it('show and stats print a daemon error on one line and exit 1', async () => {
    const h2 = mkHome(); const token = 'k'.repeat(32);
    const srv = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x'); res.setHeader('content-type', 'application/json');
      if (u.pathname === '/healthz') { res.end(JSON.stringify({ ok: true, version: VERSION, proof: healthProof(token, u.searchParams.get('nonce')!, process.pid) })); return; }
      if (u.pathname === '/v1/project') { res.end(JSON.stringify({ project: { key: 'k' } })); return; }
      res.statusCode = 500; res.end(JSON.stringify({ error: { code: 'internal', message: 'internal error' } }));
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      writeDaemonInfo(h2, { port: (srv.address() as AddressInfo).port, pid: process.pid, token, startedAt: new Date().toISOString(), version: VERSION });
      let r = io(); expect(await showCommand(['abcd1234'], r.io, { home: h2, cwd })).toBe(1);
      expect(r.errText()).toBe('memhive show: internal error\n');
      r = io(); expect(await statsCommand([], r.io, { home: h2 })).toBe(1);
      expect(r.errText()).toBe('memhive stats: internal error\n');
    } finally { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); }
  });
});

describe('edit', () => {
  it('changes title and narrative of an own row, keeps it unsynced state, and drops its vector', async () => {
    const r = io();
    expect(await editCommand([mine.id.slice(-8), '--title', 'Zebra parser fixed for good', '--narrative', 'longer story', '--json'], r.io, { home, cwd })).toBe(0);
    expect(JSON.parse(r.text()).observation).toMatchObject({ id: mine.id, title: 'Zebra parser fixed for good', narrative: 'longer story' });
    expect(ctx.store.getObservations([mine.id])[0].embeddingModel).toBeNull();
  });
  it('pins and unpins any row of the project, but refuses to rewrite someone else\'s', async () => {
    let r = io(); expect(await editCommand([theirs.id.slice(-8), '--pin'], r.io, { home, cwd })).toBe(0);
    expect(r.text()).toContain('pinned'); expect(ctx.store.getObservations([theirs.id])[0].pinned).toBe(true);
    r = io(); expect(await editCommand([theirs.id.slice(-8), '--unpin'], r.io, { home, cwd })).toBe(0);
    expect(ctx.store.getObservations([theirs.id])[0].pinned).toBe(false);
    r = io(); expect(await editCommand([theirs.id.slice(-8), '--title', 'mine now'], r.io, { home, cwd })).toBe(1);
    expect(r.errText()).toContain('someone else');
    expect(ctx.store.getObservations([theirs.id])[0].title).toBe('Bob zebra note');
  });
  it('is scoped to the project and refuses bad usage', async () => {
    let r = io(); expect(await editCommand([other.id.slice(-8), '--pin'], r.io, { home, cwd })).toBe(1);
    expect(r.errText()).toContain('no such observation');
    expect(ctx.store.getObservations([other.id])[0].pinned).toBe(false);
    r = io(); expect(await editCommand([mine.id], r.io, { home, cwd })).toBe(2);
    r = io(); expect(await editCommand([mine.id, '--pin', '--unpin'], r.io, { home, cwd })).toBe(2);
    r = io(); expect(await editCommand([mine.id, '--title', ''], r.io, { home, cwd })).toBe(1);   // empty after trim
    r = io(); expect(await editCommand([mine.id, '--title', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH'], r.io, { home, cwd })).toBe(0);
    expect(ctx.store.getObservations([mine.id])[0].title).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789');   // redacted like save_memory
  });
});

describe('--json on forget and daemon status', () => {
  it('forget --json needs --yes and prints the result object', async () => {
    let r = io(); expect(await forgetCommand([old.id, '--json'], r.io, { home, cwd })).toBe(2);
    r = io(); expect(await forgetCommand([old.id, '--json', '--yes'], r.io, { home, cwd })).toBe(0);
    expect(JSON.parse(r.text())).toMatchObject({ deleted: [{ id: old.id }], not_owner: [], not_found: [], propagates: false });
  });
  it('daemon status --json', async () => {
    const r = io(); expect(await daemonCommand(['status', '--json'], r.io, { home })).toBe(0);
    expect(JSON.parse(r.text())).toMatchObject({ running: true, port: h.info.port, pid: process.pid });
  });
});
