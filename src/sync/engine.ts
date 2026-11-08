import type { Logger } from '../shared/logger.js';
import type { Observation, Project, Session, Store, Summary } from '../store/types.js';
import type { SyncHooks } from '../daemon/context.js';
import type { PushBody, PushResult } from '../hub/routes.js';
import type { HubObservation } from '../hub/store/types.js';
import { HubClient, HubError } from './client.js';
import { loadCredentials, saveCredentials } from './credentials.js';

const BATCH = 200;
const MAX_ROUNDS = 20;   // bounds one push() call (hub allows 60 requests/min/key)

export class SyncEngine implements SyncHooks {
  private timers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private hubCfg = new Map<string, { embedding_model: string | null; embedding_dims: number | null }>();
  constructor(private deps: { store: Store; home: string; logger: Logger; fetchImpl?: typeof fetch; embedDims: number | null; embedModel?: string | null }, opts: { debounceMs?: number } = {}) { this.debounceMs = opts.debounceMs ?? 5000; }

  private clientFor(project: Project): HubClient | null {
    if (!project.hubUrl) return null;
    const cred = loadCredentials(this.deps.home).hubs[project.hubUrl];
    if (!cred || cred.authFailed) return null;
    return new HubClient(project.hubUrl, cred.key, this.deps.fetchImpl);
  }
  private markAuthFailed(project: Project): void {
    const c = loadCredentials(this.deps.home);
    if (project.hubUrl && c.hubs[project.hubUrl]) { c.hubs[project.hubUrl].authFailed = true; saveCredentials(this.deps.home, c); }
    this.deps.logger.error('hub rejected API key; run `memhub login` again', { hub: project.hubUrl });
  }
  private failed(project: Project, what: string, e: unknown): void {
    if (e instanceof HubError && e.status === 401) this.markAuthFailed(project);
    else this.deps.logger.warn(`${what} failed, will retry on next trigger`, { hub: project.hubUrl, error: e instanceof Error ? e.message : String(e) });
  }

  private async hubConfig(client: HubClient, hubUrl: string, refresh = false): Promise<{ embedding_model: string | null; embedding_dims: number | null } | null> {
    if (!refresh && this.hubCfg.has(hubUrl)) return this.hubCfg.get(hubUrl)!;
    try { const c = await client.config(); this.hubCfg.set(hubUrl, c); return c; } catch { return null; }   // unknown: send vectors, the reject path resends without
  }

  schedulePush(projectId: string): void {
    const t = this.timers.get(projectId); if (t) clearTimeout(t);
    const timer = setTimeout(() => { this.timers.delete(projectId); const p = this.deps.store.getProject(projectId); if (p) void this.push(p).catch(() => {}); }, this.debounceMs);
    timer.unref?.(); this.timers.set(projectId, timer);
  }

