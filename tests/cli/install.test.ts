import { describe, it, expect } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installCommand } from '../../src/cli/commands/install.js';
import { createDaemonContext, startDaemon } from '../../src/daemon/server.js';
import { readDaemonInfo } from '../../src/daemon/info.js';
import type { RunFn } from '../../src/install/hosts.js';

const repo = path.resolve(import.meta.dirname, '../..');
const run: RunFn = () => ({ status: 0, stdout: '', stderr: '' });
const io = () => { const out: string[] = []; const err: string[] = []; return { out, err, io: { stdout: (s: string) => out.push(s), stderr: (s: string) => err.push(s) } }; };

// Every path is a temp dir: never the real HOME, ~/.claude or ~/.codex.
function fixture() {
  const t = mkdtempSync(path.join(tmpdir(), 'mh-install-'));
  const root = path.join(t, 'pkg'); mkdirSync(path.join(root, 'dist'), { recursive: true });
  writeFileSync(path.join(root, 'dist', 'memhub.cjs'), '');
  cpSync(path.join(repo, 'plugin'), path.join(root, 'plugin'), { recursive: true });
  cpSync(path.join(repo, 'plugin-marketplace'), path.join(root, 'plugin-marketplace'), { recursive: true });
  const home = path.join(t, 'memhub');
  const env = { HOME: t, CODEX_HOME: path.join(t, 'codex'), CLAUDE_CONFIG_DIR: path.join(t, 'claude'), MEMHUB_HOME: home };
  return { root, home, env };
}

describe('install', () => {
  it('does not copy env-only values into settings.json', async () => {
    const f = fixture(); const r = io();
    const env = { ...f.env, MEMHUB_ANTHROPIC_API_KEY: 'sk-env-only', ANTHROPIC_API_KEY: 'sk-shell', MEMHUB_CONTEXT_TOKENS: '500' };
    expect(await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], r.io, { home: f.home, env, run, root: f.root })).toBe(0);
    const saved = readFileSync(path.join(f.home, 'settings.json'), 'utf8');
    expect(saved).not.toMatch(/sk-env-only|sk-shell/);
    expect(JSON.parse(saved).contextTokens).toBe(2000);
  });

  it('rejects non-numeric embedding dims instead of silently disabling embeddings', async () => {
    const f = fixture(); const r = io();
    const answers: Record<string, string> = { 'Embeddings base URL': 'http://127.0.0.1:9/v1', 'Embedding dims': 'abc' };
    const ask = async (q: string, def: string) => Object.entries(answers).find(([k]) => q.startsWith(k))?.[1] ?? def;
    expect(await installCommand(['--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], r.io, { home: f.home, env: f.env, run, root: f.root, ask })).toBe(2);
    expect(r.err.join('')).toContain('dims');
  });

  it('validates --host and --provider before any prompt', async () => {
    const f = fixture();
    const asked: string[] = [];
    const ask = async (q: string, def: string) => { asked.push(q); return def; };
    for (const args of [['--provider', 'bogus'], ['--host', 'vim'], ['--host']]) {
      const r = io();
      expect(await installCommand(args, r.io, { home: f.home, env: f.env, run, root: f.root, ask })).toBe(2);
    }
    expect(asked).toEqual([]);
  });

  it('stops a running daemon so the next hook starts the new bundle and settings', async () => {
    const f = fixture(); const r = io();
    const h = await startDaemon(createDaemonContext(f.home, f.env), { port: 0 });
    try {
      expect(await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], r.io, { home: f.home, env: f.env, run, root: f.root })).toBe(0);
      for (let i = 0; i < 40 && readDaemonInfo(f.home); i++) await new Promise((res) => setTimeout(res, 50));
      expect(readDaemonInfo(f.home)).toBeNull();
    } finally { await h.close(); }
  });
});
