import { afterEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS } from './schema';
const scaleProbeEnabled = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.RUN_SOCIALVAULT_SCALE === '1';
describe('bounded local archive queries', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());
  it('keeps page queries bounded on synthetic large records', async () => {
    const sqlite3 = await sqlite3InitModule(), db = new sqlite3.oo1.DB(':memory:', 'c');
    close = () => db.close();
    for (const migration of MIGRATIONS) for (const statement of migration.statements) db.exec(statement);
    db.exec({ sql: 'INSERT INTO conversations(id,title,participant_names,source_path,is_group,participant_ids) VALUES(?,?,?,?,?,?)', bind: ['conversation:large', 'Large thread', '[]', 'messages/inbox/large/message_1.json', 0, '[]'] });
    db.transaction(() => {
      for (let index = 0; index < 10_000; index++) db.exec({ sql: 'INSERT INTO posts(id,author_id,body,created_at,source_path,source_index) VALUES(?,?,?,?,?,?)', bind: [`post:large:${index}`, 'owner', `Synthetic post ${index}`, `2025-01-${String((index % 28) + 1).padStart(2, '0')}T00:00:00.000Z`, 'posts/large.json', index] });
      for (let index = 0; index < 100_000; index++) db.exec({ sql: 'INSERT INTO messages(id,conversation_id,sender_name,body,sent_at,source_path,source_index,sender_id) VALUES(?,?,?,?,?,?,?,?)', bind: [`message:large:${index}`, 'conversation:large', 'Synthetic sender', `Synthetic message ${index}`, `2025-01-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`, 'messages/inbox/large/message_1.json', index, 'person:large'] });
    });
    const posts = db.exec({ sql: "SELECT id FROM posts ORDER BY created_at DESC,id DESC LIMIT 21", returnValue: 'resultRows', rowMode: 'object' }) as unknown[];
    const messages = db.exec({ sql: "SELECT id FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,id DESC LIMIT 41", bind: ['conversation:large'], returnValue: 'resultRows', rowMode: 'object' }) as unknown[];
    expect(posts).toHaveLength(21);
    expect(messages).toHaveLength(41);
    expect(db.selectValue('SELECT COUNT(*) FROM posts')).toBe(10_000);
    expect(db.selectValue('SELECT COUNT(*) FROM messages')).toBe(100_000);
  }, 60_000);

  it.skipIf(!scaleProbeEnabled)('exercises the observed archive-scale source magnitudes', async () => {
    const sqlite3 = await sqlite3InitModule(), db = new sqlite3.oo1.DB(':memory:', 'c');
    close = () => db.close();
    for (const migration of MIGRATIONS) for (const statement of migration.statements) db.exec(statement);
    const timestamp = '2024-01-01T00:00:00.000Z';
    db.transaction(() => {
      for (let index = 0; index < 6_542; index += 1) db.exec({ sql: 'INSERT INTO people(id,display_name,identity_confidence,source_paths) VALUES(?,?,?,?)', bind: [`person:scale:${index}`, `Scale Person ${index}`, 'exact', '[]'] });
      for (let index = 0; index < 12_758; index += 1) db.exec({ sql: 'INSERT INTO posts(id,author_id,body,created_at,source_path,source_index) VALUES(?,?,?,?,?,?)', bind: [`post:scale:${index}`, 'person:scale:0', `Scale post ${index}`, timestamp, 'posts/scale.json', index] });
      for (let index = 0; index < 6_000; index += 1) db.exec({ sql: 'INSERT INTO conversations(id,title,participant_names,source_path,is_group,participant_ids) VALUES(?,?,?,?,?,?)', bind: [`conversation:scale:${index}`, `Scale conversation ${index}`, '["Scale Person 0"]', 'messages/scale.json', 0, '["person:scale:0"]'] });
      for (let index = 0; index < 625_806; index += 1) db.exec({ sql: 'INSERT INTO messages(id,conversation_id,sender_name,body,sent_at,source_path,source_index,sender_id) VALUES(?,?,?,?,?,?,?,?)', bind: [`message:scale:${index}`, `conversation:scale:${index % 6_000}`, 'Scale Person 0', `Scale message ${index}`, timestamp, 'messages/scale.json', index, 'person:scale:0'] });
      for (let index = 0; index < 62_493; index += 1) db.exec({ sql: 'INSERT INTO media(id,path,media_type,filename,mime_type,owner_type,owner_id,source_path,source_index) VALUES(?,?,?,?,?,?,?,?,?)', bind: [`media:scale:${index}`, `photos/scale-${index}.jpg`, 'image', `scale-${index}.jpg`, 'image/jpeg', 'post', `post:scale:${index % 12_758}`, 'photos/scale.json', index] });
    });
    expect(db.selectValue('SELECT COUNT(*) FROM people')).toBe(6_542);
    expect(db.selectValue('SELECT COUNT(*) FROM posts')).toBe(12_758);
    expect(db.selectValue('SELECT COUNT(*) FROM conversations')).toBe(6_000);
    expect(db.selectValue('SELECT COUNT(*) FROM messages')).toBe(625_806);
    expect(db.selectValue('SELECT COUNT(*) FROM media')).toBe(62_493);
    const plan = db.exec({ sql: 'EXPLAIN QUERY PLAN SELECT id FROM messages WHERE conversation_id=? ORDER BY sent_at DESC,id DESC LIMIT 40', bind: ['conversation:scale:1'], returnValue: 'resultRows', rowMode: 'object' }) as { detail: string }[];
    expect(plan.some(row => /idx_messages_conversation_sent_id|conversation_sent/i.test(String(row.detail)))).toBe(true);
  }, 180_000);
});
