import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  writeFileSync(path.join(root, 'dist', 'memhive.cjs'), '');
  cpSync(path.join(repo, 'plugin'), path.join(root, 'plugin'), { recursive: true });
  cpSync(path.join(repo, 'plugin-marketplace'), path.join(root, 'plugin-marketplace'), { recursive: true });
  const home = path.join(t, 'memhive');
  const env = { HOME: t, CODEX_HOME: path.join(t, 'codex'), CLAUDE_CONFIG_DIR: path.join(t, 'claude'), MEMHIVE_HOME: home };
  return { root, home, env };
}

describe('install', () => {
  it('does not copy env-only values into settings.json', async () => {
    const f = fixture(); const r = io();
    const env = { ...f.env, MEMHIVE_ANTHROPIC_API_KEY: 'sk-env-only', ANTHROPIC_API_KEY: 'sk-shell', MEMHIVE_CONTEXT_TOKENS: '500' };
    expect(await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], r.io, { home: f.home, env, run, root: f.root })).toBe(0);
    const saved = readFileSync(path.join(f.home, 'settings.json'), 'utf8');
    expect(saved).not.toMatch(/sk-env-only|sk-shell/);
    expect(JSON.parse(saved).contextTokens).toBe(2000);
  });

  it('hints when only ANTHROPIC_API_KEY is set: the daemon does not read it', async () => {
    const f = fixture(); const r = io();
    expect(await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], r.io, { home: f.home, env: { ...f.env, ANTHROPIC_API_KEY: 'sk-shell' }, run, root: f.root })).toBe(0);
    expect(r.out.join('')).toContain('ANTHROPIC_API_KEY is set but memhive does not read it');
    const quiet = io(); const g = fixture();
    await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], quiet.io, { home: g.home, env: { ...g.env, ANTHROPIC_API_KEY: 'sk-shell', MEMHIVE_ANTHROPIC_API_KEY: 'sk-m' }, run, root: g.root });
    expect(quiet.out.join('')).not.toContain('ANTHROPIC_API_KEY is set');
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

describe('uninstall', () => {
  it('removes the rendered plugin marketplace but keeps memory', async () => {
    const f = fixture(); const r = io();
    expect(await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], r.io, { home: f.home, env: f.env, run, root: f.root })).toBe(0);
    const { uninstallCommand } = await import('../../src/cli/commands/uninstall.js');
    expect(await uninstallCommand([], r.io, { home: f.home, env: f.env, run })).toBe(0);
    expect(existsSync(path.join(f.home, 'marketplace'))).toBe(false);
    expect(existsSync(path.join(f.home, 'settings.json'))).toBe(true);
  });

  it('prints what stays and how to delete it', async () => {
    const f = fixture(); const r = io();
    await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], io().io, { home: f.home, env: f.env, run, root: f.root });
    const { uninstallCommand } = await import('../../src/cli/commands/uninstall.js');
    expect(await uninstallCommand([], r.io, { home: f.home, env: f.env, run })).toBe(0);
    expect(r.out.join('')).toContain(`Your data stays in ${f.home}`);
    expect(r.out.join('')).toContain('settings.json and credentials.json, which hold your LLM, embedding and hub API keys');
    expect(r.out.join('')).toContain(`rm -rf '${f.home}'`);
  });

  it('resets Codex [features] hooks only when memhive turned it on', async () => {
    const { uninstallCommand } = await import('../../src/cli/commands/uninstall.js');
    const cfg = (f: ReturnType<typeof fixture>) => path.join(f.env.CODEX_HOME, 'config.toml');
    const install = (f: ReturnType<typeof fixture>) => installCommand(['--yes', '--host', 'codex', '--provider', 'anthropic', '--no-ping'], io().io, { home: f.home, env: f.env, run, root: f.root });

    const a = fixture();
    expect(await install(a)).toBe(0);
    expect(await install(a)).toBe(0);   // the second install finds hooks on, but memhive still owns them
    let r = io(); await uninstallCommand([], r.io, { home: a.home, env: a.env, run });
    expect(readFileSync(cfg(a), 'utf8')).toMatch(/\[features\]\s*\nhooks = false/);
    expect(r.out.join('')).toContain('set [features] hooks = false');

    const b = fixture(); mkdirSync(b.env.CODEX_HOME, { recursive: true });
    writeFileSync(cfg(b), '[features]\nhooks = true\n');
    expect(await install(b)).toBe(0);
    r = io(); await uninstallCommand([], r.io, { home: b.home, env: b.env, run });
    expect(readFileSync(cfg(b), 'utf8')).toContain('hooks = true');
    expect(r.out.join('')).toContain('it was on before memhive');

    const c = fixture(); mkdirSync(c.env.CODEX_HOME, { recursive: true });   // installed by 0.1: nothing recorded
    writeFileSync(cfg(c), '[features]\nhooks = true\n');
    r = io(); await uninstallCommand([], r.io, { home: c.home, env: c.env, run });
    expect(readFileSync(cfg(c), 'utf8')).toContain('hooks = true');
    expect(r.out.join('')).toContain('memhive did not record whether it turned it on');
  });

  it('--purge deletes the home after a yes, and never a directory with foreign files', async () => {
    const { uninstallCommand } = await import('../../src/cli/commands/uninstall.js');
    const f = fixture();
    await installCommand(['--yes', '--host', 'claude-code', '--provider', 'anthropic', '--no-ping'], io().io, { home: f.home, env: f.env, run, root: f.root });
    let r = io(); expect(await uninstallCommand(['--purge'], r.io, { home: f.home, env: f.env, run, input: Readable.from(['n\n']) })).toBe(1);
    expect(existsSync(path.join(f.home, 'settings.json'))).toBe(true);
    writeFileSync(path.join(f.home, 'notes.txt'), 'mine');
    r = io(); expect(await uninstallCommand(['--purge', '--yes'], r.io, { home: f.home, env: f.env, run })).toBe(1);
    expect(r.err.join('')).toContain('notes.txt');
    expect(existsSync(f.home)).toBe(true);
    rmSync(path.join(f.home, 'notes.txt'));
    r = io(); expect(await uninstallCommand(['--purge'], r.io, { home: f.home, env: f.env, run, input: Readable.from(['y\n']) })).toBe(0);
    expect(existsSync(f.home)).toBe(false);
  });
});
