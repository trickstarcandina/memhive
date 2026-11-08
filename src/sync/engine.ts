import type { Logger } from '../shared/logger.js';
import type { Observation, Project, QuarantineRow, Session, Store, Summary, SyncTable } from '../store/types.js';
import type { SyncHooks } from '../daemon/context.js';
import { z } from 'zod';
import {
  HUB_PROTOCOL,
  HubObservationSchema,
  HubSessionSchema,
  HubSummarySchema,
  HubTombstoneSchema,
  MAX_ITEM,
  MAX_LIST,
  MAX_LONG,
  MAX_SHORT,
  type PushBody,
  type PushResult,
} from '../hub/wire.js';
import { redactSecrets } from '../hooks/sanitize.js';
import { cleanObservation, cleanSession, cleanSummary, safeText } from './clean.js';
import type { HubObservation } from '../hub/store/types.js';
import { HubClient, HubError, type HubConfigInfo } from './client.js';
import { loadCredentials, saveCredentials } from './credentials.js';

const BATCH = 200;
const MAX_ROUNDS = 20; // bounds one push() call (hub allows 60 requests/min/key)
const MAX_BODY_BYTES = 1.5 * 1024 * 1024; // hub default limit is 2 MB; used when the hub does not report body_limit
// A hub's body_limit is believed up to this much: a hostile hub must not lift the response cap (4x, so 32 MB) without bound.
const MAX_HUB_BODY_LIMIT = 8 * 1024 * 1024;
const BACKOFF_START_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const MAX_STRIKES = 5; // 404 / bare-4xx failures in a row before the bounded policy in pushOnce kicks in
const FIRST_PULL_WAIT_MS = 1000;
const CLOSE_WAIT_MS = 10_000; // close() waits this long at most for background pulls
const SKIP_AFTER = 5; // size refusals of one row before this process stops sending it
const GIVE_UP_AFTER = 20; // size refusals of one row, across restarts, before it is marked synced (given up)
const PULL_LIMIT = 500;
const PULL_LIMIT_MIN = 25; // rows per pull page; halved on an oversized response
const CONFIG_TTL_MS = 10 * 60_000; // re-read /v1/config so a hub that changes its embedder is noticed without a daemon restart
const noVec = (o: HubObservation): HubObservation => ({ ...o, embedding: null, embeddingModel: null });
// Pulled rows: ids must look like ids and dates must parse, or the row is quarantined. cwd is no longer relayed (hubs send '').
const pid = z.string().regex(/^[0-9a-f-]{8,64}$/i);
const pdate = z
  .string()
  .max(64)
  .refine((v) => Number.isFinite(Date.parse(v)));
const PulledSession = HubSessionSchema.extend({
  id: pid,
  cwd: z.string().optional(),
  startedAt: pdate,
  endedAt: pdate.nullable(),
});
const PulledObservation = HubObservationSchema.extend({ id: pid, sessionId: pid, createdAt: pdate });
const PulledSummary = HubSummarySchema.extend({ id: pid, sessionId: pid, createdAt: pdate });
const PulledTombstone = HubTombstoneSchema.extend({ id: pid });
const TOMBSTONES_FROM = 2; // the first hub protocol that accepts and relays tombstones
// Outgoing rows are clipped to the same caps: the hub refuses an over-cap row, and a refused row would be lost.
const clipList = (l: string[]) => l.slice(0, MAX_LIST).map((v) => v.slice(0, MAX_ITEM));
// seenCount, lastSeenAt and pinned are this machine's bookkeeping, not part of the shared row.
const clipObs = <T extends Observation>({ seenCount: _s, lastSeenAt: _l, pinned: _p, ...o }: T): T => ({
  ...(o as T),
  title: o.title.slice(0, MAX_SHORT),
  subtitle: o.subtitle.slice(0, MAX_SHORT),
  narrative: o.narrative.slice(0, MAX_LONG),
  facts: clipList(o.facts),
  concepts: clipList(o.concepts),
  filesRead: clipList(o.filesRead),
  filesModified: clipList(o.filesModified),
  embeddingModel: o.embeddingModel?.slice(0, MAX_SHORT) ?? null,
});
const clipSum = (m: Summary): Summary => ({
  ...m,
  request: m.request.slice(0, MAX_LONG),
  learned: m.learned.slice(0, MAX_LONG),
  completed: m.completed.slice(0, MAX_LONG),
  nextSteps: m.nextSteps.slice(0, MAX_LONG),
});
// cwd and branch stay on this machine: both can name clients, tickets or home directories. cwd goes out empty, not
// absent: a protocol 1 hub (0.1.x) rejects a session without a string cwd, and with it every row under that session.
const clipSess = ({ cwd: _cwd, branch: _branch, ...x }: Session): Omit<Session, 'branch'> => ({
  ...x,
  cwd: '',
  host: x.host.slice(0, MAX_SHORT),
  hostSessionId: x.hostSessionId.slice(0, MAX_SHORT),
});
// Fields clipped above: a hub that still refuses one has smaller caps, so the row stays queued for a client that matches it.
const CLIPPED = new Set([
  'title',
  'subtitle',
  'narrative',
  'facts',
  'concepts',
  'filesRead',
  'filesModified',
  'embeddingModel',
  'request',
  'learned',
  'completed',
  'nextSteps',
  'host',
  'hostSessionId',
]);
// Hub errors that mean "the hub or the path to it is unwell", not "this batch is bad": rows stay queued and the project backs off.
// A fetch that rejects (connection refused, DNS, timeout) gets the same backoff ladder as a 5xx, so a hub that is down is not
// hammered on every trigger.
const transient = (e: unknown): boolean =>
  !(e instanceof HubError) ||
  e.code === 'bad_response' ||
  e.code === 'response_too_large' ||
  e.status === 408 ||
  e.status === 429 ||
  e.status >= 500;

