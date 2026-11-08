import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, mkdtempSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { healthProof } from '../../src/daemon/client.js';
import { writeDaemonInfo } from '../../src/daemon/info.js';
import { renderPluginDir } from '../../src/install/plugin-files.js';
import { saveCredentials } from '../../src/sync/credentials.js';
import { writePause } from '../../src/shared/optout.js';
import { resolvePaths } from '../../src/shared/paths.js';
import { VERSION } from '../../src/shared/version.js';
import { obs, sess } from '../store/store-contract.js';

const repo = path.resolve(import.meta.dirname, '../..');
const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-doc-'));
const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_LLM_MODEL: 'x' };
async function doctor(home: string, extra: Parameters<typeof doctorCommand>[2] = {}, args: string[] = ['--no-ping']) {
  let out = '';
  const code = await doctorCommand(args, { stdout: (s) => { out += s; }, stderr: () => {} }, { home, env, cwd: home, ...extra });
  return { code, out };
}
let closers: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const c of closers) await c(); closers = []; });

describe('doctor checks', () => {
  it('fails an old Node and a settings.json that does not parse, with the parser position', async () => {
    const home = mkHome();
    writeFileSync(path.join(home, 'settings.json'), '{\n  "llm": { "apiKey": "sk-secret-1" },\n  "x": ,\n}');
    const r = await doctor(home, { nodeVersion: '20.11.0' });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/FAIL node v20\.11\.0 \(memhive needs >= 22\) \(fix: install Node\.js 22/);
    expect(r.out).toContain('FAIL settings.json is not valid JSON at line 3 column 8; defaults are used');
    expect(r.out).not.toContain('sk-secret-1');
    expect(r.out).toContain('2 problem(s) found');
  });
  it('--json prints only the checks object; --no-ping skips the provider call', async () => {
    const home = mkHome();
    const r = await doctor(home, {}, ['--json', '--no-ping']);
    const j = JSON.parse(r.out);
    expect(j).toMatchObject({ version: VERSION, home, problems: 0 });
    expect(j.checks.find((c: { check: string }) => c.check === 'node')).toMatchObject({ status: 'ok' });
    expect(j.checks.some((c: { check: string }) => c.check === 'provider-ping')).toBe(false);
    const pinged = await doctor(home, {}, ['--json']);
    expect(JSON.parse(pinged.out).checks.find((c: { check: string }) => c.check === 'provider-ping')).toMatchObject({ status: 'fail' });
  });
  it('checks the node and bundle paths in every rendered plugin file', async () => {
    const home = mkHome(); const t = mkHome();
    const bundle = path.join(t, "it's", 'memhive.cjs'); mkdirSync(path.dirname(bundle)); writeFileSync(bundle, '');
    const render = (nodePath: string, b: string, version = VERSION) => renderPluginDir({ templateRoot: repo, marketplaceRoot: resolvePaths(home).marketplace, nodePath, bundlePath: b, version });
    render(process.execPath, bundle);
    let r = await doctor(home, { bundle });
    for (const f of ['hooks/hooks.json', 'hooks/codex-hooks.json', '.mcp.json']) expect(r.out).toContain(`ok   plugin ${f}: node and bundle paths are current`);
    render('/gone/node', bundle, '0.1.0');
    r = await doctor(home, { bundle });
    expect(r.out).toMatch(/warn plugin hooks\/codex-hooks\.json: node \/gone\/node does not exist \(fix: run `memhive install` again\)/);
    expect(r.out).toContain('warn plugin files were rendered by memhive 0.1.0');
    const other = path.join(t, 'other.cjs'); writeFileSync(other, '');
    render(process.execPath, other);
    r = await doctor(home, { bundle });
    expect(r.out).toContain(`warn plugin .mcp.json: runs bundle ${other}, not ${bundle}`);
    expect(r.code).toBe(0);   // warnings do not fail
    expect((await doctor(mkHome())).out).toContain('info plugin files not rendered');
  });
  it('reports schema, capture pause, log sizes', async () => {
    const home = mkHome();
    createDaemonContext(home, env).store.close();
    writePause(home, Infinity);
    mkdirSync(resolvePaths(home).logs, { recursive: true });
    writeFileSync(path.join(resolvePaths(home).logs, 'hook.log'), 'x');
    const big = path.join(resolvePaths(home).logs, 'daemon.log'); writeFileSync(big, ''); truncateSync(big, 11 * 1024 * 1024);
    const r = await doctor(home);
    expect(r.out).toMatch(/ok   database schema v\d+ \(this memhive knows up to v\d+\)/);
    expect(r.out).toContain('info capture paused until `memhive resume`');
    expect(r.out).toContain('info logs/hook.log 0.0 MB');
    expect(r.out).toContain('warn logs/daemon.log is 11.0 MB');
  });
  it('warns when the running daemon is another version (from /healthz)', async () => {
    const home = mkHome(); const token = 't'.repeat(32);
    const s = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(u.pathname === '/healthz' ? { ok: true, version: '0.1.9', proof: healthProof(token, u.searchParams.get('nonce')!, process.pid) } : {}));
    });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); closers.push(() => new Promise((r) => s.close(r)));
    writeDaemonInfo(home, { port: (s.address() as AddressInfo).port, pid: process.pid, token, startedAt: '', version: VERSION });
    const r = await doctor(home);
    expect(r.out).toContain(`warn daemon is memhive 0.1.9, this CLI is ${VERSION}`);
  });
  it('reports degraded vectors, missing embeddings and per-project sync state from the daemon', async () => {
    const home = mkHome();
    const embedEnv = { ...env, MEMHIVE_EMBED_BASE_URL: 'http://127.0.0.1:9', MEMHIVE_EMBED_MODEL: 'm', MEMHIVE_EMBED_DIMS: '2' };
    const ctx = createDaemonContext(home, embedEnv);
    const hub = 'http://127.0.0.1:9'; const p = ctx.store.getOrCreateProject('github.com/acme/app', 'app'); ctx.store.setProjectHub(p.id, hub);
    const s = sess(p.id); ctx.store.upsertSession(s); ctx.store.insertObservations([obs({ projectId: p.id, sessionId: s.id })]);
    ctx.store.updateSyncState(p.id, { lastError: 'hub 503', lastErrorAt: Date.now(), backoffUntil: Date.now() + 60_000 });
    ctx.store.quarantine(p.id, [{ id: 'x', tbl: 'observations', seq: 1, reason: 'bad', raw: '{}' }]);
    Object.defineProperty(ctx.store, 'vectorsDegraded', { get: () => true });
    const h = await startDaemon(ctx, { port: 0 }); closers.push(() => h.close());
    let r = await doctor(home, { env: embedEnv });
    expect(r.out).toContain('warn sqlite-vec did not load');
    expect(r.out).toContain('info 1 observation(s) without an embedding');
    expect(r.out).toContain(`FAIL github.com/acme/app -> ${hub}: not logged in to this hub (fix: memhive login ${hub})`);
    expect(r.out).toMatch(/info github\.com\/acme\/app -> .*: unsynced 1 observations, 0 summaries, 1 sessions, 0 forgets; last push never, last pull never/);
    expect(r.out).toMatch(/warn github\.com\/acme\/app -> .*: push backs off until .*; last error hub 503 at \d{4}-/);
    expect(r.out).toContain('warn github.com/acme/app -> http://127.0.0.1:9: 1 pulled row(s) quarantined');
    saveCredentials(home, { hubs: { [hub]: { key: 'mh_k', user: 'alice', authFailed: true } } });
    r = await doctor(home, { env: embedEnv });
    expect(r.out).toContain('the hub rejected the key of alice');
    saveCredentials(home, { hubs: { [hub]: { key: 'mh_k', user: 'alice' } } });
    r = await doctor(home, { env: embedEnv });
    expect(r.out).toContain('ok   github.com/acme/app -> http://127.0.0.1:9: logged in as alice, hub protocol unknown (unreachable)');
    expect(r.out).not.toContain('mh_k');
  });
});
