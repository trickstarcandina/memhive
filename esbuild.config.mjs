import { build } from 'esbuild';
await build({
  entryPoints: ['src/cli/index.ts'],
  bundle: true, platform: 'node', target: 'node22', format: 'cjs',
  outfile: 'dist/memhive.cjs',
  external: ['better-sqlite3', 'sqlite-vec', 'pg'],
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: true, logLevel: 'info',
});
