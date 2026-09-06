export const SCHEMA_VERSION=7;
export type Migration={version:number;statements:readonly string[]};
// Version 1 is kept byte-for-byte equivalent to the Milestone 2 schema. New changes append migrations.
export const MIGRATIONS:readonly Migration[]=[
  {version:1,statements:[
    `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, display_name TEXT NOT NULL, username TEXT, bio TEXT, joined_at TEXT, source_path TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, author_id TEXT, title TEXT, body TEXT, created_at TEXT, source_path TEXT NOT NULL, source_index INTEGER)`,
    `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, participant_names TEXT NOT NULL, source_path TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_name TEXT, body TEXT, sent_at TEXT, source_path TEXT NOT NULL, source_index INTEGER, FOREIGN KEY(conversation_id) REFERENCES conversations(id))`,
    `CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent ON messages(conversation_id, sent_at)`
  ]},
  {version:2,statements:[
    `ALTER TABLE conversations ADD COLUMN is_group INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS media (id TEXT PRIMARY KEY, path TEXT NOT NULL, media_type TEXT NOT NULL, filename TEXT, mime_type TEXT, caption TEXT, timestamp TEXT, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL, width INTEGER, height INTEGER, duration_ms INTEGER, source_path TEXT NOT NULL, source_index INTEGER)`,
    `CREATE TABLE IF NOT EXISTS import_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS search_documents (entity_type TEXT NOT NULL, entity_id TEXT PRIMARY KEY, title TEXT, body TEXT, context TEXT, created_at TEXT, conversation_id TEXT, source_path TEXT)`,
    `CREATE INDEX IF NOT EXISTS idx_media_owner ON media(owner_type, owner_id)`,
    `CREATE INDEX IF NOT EXISTS idx_search_documents_type ON search_documents(entity_type)`
  ]},
  {version:3,statements:[
    `ALTER TABLE conversations ADD COLUMN participant_ids TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE messages ADD COLUMN sender_id TEXT`,
    `CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, facebook_id TEXT, display_name TEXT NOT NULL, username TEXT, profile_url TEXT, profile_photo_path TEXT, cover_photo_path TEXT, first_seen TEXT, last_seen TEXT, relationship TEXT, identity_confidence TEXT, identity_source TEXT, source_paths TEXT NOT NULL DEFAULT '[]', is_archive_owner INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS person_sources (person_id TEXT NOT NULL, source_path TEXT NOT NULL, source_index INTEGER, PRIMARY KEY(person_id,source_path,source_index))`,
    `CREATE TABLE IF NOT EXISTS media_cache (path TEXT PRIMARY KEY, last_accessed TEXT NOT NULL, byte_size INTEGER)`,
    `CREATE TABLE IF NOT EXISTS archive_identity (id INTEGER PRIMARY KEY CHECK(id=1), filename TEXT NOT NULL, size INTEGER NOT NULL, entry_count INTEGER NOT NULL, fingerprint TEXT NOT NULL, known_entries TEXT NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_people_name ON people(display_name COLLATE NOCASE)`,
    `CREATE INDEX IF NOT EXISTS idx_people_facebook_id ON people(facebook_id)`,
    `CREATE INDEX IF NOT EXISTS idx_person_sources_person ON person_sources(person_id)`,
    `CREATE INDEX IF NOT EXISTS idx_media_cache_accessed ON media_cache(last_accessed)`,
    `CREATE INDEX IF NOT EXISTS idx_media_timestamp ON media(timestamp DESC,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_name)`,
    `CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id)`,
    `CREATE INDEX IF NOT EXISTS idx_conversations_participant_ids ON conversations(participant_ids)`
  ]},
  {version:4,statements:[
    `CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, post_id TEXT NOT NULL, author_id TEXT, author_name TEXT, body TEXT NOT NULL, created_at TEXT, source_path TEXT NOT NULL, source_index INTEGER, FOREIGN KEY(post_id) REFERENCES posts(id))`,
    `CREATE TABLE IF NOT EXISTS reactions (id TEXT PRIMARY KEY, target_type TEXT NOT NULL, target_id TEXT NOT NULL, person_id TEXT, person_name TEXT, kind TEXT NOT NULL, created_at TEXT, source_path TEXT NOT NULL, source_index INTEGER)`,
    `CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, display_name TEXT NOT NULL, facebook_id TEXT, username TEXT, profile_url TEXT, relationship_type TEXT NOT NULL, started_at TEXT, ended_at TEXT, source_path TEXT NOT NULL, source_index INTEGER)`,
    `CREATE TABLE IF NOT EXISTS albums (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, owner_id TEXT, created_at TEXT, updated_at TEXT, source_path TEXT NOT NULL, source_index INTEGER)`,
    `CREATE TABLE IF NOT EXISTS album_media (album_id TEXT NOT NULL, media_id TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(album_id,media_id))`,
    `CREATE TABLE IF NOT EXISTS profile_facts (id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, category TEXT NOT NULL, label TEXT, value TEXT NOT NULL, start_date TEXT, end_date TEXT, source_path TEXT NOT NULL, source_index INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_post_created ON comments(post_id,created_at)`,
    `CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reactions_target ON reactions(target_type,target_id)`,
    `CREATE INDEX IF NOT EXISTS idx_reactions_person ON reactions(person_id)`,
    `CREATE INDEX IF NOT EXISTS idx_connections_type ON connections(relationship_type,display_name)`,
    `CREATE INDEX IF NOT EXISTS idx_connections_person ON connections(person_id)`,
    `CREATE INDEX IF NOT EXISTS idx_albums_updated ON albums(updated_at DESC,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_album_media_media ON album_media(media_id)`,
    `CREATE INDEX IF NOT EXISTS idx_profile_facts_profile ON profile_facts(profile_id,category)`
  ]},
  {version:5,statements:[
    `CREATE TABLE IF NOT EXISTS activity_records (id TEXT PRIMARY KEY, activity_type TEXT NOT NULL, actor_person_id TEXT, target_type TEXT, target_id TEXT, occurred_at TEXT NOT NULL, calendar_month INTEGER NOT NULL, calendar_day INTEGER NOT NULL, calendar_year INTEGER NOT NULL, summary TEXT NOT NULL, source_path TEXT NOT NULL, source_index INTEGER)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_calendar ON activity_records(calendar_month,calendar_day,occurred_at DESC,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_type_date ON activity_records(activity_type,occurred_at DESC,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_year_date ON activity_records(calendar_year,occurred_at DESC,id DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_activity_actor ON activity_records(actor_person_id,occurred_at DESC)`
  ]},
  {version:6,statements:[
    `CREATE TABLE IF NOT EXISTS archive_sets (id TEXT PRIMARY KEY, platform TEXT NOT NULL, created_at INTEGER NOT NULL, part_count INTEGER NOT NULL, total_size INTEGER NOT NULL, fingerprint TEXT NOT NULL UNIQUE, imported_at TEXT, status TEXT NOT NULL DEFAULT 'complete')`,
    `CREATE TABLE IF NOT EXISTS archive_parts (id TEXT PRIMARY KEY, archive_id TEXT NOT NULL, part_index INTEGER NOT NULL, filename TEXT NOT NULL, file_size INTEGER NOT NULL, entry_count INTEGER NOT NULL, manifest_fingerprint TEXT NOT NULL, connected INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'ready', warning_count INTEGER NOT NULL DEFAULT 0, sections TEXT NOT NULL DEFAULT '[]', FOREIGN KEY(archive_id) REFERENCES archive_sets(id))`,
    `CREATE TABLE IF NOT EXISTS source_records (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, archive_part_id TEXT NOT NULL, PRIMARY KEY(entity_type,entity_id))`,
    `ALTER TABLE posts ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE conversations ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE messages ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE media ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE comments ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE reactions ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE connections ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE albums ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE profile_facts ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE person_sources ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE activity_records ADD COLUMN archive_part_id TEXT`,
    `ALTER TABLE search_documents ADD COLUMN archive_part_id TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_archive_parts_archive ON archive_parts(archive_id,part_index)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_archive_parts_manifest ON archive_parts(archive_id,manifest_fingerprint)`,
    `CREATE INDEX IF NOT EXISTS idx_source_records_part ON source_records(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_posts_part ON posts(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_messages_part ON messages(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_media_part ON media(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_comments_part ON comments(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_reactions_part ON reactions(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_connections_part ON connections(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_albums_part ON albums(archive_part_id)`,
    `CREATE INDEX IF NOT EXISTS idx_source_activity_part ON activity_records(archive_part_id)`
  ]},
  {version:7,statements:[
    `CREATE TABLE IF NOT EXISTS import_sessions (id TEXT PRIMARY KEY, archive_set_id TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, parser_version INTEGER NOT NULL, schema_version INTEGER NOT NULL, expected_part_count INTEGER NOT NULL DEFAULT 0, inspected_part_count INTEGER NOT NULL DEFAULT 0, imported_part_count INTEGER NOT NULL DEFAULT 0, failed_part_count INTEGER NOT NULL DEFAULT 0, skipped_part_count INTEGER NOT NULL DEFAULT 0, current_stage TEXT NOT NULL DEFAULT 'inspection', status TEXT NOT NULL DEFAULT 'new', normalized_counts TEXT NOT NULL DEFAULT '{}', warnings_count INTEGER NOT NULL DEFAULT 0, failed_part_ids TEXT NOT NULL DEFAULT '[]', skipped_part_ids TEXT NOT NULL DEFAULT '[]', detected_sections TEXT NOT NULL DEFAULT '[]', imported_sections TEXT NOT NULL DEFAULT '[]', coverage TEXT, last_error TEXT, metrics TEXT)` ,
    `CREATE TABLE IF NOT EXISTS import_part_checkpoints (session_id TEXT NOT NULL, archive_part_id TEXT NOT NULL, part_index INTEGER NOT NULL, manifest_fingerprint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', started_at TEXT, updated_at TEXT NOT NULL, completed_at TEXT, parser_version INTEGER NOT NULL, record_counts TEXT NOT NULL DEFAULT '{}', warnings_count INTEGER NOT NULL DEFAULT 0, error TEXT, sections TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(session_id,archive_part_id), FOREIGN KEY(session_id) REFERENCES import_sessions(id))`,
    `CREATE INDEX IF NOT EXISTS idx_import_part_checkpoints_session ON import_part_checkpoints(session_id,part_index)`,
    `CREATE INDEX IF NOT EXISTS idx_import_part_checkpoints_status ON import_part_checkpoints(session_id,status)`,
    `CREATE TABLE IF NOT EXISTS import_section_status (session_id TEXT NOT NULL, section TEXT NOT NULL, parser_version INTEGER NOT NULL, status TEXT NOT NULL, record_count INTEGER NOT NULL DEFAULT 0, warning_count INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY(session_id,section), FOREIGN KEY(session_id) REFERENCES import_sessions(id))`,
    `CREATE TABLE IF NOT EXISTS rebuild_jobs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, rows_processed INTEGER NOT NULL DEFAULT 0, error TEXT)`,
    `CREATE TABLE IF NOT EXISTS diagnostic_warning_groups (session_id TEXT NOT NULL, category TEXT NOT NULL, message TEXT NOT NULL, occurrence_count INTEGER NOT NULL DEFAULT 0, source_paths TEXT NOT NULL DEFAULT '[]', PRIMARY KEY(session_id,category,message), FOREIGN KEY(session_id) REFERENCES import_sessions(id))`,
    `CREATE INDEX IF NOT EXISTS idx_import_sessions_status ON import_sessions(status,updated_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_import_sections_session ON import_section_status(session_id,status)`
  ]}
];
export const FTS5_SCHEMA=`CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, title, body, context, created_at UNINDEXED, conversation_id UNINDEXED, source_path UNINDEXED)`;
