import type { Logger } from '../shared/logger.js';
import type { Observation, Project, Session, Store, Summary } from '../store/types.js';
import type { SyncHooks } from '../daemon/context.js';
import type { PushBody, PushResult } from '../hub/routes.js';
import type { HubObservation } from '../hub/store/types.js';
import { HubClient, HubError, type HubConfigInfo } from './client.js';
import { loadCredentials, saveCredentials } from './credentials.js';

const BATCH = 200;
const MAX_ROUNDS = 20;   // bounds one push() call (hub allows 60 requests/min/key)
const MAX_BODY_BYTES = 1.5 * 1024 * 1024;   // hub default limit is 2 MB; used when the hub does not report body_limit
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const MAX_STRIKES = 5;   // 404 / bare-4xx failures in a row before the bounded policy in pushOnce kicks in
const CONFIG_TTL_MS = 10 * 60_000;   // re-read /v1/config so a hub that changes its embedder is noticed without a daemon restart
const noVec = (o: HubObservation): HubObservation => ({ ...o, embedding: null, embeddingModel: null });

export class SyncEngine implements SyncHooks {
  private timers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private hubCfg = new Map<string, { cfg: HubConfigInfo; at: number }>();
  private backoff = new Map<string, { until: number; delayMs: number; strikes: number }>();   // project id -> next push allowed after 5xx/429/404/bare 4xx
  private badPulled = new Set<string>();
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

