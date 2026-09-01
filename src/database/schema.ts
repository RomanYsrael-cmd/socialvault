export const SCHEMA_VERSION=1;
export const MIGRATIONS=[
  `CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, person_id TEXT NOT NULL, display_name TEXT NOT NULL, username TEXT, bio TEXT, joined_at TEXT, source_path TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS posts (id TEXT PRIMARY KEY, author_id TEXT, title TEXT, body TEXT, created_at TEXT, source_path TEXT NOT NULL, source_index INTEGER)`,
  `CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT, participant_names TEXT NOT NULL, source_path TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_name TEXT, body TEXT, sent_at TEXT, source_path TEXT NOT NULL, source_index INTEGER, FOREIGN KEY(conversation_id) REFERENCES conversations(id))`,
  `CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_conversation_sent ON messages(conversation_id, sent_at)`
] as const;
