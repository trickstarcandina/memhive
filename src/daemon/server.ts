import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createJsonServer } from './http.js';
import { handleRoute } from './routes.js';
import { writeDaemonInfo, removeDaemonInfo, readDaemonInfo, type DaemonInfo } from './info.js';
import { DaemonClient } from './client.js';
import type { DaemonContext } from './context.js';
import { ensureHomeDir, resolvePaths } from '../shared/paths.js';
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
  ensureHomeDir(home);
  const settings = loadSettings(home, env);
  const logger = createLogger(home, 'daemon', env);
  const store = new SqliteStore(resolvePaths(home).db, { dims: settings.embed?.dims ?? null, warn: (m, d) => logger.warn(m, d) });
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
      let session = store.getSessionByHost(ev.host, ev.hostSessionId);
      // Existing session: reuse its project (no git spawns per event, no split on cwd change).
      let project = session ? store.getProject(session.projectId) : null;
      if (!project) { const { key, name } = projectKeyFor(ev.cwd); project = store.getOrCreateProject(key, name); }
      if (!session) { session = { id: newId(), projectId: project.id, userId, host: ev.host, hostSessionId: ev.hostSessionId, cwd: ev.cwd, startedAt: ev.at, endedAt: null, syncedAt: null }; store.upsertSession(session); }
      const sctx: SessionCtx = { sessionId: session.id, projectId: project.id, projectName: project.name, userId };
      return { ctx: sctx, project };
    },
  };
  return ctx;
}

export class DaemonAlreadyRunning extends Error { constructor() { super('another memhub daemon is already running'); this.name = 'DaemonAlreadyRunning'; } }

function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

// Exclusive lock so two racing spawns cannot both own daemon.json. A holder counts as live if its pid is alive and it
// either answers an authenticated health check or took the lock under 5 s ago (still starting up).
async function acquireLock(home: string): Promise<string> {
  const file = path.join(home, 'daemon.lock');
  for (let attempt = 0; attempt < 3; attempt++) {
    try { writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); return file; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let holder = NaN; let age = Infinity;
    try { holder = Number(readFileSync(file, 'utf8')); age = Date.now() - statSync(file).mtimeMs; } catch { continue; }   // vanished: retry
    if (pidAlive(holder)) {
      const info = readDaemonInfo(home);
      if (age < 5000 || (info && info.pid === holder && await new DaemonClient(info).health(500))) throw new DaemonAlreadyRunning();
    }
    rmSync(file, { force: true });
  }
  throw new DaemonAlreadyRunning();
}

export async function startDaemon(ctx: DaemonContext, opts: { port?: number; idleMs?: number } = {}): Promise<{ info: DaemonInfo; close(): Promise<void> }> {
  const lock = await acquireLock(ctx.home);
  const token = randomBytes(24).toString('base64url');
  const idleMs = opts.idleMs ?? 30 * 60 * 1000;
  let idleTimer: NodeJS.Timeout | null = null;
  let closing: Promise<void> | null = null;
  const touch = () => { if (idleTimer) clearTimeout(idleTimer); idleTimer = setTimeout(() => closeSafe(), idleMs); idleTimer.unref?.(); };

  const closeSafe = () => { close().catch((e) => ctx.logger.warn('close failed', { error: String(e) })); };
  const server = createJsonServer(async (method, url, body) => {
    if (url.pathname === '/healthz') {
      const nonce = url.searchParams.get('nonce') ?? '';
      return { status: 200, body: { ok: true, pid: process.pid, proof: createHmac('sha256', token).update(nonce).digest('hex') } };
    }
    touch();
    if (method === 'POST' && url.pathname === '/v1/shutdown') { setTimeout(closeSafe, 10); return { status: 200, body: {} }; }
    try { return await handleRoute(ctx, method, url, body); }
    catch (e) { ctx.logger.error('route failed', { path: url.pathname, error: e instanceof Error ? e.stack : String(e) }); return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } }; }
  }, (url, headers) => url.pathname === '/healthz' || tokenOk(headers['x-memhub-daemon-token'], token));
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', resolve); }); }
  catch (e) { rmSync(lock, { force: true }); throw e; }
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
    if (readDaemonInfo(ctx.home)?.token === token) removeDaemonInfo(ctx.home);   // never delete a successor's file
    try { if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock, { force: true }); } catch { /* gone */ }
    ctx.store.close();
    ctx.logger.info('daemon stopped');
  })();
  return { info, close };
}
