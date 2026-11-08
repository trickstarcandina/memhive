import type { AddressInfo } from 'node:net';
import type { Logger } from '../shared/logger.js';
import { createJsonServer } from '../daemon/http.js';
import { hashApiKey, generateApiKey, RateLimiter } from './auth.js';
import { handleHubRoute } from './routes.js';
import type { HubStore } from './store/types.js';
import { SqliteHubStore } from './store/sqlite.js';
import { PostgresHubStore } from './store/postgres.js';
import { VERSION } from '../shared/version.js';

export interface HubConfig { port: number; embeddingModel: string | null; embeddingDims: number | null; bodyLimit: number }

export function hubConfigFromEnv(env: NodeJS.ProcessEnv): HubConfig {
  return { port: Number(env.PORT ?? 7777) || 7777, embeddingModel: env.MEMHUB_EMBED_MODEL || null, embeddingDims: env.MEMHUB_EMBED_DIMS ? Number(env.MEMHUB_EMBED_DIMS) || null : null, bodyLimit: Number(env.MEMHUB_HUB_BODY_LIMIT ?? 2 * 1024 * 1024) || 2 * 1024 * 1024 };
}

export function createHubStore(env: NodeJS.ProcessEnv): HubStore {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (postgres://… or sqlite:<path>)');
  const dims = env.MEMHUB_EMBED_DIMS ? Number(env.MEMHUB_EMBED_DIMS) || null : null;
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return new PostgresHubStore(url, { dims });
  if (url.startsWith('sqlite:')) return new SqliteHubStore(url.slice('sqlite:'.length), { dims });
  throw new Error('DATABASE_URL must start with postgres:// or sqlite:');
}

export async function ensureAdminKey(store: HubStore): Promise<string | null> {
  // Keyed on keys, not users: a crash between createUser and createApiKey must not leave a hub nobody can log in to.
  if ((await store.listApiKeys()).length > 0) return null;
  await store.createUser('admin');
  const k = generateApiKey(); await store.createApiKey('admin', 'initial', k.hash);
  return k.raw;
}

export async function startHub(store: HubStore, cfg: HubConfig, log: Logger): Promise<{ port: number; close(): Promise<void> }> {
  const limiter = new RateLimiter(60, 60_000);
  // The key is checked before the body is read, so an unknown or revoked key never makes the hub buffer a body.
  const authed = new WeakMap<object, { keyId: string; userName: string }>();
  const authorize = async (url: URL, headers: Record<string, unknown>): Promise<boolean> => {
    if (url.pathname === '/healthz') return true;
    const m = /^Bearer\s+(mh_[A-Za-z0-9_-]+)$/.exec(String(headers.authorization ?? ''));
    const auth = m ? await store.authenticate(hashApiKey(m[1])) : null;
    if (auth) authed.set(headers, auth);
    return !!auth;
  };
  const server = createJsonServer(async (method, url, body, headers) => {
    if (url.pathname === '/healthz') return { status: 200, body: { ok: true, version: VERSION } };
    const auth = authed.get(headers)!;
    if (!limiter.allow(auth.keyId)) return { status: 429, body: { error: { code: 'rate_limited', message: '60 requests per minute per key' } } };
    try { return await handleHubRoute(store, cfg, auth, method, url, body); }
    catch (e) { log.error('hub route failed', { path: url.pathname, error: e instanceof Error ? e.stack : String(e) }); return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } }; }
  }, authorize, cfg.bodyLimit, 'missing or invalid API key');
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, '0.0.0.0', resolve); });
  const port = (server.address() as AddressInfo).port;
  log.info('hub listening', { port });
  return { port, close: async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }); await store.close(); } };
}