export class SyncEngine implements SyncHooks {
  private timers = new Map<string, NodeJS.Timeout>();
  private debounceMs: number;
  private hubCfg = new Map<string, { cfg: HubConfigInfo; at: number }>();
  // Project id -> next push allowed after 5xx/429/404/bare 4xx/network failure. Kept in sync_state so a restart honors it.
  private backoff = {
    get: (id: string): { until: number; delayMs: number; strikes: number } | undefined => {
      const s = this.deps.store.getSyncState(id);
      return s.backoffUntil === null && s.backoffMs === null && s.strikes === 0
        ? undefined
        : { until: s.backoffUntil ?? 0, delayMs: s.backoffMs ?? BACKOFF_START_MS, strikes: s.strikes };
    },
    set: (id: string, b: { until: number; delayMs: number; strikes: number }) =>
      this.deps.store.updateSyncState(id, { backoffUntil: b.until, backoffMs: b.delayMs, strikes: b.strikes }),
    delete: (id: string) => {
      if (this.backoff.get(id))
        this.deps.store.updateSyncState(id, { backoffUntil: null, backoffMs: null, strikes: 0 });
    },
  };
  private ladder(prev: { delayMs: number } | undefined, e: unknown): number {
    const next = (prev?.delayMs ?? BACKOFF_START_MS / 2) * 2;
    // A hub's retry-after (auth throttle, 429) is honored, within the ladder's cap.
    return Math.min(Math.max(next, e instanceof HubError ? (e.retryAfterMs ?? 0) : 0), BACKOFF_MAX_MS);
  }
  private badPulled = new Set<string>(); // ids already logged as quarantined
  private skipPush = new Set<string>(); // row ids a hub refused SKIP_AFTER times for size: not listed again in this process
  constructor(
    private deps: {
      store: Store;
      home: string;
      logger: Logger;
      fetchImpl?: typeof fetch;
      embedDims: number | null;
      embedModel?: string | null;
    },
    opts: { debounceMs?: number } = {}
  ) {
    this.debounceMs = opts.debounceMs ?? 5000;
  }

