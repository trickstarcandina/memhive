import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createJsonServer } from './http.js';
import { handleRoute } from './routes.js';
import { runMaintenance } from './maintenance.js';
import { writeDaemonInfo, removeDaemonInfo, readDaemonInfo, type DaemonInfo } from './info.js';
import { DaemonClient, healthProof } from './client.js';
import type { DaemonContext } from './context.js';
import { ensureHomeDir, resolvePaths } from '../shared/paths.js';
import { loadSettings } from '../shared/settings.js';
import { createLogger } from '../shared/logger.js';
import { SqliteStore } from '../store/sqlite/store.js';
import { createEmbedder, createProvider } from '../providers/factory.js';
import { Observer, type SessionCtx } from '../observer/observer.js';
import { projectKeyFor, type ProjectInfo } from '../shared/project-key.js';
import { envDisabled, matchesAny, pauseReader } from '../shared/optout.js';
import { newId } from '../shared/ids.js';
import type { HookEvent } from '../hooks/types.js';
import type { Project } from '../store/types.js';
import type { LlmProvider } from '../providers/types.js';
import { SyncEngine } from '../sync/engine.js';
import { defaultUser, loadCredentials } from '../sync/credentials.js';

function tokenOk(got: string | string[] | undefined, want: string): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(got); const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// DNS rebinding: a browser page whose name resolves to 127.0.0.1 still sends its own Host, so only loopback names pass.
function hostOk(host: string | undefined, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

export function createDaemonContext(home: string, env: NodeJS.ProcessEnv = process.env): DaemonContext {
  ensureHomeDir(home);
  const settings = loadSettings(home, env);
  const logger = createLogger(home, 'daemon', env);
  const store = new SqliteStore(resolvePaths(home).db, { dims: settings.embed?.dims ?? null, model: settings.embed?.model ?? null, warn: (m, d) => logger.warn(m, d) });
  store.migrate();
  // Degraded sqlite-vec drops every vector, so do not pay for embedding calls; rows stay NULL for a later backfill.
  const embedder = store.vectorsDegraded ? null : createEmbedder(settings);
  let provider: LlmProvider;
  try { provider = createProvider(settings); }
  catch (e) { logger.error('no usable LLM provider; observations disabled until settings fixed', { error: String(e) }); provider = { complete: async () => { throw e; } }; }
  // After an auth failure the observer asks for a new provider; one is built only when settings.json changed.
  const settingsStamp = () => { try { return statSync(resolvePaths(home).settings).mtimeMs; } catch { return 0; } };
  let stamp = settingsStamp();
  const reloadProvider = (): LlmProvider | null => {
    const now = settingsStamp(); if (now === stamp) return null;
    stamp = now;
    try { return createProvider(loadSettings(home, env)); } catch (e) { logger.warn('settings changed but provider still unusable', { error: String(e) }); return null; }
  };
  const observer = new Observer({ store, provider, embedder, logger, reloadProvider });
  const userId = defaultUser(loadCredentials(home)) ?? 'local';
  // Read per call: a login after the daemon started is picked up. With several hubs, the linked one decides.
  const userFor = (project: Project): string => { const c = loadCredentials(home); return (project.hubUrl && c.hubs[project.hubUrl]?.user) || defaultUser(c) || 'local'; };
  const sync = new SyncEngine({ store, home, logger, embedDims: settings.embed?.dims ?? null, embedModel: settings.embed?.model ?? null });
  observer.onStored = (projectId) => sync.schedulePush(projectId);
  const paused = pauseReader(home);
  const disabled = envDisabled(env);
  const excluded = (info: ProjectInfo) => info.disabled || matchesAny(settings.excludeProjects, info.key, info.top);
  // Excluded sessions have no row to remember them by; without this every event of one would spawn git again.
  const excludedSessions = new Set<string>();
  const ctx: DaemonContext = {
    home, store, observer, embedder, settings, logger, userId, sync, userFor,
    pausedUntil: () => (disabled ? Infinity : paused()),
    excludedCwd: (cwd) => excluded(projectKeyFor(cwd)),
    resolveSession(ev: HookEvent) {
      if (ctx.pausedUntil() !== null) return null;
      const sk = `${ev.host}\0${ev.hostSessionId}`;
      if (excludedSessions.has(sk)) return null;
      const skip = () => { if (excludedSessions.size >= 10_000) excludedSessions.clear(); excludedSessions.add(sk); return null; };
      let session = store.getSessionByHost(ev.host, ev.hostSessionId);
      // Existing session: reuse its project (no git spawns per event, no split on cwd change).
      let project = session ? store.getProject(session.projectId) : null;
      let branch = session?.branch ?? null;
      if (project && matchesAny(settings.excludeProjects, project.key)) return skip();
      if (!project) {
        const info = projectKeyFor(ev.cwd);
        if (excluded(info)) return skip();
        project = store.getOrCreateProject(info.key, info.name); branch = info.branch;
      }
      const user = session?.userId ?? userFor(project);
      if (!session) { session = { id: newId(), projectId: project.id, userId: user, host: ev.host, hostSessionId: ev.hostSessionId, cwd: ev.cwd, startedAt: ev.at, endedAt: null, syncedAt: null, branch }; store.upsertSession(session); }
      const sctx: SessionCtx = { sessionId: session.id, projectId: project.id, projectName: project.name, userId: user };
      return { ctx: sctx, project, branch };
    },
  };
  return ctx;
}

export class DaemonAlreadyRunning extends Error { constructor() { super('another memhive daemon is already running'); this.name = 'DaemonAlreadyRunning'; } }

function pidAlive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }

