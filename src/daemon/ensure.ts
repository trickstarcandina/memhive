import { spawn } from 'node:child_process';
import { readDaemonInfo, removeDaemonInfo, type DaemonInfo } from './info.js';
import { DaemonClient } from './client.js';
import { VERSION } from '../shared/version.js';

declare const __filename: string;   // defined in the CJS bundle, undefined under vitest (ESM)
export type SpawnFn = (bundlePath: string, home: string) => void;

const defaultSpawn: SpawnFn = (bundlePath, home) => {
  const child = spawn(process.execPath, [bundlePath, 'daemon', 'run'], { detached: true, stdio: 'ignore', env: { ...process.env, MEMHIVE_HOME: home } });
  child.unref();
};

function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

export async function ensureDaemon(home: string, opts: { wait: boolean; spawn?: SpawnFn; fetchImpl?: typeof fetch; bundlePath?: string; waitMs?: number; version?: string }): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(home);
  if (info) {
    const client = new DaemonClient(info, opts.fetchImpl);
    if (await client.health()) {
      if (info.version === (opts.version ?? VERSION)) return info;
      // A daemon from another memhive build (an upgrade, or a downgrade): ask it to stop, then start ours. A hook that cannot
      // wait only asks; the next hook finds daemon.json gone and spawns.
      await client.request('POST', '/v1/shutdown', undefined, 1000).catch(() => {});
      if (!opts.wait) return null;
      const deadline = Date.now() + (opts.waitMs ?? 2000);
      while (Date.now() < deadline && readDaemonInfo(home)?.token === info.token && pidAlive(info.pid)) await new Promise((r) => setTimeout(r, 50));
      (opts.spawn ?? defaultSpawn)(opts.bundlePath ?? (typeof __filename === 'string' ? __filename : process.argv[1]), home);
      return waitFor(home, opts);
    }
    const stale = !pidAlive(info.pid) || Date.now() - Date.parse(info.startedAt) > 5000;   // old + unhealthy = dead or hung (or pid reused)
    if (stale) removeDaemonInfo(home);
    else return opts.wait ? waitFor(home, opts) : null;   // alive pid but not answering yet: starting up
  }
  (opts.spawn ?? defaultSpawn)(opts.bundlePath ?? (typeof __filename === 'string' ? __filename : process.argv[1]), home);
  return opts.wait ? waitFor(home, opts) : null;
}

async function waitFor(home: string, opts: { fetchImpl?: typeof fetch; waitMs?: number; version?: string }): Promise<DaemonInfo | null> {
  const deadline = Date.now() + (opts.waitMs ?? 2000);
  while (Date.now() < deadline) {
    const info = readDaemonInfo(home);
    if (info && info.version === (opts.version ?? VERSION) && (await new DaemonClient(info, opts.fetchImpl).health())) return info;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
