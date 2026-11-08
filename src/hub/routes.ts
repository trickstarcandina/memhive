import { HubDimsMismatch, type HubStore, type HubObservation } from './store/types.js';
import type { HubConfig } from './server.js';
import { OBSERVATION_TYPES, type ObservationType, type SearchFilters, type Session, type Summary } from '../store/types.js';
import { VERSION } from '../shared/version.js';

export interface PushBody { projectKey: string; projectName: string; sessions: Session[]; observations: HubObservation[]; summaries: Summary[] }
export interface PushResult { accepted: { sessions: number; observations: number; summaries: number }; rejected: Array<{ id: string; reason: string }> }
export interface PullResult { sessions: Session[]; observations: HubObservation[]; summaries: Summary[]; next_seq: number; has_more: boolean }

const ok = (body: unknown, status = 200) => ({ status, body });
const err = (status: number, code: string, message: string) => ({ status, body: { error: { code, message } } });
const isUuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);

export async function handleHubRoute(store: HubStore, cfg: HubConfig, auth: { keyId: string; userName: string }, method: string, url: URL, body: unknown): Promise<{ status: number; body: unknown }> {
  const path = url.pathname; const q = url.searchParams;
  if (method === 'GET' && path === '/v1/config') return ok({ version: VERSION, embedding_model: cfg.embeddingModel, embedding_dims: cfg.embeddingDims });
  if (method === 'GET' && path === '/v1/me') return ok({ user: auth.userName });

  if (method === 'POST' && path === '/v1/sync/push') {
    const b = body as Partial<PushBody> | undefined;
    if (!b || typeof b.projectKey !== 'string' || !b.projectKey) return err(400, 'bad_push', 'projectKey required');
    const project = await store.getOrCreateProject(b.projectKey, typeof b.projectName === 'string' && b.projectName ? b.projectName : b.projectKey.split('/').pop() ?? b.projectKey);
    const rejected: PushResult['rejected'] = [];
    // Order matters: observations and summaries reference sessions (foreign keys).
    const sessions = (Array.isArray(b.sessions) ? b.sessions : []).filter((s) => isUuid(s?.id)).map((s) => ({ ...s, projectId: project.id, userId: auth.userName, syncedAt: null }));
    const sIds = await store.upsertSessions(sessions);
    const obs: HubObservation[] = [];
    for (const o of Array.isArray(b.observations) ? b.observations : []) {
      if (!isUuid(o?.id) || typeof o.title !== 'string' || !OBSERVATION_TYPES.includes(o.type)) { rejected.push({ id: String(o?.id), reason: 'invalid_observation' }); continue; }
      const hasVec = Array.isArray(o.embedding) && o.embedding.length > 0;
      if ((o.embeddingModel && o.embeddingModel !== cfg.embeddingModel) || (hasVec && (o.embeddingModel !== cfg.embeddingModel || o.embedding!.length !== cfg.embeddingDims))) { rejected.push({ id: o.id, reason: 'embedding_model_mismatch' }); continue; }
      obs.push({ ...o, projectId: project.id, userId: auth.userName, origin: 'hub', syncedAt: null, embedding: hasVec ? o.embedding : null, embeddingModel: hasVec ? o.embeddingModel : null });
    }
    let oIds: string[];
    try { oIds = await store.insertObservations(obs); }
    catch (e) {
      if (!(e instanceof HubDimsMismatch)) throw e;
      oIds = e.inserted; for (const id of e.rejected) rejected.push({ id, reason: 'embedding_model_mismatch' });
    }
    const sums = (Array.isArray(b.summaries) ? b.summaries : []).filter((s) => isUuid(s?.id) && typeof s.request === 'string').map((s) => ({ ...s, projectId: project.id, userId: auth.userName, origin: 'hub' as const, syncedAt: null }));
    const mIds = await store.insertSummaries(sums);
    const result: PushResult = { accepted: { sessions: sIds.length, observations: oIds.length, summaries: mIds.length }, rejected };
    return ok(result);
  }

  if (method === 'GET' && path === '/v1/sync/pull') {
    const key = q.get('project_key'); if (!key) return err(400, 'missing_project', 'project_key required');
    const since = Math.max(0, Number(q.get('since') ?? 0) || 0);
    const limit = Math.min(Math.max(Number(q.get('limit') ?? 500) || 500, 1), 1000);
    const project = await store.getProjectByKey(key);
    const empty: PullResult = { sessions: [], observations: [], summaries: [], next_seq: since, has_more: false };
    if (!project) return ok(empty);
    const entries = await store.listSyncLog(project.id, since, limit + 1);
    const page = entries.slice(0, limit);
    const ids = (t: string) => page.filter((e) => e.table === t).map((e) => e.rowId);
    const result: PullResult = { sessions: await store.getSessions(ids('sessions')), observations: await store.getObservations(ids('observations')), summaries: await store.getSummaries(ids('summaries')), next_seq: page.length ? page[page.length - 1].seq : since, has_more: entries.length > limit };
    return ok(result);
  }

  if (method === 'GET' && path === '/v1/search') {
    const key = q.get('project_key'); if (!key) return err(400, 'missing_project', 'project_key required');
    const project = await store.getProjectByKey(key); if (!project) return ok({ observations: [] });
    const type = q.get('type'); if (type && !OBSERVATION_TYPES.includes(type as ObservationType)) return err(400, 'bad_type', 'unknown type');
    const f: SearchFilters = { projectId: project.id, type: (type as ObservationType) ?? undefined, userId: q.get('user') ?? undefined, since: q.get('since') ?? undefined, limit: Math.min(Math.max(Number(q.get('limit') ?? 20) || 20, 1), 100) };
    return ok({ observations: await store.searchObservationsFts(q.get('q') ?? '', f) });
  }
  return err(404, 'not_found', `no route ${method} ${path}`);
}
