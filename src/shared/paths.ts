import { chmodSync, mkdirSync, readdirSync, statSync } from 'node:fs';
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
const OWN_ENTRY = /^(?:memhub\.db(?:-wal|-shm|-journal)?|settings\.json|credentials\.json|daemon\.(?:json|lock(?:\.break)?)|logs|marketplace|[\w-]+\.log(?:\.1|\.rotate)?)$|\.tmp$/;

const warnedDirs = new Set<string>();
let warnSink = (msg: string): void => { process.stderr.write(msg); };
/** Hooks must stay silent on stderr, so they route this warning to their log file. */
export function setHomeWarningSink(fn: (msg: string) => void): void { warnSink = fn; }

/**
 * Creates a data dir readable only by the owner (0o700); tightens an existing one only if it holds nothing but memhub
 * files. A loose shared dir is left alone with a warning; every memhub file is created 0o600 on its own anyway.
 */
export function ensureHomeDir(dir: string): void {
  if (mkdirSync(dir, { recursive: true, mode: 0o700 }) !== undefined) return;   // created now, already 0o700 (umask can only narrow)
  if (readdirSync(dir).every((n) => OWN_ENTRY.test(n))) { chmodSync(dir, 0o700); return; }
  if ((statSync(dir).mode & 0o077) !== 0 && !warnedDirs.has(dir)) {
    warnedDirs.add(dir);
    warnSink(`memhub: WARNING: ${dir} is readable by other users and holds files that are not memhub's; its mode is left alone. memhub files in it are owner-only (0600). Point MEMHUB_HOME at a private directory.\n`);
  }
}
