export const SCHEMA_VERSION=5;
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
  ]}
];
export const FTS5_SCHEMA=`CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, title, body, context, created_at UNINDEXED, conversation_id UNINDEXED, source_path UNINDEXED)`;
