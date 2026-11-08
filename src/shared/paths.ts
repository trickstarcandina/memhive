import { chmodSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface Paths { home: string; db: string; settings: string; credentials: string; daemonInfo: string; logs: string; marketplace: string; plugin: string }

export function resolvePaths(home = process.env.MEMHUB_HOME ?? path.join(homedir(), '.memhub')): Paths {
  return {
    home,
    db: path.join(home, 'memhub.db'),
    settings: path.join(home, 'settings.json'),
    credentials: path.join(home, 'credentials.json'),
    daemonInfo: path.join(home, 'daemon.json'),
    logs: path.join(home, 'logs'),
    marketplace: path.join(home, 'marketplace'),
    plugin: path.join(home, 'marketplace', 'plugin'),
  };
}

// Names memhub writes in its home and logs dir; a dir holding anything else is not ours to tighten.
const OWN_ENTRY = /^(?:memhub\.db(?:-wal|-shm|-journal)?|settings\.json|credentials\.json|daemon\.(?:json|lock)|logs|marketplace|[\w-]+\.log(?:\.1)?)$|\.tmp$/;

/** Creates a data dir readable only by the owner (0o700); tightens an existing one only if it holds nothing but memhub files. */
export function ensureHomeDir(dir: string): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) return;   // created now, already 0o700 (umask can only narrow)
  if (readdirSync(dir).every((n) => OWN_ENTRY.test(n))) chmodSync(dir, 0o700);
}
