import { afterEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { FTS5_SCHEMA, MIGRATIONS, SCHEMA_VERSION } from './schema';

describe('Milestone 8 persistence foundations', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('upgrades a v6 database with v7 session tables without losing rows', async () => {
    const sqlite3 = await sqlite3InitModule(); const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS.slice(0, 6)) { for (const statement of migration.statements) db.exec(statement); db.exec({ sql: 'INSERT INTO schema_migrations VALUES(?,?)', bind: [migration.version, '2026-01-01'] }); }
    db.exec({ sql: 'INSERT INTO posts(id,body,source_path) VALUES(?,?,?)', bind: ['post:kept', 'kept record', 'posts.json'] });
    for (const statement of MIGRATIONS[6].statements) db.exec(statement);
    expect(db.selectValue('SELECT MAX(version) FROM schema_migrations')).toBe(6); // v7 is applied by the worker after this migration transaction
    db.exec({ sql: 'INSERT INTO schema_migrations VALUES(?,?)', bind: [7, '2026-01-01'] });
    expect(db.selectValue('SELECT body FROM posts WHERE id=?', ['post:kept'])).toBe('kept record');
    expect(db.selectValue("SELECT name FROM sqlite_schema WHERE name='import_sessions'")).toBe('import_sessions');
    expect(db.selectValue("SELECT name FROM sqlite_schema WHERE name='import_part_checkpoints'")).toBe('import_part_checkpoints');
    expect(db.selectValue('SELECT MAX(version) FROM schema_migrations')).toBe(SCHEMA_VERSION);
  });

  it('rolls back a part transaction instead of leaving half a checkpoint', async () => {
    const sqlite3 = await sqlite3InitModule(); const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS) for (const statement of migration.statements) db.exec(statement);
    db.exec({ sql: 'INSERT INTO import_sessions(id,archive_set_id,started_at,updated_at,parser_version,schema_version) VALUES(?,?,?,?,?,?)', bind: ['session:1', 'set:1', '2026-01-01', '2026-01-01', 8, 7] });
    expect(() => db.transaction(() => { db.exec({ sql: 'INSERT INTO posts(id,body,source_path) VALUES(?,?,?)', bind: ['post:partial', 'should rollback', 'posts.json'] }); throw new Error('simulated worker failure'); })).toThrow('simulated worker failure');
    expect(db.selectValue("SELECT COUNT(*) FROM posts WHERE id='post:partial'")).toBe(0);
  });

  it('ranks title matches ahead of body-only matches with BM25 and keeps Unicode searchable', async () => {
    const sqlite3 = await sqlite3InitModule(); const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    db.exec(FTS5_SCHEMA);
    db.exec({ sql: 'INSERT INTO archive_fts(entity_type,entity_id,title,body,context) VALUES(?,?,?,?,?)', bind: ['post', 'body', 'A post', 'bicycle archive', ''] });
    db.exec({ sql: 'INSERT INTO archive_fts(entity_type,entity_id,title,body,context) VALUES(?,?,?,?,?)', bind: ['post', 'title', 'Bicycle archive', 'unrelated', ''] });
    db.exec({ sql: 'INSERT INTO archive_fts(entity_type,entity_id,title,body,context) VALUES(?,?,?,?,?)', bind: ['message', 'unicode', 'Chat', 'こんにちは 👋', ''] });
    const rows = db.exec({ sql: 'SELECT entity_id FROM archive_fts WHERE archive_fts MATCH ? ORDER BY bm25(archive_fts,0,0,5.0,1.5,1.0,0,0,0)', bind: ['bicycle'], returnValue: 'resultRows', rowMode: 'object' }) as { entity_id: string }[];
    expect(rows.map(row => row.entity_id)).toEqual(['title', 'body']);
    expect((db.exec({ sql: 'SELECT entity_id FROM archive_fts WHERE archive_fts MATCH ?', bind: ['こんにちは'], returnValue: 'resultRows', rowMode: 'object' }) as { entity_id: string }[])[0].entity_id).toBe('unicode');
  });
});
