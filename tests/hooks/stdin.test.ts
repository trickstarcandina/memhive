import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { readStdin, STDIN_LIMIT } from '../../src/hooks/stdin.js';
import { runHook } from '../../src/hooks/hook-command.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const original = Object.getOwnPropertyDescriptor(process, 'stdin')!;
const fakeStdin = (props: object = {}) => {
  const s = Object.assign(new PassThrough(), props);
  Object.defineProperty(process, 'stdin', { value: s, configurable: true });
  return s;
};
afterEach(() => Object.defineProperty(process, 'stdin', original));

describe('readStdin', () => {
  it('reads all chunks as utf8', async () => {
    const s = fakeStdin(); const p = readStdin();
    s.write('{"a":'); s.write('"é"}'); s.end();
    expect(await p).toBe('{"a":"é"}');
  });
  it('returns empty string for a TTY without reading', async () => {
    fakeStdin({ isTTY: true });
    expect(await readStdin()).toBe('');
  });
  it('truncates input beyond the limit', async () => {
    const s = fakeStdin(); const p = readStdin(5);
    s.write('abc'); s.write('defgh'); s.write('zzz'); s.end();
    expect(await p).toBe('abcde');
  });
  it('default limit is 2 MiB', async () => {
    expect(STDIN_LIMIT).toBe(2 * 1024 * 1024);
    const s = fakeStdin(); const p = readStdin();
    s.end(Buffer.alloc(STDIN_LIMIT + 1000, 'x'));
    expect((await p).length).toBe(STDIN_LIMIT);
  });
  it('resolves empty on stream error', async () => {
    const s = fakeStdin(); const p = readStdin();
    s.destroy(new Error('boom'));
    expect(await p).toBe('');
  });
  it('empty stdin yields empty string', async () => {
    const s = fakeStdin(); const p = readStdin(); s.end();
    expect(await p).toBe('');
  });
});

describe('runHook session-start failure path', () => {
  const home = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
  const startEvent = (cwd: string) => JSON.stringify({ session_id: 's1', cwd, hook_event_name: 'SessionStart', source: 'startup' });
  const info = { port: 1, pid: process.pid, token: 't', startedAt: new Date().toISOString() };

  it('daemon answers 500: exit 0, nothing on stdout, error logged', async () => {
    const h = home(); const out: string[] = [];
    const fetchImpl = (async () => new Response('{"error":{"code":"internal","message":"internal error"}}', { status: 500 })) as unknown as typeof fetch;
    const code = await runHook(['claude-code', 'SessionStart'], { home: h, readStdin: async () => startEvent(h), stdout: (s) => out.push(s), ensureDaemon: async () => info, fetchImpl });
    expect(code).toBe(0); expect(out).toEqual([]);
    expect(readFileSync(path.join(h, 'logs', 'hook.log'), 'utf8')).toContain('hook failed');
  });
  it('daemon unreachable (fetch rejects): exit 0, nothing on stdout', async () => {
    const h = home(); const out: string[] = [];
    const fetchImpl = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const code = await runHook(['claude-code', 'SessionStart'], { home: h, readStdin: async () => startEvent(h), stdout: (s) => out.push(s), ensureDaemon: async () => info, fetchImpl });
    expect(code).toBe(0); expect(out).toEqual([]);
    expect(readFileSync(path.join(h, 'logs', 'hook.log'), 'utf8')).toContain('hook failed');
  });
  it('ensureDaemon throwing is swallowed', async () => {
    const h = home(); const out: string[] = [];
    const code = await runHook(['claude-code', 'SessionStart'], { home: h, readStdin: async () => startEvent(h), stdout: (s) => out.push(s), ensureDaemon: async () => { throw new Error('spawn failed'); } });
    expect(code).toBe(0); expect(out).toEqual([]);
  });
  it('empty context from daemon prints nothing', async () => {
    const h = home(); const out: string[] = [];
    const fetchImpl = (async () => new Response('{"context":""}', { status: 200 })) as unknown as typeof fetch;
    const code = await runHook(['claude-code', 'SessionStart'], { home: h, readStdin: async () => startEvent(h), stdout: (s) => out.push(s), ensureDaemon: async () => info, fetchImpl });
    expect(code).toBe(0); expect(out).toEqual([]);
  });
});
