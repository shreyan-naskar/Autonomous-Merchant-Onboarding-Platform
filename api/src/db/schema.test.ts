import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { MIGRATIONS_DIR, openDb, type Db } from './client.js';
import { callbackEvents } from './schema.js';

let db: Db;
beforeEach(() => {
  db = openDb(':memory:');
});
afterEach(() => db.$client.close());

describe('schema / migration', () => {
  it('creates all 9 tables', () => {
    const names = (
      db.$client
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual([
      'applications',
      'audit_log',
      'callback_events',
      'documents',
      'extracted_fields',
      'jobs',
      'merchant_accounts',
      'review_tasks',
      'verifications',
    ]);
  });

  it('allows one non-duplicate callback row per event_id, plus any number of duplicate rows', () => {
    const row = { eventId: 'evt-1', payload: {}, receivedAt: 1 };
    db.insert(callbackEvents).values(row).run();
    expect(() => db.insert(callbackEvents).values(row).run()).toThrow(/UNIQUE constraint failed/);
    db.insert(callbackEvents).values({ ...row, isDuplicate: true }).run();
    db.insert(callbackEvents).values({ ...row, isDuplicate: true }).run();
    const rows = db.select().from(callbackEvents).all();
    expect(rows.map((r) => r.isDuplicate)).toEqual([false, true, true]);
  });

  it('is idempotent when migrations run twice', () => {
    expect(() => migrate(db, { migrationsFolder: MIGRATIONS_DIR })).not.toThrow();
  });
});
