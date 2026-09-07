import { afterEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { FTS5_SCHEMA, MIGRATIONS } from './schema';

describe('M10 derived-index SQL lifecycle', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('builds set-based search/activity chunks idempotently and checkpoints rows', async () => {
    const sqlite3 = await sqlite3InitModule(); const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS) for (const statement of migration.statements) db.exec(statement);
    db.exec(FTS5_SCHEMA);
    const now = new Date().toISOString();
    db.exec({ sql: 'INSERT INTO import_sessions(id,archive_set_id,started_at,updated_at,parser_version,schema_version,source_status,derived_status) VALUES(?,?,?,?,?,?,?,?)', bind: ['session:1', 'archive:1', now, now, 9, 9, 'complete', 'pending'] });
    db.exec({ sql: 'INSERT INTO derived_index_jobs(id,session_id,kind,status,phase,rows_processed,total_rows,batch_size,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)', bind: ['job:search', 'session:1', 'search', 'running', 'people', 0, 4, 2, now, now] });
    db.exec({ sql: 'INSERT INTO people(id,display_name,identity_confidence,source_paths) VALUES(?,?,?,?)', bind: ['person:1', 'Synthetic Person', 'exact', '[]'] });
    db.exec({ sql: 'INSERT INTO posts(id,body,created_at,source_path) VALUES(?,?,?,?)', bind: ['post:1', 'A searchable local memory', '2024-01-02T00:00:00.000Z', 'posts.json'] });
    db.exec({ sql: 'INSERT INTO messages(id,conversation_id,body,sent_at,source_path) VALUES(?,?,?,?,?)', bind: ['message:1', 'conversation:1', 'A local hello', '2024-01-03T00:00:00.000Z', 'messages.json'] });
    db.exec({ sql: 'INSERT INTO conversations(id,title,participant_names,participant_ids,source_path) VALUES(?,?,?,?,?)', bind: ['conversation:1', 'Local chat', '["Synthetic Person"]', '["person:1"]', 'messages.json'] });
    db.exec({ sql: "INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'post',id,NULL,body,NULL,created_at,NULL,source_path FROM posts WHERE rowid>? ORDER BY rowid LIMIT ?", bind: [0, 2] });
    db.exec({ sql: "INSERT OR REPLACE INTO search_documents(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT 'message',m.id,c.title,m.body,m.sender_name,m.sent_at,m.conversation_id,m.source_path FROM messages m LEFT JOIN conversations c ON c.id=m.conversation_id WHERE m.rowid>? ORDER BY m.rowid LIMIT ?", bind: [0, 2] });
    db.exec({ sql: 'INSERT INTO archive_fts(entity_type,entity_id,title,body,context,created_at,conversation_id,source_path) SELECT entity_type,entity_id,title,body,context,created_at,conversation_id,source_path FROM search_documents WHERE rowid>? ORDER BY rowid LIMIT ?', bind: [0, 10] });
    expect(db.selectValue('SELECT COUNT(*) FROM search_documents')).toBe(2);
    expect(db.selectValue('SELECT COUNT(*) FROM archive_fts')).toBe(2);
    db.exec({ sql: "INSERT OR IGNORE INTO activity_records(id,activity_type,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path) SELECT 'activity:post:'||id,'post','post',id,created_at,CAST(strftime('%m',created_at) AS INTEGER),CAST(strftime('%d',created_at) AS INTEGER),CAST(strftime('%Y',created_at) AS INTEGER),'Posted',source_path FROM posts WHERE rowid>? ORDER BY rowid LIMIT ?", bind: [0, 2] });
    db.exec({ sql: 'UPDATE derived_index_jobs SET cursor=?,rows_processed=?,updated_at=? WHERE session_id=? AND kind=?', bind: ['1', 1, now, 'session:1', 'search'] });
    db.exec({ sql: "INSERT OR IGNORE INTO activity_records(id,activity_type,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path) SELECT 'activity:post:'||id,'post','post',id,created_at,CAST(strftime('%m',created_at) AS INTEGER),CAST(strftime('%d',created_at) AS INTEGER),CAST(strftime('%Y',created_at) AS INTEGER),'Posted',source_path FROM posts WHERE rowid>? ORDER BY rowid LIMIT ?", bind: [0, 2] });
    expect(db.selectValue('SELECT COUNT(*) FROM activity_records')).toBe(1);
    expect(db.selectValue('SELECT cursor FROM derived_index_jobs WHERE session_id=? AND kind=?', ['session:1', 'search'])).toBe('1');
  });
});
