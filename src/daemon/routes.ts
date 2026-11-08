import type { DaemonContext } from './context.js';
import type { HookEvent } from '../hooks/types.js';
import { hybridSearch } from '../search/hybrid.js';
import { buildContext } from '../context/builder.js';
import { newId } from '../shared/ids.js';
import { OBSERVATION_TYPES, type Observation, type ObservationType, type SearchFilters } from '../store/types.js';
import { projectKeyFor } from '../shared/project-key.js';
import { embeddingText } from '../observer/observer.js';
import { normalizeHubUrl } from '../sync/credentials.js';
import { redactSecrets, stripPrivate } from '../hooks/sanitize.js';

const ok = (body: unknown, status = 200) => ({ status, body });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });

function parseSince(v: string | null): string | undefined {
  if (!v) return undefined;
  const m = v.match(/^(\d+)([dhm])$/);
  if (!m) return v;
  const ms = Number(m[1]) * (m[2] === 'd' ? 864e5 : m[2] === 'h' ? 36e5 : 6e4);
  return new Date(Date.now() - ms).toISOString();
}

const clamp = (v: string | null, dflt: number) => Math.min(Math.max(Number(v ?? dflt) || 0, 0), 50);

function resolveIds(ctx: DaemonContext, raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean).map((id) => ctx.store.resolveIdPrefix(id) ?? id);
}

