import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { getVoiceSettings, updateVoiceSettings } from './settings.js';
import { DEFAULT_VOICE_CLEANUP_PROMPT, defaultVoiceProviderValues } from '@tierwyn/shared';

describe('getVoiceSettings — prompt library', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });
  afterEach(() => db.close());

  it('seeds selectedPromptId builtin-1 and an empty prompts array', () => {
    const v = getVoiceSettings(db);
    expect(v.cleanup.selectedPromptId).toBe('builtin-1');
    expect(v.cleanup.prompts).toEqual([]);
    expect(v.cleanup.provider).toBe('lmstudio');
    expect(v.cleanup.providerValues).toEqual(defaultVoiceProviderValues());
  });

  it('seeds TTS summarize prompt defaults without touching STT prompts', () => {
    const v = getVoiceSettings(db);
    expect(v.tts.selectedPromptId).toBe('tts-builtin-1');
    expect(v.tts.prompts).toEqual([]);
  });

  it('fills missing TTS prompt fields on read for legacy voice rows', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice', ?)")
      .run(JSON.stringify({
        cleanup: {
          enabled: false,
          provider: 'lmstudio',
          baseUrl: 'x',
          apiKey: '',
          model: '',
          systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT,
          timeoutSecs: 20,
          selectedPromptId: 'builtin-1',
          prompts: [],
        },
        tts: {
          enabled: true,
          provider: 'browser',
          piperUrl: 'http://127.0.0.1:5000',
          piperVoice: 'en_US-lessac-medium',
          kokoroUrl: 'http://127.0.0.1:8880',
          kokoroVoice: 'af_heart',
        },
      }));
    const v = getVoiceSettings(db);
    expect(v.tts.selectedPromptId).toBe('tts-builtin-1');
    expect(v.tts.prompts).toEqual([]);
    expect(v.cleanup.selectedPromptId).toBe('builtin-1');
  });

  it('migrates a legacy custom systemPrompt into an imported prompt', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice', ?)")
      .run(JSON.stringify({
        cleanup: { enabled: true, baseUrl: 'x', apiKey: '', model: 'm', systemPrompt: 'MY OLD PROMPT', timeoutSecs: 20 },
      }));
    const v = getVoiceSettings(db);
    expect(v.cleanup.selectedPromptId).toBe('imported-legacy');
    expect(v.cleanup.prompts).toEqual([{ id: 'imported-legacy', name: 'Imported (legacy)', text: 'MY OLD PROMPT' }]);
  });

  it('does NOT import a legacy prompt equal to the default', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice', ?)")
      .run(JSON.stringify({
        cleanup: { enabled: false, baseUrl: 'x', apiKey: '', model: '', systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT, timeoutSecs: 20 },
      }));
    const v = getVoiceSettings(db);
    expect(v.cleanup.selectedPromptId).toBe('builtin-1');
    expect(v.cleanup.prompts).toEqual([]);
  });

  it('persists a prompts array replacement via updateVoiceSettings', () => {
    updateVoiceSettings(db, { cleanup: { prompts: [{ id: 'a', name: 'A', text: 'ta' }], selectedPromptId: 'a' } });
    const v = getVoiceSettings(db);
    expect(v.cleanup.prompts).toEqual([{ id: 'a', name: 'A', text: 'ta' }]);
    expect(v.cleanup.selectedPromptId).toBe('a');
  });

  it('reconstructs providerValues when missing and mirrors top-level to active provider', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice', ?)")
      .run(JSON.stringify({
        cleanup: {
          enabled: true,
          provider: 'gemini',
          baseUrl: 'https://custom.gemini/api',
          apiKey: 'gem-key',
          model: 'gemini-custom',
          systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT,
          timeoutSecs: 20,
          selectedPromptId: 'builtin-1',
          prompts: [],
        },
      }));
    const v = getVoiceSettings(db);
    expect(v.cleanup.providerValues.gemini).toEqual({
      baseUrl: 'https://custom.gemini/api',
      model: 'gemini-custom',
      apiKey: 'gem-key',
    });
    expect(v.cleanup.baseUrl).toBe('https://custom.gemini/api');
    expect(v.cleanup.model).toBe('gemini-custom');
    expect(v.cleanup.apiKey).toBe('gem-key');
    expect(v.cleanup.providerValues.lmstudio.baseUrl).toBe('http://localhost:1234/v1');
  });

  it('keeps per-provider values when switching provider via updateVoiceSettings', () => {
    updateVoiceSettings(db, {
      cleanup: {
        providerValues: {
          ...defaultVoiceProviderValues(),
          lmstudio: { baseUrl: 'http://192.0.2.10:1234/v1', model: 'local-model', apiKey: 'lm-key' },
          gemini: { baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-2.0-flash', apiKey: 'gem-key' },
        },
      },
    });
    updateVoiceSettings(db, { cleanup: { provider: 'gemini' } });
    expect(getVoiceSettings(db).cleanup.apiKey).toBe('gem-key');
    updateVoiceSettings(db, { cleanup: { provider: 'lmstudio' } });
    const v = getVoiceSettings(db);
    expect(v.cleanup.baseUrl).toBe('http://192.0.2.10:1234/v1');
    expect(v.cleanup.apiKey).toBe('lm-key');
    expect(v.cleanup.model).toBe('local-model');
  });
});
