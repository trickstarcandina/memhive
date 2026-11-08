import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { ensureHomeDir, resolvePaths } from '../shared/paths.js';
import { safeJsonParse } from '../shared/json.js';

export interface DaemonInfo { port: number; pid: number; token: string; startedAt: string }

export function readDaemonInfo(home: string): DaemonInfo | null {
  const p = resolvePaths(home).daemonInfo;
  if (!existsSync(p)) return null;
  const j = safeJsonParse(readFileSync(p, 'utf8')) as Partial<DaemonInfo> | undefined;
  return j && typeof j.port === 'number' && typeof j.pid === 'number' && typeof j.token === 'string' ? (j as DaemonInfo) : null;
}
export function writeDaemonInfo(home: string, info: DaemonInfo): void {
  ensureHomeDir(home);
  const p = resolvePaths(home).daemonInfo; const tmp = `${p}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, p);
}
export function removeDaemonInfo(home: string): void { rmSync(resolvePaths(home).daemonInfo, { force: true }); }
