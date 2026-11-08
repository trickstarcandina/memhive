import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from '../../src/cli/args.js';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { searchCommand } from '../../src/cli/commands/search.js';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { readDaemonInfo } from '../../src/daemon/info.js';
import { deadUrl } from '../helpers/closed-port.js';
import { waitFor } from '../helpers/wait.js';

const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } }; };
const env = { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' };

it('parseArgs', () => {
  expect(parseArgs(['q', 'w', '--type', 'bugfix', '--yes', '--limit=5'])).toEqual({ positional: ['q', 'w'], flags: { type: 'bugfix', yes: true, limit: '5' } });
});

describe('commands', () => {
  it('daemon status reports stopped, then running; stop shuts it down', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    let r = io(); expect(await daemonCommand(['status'], r.io, { home })).toBe(1); expect(r.out.join('')).toContain('not running');
    const h = await startDaemon(createDaemonContext(home, env), { port: 0 });
    r = io(); expect(await daemonCommand(['status'], r.io, { home })).toBe(0); expect(r.out.join('')).toContain(`port ${h.info.port}`);
    r = io(); expect(await daemonCommand(['stop'], r.io, { home })).toBe(0);
    await waitFor(() => !readDaemonInfo(home), { what: 'daemon.json removed' });
  });
  it.skipIf(process.platform !== 'linux')('stop ends a daemon that fails the health proof (older build) by pid, only when it is ours', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const fake = (args: string[], env: NodeJS.ProcessEnv) => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', ...args], { env, stdio: 'ignore' });
    const exited = (c: ReturnType<typeof spawn>) => new Promise<boolean>((res) => { if (c.exitCode !== null || c.signalCode) res(true); c.once('exit', () => res(true)); setTimeout(() => res(false), 2000); });
    const stranger = fake(['other', 'daemon', 'run'], { MEMHIVE_HOME: home });
    const writeInfo = (pid: number) => writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port: 9, pid, token: 't', startedAt: '' }));
    // stop identifies the process by /proc/<pid>/cmdline and environ: wait until the child shows its own, not node's pre-exec ones
    const started = (c: ReturnType<typeof spawn>) => waitFor(() => { try { return readFileSync(`/proc/${c.pid}/cmdline`, 'utf8').includes('daemon\0run'); } catch { return false; } }, { what: 'fake daemon started' });
    await started(stranger);
    writeInfo(stranger.pid!);
    let r = io(); await daemonCommand(['stop'], r.io, { home });
    expect(r.out.join('')).toContain('not running');
    expect(await Promise.race([exited(stranger), new Promise((res) => setTimeout(() => res(false), 300))])).toBe(false);
    stranger.kill();
    const old = fake(['/x/memhive.cjs', 'daemon', 'run'], { MEMHIVE_HOME: home });
    await started(old);
    writeInfo(old.pid!);
    r = io(); await daemonCommand(['stop'], r.io, { home });
    expect(r.out.join('')).toContain(`(pid ${old.pid})`);
    expect(await exited(old)).toBe(true);
  });
  it('search prints an index table', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const h = await startDaemon(createDaemonContext(home, env), { port: 0 });
    const r = io();
    expect(await searchCommand(['anything'], r.io, { home, cwd: home })).toBe(0);
    expect(r.out.join('')).toContain('No observations');
    await h.close();
  });
  it('doctor reports settings and daemon state without printing secrets', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const r = io();
    const code = await doctorCommand([], r.io, { home, env: { ...env, MEMHIVE_LLM_API_KEY: 'sk-secret-123' }, ping: false });
    expect(code).toBe(0);   // no embedder is a valid FTS-only setup
    const text = r.out.join('');
    expect(text).toContain('provider');
    expect(text).toContain('FTS-only');
    expect(text).toContain('api key set');
    expect(text).not.toContain('sk-secret-123');
  });
  it('doctor reports an observer auth failure from the running daemon', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    const ctx = createDaemonContext(home, env);
    const h = await startDaemon(ctx, { port: 0 });
    try {
      let r = io(); await doctorCommand([], r.io, { home, env, ping: false });
      expect(r.out.join('')).toContain('ok   observer');
      ctx.observer['authFailedAt'] = Date.now();
      r = io(); expect(await doctorCommand([], r.io, { home, env, ping: false })).toBe(1);
      expect(r.out.join('')).toMatch(/FAIL observer: .*401\/403/);
    } finally { await h.close(); }
  });
  it('doctor survives a malformed settings.json', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'mh-'));
    writeFileSync(path.join(home, 'settings.json'), '{not json');
    const r = io();
    await expect(doctorCommand([], r.io, { home, env, ping: false })).resolves.toBeTypeOf('number');
  });
  it('search rejects a bad --limit with usage and code 2', async () => {
    const r = io();
    expect(await searchCommand(['q', '--limit', 'abc'], r.io, { home: mkdtempSync(path.join(tmpdir(), 'mh-')) })).toBe(2);
    expect(r.err.join('')).toContain('usage');
    expect(await searchCommand(['q', '--limit'], io().io, { home: mkdtempSync(path.join(tmpdir(), 'mh-')) })).toBe(2);   // bare flag is not 1
  });
});
