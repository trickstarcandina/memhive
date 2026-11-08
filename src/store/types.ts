export type ObservationType = 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'config' | 'problem' | 'workaround';
export interface Project { id: string; key: string; name: string; hubUrl: string | null; createdAt: string }
export interface Session { id: string; projectId: string; userId: string; host: string; hostSessionId: string; cwd: string; startedAt: string; endedAt: string | null; syncedAt: string | null; origin?: 'local' | 'hub'; branch?: string | null }   // origin defaults to 'local'; pulled sessions are 'hub'; branch is local only
export interface Prompt { id: string; sessionId: string; text: string; createdAt: string }
export interface Observation { id: string; projectId: string; sessionId: string; userId: string; type: ObservationType; title: string; subtitle: string; facts: string[]; narrative: string; concepts: string[]; filesRead: string[]; filesModified: string[]; createdAt: string; embeddingModel: string | null; origin: 'local' | 'hub'; syncedAt: string | null; seenCount?: number; lastSeenAt?: string | null; pinned?: boolean }   // seen*, pinned: local only
export type ContextObservation = Observation & { branch: string | null; sessionCwd: string | null };
export interface Summary { id: string; projectId: string; sessionId: string; userId: string; request: string; learned: string; completed: string; nextSteps: string; createdAt: string; origin: 'local' | 'hub'; syncedAt: string | null }
/** projectId undefined: every project (CLI `--all-projects` only). offset: rows to skip after ranking. */
export interface SearchFilters { projectId?: string; type?: ObservationType; userId?: string; since?: string; limit: number; offset?: number }
export interface SearchHit { id: string; score: number }
/** One search result: an observation or a session summary. */
export type SearchResult = (Observation & { kind: 'observation' }) | (Summary & { kind: 'summary' });
/** Per-project sync bookkeeping; times are epoch ms. */
export interface SyncState { projectId: string; pullCursor: number; hubEpoch: string | null; backoffUntil: number | null; backoffMs: number | null; strikes: number; lastError: string | null; lastErrorAt: number | null; lastPushAt: number | null; lastPullAt: number | null; quarantined: number }
export type SyncStatePatch = Partial<Pick<SyncState, 'backoffUntil' | 'backoffMs' | 'strikes' | 'lastError' | 'lastErrorAt' | 'lastPushAt' | 'lastPullAt'>>;
export type SyncTable = 'sessions' | 'observations' | 'summaries';
/** A pulled row that could not be stored; raw is the row as received (JSON, without its vector). */
export const TOMBSTONE_TABLES = ['observation', 'summary', 'session'] as const;
export type TombstoneTable = typeof TOMBSTONE_TABLES[number];
/** A forgotten row: queued for push (synced_at NULL) and remembered so a later pull of the same id is ignored. */
export interface Tombstone { id: string; tbl: TombstoneTable; deletedAt: string }
/** syncedAt null (default): the tombstone is queued for push; a time: remembered only (pulled tombstone, forced local removal).
 * projectId: only rows of that project are deleted, and ids with no row are still remembered under it. */