  private clientFor(project: Project): HubClient | null {
    if (!project.hubUrl) return null;
    const cred = loadCredentials(this.deps.home).hubs[project.hubUrl];
    if (!cred || cred.authFailed) return null;
    return new HubClient(project.hubUrl, cred.key, this.deps.fetchImpl);
  }
  private markAuthFailed(project: Project): void {
    const c = loadCredentials(this.deps.home);
    if (project.hubUrl && c.hubs[project.hubUrl]) {
      c.hubs[project.hubUrl].authFailed = true;
      saveCredentials(this.deps.home, c);
    }
    this.deps.logger.error('hub rejected API key; run `memhive login` again', { hub: project.hubUrl });
  }
  private lastError = new Map<string, string>(); // project id -> last failure in this process, returned by syncNow
  /** Records a failure for `memhive sync` and sync_state.last_error (redacted, no control chars, bounded). */
  private noteError(projectId: string, msg: string): void {
    const clean = redactSecrets(msg)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '?')
      .slice(0, 500);
    this.lastError.set(projectId, clean);
    this.deps.store.updateSyncState(projectId, { lastError: clean, lastErrorAt: Date.now() });
  }
  private succeeded(projectId: string, at: 'lastPushAt' | 'lastPullAt'): void {
    this.deps.store.updateSyncState(projectId, { [at]: Date.now(), lastError: null, lastErrorAt: null });
  }
  private failed(project: Project, what: string, e: unknown): void {
    this.noteError(project.id, `${what}: ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof HubError && e.status === 401) this.markAuthFailed(project);
    else
      this.deps.logger.warn(`${what} failed, will retry on next trigger`, {
        hub: project.hubUrl,
        error: e instanceof Error ? e.message : String(e),
      });
  }

  /** Also sets the client's response cap from the hub's body_limit, before the client's first large request. */
  private async hubConfig(
    client: HubClient,
    hubUrl: string,
    refresh = false,
    timeoutMs = 10000
  ): Promise<HubConfigInfo | null> {
    const fits = (c: HubConfigInfo) => {
      if (c.body_limit && c.body_limit > 0) client.maxBytes = Math.min(c.body_limit, MAX_HUB_BODY_LIMIT) * 4;
      return c;
    };
    const hit = this.hubCfg.get(hubUrl);
    if (!refresh && hit && Date.now() - hit.at < CONFIG_TTL_MS) return fits(hit.cfg);
    try {
      const c = fits(await client.config(timeoutMs));
      this.hubCfg.set(hubUrl, { cfg: c, at: Date.now() });
      if ((c.protocol ?? 0) < HUB_PROTOCOL && !this.oldHubWarned.has(hubUrl)) {
        this.oldHubWarned.add(hubUrl);
        this.deps.logger.warn('hub is older than this client (no or lower protocol); syncing anyway, upgrade the hub', {
          hub: hubUrl,
          protocol: c.protocol ?? null,
        });
      }
      return c;
    } catch {
      return null;
    } // unknown: send vectors, the reject path resends without
  }
  private oldHubWarned = new Set<string>();
  /** A hub newer than this client may send or expect shapes we do not know: refuse to sync with it. */
  private async protocolError(client: HubClient, project: Project, timeoutMs?: number): Promise<string | null> {
    const p = (await this.hubConfig(client, project.hubUrl!, false, timeoutMs))?.protocol;
    if (p === undefined || p <= HUB_PROTOCOL) return null;
    const msg = `hub_protocol: the hub speaks sync protocol ${p}, this memhive speaks ${HUB_PROTOCOL}; upgrade memhive`;
    this.noteError(project.id, msg);
    this.deps.logger.warn('sync refused: hub protocol is newer than this client', { hub: project.hubUrl, protocol: p });
    return msg;
  }
  /** Hubs whose protocol is newer than this client, with the error (shown by doctor). */
  /** The linked hub's protocol (cached config), or null when unknown or unreachable. */
  async hubProtocol(project: Project): Promise<number | null> {
    const c = this.clientFor(project);
    if (!c) return null;
    return (await this.hubConfig(c, project.hubUrl!, false, 3000))?.protocol ?? null;
  }
  private tombWarned = new Set<string>();
  private localTombWarned = new Set<string>(); // project ids already warned about hub tombstones for local rows
  private tombKeptWarned = new Set<string>();
  hubErrors(): Array<{ hub: string; error: string }> {
    return [...this.hubCfg]
      .filter(([, h]) => (h.cfg.protocol ?? 0) > HUB_PROTOCOL)
      .map(([hub, h]) => ({
        hub,
        error: `hub_protocol: hub speaks protocol ${h.cfg.protocol}, this memhive speaks ${HUB_PROTOCOL}`,
      }));
  }

  schedulePush(projectId: string): void {
    const t = this.timers.get(projectId);
    if (t) clearTimeout(t);
    const timer = setTimeout(() => {
      this.timers.delete(projectId);
      const p = this.deps.store.getProject(projectId);
      if (p) void this.push(p).catch(() => {});
    }, this.debounceMs);
    timer.unref?.();
    this.timers.set(projectId, timer);
  }

  /** Sends one body; rows the hub rejects for its embedder are re-sent once without a vector. */
  private async send(client: HubClient, project: Project, body: PushBody): Promise<PushResult> {
    let result = await client.push(body);
    // Hub disagrees about the embedder: keep the row, drop its vector (local backfill / hub FTS still work).
    const mismatched = new Set(result.rejected.filter((r) => r.reason === 'embedding_model_mismatch').map((r) => r.id));
    if (mismatched.size) {
      await this.hubConfig(client, project.hubUrl!, true);
      const again = await client.push({
        ...body,
        sessions: [],
        summaries: [],
        tombstones: [],
        observations: body.observations.filter((o) => mismatched.has(o.id)).map(noVec),
      });
      result = {
        accepted: {
          sessions: result.accepted.sessions,
          observations: result.accepted.observations + again.accepted.observations,
          summaries: result.accepted.summaries,
        },
        rejected: [...result.rejected.filter((r) => r.reason !== 'embedding_model_mismatch'), ...again.rejected],
      };
    }
    return result;
  }

  // One push per project at a time: a debounced push and syncNow would otherwise list and send the same rows twice.
  private running = new Map<string, Promise<PushResult | null>>();
  async push(project: Project, opts: { force?: boolean } = {}): Promise<PushResult | null> {
    const run = (this.running.get(project.id) ?? Promise.resolve(null))
      .catch(() => null)
      .then(() => this.pushOnce(project, opts));
    this.running.set(project.id, run);
    try {
      return await run;
    } finally {
      if (this.running.get(project.id) === run) this.running.delete(project.id);
    }
  }

  private async pushOnce(project: Project, opts: { force?: boolean }): Promise<PushResult | null> {
    const total: PushResult = { accepted: { sessions: 0, observations: 0, summaries: 0 }, rejected: [] };
    const off = this.backoff.get(project.id);
    if (off && !opts.force && Date.now() < off.until) return null;
    let cap = BATCH; // rows per body; halved on 413 for the rest of this call
    let isolating = false; // sending row by row to find a row a bare 4xx keeps refusing
    {
      const c = this.clientFor(project);
      if (c && (await this.protocolError(c, project))) return null;
    }
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const client = this.clientFor(project);
      if (!client) return round === 0 ? null : total;
      const { store, logger } = this.deps;
      const sessions = (store.listUnsynced('sessions', project.id, cap, this.skipPush) as Session[]).map(clipSess);
      // A full session batch goes alone so no observation can reference a session that is still queued.
      const sessionsFirst = sessions.length === cap;
      const observations = sessionsFirst
        ? []
        : (store.listUnsynced('observations', project.id, cap, this.skipPush) as Observation[]);
      const summaries = sessionsFirst
        ? []
        : (store.listUnsynced('summaries', project.id, cap, this.skipPush) as Summary[]).map(clipSum);
      const pending = sessionsFirst ? [] : store.listPendingTombstones(project.id, BATCH);
      if (!sessions.length && !observations.length && !summaries.length && !pending.length) {
        this.backoff.delete(project.id);
        return total;
      }
      const cfg = await this.hubConfig(client, project.hubUrl!);
      // An older hub would drop the unknown field silently: tombstones stay queued until the hub speaks protocol 2.
      const canForget = (cfg?.protocol ?? 0) >= TOMBSTONES_FROM;
      if (pending.length && !canForget && !this.tombWarned.has(project.hubUrl!)) {
        this.tombWarned.add(project.hubUrl!);
        logger.warn(
          'hub does not accept tombstones (protocol < 2); forgotten rows stay queued until the hub is upgraded',
          { hub: project.hubUrl, count: pending.length }
        );
      }
      const tombstones = canForget ? pending.map((t) => ({ id: t.id, tbl: t.tbl, deleted_at: t.deletedAt })) : [];
      if (!sessions.length && !observations.length && !summaries.length && !tombstones.length) {
        this.backoff.delete(project.id);
        return total;
      }
      const vecs = store.getObservationEmbeddings(observations.map((o) => o.id));
      const toHub = (o: Observation): HubObservation => {
        const v = vecs.get(o.id);
        const fits =
          v &&
          (!cfg ||
            (cfg.embedding_model !== null &&
              cfg.embedding_model === o.embeddingModel &&
              cfg.embedding_dims === v.length));
        return { ...o, embedding: fits ? v! : null, embeddingModel: fits ? o.embeddingModel : null };
      };
      // Fill the body up to the byte budget; the first row always goes, so an oversized row reaches the 413 path below.
      const budget = cfg?.body_limit ? Math.floor(Math.min(cfg.body_limit, MAX_HUB_BODY_LIMIT) * 0.75) : MAX_BODY_BYTES;
      let used = Buffer.byteLength(JSON.stringify({ projectKey: project.key, projectName: project.name, sessions }));
      let taken = sessions.length;
      const fit = <T>(rows: T[]): T[] => {
        const out: T[] = [];
        for (const r of rows) {
          const n = Buffer.byteLength(JSON.stringify(r)) + 1;
          if (taken >= cap || (taken > 0 && used + n > budget)) break;
          out.push(r);
          used += n;
          taken++;
        }
        return out;
      };
      const hubObs = fit(observations.map((o) => toHub(clipObs(o))));
      const sums = fit(summaries);
      const body: PushBody = {
        projectKey: project.key,
        projectName: project.name,
        sessions,
        observations: hubObs,
        summaries: sums,
        tombstones,
      }; // tombstones are tiny: left out of the byte budget
      let result: PushResult;
      let refused = false; // refused: the hub turned the whole body down (giveUp)
      try {
        result = await this.send(client, project, body);
      } catch (e) {
        if (e instanceof HubError && e.status === 401) {
          this.failed(project, 'push', e);
          return round === 0 ? null : total;
        }
        if (e instanceof HubError && e.status === 413 && taken > 1) {
          cap = Math.max(1, Math.floor(taken / 2));
          continue;
        }
        if (e instanceof HubError && e.status === 413 && hubObs[0]?.embedding) {
          try {
            result = await this.send(client, project, { ...body, observations: [noVec(hubObs[0])] });
          } catch (e2) {
            if (!(e2 instanceof HubError) || e2.status !== 413) {
              this.failed(project, 'push', e2);
              return round === 0 ? null : total;
            }
            refused = true;
            result = this.giveUp(project, body, e2);
          }
        } else if (transient(e) || (e as HubError).status === 404 || (e as HubError).code === 'http_error') {
          // Policy: 408/429/5xx back off with rows kept, forever. 404 and a bare 4xx (no hub error body: proxy, WAF, wrong path, old hub)
          // also back off, but after MAX_STRIKES in a row a bare 4xx goes row by row and gives up the one row still refused (warn log),
          // while a 404 keeps its rows unsynced, logs an error and waits at the longest backoff.
          const prev = this.backoff.get(project.id);
          const status = e instanceof HubError ? e.status : 0;
          const bounded = !transient(e);
          const strikes = (prev?.strikes ?? 0) + (bounded ? 1 : 0);
          if (bounded && status !== 404 && strikes >= MAX_STRIKES) {
            if (taken > 1) {
              cap = 1;
              isolating = true;
              this.backoff.set(project.id, { until: 0, delayMs: prev?.delayMs ?? BACKOFF_START_MS, strikes });
              continue;
            }
            this.backoff.delete(project.id);
            refused = true;
            result = this.giveUp(project, body, e as HubError);
          } else {
            const delayMs = status === 404 && strikes >= MAX_STRIKES ? BACKOFF_MAX_MS : this.ladder(prev, e);
            this.backoff.set(project.id, { until: Date.now() + delayMs, delayMs, strikes });
            this.noteError(project.id, `push: ${e instanceof Error ? e.message : String(e)}`);
            if (status === 404 && strikes === MAX_STRIKES)
              logger.error('push blocked: hub keeps answering 404 (wrong hub URL or old hub?); rows stay queued', {
                hub: project.hubUrl,
              });
            else
              logger.warn('push failed, backing off', {
                hub: project.hubUrl,
                status,
                retryInMs: delayMs,
                error: e instanceof Error ? e.message : String(e),
              });
            return round === 0 ? null : total;
          }
        } else {
          refused = true;
          result = this.giveUp(project, body, e as HubError);
        }
      }
      // While isolating, a passing row keeps the strike count so the refused row is given up when it comes up.
      if (!isolating) this.backoff.delete(project.id);
      this.succeeded(project.id, 'lastPushAt');
      // Rejected rows are marked synced too (retrying the same invalid row would loop forever), except size refusals on clipped fields.
      const now = new Date().toISOString();
      const kept = new Set(
        result.rejected.filter((r) => r.reason === 'invalid_row' && r.field && CLIPPED.has(r.field)).map((r) => r.id)
      );
      if (kept.size) {
        // Bounded: after SKIP_AFTER attempts a row is left out for the rest of this process (rows behind it still go), and after
        // GIVE_UP_AFTER attempts in total (across restarts) it is given up like any other refused row.
        const fields = [...new Set(result.rejected.filter((r) => kept.has(r.id)).map((r) => r.field))];
        const tables: Array<[SyncTable, string[]]> = [
          ['sessions', sessions.map((x) => x.id)],
          ['observations', hubObs.map((x) => x.id)],
          ['summaries', sums.map((x) => x.id)],
        ];
        const givenUp: string[] = [];
        for (const [table, ids] of tables)
          for (const [id, n] of store.bumpPushAttempts(
            table,
            ids.filter((id) => kept.has(id))
          )) {
            if (n >= GIVE_UP_AFTER) {
              kept.delete(id);
              givenUp.push(id);
              this.skipPush.delete(id);
            } else if (n >= SKIP_AFTER) this.skipPush.add(id);
          }
        logger.warn('hub refused rows over its size caps; they stay queued', {
          hub: project.hubUrl,
          fields,
          count: kept.size,
        });
        if (givenUp.length) {
          logger.warn('hub kept refusing rows over its size caps; given up', {
            hub: project.hubUrl,
            fields,
            count: givenUp.length,
          });
          const g = new Set(givenUp);
          result = {
            ...result,
            rejected: result.rejected.map((r) => (g.has(r.id) ? { ...r, reason: 'given_up' } : r)),
          };
        }
      }
      const done = (ids: string[]) => ids.filter((id) => !kept.has(id));
      store.markSynced('sessions', done(sessions.map((s) => s.id)), now);
      store.markSynced('observations', done(hubObs.map((o) => o.id)), now);
      store.markSynced('summaries', done(sums.map((s) => s.id)), now);
      // A tombstone the hub refused (not_owner) is not retried either. One sent in a body the hub turned down whole was never
      // looked at: it stays queued and goes alone next round. A tombstone-only body that is turned down is given up, so this is bounded.
      if (refused && tombstones.length && sessions.length + hubObs.length + sums.length > 0) {
        if (!this.tombKeptWarned.has(project.id)) {
          this.tombKeptWarned.add(project.id);
          logger.warn('hub refused a push body; its tombstones stay queued', {
            hub: project.hubUrl,
            count: tombstones.length,
          });
        }
      } else
        store.markTombstonesSynced(
          project.id,
          tombstones.map((t) => t.id),
          now
        );
      const lost = result.rejected.filter((r) => !kept.has(r.id) && r.reason !== 'given_up');
      if (lost.length)
        logger.warn('hub rejected rows; they will not be retried', {
          hub: project.hubUrl,
          count: lost.length,
          sample: lost.slice(0, 5),
        });
      total.accepted.sessions += result.accepted.sessions;
      total.accepted.observations += result.accepted.observations;
      total.accepted.summaries += result.accepted.summaries;
      if (result.accepted.tombstones)
        total.accepted.tombstones = (total.accepted.tombstones ?? 0) + result.accepted.tombstones;
      total.rejected.push(...result.rejected);
      if (kept.size >= sessions.length + hubObs.length + sums.length + tombstones.length) break; // only queued-again rows left: the next round would resend them
    }
    return total;
  }

  /** Projects whose push has failed MAX_STRIKES times in a row with a 404 or a bare 4xx (shown by doctor). */
  blockedProjects(): string[] {
    return this.deps.store
      .listSyncStates()
      .filter((s) => s.strikes >= MAX_STRIKES)
      .map((s) => s.projectId);
  }

  /** The hub itself refused the body (a 4xx with a hub error body, other than 401/404, or one row over the size limit): every row in it is reported rejected so it is marked synced, not resent forever. */
  private giveUp(project: Project, body: PushBody, e: HubError): PushResult {
    const reason = e.status === 413 ? 'too_large' : e.code;
    this.deps.logger.warn('hub refused a push batch; its rows will not be retried', {
      hub: project.hubUrl,
      status: e.status,
      code: e.code,
      rows: body.sessions.length + body.observations.length + body.summaries.length,
    });
    return {
      accepted: { sessions: 0, observations: 0, summaries: 0 },
      rejected: [...body.sessions, ...body.observations, ...body.summaries].map((r) => ({ id: r.id, reason })),
    };
  }

  // One pull per project at a time: two pulls from the same old cursor would both reset and could move the cursor back.
  // A second caller joins the pull in flight (it fetches the same rows) instead of queueing, so its wait stays bounded.
  private pulling = new Map<string, Promise<number>>();
  pull(project: Project, timeoutMs: number): Promise<number> {
    const cur = this.pulling.get(project.id);
    if (cur) return cur;
    const run = this.pullOnce(project, timeoutMs).finally(() => this.pulling.delete(project.id));
    this.pulling.set(project.id, run);
    return run;
  }

  private async pullOnce(project: Project, timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    const left = () => Math.max(1, deadline - Date.now()); // config fetch included
    const client = this.clientFor(project);
    if (!client) return 0;
    if (await this.protocolError(client, project, left())) return 0;
    const { store, embedDims, embedModel, logger } = this.deps;
    // Vectors we would drop anyway (no local embedder, or another model/dims) are not downloaded; unknown hub config: ask for them.
    const cfg = await this.hubConfig(client, project.hubUrl!, false, left());
    const vectors =
      !cfg || (!!embedDims && !!embedModel && cfg.embedding_model === embedModel && cfg.embedding_dims === embedDims);
    let applied = 0;
    let since = store.getPullCursor(project.id);
    let wasReset = false;
    let limit = PULL_LIMIT;
    for (;;) {
      if (Date.now() >= deadline) break;
      let page: Awaited<ReturnType<HubClient['pull']>>;
      try {
        page = await client.pull(project.key, since, limit, left(), vectors);
      } catch (e) {
        // A hub that does not cap pages by bytes (0.1.x) can send more than our cap: ask for fewer rows, nothing is stored yet.
        if (e instanceof HubError && e.code === 'response_too_large' && limit > PULL_LIMIT_MIN) {
          limit = Math.max(PULL_LIMIT_MIN, Math.floor(limit / 2));
          continue;
        }
        this.pullFailed(project, e);
        break;
      }
      // A cursor past the hub's last seq, or a new hub epoch (project id), means the hub lost its data (restored or recreated):
      // pull from 0 and push local rows again. An older hub without max_seq / epoch skips that check.
      // At most one reset per call, and the deadline still applies, so a buggy hub cannot loop us.
      const epoch = typeof page.epoch === 'string' && page.epoch ? page.epoch : null;
      const knownEpoch = epoch ? store.getHubEpoch(project.id) : null;
      const newEpoch = epoch !== null && knownEpoch !== null && knownEpoch !== epoch;
      const pastEnd =
        page.max_seq !== undefined && Number.isSafeInteger(page.max_seq) && page.max_seq >= 0 && since > page.max_seq;
      if (!wasReset && (newEpoch || pastEnd)) {
        logger.warn(
          newEpoch
            ? 'hub epoch changed (hub recreated?); resyncing project'
            : 'pull cursor is past the hub max_seq (hub reset?); resyncing project',
          { hub: project.hubUrl, cursor: since, maxSeq: page.max_seq }
        );
        store.resetProjectSync(project.id);
        since = 0;
        wasReset = true;
        this.schedulePush(project.id);
        if (epoch) store.setHubEpoch(project.id, epoch);
        continue;
      }
      // Changed again after this call's reset: no second reset in one call. The epoch is not stored, so the next pull resets.
      if (newEpoch) {
        logger.warn('hub epoch changed again during one pull; resync deferred to the next pull', {
          hub: project.hubUrl,
        });
        break;
      }
      if (epoch && knownEpoch === null) store.setHubEpoch(project.id, epoch); // first seen
      const now = new Date().toISOString();
      const progressed = page.next_seq > since;
      // A row that cannot be stored (malformed, unknown session, refused by a constraint) is quarantined, not lost behind the cursor.
      const quarantine: QuarantineRow[] = [];
      const hold = (tbl: SyncTable, raw: unknown, reason: string) => {
        const { embedding: _v, ...rest } = (raw && typeof raw === 'object' ? raw : { value: raw }) as Record<
          string,
          unknown
        >;
        const id = String(rest.id ?? '?').slice(0, 100);
        // kept for diagnosis only, but it is a teammate's text: redact secrets in every string, keep it valid JSON
        quarantine.push({
          id,
          tbl,
          seq: page.next_seq,
          reason: safeText(reason, 200),
          raw: JSON.stringify(rest, (_k, v) => (typeof v === 'string' ? redactSecrets(v) : v)),
        });
        if (!this.badPulled.has(id)) {
          this.badPulled.add(id);
          logger.warn('pulled row could not be stored; quarantined', { id, table: tbl, reason: safeText(reason, 200) });
        }
      };
      const rows = <T>(tbl: SyncTable, list: unknown[], schema: z.ZodType<T>): Array<{ row: T; raw: unknown }> =>
        list.flatMap((raw) => {
          const r = schema.safeParse(raw);
          if (r.success) return [{ row: r.data, raw }];
          hold(tbl, raw, `malformed: ${r.error.issues[0]?.path.join('.') ?? '?'}`);
          return [];
        });
      // Only constraint errors are about the row; any other SQLite error (disk full, I/O, busy) may have rolled the page back,
      // so it aborts the page and the cursor stays put.
      const apply = (tbl: SyncTable, raw: unknown, fn: () => void): boolean => {
        try {
          fn();
          return true;
        } catch (e) {
          const code = String((e as { code?: unknown })?.code ?? '');
          if (code.startsWith('SQLITE_') && !code.startsWith('SQLITE_CONSTRAINT')) throw e;
          hold(tbl, raw, `store: ${e instanceof Error ? e.message : String(e)}`);
          return false;
        }
      };
      // Pulled rows come from other clients (or anyone with a key and curl): cleaned again before they are stored.
      const sessions = rows('sessions', page.sessions, PulledSession).map(({ row: s, raw }) => ({
        raw,
        row: { ...cleanSession(s), cwd: '' },
      }));
      const observations = rows('observations', page.observations, PulledObservation).map(({ row: o, raw }) => ({
        raw,
        row: cleanObservation(o),
      }));
      const summaries = rows('summaries', page.summaries, PulledSummary).map(({ row: m, raw }) => ({
        raw,
        row: cleanSummary(m),
      }));
      let pageApplied = 0;
      const tombs = page.tombstones.flatMap((raw) => {
        const r = PulledTombstone.safeParse(raw);
        if (r.success) return [r.data];
        logger.warn('pulled tombstone is malformed; skipped', { hub: project.hubUrl });
        return [];
      });
      // One transaction per page: a page applies whole with its cursor, and SQLite commits once instead of per row.
      try {
        store.transaction(() => {
          // Tombstones first (the hub checked the owner); then rows forgotten here, by a tombstone or locally, are not stored again.
          // Scoped to this project, so another project's row with the same id is left alone. Only rows pulled from the hub go:
          // the user's own rows are never deleted on a hub's word (a compromised hub could otherwise wipe local memory).
          const kept: string[] = [];
          const del = { syncedAt: now, projectId: project.id, hubOnly: true, kept };
          for (const t of tombs)
            pageApplied +=
              t.tbl === 'observation'
                ? store.deleteObservations([t.id], del)
                : t.tbl === 'summary'
                  ? store.deleteSummaries([t.id], del)
                  : store.deleteSession(t.id, del);
          if (kept.length && !this.localTombWarned.has(project.id)) {
            this.localTombWarned.add(project.id);
            logger.warn(
              'hub sent tombstones for local rows (created on this machine); kept them, forget them here to remove them',
              {
                hub: project.hubUrl,
                count: kept.length,
              }
            );
          }
          // Per table: a tombstone for a session id must not hide another user's observation that has the same id.
          const ids = (l: Array<{ row: { id: string } }>) => l.map(({ row }) => row.id);
          const dead = {
            s: store.forgottenIds(project.id, 'session', ids(sessions)),
            o: store.forgottenIds(project.id, 'observation', ids(observations)),
            m: store.forgottenIds(project.id, 'summary', ids(summaries)),
          };
          for (const { row: s, raw } of sessions) {
            if (dead.s.has(s.id)) continue;
            // A session already pulled is updated when it ends (cwd is no longer relayed, so it is not compared). Our own sessions, and a
            // session of another project or user that happens to share the id, are never overwritten.
            const cur = store.getSession(s.id);
            if (
              cur &&
              (cur.origin !== 'hub' ||
                cur.projectId !== project.id ||
                cur.userId !== s.userId ||
                cur.endedAt === s.endedAt)
            )
              continue;
            if (
              apply('sessions', raw, () => {
                store.upsertSession({ ...s, projectId: project.id, origin: 'hub', syncedAt: now });
                if (cur) store.markSynced('sessions', [s.id], now);
              })
            )
              pageApplied++;
          }
          const haveObs = store.hasObservations(observations.map(({ row }) => row.id));
          const haveSums = store.hasSummaries(summaries.map(({ row }) => row.id));
          for (const { row: o, raw } of observations) {
            if (haveObs.has(o.id) || dead.o.has(o.id)) continue;
            if (store.getSession(o.sessionId)?.projectId !== project.id) {
              hold('observations', raw, 'unknown session'); // or another project's: timeline and context would mix projects
              continue;
            }
            const row: Observation = {
              id: o.id,
              projectId: project.id,
              sessionId: o.sessionId,
              userId: o.userId,
              type: o.type,
              title: o.title,
              subtitle: o.subtitle,
              facts: o.facts,
              narrative: o.narrative,
              concepts: o.concepts,
              filesRead: o.filesRead,
              filesModified: o.filesModified,
              createdAt: o.createdAt,
              embeddingModel: null,
              origin: 'hub',
              syncedAt: now,
            };
            if (!apply('observations', raw, () => store.insertObservations([row]))) continue;
            pageApplied++;
            if (
              o.embedding &&
              embedDims &&
              o.embedding.length === embedDims &&
              o.embeddingModel &&
              o.embeddingModel === embedModel
            ) {
              try {
                store.setObservationEmbedding(o.id, o.embedding, o.embeddingModel);
              } catch (e) {
                logger.warn('pulled vector rejected locally', { id: o.id, error: String(e) });
              }
            }
          }
          for (const { row: m, raw } of summaries) {
            if (haveSums.has(m.id) || dead.m.has(m.id)) continue;
            if (store.getSession(m.sessionId)?.projectId !== project.id) {
              hold('summaries', raw, 'unknown session');
              continue;
            }
            if (
              apply('summaries', raw, () =>
                store.insertSummaries([{ ...m, projectId: project.id, origin: 'hub', syncedAt: now }])
              )
            )
              pageApplied++;
          }
          store.quarantine(project.id, quarantine);
          if (progressed) {
            since = page.next_seq;
            store.setPullCursor(project.id, since);
          }
        });
      } catch (e) {
        since = store.getPullCursor(project.id);
        this.pullFailed(project, e);
        break;
      }
      applied += pageApplied;
      this.succeeded(project.id, 'lastPullAt');
      // has_more without a higher next_seq (a buggy hub) would re-request the same page until the deadline.
      if (!page.has_more || !progressed) break;
    }
    return applied;
  }
  private pullFailed(project: Project, e: unknown): void {
    this.failed(project, 'pull', e);
    if (transient(e)) {
      const prev = this.backoff.get(project.id);
      const delayMs = this.ladder(prev, e);
      this.backoff.set(project.id, { until: Date.now() + delayMs, delayMs, strikes: prev?.strikes ?? 0 });
    }
  }

  // Session start must not wait on the hub: the pull runs in the background (close() awaits it). A project never pulled
  // waits up to FIRST_PULL_WAIT_MS so a fresh link starts with some team context. Skipped while backing off or logged out.
  private background = new Set<Promise<void>>();
  async startPull(project: Project): Promise<void> {
    const { store, logger } = this.deps;
    if ((this.backoff.get(project.id)?.until ?? 0) > Date.now() || !this.clientFor(project)) return;
    const first = store.getPullCursor(project.id) === 0 && store.getHubEpoch(project.id) === null;
    const run = this.pull(project, 10_000).then(
      () => {},
      (e) => logger.warn('background pull failed', { error: String(e) })
    );
    this.background.add(run);
    void run.finally(() => this.background.delete(run));
    if (first) {
      let t: NodeJS.Timeout | undefined;
      await Promise.race([
        run,
        new Promise<void>((r) => {
          t = setTimeout(r, FIRST_PULL_WAIT_MS);
        }),
      ]);
      clearTimeout(t);
    }
  }

  async syncNow(project: Project): Promise<{ pushed: PushResult | null; pulled: number; error?: string }> {
    this.lastError.delete(project.id);
    const pushed = await this.push(project, { force: true });
    const pulled = await this.pull(project, 10000);
    const error = this.lastError.get(project.id);
    return error ? { pushed, pulled, error } : { pushed, pulled };
  }
  async close(): Promise<void> {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    let t: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled([...this.background]),
      new Promise<void>((r) => {
        t = setTimeout(r, CLOSE_WAIT_MS);
        t.unref?.();
      }),
    ]);
    clearTimeout(t);
  }
}
