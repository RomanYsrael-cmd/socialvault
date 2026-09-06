import { afterEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

describe('Milestone 7 archive-set persistence', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());
  it('migrates a v5 database without changing earlier migrations and backfills source columns', async () => {
    const sqlite3 = await sqlite3InitModule(); const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS) { for (const statement of migration.statements) db.exec(statement); db.exec({ sql: 'INSERT INTO schema_migrations VALUES(?,?)', bind: [migration.version, new Date().toISOString()] }); }
    expect(db.selectValue('SELECT MAX(version) FROM schema_migrations')).toBe(SCHEMA_VERSION);
    expect(db.selectValue("SELECT name FROM sqlite_schema WHERE name='archive_sets'" as string)).toBe('archive_sets'); expect(db.selectValue("SELECT name FROM sqlite_schema WHERE name='archive_parts'" as string)).toBe('archive_parts');
    db.exec({ sql: 'INSERT INTO archive_sets(id,platform,created_at,part_count,total_size,fingerprint) VALUES(?,?,?,?,?,?)', bind: ['archive-set:facebook:f', 'facebook', Date.now(), 2, 42, 'f'] });
    db.exec({ sql: 'INSERT INTO archive_parts(id,archive_id,part_index,filename,file_size,entry_count,manifest_fingerprint,connected) VALUES(?,?,?,?,?,?,?,?)', bind: ['archive-part:a', 'archive-set:facebook:f', 0, 'one.zip', 20, 2, 'a', 1] });
    db.exec({ sql: 'INSERT INTO posts(id,body,source_path,archive_part_id) VALUES(?,?,?,?)', bind: ['post:1', 'hello', 'posts.json', 'archive-part:a'] });
    expect(db.selectValue('SELECT archive_part_id FROM posts WHERE id=?', ['post:1'])).toBe('archive-part:a');
  });
  it('keeps part metadata compact for a simulated 40-part set', async () => {
    const sqlite3 = await sqlite3InitModule(); const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS) for (const statement of migration.statements) db.exec(statement);
    db.transaction(() => { db.exec({ sql: 'INSERT INTO archive_sets(id,platform,created_at,part_count,total_size,fingerprint) VALUES(?,?,?,?,?,?)', bind: ['set', 'facebook', Date.now(), 40, 40_000, 'set-f'] }); for (let index = 0; index < 40; index++) db.exec({ sql: 'INSERT INTO archive_parts(id,archive_id,part_index,filename,file_size,entry_count,manifest_fingerprint,connected) VALUES(?,?,?,?,?,?,?,?)', bind: [`part:${index}`, 'set', index, `part-${index + 1}.zip`, 1_000, 100, `fp:${index}`, 1] }); });
    expect(db.selectValue('SELECT COUNT(*) FROM archive_parts')).toBe(40); expect(db.selectValue('SELECT SUM(file_size) FROM archive_parts')).toBe(40_000);
  });
});
