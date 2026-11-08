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
