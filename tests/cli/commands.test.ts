import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from '../../src/cli/args.js';
import { daemonCommand } from '../../src/cli/commands/daemon.js';
import { searchCommand } from '../../src/cli/commands/search.js';
import { doctorCommand } from '../../src/cli/commands/doctor.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { readDaemonInfo } from '../../src/daemon/info.js';

const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } }; };
const env = { MEMHUB_LLM_PROVIDER: 'openai-compat', MEMHUB_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHUB_LLM_MODEL: 'x' };

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
    for (let i = 0; i < 40 && readDaemonInfo(home); i++) await new Promise((res) => setTimeout(res, 50));
    expect(readDaemonInfo(home)).toBeNull();
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
    const code = await doctorCommand([], r.io, { home, env: { ...env, MEMHUB_LLM_API_KEY: 'sk-secret-123' }, ping: false });
    expect(code).toBe(0);   // no embedder is a valid FTS-only setup
    const text = r.out.join('');
    expect(text).toContain('provider');
    expect(text).toContain('FTS-only');
    expect(text).toContain('api key set');
    expect(text).not.toContain('sk-secret-123');
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
  });
});
