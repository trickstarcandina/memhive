import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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
  const p = resolvePaths(home).credentials;
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, p);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
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
