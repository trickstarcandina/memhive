import { it, expect } from 'vitest';
import {
  chmodSync,
  lstatSync,
  symlinkSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectHosts, installClaudeCode, installCodex, uninstallCodex, type RunFn } from '../../src/install/hosts.js';
import { expectMode } from '../helpers/posix.js';

const calls: string[] = [];
const ok: RunFn = (c, a) => {
  calls.push(`${c} ${a.join(' ')}`);
  return { status: 0, stdout: '', stderr: '' };
};
const bad: RunFn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') });

it('detects hosts via injected exists', () => {
  expect(detectHosts({ CLAUDE_CONFIG_DIR: '/a', CODEX_HOME: '/b' }, (p) => p === '/a')).toEqual({
    claudeCode: true,
    codex: false,
  });
});
it('claude install runs marketplace add + install; prints manual steps on failure', () => {
  calls.length = 0;
  expect(installClaudeCode('/m', ok).some((l) => l.startsWith('Run inside'))).toBe(false);
  expect(calls).toContain('claude plugin install memhive@memhive-local');
  expect(installClaudeCode('/m', bad).some((l) => l.startsWith('Run inside Claude Code'))).toBe(true);
});
it('codex install edits config.toml in temp home, preserving other content; uninstall disables', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cx-'));
  const cfg = path.join(home, 'config.toml');
  writeFileSync(cfg, 'model = "x"  # mine\n\n[features]\nhooks = false\n');
  expect(installCodex('/m', home, ok).ok).toBe(true);
  expect(readFileSync(cfg, 'utf8')).toBe(
    'model = "x"  # mine\n\n[features]\nhooks = true\n\n[plugins."memhive@memhive-local"]\nenabled = true\n'
  );
  uninstallCodex(home, ok);
  expect(readFileSync(cfg, 'utf8')).toContain('enabled = false');
});
it('codex install writes nothing when the codex CLI fails', () => {
  const home = path.join(mkdtempSync(path.join(tmpdir(), 'cx-')), 'codex');
  const r = installCodex('/m', home, bad);
  expect(r.ok).toBe(false);
  expect(existsSync(home)).toBe(false);
});
it('codex install refuses a root dotted features key and leaves the file untouched', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cx-'));
  const cfg = path.join(home, 'config.toml');
  writeFileSync(cfg, 'features.hooks = false\n');
  const r = installCodex('/m', home, ok);
  expect(r.ok).toBe(false);
  expect(readFileSync(cfg, 'utf8')).toBe('features.hooks = false\n');
});
it('uninstall never appends a table', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cx-'));
  const cfg = path.join(home, 'config.toml');
  writeFileSync(cfg, 'model = "x"\n');
  uninstallCodex(home, ok);
  expect(readFileSync(cfg, 'utf8')).toBe('model = "x"\n');
});
it('installCodex keeps a backup of config.toml, replaces it atomically and keeps its mode', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cx-'));
  const cfg = path.join(home, 'config.toml');
  writeFileSync(cfg, 'model = "x"\n');
  chmodSync(cfg, 0o640);
  const ino = statSync(cfg).ino;
  expect(installCodex('/m', home, ok).ok).toBe(true);
  expect(readFileSync(`${cfg}.memhive-bak`, 'utf8')).toBe('model = "x"\n');
  expect(statSync(cfg).ino).not.toBe(ino); // renamed into place, not rewritten in place
  expectMode(cfg, 0o640);
  uninstallCodex(home, ok);
  expect(readFileSync(`${cfg}.memhive-bak`, 'utf8')).toBe('model = "x"\n'); // the first backup is never overwritten
  expect(readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
});
it('installCodex keeps a symlinked config.toml a symlink and edits its target', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cx-'));
  const dots = mkdtempSync(path.join(tmpdir(), 'cx-dots-'));
  const target = path.join(dots, 'config.toml');
  writeFileSync(target, 'model = "x"\n');
  symlinkSync(target, path.join(home, 'config.toml'));
  expect(installCodex('/m', home, ok).ok).toBe(true);
  expect(lstatSync(path.join(home, 'config.toml')).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, 'utf8')).toContain('hooks = true');
});
