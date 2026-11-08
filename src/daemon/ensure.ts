import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { readDaemonInfo, removeDaemonInfo, type DaemonInfo } from './info.js';
import { DaemonClient } from './client.js';
import { VERSION } from '../shared/version.js';

declare const __filename: string;   // defined in the CJS bundle, undefined under vitest (ESM)
export type SpawnFn = (bundlePath: string, home: string) => void;

const realSpawn: SpawnFn = (bundlePath, home) => {
  const child = spawn(process.execPath, [bundlePath, 'daemon', 'run'], { detached: true, stdio: 'ignore', env: { ...process.env, MEMHIVE_HOME: home } });
  child.unref();
};
let defaultSpawn: SpawnFn = realSpawn;
/**
 * Test-only: replaces the spawn used when a caller passes none. Under vitest, process.argv[1] is the vitest entry, so the
 * real spawn would start a detached `vitest daemon run`; the test setup records the call instead. `null` restores it.
 */
export function setDefaultSpawn(fn: SpawnFn | null): void { defaultSpawn = fn ?? realSpawn; }

const warnedNewer = new Set<string>();
/** True when `v` is a lower x.y.z than `than` (a missing version, from before 0.2, is lower; a pre-release is lower than its release). */
export function olderThan(v: string | undefined, than: string): boolean {
  if (!v) return true;
  const parse = (x: string) => { const [core, pre] = x.split('-', 2); return { n: core.split('.').map((p) => Number(p) || 0), pre: pre ?? null }; };
  const a = parse(v); const b = parse(than);
  for (let i = 0; i < 3; i++) if ((a.n[i] ?? 0) !== (b.n[i] ?? 0)) return (a.n[i] ?? 0) < (b.n[i] ?? 0);
  if (a.pre === b.pre) return false;
  return a.pre !== null && (b.pre === null || a.pre < b.pre);
}

const lockHolder = (home: string): number | null => { try { return Number(readFileSync(path.join(home, 'daemon.lock'), 'utf8')); } catch { return null; } };
function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

export async function ensureDaemon(home: string, opts: { wait: boolean; spawn?: SpawnFn; fetchImpl?: typeof fetch; bundlePath?: string; waitMs?: number; version?: string; exitWaitMs?: number; warn?: (msg: string) => void }): Promise<DaemonInfo | null> {
  const info = readDaemonInfo(home);
  if (info) {
    const client = new DaemonClient(info, opts.fetchImpl);
    if (await client.health()) {
      const mine = opts.version ?? VERSION;
      if (!olderThan(info.version, mine)) {
        // A newer daemon serves an older caller as it is (the schema guard protects the database); restarting it would
        // let a long-lived pre-upgrade process kill the current daemon on every reconnect.
        if (info.version !== mine && !warnedNewer.has(info.version!)) { warnedNewer.add(info.version!); opts.warn?.(`memhive: the running daemon is ${info.version}, this process is ${mine}; restart this host session to use the new version`); }
        return info;
      }
      // Older daemon (an upgrade happened): ask it to stop, then start ours once it has exited. A hook that cannot wait
      // only asks; the next hook finds daemon.json gone and spawns.
      await client.request('POST', '/v1/shutdown', undefined, 1000).catch(() => {});
      if (!opts.wait) return null;
      // Its close() may wait up to 10 s for observer work; the new daemon must not start while it still holds the store.
      const deadline = Date.now() + (opts.exitWaitMs ?? 15_000);
      const holding = () => pidAlive(info.pid) && lockHolder(home) === info.pid;   // the lock goes only after its store is closed
      while (Date.now() < deadline && holding()) await new Promise((r) => setTimeout(r, 50));
      if (holding()) { opts.warn?.(`memhive: the old daemon (pid ${info.pid}) did not exit; not starting a second one`); return null; }
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
    if (info && !olderThan(info.version, opts.version ?? VERSION) && (await new DaemonClient(info, opts.fetchImpl).health())) return info;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}
