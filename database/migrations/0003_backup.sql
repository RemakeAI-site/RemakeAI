CREATE TABLE import_sessions (
  id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','committing','finished','cancelled'))
);
CREATE UNIQUE INDEX import_only_one ON import_sessions((1)) WHERE status IN ('pending','committing');
CREATE TABLE import_rows (
  session_id TEXT NOT NULL REFERENCES import_sessions(id) ON DELETE CASCADE,
  table_name TEXT NOT NULL, row_key TEXT NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
  PRIMARY KEY(session_id,table_name,row_key)
);
CREATE TABLE import_objects (
  session_id TEXT NOT NULL REFERENCES import_sessions(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL, staged_key TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, expected_hash TEXT, mime TEXT NOT NULL,
  upload_id TEXT, parts TEXT NOT NULL DEFAULT '[]', checked INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id,storage_key)
);
