import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  upsertPushSubscription, deletePushSubscription, listPushSubscriptions,
} from './pushSubscriptions.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  return db;
}

describe('pushSubscriptions', () => {
  it('lists empty on a fresh table', () => {
    expect(listPushSubscriptions(freshDb())).toEqual([]);
  });

  it('upsert then list returns one row', () => {
    const db = freshDb();
    upsertPushSubscription(db, {
      endpoint: 'https://push.example/a',
      p256dh: 'p1',
      auth: 'a1',
    });
    const rows = listPushSubscriptions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: 'https://push.example/a',
      p256dh: 'p1',
      auth: 'a1',
    });
    expect(rows[0].createdAt).toBeGreaterThan(0);
  });

  it('upserting the same endpoint twice yields one row with the newer keys', () => {
    const db = freshDb();
    upsertPushSubscription(db, {
      endpoint: 'https://push.example/a',
      p256dh: 'old',
      auth: 'old-auth',
    });
    upsertPushSubscription(db, {
      endpoint: 'https://push.example/a',
      p256dh: 'new',
      auth: 'new-auth',
      userAgent: 'Tierwyn-test',
    });
    const rows = listPushSubscriptions(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      endpoint: 'https://push.example/a',
      p256dh: 'new',
      auth: 'new-auth',
      userAgent: 'Tierwyn-test',
    });
  });

  it('delete removes the row', () => {
    const db = freshDb();
    upsertPushSubscription(db, {
      endpoint: 'https://push.example/a',
      p256dh: 'p1',
      auth: 'a1',
    });
    deletePushSubscription(db, 'https://push.example/a');
    expect(listPushSubscriptions(db)).toEqual([]);
  });
});
