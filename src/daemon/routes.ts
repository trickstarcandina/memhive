import { statSync } from 'node:fs';
import type { DaemonContext } from './context.js';
import { resolvePaths } from '../shared/paths.js';
import type { HookEvent } from '../hooks/types.js';
import { hybridSearch } from '../search/hybrid.js';
import { buildContext } from '../context/builder.js';
import { newId } from '../shared/ids.js';
import { OBSERVATION_TYPES, type Project, type Observation, type ObservationType, type SearchFilters } from '../store/types.js';
import { projectKeyFor } from '../shared/project-key.js';
import { matchesAny } from '../shared/optout.js';
import { embeddingText } from '../observer/observer.js';
import { normalizeHubUrl } from '../sync/credentials.js';
import { redactSecrets, stripPrivate } from '../hooks/sanitize.js';

const ok = (body: unknown, status = 200) => ({ status, body });
const EXCLUDED_MSG = 'memhive does not record this project (excludeProjects or .memhive.json); nothing was saved';
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

  if (method === 'GET' && path === '/v1/status') {
    const until = ctx.pausedUntil(); const cwd = q.get('cwd');
    return ok({
      observerAuthFailed: ctx.observer.authFailed, pushBlocked: ctx.sync?.blockedProjects?.() ?? [], hubErrors: ctx.sync?.hubErrors?.() ?? [],
      paused_until: until === null ? null : until === Infinity ? 'indefinite' : new Date(until).toISOString(),
      excluded: cwd ? ctx.excludedCwd(cwd) : null,
      vectors_degraded: store.vectorsDegraded ?? false,
      // projects=1 (doctor): per-project counts and sync state; asks each linked hub for its protocol (3 s cap each).
      ...(q.get('projects') === '1' ? { projects: await Promise.all(store.listProjects().map(async (p) => ({
        key: p.key, name: p.name, hubUrl: p.hubUrl, stats: store.projectStats(p.id), sync: store.getSyncState(p.id),
        protocol: p.hubUrl && ctx.sync?.hubProtocol ? await ctx.sync.hubProtocol(p).catch(() => null) : null,
      }))) } : {}),
    });
  }

  if (method === 'GET' && path === '/v1/stats') {
    const key = q.get('project_key');
    const projects = key ? [store.getProjectByKey(key)].filter((p): p is Project => !!p) : store.listProjects();
    const size = (f: string) => { try { return statSync(f).size; } catch { return 0; } };
    const db = resolvePaths(ctx.home).db;
    return ok({
      db_bytes: size(db) + size(`${db}-wal`),
      projects: projects.map((p) => { const st = store.getSyncState(p.id); return { key: p.key, name: p.name, hubUrl: p.hubUrl, ...store.projectStats(p.id), lastPushAt: st.lastPushAt, lastPullAt: st.lastPullAt }; }),
      observer: ctx.observer.counters,
    });
  }

  if (method === 'GET' && path === '/v1/project') {
    const cwd = q.get('cwd') ?? process.cwd();
    const info = projectKeyFor(cwd);
    if (ctx.excludedInfo(info)) return err(409, 'excluded', EXCLUDED_MSG);
    // A lookup never creates the project: an MCP call in a repo with no memory yet must leave no row behind.
    return ok({ project: store.getProjectByKey(info.key) ?? { key: info.key, name: info.name } });
  }

  if (method === 'POST' && path === '/v1/sessions/start') {
    const ev = body as HookEvent;
    if (!ev?.hostSessionId || !ev.cwd) return err(400, 'bad_event', 'hostSessionId and cwd required');
    const resolved = ctx.resolveSession(ev);
    if (!resolved) return ok({ context: '', excluded: true });
    const { project } = resolved;
    if (ctx.sync && project.hubUrl) { await ctx.sync.startPull(project); ctx.sync.schedulePush(project.id); }   // push also retries rows left over from an earlier daemon
    // Rows pulled from teammates can be left out of auto-injected context (they stay searchable through MCP).
    const me = ctx.userFor(project); const mine = <T extends { userId: string; origin?: string }>(rows: T[]) => ctx.settings.context?.scope === 'mine' ? rows.filter((r) => r.origin === 'local' || r.userId === me) : rows;   // own rows survive a login or rename
    const context = buildContext({
      projectName: project.name, observationCount: store.countObservations(project.id), sessionCount: store.countSessions(project.id), lastActivity: store.lastActivity(project.id),
      summaries: mine(store.listRecentSummaries(project.id, 50)).slice(0, 3), observations: mine(store.listContextObservations(project.id, 200)), budgetTokens: ctx.settings.contextTokens,
      me, cwd: ev.cwd, branch: resolved.branch,
    });
    return ok({ context });
  }

  if (method === 'POST' && path === '/v1/events') {
    const ev = body as HookEvent;
    if (!ev?.hostSessionId || !ev.cwd || !ev.event) return err(400, 'bad_event', 'invalid event');
    const resolved = ctx.resolveSession(ev);
    if (!resolved) return ok({}, 202);   // paused, disabled or excluded: dropped before the observer sees it
    const { ctx: sctx } = resolved;
    const warn = (e: unknown) => ctx.logger.warn('event handling failed', { event: ev.event, error: String(e) });
    switch (ev.event) {
      case 'prompt': ctx.observer.onPrompt(sctx, ev.prompt ?? ''); break;
      case 'tool': if (ev.tool) ctx.observer.onTool(sctx, { ...ev.tool, at: ev.at }); break;
      case 'stop': ctx.observer.onStop(sctx).catch(warn); break;
      case 'session-end': ctx.observer.onSessionEnd(sctx, ev.at).catch(warn); break;
      case 'session-start': break;
    }
    return ok({}, 202);
  }

  if (method === 'GET' && path === '/v1/search') {
    // all_projects: the CLI only; MCP always sends the current (or an allowlisted) project_key.
    const all = q.get('all_projects') === '1'; const key = q.get('project_key');
    if (!all && !key) return err(400, 'missing_project', 'project_key required');
    const project = all ? null : store.getProjectByKey(key!); if (!all && !project) return ok({ results: [], observations: [] });
    const type = q.get('type'); if (type && !OBSERVATION_TYPES.includes(type as ObservationType)) return err(400, 'bad_type', `type must be one of ${OBSERVATION_TYPES.join(', ')}`);
    const f: SearchFilters = { projectId: project?.id, type: (type as ObservationType) ?? undefined, userId: q.get('user') ?? undefined, since: parseSince(q.get('since')), limit: Math.min(Math.max(Number(q.get('limit') ?? 20) || 20, 1), 100), offset: Math.min(Math.max(Number(q.get('offset') ?? 0) || 0, 0), 10_000) };
    const text = (q.get('q') ?? '').trim();
    // No query: the newest observations under the filters (recent, or "everything since 2d").
    const results = text ? await hybridSearch(store, ctx.embedder, text, f) : store.listObservations(f).map((o) => ({ ...o, kind: 'observation' as const }));
    return ok({ results, observations: results.filter((r) => r.kind === 'observation') });   // observations: for 0.1 clients
  }

  // Edit one observation of the caller's project. Text changes stay on this machine and need an own row (origin local);
  // pinning is local only, so any row of the project can be pinned.
  if (method === 'POST' && path === '/v1/observations/edit') {
    const b = (body ?? {}) as { projectKey?: unknown; id?: unknown; title?: unknown; narrative?: unknown; pinned?: unknown };
    const str = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max);
    if (typeof b.projectKey !== 'string' || typeof b.id !== 'string' || !str(b.title, 2000) || !str(b.narrative, 20000) || (b.pinned !== undefined && typeof b.pinned !== 'boolean')) return err(400, 'bad_edit', 'projectKey and id required; title (max 2000), narrative (max 20000) strings, pinned boolean');
    if (b.title === undefined && b.narrative === undefined && b.pinned === undefined) return err(400, 'bad_edit', 'nothing to change (title, narrative or pinned)');
    const project = store.getProjectByKey(b.projectKey);
    const hits = project ? store.matchIdPrefix(project.id, b.id.replace(/^#/, '')).filter((h) => h.kind === 'observation') : [];
    if (hits.length > 1) return err(400, 'ambiguous_id', 'id matches more than one observation, use more characters');
    const o = hits.length ? store.getObservations([hits[0].id])[0] : undefined;
    if (!o) return err(404, 'not_found', `no such observation in ${b.projectKey.replace(/[^\x20-\x7e]/g, '?').slice(0, 200)}`);
    const clean = (v: unknown) => (typeof v === 'string' ? redactSecrets(stripPrivate(v)).trim() : undefined);
    const title = clean(b.title); const narrative = clean(b.narrative);
    if (title === '') return err(400, 'bad_edit', 'title cannot be empty');
    if ((title !== undefined || narrative !== undefined) && o.origin !== 'local') return err(403, 'not_owner', 'recorded by someone else; only its pin can change on this machine');
    store.updateObservation(o.id, { title: title?.slice(0, 200), narrative, pinned: b.pinned as boolean | undefined });
    return ok({ observation: store.getObservations([o.id])[0] });
  }

  // Forget observations or summaries of one project. Only this machine's own rows (origin local) are forgotten and pushed as
  // tombstones; anyone else's row is not_owner unless force, which removes the local copy only. Rows of other projects are
  // not_found, so an id cannot reach outside the project the caller is in. preview: report, delete nothing.
  if (method === 'POST' && path === '/v1/forget') {
    const b = (body ?? {}) as { projectKey?: unknown; ids?: unknown; force?: unknown; preview?: unknown };
    if (typeof b.projectKey !== 'string' || !Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100 || !b.ids.every((x) => typeof x === 'string')) return err(400, 'bad_forget', 'projectKey and ids (1-100 strings) required');
    const project = store.getProjectByKey(b.projectKey);
    type Row = { id: string; kind: 'observation' | 'summary'; type: string; title: string; userId: string; createdAt: string; origin: string; local_only: boolean };
    const out = { deleted: [] as Row[], not_owner: [] as Row[], not_found: [] as string[] };
    // An id must match exactly one row of this project across both tables: a prefix shared by several rows is refused whole,
    // never resolved to whichever table happens to have a single match.
    const matched = (b.ids as string[]).map((raw) => ({ raw, hits: project ? store.matchIdPrefix(project.id, raw.replace(/^#/, '')) : [] }));
    const ambiguous = matched.filter((m) => m.hits.length > 1).map((m) => m.raw);
    if (ambiguous.length) return err(400, 'ambiguous_id', `ids match more than one row, use more characters: ${ambiguous.map((x) => x.replace(/[^0-9a-f#-]/gi, '?').slice(0, 64)).join(', ')}`);
    for (const { raw, hits: [hit] } of matched) {
      const o = hit?.kind === 'observation' ? store.getObservations([hit.id])[0] : undefined; const m = hit?.kind === 'summary' ? store.getSummaries([hit.id])[0] : undefined;
      const x = o ?? m;
      if (!x || !project) { out.not_found.push(raw); continue; }
      const own = x.origin === 'local';
      const row: Row = { id: x.id, kind: o ? 'observation' : 'summary', type: o ? o.type : 'session-summary', title: o ? o.title : m!.request.slice(0, 200), userId: x.userId, createdAt: x.createdAt, origin: x.origin, local_only: !own };
      if (!own && b.force !== true) { out.not_owner.push(row); continue; }
      if (b.preview !== true) {
        const opts = { syncedAt: own ? null : new Date().toISOString(), projectId: project.id };   // a forced foreign row: remembered, never pushed
        if (o) store.deleteObservations([x.id], opts); else store.deleteSummaries([x.id], opts);
      }
      out.deleted.push(row);
    }
    // About own rows only (forced rows are local_only): true: the team's copies go too; false: local only (not linked, or a hub
    // before protocol 2); null: hub unreachable, queued.
    const own = out.deleted.some((r) => !r.local_only);
    const protocol = own && project?.hubUrl && ctx.sync?.hubProtocol ? await ctx.sync.hubProtocol(project) : null;
    const propagates = !own || !project?.hubUrl ? false : protocol === null ? null : protocol >= 2;
    if (project?.hubUrl && b.preview !== true && out.deleted.length) ctx.sync?.schedulePush(project.id);
    return ok({ ...out, propagates });
  }

  if (method === 'GET' && path === '/v1/observations') {
    const obsIds: string[] = []; const sumIds: string[] = [];
    for (const id of (q.get('ids') ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const o = store.resolveIdPrefix(id); const sm = o ? null : store.resolveSummaryIdPrefix(id);
      if (sm) sumIds.push(sm); else obsIds.push(o ?? id);
    }
    return ok({ observations: store.getObservations(obsIds), summaries: store.getSummaries(sumIds) });
  }

  if (method === 'GET' && path === '/v1/timeline') {
    const [anchor] = resolveIds(ctx, q.get('anchor') ?? ''); if (!anchor) return err(400, 'missing_anchor', 'anchor required');
    return ok({ observations: store.timeline(anchor, clamp(q.get('before'), 5), clamp(q.get('after'), 5)) });
  }

  if (method === 'POST' && path === '/v1/memories') {
    const b = (body ?? {}) as { projectKey?: string; text?: string; title?: string; type?: string; cwd?: string };
    // Same caps as the MCP save_memory schema; the route is reachable without MCP.
    if ((typeof b.text === 'string' && b.text.length > 20000) || (typeof b.title === 'string' && b.title.length > 2000)) return err(400, 'too_long', 'text max 20000 chars, title max 2000');
    const clean = (v: string) => redactSecrets(stripPrivate(v)).trim();
    const text = typeof b.text === 'string' ? clean(b.text) : '';
    const title = typeof b.title === 'string' ? clean(b.title) : '';
    if (!b.projectKey || !text) return err(400, 'bad_memory', 'projectKey and text required');
    if (ctx.pausedUntil() !== null) return err(409, 'paused', 'memhive is paused or disabled (memhive resume); nothing was saved');
    if (matchesAny(ctx.settings.excludeProjects, b.projectKey) || (typeof b.cwd === 'string' && b.cwd && ctx.excludedCwd(b.cwd))) return err(409, 'excluded', EXCLUDED_MSG);
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
    if (!ctx.sync || !project.hubUrl) return err(400, 'not_linked', 'project is not linked to a hub (memhive link <url>)');
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

  if (method === 'POST' && path === '/v1/embed') {
    const b = (body ?? {}) as { limit?: unknown; rebuild?: unknown };
    if (b.rebuild === true) { store.resetEmbeddings(); ctx.observer.clearEmbedFailures(); }
    return ok({ embedded: await ctx.observer.embedMissing(Math.min(Math.max(Number(b.limit ?? 200) || 200, 1), 1000)) });
  }

  return err(404, 'not_found', `no route ${method} ${path}`);
}
