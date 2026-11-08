import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { readRepoConfig, type RepoConfig } from './optout.js';

export function normalizeRemote(url: string): string | null {
  let s = url.trim();
  if (!s) return null;
  s = s.replace(/^[a-z+]+:\/\//i, ''); // scheme
  s = s.replace(/^[^@/]+@/, ''); // user@
  // host:port/ -> host/. Also applied to scp-like host:123/repo (strictly a path): changing it would rekey existing projects.
  s = s.replace(/^([^:/]+):(\d+)\//, '$1/');
  s = s.replace(/^([^:/]+):/, '$1/'); // scp-like host:path
  s = s.replace(/\.git\/?$/i, '').replace(/\/+$/, '');
  if (!/^[^/]+\/.+/.test(s) || /\s/.test(s)) return null;
  return s.toLowerCase();
}

export interface ProjectKeyDeps {
  gitRemote: (cwd: string) => string | null;
  /** One spawn for both: the repo top level and the current branch (null when detached or not a repo). */
  gitRevParse: (cwd: string) => { top: string | null; branch: string | null };
  readRepoConfig?: (dir: string) => RepoConfig;
}
export interface ProjectInfo {
  key: string;
  name: string;
  top: string;
  branch: string | null;
  disabled: boolean;
}

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 2000 });
  return r.status === 0 ? r.stdout.trim() || null : null;
}
const defaultDeps: ProjectKeyDeps = {
  gitRemote: (cwd) => git(cwd, ['config', '--get', 'remote.origin.url']),
  gitRevParse: (cwd) => {
    // A repo without commits fails on HEAD (status 128) but still prints the top level first.
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const [top, branch] = (r.error ? '' : (r.stdout ?? ''))
      .trim()
      .split('\n')
      .map((l) => l.trim());
    return { top: top || null, branch: branch && branch !== 'HEAD' ? branch : null };
  },
};

export function projectKeyFor(cwd: string, deps: ProjectKeyDeps = defaultDeps): ProjectInfo {
  const remote = deps.gitRemote(cwd);
  const remoteKey = remote ? normalizeRemote(remote) : null;
  const { top: gitTop, branch } = deps.gitRevParse(cwd);
  const top = gitTop ?? cwd;
  const natural = remoteKey ?? `path:${createHash('sha256').update(path.resolve(top)).digest('hex').slice(0, 16)}`;
  // Nearest `.memhive.json` from cwd up to the repo root, so each monorepo package can carry its own.
  const read = deps.readRepoConfig ?? readRepoConfig;
  let repo: RepoConfig = {};
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  }; // git prints the real path
  for (let d = real(cwd), stop = real(top); ; d = path.dirname(d)) {
    repo = read(d);
    if (repo.disabled || repo.project || d === stop || d === path.dirname(d) || !d.startsWith(stop)) break;
  }
  // The override may only narrow the repo's own key (monorepo packages): a committed file naming another project's key
  // would otherwise pull that project's memory into this repo's context.
  const key = repo.project && repo.project.startsWith(`${natural}/`) ? repo.project : natural;
  const name = key !== natural ? path.basename(key) : path.basename(remoteKey ?? top) || path.basename(cwd);
  return { key, name, top, branch, disabled: repo.disabled === true };
}