  private async hubConfig(client: HubClient, hubUrl: string, refresh = false): Promise<HubConfigInfo | null> {
    const hit = this.hubCfg.get(hubUrl);
    if (!refresh && hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
    try { const c = await client.config(); this.hubCfg.set(hubUrl, { cfg: c, at: Date.now() }); return c; } catch { return null; }   // unknown: send vectors, the reject path resends without
  }

  schedulePush(projectId: string): void {
    const t = this.timers.get(projectId); if (t) clearTimeout(t);
    const timer = setTimeout(() => { this.timers.delete(projectId); const p = this.deps.store.getProject(projectId); if (p) void this.push(p).catch(() => {}); }, this.debounceMs);
    timer.unref?.(); this.timers.set(projectId, timer);
  }

  /** Sends one body; rows the hub rejects for its embedder are re-sent once without a vector. */
  private async send(client: HubClient, project: Project, body: PushBody): Promise<PushResult> {
    let result = await client.push(body);
    // Hub disagrees about the embedder: keep the row, drop its vector (local backfill / hub FTS still work).
    const mismatched = new Set(result.rejected.filter((r) => r.reason === 'embedding_model_mismatch').map((r) => r.id));
    if (mismatched.size) {
      await this.hubConfig(client, project.hubUrl!, true);
      const again = await client.push({ ...body, sessions: [], summaries: [], observations: body.observations.filter((o) => mismatched.has(o.id)).map(noVec) });
      result = { accepted: { sessions: result.accepted.sessions, observations: result.accepted.observations + again.accepted.observations, summaries: result.accepted.summaries }, rejected: [...result.rejected.filter((r) => r.reason !== 'embedding_model_mismatch'), ...again.rejected] };
    }
    return result;
  }

  // One push per project at a time: a debounced push and syncNow would otherwise list and send the same rows twice.
  private running = new Map<string, Promise<PushResult | null>>();
  async push(project: Project, opts: { force?: boolean } = {}): Promise<PushResult | null> {
    const run = (this.running.get(project.id) ?? Promise.resolve(null)).catch(() => null).then(() => this.pushOnce(project, opts));
    this.running.set(project.id, run);
    try { return await run; } finally { if (this.running.get(project.id) === run) this.running.delete(project.id); }
  }

  private async pushOnce(project: Project, opts: { force?: boolean }): Promise<PushResult | null> {
    const total: PushResult = { accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [] };
    const off = this.backoff.get(project.id);
    if (off && !opts.force && Date.now() < off.until) return null;
    let cap = BATCH;   // rows per body; halved on 413 for the rest of this call
    let isolating = false;   // sending row by row to find a row a bare 4xx keeps refusing
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const client = this.clientFor(project); if (!client) return round === 0 ? null : total;
      const { store, logger } = this.deps;
      const sessions = store.listUnsynced('sessions', project.id, cap) as Session[];
      // A full session batch goes alone so no observation can reference a session that is still queued.
      const sessionsFirst = sessions.length === cap;
      const observations = sessionsFirst ? [] : store.listUnsynced('observations', project.id, cap) as Observation[];
      const summaries = sessionsFirst ? [] : store.listUnsynced('summaries', project.id, cap) as Summary[];
      if (!sessions.length && !observations.length && !summaries.length) { this.backoff.delete(project.id); return total; }
      const cfg = await this.hubConfig(client, project.hubUrl!);
      const vecs = store.getObservationEmbeddings(observations.map((o) => o.id));
      const toHub = (o: Observation): HubObservation => {
        const v = vecs.get(o.id);
        const fits = v && (!cfg || (cfg.embedding_model !== null && cfg.embedding_model === o.embeddingModel && cfg.embedding_dims === v.length));
        return { ...o, embedding: fits ? v! : null, embeddingModel: fits ? o.embeddingModel : null };
      };
      // Fill the body up to the byte budget; the first row always goes, so an oversized row reaches the 413 path below.
      const budget = cfg?.body_limit ? Math.floor(cfg.body_limit * 0.75) : MAX_BODY_BYTES;
      let used = Buffer.byteLength(JSON.stringify({ projectKey: project.key, projectName: project.name, sessions })); let taken = sessions.length;
      const fit = <T>(rows: T[]): T[] => {
        const out: T[] = [];
        for (const r of rows) { const n = Buffer.byteLength(JSON.stringify(r)) + 1; if (taken >= cap || (taken > 0 && used + n > budget)) break; out.push(r); used += n; taken++; }
        return out;
      };
      const hubObs = fit(observations.map(toHub)); const sums = fit(summaries);
      const body: PushBody = { projectKey: project.key, projectName: project.name, sessions, observations: hubObs, summaries: sums };
      let result: PushResult;
      try { result = await this.send(client, project, body); }
      catch (e) {
        if (!(e instanceof HubError) || e.status === 401) { this.failed(project, 'push', e); return round === 0 ? null : total; }
        if (e.status === 413 && taken > 1) { cap = Math.max(1, Math.floor(taken / 2)); continue; }
        if (e.status === 413 && hubObs[0]?.embedding) {
          try { result = await this.send(client, project, { ...body, observations: [noVec(hubObs[0])] }); }
          catch (e2) { if (!(e2 instanceof HubError) || e2.status !== 413) { this.failed(project, 'push', e2); return round === 0 ? null : total; } result = this.giveUp(project, body, e2); }
        } else if (e.status === 404 || e.code === 'http_error' || e.status === 408 || e.status === 429 || e.status >= 500) {
          // Policy: 408/429/5xx back off with rows kept, forever. 404 and a bare 4xx (no hub error body: proxy, WAF, wrong path, old hub)
          // also back off, but after MAX_STRIKES in a row a bare 4xx goes row by row and gives up the one row still refused (warn log),
          // while a 404 keeps its rows unsynced, logs an error and waits at the longest backoff.
          // shortcut: backoff is per daemon process and resets on restart, persist it if hubs stay down for hours
          const prev = this.backoff.get(project.id);
          const bounded = e.status === 404 || (e.status < 500 && e.status !== 408 && e.status !== 429);
          const strikes = (prev?.strikes ?? 0) + (bounded ? 1 : 0);
          if (bounded && e.status !== 404 && strikes >= MAX_STRIKES) {
            if (taken > 1) { cap = 1; isolating = true; this.backoff.set(project.id, { until: 0, delayMs: prev?.delayMs ?? BACKOFF_START_MS, strikes }); continue; }
            this.backoff.delete(project.id); result = this.giveUp(project, body, e);
          } else {
            const delayMs = e.status === 404 && strikes >= MAX_STRIKES ? BACKOFF_MAX_MS : Math.min((prev?.delayMs ?? BACKOFF_START_MS / 2) * 2, BACKOFF_MAX_MS);
            this.backoff.set(project.id, { until: Date.now() + delayMs, delayMs, strikes });
            if (e.status === 404 && strikes === MAX_STRIKES) logger.error('push blocked: hub keeps answering 404 (wrong hub URL or old hub?); rows stay queued', { hub: project.hubUrl });
            else logger.warn('push failed, backing off', { hub: project.hubUrl, status: e.status, retryInMs: delayMs, error: e.message });
            return round === 0 ? null : total;
          }
        } else result = this.giveUp(project, body, e);
      }
      // While isolating, a passing row keeps the strike count so the refused row is given up when it comes up.
      if (!isolating) this.backoff.delete(project.id);
      // Rejected rows are marked synced too: retrying the same invalid row would loop forever.
      const now = new Date().toISOString();
      store.markSynced('sessions', sessions.map((s) => s.id), now);
      store.markSynced('observations', hubObs.map((o) => o.id), now);
      store.markSynced('summaries', sums.map((s) => s.id), now);
      if (result.rejected.length) logger.warn('hub rejected rows; they will not be retried', { hub: project.hubUrl, count: result.rejected.length, sample: result.rejected.slice(0, 5) });
      total.accepted.sessions += result.accepted.sessions; total.accepted.observations += result.accepted.observations; total.accepted.summaries += result.accepted.summaries;
      total.rejected.push(...result.rejected);
    }
    return total;
  }

  /** Projects whose push has failed MAX_STRIKES times in a row with a 404 or a bare 4xx (shown by doctor). */
  blockedProjects(): string[] { return [...this.backoff].filter(([, b]) => b.strikes >= MAX_STRIKES).map(([id]) => id); }

