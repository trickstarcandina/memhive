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
  if ((await store.countUsers()) > 0) return null;
  await store.createUser('admin');
  const k = generateApiKey(); await store.createApiKey('admin', 'initial', k.hash);
  return k.raw;
}

export async function startHub(store: HubStore, cfg: HubConfig, log: Logger): Promise<{ port: number; close(): Promise<void> }> {
  const limiter = new RateLimiter(60, 60_000);
  const server = createJsonServer(async (method, url, body, headers) => {
    if (url.pathname === '/healthz') return { status: 200, body: { ok: true, version: VERSION } };
    const m = /^Bearer\s+(mh_[A-Za-z0-9_-]+)$/.exec(String(headers.authorization ?? ''));
    const auth = m ? await store.authenticate(hashApiKey(m[1])) : null;
    if (!auth) return { status: 401, body: { error: { code: 'unauthorized', message: 'missing or invalid API key' } } };
    if (!limiter.allow(auth.keyId)) return { status: 429, body: { error: { code: 'rate_limited', message: '60 requests per minute per key' } } };
    try { return await handleHubRoute(store, cfg, auth, method, url, body); }
    catch (e) { log.error('hub route failed', { path: url.pathname, error: e instanceof Error ? e.stack : String(e) }); return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } }; }
  }, // shortcut: sync pre-check only rejects missing/malformed credentials before buffering the body; a well-formed wrong key is still rejected after, by the DB lookup.
  (url, headers) => url.pathname === '/healthz' || /^Bearer\s+mh_[A-Za-z0-9_-]+$/.test(String(headers.authorization ?? '')), cfg.bodyLimit);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(cfg.port, '0.0.0.0', resolve); });
  const port = (server.address() as AddressInfo).port;
  log.info('hub listening', { port });
  return { port, close: async () => { await new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections?.(); }); await store.close(); } };
}
