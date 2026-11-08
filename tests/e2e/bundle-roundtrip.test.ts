import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { waitFor } from '../helpers/wait.js';

// The real bundle in real processes: hooks spawn the detached daemon through the default spawn, the native modules load
// from inside the bundle, MCP runs over stdio. CI runs it after `npm run build`; without a build it is skipped.
const BUNDLE = path.resolve(import.meta.dirname, '../../dist/memhive.cjs');

const root = mkdtempSync(path.join(tmpdir(), 'mh-e2e-'));
const dirs = { HOME: path.join(root, 'home'), MEMHIVE_HOME: path.join(root, 'mh'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex') };
const project = path.join(root, 'project');
let llm: Server; let llmCalls = 0; let env: NodeJS.ProcessEnv = {};

const run = (args: string[], stdin = '', timeoutMs = 10_000) => new Promise<{ code: number | null; out: string; err: string; ms: number }>((resolve, reject) => {
  const t0 = Date.now();
  const c = spawn(process.execPath, [BUNDLE, ...args], { cwd: project, env, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
  const kill = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
  c.on('error', reject);
  c.on('close', (code) => { clearTimeout(kill); resolve({ code, out, err, ms: Date.now() - t0 }); });
  c.stdin.end(stdin);
});
const hook = (event: string, extra: object) => run(['hook', 'claude-code', event], JSON.stringify({ session_id: 'e2e-1', cwd: project, hook_event_name: event, ...extra }));
const daemonPid = (): number | null => { try { return JSON.parse(readFileSync(path.join(dirs.MEMHIVE_HOME, 'daemon.json'), 'utf8')).pid; } catch { return null; } };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe.skipIf(!existsSync(BUNDLE))('built bundle round trip', () => {
  let pid: number | null = null;
  beforeAll(async () => {
    for (const d of [...Object.values(dirs), project]) mkdirSync(d, { recursive: true });
    llm = createServer((req, res) => {
      let body = ''; req.on('data', (c) => (body += c));
      req.on('end', () => {
        llmCalls++;
        const system = JSON.parse(body).messages[0].content as string;
        const content = system.includes('summarize one turn')
          ? { request: 'wire the e2e test', learned: 'bundle works', completed: 'round trip', next_steps: '' }
          : { observations: [{ type: 'decision', title: 'Bundle e2e marker zebracorn', facts: ['detached daemon'], narrative: 'Hooks reached the daemon.' }] };
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
      });
    });
    await new Promise<void>((r) => llm.listen(0, '127.0.0.1', r));
    // only what a user would have, pointed at temp dirs; no MEMHIVE_* from the outer shell
    env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('MEMHIVE_')));
    Object.assign(env, dirs, { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: `http://127.0.0.1:${(llm.address() as AddressInfo).port}/v1`, MEMHIVE_LLM_MODEL: 'fake' });
  });
  afterAll(async () => {
    // never leave the detached daemon behind, even when an assertion failed
    for (const p of [pid, daemonPid()]) if (p && alive(p)) process.kill(p, 'SIGKILL');
    await new Promise<void>((r) => llm.close(() => r()));
  });

  it('hooks, detached daemon, observer, search, MCP over stdio, daemon stop', { timeout: 60_000 }, async () => {
    // (a) SessionStart spawns the daemon and prints context
    const start = await hook('SessionStart', { source: 'startup' });
    expect(start.code, start.err).toBe(0);
    const out = JSON.parse(start.out);
    expect(out.hookSpecificOutput.additionalContext).toContain('memhive ·');
    pid = daemonPid(); expect(pid).not.toBeNull(); expect(alive(pid!)).toBe(true); expect(pid).not.toBe(process.pid);

    // (b) 8 tool events and a Stop, each a separate process within the 2 s budget
    for (let i = 0; i < 8; i++) {
      const r = await hook('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: path.join(project, `f${i}.ts`) }, tool_response: { success: true } });
      expect(r.code).toBe(0); expect(r.ms).toBeLessThan(2000);
    }
    const stop = await hook('Stop', { stop_hook_active: false });
    expect(stop.code).toBe(0); expect(stop.ms).toBeLessThan(2000);

    // (c) the fake LLM was called and the observation is searchable through the CLI
    await waitFor(() => llmCalls > 0, { timeout: 15_000, what: 'LLM called' });
    const hit = await waitFor(async () => { const r = await run(['search', '--json', 'zebracorn']); return r.code === 0 && JSON.parse(r.out).results?.length ? JSON.parse(r.out).results[0] : null; }, { timeout: 15_000, interval: 200, what: 'observation searchable' });
    expect(hit.title).toBe('Bundle e2e marker zebracorn');

    // (d) MCP over stdio
    const transport = new StdioClientTransport({ command: process.execPath, args: [BUNDLE, 'mcp'], cwd: project, env: env as Record<string, string>, stderr: 'pipe' });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    try {
      const text = (r: any) => (r.content as Array<{ text: string }>).map((c) => c.text).join('\n');
      const s = text(await client.callTool({ name: 'search', arguments: { query: 'zebracorn' } }));
      expect(s).toContain('zebracorn');
      const id = s.match(/#([0-9a-f]{8})/)![1];
      expect(text(await client.callTool({ name: 'timeline', arguments: { anchor_id: id } }))).toContain('zebracorn');
      const full = text(await client.callTool({ name: 'get_observations', arguments: { ids: [id] } }));
      expect(full).toContain('Hooks reached the daemon.'); expect(full).toContain('<<<narrative');
    } finally { await client.close(); }

    // (e) daemon stop: process gone, daemon.json and lock removed
    const st = await run(['daemon', 'stop']);
    expect(st.code).toBe(0);
    await waitFor(() => !alive(pid!), { timeout: 15_000, what: 'daemon exited' });
    expect(existsSync(path.join(dirs.MEMHIVE_HOME, 'daemon.json'))).toBe(false);
    expect(existsSync(path.join(dirs.MEMHIVE_HOME, 'daemon.lock'))).toBe(false);
  });
});
