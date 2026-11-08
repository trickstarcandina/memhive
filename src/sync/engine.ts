import type { Logger } from '../shared/logger.js';
import type { Observation, Project, Session, Store, Summary } from '../store/types.js';
import type { SyncHooks } from '../daemon/context.js';
import { z } from 'zod';
import { HUB_PROTOCOL, HubObservationSchema, HubSessionSchema, HubSummarySchema, MAX_ITEM, MAX_LIST, MAX_LONG, MAX_SHORT, type PushBody, type PushResult } from '../hub/wire.js';
import { redactSecrets } from '../hooks/sanitize.js';
import type { HubObservation } from '../hub/store/types.js';
import { HubClient, HubError, type HubConfigInfo } from './client.js';
import { loadCredentials, saveCredentials } from './credentials.js';

const BATCH = 200;
const MAX_ROUNDS = 20;   // bounds one push() call (hub allows 60 requests/min/key)
const MAX_BODY_BYTES = 1.5 * 1024 * 1024;   // hub default limit is 2 MB; used when the hub does not report body_limit
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const MAX_STRIKES = 5;   // 404 / bare-4xx failures in a row before the bounded policy in pushOnce kicks in
const FIRST_PULL_WAIT_MS = 1000;
const CONFIG_TTL_MS = 10 * 60_000;   // re-read /v1/config so a hub that changes its embedder is noticed without a daemon restart
const noVec = (o: HubObservation): HubObservation => ({ ...o, embedding: null, embeddingModel: null });
// cwd is no longer relayed (hubs send ''), so it is optional here.
const PulledSession = HubSessionSchema.extend({ cwd: z.string().optional() });
// Pulled rows come from other clients (or anyone with a key and curl): redact and clip them again with the hub's caps,
// clipping rather than rejecting so an older hub's longer rows still arrive.
const cut = (v: string, n: number) => redactSecrets(v).slice(0, n);
const cutList = (l: string[]) => l.slice(0, MAX_LIST).map((v) => cut(v, MAX_ITEM));
// Outgoing rows are clipped to the same caps: the hub refuses an over-cap row, and a refused row would be lost.
const clipList = (l: string[]) => l.slice(0, MAX_LIST).map((v) => v.slice(0, MAX_ITEM));
const clipObs = <T extends Observation>(o: T): T => ({ ...o, title: o.title.slice(0, MAX_SHORT), subtitle: o.subtitle.slice(0, MAX_SHORT), narrative: o.narrative.slice(0, MAX_LONG), facts: clipList(o.facts), concepts: clipList(o.concepts), filesRead: clipList(o.filesRead), filesModified: clipList(o.filesModified), embeddingModel: o.embeddingModel?.slice(0, MAX_SHORT) ?? null });
const clipSum = (m: Summary): Summary => ({ ...m, request: m.request.slice(0, MAX_LONG), learned: m.learned.slice(0, MAX_LONG), completed: m.completed.slice(0, MAX_LONG), nextSteps: m.nextSteps.slice(0, MAX_LONG) });
// cwd stays local: it is a path on this machine, the hub neither needs nor keeps it.
const clipSess = ({ cwd: _cwd, ...x }: Session): Omit<Session, 'cwd'> => ({ ...x, host: x.host.slice(0, MAX_SHORT), hostSessionId: x.hostSessionId.slice(0, MAX_SHORT) });
// Fields clipped above: a hub that still refuses one has smaller caps, so the row stays queued for a client that matches it.
const CLIPPED = new Set(['title', 'subtitle', 'narrative', 'facts', 'concepts', 'filesRead', 'filesModified', 'embeddingModel', 'request', 'learned', 'completed', 'nextSteps', 'host', 'hostSessionId']);
// Hub errors that mean "the hub or the path to it is unwell", not "this batch is bad": rows stay queued and the project backs off.
// A fetch that rejects (connection refused, DNS, timeout) gets the same backoff ladder as a 5xx, so a hub that is down is not
// hammered on every trigger.
const transient = (e: unknown): boolean => !(e instanceof HubError) || e.code === 'bad_response' || e.code === 'response_too_large' || e.status === 408 || e.status === 429 || e.status >= 500;

