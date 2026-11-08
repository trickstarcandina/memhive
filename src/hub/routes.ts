import type { z } from 'zod';
import { HubDimsMismatch, type HubStore, type HubObservation } from './store/types.js';
import type { HubConfig } from './server.js';
import { OBSERVATION_TYPES, type ObservationType, type SearchFilters, type Session, type Summary } from '../store/types.js';
import { VERSION } from '../shared/version.js';
import { HUB_PROTOCOL, PushBodySchema, PushObservationSchema, PushSessionSchema, PushSummarySchema, PushTombstoneSchema, isIso, type PushResult, type PullResult } from './wire.js';

export type { PushBody, PushResult, PullResult } from './wire.js';
export { isIso } from './wire.js';

const ok = (body: unknown, status = 200) => ({ status, body });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
type Rejected = PushResult['rejected'][number];
/**
 * Maps a row's schema issues to the rejection codes clients already know. Ids come first (a row we cannot name), then the
 * row-kind codes (a wrong type, not a length), then invalid_row naming the first bad field (never its value).
 */
function rejection(row: unknown, issues: z.core.$ZodIssue[], kindFields: string[], kindReason: string): Rejected {
  const id = String((row as { id?: unknown } | null)?.id).slice(0, 64);   // a bogus id is not echoed whole
  const top = (i: z.core.$ZodIssue) => String(i.path[0] ?? '');
  if (issues.some((i) => top(i) === 'id' || top(i) === 'sessionId')) return { id, reason: 'invalid_id' };
  if (issues.some((i) => top(i) === 'embedding' && i.code !== 'too_big')) return { id, reason: 'invalid_vector' };
  if (issues.some((i) => kindFields.includes(top(i)) && i.code !== 'too_big')) return { id, reason: kindReason };
  return { id, reason: 'invalid_row', field: top(issues[0]) || undefined };
}
// Postgres rejects NUL in text and jsonb; strip it everywhere so a row cannot fail in the DB after passing validation.
const noNul = <T>(v: T): T => (typeof v === 'string' ? v.replace(/\u0000/g, '') : Array.isArray(v) ? v.map(noNul) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noNul(x)])) : v) as T;
const PULL_CHUNK = 50;   // rows fetched per query while filling a page, so a page of large rows is never loaded whole
const intParam = (v: string | null, def: number, min: number, max: number) => { const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : def; };

