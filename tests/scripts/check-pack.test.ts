import { it, expect } from 'vitest';
// @ts-expect-error -- plain .mjs script without type declarations
import { checkPackFiles } from '../../scripts/check-pack.mjs';

const GOOD = [
  'LICENSE',
  'README.md',
  'dist/memhive.cjs',
  'package.json',
  'plugin-marketplace/.agents/plugins/marketplace.json',
  'plugin-marketplace/.claude-plugin/marketplace.json',
  'plugin/.claude-plugin/plugin.json',
  'plugin/.codex-plugin/plugin.json',
  'plugin/.mcp.json',
  'plugin/hooks/hooks.json',
  'plugin/skills/mem-search/SKILL.md',
];

it('accepts the expected package contents', () => {
  expect(checkPackFiles(GOOD)).toEqual([]);
});

it('rejects sourcemaps, sources and tests', () => {
  expect(checkPackFiles([...GOOD, 'dist/memhive.cjs.map', 'src/cli/index.ts', 'tests/a.test.ts'])).toEqual([
    'unexpected file: dist/memhive.cjs.map',
    'unexpected file: src/cli/index.ts',
    'unexpected file: tests/a.test.ts',
  ]);
});

it('reports a dropped dot-directory and a missing bundle', () => {
  const files = GOOD.filter((f) => !f.startsWith('plugin/.codex-plugin/') && f !== 'dist/memhive.cjs');
  expect(checkPackFiles(files)).toEqual(['missing file: dist/memhive.cjs', 'missing directory: plugin/.codex-plugin/']);
});
