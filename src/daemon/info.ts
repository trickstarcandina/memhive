import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolvePaths } from '../shared/paths.js';
import { safeJsonParse } from '../shared/json.js';

export interface DaemonInfo { port: number; pid: number; token: string; startedAt: string }

export function readDaemonInfo(home: string): DaemonInfo | null {
  const p = resolvePaths(home).daemonInfo;
  if (!existsSync(p)) return null;
  const j = safeJsonParse(readFileSync(p, 'utf8')) as Partial<DaemonInfo> | undefined;
  return j && typeof j.port === 'number' && typeof j.pid === 'number' && typeof j.token === 'string' ? (j as DaemonInfo) : null;
}
export function writeDaemonInfo(home: string, info: DaemonInfo): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(resolvePaths(home).daemonInfo, JSON.stringify(info), { mode: 0o600 });
}
export function removeDaemonInfo(home: string): void { rmSync(resolvePaths(home).daemonInfo, { force: true }); }
