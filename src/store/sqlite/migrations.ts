export const SQLITE_MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL, hub_url TEXT, created_at TEXT NOT NULL);
  CREATE TABLE sessions (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), user_id TEXT NOT NULL, host TEXT NOT NULL,
    host_session_id TEXT NOT NULL, cwd TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, synced_at TEXT);
  CREATE UNIQUE INDEX sessions_host ON sessions(host, host_session_id);
  CREATE INDEX sessions_project ON sessions(project_id, started_at);
  CREATE TABLE prompts (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), text TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX prompts_session ON prompts(session_id, created_at);
  CREATE TABLE observations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL, user_id TEXT NOT NULL,
    type TEXT NOT NULL, title TEXT NOT NULL, subtitle TEXT NOT NULL DEFAULT '', facts TEXT NOT NULL DEFAULT '[]', narrative TEXT NOT NULL DEFAULT '',
    concepts TEXT NOT NULL DEFAULT '[]', files_read TEXT NOT NULL DEFAULT '[]', files_modified TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, embedding_model TEXT, origin TEXT NOT NULL DEFAULT 'local', synced_at TEXT);
  CREATE INDEX observations_project_time ON observations(project_id, created_at);
  CREATE INDEX observations_session_time ON observations(session_id, created_at);
  CREATE INDEX observations_unsynced ON observations(project_id, synced_at);
  CREATE VIRTUAL TABLE observations_fts USING fts5(title, subtitle, narrative, facts, concepts, content='observations', content_rowid='rowid', tokenize='unicode61');
  CREATE TRIGGER observations_ai AFTER INSERT ON observations BEGIN
    INSERT INTO observations_fts(rowid, title, subtitle, narrative, facts, concepts) VALUES (new.rowid, new.title, new.subtitle, new.narrative, new.facts, new.concepts); END;
  CREATE TRIGGER observations_ad AFTER DELETE ON observations BEGIN
    INSERT INTO observations_fts(observations_fts, rowid, title, subtitle, narrative, facts, concepts) VALUES ('delete', old.rowid, old.title, old.subtitle, old.narrative, old.facts, old.concepts); END;
  CREATE TABLE summaries (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), session_id TEXT NOT NULL, user_id TEXT NOT NULL,
    request TEXT NOT NULL, learned TEXT NOT NULL DEFAULT '', completed TEXT NOT NULL DEFAULT '', next_steps TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, origin TEXT NOT NULL DEFAULT 'local', synced_at TEXT);
  CREATE INDEX summaries_project_time ON summaries(project_id, created_at);
  CREATE VIRTUAL TABLE summaries_fts USING fts5(request, learned, completed, next_steps, content='summaries', content_rowid='rowid', tokenize='unicode61');
  CREATE TRIGGER summaries_ai AFTER INSERT ON summaries BEGIN
    INSERT INTO summaries_fts(rowid, request, learned, completed, next_steps) VALUES (new.rowid, new.request, new.learned, new.completed, new.next_steps); END;
  CREATE TABLE sync_state (project_id TEXT PRIMARY KEY, pull_cursor INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE vec_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `,
  // 2: sessions get an origin so pulled sessions are never pushed back under the local user. Existing pulled sessions are
  // recognized by having only hub-origin rows.
  `
  ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'local';
  UPDATE sessions SET origin = 'hub'
    WHERE EXISTS (SELECT 1 FROM observations o WHERE o.session_id = sessions.id AND o.origin = 'hub' UNION ALL SELECT 1 FROM summaries m WHERE m.session_id = sessions.id AND m.origin = 'hub')
      AND NOT EXISTS (SELECT 1 FROM observations o WHERE o.session_id = sessions.id AND o.origin = 'local' UNION ALL SELECT 1 FROM summaries m WHERE m.session_id = sessions.id AND m.origin = 'local');
  `,
  // 3: the hub epoch (hub project id) last seen per project, to detect a recreated hub that already grew past our cursor.
  `
  ALTER TABLE sync_state ADD COLUMN hub_epoch TEXT;
  `,
  // 4: push/pull backoff and last outcome survive a daemon restart (epoch ms; backoff_ms is the current step of the ladder).
  `
  ALTER TABLE sync_state ADD COLUMN backoff_until INTEGER;
  ALTER TABLE sync_state ADD COLUMN backoff_ms INTEGER;
  ALTER TABLE sync_state ADD COLUMN strikes INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sync_state ADD COLUMN last_error TEXT;
  ALTER TABLE sync_state ADD COLUMN last_push_at INTEGER;
  ALTER TABLE sync_state ADD COLUMN last_pull_at INTEGER;
  `,
  // 5: push attempts per row (rows a hub keeps refusing for size are given up after a bound), when last_error happened, and a
  // quarantine for pulled rows that could not be stored, so they are kept (bounded) instead of lost behind the cursor.
  `
  ALTER TABLE sessions ADD COLUMN push_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE observations ADD COLUMN push_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE summaries ADD COLUMN push_attempts INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE sync_state ADD COLUMN last_error_at INTEGER;
  CREATE TABLE sync_quarantine (id TEXT NOT NULL, tbl TEXT NOT NULL, project_id TEXT NOT NULL, seq INTEGER NOT NULL, reason TEXT NOT NULL, raw TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE INDEX sync_quarantine_project ON sync_quarantine(project_id);
  `,
];
