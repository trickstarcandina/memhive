import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: 'dist/memhive.cjs',
  external: ['better-sqlite3', 'sqlite-vec', 'pg'],
  banner: { js: '#!/usr/bin/env node' },
  define: { __MEMHIVE_VERSION__: JSON.stringify(version) },
  // No sourcemap: it is not shipped in the package, and a stale one left in dist/ would be.
  logLevel: 'info',
});
