CREATE TABLE upload_sessions (
  id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  target_type TEXT NOT NULL CHECK(target_type IN ('publication','idea','category','logo')),
  target_id TEXT NOT NULL,
  replace_for TEXT,
  original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
  format TEXT NOT NULL,
  file_size INTEGER NOT NULL CHECK(file_size > 0),
  width INTEGER,
  height INTEGER,
  duration REAL,
  chunk_size INTEGER NOT NULL CHECK(chunk_size > 0),
  upload_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('creating','uploading','sealing','done','canceling')),
  lease TEXT,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE upload_parts (
  upload_session_id TEXT NOT NULL REFERENCES upload_sessions(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number > 0),
  etag TEXT,
  sha256 TEXT,
  size INTEGER,
  lease TEXT,
  lease_until TEXT,
  PRIMARY KEY (upload_session_id,part_number)
);

CREATE INDEX upload_sessions_status_date_idx ON upload_sessions(status,updated_at);

CREATE TABLE preview_uploads (
  media_id TEXT PRIMARY KEY,
  storage_key TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL CHECK(size > 0),
  created_at TEXT NOT NULL
);
