import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, setDb, getDb } from '../db/index.js';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { getCompactionSettings, updateCompactionSettings } from './settings.js';
import { AGENT_DEFER_MAX_MS } from '@tierwyn/shared';

beforeEach(() => {
  const db = openDb(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  setDb(db);
});

describe('usageAutoResume settings', () => {
  it('defaults to delegates / 8h / 3', () => {
    const s = getCompactionSettings(getDb());
    expect(s.usageAutoResume).toBe('delegates');
    expect(s.usageAutoResumeMaxDeferMs).toBe(AGENT_DEFER_MAX_MS);
    expect(s.usageAutoResumeMaxAttempts).toBe(3);
  });

  it('rejects reserved mesh-style junk on the enum by falling back to delegates', () => {
    const db = getDb();
    db.prepare("UPDATE settings SET value = json_set(value, '$.usageAutoResume', 'project') WHERE key = 'compaction'").run();
    expect(getCompactionSettings(db).usageAutoResume).toBe('delegates');
  });

  it('clamps maxDeferMs and maxAttempts', () => {
    const s = updateCompactionSettings(getDb(), {
      usageAutoResumeMaxDeferMs: -1,
      usageAutoResumeMaxAttempts: 99,
    } as never);
    expect(s.usageAutoResumeMaxDeferMs).toBe(0);
    expect(s.usageAutoResumeMaxAttempts).toBe(10);
  });
});