  /** The hub itself refused the body (a 4xx with a hub error body, other than 401/404, or one row over the size limit): every row in it is reported rejected so it is marked synced, not resent forever. */
  private giveUp(project: Project, body: PushBody, e: HubError): PushResult {
    const reason = e.status === 413 ? 'too_large' : e.code;
    this.deps.logger.warn('hub refused a push batch; its rows will not be retried', { hub: project.hubUrl, status: e.status, code: e.code, rows: body.sessions.length + body.observations.length + body.summaries.length });
    return { accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [...body.sessions, ...body.observations, ...body.summaries].map((r) => ({ id: r.id, reason })) };
  }

  // One pull per project at a time: two pulls from the same old cursor would both reset and could move the cursor back.
  // A second caller joins the pull in flight (it fetches the same rows) instead of queueing, so its wait stays bounded.
  private pulling = new Map<string, Promise<number>>();
  pull(project: Project, timeoutMs: number): Promise<number> {
    const cur = this.pulling.get(project.id); if (cur) return cur;
    const run = this.pullOnce(project, timeoutMs).finally(() => this.pulling.delete(project.id));
    this.pulling.set(project.id, run);
    return run;
  }

  private async pullOnce(project: Project, timeoutMs: number): Promise<number> {
    const client = this.clientFor(project); if (!client) return 0;
    const { store, embedDims, embedModel, logger } = this.deps;
    let applied = 0; let since = store.getPullCursor(project.id);
    const deadline = Date.now() + timeoutMs; let wasReset = false;
    // One bad row must not stall the cursor: it is logged (once per id) and skipped.
    const apply = (id: string, fn: () => void): boolean => {
      try { fn(); return true; }
      catch (e) { if (!this.badPulled.has(id)) { this.badPulled.add(id); logger.warn('pulled row could not be stored; skipped', { id, error: String(e) }); } return false; }
    };
    for (;;) {
      let page;
      try { page = await client.pull(project.key, since, 500, Math.max(500, deadline - Date.now())); }
      catch (e) { this.failed(project, 'pull', e); break; }
      // A cursor past the hub's last seq means the hub lost its data (restored or recreated): pull from 0 and push local rows again.
      // An older hub without max_seq skips this check.
      // At most one reset per call, and the deadline still applies, so a buggy hub cannot loop us.
      if (!wasReset && Number.isSafeInteger(page.max_seq) && page.max_seq >= 0 && since > page.max_seq) {
        logger.warn('pull cursor is past the hub max_seq (hub reset?); resyncing project', { hub: project.hubUrl, cursor: since, maxSeq: page.max_seq });
        store.resetProjectSync(project.id); since = 0; wasReset = true; this.schedulePush(project.id);
        if (Date.now() > deadline) break;
        continue;
      }
      const now = new Date().toISOString();
      for (const s of page.sessions) {
        // A session already pulled is updated (the hub re-logs it when it ends or its cwd changes). Our own sessions, and a
        // session of another project or user that happens to share the id, are never overwritten.
        const cur = store.getSession(s.id);
        if (cur && (cur.origin !== 'hub' || cur.projectId !== project.id || cur.userId !== s.userId || (cur.endedAt === s.endedAt && cur.cwd === s.cwd))) continue;
        if (apply(s.id, () => { store.upsertSession({ ...s, projectId: project.id, origin: 'hub', syncedAt: now }); if (cur) store.markSynced('sessions', [s.id], now); })) applied++;
      }
      // Rows are stored as pushed (the pushing client already sanitized them); a row for an unknown session is skipped, not fatal.
      const fresh = page.observations.filter((o) => store.getObservations([o.id]).length === 0 && store.getSession(o.sessionId));
      for (const o of fresh) {
        const row: Observation = { id: o.id, projectId: project.id, sessionId: o.sessionId, userId: o.userId, type: o.type, title: o.title, subtitle: o.subtitle, facts: o.facts, narrative: o.narrative, concepts: o.concepts, filesRead: o.filesRead, filesModified: o.filesModified, createdAt: o.createdAt, embeddingModel: null, origin: 'hub', syncedAt: now };
        if (!apply(o.id, () => store.insertObservations([row]))) continue;
        applied++;
        if (o.embedding && embedDims && o.embedding.length === embedDims && o.embeddingModel && o.embeddingModel === embedModel) {
          try { store.setObservationEmbedding(o.id, o.embedding, o.embeddingModel); } catch (e) { logger.warn('pulled vector rejected locally', { id: o.id, error: String(e) }); }
        }
      }
      // shortcut: O(n) summary dedupe per pull page, add Store.hasSummary when projects exceed ~10k summaries
      const known = new Set(store.listRecentSummaries(project.id, 10_000).map((x) => x.id));
      for (const s of page.summaries) if (!known.has(s.id) && store.getSession(s.sessionId) && apply(s.id, () => store.insertSummaries([{ ...s, projectId: project.id, origin: 'hub', syncedAt: now }]))) applied++;
      if (page.next_seq > since) { since = page.next_seq; store.setPullCursor(project.id, since); }
      if (!page.has_more || Date.now() > deadline) break;
    }
    return applied;
  }

  async syncNow(project: Project): Promise<{ pushed: PushResult | null; pulled: number }> { return { pushed: await this.push(project, { force: true }), pulled: await this.pull(project, 10000) }; }
  close(): void { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); }
}
