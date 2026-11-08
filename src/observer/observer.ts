import type { Logger } from '../shared/logger.js';
import { newId } from '../shared/ids.js';
import type { Observation, Store, Summary } from '../store/types.js';
import { ProviderError, type Embedder, type LlmProvider } from '../providers/types.js';
import { SessionBuffer, type ToolEvent } from './session-buffer.js';
import { OBSERVER_SYSTEM, SUMMARY_SYSTEM, buildObservationPrompt, buildSummaryPrompt } from './prompts.js';
import { redactSecrets } from '../hooks/sanitize.js';
import { parseObservations, parseSummary, type ObservationDraft } from './parser.js';

export type { ToolEvent } from './session-buffer.js';
export interface SessionCtx { sessionId: string; projectId: string; projectName: string; userId: string }
export interface ObserverOptions { flushCount: number; idleMs: number; maxAgeMs: number; maxEvents: number; maxTokens: number }
const DEFAULTS: ObserverOptions = { flushCount: 8, idleMs: 5000, maxAgeMs: 300000, maxEvents: 128, maxTokens: 2048 };

interface SessionState { buffer: SessionBuffer; timer: NodeJS.Timeout | null; inflight: Promise<void> | null; turnObservations: Observation[]; ctx: SessionCtx; touchedAt: number }
const IDLE_DROP_MS = 30 * 60 * 1000;
// After a 401/403 the observer stays paused until settings give a new provider, or this long has passed (then one new try).
const AUTH_RETRY_MS = 15 * 60 * 1000;

export const embeddingText = (o: Pick<Observation, 'title' | 'subtitle' | 'facts' | 'narrative'>) => [o.title, o.subtitle, ...o.facts, o.narrative].filter(Boolean).join('\n');

export class Observer {
  private sessions = new Map<string, SessionState>();
  private opts: ObserverOptions;
  private authFailedAt: number | null = null;
  // Session id -> prompt id last summarized; pruned with idle sessions (Codex sends no SessionEnd).
  private summarizedPrompt = new Map<string, { promptId: string; at: number }>();
  constructor(private deps: { store: Store; provider: LlmProvider; embedder: Embedder | null; logger: Logger; reloadProvider?: () => LlmProvider | null }, opts: Partial<ObserverOptions> = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }
  /** Test seam: live session entries. */
  get sessionCount(): number { return this.sessions.size; }
  get authFailed(): boolean { return this.authFailedAt !== null; }

  /** True while an auth failure pauses provider calls; a changed provider (settings) or the cooldown lifts it. */
  private paused(): boolean {
    if (this.authFailedAt === null) return false;
    const next = this.deps.reloadProvider?.() ?? null;
    if (next) { this.deps.provider = next; this.authFailedAt = null; this.deps.logger.info('provider reloaded after auth failure'); return false; }
    if (Date.now() - this.authFailedAt < AUTH_RETRY_MS) return true;
    this.authFailedAt = null;
    return false;
  }
  /** Test seam: live summary markers. */
  get summaryMarkerCount(): number { return this.summarizedPrompt.size; }

  private state(ctx: SessionCtx): SessionState {
    const now = Date.now();
    for (const [id, o] of this.sessions) if (id !== ctx.sessionId && now - o.touchedAt > IDLE_DROP_MS && !o.inflight) { if (o.timer) clearTimeout(o.timer); this.sessions.delete(id); }
    for (const [id, m] of this.summarizedPrompt) if (id !== ctx.sessionId && now - m.at > IDLE_DROP_MS) this.summarizedPrompt.delete(id);
    let s = this.sessions.get(ctx.sessionId);
    if (!s) { s = { buffer: new SessionBuffer(this.opts.maxEvents, this.opts.maxAgeMs), timer: null, inflight: null, turnObservations: [], ctx, touchedAt: now }; this.sessions.set(ctx.sessionId, s); }
    s.touchedAt = now;
    return s;
  }

  onPrompt(ctx: SessionCtx, prompt: string): void {
    const s = this.state(ctx);
    s.turnObservations = [];
    if (prompt) this.deps.store.insertPrompt({ id: newId(), sessionId: ctx.sessionId, text: prompt, createdAt: new Date().toISOString() });
  }

