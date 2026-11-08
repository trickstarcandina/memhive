import { describe, it, expect } from 'vitest';
import { spawnSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installCommand } from '../../src/cli/commands/install.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import type { RunFn } from '../../src/install/hosts.js';
import { deadUrl } from '../helpers/closed-port.js';

const repo = path.resolve(import.meta.dirname, '../..');
const BUNDLE = path.join(repo, 'dist', 'memhive.cjs');
const run: RunFn = () => ({ status: 0, stdout: '', stderr: '' });
const io = { stdout: () => {}, stderr: () => {} };

/** How cmd.exe reads one command line: quotes toggle, ^ escapes outside quotes, spaces split outside quotes. */
function cmdTokens(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false; let any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { q = !q; any = true; continue; }
    if (!q && c === '^') { cur += line[++i] ?? ''; any = true; continue; }
    if (!q && c === '%') throw new Error(`unescaped % at ${i}: cmd.exe would expand it`);
    if (q && c === '%') throw new Error(`% inside quotes at ${i}: cmd.exe still expands it`);
    if (!q && c === ' ') { if (any) out.push(cur); cur = ''; any = false; continue; }
    cur += c; any = true;
  }
  if (q) throw new Error('unbalanced quotes');
  if (any) out.push(cur);
  return out;
}

describe.skipIf(!existsSync(BUNDLE) || process.platform === 'win32')('install, then the rendered Codex hook', () => {
  it('the rendered command runs through sh -c, reaches the daemon and prints context; commandWindows is well-formed', { timeout: 30_000 }, async () => {
    const t = mkdtempSync(path.join(tmpdir(), 'mh-insthook-'));
    // a package dir whose path needs quoting in both shells: templates copied, dist linked to this checkout's build
    // (node resolves the bundle's native modules from its real path)
    const root = path.join(t, "pkg %PATH% it's $HOME");
    mkdirSync(root);
    for (const d of ['plugin', 'plugin-marketplace']) cpSync(path.join(repo, d), path.join(root, d), { recursive: true });
    symlinkSync(path.join(repo, 'dist'), path.join(root, 'dist'));
    const home = path.join(t, 'memhive'); const project = path.join(t, 'project'); mkdirSync(project);
    const env = { HOME: t, CODEX_HOME: path.join(t, 'codex'), CLAUDE_CONFIG_DIR: path.join(t, 'claude'), MEMHIVE_HOME: home };
    expect(await installCommand(['--yes', '--host', 'codex', '--provider', 'openai-compat', '--no-ping'], io, { home, env: { ...env, MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' }, run, root })).toBe(0);

    const hooks = JSON.parse(readFileSync(path.join(home, 'marketplace', 'plugin', 'hooks', 'codex-hooks.json'), 'utf8'));
    const entry = hooks.hooks.SessionStart[0].hooks[0];
    const bundle = path.join(root, 'dist', 'memhive.cjs');
    expect(cmdTokens(entry.commandWindows)).toEqual([process.execPath, bundle, 'hook', 'codex', 'SessionStart']);
    expect(entry.commandWindows).toContain('"^%"PATH"^%"');

    const d = await startDaemon(createDaemonContext(home, { MEMHIVE_LLM_PROVIDER: 'openai-compat', MEMHIVE_LLM_BASE_URL: deadUrl, MEMHIVE_LLM_MODEL: 'x' }), { port: 0 });
    try {
      // spawn (not spawnSync): the in-process daemon must keep serving while the hook runs
      const r = await new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const c = spawn('sh', ['-c', entry.command], { cwd: project, env: { PATH: process.env.PATH, ...env } });
        let out = ''; let err = ''; c.stdout.on('data', (x) => (out += x)); c.stderr.on('data', (x) => (err += x));
        c.on('close', (code) => resolve({ code, out, err }));
        c.stdin.end(JSON.stringify({ session_id: 'cx-install', cwd: project, hook_event_name: 'SessionStart', source: 'startup', model: 'gpt-5-codex' }));
      });
      expect(r.code, r.err).toBe(0);
      expect(JSON.stringify(JSON.parse(r.out))).toContain('memhive ·');
    } finally { await d.close(); }
    expect(spawnSync('sh', ['-n', '-c', entry.command]).status).toBe(0);
  });
});
