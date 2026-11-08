import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import type { Observation, Project, Prompt, SearchFilters, SearchHit, Session, Store, Summary, SyncState, SyncStatePatch } from '../types.js';
import { SQLITE_MIGRATIONS } from './migrations.js';
import { toFtsQuery } from './fts-query.js';
import { newId } from '../../shared/ids.js';

type Row = Record<string, any>;
const j = (v: unknown) => JSON.stringify(v ?? []);
const pj = (v: unknown): string[] => { try { const a = JSON.parse(String(v)); return Array.isArray(a) ? a : []; } catch { return []; } };

const rowToProject = (r: Row): Project => ({ id: r.id, key: r.key, name: r.name, hubUrl: r.hub_url ?? null, createdAt: r.created_at });
const rowToSession = (r: Row): Session => ({ id: r.id, projectId: r.project_id, userId: r.user_id, host: r.host, hostSessionId: r.host_session_id, cwd: r.cwd, startedAt: r.started_at, endedAt: r.ended_at ?? null, syncedAt: r.synced_at ?? null, origin: r.origin });
const rowToObservation = (r: Row): Observation => ({ id: r.id, projectId: r.project_id, sessionId: r.session_id, userId: r.user_id, type: r.type, title: r.title, subtitle: r.subtitle, facts: pj(r.facts), narrative: r.narrative, concepts: pj(r.concepts), filesRead: pj(r.files_read), filesModified: pj(r.files_modified), createdAt: r.created_at, embeddingModel: r.embedding_model ?? null, origin: r.origin, syncedAt: r.synced_at ?? null });
const rowToSyncState = (r: Row): SyncState => ({ projectId: r.project_id, pullCursor: Number(r.pull_cursor), hubEpoch: r.hub_epoch ?? null, backoffUntil: r.backoff_until ?? null, backoffMs: r.backoff_ms ?? null, strikes: Number(r.strikes ?? 0), lastError: r.last_error ?? null, lastPushAt: r.last_push_at ?? null, lastPullAt: r.last_pull_at ?? null });
const SYNC_COLS: Record<keyof SyncStatePatch, string> = { backoffUntil: 'backoff_until', backoffMs: 'backoff_ms', strikes: 'strikes', lastError: 'last_error', lastPushAt: 'last_push_at', lastPullAt: 'last_pull_at' };
const rowToSummary = (r: Row): Summary => ({ id: r.id, projectId: r.project_id, sessionId: r.session_id, userId: r.user_id, request: r.request, learned: r.learned, completed: r.completed, nextSteps: r.next_steps, createdAt: r.created_at, origin: r.origin, syncedAt: r.synced_at ?? null });

function filterSql(f: SearchFilters, alias: string): { sql: string; params: unknown[] } {
  const parts = [`${alias}.project_id = ?`]; const params: unknown[] = [f.projectId];
  if (f.type) { parts.push(`${alias}.type = ?`); params.push(f.type); }
  if (f.userId) { parts.push(`${alias}.user_id = ?`); params.push(f.userId); }
  if (f.since) { parts.push(`${alias}.created_at >= ?`); params.push(f.since); }
  return { sql: parts.join(' AND '), params };
}

export class SqliteStore implements Store {
  private db: Database.Database;
  private dims: number | null;

  private vecOff = false;
  /** True when dims were configured but sqlite-vec failed to load (vectors cannot be stored or searched). */
  get vectorsDegraded(): boolean { return this.vecOff; }

  constructor(file: string, opts: { dims: number | null; warn?: (msg: string, data?: object) => void; loadVec?: (db: Database.Database) => void }) {
    // Owner-only before SQLite opens it: SQLite creates -wal/-shm with the db file's mode.
    const onDisk = file !== ':memory:' && !file.startsWith('file:');
    if (onDisk) { fs.closeSync(fs.openSync(file, 'a', 0o600)); fs.chmodSync(file, 0o600); }
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
    this.dims = opts.dims;
    if (onDisk) for (const f of [`${file}-wal`, `${file}-shm`]) { try { fs.chmodSync(f, 0o600); } catch { /* not created yet */ } }
    if (this.dims) {
      try { (opts.loadVec ?? ((d) => sqliteVec.load(d)))(this.db); }
      catch (e) { opts.warn?.('sqlite-vec failed to load; vector search disabled (FTS only)', { error: String(e) }); this.dims = null; this.vecOff = true; }
    }
  }

  migrate(): void {
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
    const applied = new Set(this.db.prepare('SELECT version FROM schema_migrations').all().map((r: any) => r.version as number));
    SQLITE_MIGRATIONS.forEach((sql, i) => {
      const v = i + 1;
      if (applied.has(v)) return;
      this.db.transaction(() => {
        this.db.exec(sql);
        this.db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(v, new Date().toISOString());
      })();
    });
    this.ensureVecTable();
  }

