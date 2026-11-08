import { HubDimsMismatch, type HubStore, type HubObservation } from './store/types.js';
import type { HubConfig } from './server.js';
import { OBSERVATION_TYPES, type ObservationType, type SearchFilters, type Session, type Summary } from '../store/types.js';
import { VERSION } from '../shared/version.js';

export interface PushBody { projectKey: string; projectName: string; sessions: Session[]; observations: HubObservation[]; summaries: Summary[] }
export interface PushResult { accepted: { sessions: number; observations: number; summaries: number }; rejected: Array<{ id: string; reason: string }> }
export interface PullResult { sessions: Session[]; observations: HubObservation[]; summaries: Summary[]; next_seq: number; has_more: boolean; max_seq: number; epoch?: string }   // max_seq: highest seq of the project, so a client whose cursor is past it knows the hub was reset; epoch: the hub project id, new when the hub was recreated (even one already past the client's cursor)

const ok = (body: unknown, status = 200) => ({ status, body });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
export const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_RE.test(v) && !Number.isNaN(Date.parse(v));
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
// Postgres rejects NUL in text and jsonb; strip it everywhere so a row cannot fail in the DB after passing validation.
const noNul = <T>(v: T): T => (typeof v === 'string' ? v.replace(/\u0000/g, '') : Array.isArray(v) ? v.map(noNul) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noNul(x)])) : v) as T;
const intParam = (v: string | null, def: number, min: number, max: number) => { const n = v === null ? NaN : Number(v); return Number.isFinite(n) ? Math.min(Math.max(Math.floor(n), min), max) : def; };

export async function handleHubRoute(store: HubStore, cfg: HubConfig, auth: { keyId: string; userName: string }, method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }> {
  const path = url.pathname; const q = url.searchParams;
  if (method === 'GET' && path === '/v1/config') return ok({ version: VERSION, embedding_model: cfg.embeddingModel, embedding_dims: cfg.embeddingDims, body_limit: cfg.bodyLimit });
  if (method === 'GET' && path === '/v1/me') return ok({ user: auth.userName });

  if (method === 'POST' && path === '/v1/sync/push') {
    const b = noNul(body) as Partial<PushBody> | undefined;
    if (!b || typeof b.projectKey !== 'string' || !b.projectKey) return err(400, 'bad_push', 'projectKey required');
    const project = await store.getOrCreateProject(b.projectKey, typeof b.projectName === 'string' && b.projectName ? b.projectName : b.projectKey.split('/').pop() ?? b.projectKey);
    const rejected: PushResult['rejected'] = [];
    // Order matters: observations and summaries reference sessions (foreign keys).
    const sessions: Session[] = [];
    for (const s of Array.isArray(b.sessions) ? b.sessions : []) {
      if (!isUuid(s?.id)) { rejected.push({ id: String(s?.id), reason: 'invalid_id' }); continue; }
      if (![s.host, s.hostSessionId, s.cwd].every(isStr) || !isIso(s.startedAt) || (s.endedAt != null && !isIso(s.endedAt))) { rejected.push({ id: s.id, reason: 'invalid_row' }); continue; }
      sessions.push({ ...s, projectId: project.id, userId: auth.userName, syncedAt: null });
    }
    const sIds = await store.upsertSessions(sessions);
    // An unchanged session is either identical (fine) or owned by another user/project (the upsert skipped it): report the latter.
    const changed = new Set(sIds);
    for (const x of await store.getSessions(sessions.filter((s) => !changed.has(s.id)).map((s) => s.id))) if (x.userId !== auth.userName || x.projectId !== project.id) rejected.push({ id: x.id, reason: 'not_owner' });
    const obsIn: HubObservation[] = []; const sumIn: Summary[] = [];
    for (const o of Array.isArray(b.observations) ? b.observations : []) {
      if (!isUuid(o?.id) || !isUuid(o.sessionId)) { rejected.push({ id: String(o?.id), reason: 'invalid_id' }); continue; }
      if (typeof o.title !== 'string' || !OBSERVATION_TYPES.includes(o.type)) { rejected.push({ id: o.id, reason: 'invalid_observation' }); continue; }
      if (![o.subtitle, o.narrative].every(isStr) || ![o.facts, o.concepts, o.filesRead, o.filesModified].every(isStrList) || !isIso(o.createdAt) || (o.embeddingModel != null && !isStr(o.embeddingModel))) { rejected.push({ id: o.id, reason: 'invalid_row' }); continue; }
      const hasVec = Array.isArray(o.embedding) && o.embedding.length > 0;
      if (hasVec && !o.embedding!.every((x) => typeof x === 'number' && Number.isFinite(x))) { rejected.push({ id: o.id, reason: 'invalid_vector' }); continue; }
      if ((o.embeddingModel && o.embeddingModel !== cfg.embeddingModel) || (hasVec && (o.embeddingModel !== cfg.embeddingModel || o.embedding!.length !== cfg.embeddingDims))) { rejected.push({ id: o.id, reason: 'embedding_model_mismatch' }); continue; }
      obsIn.push({ ...o, projectId: project.id, userId: auth.userName, origin: 'hub', syncedAt: null, embedding: hasVec ? o.embedding : null, embeddingModel: hasVec ? o.embeddingModel : null });
    }
    for (const m of Array.isArray(b.summaries) ? b.summaries : []) {
      if (!isUuid(m?.id) || !isUuid(m.sessionId)) { rejected.push({ id: String(m?.id), reason: 'invalid_id' }); continue; }
      if (typeof m.request !== 'string') { rejected.push({ id: m.id, reason: 'invalid_summary' }); continue; }
      if (![m.learned, m.completed, m.nextSteps].every(isStr) || !isIso(m.createdAt)) { rejected.push({ id: m.id, reason: 'invalid_row' }); continue; }
      sumIn.push({ ...m, projectId: project.id, userId: auth.userName, origin: 'hub', syncedAt: null });
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
    const result: PushResult = { accepted: { sessions: sIds.length, observations: oIds.length, summaries: mIds.length }, rejected };
    return ok(result);
  }

  if (method === 'GET' && path === '/v1/sync/pull') {
    const key = q.get('project_key'); if (!key) return err(400, 'missing_project', 'project_key required');
    const since = intParam(q.get('since'), 0, 0, Number.MAX_SAFE_INTEGER);
    const limit = intParam(q.get('limit'), 500, 1, 1000);
    const project = await store.getProjectByKey(key);
    const empty: PullResult = { sessions: [], observations: [], summaries: [], next_seq: since, has_more: false, max_seq: 0 };
    if (!project) return ok(empty);
    const entries = await store.listSyncLog(project.id, since, limit + 1);
    const page = entries.slice(0, limit);
    const ids = (t: string) => page.filter((e) => e.table === t).map((e) => e.rowId);
    const result: PullResult = { sessions: await store.getSessions(ids('sessions')), observations: await store.getObservations(ids('observations')), summaries: await store.getSummaries(ids('summaries')), next_seq: page.length ? page[page.length - 1].seq : since, has_more: entries.length > limit, max_seq: await store.maxSeq(project.id), epoch: project.id };
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
