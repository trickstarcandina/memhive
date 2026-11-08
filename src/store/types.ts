export type ObservationType = 'decision' | 'bugfix' | 'feature' | 'refactor' | 'discovery' | 'config' | 'problem' | 'workaround';
export interface Project { id: string; key: string; name: string; hubUrl: string | null; createdAt: string }
export interface Session { id: string; projectId: string; userId: string; host: string; hostSessionId: string; cwd: string; startedAt: string; endedAt: string | null; syncedAt: string | null; origin?: 'local' | 'hub' }   // origin defaults to 'local'; pulled sessions are 'hub'
export interface Prompt { id: string; sessionId: string; text: string; createdAt: string }
export interface Observation { id: string; projectId: string; sessionId: string; userId: string; type: ObservationType; title: string; subtitle: string; facts: string[]; narrative: string; concepts: string[]; filesRead: string[]; filesModified: string[]; createdAt: string; embeddingModel: string | null; origin: 'local' | 'hub'; syncedAt: string | null }
export interface Summary { id: string; projectId: string; sessionId: string; userId: string; request: string; learned: string; completed: string; nextSteps: string; createdAt: string; origin: 'local' | 'hub'; syncedAt: string | null }
export interface SearchFilters { projectId: string; type?: ObservationType; userId?: string; since?: string; limit: number }
export interface SearchHit { id: string; score: number }
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
  insertObservations(obs: Observation[]): void;           // ignores ids that already exist
  getObservations(ids: string[]): Observation[];           // order = input order
  resolveIdPrefix(prefix: string): string | null;          // unique prefix of an observation id, else null
  listRecentObservations(projectId: string, limit: number): Observation[];
  listSessionObservations(sessionId: string, limit: number): Observation[];
  searchObservationsFts(query: string, f: SearchFilters): SearchHit[];
  searchObservationsVector(vec: number[], f: SearchFilters): SearchHit[];
  timeline(anchorId: string, before: number, after: number): Observation[];
  listMissingEmbedding(limit: number): Observation[];
  setObservationEmbedding(id: string, vec: number[], model: string): void;
  getObservationEmbeddings(ids: string[]): Map<string, number[]>;   // only ids that have a vector
  insertSummaries(s: Summary[]): void;
  listRecentSummaries(projectId: string, limit: number): Summary[];
  searchSummariesFts(query: string, f: SearchFilters): SearchHit[];
  listUnsynced(table: 'sessions' | 'observations' | 'summaries', projectId: string, limit: number): Array<Session | Observation | Summary>;
  markSynced(table: 'sessions' | 'observations' | 'summaries', ids: string[], at: string): void;
  getPullCursor(projectId: string): number;
  setPullCursor(projectId: string, cursor: number): void;
  resetProjectSync(projectId: string): void;   // relink: local-origin rows are unsynced again (pulled rows stay), pull restarts from 0
  countObservations(projectId: string): number;
  countSessions(projectId: string): number;
  lastActivity(projectId: string): string | null;         // max(observations.created_at)
}
export const OBSERVATION_TYPES = ['decision', 'bugfix', 'feature', 'refactor', 'discovery', 'config', 'problem', 'workaround'] as const;
