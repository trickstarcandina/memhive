import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// POSIX single-quote escaping, for hosts whose hook command is one shell string.
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
// Codex on Windows runs `%COMSPEC% /C "<commandWindows>"`; a Windows path cannot contain `"`, so double quotes suffice.
// shortcut: a path with %NAME% of a defined env var is still expanded by cmd.exe; escape it if that ever shows up.
const cmdq = (s: string) => `"${s}"`;

export function renderPluginDir(opts: { templateRoot: string; marketplaceRoot: string; nodePath: string; bundlePath: string; version: string }): void {
  rmSync(opts.marketplaceRoot, { recursive: true, force: true });
  mkdirSync(opts.marketplaceRoot, { recursive: true });
  cpSync(path.join(opts.templateRoot, 'plugin-marketplace'), opts.marketplaceRoot, { recursive: true });
  cpSync(path.join(opts.templateRoot, 'plugin'), path.join(opts.marketplaceRoot, 'plugin'), { recursive: true });
  const vars: Record<string, string> = { NODE: opts.nodePath, BUNDLE: opts.bundlePath, VERSION: opts.version, NODE_SH: shq(opts.nodePath), BUNDLE_SH: shq(opts.bundlePath), NODE_CMD: cmdq(opts.nodePath), BUNDLE_CMD: cmdq(opts.bundlePath) };
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(json|md)$/.test(name)) continue;
      const src = readFileSync(p, 'utf8');
      // JSON string values: escape backslashes/quotes. *_SH / *_CMD vars are quoted for sh / cmd.exe (Codex runs shell strings); plain vars are raw.
      const out = src.replace(/\{\{(NODE_SH|BUNDLE_SH|NODE_CMD|BUNDLE_CMD|NODE|BUNDLE|VERSION)\}\}/g, (_, k: string) => (name.endsWith('.json') ? JSON.stringify(vars[k]).slice(1, -1) : vars[k]));
      if (out !== src) writeFileSync(p, out);
    }
  };
  walk(opts.marketplaceRoot);
}
