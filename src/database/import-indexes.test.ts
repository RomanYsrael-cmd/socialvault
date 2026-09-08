import { expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS } from './schema';
import { deferBrowsingIndexes, MESSAGE_BROWSING_INDEXES } from './import-indexes';

it('retains indexed deduplication/provenance and restores indexed browsing after base writes', async () => {
  const sqlite = await sqlite3InitModule(), db = new sqlite.oo1.DB(':memory:', 'c');
  try {
    for (const migration of MIGRATIONS) for (const sql of migration.statements) db.exec(sql);
    deferBrowsingIndexes(sql => db.exec(sql));
    const source = 'messages/inbox/synthetic/message_1.html';
    db.transaction(() => {
      for (let i=0;i<10_000;i++) db.exec({sql:'INSERT OR IGNORE INTO messages(id,conversation_id,body,sent_at,source_path,archive_part_id) VALUES(?,?,?,?,?,?)',bind:[`message:${i%5000}`,'thread','Synthetic','2024-01-01',source,'part']});
      db.exec({sql:'INSERT INTO import_source_checkpoints VALUES(?,?,?,?)',bind:['session','part',source,'9']});
    });
    expect(db.selectValue('SELECT COUNT(*) FROM messages')).toBe(5000);
    const plan = (sql:string,bind:string[]) => JSON.stringify(db.exec({sql:`EXPLAIN QUERY PLAN ${sql}`,bind,returnValue:'resultRows',rowMode:'object'}));
    expect(plan('SELECT id FROM messages WHERE id=?',['message:1'])).toMatch(/INDEX/);
    expect(plan('SELECT id FROM messages WHERE archive_part_id=?',['part'])).toContain('idx_source_messages_part');
    expect(plan('SELECT source_path FROM import_source_checkpoints WHERE session_id=? AND archive_part_id=?',['session','part'])).toMatch(/INDEX/);
    for(const[name,definition]of Object.entries(MESSAGE_BROWSING_INDEXES)) db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${definition}`);
    expect(plan('SELECT id FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,id DESC LIMIT 40',['thread'])).toContain('idx_messages_conversation_sent_id');
    expect(db.selectValue('SELECT COUNT(*) FROM import_source_checkpoints')).toBe(1);
  } finally {db.close();}
},30_000);
