import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectHosts, installClaudeCode, installCodex, uninstallCodex, type RunFn } from '../../src/install/hosts.js';

const calls: string[] = [];
const ok: RunFn = (c, a) => { calls.push(`${c} ${a.join(' ')}`); return { status: 0, stdout: '', stderr: '' }; };
const bad: RunFn = () => ({ status: null, stdout: '', stderr: '', error: new Error('ENOENT') });

it('detects hosts via injected exists', () => {
  expect(detectHosts({ CLAUDE_CONFIG_DIR: '/a', CODEX_HOME: '/b' }, (p) => p === '/a')).toEqual({ claudeCode: true, codex: false });
});
it('claude install runs marketplace add + install; prints manual steps on failure', () => {
  calls.length = 0;
  expect(installClaudeCode('/m', ok).some((l) => l.startsWith('Run inside'))).toBe(false);
  expect(calls).toContain('claude plugin install memhub@memhub-local');
  expect(installClaudeCode('/m', bad).some((l) => l.startsWith('Run inside Claude Code'))).toBe(true);
});
it('codex install edits config.toml in temp home, preserving other content; uninstall disables', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'cx-'));
  const cfg = path.join(home, 'config.toml');
  writeFileSync(cfg, 'model = "x"  # mine\n\n[features]\nhooks = false\n');
  installCodex('/m', home, ok);
  expect(readFileSync(cfg, 'utf8')).toBe('model = "x"  # mine\n\n[features]\nhooks = true\n\n[plugins."memhub@memhub-local"]\nenabled = true\n');
  uninstallCodex(home, ok);
  expect(readFileSync(cfg, 'utf8')).toContain('enabled = false');
});
