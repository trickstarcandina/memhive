import { chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export interface Paths { home: string; db: string; settings: string; credentials: string; daemonInfo: string; state: string; logs: string; marketplace: string; plugin: string }

export function resolvePaths(home = process.env.MEMHIVE_HOME ?? path.join(homedir(), '.memhive')): Paths {
  return {
    home,
    db: path.join(home, 'memhive.db'),
    settings: path.join(home, 'settings.json'),
    credentials: path.join(home, 'credentials.json'),
    daemonInfo: path.join(home, 'daemon.json'),
    state: path.join(home, 'state.json'),
    logs: path.join(home, 'logs'),
    marketplace: path.join(home, 'marketplace'),
    plugin: path.join(home, 'marketplace', 'plugin'),
  };
}

// Names memhive writes in its home and logs dir; a dir holding anything else is not ours to tighten.
const OWN_ENTRY = /^(?:memhive\.db(?:-wal|-shm|-journal)?|settings\.json|credentials\.json|state\.json|daemon\.(?:json|lock(?:\.break)?)|logs|marketplace|[\w-]+\.log(?:\.1|\.rotate)?)$|\.tmp$/;

export const isOwnEntry = (name: string): boolean => OWN_ENTRY.test(name);

const warnedDirs = new Set<string>();
let warnSink = (msg: string): void => { process.stderr.write(msg); };
/** Hooks must stay silent on stderr, so they route this warning to their log file. */
export function setHomeWarningSink(fn: (msg: string) => void): void { warnSink = fn; }

/**
 * Creates a data dir readable only by the owner (0o700); tightens an existing one only if it holds nothing but memhive
 * files. A loose shared dir is left alone with a warning; every memhive file is created 0o600 on its own anyway.
 */
export function ensureHomeDir(dir: string): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) return;   // created now, already 0o700 (umask can only narrow)
  if (readdirSync(dir).every((n) => OWN_ENTRY.test(n))) { chmodSync(dir, 0o700); return; }
  if ((statSync(dir).mode & 0o077) !== 0 && !warnedDirs.has(dir)) {
    warnedDirs.add(dir);
    warnSink(`memhive: WARNING: ${dir} is readable by other users and holds files that are not memhive's; its mode is left alone. memhive files in it are owner-only (0600). Point MEMHIVE_HOME at a private directory.\n`);
  }
}
