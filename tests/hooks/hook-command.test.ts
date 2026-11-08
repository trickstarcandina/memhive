import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runHook } from '../../src/hooks/hook-command.js';
import { readStdin, STDIN_LIMIT } from '../../src/hooks/stdin.js';
import { PassThrough } from 'node:stream';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';

const mkHome = () => mkdtempSync(path.join(tmpdir(), 'mh-'));
const env = { MEMHUB_LLM_PROVIDER: 'openai-compat', MEMHUB_LLM_BASE_URL: 'http://127.0.0.1:9', MEMHUB_LLM_MODEL: 'x' };

describe('runHook', () => {
  it('session-start prints context JSON when daemon is up', async () => {
    const home = mkHome(); const h = await startDaemon(createDaemonContext(home, env), { port: 0 });
    const out: string[] = [];
    const code = await runHook(['claude-code', 'SessionStart'], { home, readStdin: async () => JSON.stringify({ session_id: 's1', cwd: home, hook_event_name: 'SessionStart', source: 'startup' }), stdout: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('')).hookSpecificOutput.additionalContext).toContain('memhub ·');
    await h.close();
  });
  it('exits 0 and logs on invalid JSON, empty stdin, unknown host, missing daemon', async () => {
    const home = mkHome(); const out: string[] = [];
    expect(await runHook(['claude-code', 'PostToolUse'], { home, readStdin: async () => '{not json', stdout: (s) => out.push(s), ensureDaemon: async () => null })).toBe(0);
    expect(await runHook(['claude-code', 'PostToolUse'], { home, readStdin: async () => '', stdout: (s) => out.push(s), ensureDaemon: async () => null })).toBe(0);
    expect(await runHook(['vim', 'PostToolUse'], { home, readStdin: async () => '{}', stdout: (s) => out.push(s) })).toBe(0);
    expect(await runHook(['claude-code', 'SessionStart'], { home, readStdin: async () => JSON.stringify({ session_id: 's', cwd: home, hook_event_name: 'SessionStart' }), stdout: (s) => out.push(s), ensureDaemon: async () => null })).toBe(0);
    expect(out).toEqual([]);
    expect(existsSync(path.join(home, 'logs', 'hook.log'))).toBe(true);
    expect(readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8')).toContain('invalid JSON');
  });
  it('oversize, whitespace-only, non-object and throwing stdin exit 0, log, print nothing, never touch the daemon', async () => {
    const home = mkHome(); const out: string[] = []; let ensured = 0;
    const base = { home, stdout: (s: string) => out.push(s), ensureDaemon: (async () => { ensured++; return null; }) as never };
    const big = JSON.stringify({ session_id: 's', cwd: home, hook_event_name: 'PostToolUse', tool_name: 'x', tool_input: 'a'.repeat(3 * 1024 * 1024) });
    expect(await runHook(['claude-code', 'PostToolUse'], { ...base, readStdin: async () => big })).toBe(0);
    expect(await runHook(['claude-code', 'PostToolUse'], { ...base, readStdin: async () => ' \n\t ' })).toBe(0);
    expect(await runHook(['claude-code', 'PostToolUse'], { ...base, readStdin: async () => 'null' })).toBe(0);
    expect(await runHook(['claude-code', 'PostToolUse'], { ...base, readStdin: async () => '[1,2]' })).toBe(0);
    expect(await runHook(['claude-code', 'PostToolUse'], { ...base, readStdin: async () => { throw new Error('boom'); } })).toBe(0);
    expect(await runHook([], { ...base, readStdin: async () => '{}' })).toBe(0);
    expect(out).toEqual([]); expect(ensured).toBe(0);
    const log = readFileSync(path.join(home, 'logs', 'hook.log'), 'utf8');
    expect(log).toContain('stdin too large'); expect(log).toContain('empty stdin'); expect(log).toContain('hook failed');
  });
  it('tool events are fire-and-forget with a 250 ms budget', async () => {
    const home = mkHome(); const h = await startDaemon(createDaemonContext(home, env), { port: 0 });
    let seenTimeout = 0;
    const slowFetch: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/v1/events')) {
        seenTimeout++;
        await new Promise<void>((resolve, reject) => { const t = setTimeout(resolve, 1000); init?.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }); });
      }
      return fetch(url, init);
    };
    const t0 = Date.now();
    const code = await runHook(['codex', 'PostToolUse'], { home, fetchImpl: slowFetch, readStdin: async () => JSON.stringify({ session_id: 's1', cwd: home, hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: {}, tool_response: 'x' }) });
    expect(code).toBe(0);
    expect(Date.now() - t0).toBeLessThan(900);
    expect(seenTimeout).toBe(1);
    await h.close();
  });
  it('readStdin keeps one byte past the limit so the caller can tell oversize from invalid JSON', async () => {
    const input = new PassThrough();
    const p = readStdin(STDIN_LIMIT, input, 1000);
    input.end(Buffer.alloc(STDIN_LIMIT + 100, 'a'));
    expect((await p).length).toBe(STDIN_LIMIT + 1);
  });
  it('readStdin gives up when the host never closes stdin', async () => {
    const input = new PassThrough(); input.write('{"partial":');
    const t0 = Date.now();
    expect(await readStdin(STDIN_LIMIT, input, 100)).toBe('{"partial":');
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
