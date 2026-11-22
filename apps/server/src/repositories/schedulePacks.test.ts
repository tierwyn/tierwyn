import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { SchedulePack } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  listPacks, getPack, upsertShippedPack, upsertImportedPack, deletePack,
} from './schedulePacks.js';
import { SHIPPED_PACKS } from '../schedules/packs/index.js';

function fresh() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function imported(slug: string, overrides: Partial<SchedulePack> = {}): SchedulePack {
  return {
    slug,
    title: `Imported ${slug}`,
    description: 'd',
    version: 1,
    origin: 'imported',
    job: {
      cadence: { kind: 'once', fireInMs: 60_000 },
      promptTemplate: 'do the thing',
    },
    ...overrides,
  };
}

describe('schedulePacks repository', () => {
  it('upserts a shipped pack and lists it', () => {
    const db = fresh();
    upsertShippedPack(db, SHIPPED_PACKS[0]!);
    const listed = listPacks(db);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.slug).toBe(SHIPPED_PACKS[0]!.slug);
    expect(listed[0]!.origin).toBe('shipped');
    expect(getPack(db, SHIPPED_PACKS[0]!.slug)?.title).toBe(SHIPPED_PACKS[0]!.title);
  });

  it('re-upserts a shipped pack in place and never touches an imported row of the same slug', () => {
    const db = fresh();
    const pack = imported('my-pack');
    upsertImportedPack(db, pack);
    const asShipped: SchedulePack = { ...pack, origin: 'shipped', title: 'should not win' };
    upsertShippedPack(db, asShipped);
    expect(getPack(db, 'my-pack')!.origin).toBe('imported');
    expect(getPack(db, 'my-pack')!.title).toBe('Imported my-pack');
  });

  it('upserts imported over imported, and delete of shipped returns shipped', () => {
    const db = fresh();
    upsertShippedPack(db, SHIPPED_PACKS[0]!);
    expect(deletePack(db, SHIPPED_PACKS[0]!.slug)).toBe('shipped');
    expect(getPack(db, SHIPPED_PACKS[0]!.slug)).toBeTruthy();

    upsertImportedPack(db, imported('ops-pack'));
    upsertImportedPack(db, imported('ops-pack', { title: 'Updated' }));
    expect(getPack(db, 'ops-pack')!.title).toBe('Updated');
    expect(deletePack(db, 'ops-pack')).toBe('deleted');
    expect(getPack(db, 'ops-pack')).toBeUndefined();
    expect(deletePack(db, 'nope')).toBe('not_found');
  });

  it('listPacks skips a malformed doc row rather than throwing', () => {
    const db = fresh();
    upsertImportedPack(db, imported('good'));
    db.prepare(
      `INSERT INTO schedule_packs (slug, title, description, version, origin, doc, created_at, updated_at)
       VALUES ('bad', 'Bad', '', 1, 'imported', 'not-json', 1, 1)`,
    ).run();
    const listed = listPacks(db);
    expect(listed.map((p) => p.slug)).toEqual(['good']);
  });

  it('lists shipped first, then imported, each group slug ASC', () => {
    const db = fresh();
    upsertImportedPack(db, imported('zeta'));
    upsertImportedPack(db, imported('alpha'));
    upsertShippedPack(db, { ...SHIPPED_PACKS[0]!, slug: 'zebra-shipped' });
    upsertShippedPack(db, { ...SHIPPED_PACKS[0]!, slug: 'able-shipped' });
    expect(listPacks(db).map((p) => p.slug)).toEqual([
      'able-shipped', 'zebra-shipped', 'alpha', 'zeta',
    ]);
  });
});
