import Database from 'better-sqlite3';
import { HubDimsConflict, HubDimsMismatch, type HubStoreOptions } from './types.js';
import type {
  HubApiKey,
  HubObservation,
  HubProjectInfo,
  HubStore,
  HubUserInfo,
  HubUserRemoval,
  SyncLogEntry,
} from './types.js';
import type {
  Observation,
  ObservationType,
  Project,
  SearchFilters,
  Session,
  Summary,
  Tombstone,
} from '../../store/types.js';
import { HUB_SQLITE_MIGRATIONS } from './migrations-sqlite.js';
import { toFtsQuery } from '../../store/sqlite/fts-query.js';
import { newId } from '../../shared/ids.js';

// biome-ignore lint/suspicious/noExplicitAny: ad-hoc query rows (aggregates, joins); table rows are typed by the mappers below
type Row = Record<string, any>;
interface SessionRow {
  id: string;
  project_id: string;
  user_id: string;
  host: string;
  host_session_id: string;
  started_at: string;
  ended_at: string | null;
}
interface ObservationRow {
  id: string;
  project_id: string;
  session_id: string;
  user_id: string;
  type: ObservationType;
  title: string;
  subtitle: string;
  facts: string;
  narrative: string;
  concepts: string;
  files_read: string;
  files_modified: string;
  created_at: string;
  embedding_model: string | null;
  embedding?: Buffer | null;
}
interface SummaryRow {
  id: string;
  project_id: string;
  session_id: string;
  user_id: string;
  request: string;
  learned: string;
  completed: string;
  next_steps: string;
  created_at: string;
}
interface ApiKeyRow {
  id: string;
  user_name: string;
  label: string;
  created_at: string;
  revoked_at: string | null;
}
const j = (v: unknown) => JSON.stringify(v ?? []);
const pj = (v: unknown): string[] => {
  try {
    const a = JSON.parse(String(v));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
};
const vecToBlob = (v: number[] | null) => (v ? Buffer.from(new Float32Array(v).buffer) : null);
const blobToVec = (b: Buffer | null): number[] | null =>
  b ? Array.from(new Float32Array(Uint8Array.from(b).buffer)) : null;
const rowToSession = (row: Row): Session => {
  const r = row as SessionRow;
  return {
    id: r.id,
    projectId: r.project_id,
    userId: r.user_id,
    host: r.host,
    hostSessionId: r.host_session_id,
    cwd: '',
    startedAt: r.started_at,
    endedAt: r.ended_at ?? null,
    syncedAt: null,
  };
};
const rowToObs = (row: Row): HubObservation => {
  const r = row as ObservationRow;
  return {
    id: r.id,
    projectId: r.project_id,
    sessionId: r.session_id,
    userId: r.user_id,
    type: r.type,
    title: r.title,
    subtitle: r.subtitle,
    facts: pj(r.facts),
    narrative: r.narrative,
    concepts: pj(r.concepts),
    filesRead: pj(r.files_read),
    filesModified: pj(r.files_modified),
    createdAt: r.created_at,
    embeddingModel: r.embedding_model ?? null,
    origin: 'hub',
    syncedAt: null,
    embedding: blobToVec(r.embedding ?? null),
  };
};
const rowToSummary = (row: Row): Summary => {
  const r = row as SummaryRow;
  return {
    id: r.id,
    projectId: r.project_id,
    sessionId: r.session_id,
    userId: r.user_id,
    request: r.request,
    learned: r.learned,
    completed: r.completed,
    nextSteps: r.next_steps,
    createdAt: r.created_at,
    origin: 'hub',
    syncedAt: null,
  };
};
const rowToKey = (row: Row): HubApiKey => {
  const r = row as ApiKeyRow;
  return {
    id: r.id,
    userName: r.user_name,
    label: r.label,
    createdAt: r.created_at,
    revokedAt: r.revoked_at ?? null,
  };
};
const inList = (ids: string[]) => ids.map(() => '?').join(',');
const TOMB_TABLES = { observation: 'observations', summary: 'summaries', session: 'sessions' } as const;

export class SqliteHubStore implements HubStore {
  private db: Database.Database;
  private dims: number | null;
  constructor(
    file: string,
    private opts: HubStoreOptions
  ) {
    this.dims = opts.dims;
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('foreign_keys = ON');
  }
  async migrate(): Promise<void> {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)'
    );
    const applied = new Set(
      this.db
        .prepare('SELECT version FROM schema_migrations')
        .all()
        .map((r) => (r as { version: number }).version)
    );
    HUB_SQLITE_MIGRATIONS.forEach((sql, i) => {
      if (!applied.has(i + 1))
        this.db.transaction(() => {
          this.db.exec(sql);
          this.db.prepare('INSERT INTO schema_migrations VALUES (?, ?)').run(i + 1, new Date().toISOString());
        })();
    });
    if (this.opts.checkDims !== false) this.checkDims();
  }
  // Same contract as the Postgres store. A database from before hub_meta existed is judged by a stored vector, if any.
  private checkDims(): void {
    const meta = this.db.prepare(`SELECT value FROM hub_meta WHERE key = 'embedding_dims'`).get() as Row | undefined;
    const blob = meta
      ? undefined
      : (this.db.prepare('SELECT length(embedding) n FROM observations WHERE embedding IS NOT NULL LIMIT 1').get() as
          | Row
          | undefined);
    const have = meta ? (meta.value ? Number(meta.value) : null) : blob ? Number(blob.n) / 4 : this.dims;
    const record = this.db.prepare(
      `INSERT INTO hub_meta VALUES ('embedding_dims', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    if (have !== this.dims && !this.opts.resetVectors) throw new HubDimsConflict(have, this.dims);
    this.db.transaction(() => {
      if (have !== this.dims)
        this.db.exec(
          'UPDATE observations SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL OR embedding_model IS NOT NULL'
        );
      record.run(String(this.dims ?? ''));
    })();
  }
  async close(): Promise<void> {
    this.db.close();
  }

  async getProjectByKey(key: string): Promise<Project | null> {
    const r = this.db.prepare('SELECT * FROM projects WHERE key = ?').get(key) as Row | undefined;
    return r ? { id: r.id, key: r.key, name: r.name, hubUrl: null, createdAt: r.created_at } : null;
  }
  async getOrCreateProject(key: string, name: string): Promise<Project> {
    this.db
      .prepare('INSERT INTO projects(id, key, name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO NOTHING')
      .run(newId(), key, name, new Date().toISOString());
    return (await this.getProjectByKey(key))!;
  }
  private logStmt?: Database.Statement;
  private get log(): Database.Statement {
    // biome-ignore lint/suspicious/noAssignInExpressions: lazy init with ??= is intended
    return (this.logStmt ??= this.db.prepare('INSERT INTO sync_log(project_id, tbl, row_id) VALUES (?, ?, ?)'));
  }
  async upsertSessions(rows: Session[]): Promise<string[]> {
    const newEnd = `CASE WHEN excluded.ended_at IS NULL THEN sessions.ended_at WHEN sessions.ended_at IS NULL THEN excluded.ended_at ELSE MAX(sessions.ended_at, excluded.ended_at) END`;
    const stmt =
      this.db.prepare(`INSERT INTO sessions(id, project_id, user_id, host, host_session_id, started_at, ended_at) VALUES (@id, @projectId, @userId, @host, @hostSessionId, @startedAt, @endedAt)
      ON CONFLICT(id) DO UPDATE SET ended_at = ${newEnd}
      WHERE sessions.project_id = excluded.project_id AND sessions.user_id = excluded.user_id AND sessions.ended_at IS NOT (${newEnd})`);
    const changed: string[] = [];
    this.db.transaction(() => {
      for (const r of rows) {
        if (
          stmt.run({
            id: r.id,
            projectId: r.projectId,
            userId: r.userId,
            host: r.host,
            hostSessionId: r.hostSessionId,
            startedAt: r.startedAt,
            endedAt: r.endedAt ?? null,
          }).changes
        ) {
          changed.push(r.id);
          this.log.run(r.projectId, 'sessions', r.id);
        }
      }
    })();
    return changed;
  }
  async insertObservations(rows: HubObservation[]): Promise<string[]> {
    const stmt = this.db.prepare(
      `INSERT INTO observations(id, project_id, session_id, user_id, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, created_at, embedding_model, embedding) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
    );
    const inserted: string[] = [];
    const rejected: HubObservation[] = [];
    this.db.transaction(() => {
      for (const o of rows) {
        if (this.dims !== null && o.embedding && o.embedding.length !== this.dims) {
          rejected.push(o);
          continue;
        }
        const r = stmt.run(
          o.id,
          o.projectId,
          o.sessionId,
          o.userId,
          o.type,
          o.title,
          o.subtitle,
          j(o.facts),
          o.narrative,
          j(o.concepts),
          j(o.filesRead),
          j(o.filesModified),
          o.createdAt,
          o.embeddingModel,
          vecToBlob(o.embedding)
        );
        if (r.changes) {
          inserted.push(o.id);
          this.log.run(o.projectId, 'observations', o.id);
        }
      }
    })();
    if (rejected.length)
      throw new HubDimsMismatch(
        rejected[0].id,
        this.dims!,
        rejected[0].embedding!.length,
        inserted,
        rejected.map((o) => o.id)
      );
    return inserted;
  }
  async insertSummaries(rows: Summary[]): Promise<string[]> {
    const stmt = this.db.prepare(
      `INSERT INTO summaries(id, project_id, session_id, user_id, request, learned, completed, next_steps, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`
    );
    const inserted: string[] = [];
    this.db.transaction(() => {
      for (const s of rows) {
        if (
          stmt.run(
            s.id,
            s.projectId,
            s.sessionId,
            s.userId,
            s.request,
            s.learned,
            s.completed,
            s.nextSteps,
            s.createdAt
          ).changes
        ) {
          inserted.push(s.id);
          this.log.run(s.projectId, 'summaries', s.id);
        }
      }
    })();
    return inserted;
  }
  async listSyncLog(projectId: string, sinceSeq: number, limit: number): Promise<SyncLogEntry[]> {
    return (
      this.db
        .prepare('SELECT seq, tbl, row_id FROM sync_log WHERE project_id = ? AND seq > ? ORDER BY seq LIMIT ?')
        .all(projectId, sinceSeq, limit) as Row[]
    ).map((r) => ({ seq: Number(r.seq), table: r.tbl, rowId: r.row_id }));
  }
  async applyTombstones(
    projectId: string,
    userName: string,
    rows: Tombstone[]
  ): Promise<{ applied: number; rejected: Array<{ id: string; reason: string }> }> {
    const rejected: Array<{ id: string; reason: string }> = [];
    let applied = 0;
    this.db.transaction(() => {
      for (const t of rows) {
        const r = this.db.prepare(`SELECT project_id, user_id FROM ${TOMB_TABLES[t.tbl]} WHERE id = ?`).get(t.id) as
          | Row
          | undefined;
        if (r && (r.project_id !== projectId || r.user_id !== userName)) {
          rejected.push({ id: t.id, reason: 'not_owner' });
          continue;
        }
        applied++;
        if (!r) continue;
        if (t.tbl === 'session')
          for (const c of ['observations', 'summaries'])
            this.db
              .prepare(`DELETE FROM ${c} WHERE session_id = ? AND project_id = ? AND user_id = ?`)
              .run(t.id, projectId, userName); // only the pusher's own rows, whatever references them
        this.db.prepare(`DELETE FROM ${TOMB_TABLES[t.tbl]} WHERE id = ?`).run(t.id);
        this.db
          .prepare(
            'INSERT INTO tombstones(id, tbl, project_id, user_id, deleted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING'
          )
          .run(t.id, t.tbl, projectId, userName, t.deletedAt);
        this.log.run(projectId, 'tombstone', t.id);
      }
    })();
    return { applied, rejected };
  }
  async tombstoned(projectId: string, tbl: Tombstone['tbl'], ids: string[]): Promise<Set<string>> {
    return new Set(
      ids.length
        ? (
            this.db
              .prepare(`SELECT id FROM tombstones WHERE project_id = ? AND tbl = ? AND id IN (${inList(ids)})`)
              .all(projectId, tbl, ...ids) as Row[]
          ).map((r) => r.id)
        : []
    );
  }
  async getTombstones(projectId: string, ids: string[]): Promise<Tombstone[]> {
    return ids.length
      ? (
          this.db
            .prepare(`SELECT id, tbl, deleted_at FROM tombstones WHERE project_id = ? AND id IN (${inList(ids)})`)
            .all(projectId, ...ids) as Row[]
        ).map((r) => ({ id: r.id, tbl: r.tbl, deletedAt: r.deleted_at }))
      : [];
  }
  async maxSeq(projectId: string): Promise<number> {
    return Number(
      (this.db.prepare('SELECT COALESCE(MAX(seq), 0) m FROM sync_log WHERE project_id = ?').get(projectId) as Row).m
    );
  }
  async getSessions(ids: string[]): Promise<Session[]> {
    return ids.length
      ? (this.db.prepare(`SELECT * FROM sessions WHERE id IN (${inList(ids)})`).all(...ids) as Row[]).map(rowToSession)
      : [];
  }
  async getObservations(ids: string[]): Promise<HubObservation[]> {
    if (!ids.length) return [];
    const by = new Map(
      (this.db.prepare(`SELECT * FROM observations WHERE id IN (${inList(ids)})`).all(...ids) as Row[]).map((r) => [
        r.id,
        rowToObs(r),
      ])
    );
    return ids.map((id) => by.get(id)).filter((o): o is HubObservation => !!o);
  }
  async getSummaries(ids: string[]): Promise<Summary[]> {
    return ids.length
      ? (this.db.prepare(`SELECT * FROM summaries WHERE id IN (${inList(ids)})`).all(...ids) as Row[]).map(rowToSummary)
      : [];
  }
  async searchObservationsFts(query: string, f: SearchFilters): Promise<Observation[]> {
    const q = toFtsQuery(query);
    if (!q) return [];
    const parts = ['o.project_id = ?'];
    const params: unknown[] = [f.projectId];
    if (f.type) {
      parts.push('o.type = ?');
      params.push(f.type);
    }
    if (f.userId) {
      parts.push('o.user_id = ?');
      params.push(f.userId);
    }
    if (f.since) {
      parts.push('o.created_at >= ?');
      params.push(f.since);
    }
    const rows = this.db
      .prepare(
        `SELECT o.id, o.project_id, o.session_id, o.user_id, o.type, o.title, o.subtitle, o.facts, o.narrative, o.concepts, o.files_read, o.files_modified, o.created_at, o.embedding_model FROM observations_fts JOIN observations o ON o.rowid = observations_fts.rowid WHERE observations_fts MATCH ? AND ${parts.join(' AND ')} ORDER BY bm25(observations_fts) LIMIT ?`
      )
      .all(q, ...params, f.limit) as Row[];
    return rows.map((r) => {
      const { embedding: _e, ...rest } = rowToObs(r);
      return rest;
    });
  }
  async countUsers(): Promise<number> {
    return Number((this.db.prepare('SELECT COUNT(*) c FROM users').get() as Row).c);
  }
  async createUser(name: string): Promise<void> {
    this.db
      .prepare('INSERT INTO users(name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING')
      .run(name, new Date().toISOString());
  }
  async createApiKey(userName: string, label: string, keyHash: string): Promise<HubApiKey> {
    const k: HubApiKey = { id: newId(), userName, label, createdAt: new Date().toISOString(), revokedAt: null };
    this.db
      .prepare('INSERT INTO api_keys(id, user_name, label, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(k.id, userName, label, keyHash, k.createdAt);
    return k;
  }
  async listApiKeys(): Promise<HubApiKey[]> {
    return (this.db.prepare('SELECT * FROM api_keys ORDER BY created_at').all() as Row[]).map(rowToKey);
  }
  async revokeApiKey(id: string): Promise<boolean> {
    return (
      this.db
        .prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(new Date().toISOString(), id).changes > 0
    );
  }
  async rotateApiKey(id: string, newHash: string): Promise<HubApiKey | null> {
    return this.db.transaction((): HubApiKey | null => {
      const old = this.db
        .prepare('SELECT user_name, label FROM api_keys WHERE id = ? AND revoked_at IS NULL')
        .get(id) as Row | undefined;
      if (!old) return null;
      const now = new Date().toISOString();
      this.db.prepare('UPDATE api_keys SET revoked_at = ? WHERE id = ?').run(now, id);
      const k: HubApiKey = { id: newId(), userName: old.user_name, label: old.label, createdAt: now, revokedAt: null };
      this.db
        .prepare('INSERT INTO api_keys(id, user_name, label, key_hash, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(k.id, k.userName, k.label, newHash, k.createdAt);
      return k;
    })();
  }
  async listUsers(): Promise<HubUserInfo[]> {
    // MAX(a, b) is NULL if either is NULL in SQLite, hence the '' stand-ins
    return (
      this.db
        .prepare(`SELECT u.name, u.created_at,
      (SELECT COUNT(*) FROM api_keys k WHERE k.user_name = u.name AND k.revoked_at IS NULL) AS active_keys,
      (SELECT COUNT(*) FROM observations o WHERE o.user_id = u.name) AS observations,
      NULLIF(MAX(COALESCE((SELECT MAX(COALESCE(s.ended_at, s.started_at)) FROM sessions s WHERE s.user_id = u.name), ''), COALESCE((SELECT MAX(o.created_at) FROM observations o WHERE o.user_id = u.name), '')), '') AS last_seen
      FROM users u ORDER BY u.name`)
        .all() as Row[]
    ).map((r) => ({
      name: r.name,
      createdAt: r.created_at,
      activeKeys: Number(r.active_keys),
      observations: Number(r.observations),
      lastSeen: r.last_seen ?? null,
    }));
  }
  async removeUser(name: string): Promise<HubUserRemoval | null> {
    if (!this.db.prepare('SELECT 1 FROM users WHERE name = ?').get(name)) return null;
    const revoked = this.db
      .prepare('UPDATE api_keys SET revoked_at = ? WHERE user_name = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), name).changes;
    const r = this.db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM observations WHERE user_id = @n) o, (SELECT COUNT(*) FROM sessions WHERE user_id = @n) s, (SELECT COUNT(*) FROM summaries WHERE user_id = @n) m`
      )
      .get({ n: name }) as Row;
    return { revokedKeys: revoked, observations: Number(r.o), sessions: Number(r.s), summaries: Number(r.m) };
  }
  async listProjects(): Promise<HubProjectInfo[]> {
    return (
      this.db
        .prepare(`SELECT p.key, p.name, p.created_at,
      (SELECT COUNT(*) FROM observations o WHERE o.project_id = p.id) AS observations, (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions,
      (SELECT COUNT(*) FROM summaries m WHERE m.project_id = p.id) AS summaries, (SELECT MAX(o.created_at) FROM observations o WHERE o.project_id = p.id) AS last_activity
      FROM projects p ORDER BY p.key`)
        .all() as Row[]
    ).map((r) => ({
      key: r.key,
      name: r.name,
      createdAt: r.created_at,
      observations: Number(r.observations),
      sessions: Number(r.sessions),
      summaries: Number(r.summaries),
      lastActivity: r.last_activity ?? null,
    }));
  }
  async authenticate(keyHash: string): Promise<{ keyId: string; userName: string } | null> {
    const r = this.db
      .prepare('SELECT id, user_name FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL')
      .get(keyHash) as Row | undefined;
    return r ? { keyId: r.id, userName: r.user_name } : null;
  }
}
