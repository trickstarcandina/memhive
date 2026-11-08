import { Pool, type PoolClient } from 'pg';
import { HubDimsConflict, HubDimsMismatch, type HubStoreOptions } from './types.js';
import type { HubApiKey, HubObservation, HubProjectInfo, HubStore, HubUserInfo, HubUserRemoval, SyncLogEntry, SyncTable } from './types.js';
import type { Observation, Project, SearchFilters, Session, Summary } from '../../store/types.js';
import { assertValidDims, hubPgMigrations } from './migrations-pg.js';
import { newId } from '../../shared/ids.js';

type Row = Record<string, any>;
const iso = (v: any): string => (v instanceof Date ? v.toISOString() : String(v));
const isoOrNull = (v: any): string | null => (v == null ? null : iso(v));
const arr = (v: any): string[] => (Array.isArray(v) ? v : []);
/** Thrown before any write when a vector holds NaN/Infinity. */
export class HubInvalidVector extends Error {
  constructor(public rowId: string) { super(`invalid_embedding: row ${rowId} has a non-finite value`); this.name = 'HubInvalidVector'; }
}
const parseVec = (v: any): number[] | null => (v == null ? null : typeof v === 'string' ? JSON.parse(v) : Array.isArray(v) ? v : null);
const rowToSession = (r: Row): Session => ({ id: r.id, projectId: r.project_id, userId: r.user_id, host: r.host, hostSessionId: r.host_session_id, cwd: r.cwd, startedAt: iso(r.started_at), endedAt: isoOrNull(r.ended_at), syncedAt: null });
const rowToObs = (r: Row): HubObservation => ({ id: r.id, projectId: r.project_id, sessionId: r.session_id, userId: r.user_id, type: r.type, title: r.title, subtitle: r.subtitle, facts: arr(r.facts), narrative: r.narrative, concepts: arr(r.concepts), filesRead: arr(r.files_read), filesModified: arr(r.files_modified), createdAt: iso(r.created_at), embeddingModel: r.embedding_model ?? null, origin: 'hub', syncedAt: null, embedding: parseVec(r.embedding) });
const rowToSummary = (r: Row): Summary => ({ id: r.id, projectId: r.project_id, sessionId: r.session_id, userId: r.user_id, request: r.request, learned: r.learned, completed: r.completed, nextSteps: r.next_steps, createdAt: iso(r.created_at), origin: 'hub', syncedAt: null });
const rowToKey = (r: Row): HubApiKey => ({ id: r.id, userName: r.user_name, label: r.label, createdAt: iso(r.created_at), revokedAt: isoOrNull(r.revoked_at) });

/** to_tsquery-safe: tokens joined with & */
export function toTsQuery(text: string): string {
  const tokens = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16);
  return tokens.map((t) => `'${t.replace(/'/g, "''")}'`).join(' & ');
}

export class PostgresHubStore implements HubStore {
  private pool: Pool;
  constructor(databaseUrl: string, private opts: HubStoreOptions) {
    assertValidDims(opts.dims);
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
    // idle-client errors (e.g. server restart) would otherwise crash the process; never log the URL
    this.pool.on('error', (e) => console.error(`[memhive-hub] postgres pool error: ${e.message}`));
  }
  private async q(sql: string, params: unknown[] = []): Promise<Row[]> { return (await this.pool.query(sql, params)).rows; }

