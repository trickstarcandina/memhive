export type ObservationType = 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'config' | 'problem' | 'workaround';
export interface Project { id: string; key: string; name: string; hubUrl: string | null; createdAt: string }
export interface Session { id: string; projectId: string; userId: string; host: string; hostSessionId: string; cwd: string; startedAt: string; endedAt: string | null; syncedAt: string | null; origin?: 'local' | 'hub'; branch?: string | null }   // origin defaults to 'local'; pulled sessions are 'hub'; branch is local only
export interface Prompt { id: string; sessionId: string; text: string; createdAt: string }
export interface Observation { id: string; projectId: string; sessionId: string; userId: string; type: ObservationType; title: string; subtitle: string; facts: string[]; narrative: string; concepts: string[]; filesRead: string[]; filesModified: string[]; createdAt: string; embeddingModel: string | null; origin: 'local' | 'hub'; syncedAt: string | null; seenCount?: number; lastSeenAt?: string | null }   // seen*: local only, set by dedupe
export type ContextObservation = Observation & { branch: string | null };
export interface Summary { id: string; projectId: string; sessionId: string; userId: string; request: string; learned: string; completed: string; nextSteps: string; createdAt: string; origin: 'local' | 'hub'; syncedAt: string | null }
export interface SearchFilters { projectId: string; type?: ObservationType; userId?: string; since?: string; limit: number }
export interface SearchHit { id: string; score: number }
/** Per-project sync bookkeeping; times are epoch ms. */
export interface SyncState { projectId: string; pullCursor: number; hubEpoch: string | null; backoffUntil: number | null; backoffMs: number | null; strikes: number; lastError: string | null; lastErrorAt: number | null; lastPushAt: number | null; lastPullAt: number | null; quarantined: number }
export type SyncStatePatch = Partial<Pick<SyncState, 'backoffUntil' | 'backoffMs' | 'strikes' | 'lastError' | 'lastErrorAt' | 'lastPushAt' | 'lastPullAt'>>;
export type SyncTable = 'sessions' | 'observations' | 'summaries';
/** A pulled row that could not be stored; raw is the row as received (JSON, without its vector). */
export interface QuarantineRow { id: string; tbl: SyncTable; seq: number; reason: string; raw: string; createdAt?: string }
export interface Store {
  migrate(): void;
  close(): void;
  getOrCreateProject(key: string, name: string): Project;
  getProject(id: string): Project | null;
  getProjectByKey(key: string): Project | null;
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
  hasObservations(ids: string[]): Set<string>;             // the ids that exist
  hasSummaries(ids: string[]): Set<string>;
  transaction<T>(fn: () => T): T;                          // nests (savepoint); a throw rolls back only its own level
  resolveIdPrefix(prefix: string): string | null;          // unique prefix of an observation id, else null
  listRecentObservations(projectId: string, limit: number): Observation[];
  /** Candidates for the session-start context: the newest `limit` rows, each with its session's branch. */
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
