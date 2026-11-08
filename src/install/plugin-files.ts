import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function renderPluginDir(opts: { templateRoot: string; marketplaceRoot: string; nodePath: string; bundlePath: string; version: string }): void {
  rmSync(opts.marketplaceRoot, { recursive: true, force: true });
  mkdirSync(opts.marketplaceRoot, { recursive: true });
  cpSync(path.join(opts.templateRoot, 'plugin-marketplace'), opts.marketplaceRoot, { recursive: true });
  cpSync(path.join(opts.templateRoot, 'plugin'), path.join(opts.marketplaceRoot, 'plugin'), { recursive: true });
  const vars: Record<string, string> = { NODE: opts.nodePath, BUNDLE: opts.bundlePath, VERSION: opts.version };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(json|md)$/.test(name)) continue;
      const src = readFileSync(p, 'utf8');
      // JSON string values: escape backslashes/quotes; args are separate array items so spaces in paths need no shell quoting.
      const out = src.replace(/\{\{(NODE|BUNDLE|VERSION)\}\}/g, (_, k: string) => (name.endsWith('.json') ? JSON.stringify(vars[k]).slice(1, -1) : vars[k]));
      if (out !== src) writeFileSync(p, out);
    }
  };
  walk(opts.marketplaceRoot);
}