  async push(project: Project): Promise<PushResult | null> {
    const total: PushResult = { accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [] };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const client = this.clientFor(project); if (!client) return round === 0 ? null : total;
      const { store, logger } = this.deps;
      const sessions = store.listUnsynced('sessions', project.id, BATCH) as Session[];
      // A full session batch goes alone so no observation can reference a session that is still queued.
      const sessionsFirst = sessions.length === BATCH;
      const observations = sessionsFirst ? [] : store.listUnsynced('observations', project.id, BATCH) as Observation[];
      const summaries = sessionsFirst ? [] : store.listUnsynced('summaries', project.id, BATCH) as Summary[];
      if (!sessions.length && !observations.length && !summaries.length) return total;
      const cfg = await this.hubConfig(client, project.hubUrl!);
      const vecs = store.getObservationEmbeddings(observations.map((o) => o.id));
      const toHub = (o: Observation, withVec: boolean): HubObservation => {
        const v = withVec ? vecs.get(o.id) : undefined;
        const fits = v && (!cfg || (cfg.embedding_model !== null && cfg.embedding_model === o.embeddingModel && cfg.embedding_dims === v.length));
        return { ...o, embedding: fits ? v! : null, embeddingModel: fits ? o.embeddingModel : null };
      };
      const body: PushBody = { projectKey: project.key, projectName: project.name, sessions, observations: observations.map((o) => toHub(o, true)), summaries };
      let result: PushResult;
      try {
        result = await client.push(body);
        // Hub disagrees about the embedder: keep the row, drop its vector (local backfill / hub FTS still work).
        const mismatched = new Set(result.rejected.filter((r) => r.reason === 'embedding_model_mismatch').map((r) => r.id));
        if (mismatched.size) {
          await this.hubConfig(client, project.hubUrl!, true);
          const again = await client.push({ ...body, sessions: [], summaries: [], observations: observations.filter((o) => mismatched.has(o.id)).map((o) => toHub(o, false)) });
          result = { accepted: { sessions: result.accepted.sessions, observations: result.accepted.observations + again.accepted.observations, summaries: result.accepted.summaries }, rejected: [...result.rejected.filter((r) => r.reason !== 'embedding_model_mismatch'), ...again.rejected] };
        }
      }
      catch (e) { this.failed(project, 'push', e); return round === 0 ? null : total; }
      // Rejected rows are marked synced too: retrying the same invalid row would loop forever.
      const now = new Date().toISOString();
      store.markSynced('sessions', sessions.map((s) => s.id), now);
      store.markSynced('observations', observations.map((o) => o.id), now);
      store.markSynced('summaries', summaries.map((s) => s.id), now);
      if (result.rejected.length) logger.warn('hub rejected rows; they will not be retried', { hub: project.hubUrl, count: result.rejected.length, sample: result.rejected.slice(0, 5) });
      total.accepted.sessions += result.accepted.sessions; total.accepted.observations += result.accepted.observations; total.accepted.summaries += result.accepted.summaries;
      total.rejected.push(...result.rejected);
      if (!sessionsFirst && observations.length < BATCH && summaries.length < BATCH) return total;
    }
    return total;
  }

  async pull(project: Project, timeoutMs: number): Promise<number> {
    const client = this.clientFor(project); if (!client) return 0;
    const { store, embedDims, embedModel, logger } = this.deps;
    let applied = 0; let since = store.getPullCursor(project.id);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      let page;
      try { page = await client.pull(project.key, since, 500, Math.max(500, deadline - Date.now())); }
      catch (e) { this.failed(project, 'pull', e); break; }
      const now = new Date().toISOString();
      for (const s of page.sessions) if (!store.getSession(s.id)) { store.upsertSession({ ...s, projectId: project.id, syncedAt: now }); applied++; }
      // Rows are stored as pushed (the pushing client already sanitized them); a row for an unknown session is skipped, not fatal.
      const fresh = page.observations.filter((o) => store.getObservations([o.id]).length === 0 && store.getSession(o.sessionId));
      store.insertObservations(fresh.map((o) => ({ id: o.id, projectId: project.id, sessionId: o.sessionId, userId: o.userId, type: o.type, title: o.title, subtitle: o.subtitle, facts: o.facts, narrative: o.narrative, concepts: o.concepts, filesRead: o.filesRead, filesModified: o.filesModified, createdAt: o.createdAt, embeddingModel: null, origin: 'hub' as const, syncedAt: now })));
      for (const o of fresh) {
        applied++;
        if (o.embedding && embedDims && o.embedding.length === embedDims && o.embeddingModel && o.embeddingModel === embedModel) {
          try { store.setObservationEmbedding(o.id, o.embedding, o.embeddingModel); } catch (e) { logger.warn('pulled vector rejected locally', { id: o.id, error: String(e) }); }
        }
      }
      // shortcut: O(n) summary dedupe per pull page, add Store.hasSummary when projects exceed ~10k summaries
      const known = new Set(store.listRecentSummaries(project.id, 10_000).map((x) => x.id));
      const freshSums = page.summaries.filter((s) => !known.has(s.id) && store.getSession(s.sessionId));
      store.insertSummaries(freshSums.map((s) => ({ ...s, projectId: project.id, origin: 'hub' as const, syncedAt: now }))); applied += freshSums.length;
      if (page.next_seq > since) { since = page.next_seq; store.setPullCursor(project.id, since); }
      if (!page.has_more || Date.now() > deadline) break;
    }
    return applied;
  }

  async syncNow(project: Project): Promise<{ pushed: PushResult | null; pulled: number }> { return { pushed: await this.push(project), pulled: await this.pull(project, 10000) }; }
  close(): void { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
