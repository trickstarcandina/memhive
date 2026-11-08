import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { ensureHomeDir, resolvePaths } from '../shared/paths.js';
import { safeJsonParse } from '../shared/json.js';

export interface DaemonInfo {
  port: number;
  pid: number;
  token: string;
  startedAt: string;
  version?: string;
} // version: absent before 0.2

export function readDaemonInfo(home: string): DaemonInfo | null {
  const p = resolvePaths(home).daemonInfo;
  if (!existsSync(p)) return null;
  const j = safeJsonParse(readFileSync(p, 'utf8')) as Partial<DaemonInfo> | undefined;
  return j && typeof j.port === 'number' && typeof j.pid === 'number' && typeof j.token === 'string'
    ? (j as DaemonInfo)
    : null;
}
export function writeDaemonInfo(home: string, info: DaemonInfo): void {
  ensureHomeDir(home);
  const p = resolvePaths(home).daemonInfo;
  const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, p);
}
export function removeDaemonInfo(home: string): void {
  rmSync(resolvePaths(home).daemonInfo, { force: true });
}

const readText = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
/** Linux only (/proc): is `pid` a `memhive daemon run` for this home? False when it cannot tell. */
export function isOurDaemon(home: string, pid: number): boolean {
  const args = readText(`/proc/${pid}/cmdline`).split('\0');
  const env = readText(`/proc/${pid}/environ`).split('\0');
  return (
    args.includes('daemon') &&
    args.includes('run') &&
    args.some((a) => a.includes('memhive')) &&
    env.includes(`MEMHIVE_HOME=${home}`)
  );
}
/** Whether /proc can answer for `pid` at all; without it a live holder is never assumed to be someone else's pid. */
export const procKnows = (pid: number): boolean => readText(`/proc/${pid}/cmdline`) !== '';