  async migrate(): Promise<void> {
    const c = await this.pool.connect(); let dead: Error | undefined;
    try {
      await c.query('SELECT pg_advisory_lock(7346001)'); // two hubs booting together must not race on DDL
      await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL)');
      const applied = new Set((await c.query('SELECT version FROM schema_migrations')).rows.map((r) => Number(r.version)));
      const migrations = hubPgMigrations(this.opts.dims);
      for (let i = 0; i < migrations.length; i++) {
        if (applied.has(i + 1)) continue;
        try { await c.query('BEGIN'); await c.query(migrations[i]); await c.query('INSERT INTO schema_migrations VALUES ($1, now())', [i + 1]); await c.query('COMMIT'); }
        catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      }
      await this.checkDims(c);
    } finally { await c.query('SELECT pg_advisory_unlock(7346001)').catch((e) => { dead = e; }); c.release(dead); }   // a broken client is destroyed, not pooled
  }
  // The vector column type is fixed when the table is created; a later MEMHIVE_EMBED_DIMS change would make every insert with
  // a vector fail in the DB (a 500 the client retries forever), so a conflict stops the hub here instead.
  private async checkDims(c: PoolClient): Promise<void> {
    const want = this.opts.dims;
    const { rows: [col] } = await c.query(`SELECT format_type(atttypid, atttypmod) AS t, atttypmod AS m FROM pg_attribute WHERE attrelid = 'observations'::regclass AND attname = 'embedding'`);
    const have = String(col.t).startsWith('vector') && col.m > 0 ? Number(col.m) : null;
    if (have !== want) {
      if (!this.opts.resetVectors) throw new HubDimsConflict(have, want);
      try {
        await c.query('BEGIN');
        await c.query(`ALTER TABLE observations DROP COLUMN embedding, ADD COLUMN embedding ${want ? `vector(${want})` : 'real[]'}`);
        await c.query('UPDATE observations SET embedding_model = NULL WHERE embedding_model IS NOT NULL');
        await c.query(`INSERT INTO hub_meta VALUES ('embedding_dims', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(want ?? '')]);
        await c.query('COMMIT');
      } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
      return;
    }
    await c.query(`INSERT INTO hub_meta VALUES ('embedding_dims', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [String(want ?? '')]);
  }
  async close(): Promise<void> { await this.pool.end(); }

  async getProjectByKey(key: string): Promise<Project | null> { const [r] = await this.q('SELECT * FROM projects WHERE key = $1', [key]); return r ? { id: r.id, key: r.key, name: r.name, hubUrl: null, createdAt: iso(r.created_at) } : null; }
  async getOrCreateProject(key: string, name: string): Promise<Project> {
    await this.q('INSERT INTO projects(id, key, name, created_at) VALUES ($1, $2, $3, now()) ON CONFLICT (key) DO NOTHING', [newId(), key, name]);
    return (await this.getProjectByKey(key))!;
  }
  // Writes to one project are serialized (lock held to commit). sync_log.seq is assigned at insert, so without this a later
  // transaction could commit a higher seq before an earlier one commits a lower seq, and a puller advancing its cursor
  // past the higher seq would skip the lower one forever. Locks are taken in hash order (the lock key), not id order, so
  // two ids whose hashes collide cannot make two transactions take the same locks in opposite order.
  private async tx<T>(projectIds: string[], fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect(); let dead: Error | undefined;
    try {
      await c.query('BEGIN');
      const { rows } = await c.query('SELECT DISTINCT hashtext(id) AS h FROM unnest($1::text[]) AS id ORDER BY h', [projectIds]);
      for (const r of rows) await c.query('SELECT pg_advisory_xact_lock($1::int)', [r.h]);
      const out = await fn(c); await c.query('COMMIT'); return out;
    } catch (e) { await c.query('ROLLBACK').catch((re) => { dead = re; }); throw e; } finally { c.release(dead); }
  }
  // One statement per batch: the project lock is held for a few round trips, not one per row. Rows are logged in input order
  // (WITH ORDINALITY), so seq order matches what the caller passed whatever order RETURNING uses.
  private async log(c: PoolClient, table: SyncTable, rows: Array<{ id: string; projectId: string }>): Promise<void> {
    if (!rows.length) return;
    await c.query('INSERT INTO sync_log(project_id, tbl, row_id) SELECT p, $2, r FROM unnest($1::uuid[], $3::uuid[]) WITH ORDINALITY AS t(p, r, n) ORDER BY n', [rows.map((r) => r.projectId), table, rows.map((r) => r.id)]);
  }
  /** Input rows whose id came back from RETURNING, first occurrence only, in input order. */
  private static written<T extends { id: string }>(rows: T[], returned: Array<{ id: string }>): T[] {
    const ids = new Set(returned.map((r) => r.id)); return rows.filter((r) => ids.delete(r.id));
  }

  async upsertSessions(rows: Session[]): Promise<string[]> {
    if (!rows.length) return [];
    const newEnd = 'GREATEST(sessions.ended_at, EXCLUDED.ended_at)'; // GREATEST ignores NULLs
    // ON CONFLICT DO UPDATE cannot touch a row twice in one statement: the last copy of an id wins, as a row-by-row upsert would
    const uniq = [...new Map(rows.map((r) => [r.id, r])).values()];
    return this.tx(uniq.map((r) => r.projectId), async (c) => {
      const { rows: ret } = await c.query(`INSERT INTO sessions(id, project_id, user_id, host, host_session_id, cwd, started_at, ended_at)
        SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::text[], $6::text[], $7::timestamptz[], $8::timestamptz[])
        ON CONFLICT (id) DO UPDATE SET ended_at = ${newEnd}, cwd = EXCLUDED.cwd
        WHERE sessions.project_id = EXCLUDED.project_id AND sessions.user_id = EXCLUDED.user_id AND (sessions.cwd IS DISTINCT FROM EXCLUDED.cwd OR sessions.ended_at IS DISTINCT FROM ${newEnd}) RETURNING id`,
        [uniq.map((s) => s.id), uniq.map((s) => s.projectId), uniq.map((s) => s.userId), uniq.map((s) => s.host), uniq.map((s) => s.hostSessionId), uniq.map((s) => s.cwd), uniq.map((s) => s.startedAt), uniq.map((s) => s.endedAt)]);
      const changed = PostgresHubStore.written(uniq, ret); await this.log(c, 'sessions', changed);
      return changed.map((s) => s.id);
    });
  }
  async insertObservations(rows: HubObservation[]): Promise<string[]> {
    for (const o of rows) if (o.embedding && !o.embedding.every(Number.isFinite)) throw new HubInvalidVector(o.id);
    const dims = this.opts.dims;
    const rejected = rows.filter((o) => dims !== null && o.embedding && o.embedding.length !== dims);
    const ok = rows.filter((o) => !rejected.includes(o));
    const inserted = !ok.length ? [] : await this.tx(ok.map((r) => r.projectId), async (c) => {
      const col = <K extends keyof HubObservation>(k: K) => ok.map((o) => o[k]);
      const json = (k: 'facts' | 'concepts' | 'filesRead' | 'filesModified') => ok.map((o) => JSON.stringify(o[k]));
      // vectors travel as text and are cast per row: pgvector parses '[1,2]', real[] parses '{1,2}'
      const vecs = ok.map((o) => (o.embedding ? (dims ? `[${o.embedding.join(',')}]` : `{${o.embedding.join(',')}}`) : null));
      const { rows: ret } = await c.query(`INSERT INTO observations(id, project_id, session_id, user_id, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, created_at, embedding_model, embedding)
        SELECT id, project_id, session_id, user_id, type, title, subtitle, facts::jsonb, narrative, concepts::jsonb, files_read::jsonb, files_modified::jsonb, created_at, embedding_model, embedding::${dims ? 'vector' : 'real[]'}
        FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[], $12::text[], $13::timestamptz[], $14::text[], $15::text[])
          AS t(id, project_id, session_id, user_id, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, created_at, embedding_model, embedding)
        ON CONFLICT (id) DO NOTHING RETURNING id`,
        [col('id'), col('projectId'), col('sessionId'), col('userId'), col('type'), col('title'), col('subtitle'), json('facts'), col('narrative'), json('concepts'), json('filesRead'), json('filesModified'), col('createdAt'), col('embeddingModel'), vecs]);
      const done = PostgresHubStore.written(ok, ret); await this.log(c, 'observations', done);
      return done.map((o) => o.id);
    });
    if (rejected.length) throw new HubDimsMismatch(rejected[0].id, dims!, rejected[0].embedding!.length, inserted, rejected.map((o) => o.id));
    return inserted;
  }
  async insertSummaries(rows: Summary[]): Promise<string[]> {
    if (!rows.length) return [];
    return this.tx(rows.map((r) => r.projectId), async (c) => {
      const col = <K extends keyof Summary>(k: K) => rows.map((s) => s[k]);
      const { rows: ret } = await c.query(`INSERT INTO summaries(id, project_id, session_id, user_id, request, learned, completed, next_steps, created_at)
        SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::timestamptz[]) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [col('id'), col('projectId'), col('sessionId'), col('userId'), col('request'), col('learned'), col('completed'), col('nextSteps'), col('createdAt')]);
      const done = PostgresHubStore.written(rows, ret); await this.log(c, 'summaries', done);
      return done.map((s) => s.id);
    });
  }
  async listSyncLog(projectId: string, sinceSeq: number, limit: number): Promise<SyncLogEntry[]> {
    return (await this.q('SELECT seq, tbl, row_id FROM sync_log WHERE project_id = $1 AND seq > $2 ORDER BY seq LIMIT $3', [projectId, sinceSeq, limit])).map((r) => ({ seq: Number(r.seq), table: r.tbl, rowId: r.row_id }));
  }
  async maxSeq(projectId: string): Promise<number> { const [r] = await this.q('SELECT COALESCE(MAX(seq), 0) m FROM sync_log WHERE project_id = $1', [projectId]); return Number(r.m); }
  async getSessions(ids: string[]): Promise<Session[]> { return ids.length ? (await this.q('SELECT * FROM sessions WHERE id = ANY($1::uuid[])', [ids])).map(rowToSession) : []; }
  async getObservations(ids: string[]): Promise<HubObservation[]> {
    if (!ids.length) return [];
    const by = new Map((await this.q('SELECT *, to_json(embedding) AS embedding FROM observations WHERE id = ANY($1::uuid[])', [ids])).map((r) => [r.id, rowToObs(r)]));
    return ids.map((id) => by.get(id)).filter((o): o is HubObservation => !!o);
  }
  async getSummaries(ids: string[]): Promise<Summary[]> { return ids.length ? (await this.q('SELECT * FROM summaries WHERE id = ANY($1::uuid[])', [ids])).map(rowToSummary) : []; }
  async searchObservationsFts(query: string, f: SearchFilters): Promise<Observation[]> {
    const tsq = toTsQuery(query); if (!tsq) return [];
    const parts = ['project_id = $2', "tsv @@ to_tsquery('simple', $1)"]; const params: unknown[] = [tsq, f.projectId];
    if (f.type) { params.push(f.type); parts.push(`type = $${params.length}`); }
    if (f.userId) { params.push(f.userId); parts.push(`user_id = $${params.length}`); }
    if (f.since) { params.push(f.since); parts.push(`created_at >= $${params.length}`); }
    params.push(f.limit);
    const rows = await this.q(`SELECT id, project_id, session_id, user_id, type, title, subtitle, facts, narrative, concepts, files_read, files_modified, created_at, embedding_model, NULL AS embedding FROM observations WHERE ${parts.join(' AND ')} ORDER BY ts_rank(tsv, to_tsquery('simple', $1)) DESC LIMIT $${params.length}`, params);
    return rows.map((r) => { const { embedding: _e, ...rest } = rowToObs(r); return rest; });
  }
  async countUsers(): Promise<number> { const [r] = await this.q('SELECT COUNT(*) c FROM users'); return Number(r.c); }
  async createUser(name: string): Promise<void> { await this.q('INSERT INTO users(name, created_at) VALUES ($1, now()) ON CONFLICT DO NOTHING', [name]); }
  async createApiKey(userName: string, label: string, keyHash: string): Promise<HubApiKey> {
    const id = newId();
    const [r] = await this.q('INSERT INTO api_keys(id, user_name, label, key_hash, created_at) VALUES ($1, $2, $3, $4, now()) RETURNING *', [id, userName, label, keyHash]);
    return rowToKey(r);
  }
  async listApiKeys(): Promise<HubApiKey[]> { return (await this.q('SELECT * FROM api_keys ORDER BY created_at')).map(rowToKey); }
  async revokeApiKey(id: string): Promise<boolean> { return (await this.pool.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id])).rowCount! > 0; }
  async rotateApiKey(id: string, newHash: string): Promise<HubApiKey | null> {
    const c = await this.pool.connect(); let dead: Error | undefined;
    try {
      await c.query('BEGIN');
      const { rows: [old] } = await c.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING user_name, label', [id]);
      if (!old) { await c.query('ROLLBACK'); return null; }
      const { rows: [r] } = await c.query('INSERT INTO api_keys(id, user_name, label, key_hash, created_at) VALUES ($1, $2, $3, $4, now()) RETURNING *', [newId(), old.user_name, old.label, newHash]);
      await c.query('COMMIT'); return rowToKey(r);
    } catch (e) { await c.query('ROLLBACK').catch((re) => { dead = re; }); throw e; } finally { c.release(dead); }
  }
  async listUsers(): Promise<HubUserInfo[]> {
    return (await this.q(`SELECT u.name, u.created_at,
      (SELECT COUNT(*) FROM api_keys k WHERE k.user_name = u.name AND k.revoked_at IS NULL) AS active_keys,
      (SELECT COUNT(*) FROM observations o WHERE o.user_id = u.name) AS observations,
      GREATEST((SELECT MAX(COALESCE(s.ended_at, s.started_at)) FROM sessions s WHERE s.user_id = u.name), (SELECT MAX(o.created_at) FROM observations o WHERE o.user_id = u.name)) AS last_seen
      FROM users u ORDER BY u.name`)).map((r) => ({ name: r.name, createdAt: iso(r.created_at), activeKeys: Number(r.active_keys), observations: Number(r.observations), lastSeen: isoOrNull(r.last_seen) }));
  }
  async removeUser(name: string): Promise<HubUserRemoval | null> {
    const [u] = await this.q('SELECT name FROM users WHERE name = $1', [name]); if (!u) return null;
    const revoked = (await this.pool.query('UPDATE api_keys SET revoked_at = now() WHERE user_name = $1 AND revoked_at IS NULL', [name])).rowCount ?? 0;
    const [r] = await this.q(`SELECT (SELECT COUNT(*) FROM observations WHERE user_id = $1) o, (SELECT COUNT(*) FROM sessions WHERE user_id = $1) s, (SELECT COUNT(*) FROM summaries WHERE user_id = $1) m`, [name]);
    return { revokedKeys: revoked, observations: Number(r.o), sessions: Number(r.s), summaries: Number(r.m) };
  }
  async listProjects(): Promise<HubProjectInfo[]> {
    return (await this.q(`SELECT p.key, p.name, p.created_at,
      (SELECT COUNT(*) FROM observations o WHERE o.project_id = p.id) AS observations, (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions,
      (SELECT COUNT(*) FROM summaries m WHERE m.project_id = p.id) AS summaries, (SELECT MAX(o.created_at) FROM observations o WHERE o.project_id = p.id) AS last_activity
      FROM projects p ORDER BY p.key`)).map((r) => ({ key: r.key, name: r.name, createdAt: iso(r.created_at), observations: Number(r.observations), sessions: Number(r.sessions), summaries: Number(r.summaries), lastActivity: isoOrNull(r.last_activity) }));
  }
  async authenticate(keyHash: string): Promise<{ keyId: string; userName: string } | null> {
    const [r] = await this.q('SELECT id, user_name FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL', [keyHash]);
    return r ? { keyId: r.id, userName: r.user_name } : null;
  }
}