export async function handleHubRoute(store: HubStore, cfg: HubConfig, auth: { keyId: string; userName: string }, method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }> {
  const path = url.pathname; const q = url.searchParams;
  if (method === 'GET' && path === '/v1/config') return ok({ version: VERSION, protocol: HUB_PROTOCOL, embedding_model: cfg.embeddingModel, embedding_dims: cfg.embeddingDims, body_limit: cfg.bodyLimit });
  if (method === 'GET' && path === '/v1/me') return ok({ user: auth.userName });

  if (method === 'POST' && path === '/v1/sync/push') {
    const raw = noNul(body) as Record<string, unknown> | undefined;
    // The envelope is checked whole (400); rows one by one, so one bad row never costs the rest of the batch.
    const env = PushBodySchema.pick({ projectKey: true, projectName: true }).safeParse(raw ?? {});
    if (!env.success) return err(400, 'bad_push', `invalid ${String(env.error.issues[0].path[0] ?? 'body')}`);
    const rows = (k: string): unknown[] => (Array.isArray(raw?.[k]) ? (raw[k] as unknown[]) : []);
    const { projectKey, projectName } = env.data;
    const project = await store.getOrCreateProject(projectKey, projectName || (projectKey.split('/').pop() ?? projectKey));
    const rejected: PushResult['rejected'] = [];
    // A row the hub deleted (forgotten by its owner) is never taken back, e.g. from the owner's other machine.
    const ids = (k: string) => rows(k).flatMap((r) => { const v = PushTombstoneSchema.shape.id.safeParse((r as { id?: unknown } | null)?.id); return v.success ? [v.data] : []; });   // uuids only (Postgres casts them), lowercased like the parsed rows
    const dead = await store.tombstoned(project.id, [...ids('sessions'), ...ids('observations'), ...ids('summaries')]);
    const forgotten = (id: string) => { if (!dead.has(id)) return false; rejected.push({ id, reason: 'forgotten' }); return true; };
    // Order matters: observations and summaries reference sessions (foreign keys).
    const sessions: Session[] = [];
    for (const r of rows('sessions')) {
      const p = PushSessionSchema.safeParse(r); if (!p.success) { rejected.push(rejection(r, p.error.issues, [], 'invalid_row')); continue; }
      if (forgotten(p.data.id)) continue;
      const { cwd: _cwd, ...s } = p.data;   // accepted for older clients, never stored (Session.cwd is '' on the hub)
      sessions.push({ ...s, cwd: '', endedAt: s.endedAt ?? null, projectId: project.id, userId: auth.userName, syncedAt: null });
    }
    const sIds = await store.upsertSessions(sessions);
    // An unchanged session is either identical (fine) or owned by another user/project (the upsert skipped it): report the latter.
    const changed = new Set(sIds);
    for (const x of await store.getSessions(sessions.filter((s) => !changed.has(s.id)).map((s) => s.id))) if (x.userId !== auth.userName || x.projectId !== project.id) rejected.push({ id: x.id, reason: 'not_owner' });
    const obsIn: HubObservation[] = []; const sumIn: Summary[] = [];
    for (const r of rows('observations')) {
      const p = PushObservationSchema.safeParse(r); if (!p.success) { rejected.push(rejection(r, p.error.issues, ['title', 'type'], 'invalid_observation')); continue; }
      const o = p.data; if (forgotten(o.id)) continue;
      const hasVec = !!o.embedding && o.embedding.length > 0;
      if ((o.embeddingModel && o.embeddingModel !== cfg.embeddingModel) || (hasVec && (o.embeddingModel !== cfg.embeddingModel || o.embedding!.length !== cfg.embeddingDims))) { rejected.push({ id: o.id, reason: 'embedding_model_mismatch' }); continue; }
      obsIn.push({ ...o, projectId: project.id, userId: auth.userName, origin: 'hub', syncedAt: null, embedding: hasVec ? o.embedding : null, embeddingModel: hasVec ? o.embeddingModel : null });
    }
    for (const r of rows('summaries')) {
      const p = PushSummarySchema.safeParse(r); if (!p.success) { rejected.push(rejection(r, p.error.issues, ['request'], 'invalid_summary')); continue; }
      if (forgotten(p.data.id)) continue;
      sumIn.push({ ...p.data, projectId: project.id, userId: auth.userName, origin: 'hub', syncedAt: null });
    }
    // A row must hang off a session this user owns in this project (avoids FK 500s and attaching rows to someone else's session).
    const owned = new Set((await store.getSessions([...new Set([...obsIn, ...sumIn].map((r) => r.sessionId))])).filter((x) => x.userId === auth.userName && x.projectId === project.id).map((x) => x.id));
    const keep = <T extends { id: string; sessionId: string }>(rows: T[]) => rows.filter((r) => { if (owned.has(r.sessionId)) return true; rejected.push({ id: r.id, reason: 'unknown_session' }); return false; });
    const obs = keep(obsIn); const sums = keep(sumIn);
    // Non-finite vectors were rejected above, so the store's own invalid-vector guard cannot fire here.
    let oIds: string[];
    try { oIds = await store.insertObservations(obs); }
    catch (e) {
      if (!(e instanceof HubDimsMismatch)) throw e;
      oIds = e.inserted; for (const id of e.rejected) rejected.push({ id, reason: 'embedding_model_mismatch' });
    }
    const mIds = await store.insertSummaries(sums);
    // Tombstones last: a row sent in the same body is written first, so its tombstone finds it.
    const tombs = [];
    for (const r of rows('tombstones')) {
      const p = PushTombstoneSchema.safeParse(r); if (!p.success) { rejected.push(rejection(r, p.error.issues, [], 'invalid_row')); continue; }
      tombs.push({ id: p.data.id, tbl: p.data.tbl, deletedAt: p.data.deleted_at });
    }
    const t = await store.applyTombstones(project.id, auth.userName, tombs); rejected.push(...t.rejected);
    const result: PushResult = { accepted: { sessions: sIds.length, observations: oIds.length, summaries: mIds.length, ...(tombs.length ? { tombstones: t.applied } : {}) }, rejected };
    return ok(result);
  }

  if (method === 'GET' && path === '/v1/sync/pull') {
    const key = q.get('project_key'); if (!key) return err(400, 'missing_project', 'project_key required');
    const since = intParam(q.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(q.get('limit'), 500, 1, 1000);
    const project = await store.getProjectByKey(key);
    const empty: PullResult = { sessions: [], observations: [], summaries: [], tombstones: [], next_seq: since, has_more: false, max_seq: 0 };
    if (!project) return ok(empty);
    const entries = await store.listSyncLog(project.id, since, limit + 1);
    const vectors = q.get('vectors') !== '0';
    const result: PullResult = { sessions: [], observations: [], summaries: [], tombstones: [], next_seq: since, has_more: false, max_seq: await store.maxSeq(project.id), epoch: project.id };
    // The page stops at the hub's own body limit, so rows that are each fine cannot add up to a response nobody can build or
    // read. The first row always goes (push caps keep one row well below the limit), so the cursor always moves.
    let used = Buffer.byteLength(JSON.stringify(result)) + 64; let taken = 0; let full = false;
    for (let i = 0; i < Math.min(entries.length, limit) && !full; i += PULL_CHUNK) {
      const chunk = entries.slice(i, Math.min(i + PULL_CHUNK, limit));
      const ids = (t: string) => chunk.filter((e) => e.table === t).map((e) => e.rowId);
      // A key can hold several rows: tombstones are keyed by (tbl, id) and the log names only the id, so one entry relays
      // each table's tombstone for that id (a repeat is harmless, applying a tombstone is idempotent).
      const rows = new Map<string, object[]>();
      const put = (k: string, x: object) => rows.set(k, [...(rows.get(k) ?? []), x]);
      for (const x of await store.getSessions(ids('sessions'))) put('sessions:' + x.id, x);
      for (const x of await store.getObservations(ids('observations'))) { if (!vectors) delete (x as { embedding?: unknown }).embedding; put('observations:' + x.id, x); }
      for (const x of await store.getSummaries(ids('summaries'))) put('summaries:' + x.id, x);
      for (const x of await store.getTombstones(project.id, ids('tombstone'))) put('tombstone:' + x.id, { id: x.id, tbl: x.tbl, deleted_at: x.deletedAt });
      for (const e of chunk) {
        const list = rows.get(`${e.table}:${e.rowId}`) ?? [];
        const n = list.reduce((a, row) => a + Buffer.byteLength(JSON.stringify(row)) + 1, 0);
        if (list.length && taken > 0 && used + n > cfg.bodyLimit) { full = true; break; }
        (result[e.table === 'tombstone' ? 'tombstones' : e.table] as object[]).push(...list); used += n;
        taken++; result.next_seq = e.seq;
      }
    }
    result.has_more = taken < entries.length;
    return ok(result);
  }

  if (method === 'GET' && path === '/v1/search') {
    const key = q.get('project_key'); if (!key) return err(400, 'missing_project', 'project_key required');
    const project = await store.getProjectByKey(key); if (!project) return ok({ observations: [] });
    const type = q.get('type'); if (type && !OBSERVATION_TYPES.includes(type as ObservationType)) return err(400, 'bad_type', 'unknown type');
    const f: SearchFilters = { projectId: project.id, type: (type as ObservationType) ?? undefined, userId: q.get('user') ?? undefined, since: isIso(q.get('since')) ? q.get('since')! : undefined, limit: intParam(q.get('limit'), 20, 1, 100) };
    return ok({ observations: await store.searchObservationsFts(q.get('q') ?? '', f) });
  }
  return err(404, 'not_found', `no route ${method} ${path}`);
}
