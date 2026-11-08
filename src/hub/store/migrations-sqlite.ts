export const HUB_SQLITE_MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE users (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
  CREATE TABLE api_keys (id TEXT PRIMARY KEY, user_name TEXT NOT NULL REFERENCES users(name), label TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, revoked_at TEXT);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, user_id TEXT NOT NULL, host TEXT NOT NULL, host_session_id TEXT NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT);
  CREATE TABLE observations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '',
    facts TEXT NOT NULL DEFAULT '[]', narrative TEXT NOT NULL DEFAULT '', concepts TEXT NOT NULL DEFAULT '[]', files_read TEXT NOT NULL DEFAULT '[]', files_modified TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, embedding_model TEXT, embedding BLOB);
  CREATE INDEX observations_project_time ON observations(project_id, created_at);
  CREATE VIRTUAL TABLE observations_fts USING fts5(title, subtitle, narrative, facts, concepts, content='observations', content_rowid='rowid', tokenize='unicode61');
  CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts) VALUES (new.rowid, new.title, new.subtitle, new.narrative, new.facts, new.concepts); END;
  CREATE TABLE summaries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, session_id TEXT NOT NULL, user_id TEXT NOT NULL, request TEXT NOT NULL, learned TEXT NOT NULL DEFAULT '', completed TEXT NOT NULL DEFAULT '', next_steps TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
  CREATE TABLE sync_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, tbl TEXT NOT NULL, row_id TEXT NOT NULL);
  CREATE INDEX sync_log_project ON sync_log(project_id, seq);
  `,
  // Vectors are untyped blobs here, so the dims the hub was set up for live only in this table (checked at every start).
  `CREATE TABLE hub_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
];
