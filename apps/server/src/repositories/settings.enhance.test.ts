import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ENHANCE_DEFAULTS, defaultVoiceProviderValues } from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { getEnhanceSettings, updateEnhanceSettings } from './settings.js';

describe('enhance settings', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });
  afterEach(() => db.close());

  it('returns ENHANCE_DEFAULTS when no row exists', () => {
    const s = getEnhanceSettings(db);
    expect(s.provider).toBe(ENHANCE_DEFAULTS.provider);
    expect(s.model).toBe('');
    expect(s.quickSelectedPromptId).toBe('enhance-quick-1');
    expect(s.contextSelectedPromptId).toBe('enhance-context-1');
    expect(s.quickPrompts).toEqual([]);
    expect(s.contextPrompts).toEqual([]);
    expect(s.providerValues).toEqual(defaultVoiceProviderValues());
    expect(s.describeEnabled).toBe(true);
  });

  it('persists describeEnabled false and reads it back', () => {
    updateEnhanceSettings(db, { describeEnabled: false });
    expect(getEnhanceSettings(db).describeEnabled).toBe(false);
    updateEnhanceSettings(db, { describeEnabled: true });
    expect(getEnhanceSettings(db).describeEnabled).toBe(true);
  });

  it('treats a missing describeEnabled on an old row as true', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enhance', ?)").run(JSON.stringify({
      provider: 'lmstudio',
      model: '',
      baseUrl: '',
      apiKey: '',
      timeoutSecs: 60,
    }));
    expect(getEnhanceSettings(db).describeEnabled).toBe(true);
  });

  it('round-trips patches and mirrors providerValues to top-level fields', () => {
    updateEnhanceSettings(db, {
      model: 'test-model',
      baseUrl: 'http://127.0.0.1:9999/v1',
      apiKey: 'k',
    });
    const s = getEnhanceSettings(db);
    expect(s.model).toBe('test-model');
    expect(s.baseUrl).toBe('http://127.0.0.1:9999/v1');
    expect(s.apiKey).toBe('k');
    expect(s.providerValues.lmstudio.model).toBe('test-model');
    expect(s.providerValues.lmstudio.baseUrl).toBe('http://127.0.0.1:9999/v1');
    expect(s.providerValues.lmstudio.apiKey).toBe('k');
  });

  it('persists prompt libraries and selected ids', () => {
    updateEnhanceSettings(db, {
      quickPrompts: [{ id: 'q1', name: 'Custom Q', text: 'quick custom' }],
      quickSelectedPromptId: 'q1',
      contextSelectedPromptId: 'enhance-context-1',
    });
    const s = getEnhanceSettings(db);
    expect(s.quickPrompts).toEqual([{ id: 'q1', name: 'Custom Q', text: 'quick custom' }]);
    expect(s.quickSelectedPromptId).toBe('q1');
    expect(s.contextSelectedPromptId).toBe('enhance-context-1');
  });

  it('switches provider and mirrors its stored values', () => {
    updateEnhanceSettings(db, {
      providerValues: {
        ...defaultVoiceProviderValues(),
        openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', apiKey: 'sk-x' },
      },
    });
    updateEnhanceSettings(db, { provider: 'openai' });
    const s = getEnhanceSettings(db);
    expect(s.provider).toBe('openai');
    expect(s.model).toBe('gpt-4o-mini');
    expect(s.apiKey).toBe('sk-x');
  });
});