export class SyncEngine implements SyncHooks {
  private timers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private hubCfg = new Map<string, { cfg: HubConfigInfo; at: number }>();
  // Project id -> next push allowed after 5xx/429/404/bare 4xx/network failure. Kept in sync_state so a restart honors it.
  private backoff = {
    get: (id: string): { until: number; delayMs: number; strikes: number } | undefined => {
      const s = this.deps.store.getSyncState(id);
      return s.backoffUntil === null && s.backoffMs === null && s.strikes === 0 ? undefined : { until: s.backoffUntil ?? 0, delayMs: s.backoffMs ?? BACKOFF_START_MS, strikes: s.strikes };
    },
    set: (id: string, b: { until: number; delayMs: number; strikes: number }) => this.deps.store.updateSyncState(id, { backoffUntil: b.until, backoffMs: b.delayMs, strikes: b.strikes }),
    delete: (id: string) => { if (this.backoff.get(id)) this.deps.store.updateSyncState(id, { backoffUntil: null, backoffMs: null, strikes: 0 }); },
  };
  private ladder(prev: { delayMs: number } | undefined, e: unknown): number {
    const next = (prev?.delayMs ?? BACKOFF_START_MS / 2) * 2;
    // A hub's retry-after (auth throttle, 429) is honored, within the ladder's cap.
    return Math.min(Math.max(next, e instanceof HubError ? e.retryAfterMs ?? 0 : 0), BACKOFF_MAX_MS);
  }
  private badPulled = new Set<string>();
  constructor(private deps: { store: Store; home: string; logger: Logger; fetchImpl?: typeof fetch; embedDims: number | null; embedModel?: string | null }, opts: { debounceMs?: number } = {}) { this.debounceMs = opts.debounceMs ?? 5000; }

