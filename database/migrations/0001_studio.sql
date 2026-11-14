CREATE TABLE media_assets (
  id TEXT PRIMARY KEY, storage_key TEXT NOT NULL UNIQUE, original_filename TEXT NOT NULL,
  mime_type TEXT NOT NULL, format TEXT NOT NULL, file_size INTEGER NOT NULL CHECK(file_size > 0),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64), media_type TEXT NOT NULL CHECK(media_type IN ('image','video')),
  width INTEGER, height INTEGER, duration REAL, preview_storage_key TEXT UNIQUE, preview_size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE TABLE categories (
  id TEXT PRIMARY KEY, parent_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
  cover_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL, icon TEXT NOT NULL DEFAULT 'layers',
  color TEXT NOT NULL DEFAULT '#20D6CD', sort_order INTEGER NOT NULL DEFAULT 0,
  is_hidden INTEGER NOT NULL DEFAULT 0 CHECK(is_hidden IN (0,1)), is_archived INTEGER NOT NULL DEFAULT 0 CHECK(is_archived IN (0,1)),
  description_limit INTEGER, search_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  deleted_at TEXT, trash_group TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TRIGGER categories_no_cycles BEFORE UPDATE OF parent_id ON categories WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT,'category cycle') WHERE NEW.id IN (
    WITH RECURSIVE ancestors(id) AS (SELECT NEW.parent_id UNION SELECT c.parent_id FROM categories c JOIN ancestors a ON c.id=a.id WHERE c.parent_id IS NOT NULL)
    SELECT id FROM ancestors
  );
END;
CREATE TABLE publication_statuses (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL, sort_order INTEGER NOT NULL);
CREATE TABLE publications (
  id TEXT PRIMARY KEY, category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', hashtags TEXT NOT NULL DEFAULT '', status_id TEXT NOT NULL DEFAULT 'draft' REFERENCES publication_statuses(id),
  scenario TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', cover_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
  scheduled_at TEXT, published_at TEXT, tiktok_url TEXT NOT NULL DEFAULT '', is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0,1)),
  search_text TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, trash_group TEXT,
  version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE ideas (
  id TEXT PRIMARY KEY, category_id TEXT REFERENCES categories(id) ON DELETE SET NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','developing','selected','realized','archived')),
  scenario TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', links TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(links)),
  cover_media_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL, publication_id TEXT REFERENCES publications(id) ON DELETE SET NULL,
  is_favorite INTEGER NOT NULL DEFAULT 0 CHECK(is_favorite IN (0,1)), search_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT, trash_group TEXT, version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE publication_media (
  id TEXT PRIMARY KEY, publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_assets(id), sort_order INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'asset',
  deleted_at TEXT, replace_for TEXT
);
CREATE TABLE idea_media (
  id TEXT PRIMARY KEY, idea_id TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_assets(id), sort_order INTEGER NOT NULL DEFAULT 0, role TEXT NOT NULL DEFAULT 'asset',
  deleted_at TEXT, replace_for TEXT
);
CREATE TABLE owner_covers (
  id TEXT PRIMARY KEY, owner_type TEXT NOT NULL CHECK(owner_type IN ('category','logo')), owner_id TEXT NOT NULL,
  media_id TEXT NOT NULL REFERENCES media_assets(id), created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE UNIQUE INDEX owner_covers_active ON owner_covers(owner_type,owner_id) WHERE deleted_at IS NULL;
CREATE TABLE custom_field_definitions (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('text','number','date','boolean','select','url')),
  options TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(options)), sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE custom_field_values (
  publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  field_id TEXT NOT NULL REFERENCES custom_field_definitions(id) ON DELETE CASCADE,
  value TEXT NOT NULL CHECK(json_valid(value)), PRIMARY KEY(publication_id,field_id)
);
CREATE TABLE app_settings (key TEXT PRIMARY KEY,value TEXT NOT NULL CHECK(json_valid(value)),updated_at TEXT NOT NULL);
CREATE TABLE activity_log (id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT, entity_id TEXT, created_at TEXT NOT NULL);
CREATE TABLE storage_operations (
  id TEXT PRIMARY KEY, action TEXT NOT NULL, status TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE backup_records (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, status TEXT NOT NULL, object_count INTEGER NOT NULL DEFAULT 0, detail TEXT);
CREATE TABLE archive_exceptions (publication_id TEXT PRIMARY KEY REFERENCES publications(id) ON DELETE CASCADE, created_at TEXT NOT NULL);
CREATE TABLE system_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE media_cleanup (storage_key TEXT PRIMARY KEY,created_at TEXT NOT NULL);
CREATE INDEX category_parent_idx ON categories(parent_id,deleted_at,sort_order);
CREATE INDEX category_trash_idx ON categories(trash_group) WHERE trash_group IS NOT NULL;
CREATE INDEX publication_category_idx ON publications(category_id,deleted_at,status_id);
CREATE INDEX publication_status_idx ON publications(status_id,deleted_at,updated_at);
CREATE INDEX publication_schedule_idx ON publications(scheduled_at) WHERE deleted_at IS NULL;
CREATE INDEX publication_trash_idx ON publications(trash_group) WHERE trash_group IS NOT NULL;
CREATE INDEX publication_media_order_idx ON publication_media(publication_id,deleted_at,sort_order);
CREATE INDEX publication_media_reverse_idx ON publication_media(media_id);
CREATE INDEX idea_trash_idx ON ideas(trash_group) WHERE trash_group IS NOT NULL;
CREATE INDEX idea_category_idx ON ideas(category_id,deleted_at,status);
CREATE INDEX idea_media_order_idx ON idea_media(idea_id,deleted_at,sort_order);
CREATE INDEX idea_media_reverse_idx ON idea_media(media_id);
CREATE INDEX cover_media_idx ON owner_covers(media_id);
CREATE INDEX activity_recent_idx ON activity_log(created_at DESC);
CREATE INDEX operations_recent_idx ON storage_operations(status,created_at DESC);
