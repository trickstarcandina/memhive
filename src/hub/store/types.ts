import type { Observation, Project, SearchFilters, Session, Summary, Tombstone } from '../../store/types.js';

export interface HubObservation extends Observation { embedding: number[] | null }
export interface HubUserInfo { name: string; createdAt: string; activeKeys: number; observations: number; lastSeen: string | null }   // lastSeen: newest session or observation time the user's clients reported
export interface HubProjectInfo { key: string; name: string; createdAt: string; observations: number; sessions: number; summaries: number; lastActivity: string | null }
export interface HubUserRemoval { revokedKeys: number; observations: number; sessions: number; summaries: number }   // rows counted here stay on the hub
export interface HubApiKey { id: string; userName: string; label: string; createdAt: string; revokedAt: string | null }
export type SyncTable = 'sessions' | 'observations' | 'summaries';
export interface SyncLogEntry { seq: number; table: SyncTable | 'tombstone'; rowId: string }
/** Thrown by insertObservations after the batch is written when some rows had a vector of the wrong length; those rows are not written. */
export class HubDimsMismatch extends Error {
  constructor(public rowId: string, public expected: number, public actual: number, public inserted: string[] = [], public rejected: string[] = [rowId]) {
    super(`embedding_dims_mismatch: row ${rowId} has ${actual} dims, expected ${expected}`);
    this.name = 'HubDimsMismatch';
  }
}
/** Thrown by migrate() when the database was set up for other embedding dims than the hub is configured with. */
export class HubDimsConflict extends Error {
  constructor(public dbDims: number | null, public envDims: number | null) {
    const show = (d: number | null) => (d === null ? 'unset' : String(d));
    super(`hub embedding dims is ${show(dbDims)} in the database but MEMHIVE_EMBED_DIMS=${envDims === null ? '' : envDims}; ${dbDims === null ? 'unset MEMHIVE_EMBED_DIMS' : `set MEMHIVE_EMBED_DIMS=${dbDims}`} or run "memhive serve --reset-vectors"`);
    this.name = 'HubDimsConflict';
  }
}
// resetVectors: on a dims conflict, drop every stored vector instead of refusing to start. checkDims false (admin commands, which
// never write vectors) skips the comparison entirely; only serve enforces or resets.
export interface HubStoreOptions { dims: number | null; resetVectors?: boolean; checkDims?: boolean }
// upsertSessions / insertObservations / insertSummaries append the sync_log entries for exactly the rows they wrote, in the same transaction.
export interface HubStore {
  migrate(): Promise<void>; close(): Promise<void>;
  getOrCreateProject(key: string, name: string): Promise<Project>;
  getProjectByKey(key: string): Promise<Project | null>;
  upsertSessions(rows: Session[]): Promise<string[]>;                 // ids inserted or updated
  insertObservations(rows: HubObservation[]): Promise<string[]>;      // ids newly inserted (existing ignored)
  insertSummaries(rows: Summary[]): Promise<string[]>;
  listSyncLog(projectId: string, sinceSeq: number, limit: number): Promise<SyncLogEntry[]>;
  maxSeq(projectId: string): Promise<number>;
  /**
   * Deletes each row the user owns in the project (a session with its observations and summaries), records the tombstone
   * and logs it for pull. A row of someone else is rejected not_owner; a row the hub does not have is accepted and ignored.
   */
  applyTombstones(projectId: string, userName: string, rows: Tombstone[]): Promise<{ applied: number; rejected: Array<{ id: string; reason: string }> }>;
  tombstoned(projectId: string, ids: string[]): Promise<Set<string>>;   // ids the hub deleted in this project: never accepted again
  getTombstones(ids: string[]): Promise<Tombstone[]>;
  getSessions(ids: string[]): Promise<Session[]>;
  getObservations(ids: string[]): Promise<HubObservation[]>;
  getSummaries(ids: string[]): Promise<Summary[]>;
  searchObservationsFts(query: string, f: SearchFilters): Promise<Observation[]>;
  countUsers(): Promise<number>;
  createUser(name: string): Promise<void>;                             // idempotent
  createApiKey(userName: string, label: string, keyHash: string): Promise<HubApiKey>;
  listApiKeys(): Promise<HubApiKey[]>;
  revokeApiKey(id: string): Promise<boolean>;
  rotateApiKey(id: string, newHash: string): Promise<HubApiKey | null>;   // revokes the active key id and adds one for the same user and label, atomically; null when id is not active
  listUsers(): Promise<HubUserInfo[]>;
  removeUser(name: string): Promise<HubUserRemoval | null>;              // revokes every key of the user, keeps rows; null when unknown
  listProjects(): Promise<HubProjectInfo[]>;
  authenticate(keyHash: string): Promise<{ keyId: string; userName: string } | null>;   // null when unknown or revoked
}
