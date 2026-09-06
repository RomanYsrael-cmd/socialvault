export const SCHEMA_VERSION=2;
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
  ]}
];
export const FTS5_SCHEMA=`CREATE VIRTUAL TABLE IF NOT EXISTS archive_fts USING fts5(entity_type UNINDEXED, entity_id UNINDEXED, title, body, context, created_at UNINDEXED, conversation_id UNINDEXED, source_path UNINDEXED)`;