export async function handleRoute(ctx: DaemonContext, method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }> {
  const { store } = ctx; const q = url.searchParams; const path = url.pathname;

  if (method === 'GET' && path === '/v1/status') return ok({ observerAuthFailed: ctx.observer.authFailed, pushBlocked: ctx.sync?.blockedProjects?.() ?? [] });

  if (method === 'GET' && path === '/v1/project') {
    const cwd = q.get('cwd') ?? process.cwd();
    const { key, name } = projectKeyFor(cwd);
    return ok({ project: store.getOrCreateProject(key, name) });
  }

  if (method === 'POST' && path === '/v1/sessions/start') {
    const ev = body as HookEvent;
    if (!ev?.hostSessionId || !ev.cwd) return err(400, 'bad_event', 'hostSessionId and cwd required');
    const { project } = ctx.resolveSession(ev);
    if (ctx.sync && project.hubUrl) { try { await ctx.sync.pull(project, 3000); } catch (e) { ctx.logger.warn('pull failed', { error: String(e) }); } ctx.sync.schedulePush(project.id); }   // push also retries rows left over from an earlier daemon
    const context = buildContext({
      projectName: project.name, observationCount: store.countObservations(project.id), sessionCount: store.countSessions(project.id), lastActivity: store.lastActivity(project.id),
      summaries: store.listRecentSummaries(project.id, 3), observations: store.listRecentObservations(project.id, 200), budgetTokens: ctx.settings.contextTokens,
    });
    return ok({ context });
  }

  if (method === 'POST' && path === '/v1/events') {
    const ev = body as HookEvent;
    if (!ev?.hostSessionId || !ev.cwd || !ev.event) return err(400, 'bad_event', 'invalid event');
    const { ctx: sctx } = ctx.resolveSession(ev);
    const warn = (e: unknown) => ctx.logger.warn('event handling failed', { event: ev.event, error: String(e) });
    switch (ev.event) {
      case 'prompt': ctx.observer.onPrompt(sctx, ev.prompt ?? ''); break;
      case 'tool': if (ev.tool) ctx.observer.onTool(sctx, { ...ev.tool, at: ev.at }); break;
      case 'stop': ctx.observer.onStop(sctx).catch(warn); break;
      case 'session-end': ctx.observer.onSessionEnd(sctx).then(() => store.endSession(sctx.sessionId, ev.at)).catch(warn); break;
      case 'session-start': break;
    }
    return ok({}, 202);
  }

  if (method === 'GET' && path === '/v1/search') {
    const key = q.get('project_key'); if (!key) return err(400, 'missing_project', 'project_key required');
    const project = store.getProjectByKey(key); if (!project) return ok({ observations: [] });
    const type = q.get('type'); if (type && !OBSERVATION_TYPES.includes(type as ObservationType)) return err(400, 'bad_type', `type must be one of ${OBSERVATION_TYPES.join(', ')}`);
    const f: SearchFilters = { projectId: project.id, type: (type as ObservationType) ?? undefined, userId: q.get('user') ?? undefined, since: parseSince(q.get('since')), limit: Math.min(Math.max(Number(q.get('limit') ?? 20) || 20, 1), 100) };
    return ok({ observations: await hybridSearch(store, ctx.embedder, q.get('q') ?? '', f) });
  }

  if (method === 'GET' && path === '/v1/observations') return ok({ observations: store.getObservations(resolveIds(ctx, q.get('ids') ?? '')) });

  if (method === 'GET' && path === '/v1/timeline') {
    const [anchor] = resolveIds(ctx, q.get('anchor') ?? ''); if (!anchor) return err(400, 'missing_anchor', 'anchor required');
    return ok({ observations: store.timeline(anchor, clamp(q.get('before'), 5), clamp(q.get('after'), 5)) });
  }

  if (method === 'POST' && path === '/v1/memories') {
    const b = (body ?? {}) as { projectKey?: string; text?: string; title?: string; type?: string };
    // Same caps as the MCP save_memory schema; the route is reachable without MCP.
    if ((typeof b.text === 'string' && b.text.length > 20000) || (typeof b.title === 'string' && b.title.length > 2000)) return err(400, 'too_long', 'text max 20000 chars, title max 2000');
    const clean = (v: string) => redactSecrets(stripPrivate(v)).trim();
    const text = typeof b.text === 'string' ? clean(b.text) : '';
    const title = typeof b.title === 'string' ? clean(b.title) : '';
    if (!b.projectKey || !text) return err(400, 'bad_memory', 'projectKey and text required');
    const project = store.getProjectByKey(b.projectKey) ?? store.getOrCreateProject(b.projectKey, b.projectKey.split('/').pop() ?? b.projectKey);
    const type = (b.type && OBSERVATION_TYPES.includes(b.type as ObservationType) ? b.type : 'discovery') as ObservationType;
    const now = new Date().toISOString();
    let session = store.getSessionByHost('manual', project.id);
    if (!session) { session = { id: newId(), projectId: project.id, userId: ctx.userFor(project), host: 'manual', hostSessionId: project.id, cwd: '', startedAt: now, endedAt: null, syncedAt: null }; store.upsertSession(session); }
    const o: Observation = { id: newId(), projectId: project.id, sessionId: session.id, userId: session.userId, type, title: (title || text).slice(0, 200), subtitle: '', facts: [text], narrative: '', concepts: [], filesRead: [], filesModified: [], createdAt: now, embeddingModel: null, origin: 'local', syncedAt: null };
    store.insertObservations([o]);
    if (ctx.embedder) { try { const [v] = await ctx.embedder.embed([embeddingText(o)]); store.setObservationEmbedding(o.id, v, ctx.embedder.model); } catch { /* backfill later */ } }
    ctx.sync?.schedulePush(project.id);
    return ok({ observation: store.getObservations([o.id])[0] });
  }

  if (method === 'POST' && path === '/v1/sync') {
    const cwd = String((body as { cwd?: string } | undefined)?.cwd ?? process.cwd()); const { key, name } = projectKeyFor(cwd);
    const project = store.getOrCreateProject(key, name);
    if (!ctx.sync || !project.hubUrl) return err(400, 'not_linked', 'project is not linked to a hub (memhub link <url>)');
    return ok(await ctx.sync.syncNow(project));
  }

  if (method === 'POST' && path === '/v1/projects/link') {
    const b = (body ?? {}) as { cwd?: string; hubUrl?: string | null };
    let hubUrl: string | null = null;
    if (b.hubUrl != null) { try { hubUrl = normalizeHubUrl(String(b.hubUrl)); } catch (e) { return err(400, 'bad_hub_url', e instanceof Error ? e.message : 'bad hub url'); } }
    const { key, name } = projectKeyFor(String(b.cwd ?? process.cwd()));
    const project = store.getOrCreateProject(key, name);
    if (hubUrl && project.hubUrl !== hubUrl) store.resetProjectSync(project.id);   // new hub has none of this history
    store.setProjectHub(project.id, hubUrl);
    return ok({ project: store.getProject(project.id) });
  }

  if (method === 'POST' && path === '/v1/embed') return ok({ embedded: await ctx.observer.embedMissing(Number((body as any)?.limit ?? 200) || 200) });

  return err(404, 'not_found', `no route ${method} ${path}`);
}
