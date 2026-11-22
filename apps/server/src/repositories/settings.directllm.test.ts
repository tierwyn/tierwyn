import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  DIRECT_LLM_DEFAULT_LABELS,
  SIDECAR_SITE_DEFAULT_PROFILE,
  VOICE_PROVIDER_PRESETS,
  directConnectionConfigured,
  enhanceConfigured,
  ttsSummarizeConfigured,
} from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import {
  createDirectLlmProfile,
  deleteDirectLlmProfile,
  getEnhanceSettings,
  getSidecarLlmSettings,
  getVoiceSettings,
  listDirectLlmProfiles,
  updateDirectLlmProfile,
  updateEnhanceSettings,
  updateSidecarLlmSettings,
  updateVoiceSettings,
} from './settings.js';

describe('direct llm profiles', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });
  afterEach(() => db.close());

  it('listDirectLlmProfiles returns two profiles with default labels when no rows exist', () => {
    const profiles = listDirectLlmProfiles(db);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.id)).toEqual(['cleanup', 'enhancer']);
    expect(profiles[0]!.label).toBe(DIRECT_LLM_DEFAULT_LABELS.cleanup);
    expect(profiles[1]!.label).toBe(DIRECT_LLM_DEFAULT_LABELS.enhancer);
  });

  it('values mirror voice.cleanup / enhance after those blobs are written', () => {
    updateVoiceSettings(db, {
      cleanup: { model: 'voice-m', baseUrl: 'http://127.0.0.1:1111/v1', apiKey: 'vk', timeoutSecs: 22 },
    });
    updateEnhanceSettings(db, {
      model: 'enh-m', baseUrl: 'http://127.0.0.1:2222/v1', apiKey: 'ek', timeoutSecs: 44,
    });
    const [cleanup, enhancer] = listDirectLlmProfiles(db);
    const voice = getVoiceSettings(db).cleanup;
    const enhance = getEnhanceSettings(db);
    expect(cleanup!.model).toBe(voice.model);
    expect(cleanup!.baseUrl).toBe(voice.baseUrl);
    expect(cleanup!.apiKey).toBe(voice.apiKey);
    expect(cleanup!.timeoutSecs).toBe(voice.timeoutSecs);
    expect(enhancer!.model).toBe(enhance.model);
    expect(enhancer!.baseUrl).toBe(enhance.baseUrl);
    expect(enhancer!.apiKey).toBe(enhance.apiKey);
    expect(enhancer!.timeoutSecs).toBe(enhance.timeoutSecs);
  });

  it("updateDirectLlmProfile('cleanup', { model }) is visible through getVoiceSettings", () => {
    updateDirectLlmProfile(db, 'cleanup', { model: 'from-profile' });
    expect(getVoiceSettings(db).cleanup.model).toBe('from-profile');
    expect(listDirectLlmProfiles(db)[0]!.model).toBe('from-profile');
  });

  it("updateDirectLlmProfile('enhancer', …) is visible through getEnhanceSettings", () => {
    updateDirectLlmProfile(db, 'enhancer', { model: 'enh-from-profile', timeoutSecs: 15 });
    const enhance = getEnhanceSettings(db);
    expect(enhance.model).toBe('enh-from-profile');
    expect(enhance.timeoutSecs).toBe(15);
  });

  it('unknown id throws', () => {
    expect(() => updateDirectLlmProfile(db, 'nope', { model: 'x' }))
      .toThrow(/unknown direct llm profile: nope/);
  });

  it('configured matches enhanceConfigured / ttsSummarizeConfigured for the same input', () => {
    const empty = listDirectLlmProfiles(db);
    expect(empty[0]!.configured).toBe(ttsSummarizeConfigured(getVoiceSettings(db).cleanup));
    expect(empty[1]!.configured).toBe(enhanceConfigured(getEnhanceSettings(db)));

    updateVoiceSettings(db, { cleanup: { model: 'voice-m', baseUrl: 'http://127.0.0.1:1234/v1' } });
    updateEnhanceSettings(db, { model: 'enh-m', baseUrl: 'http://127.0.0.1:1234/v1' });
    const ready = listDirectLlmProfiles(db);
    expect(ready[0]!.configured).toBe(true);
    expect(ready[1]!.configured).toBe(true);
    expect(ready[0]!.configured).toBe(ttsSummarizeConfigured(getVoiceSettings(db).cleanup));
    expect(ready[1]!.configured).toBe(enhanceConfigured(getEnhanceSettings(db)));
  });

  it('stores a custom profileLabel and reads it back as label', () => {
    const next = updateDirectLlmProfile(db, 'cleanup', { label: 'Local Gemma' });
    expect(next[0]!.label).toBe('Local Gemma');
    expect(getVoiceSettings(db).cleanup.profileLabel).toBe('Local Gemma');
  });

  it('createDirectLlmProfile appends a third profile after the built-ins', () => {
    const { profiles, createdId } = createDirectLlmProfile(db);
    expect(createdId).toBeTruthy();
    expect(profiles.map((p) => p.id)).toEqual(['cleanup', 'enhancer', createdId]);
    expect(listDirectLlmProfiles(db).map((p) => p.id)).toEqual(['cleanup', 'enhancer', createdId]);
  });

  it('created profile uses LM Studio defaults and is unconfigured', () => {
    const { createdId, profiles } = createDirectLlmProfile(db);
    const created = profiles.find((p) => p.id === createdId)!;
    expect(created.provider).toBe('lmstudio');
    expect(created.baseUrl).toBe(VOICE_PROVIDER_PRESETS.lmstudio.baseUrl);
    expect(created.model).toBe('');
    expect(created.apiKey).toBe('');
    expect(created.timeoutSecs).toBe(60);
    expect(created.configured).toBe(false);
    expect(Object.keys(created.providerValues).sort()).toEqual(['gemini', 'lmstudio', 'ollama', 'openai']);
  });

  it('two createDirectLlmProfile calls in the same millisecond produce distinct ids', () => {
    const now = Date.now();
    const realNow = Date.now;
    Date.now = () => now;
    try {
      const a = createDirectLlmProfile(db).createdId;
      const b = createDirectLlmProfile(db).createdId;
      expect(a).not.toBe(b);
    } finally {
      Date.now = realNow;
    }
  });

  it('createDirectLlmProfile honours label and provider and mirrors the preset', () => {
    const { createdId, profiles } = createDirectLlmProfile(db, {
      label: 'Gemini Flash',
      provider: 'gemini',
    });
    const created = profiles.find((p) => p.id === createdId)!;
    expect(created.label).toBe('Gemini Flash');
    expect(created.provider).toBe('gemini');
    expect(created.baseUrl).toBe(VOICE_PROVIDER_PRESETS.gemini.baseUrl);
    expect(created.model).toBe(VOICE_PROVIDER_PRESETS.gemini.model);
  });

  it('default label uniquification: New connection, New connection 2, New connection 3', () => {
    const a = createDirectLlmProfile(db).profiles.find((p) => p.id !== 'cleanup' && p.id !== 'enhancer')!;
    const b = createDirectLlmProfile(db).profiles.filter((p) => p.id !== 'cleanup' && p.id !== 'enhancer');
    const c = createDirectLlmProfile(db).profiles.filter((p) => p.id !== 'cleanup' && p.id !== 'enhancer');
    expect(a.label).toBe('New connection');
    expect(b.map((p) => p.label).sort()).toEqual(['New connection', 'New connection 2']);
    expect(c.map((p) => p.label).sort()).toEqual(['New connection', 'New connection 2', 'New connection 3']);
  });

  it('updateDirectLlmProfile on an extra round-trips and does not mutate built-in blobs', () => {
    const { createdId } = createDirectLlmProfile(db);
    const voiceBefore = getVoiceSettings(db).cleanup;
    const enhanceBefore = getEnhanceSettings(db);
    const next = updateDirectLlmProfile(db, createdId, {
      model: 'm',
      baseUrl: 'http://x/v1',
      timeoutSecs: 12,
      label: 'L',
    });
    const updated = next.find((p) => p.id === createdId)!;
    expect(updated.model).toBe('m');
    expect(updated.baseUrl).toBe('http://x/v1');
    expect(updated.timeoutSecs).toBe(12);
    expect(updated.label).toBe('L');
    expect(getVoiceSettings(db).cleanup).toEqual(voiceBefore);
    expect(getEnhanceSettings(db)).toEqual(enhanceBefore);
  });

  it('provider switch on an extra profile keeps per-provider memory', () => {
    const { createdId } = createDirectLlmProfile(db, { provider: 'gemini' });
    updateDirectLlmProfile(db, createdId, { model: 'gemini-kept' });
    const afterLm = updateDirectLlmProfile(db, createdId, { provider: 'lmstudio' })
      .find((p) => p.id === createdId)!;
    expect(afterLm.provider).toBe('lmstudio');
    expect(afterLm.baseUrl).toBe(VOICE_PROVIDER_PRESETS.lmstudio.baseUrl);
    expect(afterLm.model).toBe(VOICE_PROVIDER_PRESETS.lmstudio.model);
    expect(afterLm.providerValues.gemini.model).toBe('gemini-kept');
    const back = updateDirectLlmProfile(db, createdId, { provider: 'gemini' })
      .find((p) => p.id === createdId)!;
    expect(back.provider).toBe('gemini');
    expect(back.model).toBe('gemini-kept');
    expect(back.baseUrl).toBe(VOICE_PROVIDER_PRESETS.gemini.baseUrl);
    expect(back.apiKey).toBe('');
  });

  it('configured on an extra profile matches directConnectionConfigured()', () => {
    const { createdId } = createDirectLlmProfile(db);
    const empty = listDirectLlmProfiles(db).find((p) => p.id === createdId)!;
    expect(empty.configured).toBe(false);
    expect(empty.configured).toBe(directConnectionConfigured(empty));
    const ready = updateDirectLlmProfile(db, createdId, {
      model: 'm',
      baseUrl: 'http://127.0.0.1:1234/v1',
    }).find((p) => p.id === createdId)!;
    expect(ready.configured).toBe(true);
    expect(ready.configured).toBe(directConnectionConfigured(ready));
  });

  it('deleteDirectLlmProfile removes an extra; list is back to two', () => {
    const { createdId } = createDirectLlmProfile(db);
    const { profiles } = deleteDirectLlmProfile(db, createdId);
    expect(profiles).toHaveLength(2);
    expect(profiles.map((p) => p.id)).toEqual(['cleanup', 'enhancer']);
    expect(listDirectLlmProfiles(db)).toHaveLength(2);
  });

  it('delete reassigns an explicit direct route to alive[0], not the site default', () => {
    const { createdId } = createDirectLlmProfile(db);
    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: createdId },
      tts: { backend: 'direct', profile: 'cleanup' },
    }, []);
    deleteDirectLlmProfile(db, createdId);
    const sidecar = getSidecarLlmSettings(db);
    const alive = listDirectLlmProfiles(db);
    expect(sidecar.describe.profile).toBe(alive[0]!.id);
    expect(sidecar.describe.profile).toBe('cleanup');
    expect(sidecar.describe.profile).not.toBe(SIDECAR_SITE_DEFAULT_PROFILE.describe);
    expect(sidecar.tts.profile).toBe('cleanup');
  });

  it("delete leaves backend:'agent' rows alone even if profile names the deleted id", () => {
    const { createdId } = createDirectLlmProfile(db);
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'm', profile: createdId },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    deleteDirectLlmProfile(db, createdId);
    const tts = getSidecarLlmSettings(db).tts;
    expect(tts.backend).toBe('agent_oneshot');
    expect(tts.profile).toBe(createdId);
    expect(tts.adapter).toBe('pi');
  });

  it('deletes a built-in and drops it from the list', () => {
    const { profiles } = deleteDirectLlmProfile(db, 'cleanup');
    expect(profiles.map((p) => p.id)).toEqual(['enhancer']);
    expect(listDirectLlmProfiles(db).map((p) => p.id)).toEqual(['enhancer']);
  });

  it('deleting every profile yields an empty list and clears direct route profiles', () => {
    const { createdId } = createDirectLlmProfile(db);
    deleteDirectLlmProfile(db, 'cleanup');
    deleteDirectLlmProfile(db, 'enhancer');
    deleteDirectLlmProfile(db, createdId);
    expect(listDirectLlmProfiles(db)).toEqual([]);
    const sidecar = getSidecarLlmSettings(db);
    expect(sidecar.transcribe.profile).toBeUndefined();
    expect(sidecar.enhance.profile).toBeUndefined();
    expect(sidecar.tts.profile).toBeUndefined();
    expect(sidecar.describe.profile).toBeUndefined();
  });

  it('deleting cleanup preserves prompts and selectedPromptId and blanks credentials across all providers', () => {
    updateVoiceSettings(db, {
      cleanup: {
        provider: 'openai',
        baseUrl: 'http://127.0.0.1:1111/v1',
        apiKey: 'secret',
        model: 'voice-m',
        selectedPromptId: 'builtin-1',
        prompts: [{ id: 'p1', name: 'Keep me', text: 'hello' }],
      },
    });
    deleteDirectLlmProfile(db, 'cleanup');
    const cleanup = getVoiceSettings(db).cleanup;
    expect(cleanup.prompts).toEqual([{ id: 'p1', name: 'Keep me', text: 'hello' }]);
    expect(cleanup.selectedPromptId).toBe('builtin-1');
    expect(cleanup.baseUrl).toBe('');
    expect(cleanup.apiKey).toBe('');
    expect(cleanup.model).toBe('');
    expect(cleanup.providerValues?.openai?.apiKey).toBe('');
    expect(cleanup.providerValues?.openai?.baseUrl).toBe('');
  });

  it('deleting enhancer preserves quickPrompts and describeEnabled', () => {
    updateEnhanceSettings(db, {
      model: 'enh-m',
      baseUrl: 'http://127.0.0.1:2222/v1',
      apiKey: 'ek',
      describeEnabled: false,
      quickPrompts: [{ id: 'q1', name: 'Keep', text: 'rewrite' }],
    });
    deleteDirectLlmProfile(db, 'enhancer');
    const enhance = getEnhanceSettings(db);
    expect(enhance.quickPrompts).toEqual([{ id: 'q1', name: 'Keep', text: 'rewrite' }]);
    expect(enhance.describeEnabled).toBe(false);
    expect(enhance.baseUrl).toBe('');
    expect(enhance.apiKey).toBe('');
    expect(enhance.model).toBe('');
  });

  it('updateDirectLlmProfile of a deleted built-in throws unknown', () => {
    deleteDirectLlmProfile(db, 'cleanup');
    expect(() => updateDirectLlmProfile(db, 'cleanup', { model: 'x' }))
      .toThrow(/unknown direct llm profile: cleanup/);
  });

  it('deleting the implicit site default repoints unset routes to the first surviving profile', () => {
    const { createdId } = createDirectLlmProfile(db);
    // transcribe/tts have no profile key — implicit default is cleanup
    deleteDirectLlmProfile(db, 'cleanup');
    const sidecar = getSidecarLlmSettings(db);
    expect(sidecar.transcribe.profile).toBe('enhancer');
    expect(sidecar.tts.profile).toBe('enhancer');
    expect(sidecar.enhance.profile).toBeUndefined();
    expect(sidecar.describe.profile).toBeUndefined();
    expect(listDirectLlmProfiles(db).map((p) => p.id)).toEqual(['enhancer', createdId]);
  });

  it('deleteDirectLlmProfile of an unknown id throws', () => {
    expect(() => deleteDirectLlmProfile(db, 'ghost'))
      .toThrow(/unknown direct llm profile: ghost/);
  });

  it('corrupt direct_llm_profiles row makes listDirectLlmProfiles return just the built-ins', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('direct_llm_profiles', ?)").run('not json');
    expect(listDirectLlmProfiles(db).map((p) => p.id)).toEqual(['cleanup', 'enhancer']);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('direct_llm_profiles', ?)").run('{"a":1}');
    expect(listDirectLlmProfiles(db).map((p) => p.id)).toEqual(['cleanup', 'enhancer']);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('direct_llm_profiles', ?)").run('[{"id":"junk"}]');
    expect(listDirectLlmProfiles(db).map((p) => p.id)).toEqual(['cleanup', 'enhancer']);
  });
});
