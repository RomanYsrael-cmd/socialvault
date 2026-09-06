import { afterEach, describe, expect, it } from 'vitest';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import { MIGRATIONS, SCHEMA_VERSION } from './schema';

describe('Milestone 6 activity ledger', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('creates migration v5, stores calendar parts, and queries memories by month/day', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS) { for (const statement of migration.statements) db.exec(statement); db.exec({ sql: 'INSERT INTO schema_migrations VALUES(?,?)', bind: [migration.version, new Date().toISOString()] }); }
    expect(db.selectValue('SELECT MAX(version) FROM schema_migrations')).toBe(SCHEMA_VERSION);
    db.exec({ sql: 'INSERT INTO activity_records(id,activity_type,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path) VALUES(?,?,?,?,?,?,?,?,?,?)', bind: ['activity:post:1', 'post', 'post', 'post:1', '2024-09-06T12:00:00.000Z', 9, 6, 2024, 'Posted a memory', 'posts.json'] });
    db.exec({ sql: 'INSERT INTO activity_records(id,activity_type,target_type,target_id,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path) VALUES(?,?,?,?,?,?,?,?,?,?)', bind: ['activity:post:2', 'post', 'post', 'post:2', '2023-09-06T12:00:00.000Z', 9, 6, 2023, 'Posted another memory', 'posts.json'] });
    const memories = db.exec({ sql: 'SELECT target_id targetId,calendar_year year FROM activity_records WHERE calendar_month=? AND calendar_day=? ORDER BY calendar_year DESC', bind: [9, 6], returnValue: 'resultRows', rowMode: 'object' }) as { targetId: string; year: number }[];
    expect(memories).toEqual([{ targetId: 'post:1', year: 2024 }, { targetId: 'post:2', year: 2023 }]);
    const plan = db.exec({ sql: 'EXPLAIN QUERY PLAN SELECT id FROM activity_records WHERE calendar_month=? AND calendar_day=?', bind: [9, 6], returnValue: 'resultRows', rowMode: 'object' }) as { detail: string }[];
    expect(plan.some(row => row.detail.includes('idx_activity_calendar'))).toBe(true);
  });

  it('supports type/year filters and stable cursor ordering for activity pages', async () => {
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.DB(':memory:', 'c'); close = () => db.close();
    for (const migration of MIGRATIONS) { for (const statement of migration.statements) db.exec(statement); db.exec({ sql: 'INSERT INTO schema_migrations VALUES(?,?)', bind: [migration.version, new Date().toISOString()] }); }
    for (let index = 0; index < 4; index += 1) db.exec({ sql: 'INSERT INTO activity_records(id,activity_type,occurred_at,calendar_month,calendar_day,calendar_year,summary,source_path) VALUES(?,?,?,?,?,?,?,?)', bind: [`activity:${index}`, index % 2 ? 'comment' : 'post', `2025-01-0${index + 1}T00:00:00.000Z`, 1, index + 1, 2025, `record ${index}`, 'history.json'] });
    const rows = db.exec({ sql: 'SELECT id FROM activity_records WHERE activity_type=? AND calendar_year=? ORDER BY occurred_at DESC,id DESC LIMIT 2', bind: ['post', 2025], returnValue: 'resultRows', rowMode: 'object' }) as { id: string }[];
    expect(rows.map(row => row.id)).toEqual(['activity:2', 'activity:0']);
  });
});