  private clientFor(project: Project): HubClient | null {
    if (!project.hubUrl) return null;
    const cred = loadCredentials(this.deps.home).hubs[project.hubUrl];
    if (!cred || cred.authFailed) return null;
    const client = new HubClient(project.hubUrl, cred.key, this.deps.fetchImpl);
    const limit = this.hubCfg.get(project.hubUrl)?.cfg.body_limit; if (limit && limit > 0) client.maxBytes = limit * 4;
    return client;
  }
  private markAuthFailed(project: Project): void {
    const c = loadCredentials(this.deps.home);
    if (project.hubUrl && c.hubs[project.hubUrl]) { c.hubs[project.hubUrl].authFailed = true; saveCredentials(this.deps.home, c); }
    this.deps.logger.error('hub rejected API key; run `memhive login` again', { hub: project.hubUrl });
  }
  private lastError = new Map<string, string>();   // project id -> last failure in this process, returned by syncNow
  /** Records a failure for `memhive sync` and sync_state.last_error (redacted, no control chars, bounded). */
  private noteError(projectId: string, msg: string): void {
    const clean = redactSecrets(msg).replace(/[\u0000-\u001f\u007f-\u009f]/g, '?').slice(0, 500);
    this.lastError.set(projectId, clean); this.deps.store.updateSyncState(projectId, { lastError: clean });
  }
  private failed(project: Project, what: string, e: unknown): void {
    this.noteError(project.id, `${what}: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof HubError && e.status === 401) this.markAuthFailed(project);
    else this.deps.logger.warn(`${what} failed, will retry on next trigger`, { hub: project.hubUrl, error: e instanceof Error ? e.message : String(e) });
  }

  private async hubConfig(client: HubClient, hubUrl: string, refresh = false): Promise<HubConfigInfo | null> {
    const hit = this.hubCfg.get(hubUrl);
    if (!refresh && hit && Date.now() - hit.at < CONFIG_TTL_MS) return hit.cfg;
    try {
      const c = await client.config(); this.hubCfg.set(hubUrl, { cfg: c, at: Date.now() });
      if ((c.protocol ?? 0) < HUB_PROTOCOL && !this.oldHubWarned.has(hubUrl)) { this.oldHubWarned.add(hubUrl); this.deps.logger.warn('hub is older than this client (no or lower protocol); syncing anyway, upgrade the hub', { hub: hubUrl, protocol: c.protocol ?? null }); }
      return c;
    } catch { return null; }   // unknown: send vectors, the reject path resends without
  }
  private oldHubWarned = new Set<string>();
  /** A hub newer than this client may send or expect shapes we do not know: refuse to sync with it. */
  private async protocolError(client: HubClient, project: Project): Promise<string | null> {
    const p = (await this.hubConfig(client, project.hubUrl!))?.protocol;
    if (p === undefined || p <= HUB_PROTOCOL) return null;
    const msg = `hub_protocol: the hub speaks sync protocol ${p}, this memhive speaks ${HUB_PROTOCOL}; upgrade memhive`;
    this.noteError(project.id, msg);
    this.deps.logger.warn('sync refused: hub protocol is newer than this client', { hub: project.hubUrl, protocol: p });
    return msg;
  }
  /** Hubs whose protocol is newer than this client, with the error (shown by doctor). */
  hubErrors(): Array<{ hub: string; error: string }> {
    return [...this.hubCfg].filter(([, h]) => (h.cfg.protocol ?? 0) > HUB_PROTOCOL).map(([hub, h]) => ({ hub, error: `hub_protocol: hub speaks protocol ${h.cfg.protocol}, this memhive speaks ${HUB_PROTOCOL}` }));
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
    { const c = this.clientFor(project); if (c && await this.protocolError(c, project)) return null; }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const client = this.clientFor(project); if (!client) return round === 0 ? null : total;
      const { store, logger } = this.deps;
      const sessions = (store.listUnsynced('sessions', project.id, cap) as Session[]).map(clipSess);
      // A full session batch goes alone so no observation can reference a session that is still queued.
      const sessionsFirst = sessions.length === cap;
      const observations = sessionsFirst ? [] : store.listUnsynced('observations', project.id, cap) as Observation[];
      const summaries = sessionsFirst ? [] : (store.listUnsynced('summaries', project.id, cap) as Summary[]).map(clipSum);
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
      const hubObs = fit(observations.map((o) => toHub(clipObs(o)))); const sums = fit(summaries);
      const body: PushBody = { projectKey: project.key, projectName: project.name, sessions, observations: hubObs, summaries: sums };
      let result: PushResult;
      try { result = await this.send(client, project, body); }
      catch (e) {
        if (e instanceof HubError && e.status === 401) { this.failed(project, 'push', e); return round === 0 ? null : total; }
        if (e instanceof HubError && e.status === 413 && taken > 1) { cap = Math.max(1, Math.floor(taken / 2)); continue; }
        if (e instanceof HubError && e.status === 413 && hubObs[0]?.embedding) {
          try { result = await this.send(client, project, { ...body, observations: [noVec(hubObs[0])] }); }
          catch (e2) { if (!(e2 instanceof HubError) || e2.status !== 413) { this.failed(project, 'push', e2); return round === 0 ? null : total; } result = this.giveUp(project, body, e2); }
        } else if (transient(e) || (e as HubError).status === 404 || (e as HubError).code === 'http_error') {
          // Policy: 408/429/5xx back off with rows kept, forever. 404 and a bare 4xx (no hub error body: proxy, WAF, wrong path, old hub)
          // also back off, but after MAX_STRIKES in a row a bare 4xx goes row by row and gives up the one row still refused (warn log),
          // while a 404 keeps its rows unsynced, logs an error and waits at the longest backoff.
          const prev = this.backoff.get(project.id);
          const status = e instanceof HubError ? e.status : 0;
          const bounded = !transient(e);
          const strikes = (prev?.strikes ?? 0) + (bounded ? 1 : 0);
          if (bounded && status !== 404 && strikes >= MAX_STRIKES) {
            if (taken > 1) { cap = 1; isolating = true; this.backoff.set(project.id, { until: 0, delayMs: prev?.delayMs ?? BACKOFF_START_MS, strikes }); continue; }
            this.backoff.delete(project.id); result = this.giveUp(project, body, e as HubError);
          } else {
            const delayMs = status === 404 && strikes >= MAX_STRIKES ? BACKOFF_MAX_MS : this.ladder(prev, e);
            this.backoff.set(project.id, { until: Date.now() + delayMs, delayMs, strikes });
            this.noteError(project.id, `push: ${e instanceof Error ? e.message : String(e)}`);
            if (status === 404 && strikes === MAX_STRIKES) logger.error('push blocked: hub keeps answering 404 (wrong hub URL or old hub?); rows stay queued', { hub: project.hubUrl });
            else logger.warn('push failed, backing off', { hub: project.hubUrl, status, retryInMs: delayMs, error: e instanceof Error ? e.message : String(e) });
            return round === 0 ? null : total;
          }
        } else result = this.giveUp(project, body, e as HubError);
      }
      // While isolating, a passing row keeps the strike count so the refused row is given up when it comes up.
      if (!isolating) this.backoff.delete(project.id);
      store.updateSyncState(project.id, { lastPushAt: Date.now() });
      // Rejected rows are marked synced too (retrying the same invalid row would loop forever), except size refusals on clipped fields.
      const now = new Date().toISOString();
      const kept = new Set(result.rejected.filter((r) => r.reason === 'invalid_row' && r.field && CLIPPED.has(r.field)).map((r) => r.id));
      if (kept.size) logger.warn('hub refused rows over its size caps; they stay queued', { hub: project.hubUrl, fields: [...new Set(result.rejected.filter((r) => kept.has(r.id)).map((r) => r.field))] });
      const done = (ids: string[]) => ids.filter((id) => !kept.has(id));
      store.markSynced('sessions', done(sessions.map((s) => s.id)), now);
      store.markSynced('observations', done(hubObs.map((o) => o.id)), now);
      store.markSynced('summaries', done(sums.map((s) => s.id)), now);
      const lost = result.rejected.filter((r) => !kept.has(r.id));
      if (lost.length) logger.warn('hub rejected rows; they will not be retried', { hub: project.hubUrl, count: lost.length, sample: lost.slice(0, 5) });
      total.accepted.sessions += result.accepted.sessions; total.accepted.observations += result.accepted.observations; total.accepted.summaries += result.accepted.summaries;
      total.rejected.push(...result.rejected);
      if (kept.size >= sessions.length + hubObs.length + sums.length) break;   // only queued-again rows left: the next round would resend them
    }
    return total;
  }

  /** Projects whose push has failed MAX_STRIKES times in a row with a 404 or a bare 4xx (shown by doctor). */
  blockedProjects(): string[] { return this.deps.store.listSyncStates().filter((s) => s.strikes >= MAX_STRIKES).map((s) => s.projectId); }

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
    if (await this.protocolError(client, project)) return 0;
    const { store, embedDims, embedModel, logger } = this.deps;
    // Vectors we would drop anyway (no local embedder, or another model/dims) are not downloaded; unknown hub config: ask for them.
    const cfg = await this.hubConfig(client, project.hubUrl!);
    const vectors = !cfg || (!!embedDims && !!embedModel && cfg.embedding_model === embedModel && cfg.embedding_dims === embedDims);
    let applied = 0; let since = store.getPullCursor(project.id);
    const deadline = Date.now() + timeoutMs; let wasReset = false;
    // One bad row must not stall the cursor: it is logged (once per id) and skipped.
    const apply = (id: string, fn: () => void): boolean => {
      try { fn(); return true; }
      catch (e) { if (!this.badPulled.has(id)) { this.badPulled.add(id); logger.warn('pulled row could not be stored; skipped', { id, error: String(e) }); } return false; }
    };
    for (;;) {
      let page;
      try { page = await client.pull(project.key, since, 500, Math.max(500, deadline - Date.now()), vectors); }
      catch (e) {
        this.failed(project, 'pull', e);
        if (transient(e)) { const prev = this.backoff.get(project.id); const delayMs = this.ladder(prev, e); this.backoff.set(project.id, { until: Date.now() + delayMs, delayMs, strikes: prev?.strikes ?? 0 }); }
        break;
      }
      // A cursor past the hub's last seq, or a new hub epoch (project id), means the hub lost its data (restored or recreated):
      // pull from 0 and push local rows again. An older hub without max_seq / epoch skips that check.
      // At most one reset per call, and the deadline still applies, so a buggy hub cannot loop us.
      const epoch = typeof page.epoch === 'string' && page.epoch ? page.epoch : null;
      const knownEpoch = epoch ? store.getHubEpoch(project.id) : null;
      const newEpoch = epoch !== null && knownEpoch !== null && knownEpoch !== epoch;
      const pastEnd = page.max_seq !== undefined && Number.isSafeInteger(page.max_seq) && page.max_seq >= 0 && since > page.max_seq;
      if (!wasReset && (newEpoch || pastEnd)) {
        logger.warn(newEpoch ? 'hub epoch changed (hub recreated?); resyncing project' : 'pull cursor is past the hub max_seq (hub reset?); resyncing project', { hub: project.hubUrl, cursor: since, maxSeq: page.max_seq });
        store.resetProjectSync(project.id); since = 0; wasReset = true; this.schedulePush(project.id);
        if (epoch) store.setHubEpoch(project.id, epoch);
        if (Date.now() > deadline) break;
        continue;
      }
      if (epoch && knownEpoch !== epoch) store.setHubEpoch(project.id, epoch);   // first seen, or changed again after this call's reset
      const now = new Date().toISOString();
      // Rows are checked one by one: a malformed row is logged once and skipped like a row the store refuses.
      const rows = <T>(list: unknown[], schema: z.ZodType<T>): T[] => list.flatMap((raw) => {
        const r = schema.safeParse(raw); if (r.success) return [r.data];
        apply(String((raw as { id?: unknown } | null)?.id ?? '?'), () => { throw new Error(`malformed row: ${r.error.issues[0]?.path.join('.')}`); });
        return [];
      });
      const sessions = rows(page.sessions, PulledSession).map((s) => ({ ...s, host: cut(s.host, MAX_SHORT), hostSessionId: cut(s.hostSessionId, MAX_SHORT), cwd: '' }));
      const observations = rows(page.observations, HubObservationSchema).map((o) => ({ ...o, title: cut(o.title, MAX_SHORT), subtitle: cut(o.subtitle, MAX_SHORT), narrative: cut(o.narrative, MAX_LONG), facts: cutList(o.facts), concepts: cutList(o.concepts), filesRead: cutList(o.filesRead), filesModified: cutList(o.filesModified) }));
      const summaries = rows(page.summaries, HubSummarySchema).map((m) => ({ ...m, request: cut(m.request, MAX_LONG), learned: cut(m.learned, MAX_LONG), completed: cut(m.completed, MAX_LONG), nextSteps: cut(m.nextSteps, MAX_LONG) }));
      // One transaction per page: a page applies whole with its cursor, and SQLite commits once instead of per row.
      store.transaction(() => {
        for (const s of sessions) {
          // A session already pulled is updated when it ends (cwd is no longer relayed, so it is not compared). Our own sessions, and a
          // session of another project or user that happens to share the id, are never overwritten.
          const cur = store.getSession(s.id);
          if (cur && (cur.origin !== 'hub' || cur.projectId !== project.id || cur.userId !== s.userId || cur.endedAt === s.endedAt)) continue;
          if (apply(s.id, () => { store.upsertSession({ ...s, projectId: project.id, origin: 'hub', syncedAt: now }); if (cur) store.markSynced('sessions', [s.id], now); })) applied++;
        }
        // A row for an unknown session is skipped, not fatal.
        const haveObs = store.hasObservations(observations.map((o) => o.id)); const haveSums = store.hasSummaries(summaries.map((m) => m.id));
        for (const o of observations) {
          if (haveObs.has(o.id) || !store.getSession(o.sessionId)) continue;
          const row: Observation = { id: o.id, projectId: project.id, sessionId: o.sessionId, userId: o.userId, type: o.type, title: o.title, subtitle: o.subtitle, facts: o.facts, narrative: o.narrative, concepts: o.concepts, filesRead: o.filesRead, filesModified: o.filesModified, createdAt: o.createdAt, embeddingModel: null, origin: 'hub', syncedAt: now };
          if (!apply(o.id, () => store.insertObservations([row]))) continue;
          applied++;
          if (o.embedding && embedDims && o.embedding.length === embedDims && o.embeddingModel && o.embeddingModel === embedModel) {
            try { store.setObservationEmbedding(o.id, o.embedding, o.embeddingModel); } catch (e) { logger.warn('pulled vector rejected locally', { id: o.id, error: String(e) }); }
          }
        }
        for (const s of summaries) if (!haveSums.has(s.id) && store.getSession(s.sessionId) && apply(s.id, () => store.insertSummaries([{ ...s, projectId: project.id, origin: 'hub', syncedAt: now }]))) applied++;
        if (page.next_seq > since) { since = page.next_seq; store.setPullCursor(project.id, since); }
      });
      store.updateSyncState(project.id, { lastPullAt: Date.now() });
      if (!page.has_more || Date.now() > deadline) break;
    }
    return applied;
  }

  // Session start must not wait on the hub: the pull runs in the background (close() awaits it). A project never pulled
  // waits up to FIRST_PULL_WAIT_MS so a fresh link starts with some team context. Skipped while backing off or logged out.
  private background = new Set<Promise<void>>();
  async startPull(project: Project): Promise<void> {
    const { store, logger } = this.deps;
    if ((this.backoff.get(project.id)?.until ?? 0) > Date.now() || !this.clientFor(project)) return;
    const first = store.getPullCursor(project.id) === 0 && store.getHubEpoch(project.id) === null;
    const run = this.pull(project, 10_000).then(() => {}, (e) => logger.warn('background pull failed', { error: String(e) }));
    this.background.add(run); void run.finally(() => this.background.delete(run));
    if (first) { let t: NodeJS.Timeout | undefined; await Promise.race([run, new Promise<void>((r) => { t = setTimeout(r, FIRST_PULL_WAIT_MS); })]); clearTimeout(t); }
  }

  async syncNow(project: Project): Promise<{ pushed: PushResult | null; pulled: number; error?: string }> {
    this.lastError.delete(project.id);
    const pushed = await this.push(project, { force: true }); const pulled = await this.pull(project, 10000);
    const error = this.lastError.get(project.id);
    return error ? { pushed, pulled, error } : { pushed, pulled };
  }
  async close(): Promise<void> { for (const t of this.timers.values()) clearTimeout(t); this.timers.clear(); await Promise.allSettled([...this.background]); }
}
