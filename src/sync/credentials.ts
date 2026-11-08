import { existsSync, readFileSync } from 'node:fs';
import { writeFileAtomic } from '../shared/fs.js';
import { ensureHomeDir, resolvePaths } from '../shared/paths.js';
import { safeJsonParse } from '../shared/json.js';

export interface HubCredential {
  key: string;
  user: string;
  authFailed?: boolean;
}
export interface Credentials {
  hubs: Record<string, HubCredential>;
}

export function loadCredentials(home: string): Credentials {
  const p = resolvePaths(home).credentials;
  const j = existsSync(p) ? (safeJsonParse(readFileSync(p, 'utf8')) as Partial<Credentials> | undefined) : undefined;
  const hubs: Record<string, HubCredential> = {};
  if (j?.hubs && typeof j.hubs === 'object') {
    for (const [url, c] of Object.entries(j.hubs))
      if (c && typeof c.key === 'string' && typeof c.user === 'string')
        hubs[url] = { key: c.key, user: c.user, ...(c.authFailed ? { authFailed: true } : {}) };
  }
  return { hubs };
}

export function saveCredentials(home: string, c: Credentials): void {
  ensureHomeDir(home);
  writeFileAtomic(resolvePaths(home).credentials, JSON.stringify(c, null, 2) + '\n', 0o600);
}

export function normalizeHubUrl(url: string): string {
  const u = new URL(url);
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback))
    throw new Error('hub url must use https:// (plain http only for localhost)');
  return u.origin;
}

export function defaultUser(c: Credentials): string | null {
  for (const h of Object.values(c.hubs)) if (!h.authFailed && h.user) return h.user;
  return null;
}
