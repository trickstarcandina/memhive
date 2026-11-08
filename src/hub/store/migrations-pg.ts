/** dims is interpolated into DDL, so it must be a plain integer. */
export function assertValidDims(dims: number | null): void {
  if (dims !== null && !(Number.isInteger(dims) && dims >= 1 && dims <= 16000)) throw new Error(`invalid embedding dims: ${String(dims)}`);
}

export function hubPgMigrations(dims: number | null): string[] {
  assertValidDims(dims);
  const vec = dims ? `embedding vector(${dims})` : 'embedding real[]';
  return [
    `
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE TABLE projects (id uuid PRIMARY KEY, key text NOT NULL UNIQUE, name text NOT NULL, created_at timestamptz NOT NULL);
    CREATE TABLE users (name text PRIMARY KEY, created_at timestamptz NOT NULL);
    CREATE TABLE api_keys (id uuid PRIMARY KEY, user_name text NOT NULL REFERENCES users(name), label text NOT NULL, key_hash text NOT NULL UNIQUE, created_at timestamptz NOT NULL, revoked_at timestamptz);
    CREATE TABLE sessions (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), user_id text NOT NULL, host text NOT NULL, host_session_id text NOT NULL, cwd text NOT NULL, started_at timestamptz NOT NULL, ended_at timestamptz);
    CREATE TABLE observations (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), session_id uuid NOT NULL, user_id text NOT NULL, type text NOT NULL, title text NOT NULL, subtitle text NOT NULL DEFAULT '',
      facts jsonb NOT NULL DEFAULT '[]', narrative text NOT NULL DEFAULT '', concepts jsonb NOT NULL DEFAULT '[]', files_read jsonb NOT NULL DEFAULT '[]', files_modified jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL, embedding_model text, ${vec},
      tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', title || ' ' || subtitle || ' ' || narrative || ' ' || facts::text || ' ' || concepts::text)) STORED);
    CREATE INDEX observations_project_time ON observations(project_id, created_at);
    CREATE INDEX observations_tsv ON observations USING gin(tsv);
    CREATE TABLE summaries (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id), session_id uuid NOT NULL, user_id text NOT NULL, request text NOT NULL, learned text NOT NULL DEFAULT '', completed text NOT NULL DEFAULT '', next_steps text NOT NULL DEFAULT '', created_at timestamptz NOT NULL);
    CREATE TABLE sync_log (seq bigserial PRIMARY KEY, project_id uuid NOT NULL, tbl text NOT NULL, row_id uuid NOT NULL);
    CREATE INDEX sync_log_project ON sync_log(project_id, seq);
    `,
    // Records the embedding dims the hub was set up for (checked at every start, see migrate()).
    `CREATE TABLE hub_meta (key text PRIMARY KEY, value text NOT NULL);`,
  ];
}