// Exclusive lock so two racing spawns cannot both own daemon.json. A holder counts as live if its pid is alive and it
// either answers an authenticated health check or took the lock under 5 s ago (still starting up).
async function acquireLock(home: string): Promise<string> {
  const file = path.join(home, 'daemon.lock');
  for (let attempt = 0; attempt < 5; attempt++) {
    try { writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); return file; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    let holder = NaN; let mtime = 0;
    try { holder = Number(readFileSync(file, 'utf8')); mtime = statSync(file).mtimeMs; } catch { continue; }   // vanished: retry
    if (pidAlive(holder)) {
      const info = readDaemonInfo(home);
      if (Date.now() - mtime < 5000 || (info && info.pid === holder && await new DaemonClient(info).health(500))) throw new DaemonAlreadyRunning();
    }
    // Break the stale lock under a second exclusive lock and only if it is still the file judged stale, so two
    // starters cannot both remove it (the second would delete the first one's fresh lock) and both start.
    const breaker = `${file}.break`;
    try { writeFileSync(breaker, String(process.pid), { flag: 'wx', mode: 0o600 }); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(breaker).mtimeMs > 5000) rmSync(breaker, { force: true }); } catch { /* gone */ }   // breaker left by a crash
      await new Promise((r) => setTimeout(r, 50));
      continue;
    }
    try { if (statSync(file).mtimeMs === mtime && Number(readFileSync(file, 'utf8')) === holder) rmSync(file, { force: true }); }
    catch { /* already gone */ }
    finally { rmSync(breaker, { force: true }); }
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
      return { status: 200, body: { ok: true, proof: healthProof(token, nonce, process.pid) } };   // pid is bound in the proof, not disclosed
    }
    touch();
    if (method === 'POST' && url.pathname === '/v1/shutdown') { setTimeout(closeSafe, 10); return { status: 200, body: {} }; }
    try { return await handleRoute(ctx, method, url, body); }
    catch (e) { ctx.logger.error('route failed', { path: url.pathname, error: e instanceof Error ? e.stack : String(e) }); return { status: 500, body: { error: { code: 'internal', message: 'internal error' } } }; }
  }, (url, headers) => hostOk(headers.host, port()) && (url.pathname === '/healthz' || tokenOk(headers['x-memhive-daemon-token'], token)));
  const port = () => (server.address() as AddressInfo | null)?.port ?? -1;
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, '127.0.0.1', resolve); }); }
  catch (e) { rmSync(lock, { force: true }); throw e; }
  const info: DaemonInfo = { port: (server.address() as AddressInfo).port, pid: process.pid, token, startedAt: new Date().toISOString() };
  writeDaemonInfo(ctx.home, info);
  touch();
  ctx.logger.info('daemon started', { port: info.port });

  const tick = () => { runMaintenance(ctx); void ctx.observer.backfill(); };
  tick();
  const embedTimer = setInterval(tick, 10 * 60 * 1000); embedTimer.unref?.();

  const close = () => closing ??= (async () => {
    if (idleTimer) clearTimeout(idleTimer); clearInterval(embedTimer);
    try { await ctx.observer.flushAll(); } catch { /* best effort */ }
    await new Promise<void>((r) => server.close(() => r()));
    server.closeAllConnections?.();
    await ctx.sync?.close();   // a background pull may still be writing to the store; finish before the lock is released
    if (readDaemonInfo(ctx.home)?.token === token) removeDaemonInfo(ctx.home);   // never delete a successor's file
    try { if (Number(readFileSync(lock, 'utf8')) === process.pid) rmSync(lock, { force: true }); } catch { /* gone */ }
    ctx.store.close();
    ctx.logger.info('daemon stopped');
  })();
  return { info, close };
}
