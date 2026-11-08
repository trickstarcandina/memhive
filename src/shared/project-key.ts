import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

export function normalizeRemote(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^[a-z+]+:\/\//i, '');          // scheme
  s = s.replace(/^[^@/]+@/, '');                 // user@
  s = s.replace(/^([^:/]+):(\d+)\//, '$1/');     // host:port/ -> host/
  s = s.replace(/^([^:/]+):/, '$1/');            // scp-like host:path
  s = s.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  if (!/^[^/]+\/.+/.test(s) || /\s/.test(s)) return null;
  return s.toLowerCase();
}

export interface ProjectKeyDeps { gitRemote: (cwd: string) => string | null; gitTopLevel: (cwd: string) => string | null }

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000 });
  return r.status === 0 ? r.stdout.trim() || null : null;
}
const defaultDeps: ProjectKeyDeps = {
  gitRemote: (cwd) => git(cwd, ['config', '--get', 'remote.origin.url']),
  gitTopLevel: (cwd) => git(cwd, ['rev-parse', '--show-toplevel']),
};

export function projectKeyFor(cwd: string, deps: ProjectKeyDeps = defaultDeps): { key: string; name: string } {
  const remote = deps.gitRemote(cwd);
  const key = remote ? normalizeRemote(remote) : null;
  const top = deps.gitTopLevel(cwd) ?? cwd;
  const name = path.basename(key ?? top) || path.basename(cwd);
  if (key) return { key, name };
  const hash = createHash('sha256').update(path.resolve(top)).digest('hex').slice(0, 16);
  return { key: `path:${hash}`, name };
}
