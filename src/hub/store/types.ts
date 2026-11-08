import type { Observation, Project, SearchFilters, Session, Summary } from '../../store/types.js';

export interface HubObservation extends Observation { embedding: number[] | null }
export interface HubApiKey { id: string; userName: string; label: string; createdAt: string; revokedAt: string | null }
export type SyncTable = 'sessions' | 'observations' | 'summaries';
export interface SyncLogEntry { seq: number; table: SyncTable; rowId: string }
export interface HubStore {
  migrate(): Promise<void>; close(): Promise<void>;
  getOrCreateProject(key: string, name: string): Promise<Project>;
  getProjectByKey(key: string): Promise<Project | null>;
  upsertSessions(rows: Session[]): Promise<string[]>;                 // ids inserted or updated
  insertObservations(rows: HubObservation[]): Promise<string[]>;      // ids newly inserted (existing ignored)
  insertSummaries(rows: Summary[]): Promise<string[]>;
  appendSyncLog(projectId: string, entries: Array<{ table: SyncTable; rowId: string }>): Promise<void>;
  listSyncLog(projectId: string, sinceSeq: number, limit: number): Promise<SyncLogEntry[]>;
  maxSeq(projectId: string): Promise<number>;
  getSessions(ids: string[]): Promise<Session[]>;
  getObservations(ids: string[]): Promise<HubObservation[]>;
  getSummaries(ids: string[]): Promise<Summary[]>;
  searchObservationsFts(query: string, f: SearchFilters): Promise<Observation[]>;
  countUsers(): Promise<number>;
  createUser(name: string): Promise<void>;                             // idempotent
  createApiKey(userName: string, label: string, keyHash: string): Promise<HubApiKey>;
  listApiKeys(): Promise<HubApiKey[]>;
  revokeApiKey(id: string): Promise<boolean>;
  authenticate(keyHash: string): Promise<{ keyId: string; userName: string } | null>;   // null when unknown or revoked
}