  onTool(ctx: SessionCtx, ev: ToolEvent): void {
    const s = this.state(ctx);
    s.buffer.push(ev);
    if (s.buffer.size() >= this.opts.flushCount) { void this.flush(s); return; }
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { s.timer = null; void this.flush(s); }, this.opts.idleMs);
    s.timer.unref?.();
  }

  async onStop(ctx: SessionCtx): Promise<void> {
    const s = this.state(ctx);
    try {
      await this.flush(s);
      await this.summarize(s, ctx);
    } finally {
      // A failed summary keeps its turn observations so SessionEnd can retry it.
      if (s.buffer.size() === 0 && !s.inflight && !s.timer && s.turnObservations.length === 0) this.sessions.delete(ctx.sessionId);
    }
  }

  /** Session end: summarize only if the last Stop did not already cover the latest prompt. */
  async onSessionEnd(ctx: SessionCtx): Promise<void> {
    try { await this.onStop(ctx); } finally {
      this.summarizedPrompt.delete(ctx.sessionId);
      const s = this.sessions.get(ctx.sessionId);
      if (s && s.buffer.size() === 0 && !s.inflight && !s.timer) this.sessions.delete(ctx.sessionId);   // no retry after the end
    }
  }

  private async summarize(s: SessionState, ctx: SessionCtx): Promise<void> {
    const latest = this.deps.store.latestPrompt(ctx.sessionId);
    const prev = this.summarizedPrompt.get(ctx.sessionId);
    if (latest && prev?.promptId === latest.id) return;
    const prompt = latest?.text ?? null;
    const observations = s.turnObservations;
    if (observations.length === 0 && (prompt ?? '').length < 20) { s.turnObservations = []; return; }
    if (this.paused()) return;
    // Claim the turn before awaiting: a racing Stop/SessionEnd then sees it summarized (or nothing new without a prompt row).
    if (latest) this.summarizedPrompt.set(ctx.sessionId, { promptId: latest.id, at: Date.now() });
    s.turnObservations = [];
    const unclaim = () => {
      if (latest && this.summarizedPrompt.get(ctx.sessionId)?.promptId === latest.id) { if (prev) this.summarizedPrompt.set(ctx.sessionId, prev); else this.summarizedPrompt.delete(ctx.sessionId); }
      s.turnObservations = [...observations, ...s.turnObservations];
    };
    try {
      const text = await this.deps.provider.complete({ system: SUMMARY_SYSTEM, user: buildSummaryPrompt({ projectName: ctx.projectName, prompt, observations }), maxTokens: 1024 });
      const parsed = parseSummary(text);
      const draft = parsed && { request: redactSecrets(parsed.request), learned: redactSecrets(parsed.learned), completed: redactSecrets(parsed.completed), nextSteps: redactSecrets(parsed.nextSteps) };
      if (!draft) { this.deps.logger.warn('summary unparseable', { sessionId: ctx.sessionId }); return; }
      const summary: Summary = { id: newId(), projectId: ctx.projectId, sessionId: ctx.sessionId, userId: ctx.userId, ...draft, createdAt: new Date().toISOString(), origin: 'local', syncedAt: null };
      this.deps.store.insertSummaries([summary]);
      this.onStored?.(ctx.projectId);
    } catch (e) { unclaim(); this.handleProviderError(e, 'summary'); }
  }

  /** Plan 2 sets this to trigger sync after new rows. */
  onStored: ((projectId: string) => void) | null = null;

  async flushAll(): Promise<void> { await Promise.allSettled([...this.sessions.values()].map((s) => this.flush(s))); }

  private async flush(s: SessionState): Promise<void> {
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
    while (s.inflight) await s.inflight;
    const events = s.buffer.drain();
    if (events.length === 0 || this.paused()) return;
    s.inflight = this.generate(s, events).finally(() => { s.inflight = null; });
    await s.inflight;
  }

  private async generate(s: SessionState, events: ToolEvent[]): Promise<void> {
    try { await this.generateUnsafe(s, events); }
    catch (e) { this.deps.logger.error('observation batch failed', { sessionId: s.ctx.sessionId, error: e instanceof Error ? e.message : String(e) }); }
  }

  private async generateUnsafe(s: SessionState, events: ToolEvent[]): Promise<void> {
    const { store, provider, logger } = this.deps; const ctx = s.ctx;
    const prompt = store.latestPrompt(ctx.sessionId)?.text ?? null;
    const recentTitles = store.listSessionObservations(ctx.sessionId, 10).map((o) => o.title);
    let text: string;
    try { text = await provider.complete({ system: OBSERVER_SYSTEM, user: buildObservationPrompt({ projectName: ctx.projectName, prompt, recentTitles, events }), maxTokens: this.opts.maxTokens }); }
    catch (e) { this.handleProviderError(e, 'observation'); return; }
    const drafts = parseObservations(text);
    if (drafts === null) { logger.warn('observer output unparseable, batch dropped', { sessionId: ctx.sessionId, events: events.length }); return; }
    if (drafts.length === 0) return;
    const rows = drafts.slice(0, 20).map((d) => this.toRow(ctx, d));
    store.insertObservations(rows);
    s.turnObservations.push(...rows);
    logger.info('observations stored', { sessionId: ctx.sessionId, count: rows.length });
    await this.embed(rows);
    this.onStored?.(ctx.projectId);
  }

  private toRow(ctx: SessionCtx, d: ObservationDraft): Observation {
    const r = redactSecrets;
    return { id: newId(), projectId: ctx.projectId, sessionId: ctx.sessionId, userId: ctx.userId, ...d, title: r(d.title), subtitle: r(d.subtitle), narrative: r(d.narrative), facts: d.facts.map(r), concepts: d.concepts.map(r), filesRead: d.filesRead.map(r), filesModified: d.filesModified.map(r), createdAt: new Date().toISOString(), embeddingModel: null, origin: 'local', syncedAt: null };
  }

  private async embed(rows: Observation[]): Promise<number> {
    const { embedder, store, logger } = this.deps;
    if (!embedder || rows.length === 0) return 0;
    let done = 0;
    for (let i = 0; i < rows.length; i += 16) {
      const batch = rows.slice(i, i + 16);
      try {
        const vecs = await embedder.embed(batch.map(embeddingText));
        batch.forEach((o, k) => store.setObservationEmbedding(o.id, vecs[k], embedder.model));
        done += batch.length;
      } catch (e) { logger.warn('embedding failed, left for backfill', { error: String(e) }); }
    }
    return done;
  }

  async embedMissing(limit = 200): Promise<number> { return this.embed(this.deps.store.listMissingEmbedding(limit)); }

  private handleProviderError(e: unknown, stage: string): void {
    const kind = e instanceof ProviderError ? e.kind : 'other';
    if (kind === 'auth') this.authFailedAt = Date.now();
    this.deps.logger.warn(`${stage} dropped: provider ${kind}`, { error: e instanceof Error ? e.message : String(e) });
  }
}
