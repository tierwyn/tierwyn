import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { GENERAL_DEFAULTS, seedDefaultSettings } from '../db/seed.js';
import { getGeneralSettings, updateGeneralSettings } from './settings.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  return db;
}

describe('updateGeneralSettings conversationRetentionDays', () => {
  it('defaults to 0 (keep forever) on a fresh install', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.conversationRetentionDays).toBe(0);
    expect(getGeneralSettings(db).conversationRetentionDays).toBe(0);
  });

  it('rejects −1', () => {
    const db = freshDb();
    expect(() => updateGeneralSettings(db, { conversationRetentionDays: -1 })).toThrow(/0–3650/);
  });

  it('rejects 4000', () => {
    const db = freshDb();
    expect(() => updateGeneralSettings(db, { conversationRetentionDays: 4000 })).toThrow(/0–3650/);
  });

  it('accepts 90', () => {
    const db = freshDb();
    const updated = updateGeneralSettings(db, { conversationRetentionDays: 90 });
    expect(updated.conversationRetentionDays).toBe(90);
    expect(getGeneralSettings(db).conversationRetentionDays).toBe(90);
  });

  it('rejects a non-integer', () => {
    const db = freshDb();
    expect(() => updateGeneralSettings(db, { conversationRetentionDays: 1.5 })).toThrow(/integer/);
  });
});

describe('grokBotAutoStart', () => {
  it('defaults to keep-running on a legacy row with no key', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.grokBotAutoStart).toBe('keep-running');
    expect(getGeneralSettings(db).grokBotAutoStart).toBe('keep-running');
  });

  it('rejects an invalid value', () => {
    const db = freshDb();
    expect(() => updateGeneralSettings(db, { grokBotAutoStart: 'always' as 'off' })).toThrow(
      /off \| on-demand \| keep-running/,
    );
  });

  it('persists a valid value', () => {
    const db = freshDb();
    const updated = updateGeneralSettings(db, { grokBotAutoStart: 'on-demand' });
    expect(updated.grokBotAutoStart).toBe('on-demand');
    expect(getGeneralSettings(db).grokBotAutoStart).toBe('on-demand');
  });
});