export interface DeleteOpts { syncedAt?: string | null; projectId?: string }
export interface ObservationPatch { title?: string; narrative?: string; facts?: string[]; pinned?: boolean }
export interface QuarantineRow { id: string; tbl: SyncTable; seq: number; reason: string; raw: string; createdAt?: string }
/** Row counts of one project (doctor, stats). */
export interface ProjectStats {
  observations: { local: number; hub: number }; byType: Partial<Record<ObservationType, number>>; sessions: number; summaries: number; pinned: number;
  unsynced: { sessions: number; observations: number; summaries: number; tombstones: number }; missingEmbedding: number;
}
export interface Store {
  /** True when vectors were configured but sqlite-vec failed to load (FTS-only). */
  readonly vectorsDegraded?: boolean;
  migrate(): void;
  close(): void;
  getOrCreateProject(key: string, name: string): Project;
  getProject(id: string): Project | null;
  getProjectByKey(key: string): Project | null;
  listProjects(): Project[];
  projectStats(projectId: string): ProjectStats;
  setProjectHub(id: string, hubUrl: string | null): void;
  upsertSession(s: Session): void;
  getSession(id: string): Session | null;
  getSessionByHost(host: string, hostSessionId: string): Session | null;
  endSession(id: string, endedAt: string): void;
  insertPrompt(p: Prompt): void;
  latestPrompt(sessionId: string): Prompt | null;
  /** Keeps the newest `keep` prompts per session and drops every prompt of sessions that ended before `endedBefore`. */
  prunePrompts(keep: number, endedBefore: string): number;
  insertObservations(obs: Observation[]): void;           // ignores ids that already exist
  getObservations(ids: string[]): Observation[];           // order = input order
  /** A local-origin near-duplicate in the project seen since `since`: same type and title tokens Jaccard >= 0.8, or cosine >= 0.92. */
  findDuplicate(o: Pick<Observation, 'projectId' | 'type' | 'title'>, vec: number[] | null, since: string): string | null;
  bumpSeen(id: string, at: string): void;                  // seen_count + 1, last_seen_at = at
  setPinned(id: string, pinned: boolean): boolean;          // false: no such observation
  /** Local edit (not synced): text changes refresh FTS and drop the vector so the backfill re-embeds. false: no such row. */
  updateObservation(id: string, patch: ObservationPatch): boolean;
  /** Each returns the number of rows deleted and writes a tombstone per deleted row (see DeleteOpts). */
  deleteObservations(ids: string[], opts?: DeleteOpts): number;
  deleteSummaries(ids: string[], opts?: DeleteOpts): number;
  deleteSession(id: string, opts?: DeleteOpts): number;     // also its observations, summaries and prompts (remembered, not pushed)
  forgottenIds(projectId: string, tbl: TombstoneTable, ids: string[]): Set<string>;   // ids with a tombstone for this table in this project
  /** Rows of the project whose id, head prefix or 8-char tail matches, from both tables; at most 2 per table (more = ambiguous). */
  matchIdPrefix(projectId: string, prefix: string): Array<{ id: string; kind: 'observation' | 'summary' }>;
  listPendingTombstones(projectId: string, limit: number): Tombstone[];
  markTombstonesSynced(projectId: string, ids: string[], at: string): void;
  /**
   * Deletes unpinned rows of each type last seen before its cutoff, only where nothing is lost for the team: rows
   * already synced, or rows of projects with no hub. Returns the count.
   */
  deleteExpired(cutoffs: Partial<Record<ObservationType, string>>, maxChunks?: number): number;   // at most maxChunks x 500 rows per call
  hasObservations(ids: string[]): Set<string>;             // the ids that exist
  hasSummaries(ids: string[]): Set<string>;
  transaction<T>(fn: () => T): T;                          // nests (savepoint); a throw rolls back only its own level
  resolveIdPrefix(prefix: string): string | null;          // unique prefix of an observation id, else null
  listRecentObservations(projectId: string, limit: number): Observation[];
  listObservations(f: SearchFilters): Observation[];        // newest first, filtered, limit and offset applied
  /** Candidates for the session-start context: the newest `limit` rows plus every pinned row, each with its session's branch. */
  listContextObservations(projectId: string, limit: number): ContextObservation[];
  listSessionObservations(sessionId: string, limit: number): Observation[];
  searchObservationsFts(query: string, f: SearchFilters): SearchHit[];
  searchObservationsVector(vec: number[], f: SearchFilters): SearchHit[];
  timeline(anchorId: string, before: number, after: number): Observation[];
  /** Rows without a vector, or (with `model`) with a vector from another model; newest first, `exclude` left out. */
  listMissingEmbedding(limit: number, model?: string, exclude?: Iterable<string>): Observation[];
  setObservationEmbedding(id: string, vec: number[], model: string): void;
  setObservationEmbeddings(rows: Array<{ id: string; vec: number[]; model: string }>): void;   // one transaction
  /** Drops every stored vector and marks all rows as needing an embedding (model or dims change, `embed --rebuild`). */
  resetEmbeddings(): void;
  getObservationEmbeddings(ids: string[]): Map<string, number[]>;   // only ids that have a vector
  insertSummaries(s: Summary[]): void;
  listRecentSummaries(projectId: string, limit: number): Summary[];
  getSummaries(ids: string[]): Summary[];                  // order = input order
  resolveSummaryIdPrefix(prefix: string): string | null;   // unique prefix or 8-char tail of a summary id, else null
  searchSummariesFts(query: string, f: SearchFilters): SearchHit[];
  listUnsynced(table: SyncTable, projectId: string, limit: number, exclude?: Iterable<string>): Array<Session | Observation | Summary>;
  bumpPushAttempts(table: SyncTable, ids: string[]): Map<string, number>;   // returns the new count per id
  quarantine(projectId: string, rows: QuarantineRow[]): void;   // keeps the newest 1000 per project
  listQuarantine(projectId: string, limit: number): QuarantineRow[];
  markSynced(table: 'sessions' | 'observations' | 'summaries', ids: string[], at: string): void;
  getPullCursor(projectId: string): number;
  setPullCursor(projectId: string, cursor: number): void;
  getHubEpoch(projectId: string): string | null;   // last hub epoch seen in a pull; null = none yet
  setHubEpoch(projectId: string, epoch: string): void;
  getSyncState(projectId: string): SyncState;   // defaults when the project has no row yet
  updateSyncState(projectId: string, patch: SyncStatePatch): void;
  listSyncStates(): SyncState[];
  resetProjectSync(projectId: string): void;   // relink: local-origin rows are unsynced again (pulled rows stay), pull restarts from 0, epoch and backoff forgotten
  countObservations(projectId: string): number;
  countSessions(projectId: string): number;
  lastActivity(projectId: string): string | null;         // max(observations.created_at)
}
export const OBSERVATION_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'config', 'problem', 'workaround'] as const;