  private ensureVecTable(): void {
    if (!this.dims) return;
    const cur = this.db.prepare(`SELECT v FROM vec_meta WHERE k = 'dims'`).get() as Row | undefined;
    if (cur && Number(cur.v) === this.dims) return;
    this.db.transaction(() => {
      this.db.exec('DROP TABLE IF EXISTS vec_observations');
      this.db.exec(`CREATE VIRTUAL TABLE vec_observations USING vec0(id TEXT PRIMARY KEY, project_id TEXT PARTITION KEY, embedding float[${this.dims}])`);
      this.db.exec('UPDATE observations SET embedding_model = NULL');
      this.db.prepare(`INSERT INTO vec_meta(k, v) VALUES ('dims', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`).run(String(this.dims));
    })();
  }

  close(): void { this.db.close(); }

  getOrCreateProject(key: string, name: string): Project {
    const existing = this.getProjectByKey(key);
    if (existing) return existing;
    const p: Project = { id: newId(), key, name, hubUrl: null, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO projects(id, key, name, hub_url, created_at) VALUES (?, ?, ?, NULL, ?)').run(p.id, p.key, p.name, p.createdAt);
    return p;
  }
  getProject(id: string): Project | null { const r = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined; return r ? rowToProject(r) : null; }
  getProjectByKey(key: string): Project | null { const r = this.db.prepare('SELECT * FROM projects WHERE key = ?').get(key) as Row | undefined; return r ? rowToProject(r) : null; }
  setProjectHub(id: string, hubUrl: string | null): void { this.db.prepare('UPDATE projects SET hub_url = ? WHERE id = ?').run(hubUrl, id); }

  upsertSession(s: Session): void {
    this.db.prepare(`INSERT INTO sessions(id, project_id, user_id, host, host_session_id, cwd, started_at, ended_at, synced_at, origin)
      VALUES (@id, @projectId, @userId, @host, @hostSessionId, @cwd, @startedAt, @endedAt, @syncedAt, @origin)
      ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, ended_at = COALESCE(excluded.ended_at, sessions.ended_at), synced_at = NULL
      WHERE sessions.project_id = excluded.project_id AND sessions.user_id = excluded.user_id`).run({ ...s, origin: s.origin ?? 'local' });
  }
  getSession(id: string): Session | null { const r = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined; return r ? rowToSession(r) : null; }
  getSessionByHost(host: string, hostSessionId: string): Session | null { const r = this.db.prepare('SELECT * FROM sessions WHERE host = ? AND host_session_id = ?').get(host, hostSessionId) as Row | undefined; return r ? rowToSession(r) : null; }
  endSession(id: string, endedAt: string): void { this.db.prepare('UPDATE sessions SET ended_at = ?, synced_at = NULL WHERE id = ?').run(endedAt, id); }

  insertPrompt(p: Prompt): void { this.db.prepare('INSERT INTO prompts(id, session_id, text, created_at) VALUES (?, ?, ?, ?)').run(p.id, p.sessionId, p.text, p.createdAt); }
  latestPrompt(sessionId: string): Prompt | null {
    const r = this.db.prepare('SELECT * FROM prompts WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(sessionId) as Row | undefined;
    return r ? { id: r.id, sessionId: r.session_id, text: r.text, createdAt: r.created_at } : null;
  }

  insertObservations(obs: Observation[]): void {
    const stmt = this.db.prepare(`INSERT INTO observations(id, project_id, session_id, user_id, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, created_at, embedding_model, origin, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
    this.db.transaction(() => { for (const o of obs) stmt.run(o.id, o.projectId, o.sessionId, o.userId, o.type, o.title, o.subtitle, j(o.facts), o.narrative, j(o.concepts), j(o.filesRead), j(o.filesModified), o.createdAt, o.embeddingModel, o.origin, o.syncedAt); })();
  }
  getObservations(ids: string[]): Observation[] {
    if (ids.length === 0) return [];
    const rows = this.db.prepare(`SELECT * FROM observations WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[];
    const byId = new Map(rows.map((r) => [r.id, rowToObservation(r)]));
    return ids.map((id) => byId.get(id)).filter((o): o is Observation => !!o);
  }
  resolveIdPrefix(prefix: string): string | null {
    if (prefix.length < 4) return null;
    // shortcut: suffix match scans the table, add an index on a reversed id if stores grow past ~1M rows
    const rows = this.db.prepare('SELECT id FROM observations WHERE substr(id, 1, length(?)) = ? OR substr(id, -length(?)) = ? LIMIT 2').all(prefix, prefix, prefix, prefix) as Row[];
    return rows.length === 1 ? rows[0].id : null;
  }
  listRecentObservations(projectId: string, limit: number): Observation[] {
    return (this.db.prepare('SELECT * FROM observations WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(projectId, limit) as Row[]).map(rowToObservation);
  }
  listSessionObservations(sessionId: string, limit: number): Observation[] {
    return (this.db.prepare('SELECT * FROM observations WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(sessionId, limit) as Row[]).map(rowToObservation);
  }
  searchObservationsFts(query: string, f: SearchFilters): SearchHit[] {
    const q = toFtsQuery(query); if (!q) return [];
    const w = filterSql(f, 'o');
    const rows = this.db.prepare(`SELECT o.id AS id, bm25(observations_fts) AS score FROM observations_fts JOIN observations o ON o.rowid = observations_fts.rowid
      WHERE observations_fts MATCH ? AND ${w.sql} ORDER BY score LIMIT ?`).all(q, ...w.params, f.limit) as Row[];
    return rows.map((r) => ({ id: r.id, score: -r.score }));
  }
  searchObservationsVector(vec: number[], f: SearchFilters): SearchHit[] {
    if (!this.dims || vec.length !== this.dims) return [];
    const buf = Buffer.from(new Float32Array(vec).buffer);
    const candidates = this.db.prepare(`SELECT id, distance FROM vec_observations WHERE embedding MATCH ? AND project_id = ? AND k = ? ORDER BY distance`).all(buf, f.projectId, Math.max(f.limit * 4, 50)) as Row[];
    if (candidates.length === 0) return [];
    const w = filterSql(f, 'o');
    const ids = candidates.map((c) => c.id);
    const keep = new Set((this.db.prepare(`SELECT o.id FROM observations o WHERE o.id IN (${ids.map(() => '?').join(',')}) AND ${w.sql}`).all(...ids, ...w.params) as Row[]).map((r) => r.id));
    return candidates.filter((c) => keep.has(c.id)).slice(0, f.limit).map((c) => ({ id: c.id, score: 1 / (1 + c.distance) }));
  }
  timeline(anchorId: string, before: number, after: number): Observation[] {
    const anchor = this.db.prepare('SELECT * FROM observations WHERE id = ?').get(anchorId) as Row | undefined;
    if (!anchor) return [];
    const prev = this.db.prepare('SELECT * FROM observations WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?').all(anchor.session_id, anchor.created_at, anchor.created_at, anchor.id, before) as Row[];
    const next = this.db.prepare('SELECT * FROM observations WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT ?').all(anchor.session_id, anchor.created_at, anchor.created_at, anchor.id, after) as Row[];
    return [...prev.reverse(), anchor, ...next].map(rowToObservation);
  }
  listMissingEmbedding(limit: number): Observation[] {
    return (this.db.prepare('SELECT * FROM observations WHERE embedding_model IS NULL ORDER BY created_at DESC, rowid DESC LIMIT ?').all(limit) as Row[]).map(rowToObservation);
  }
  setObservationEmbedding(id: string, vec: number[], model: string): void {
    if (this.vecOff) return; // leave unembedded so a later run with sqlite-vec working backfills
    this.db.transaction(() => {
      if (this.dims) {
        if (vec.length !== this.dims) throw new Error(`embedding dims ${vec.length} != ${this.dims}`);
        const o = this.db.prepare('SELECT project_id FROM observations WHERE id = ?').get(id) as Row | undefined;
        if (!o) return;
        this.db.prepare('DELETE FROM vec_observations WHERE id = ?').run(id);
        this.db.prepare('INSERT INTO vec_observations(id, project_id, embedding) VALUES (?, ?, ?)').run(id, o.project_id, Buffer.from(new Float32Array(vec).buffer));
      }
      this.db.prepare('UPDATE observations SET embedding_model = ? WHERE id = ?').run(model, id);
    })();
  }

  getObservationEmbeddings(ids: string[]): Map<string, number[]> {
    const out = new Map<string, number[]>();
    if (!this.dims || ids.length === 0) return out;
    for (const r of this.db.prepare(`SELECT id, embedding FROM vec_observations WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as Row[]) {
      const b: Buffer = r.embedding; out.set(r.id, Array.from(new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))));
    }
    return out;
  }

  insertSummaries(list: Summary[]): void {
    const stmt = this.db.prepare(`INSERT INTO summaries(id, project_id, session_id, user_id, request, learned, completed, next_steps, created_at, origin, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`);
    this.db.transaction(() => { for (const s of list) stmt.run(s.id, s.projectId, s.sessionId, s.userId, s.request, s.learned, s.completed, s.nextSteps, s.createdAt, s.origin, s.syncedAt); })();
  }
  listRecentSummaries(projectId: string, limit: number): Summary[] {
    return (this.db.prepare('SELECT * FROM summaries WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(projectId, limit) as Row[]).map(rowToSummary);
  }
  searchSummariesFts(query: string, f: SearchFilters): SearchHit[] {
    const q = toFtsQuery(query); if (!q) return [];
    const parts = ['s.project_id = ?']; const params: unknown[] = [f.projectId];
    if (f.userId) { parts.push('s.user_id = ?'); params.push(f.userId); }
    if (f.since) { parts.push('s.created_at >= ?'); params.push(f.since); }
    const rows = this.db.prepare(`SELECT s.id AS id, bm25(summaries_fts) AS score FROM summaries_fts JOIN summaries s ON s.rowid = summaries_fts.rowid WHERE summaries_fts MATCH ? AND ${parts.join(' AND ')} ORDER BY score LIMIT ?`).all(q, ...params, f.limit) as Row[];
    return rows.map((r) => ({ id: r.id, score: -r.score }));
  }

  listUnsynced(table: 'sessions' | 'observations' | 'summaries', projectId: string, limit: number): Array<Session | Observation | Summary> {
    const rows = this.db.prepare(`SELECT * FROM ${table} WHERE project_id = ? AND synced_at IS NULL AND origin = 'local' ORDER BY rowid LIMIT ?`).all(projectId, limit) as Row[];
    const conv: (r: Row) => Session | Observation | Summary = table === 'sessions' ? rowToSession : table === 'observations' ? rowToObservation : rowToSummary;
    return rows.map(conv);
  }
  markSynced(table: 'sessions' | 'observations' | 'summaries', ids: string[], at: string): void {
    if (ids.length === 0) return;
    this.db.prepare(`UPDATE ${table} SET synced_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(at, ...ids);
  }
  getPullCursor(projectId: string): number { const r = this.db.prepare('SELECT pull_cursor FROM sync_state WHERE project_id = ?').get(projectId) as Row | undefined; return r ? Number(r.pull_cursor) : 0; }
  setPullCursor(projectId: string, cursor: number): void { this.db.prepare('INSERT INTO sync_state(project_id, pull_cursor) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET pull_cursor = excluded.pull_cursor').run(projectId, cursor); }
  resetProjectSync(projectId: string): void {
    this.db.transaction(() => {
      for (const t of ['sessions', 'observations', 'summaries']) this.db.prepare(`UPDATE ${t} SET synced_at = NULL WHERE project_id = ? AND origin = 'local'`).run(projectId);
      this.db.prepare('INSERT INTO sync_state(project_id, pull_cursor, hub_epoch) VALUES (?, 0, NULL) ON CONFLICT(project_id) DO UPDATE SET pull_cursor = 0, hub_epoch = NULL, backoff_until = NULL, backoff_ms = NULL, strikes = 0').run(projectId);
    })();
  }
  getSyncState(projectId: string): SyncState {
    const r = this.db.prepare('SELECT * FROM sync_state WHERE project_id = ?').get(projectId) as Row | undefined;
    return r ? rowToSyncState(r) : rowToSyncState({ project_id: projectId, pull_cursor: 0 });
  }
  updateSyncState(projectId: string, patch: SyncStatePatch): void {
    const keys = (Object.keys(patch) as Array<keyof SyncStatePatch>).filter((k) => k in SYNC_COLS);
    if (!keys.length) return;
    const cols = keys.map((k) => SYNC_COLS[k]);
    this.db.prepare(`INSERT INTO sync_state(project_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})
      ON CONFLICT(project_id) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`).run(projectId, ...keys.map((k) => patch[k] ?? null));
  }
  listSyncStates(): SyncState[] { return (this.db.prepare('SELECT * FROM sync_state').all() as Row[]).map(rowToSyncState); }
  getHubEpoch(projectId: string): string | null { const r = this.db.prepare('SELECT hub_epoch FROM sync_state WHERE project_id = ?').get(projectId) as Row | undefined; return (r?.hub_epoch as string | null | undefined) ?? null; }
  setHubEpoch(projectId: string, epoch: string): void {
    this.db.prepare('INSERT INTO sync_state(project_id, pull_cursor, hub_epoch) VALUES (?, 0, ?) ON CONFLICT(project_id) DO UPDATE SET hub_epoch = excluded.hub_epoch').run(projectId, epoch);
  }
  countObservations(projectId: string): number { return Number((this.db.prepare('SELECT COUNT(*) c FROM observations WHERE project_id = ?').get(projectId) as Row).c); }
  countSessions(projectId: string): number { return Number((this.db.prepare('SELECT COUNT(*) c FROM sessions WHERE project_id = ?').get(projectId) as Row).c); }
  lastActivity(projectId: string): string | null { return ((this.db.prepare('SELECT MAX(created_at) m FROM observations WHERE project_id = ?').get(projectId) as Row).m as string | null) ?? null; }
}
