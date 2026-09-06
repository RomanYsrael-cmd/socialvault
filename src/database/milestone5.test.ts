import { afterEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

describe('Milestone 5 SQLite records', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());
  it('migrates social graph tables and reads basic records', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS) { for (const statement of migration.statements) db.exec(statement); db.exec({ sql: 'INSERT INTO schema_migrations VALUES(?,?)', bind: [migration.version, new Date().toISOString()] }); }
    expect(db.selectValue('SELECT MAX(version) FROM schema_migrations')).toBe(SCHEMA_VERSION);
    db.exec({ sql: 'INSERT INTO posts(id,author_id,body,source_path) VALUES(?,?,?,?)', bind: ['post:1', 'owner', 'hello', 'posts.json'] });
    db.exec({ sql: 'INSERT INTO comments(id,post_id,body,source_path) VALUES(?,?,?,?)', bind: ['comment:1', 'post:1', 'nice post', 'posts.json'] });
    db.exec({ sql: 'INSERT INTO connections(id,person_id,display_name,relationship_type,source_path) VALUES(?,?,?,?,?)', bind: ['connection:1', 'person:1', 'Friend', 'friend', 'friends.json'] });
    db.exec({ sql: 'INSERT INTO albums(id,title,source_path) VALUES(?,?,?)', bind: ['album:1', 'Summer', 'albums.json'] });
    expect(db.selectValue('SELECT body FROM comments WHERE post_id=?', ['post:1'])).toBe('nice post');
    expect(db.selectValue('SELECT display_name FROM connections WHERE relationship_type=?', ['friend'])).toBe('Friend');
    expect(db.selectValue('SELECT title FROM albums WHERE id=?', ['album:1'])).toBe('Summer');
  });
});
