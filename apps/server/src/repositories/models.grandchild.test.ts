import { describe, it, expect, beforeEach } from 'vitest';
import { openDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedCatalogue } from '../db/seed.js';
import { createModel, updateModel, getModel } from './models.js';
import type { Database } from 'better-sqlite3';

describe('maxGrandchildSpawns round-trip', () => {
  let db: Database;
  beforeEach(() => { db = openDb(':memory:'); runMigrations(db, migrations); seedCatalogue(db); });

  it('persists on create and patch', () => {
    const created = createModel(db, 'claude-code', {
      modelName: 'gc-test', label: 'GC', maxGrandchildSpawns: 3,
    } as any);
    expect(created.maxGrandchildSpawns).toBe(3);
    const patched = updateModel(db, created.id, { maxGrandchildSpawns: 5 } as any);
    expect(patched!.maxGrandchildSpawns).toBe(5);
    expect(getModel(db, created.id)!.maxGrandchildSpawns).toBe(5);
  });
});
