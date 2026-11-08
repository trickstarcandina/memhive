import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createJsonServer } from './http.js';
import { handleRoute } from './routes.js';
import { writeDaemonInfo, removeDaemonInfo, type DaemonInfo } from './info.js';
import type { DaemonContext } from './context.js';
import { resolvePaths } from '../shared/paths.js';
import { loadSettings } from '../shared/settings.js';
import { createLogger } from '../shared/logger.js';
import { SqliteStore } from '../store/sqlite/store.js';
import { createEmbedder, createProvider } from '../providers/factory.js';
import { Observer, type SessionCtx } from '../observer/observer.js';
import { projectKeyFor } from '../shared/project-key.js';
import { newId } from '../shared/ids.js';
import type { HookEvent } from '../hooks/types.js';
import type { LlmProvider } from '../providers/types.js';

function tokenOk(got: string | string[] | undefined, want: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createDaemonContext(home: string, env: NodeJS.ProcessEnv = process.env): DaemonContext {
  mkdirSync(home, { recursive: true });
  const settings = loadSettings(home, env);
  const logger = createLogger(home, 'daemon', env);
  const store = new SqliteStore(resolvePaths(home).db, { dims: settings.embed?.dims ?? null });
  store.migrate();
  const embedder = createEmbedder(settings);
  let provider: LlmProvider;
  try { provider = createProvider(settings); }
  catch (e) { logger.error('no usable LLM provider; observations disabled until settings fixed', { error: String(e) }); provider = { complete: async () => { throw e; } }; }
  const observer = new Observer({ store, provider, embedder, logger });
  const userId = 'local';
  const ctx: DaemonContext = {
    home, store, observer, embedder, settings, logger, userId, sync: null,
    resolveSession(ev: HookEvent) {
      const { key, name } = projectKeyFor(ev.cwd);
      const project = store.getOrCreateProject(key, name);
      let session = store.getSessionByHost(ev.host, ev.hostSessionId);
      if (!session) { session = { id: newId(), projectId: project.id, userId, host: ev.host, hostSessionId: ev.hostSessionId, cwd: ev.cwd, startedAt: ev.at, endedAt: null, syncedAt: null }; store.upsertSession(session); }
      const sctx: SessionCtx = { sessionId: session.id, projectId: project.id, projectName: project.name, userId };
      return { ctx: sctx, project };
    },
  };
  return ctx;
}

export async function startDaemon(ctx: DaemonContext, opts: { port?: number; idleMs?: number } = {}): Promise<{ info: DaemonInfo; close(): Promise<void> }> {
  const token = randomBytes(24).toString('base64url');
  const idleMs = opts.idleMs ?? 30 * 60 * 1000;
  let idleTimer: NodeJS.Timeout | null = null;
  let closing: Promise<void> | null = null;
  const touch = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => void close(), idleMs); idleTimer.unref?.(); };

  const server = createJsonServer(async (method, url, body, headers) => {
    if (url.pathname === '/healthz') return { status: 200, body: { ok: true, pid: process.pid } };
    if (!tokenOk(headers['x-memhub-daemon-token'], token)) return { status: 401, body: { error: { code: 'unauthorized', message: 'bad daemon token' } } };
    touch();
    if (method === 'POST' && url.pathname === '/v1/shutdown') { setTimeout(() => void close(), 10); return { status: 200, body: {} }; }
    try { return await handleRoute(ctx, method, url, body); }
    catch (e) { ctx.logger.error('route failed', { path: url.pathname, error: e instanceof Error ? e.stack : String(e) }); return { status: 500, body: { error: { code: 'internal', message: e instanceof Error ? e.message : String(e) } } }; }
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, '127.0.0.1', resolve));
  const info: DaemonInfo = { port: (server.address() as AddressInfo).port, pid: process.pid, token, startedAt: new Date().toISOString() };
  writeDaemonInfo(ctx.home, info);
  touch();
  ctx.logger.info('daemon started', { port: info.port });

  const embedTimer = setInterval(() => void ctx.observer.embedMissing().catch(() => {}), 10 * 60 * 1000); embedTimer.unref?.();

  const close = () => closing ??= (async () => {
    if (idleTimer) clearTimeout(idleTimer); clearInterval(embedTimer);
    try { await ctx.observer.flushAll(); } catch { /* best effort */ }
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    removeDaemonInfo(ctx.home);
    ctx.store.close();
    ctx.logger.info('daemon stopped');
  })();
  return { info, close };
}
