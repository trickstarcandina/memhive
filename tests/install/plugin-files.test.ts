import { it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { renderPluginDir } from '../../src/install/plugin-files.js';

it('renders templates with absolute node and bundle paths', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mh-'));
  const mk = path.join(root, 'marketplace');
  renderPluginDir({ templateRoot: path.resolve('.'), marketplaceRoot: mk, nodePath: '/usr/bin/node', bundlePath: '/opt/memhub/dist/memhub.cjs', version: '9.9.9' });
  const hooks = JSON.parse(readFileSync(path.join(mk, 'plugin', 'hooks', 'hooks.json'), 'utf8'));
  expect(hooks.hooks.SessionStart[0].hooks[0]).toMatchObject({ command: '/usr/bin/node', args: ['/opt/memhub/dist/memhub.cjs', 'hook', 'claude-code', 'SessionStart'] });
  expect(JSON.parse(readFileSync(path.join(mk, '.claude-plugin', 'marketplace.json'), 'utf8')).plugins[0].version).toBe('9.9.9');
  expect(existsSync(path.join(mk, '.agents', 'plugins', 'marketplace.json'))).toBe(true);
  expect(existsSync(path.join(mk, 'plugin', 'skills', 'mem-search', 'SKILL.md'))).toBe(true);
  expect(readFileSync(path.join(mk, 'plugin', '.mcp.json'), 'utf8')).not.toContain('{{');
});

it('keeps paths with spaces and backslashes intact as single args', () => {
  const mk = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'mk');
  renderPluginDir({ templateRoot: path.resolve('.'), marketplaceRoot: mk, nodePath: 'C:\\Program Files\\node.exe', bundlePath: '/my dir/memhub.cjs', version: '1.0.0' });
  const h = JSON.parse(readFileSync(path.join(mk, 'plugin', 'hooks', 'hooks.json'), 'utf8')).hooks.Stop[0].hooks[0];
  expect(h).toMatchObject({ command: 'C:\\Program Files\\node.exe', args: ['/my dir/memhub.cjs', 'hook', 'claude-code', 'Stop'] });
  expect(JSON.parse(readFileSync(path.join(mk, 'plugin', '.mcp.json'), 'utf8')).mcpServers.memhub.args[0]).toBe('/my dir/memhub.cjs');
});

it('renders a single shell-quoted command string for Codex hooks', () => {
  const mk = path.join(mkdtempSync(path.join(tmpdir(), 'mh-')), 'mk');
  renderPluginDir({ templateRoot: path.resolve('.'), marketplaceRoot: mk, nodePath: '/usr/bin/node', bundlePath: "/my dir/it's/memhub.cjs", version: '1.0.0' });
  const h = JSON.parse(readFileSync(path.join(mk, 'plugin', 'hooks', 'codex-hooks.json'), 'utf8')).hooks.Stop[0].hooks[0];
  expect(h.args).toBeUndefined();
  expect(h.command).toBe("'/usr/bin/node' '/my dir/it'\\''s/memhub.cjs' hook codex Stop");
});
