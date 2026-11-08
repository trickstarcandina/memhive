import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Logger } from '../shared/logger.js';
import { createJsonServer } from '../daemon/http.js';
import { hashApiKey, generateApiKey, RateLimiter, AuthThrottle, remember } from './auth.js';
import { handleHubRoute } from './routes.js';
import type { HubStore } from './store/types.js';
import { SqliteHubStore } from './store/sqlite.js';
import { PostgresHubStore } from './store/postgres.js';
import { VERSION } from '../shared/version.js';

export interface HubConfig {
  port: number;
  host?: string;
  trustProxy?: boolean;
  embeddingModel: string | null;
  embeddingDims: number | null;
  bodyLimit: number;
} // host defaults to loopback

export function hubConfigFromEnv(env: NodeJS.ProcessEnv): HubConfig {
  return {
    port: Number(env.PORT ?? 7777) || 7777,
    host: env.MEMHIVE_HOST || env.HOST || '127.0.0.1',
    trustProxy: env.MEMHIVE_TRUST_PROXY === '1',
    embeddingModel: env.MEMHIVE_EMBED_MODEL || null,
    embeddingDims: env.MEMHIVE_EMBED_DIMS ? Number(env.MEMHIVE_EMBED_DIMS) || null : null,
    bodyLimit: Number(env.MEMHIVE_HUB_BODY_LIMIT ?? 2 * 1024 * 1024) || 2 * 1024 * 1024,
  };
}

/** admin: for key/user/project commands, which skip the dims guard and can never reset vectors. */
export function createHubStore(env: NodeJS.ProcessEnv, mode: 'serve' | 'admin' = 'serve'): HubStore {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (postgres://… or sqlite:<path>)');
  const opts = {
    dims: env.MEMHIVE_EMBED_DIMS ? Number(env.MEMHIVE_EMBED_DIMS) || null : null,
    resetVectors: mode === 'serve' && env.MEMHIVE_RESET_VECTORS === '1',
    checkDims: mode === 'serve',
  };
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) return new PostgresHubStore(url, opts);
  if (url.startsWith('sqlite:')) return new SqliteHubStore(url.slice('sqlite:'.length), opts);
  throw new Error('DATABASE_URL must start with postgres:// or sqlite:');
}

/** persist runs before the key is stored: if it throws, no key exists and the next start tries again. */
export async function ensureAdminKey(
  store: HubStore,
  persist: (raw: string) => void = () => {}
): Promise<string | null> {
  // Keyed on keys, not users: a crash between createUser and createApiKey must not leave a hub nobody can log in to.
  if ((await store.listApiKeys()).length > 0) return null;
  const k = generateApiKey();
  persist(k.raw);
  await store.createUser('admin');
  await store.createApiKey('admin', 'initial', k.hash);
  return k.raw;
}

const BAD_KEY_CACHE = 256; // recently refused key hashes answered 401 without a DB lookup
const BAD_KEY_TTL_MS = 60_000;
const GOOD_KEY_CACHE = 1024;
const bearer = (headers: Record<string, unknown>) =>
  /^Bearer\s+(mh_[A-Za-z0-9_-]+)$/.exec(String(headers.authorization ?? ''))?.[1] ?? null;

export async function startHub(
  store: HubStore,
  cfg: HubConfig,
  log: Logger
): Promise<{ port: number; host: string; close(): Promise<void> }> {
  const limiter = new RateLimiter(60, 60_000);
  // Failed auth is throttled per client so a flood of bad keys cannot tie up the DB pool. Keys that authenticated before still
  // reach the store during a flood (a revoke still applies); only never-seen keys from the flooding client are turned away.
  const throttle = new AuthThrottle(30, 60_000, 10_000);
  const bad = new Map<string, number>();
  const good = new Map<string, true>();
  const clientOf = new WeakMap<object, string>(); // req.headers -> client address, set before the shared server runs
  // The key is checked before the body is read, so an unknown or revoked key never makes the hub buffer a body.
  const authed = new WeakMap<object, { keyId: string; userName: string }>();
  const authorize = async (url: URL, headers: Record<string, unknown>): Promise<boolean> => {
    if (url.pathname === '/healthz') return true;
    const raw = bearer(headers);
    const hash = raw ? hashApiKey(raw) : null;
    if (hash && (bad.get(hash) ?? 0) > Date.now()) return false; // a cache hit costs nothing, so it does not count against the client
    const auth = hash ? await store.authenticate(hash) : null;
    if (auth) {
      authed.set(headers, auth);
      remember(good, hash!, true, GOOD_KEY_CACHE);
      return true;
    }
    throttle.failed(clientOf.get(headers) ?? '');
    if (hash) {
      good.delete(hash);
      remember(bad, hash, Date.now() + BAD_KEY_TTL_MS, BAD_KEY_CACHE);
    }
    return false;
  };
  // Behind a trusted proxy the client is the last X-Forwarded-For entry (the one that proxy appended; earlier ones are client-supplied).
  const client = (req: IncomingMessage): string => {
    const xff = cfg.trustProxy
      ? String(req.headers['x-forwarded-for'] ?? '')
          .split(',')
          .map((x) => x.trim())
          .filter(Boolean)
          .pop()
      : undefined;
    return xff ?? req.socket.remoteAddress ?? '';
  };
  const server = createJsonServer(
    async (method, url, body, headers) => {
      if (url.pathname === '/healthz') return { status: 200, body: { ok: true, version: VERSION } };
      const auth = authed.get(headers)!;
      if (!limiter.allow(auth.keyId))
        return { status: 429, body: { error: { code: 'rate_limited', message: '60 requests per minute per key' } } };
      try {
        return await handleHubRoute(store, cfg, auth, method, url, body);
      } catch (e) {
        log.error('hub route failed', { path: url.pathname, error: e instanceof Error ? e.stack : String(e) });
        return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } };
      }
    },
    authorize,
    cfg.bodyLimit,
    'missing or invalid API key'
  );
  // The throttle answers before the shared JSON server runs (it has no way to set retry-after), so it never touches the store.
  const [inner] = server.listeners('request') as Array<(req: IncomingMessage, res: ServerResponse) => void>;
  server.removeAllListeners('request');
  const reply = (
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    headers: Record<string, string> = {}
  ) => {
    res.writeHead(status, { 'content-type': 'application/json', connection: 'close', ...headers });
    res.end(JSON.stringify({ error: { code, message } }));
  };
  server.on('request', (req: IncomingMessage, res: ServerResponse) => {
    // A throw here would escape every handler and kill the process, before any auth.
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      return reply(res, 400, 'bad_url', 'malformed request URL');
    }
    const who = client(req);
    clientOf.set(req.headers, who);
    const raw = url.pathname === '/healthz' ? null : bearer(req.headers);
    const wait = url.pathname === '/healthz' || (raw && good.has(hashApiKey(raw))) ? 0 : throttle.wait(who);
    if (!wait) return inner.call(server, req, res);
    reply(res, 429, 'rate_limited', 'too many failed authentications', { 'retry-after': String(wait) });
  });
  const host = cfg.host ?? '127.0.0.1';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, host, resolve);
  });
  const port = (server.address() as AddressInfo).port;
  log.info('hub listening', { host, port });
  return {
    port,
    host,
    close: async () => {
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections?.();
      });
      await store.close();
    },
  };
}
