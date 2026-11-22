import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import {
  getEnhanceSettings,
  getSidecarLlmSettings,
  getVoiceSettings,
  getBtwSettings,
  updateBtwSettings,
  updateEnhanceSettings,
  updateSidecarLlmSettings,
  updateVoiceSettings,
} from './settings.js';
import { sidecarDeps, sidecarSiteReady } from '../sidecar.js';
import { catalogue } from '../catalogue.js';
import { registry } from '../registry.js';
import { SIDECAR_LLM_DEFAULTS } from '@tierwyn/shared';

const CAPABLE = [
  { type: 'pi', supportsToolsOff: true, supportsReadOnly: false },
  { type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true },
];

describe('sidecar llm settings', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });
  afterEach(() => db.close());

  it('returns direct defaults for all four sites when no row exists', () => {
    const s = getSidecarLlmSettings(db);
    expect(s.transcribe).toEqual({ backend: 'direct', enabled: false });
    expect(s.enhance).toEqual({ backend: 'direct', enabled: true });
    expect(s.tts).toEqual({ backend: 'direct', enabled: true });
    expect(s.describe).toEqual({ backend: 'direct', enabled: true });
    expect(s.btw).toEqual({
      backend: 'agent_readonly', adapter: 'claude-code', model: 'claude-haiku-4-5', enabled: true,
    });
  });

  it('stored btw route on an unregistered adapter falls back to default', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      btw: { backend: 'agent_readonly', adapter: 'nonexistent-agent', model: 'x' },
    }));
    expect(getSidecarLlmSettings(db).btw.adapter).toBe('claude-code');
  });

  it('round-trips one site to agent without changing the other three', () => {
    const next = updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, CAPABLE);
    expect(next.tts).toEqual({ backend: 'agent_oneshot', adapter: 'pi', model: 'zai/glm-5.3', enabled: true });
    expect(next.transcribe).toEqual({ backend: 'direct', enabled: false });
    expect(next.enhance).toEqual({ backend: 'direct', enabled: true });
    expect(next.describe).toEqual({ backend: 'direct', enabled: true });

    const reread = getSidecarLlmSettings(db);
    expect(reread.tts).toEqual({ backend: 'agent_oneshot', adapter: 'pi', model: 'zai/glm-5.3', enabled: true });
    expect(reread.transcribe.backend).toBe('direct');
  });

  it('throws on an unknown site key', () => {
    expect(() => updateSidecarLlmSettings(db, {
      nope: { backend: 'direct' },
    } as never, CAPABLE)).toThrow(/unknown sidecar site: nope/);
  });

  it('persists an agent row with no model and leaves it not-ready', () => {
    const next = updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi' },
    }, CAPABLE);
    expect(next.tts).toEqual({ backend: 'agent_oneshot', adapter: 'pi', enabled: true });
    expect(sidecarSiteReady(db, 'tts')).toBe(false);
    expect(getSidecarLlmSettings(db).tts).toEqual({ backend: 'agent_oneshot', adapter: 'pi', enabled: true });
  });

  it('throws when adapter is not in the capable set', () => {
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'openclaw', model: 'x' },
    }, CAPABLE)).toThrow(/adapter openclaw does not support one-shot/);
  });

  it('throws on an invalid backend', () => {
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'nope' as never },
    }, CAPABLE)).toThrow(/backend/);
  });

  it("accepts legacy backend 'gemini' and canonicalises it to 'direct'", () => {
    const next = updateSidecarLlmSettings(db, {
      tts: { backend: 'gemini' as never },
    }, CAPABLE);
    expect(next.tts.backend).toBe('direct');
    expect(getSidecarLlmSettings(db).tts.backend).toBe('direct');
  });

  it('persists an agent row with no adapter', () => {
    const next = updateSidecarLlmSettings(db, {
      enhance: { backend: 'agent' },
    }, CAPABLE);
    expect(next.enhance).toEqual({ backend: 'agent_oneshot', enabled: true });
    expect(sidecarSiteReady(db, 'enhance')).toBe(false);
  });

  it('round-trips profile id and tolerates an unknown profile id', () => {
    const known = updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: 'cleanup' },
    }, CAPABLE);
    expect(known.describe).toEqual({ backend: 'direct', profile: 'cleanup', enabled: true });

    const unknown = updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: 'future-third' },
    }, CAPABLE);
    expect(unknown.describe.profile).toBe('future-third');
    expect(getSidecarLlmSettings(db).describe.profile).toBe('future-third');
  });

  it("reads a legacy row written with backend:'gemini' as 'direct'", () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      transcribe: { backend: 'gemini' },
      enhance: { backend: 'gemini', adapter: 'pi', model: 'kept' },
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
      describe: { backend: 'gemini' },
    }));
    const s = getSidecarLlmSettings(db);
    expect(s.transcribe).toEqual({ backend: 'direct', enabled: false });
    expect(s.enhance).toEqual({ backend: 'direct', adapter: 'pi', model: 'kept', enabled: true });
    expect(s.tts).toEqual({ backend: 'agent_oneshot', adapter: 'pi', model: 'zai/glm-5.3', enabled: true });
    expect(s.describe).toEqual({ backend: 'direct', enabled: true });
  });

  // JSON.stringify drops `model: undefined` on adapter pick, so the wire body has no model key.
  // Agent patches must take adapter/model from the payload only — absent ⇒ cleared.
  it('agent adapter change without a model key clears the previous adapter\'s model', () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, CAPABLE);
    const next = updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'copilot' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }, { type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }, { type: 'copilot', supportsToolsOff: true, supportsReadOnly: false }]);
    expect(next.tts).toEqual({ backend: 'agent_oneshot', adapter: 'copilot', enabled: true });
    expect('model' in next.tts).toBe(false);
    expect(sidecarSiteReady(db, 'tts')).toBe(false);
    expect(getSidecarLlmSettings(db).tts).toEqual({ backend: 'agent_oneshot', adapter: 'copilot', enabled: true });
  });

  it('toggling to direct retains adapter and model when those keys are omitted', () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, CAPABLE);
    const next = updateSidecarLlmSettings(db, {
      tts: { backend: 'direct' },
    }, CAPABLE);
    expect(next.tts).toEqual({ backend: 'direct', adapter: 'pi', model: 'zai/glm-5.3', enabled: true });
    expect(getSidecarLlmSettings(db).tts).toEqual({ backend: 'direct', adapter: 'pi', model: 'zai/glm-5.3', enabled: true });
  });

  it('enabled round-trips for enhance and tts', () => {
    const next = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', enabled: false },
      tts: { backend: 'direct', enabled: false },
    }, CAPABLE);
    expect(next.enhance.enabled).toBe(false);
    expect(next.tts.enabled).toBe(false);
    const reread = getSidecarLlmSettings(db);
    expect(reread.enhance.enabled).toBe(false);
    expect(reread.tts.enabled).toBe(false);

    const back = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', enabled: true },
      tts: { backend: 'direct', enabled: true },
    }, CAPABLE);
    expect(back.enhance.enabled).toBe(true);
    expect(back.tts.enabled).toBe(true);
  });

  it('transcribe.enabled reflects voice.cleanup.enabled and writing it flips the voice flag', () => {
    expect(getSidecarLlmSettings(db).transcribe.enabled).toBe(false);
    expect(getVoiceSettings(db).cleanup.enabled).toBe(false);

    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'direct', enabled: true },
    }, CAPABLE);
    expect(getVoiceSettings(db).cleanup.enabled).toBe(true);
    expect(getSidecarLlmSettings(db).transcribe.enabled).toBe(true);

    updateVoiceSettings(db, { cleanup: { enabled: false } });
    expect(getSidecarLlmSettings(db).transcribe.enabled).toBe(false);
  });

  it('describe.enabled reflects enhance.describeEnabled and writing it flips the enhance flag', () => {
    expect(getSidecarLlmSettings(db).describe.enabled).toBe(true);
    expect(getEnhanceSettings(db).describeEnabled).not.toBe(false);

    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', enabled: false },
    }, CAPABLE);
    expect(getEnhanceSettings(db).describeEnabled).toBe(false);
    expect(getSidecarLlmSettings(db).describe.enabled).toBe(false);

    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', enabled: true },
    }, CAPABLE);
    expect(getEnhanceSettings(db).describeEnabled).toBe(true);
    expect(getSidecarLlmSettings(db).describe.enabled).toBe(true);
  });

  it('persisted sidecarLlm JSON has no enabled key for transcribe or describe', () => {
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'direct', enabled: true },
      describe: { backend: 'direct', enabled: false },
      enhance: { backend: 'direct', enabled: false },
      tts: { backend: 'direct', enabled: true },
    }, CAPABLE);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string };
    const parsed = JSON.parse(row.value) as {
      transcribe?: { enabled?: unknown };
      describe?: { enabled?: unknown };
      enhance?: { enabled?: unknown };
      tts?: { enabled?: unknown };
    };
    expect('enabled' in (parsed.transcribe ?? {})).toBe(false);
    expect('enabled' in (parsed.describe ?? {})).toBe(false);
    expect(parsed.enhance?.enabled).toBe(false);
    expect(parsed.tts?.enabled).toBe(true);
  });

  it('omitting enabled on a direct patch retains the stored value', () => {
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', enabled: false },
      tts: { backend: 'direct', enabled: false },
    }, CAPABLE);
    const next = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', profile: 'cleanup' },
      tts: { backend: 'direct' },
    }, CAPABLE);
    expect(next.enhance.enabled).toBe(false);
    expect(next.enhance.profile).toBe('cleanup');
    expect(next.tts.enabled).toBe(false);
  });

  it('a rejected multi-site patch leaves legacy flags unchanged (atomic validation)', () => {
    const initialCleanup = getVoiceSettings(db).cleanup.enabled;
    expect(() => {
      updateSidecarLlmSettings(db, {
        transcribe: { backend: 'direct', enabled: !initialCleanup },
        tts: { backend: 'agent', adapter: 'not-capable' },
      }, CAPABLE);
    }).toThrow(/adapter not-capable does not support one-shot/);
    expect(getVoiceSettings(db).cleanup.enabled).toBe(initialCleanup);
  });

  it('a stored sidecarLlm blob without a commit key defaults commit to direct/enabled', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      transcribe: { backend: 'direct' },
      enhance: { backend: 'direct' },
      tts: { backend: 'direct' },
      describe: { backend: 'direct' },
    }));
    const s = getSidecarLlmSettings(db);
    expect(s.commit).toEqual({ backend: 'direct', enabled: true });
  });

  it('updateSidecarLlmSettings({ commit }) round-trips without disturbing the other four', () => {
    const next = updateSidecarLlmSettings(db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, CAPABLE);
    expect(next.commit).toEqual({
      backend: 'agent_oneshot', adapter: 'pi', model: 'zai/glm-5.3', enabled: true,
    });
    expect(next.transcribe.backend).toBe('direct');
    expect(next.enhance.backend).toBe('direct');
    expect(next.tts.backend).toBe('direct');
    expect(next.describe.backend).toBe('direct');
    expect(getSidecarLlmSettings(db).commit).toEqual({
      backend: 'agent_oneshot', adapter: 'pi', model: 'zai/glm-5.3', enabled: true,
    });
  });

  it('T1: write agent, read back agent_oneshot', () => {
    const next = updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'm' },
    }, CAPABLE);
    expect(next.tts.backend).toBe('agent_oneshot');
  });

  it('T2: seed blob with agent; read normalises, disk stays agent until save', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      tts: { backend: 'agent', adapter: 'pi', model: 'm' },
    }));
    expect(getSidecarLlmSettings(db).tts.backend).toBe('agent_oneshot');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string };
    expect(JSON.parse(row.value).tts.backend).toBe('agent');
  });

  it('T4: write agent_readonly + read-only-capable adapter persists', () => {
    const next = updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, CAPABLE);
    expect(next.commit).toEqual({
      backend: 'agent_readonly', adapter: 'claude-code', model: 'm', enabled: true,
    });
  });

  it('T5: write agent_readonly + tools-off-only adapter throws; blob unchanged', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'direct' },
    }, CAPABLE);
    const before = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string } | undefined;
    expect(() => updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'pi', model: 'm' },
    }, CAPABLE)).toThrow(/does not support read-only one-shot/);
    const after = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string } | undefined;
    expect(after?.value).toBe(before?.value);
  });

  it('write agent_readonly on transcribe or tts throws; does not support read-only mode', () => {
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, CAPABLE)).toThrow(/sidecar site tts does not support read-only mode/);

    expect(() => updateSidecarLlmSettings(db, {
      transcribe: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, CAPABLE)).toThrow(/sidecar site transcribe does not support read-only mode/);
  });

  it('coerces legacy agent_readonly on transcribe/tts to agent_oneshot', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      transcribe: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
      tts: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }));
    const settings = getSidecarLlmSettings(db);
    expect(settings.transcribe.backend).toBe('agent_oneshot');
    expect(settings.tts.backend).toBe('agent_oneshot');
  });

  it('T6: write agent_oneshot + unknown adapter throws', () => {
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'agent_oneshot', adapter: 'openclaw', model: 'x' },
    }, CAPABLE)).toThrow(/adapter openclaw does not support one-shot/);
  });

  it('T7: write nonsense backend throws', () => {
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'nonsense' as never },
    }, CAPABLE)).toThrow(/invalid sidecar backend: nonsense/);
  });

  it('T8: agent_readonly → direct → agent_readonly retains adapter/model via payload rules', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, CAPABLE);
    const toDirect = updateSidecarLlmSettings(db, {
      commit: { backend: 'direct' },
    }, CAPABLE);
    expect(toDirect.commit).toEqual({
      backend: 'direct', adapter: 'claude-code', model: 'm', enabled: true,
    });
    // Agent patches take adapter/model from payload only — omitting them clears.
    const back = updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, CAPABLE);
    expect(back.commit.backend).toBe('agent_readonly');
    expect(back.commit.adapter).toBe('claude-code');
    expect(back.commit.model).toBe('m');
  });

  it('T9: derived-enabled sites with agent backend still buffer legacy writes after validation', () => {
    const initialCleanup = getVoiceSettings(db).cleanup.enabled;
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'agent_oneshot', adapter: 'pi', model: 'm', enabled: !initialCleanup },
    }, CAPABLE);
    expect(getVoiceSettings(db).cleanup.enabled).toBe(!initialCleanup);
    expect(getSidecarLlmSettings(db).transcribe.backend).toBe('agent_oneshot');
  });

  it('round-trips enhance timeoutSecs and persists it on the sidecarLlm row', () => {
    const next = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: 90 },
    }, CAPABLE);
    expect(next.enhance.timeoutSecs).toBe(90);
    expect(getSidecarLlmSettings(db).enhance.timeoutSecs).toBe(90);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string };
    expect(JSON.parse(row.value).enhance.timeoutSecs).toBe(90);
  });

  it('clamps timeoutSecs on write: 1→5, 9999→600, 45.6→46; junk/0/-1/NaN absent', () => {
    const low = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: 1 },
    }, CAPABLE);
    expect(low.enhance.timeoutSecs).toBe(5);

    const high = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: 9999 },
    }, CAPABLE);
    expect(high.enhance.timeoutSecs).toBe(600);

    const rounded = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: 45.6 },
    }, CAPABLE);
    expect(rounded.enhance.timeoutSecs).toBe(46);

    for (const junk of ['abc', 0, -1, NaN] as const) {
      const next = updateSidecarLlmSettings(db, {
        enhance: { backend: 'direct', timeoutSecs: junk as never },
      }, CAPABLE);
      expect('timeoutSecs' in next.enhance).toBe(false);
    }
  });

  it('retain-on-omit keeps timeoutSecs when a later patch omits the key', () => {
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: 90 },
    }, CAPABLE);
    const next = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct' },
    }, CAPABLE);
    expect(next.enhance.timeoutSecs).toBe(90);
    expect(getSidecarLlmSettings(db).enhance.timeoutSecs).toBe(90);
  });

  it('explicit timeoutSecs null clears the override', () => {
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: 90 },
    }, CAPABLE);
    const next = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: null },
    } as never, CAPABLE);
    expect('timeoutSecs' in next.enhance).toBe(false);
    expect('timeoutSecs' in getSidecarLlmSettings(db).enhance).toBe(false);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string };
    expect('timeoutSecs' in (JSON.parse(row.value).enhance ?? {})).toBe(false);
  });

  it('sidecarSiteReady is true for describe/enhance agent_readonly and false for transcribe/tts', () => {
    const origCreate = sidecarDeps.createAdapter;
    sidecarDeps.createAdapter = (() => ({
      oneShot: async () => ({ text: 'x' }),
      oneShotModes: ['none', 'read_only'],
    })) as never;
    try {
      updateVoiceSettings(db, { cleanup: { enabled: true } });
      updateSidecarLlmSettings(db, {
        describe: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
        enhance: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
      }, CAPABLE);
      expect(sidecarSiteReady(db, 'describe')).toBe(true);
      expect(sidecarSiteReady(db, 'enhance')).toBe(true);
      expect(sidecarSiteReady(db, 'transcribe')).toBe(false);
      expect(sidecarSiteReady(db, 'tts')).toBe(false);
    } finally {
      sidecarDeps.createAdapter = origCreate;
    }
  });

  it('reads a hand-written timeoutSecs string as a number and leaves a missing key absent', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      enhance: { backend: 'direct', timeoutSecs: '70' },
      tts: { backend: 'direct' },
    }));
    expect(getSidecarLlmSettings(db).enhance.timeoutSecs).toBe(70);
    expect('timeoutSecs' in getSidecarLlmSettings(db).tts).toBe(false);
  });

  it('transcribe timeout is stored while enabled still routes to voice.cleanup.enabled', () => {
    const next = updateSidecarLlmSettings(db, {
      transcribe: { backend: 'direct', timeoutSecs: 90, enabled: true },
    }, CAPABLE);
    expect(next.transcribe.timeoutSecs).toBe(90);
    expect(next.transcribe.enabled).toBe(true);
    expect(getVoiceSettings(db).cleanup.enabled).toBe(true);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string };
    const parsed = JSON.parse(row.value) as { transcribe?: { timeoutSecs?: number; enabled?: unknown } };
    expect(parsed.transcribe?.timeoutSecs).toBe(90);
    expect('enabled' in (parsed.transcribe ?? {})).toBe(false);
  });

  it('T10: write agent_readonly succeeds for all 4 one-shot capable adapters', () => {
    const allReadOnly = [
      { type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true },
      { type: 'pi', supportsToolsOff: true, supportsReadOnly: true },
      { type: 'cursor', supportsToolsOff: true, supportsReadOnly: true },
      { type: 'copilot', supportsToolsOff: true, supportsReadOnly: true },
    ];
    for (const adapter of ['claude-code', 'pi', 'cursor', 'copilot']) {
      const next = updateSidecarLlmSettings(db, {
        commit: { backend: 'agent_readonly', adapter, model: 'm' },
      }, allReadOnly);
      expect(next.commit).toEqual({
        backend: 'agent_readonly', adapter, model: 'm', enabled: true,
      });
    }
  });

  it('drops malformed prompt objects and non-array prompt blobs from the stored row', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      commit: {
        backend: 'direct',
        prompts: [
          { id: 'ok', name: 'Ok', text: 'T' },
          { id: '', name: 'bad', text: 'x' },
          'not-an-object',
          { id: 'x' },
          null,
          { id: '  ', name: 'ws', text: 'x' },
        ],
      },
      describe: { backend: 'direct', prompts: 'not-an-array' },
    }));
    const s = getSidecarLlmSettings(db);
    expect(s.commit.prompts).toEqual([{ id: 'ok', name: 'Ok', text: 'T' }]);
    expect('prompts' in s.describe).toBe(false);
  });

  it('caps stored prompt text at 10000 chars', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      commit: {
        backend: 'direct',
        prompts: [{ id: 'x', name: 'N', text: 'a'.repeat(10_001) }],
      },
    }));
    const s = getSidecarLlmSettings(db);
    expect(s.commit.prompts?.[0]?.text).toHaveLength(10_000);
  });

  it('clamps a stored maxInputChars below 500 / above 500000', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      commit: { backend: 'direct', maxInputChars: 10 },
      describe: { backend: 'direct', maxInputChars: 9e9 },
    }));
    const s = getSidecarLlmSettings(db);
    expect(s.commit.maxInputChars).toBe(500);
    expect(s.describe.maxInputChars).toBe(500_000);
  });

  it('ignores a non-numeric stored maxInputChars', () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      commit: { backend: 'direct', maxInputChars: 'nope' },
    }));
    expect('maxInputChars' in getSidecarLlmSettings(db).commit).toBe(false);
  });

  it('falls back transcribe prompts + selection to voice.cleanup when the route has none', () => {
    updateVoiceSettings(db, { cleanup: { prompts: [{ id: 'c1', name: 'Mine', text: 'T' }], selectedPromptId: 'c1' } });
    const s = getSidecarLlmSettings(db);
    expect(s.transcribe.prompts).toEqual([{ id: 'c1', name: 'Mine', text: 'T' }]);
    expect(s.transcribe.selectedPromptId).toBe('c1');
  });

  it('falls back tts prompts to voice.tts', () => {
    updateVoiceSettings(db, { tts: { prompts: [{ id: 't1', name: 'Speak', text: 'S' }], selectedPromptId: 't1' } });
    const s = getSidecarLlmSettings(db);
    expect(s.tts.prompts).toEqual([{ id: 't1', name: 'Speak', text: 'S' }]);
    expect(s.tts.selectedPromptId).toBe('t1');
  });

  it('falls back enhance prompts to enhance.quickPrompts and selection to quickSelectedPromptId', () => {
    updateEnhanceSettings(db, {
      quickPrompts: [{ id: 'q1', name: 'Q', text: 'quick' }],
      quickSelectedPromptId: 'q1',
    });
    const s = getSidecarLlmSettings(db);
    expect(s.enhance.prompts).toEqual([{ id: 'q1', name: 'Q', text: 'quick' }]);
    expect(s.enhance.selectedPromptId).toBe('q1');
  });

  it('falls back enhance contextPrompts to enhance.contextPrompts', () => {
    updateEnhanceSettings(db, {
      contextPrompts: [{ id: 'cx1', name: 'Cx', text: 'ctx' }],
      contextSelectedPromptId: 'cx1',
    });
    const s = getSidecarLlmSettings(db);
    expect(s.enhance.contextPrompts).toEqual([{ id: 'cx1', name: 'Cx', text: 'ctx' }]);
    expect(s.enhance.contextSelectedPromptId).toBe('cx1');
  });

  it('does NOT fall back once the route carries its own prompts', () => {
    updateVoiceSettings(db, { cleanup: { prompts: [{ id: 'c1', name: 'Mine', text: 'T' }], selectedPromptId: 'c1' } });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      transcribe: {
        backend: 'direct',
        prompts: [{ id: 'r1', name: 'Route', text: 'R' }],
        selectedPromptId: 'r1',
      },
    }));
    const s = getSidecarLlmSettings(db);
    expect(s.transcribe.prompts).toEqual([{ id: 'r1', name: 'Route', text: 'R' }]);
    expect(s.transcribe.selectedPromptId).toBe('r1');
  });

  it('does not mutate the legacy voice/enhance blobs on read', () => {
    updateVoiceSettings(db, { cleanup: { prompts: [{ id: 'c1', name: 'Mine', text: 'T' }], selectedPromptId: 'c1' } });
    updateEnhanceSettings(db, {
      quickPrompts: [{ id: 'q1', name: 'Q', text: 'quick' }],
      quickSelectedPromptId: 'q1',
    });
    const voiceBefore = JSON.stringify(getVoiceSettings(db));
    const enhanceBefore = JSON.stringify(getEnhanceSettings(db));
    getSidecarLlmSettings(db);
    getSidecarLlmSettings(db);
    expect(JSON.stringify(getVoiceSettings(db))).toBe(voiceBefore);
    expect(JSON.stringify(getEnhanceSettings(db))).toBe(enhanceBefore);
  });

  it('keeps prompts when a later PATCH omits them', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', prompts: [{ id: 'x', name: 'X', text: 'T' }], selectedPromptId: 'x' },
    }, CAPABLE);
    const after = updateSidecarLlmSettings(db, { commit: { backend: 'direct', timeoutSecs: 90 } }, CAPABLE);
    expect(after.commit.prompts).toEqual([{ id: 'x', name: 'X', text: 'T' }]);
    expect(after.commit.selectedPromptId).toBe('x');
    expect(after.commit.timeoutSecs).toBe(90);
  });

  it('clears prompts on an explicit empty array', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', prompts: [{ id: 'x', name: 'X', text: 'T' }], selectedPromptId: 'x' },
    }, CAPABLE);
    const after = updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', prompts: [] },
    }, CAPABLE);
    expect(after.commit.prompts).toEqual([]);
    expect(getSidecarLlmSettings(db).commit.prompts).toEqual([]);
  });

  it('keeps an explicit empty transcribe prompts array instead of re-promoting legacy', () => {
    updateVoiceSettings(db, {
      cleanup: { prompts: [{ id: 'c1', name: 'Mine', text: 'T' }], selectedPromptId: 'c1' },
    });
    expect(getSidecarLlmSettings(db).transcribe.prompts).toEqual([{ id: 'c1', name: 'Mine', text: 'T' }]);
    const after = updateSidecarLlmSettings(db, { transcribe: { backend: 'direct', prompts: [] } }, CAPABLE);
    expect(after.transcribe.prompts).toEqual([]);
    expect(getSidecarLlmSettings(db).transcribe.prompts).toEqual([]);
  });

  it('keeps an explicit empty tts prompts array instead of re-promoting legacy', () => {
    updateVoiceSettings(db, {
      tts: { prompts: [{ id: 't1', name: 'Speak', text: 'S' }], selectedPromptId: 't1' },
    });
    expect(getSidecarLlmSettings(db).tts.prompts).toEqual([{ id: 't1', name: 'Speak', text: 'S' }]);
    const after = updateSidecarLlmSettings(db, { tts: { backend: 'direct', prompts: [] } }, CAPABLE);
    expect(after.tts.prompts).toEqual([]);
    expect(getSidecarLlmSettings(db).tts.prompts).toEqual([]);
  });

  it('keeps explicit empty enhance prompts and contextPrompts instead of re-promoting legacy', () => {
    updateEnhanceSettings(db, {
      quickPrompts: [{ id: 'q1', name: 'Q', text: 'quick' }],
      quickSelectedPromptId: 'q1',
      contextPrompts: [{ id: 'cx1', name: 'Cx', text: 'ctx' }],
      contextSelectedPromptId: 'cx1',
    });
    const promoted = getSidecarLlmSettings(db).enhance;
    expect(promoted.prompts).toEqual([{ id: 'q1', name: 'Q', text: 'quick' }]);
    expect(promoted.contextPrompts).toEqual([{ id: 'cx1', name: 'Cx', text: 'ctx' }]);
    const after = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', prompts: [], contextPrompts: [] },
    }, CAPABLE);
    expect(after.enhance.prompts).toEqual([]);
    expect(after.enhance.contextPrompts).toEqual([]);
    const reread = getSidecarLlmSettings(db).enhance;
    expect(reread.prompts).toEqual([]);
    expect(reread.contextPrompts).toEqual([]);
  });

  it('promotes a freeform voice.cleanup.systemPrompt when no named cleanup prompts exist', () => {
    updateVoiceSettings(db, {
      cleanup: {
        systemPrompt: 'MY FREEFORM PROMPT',
        selectedPromptId: 'ghost',
        prompts: [],
      },
    });
    const s = getSidecarLlmSettings(db).transcribe;
    expect(s.prompts).toEqual([
      { id: 'legacy-systemPrompt', name: 'Legacy cleanup prompt', text: 'MY FREEFORM PROMPT' },
    ]);
    expect(s.selectedPromptId).toBe('legacy-systemPrompt');
  });

  it('rejects a non-array prompts payload without clearing the stored list', () => {
    updateSidecarLlmSettings(db, {
      transcribe: {
        backend: 'direct',
        prompts: [{ id: 'x', name: 'X', text: 'T' }],
        selectedPromptId: 'x',
      },
    }, CAPABLE);
    expect(() => updateSidecarLlmSettings(db, {
      transcribe: { backend: 'direct', prompts: 'garbage' },
    } as never, CAPABLE)).toThrow(/prompts must be an array/);
    expect(getSidecarLlmSettings(db).transcribe.prompts).toEqual([{ id: 'x', name: 'X', text: 'T' }]);
  });

  it('rejects a non-array contextPrompts payload without clearing the stored list', () => {
    updateSidecarLlmSettings(db, {
      enhance: {
        backend: 'direct',
        contextPrompts: [{ id: 'c', name: 'C', text: 'ctx' }],
        contextSelectedPromptId: 'c',
      },
    }, CAPABLE);
    expect(() => updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', contextPrompts: 'garbage' },
    } as never, CAPABLE)).toThrow(/contextPrompts must be an array/);
    expect(getSidecarLlmSettings(db).enhance.contextPrompts).toEqual([{ id: 'c', name: 'C', text: 'ctx' }]);
  });

  it('does not persist other sites\' promoted prompts when PATCHing one site', () => {
    updateVoiceSettings(db, {
      cleanup: { prompts: [{ id: 'c1', name: 'Mine', text: 'T' }], selectedPromptId: 'c1' },
    });
    updateSidecarLlmSettings(db, { commit: { backend: 'direct', timeoutSecs: 90 } }, CAPABLE);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string };
    const parsed = JSON.parse(row.value) as { transcribe?: { prompts?: unknown } };
    expect('prompts' in (parsed.transcribe ?? {})).toBe(false);
    expect(getSidecarLlmSettings(db).transcribe.prompts).toEqual([{ id: 'c1', name: 'Mine', text: 'T' }]);
  });

  it('round-trips maxInputChars and clamps it on write', () => {
    const next = updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', maxInputChars: 10 },
    }, CAPABLE);
    expect(next.commit.maxInputChars).toBe(500);
    const high = updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', maxInputChars: 9e9 },
    }, CAPABLE);
    expect(high.commit.maxInputChars).toBe(500_000);
    const ok = updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', maxInputChars: 8000 },
    }, CAPABLE);
    expect(ok.commit.maxInputChars).toBe(8000);
    expect(getSidecarLlmSettings(db).commit.maxInputChars).toBe(8000);
  });

  it('keeps maxInputChars when a later PATCH omits it; clears it on explicit null', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', maxInputChars: 8000 },
    }, CAPABLE);
    const kept = updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', timeoutSecs: 90 },
    }, CAPABLE);
    expect(kept.commit.maxInputChars).toBe(8000);
    const cleared = updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', maxInputChars: null },
    } as never, CAPABLE);
    expect('maxInputChars' in cleared.commit).toBe(false);
    expect('maxInputChars' in getSidecarLlmSettings(db).commit).toBe(false);
  });

  it('round-trips enhance contextPrompts independently of prompts', () => {
    const next = updateSidecarLlmSettings(db, {
      enhance: {
        backend: 'direct',
        prompts: [{ id: 'q', name: 'Q', text: 'quick' }],
        selectedPromptId: 'q',
        contextPrompts: [{ id: 'c', name: 'C', text: 'ctx' }],
        contextSelectedPromptId: 'c',
      },
    }, CAPABLE);
    expect(next.enhance.prompts).toEqual([{ id: 'q', name: 'Q', text: 'quick' }]);
    expect(next.enhance.selectedPromptId).toBe('q');
    expect(next.enhance.contextPrompts).toEqual([{ id: 'c', name: 'C', text: 'ctx' }]);
    expect(next.enhance.contextSelectedPromptId).toBe('c');

    const later = updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', timeoutSecs: 45 },
    }, CAPABLE);
    expect(later.enhance.prompts).toEqual([{ id: 'q', name: 'Q', text: 'quick' }]);
    expect(later.enhance.contextPrompts).toEqual([{ id: 'c', name: 'C', text: 'ctx' }]);
    expect(later.enhance.contextSelectedPromptId).toBe('c');
    expect(later.enhance.timeoutSecs).toBe(45);
  });

  it('rejects contextPrompts on a non-enhance site', () => {
    const next = updateSidecarLlmSettings(db, {
      commit: {
        backend: 'direct',
        prompts: [{ id: 'x', name: 'X', text: 'T' }],
        contextPrompts: [{ id: 'c', name: 'C', text: 'nope' }],
      } as never,
    }, CAPABLE);
    expect(next.commit.prompts).toEqual([{ id: 'x', name: 'X', text: 'T' }]);
    expect('contextPrompts' in next.commit).toBe(false);
  });

  it('round-trips tts codePrompts independently of prompts', () => {
    const next = updateSidecarLlmSettings(db, {
      tts: {
        backend: 'direct',
        prompts: [{ id: 'p', name: 'P', text: 'prose' }],
        selectedPromptId: 'p',
        codePrompts: [{ id: 'c', name: 'C', text: 'code' }],
        codeSelectedPromptId: 'c',
      },
    }, CAPABLE);
    expect(next.tts.prompts).toEqual([{ id: 'p', name: 'P', text: 'prose' }]);
    expect(next.tts.selectedPromptId).toBe('p');
    expect(next.tts.codePrompts).toEqual([{ id: 'c', name: 'C', text: 'code' }]);
    expect(next.tts.codeSelectedPromptId).toBe('c');

    const later = updateSidecarLlmSettings(db, {
      tts: { backend: 'direct', timeoutSecs: 33 },
    }, CAPABLE);
    expect(later.tts.prompts).toEqual([{ id: 'p', name: 'P', text: 'prose' }]);
    expect(later.tts.codePrompts).toEqual([{ id: 'c', name: 'C', text: 'code' }]);
    expect(later.tts.codeSelectedPromptId).toBe('c');
    expect(later.tts.timeoutSecs).toBe(33);
  });

  it('rejects a non-array codePrompts payload without clearing the stored list', () => {
    updateSidecarLlmSettings(db, {
      tts: {
        backend: 'direct',
        codePrompts: [{ id: 'c', name: 'C', text: 'code' }],
        codeSelectedPromptId: 'c',
      },
    }, CAPABLE);
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'direct', codePrompts: 'garbage' },
    } as never, CAPABLE)).toThrow(/codePrompts must be an array/);
    expect(getSidecarLlmSettings(db).tts.codePrompts).toEqual([{ id: 'c', name: 'C', text: 'code' }]);
  });

  it('rejects codePrompts on a non-tts site', () => {
    const next = updateSidecarLlmSettings(db, {
      commit: {
        backend: 'direct',
        prompts: [{ id: 'x', name: 'X', text: 'T' }],
        codePrompts: [{ id: 'c', name: 'C', text: 'nope' }],
      } as never,
    }, CAPABLE);
    expect(next.commit.prompts).toEqual([{ id: 'x', name: 'X', text: 'T' }]);
    expect('codePrompts' in next.commit).toBe(false);
  });

  it('round-trips tts diffPrompts independently of prompts/codePrompts', () => {
    const next = updateSidecarLlmSettings(db, {
      tts: {
        backend: 'direct',
        prompts: [{ id: 'p', name: 'P', text: 'prose' }],
        selectedPromptId: 'p',
        codePrompts: [{ id: 'c', name: 'C', text: 'code' }],
        codeSelectedPromptId: 'c',
        diffPrompts: [{ id: 'd', name: 'D', text: 'diff' }],
        diffSelectedPromptId: 'd',
      },
    }, CAPABLE);
    expect(next.tts.diffPrompts).toEqual([{ id: 'd', name: 'D', text: 'diff' }]);
    expect(next.tts.diffSelectedPromptId).toBe('d');
    expect(getSidecarLlmSettings(db).tts.diffPrompts).toEqual([{ id: 'd', name: 'D', text: 'diff' }]);
  });

  it('PATCH touching only codePrompts retains diffPrompts (retain-on-omit)', () => {
    updateSidecarLlmSettings(db, {
      tts: {
        backend: 'direct',
        diffPrompts: [{ id: 'd', name: 'D', text: 'diff' }],
        diffSelectedPromptId: 'd',
        codePrompts: [{ id: 'c', name: 'C', text: 'code' }],
        codeSelectedPromptId: 'c',
      },
    }, CAPABLE);
    const later = updateSidecarLlmSettings(db, {
      tts: {
        backend: 'direct',
        codePrompts: [{ id: 'c2', name: 'C2', text: 'code2' }],
        codeSelectedPromptId: 'c2',
      },
    }, CAPABLE);
    expect(later.tts.codePrompts).toEqual([{ id: 'c2', name: 'C2', text: 'code2' }]);
    expect(later.tts.diffPrompts).toEqual([{ id: 'd', name: 'D', text: 'diff' }]);
    expect(later.tts.diffSelectedPromptId).toBe('d');
  });

  it('rejects a non-array diffPrompts payload without clearing the stored list', () => {
    updateSidecarLlmSettings(db, {
      tts: {
        backend: 'direct',
        diffPrompts: [{ id: 'd', name: 'D', text: 'diff' }],
        diffSelectedPromptId: 'd',
      },
    }, CAPABLE);
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'direct', diffPrompts: 'nope' },
    } as never, CAPABLE)).toThrow(/diffPrompts must be an array/);
    expect(getSidecarLlmSettings(db).tts.diffPrompts).toEqual([{ id: 'd', name: 'D', text: 'diff' }]);
  });

  it('enhance project fields round-trip, retain on omit, clear on empty string', () => {
    updateSidecarLlmSettings(db, {
      enhance: {
        backend: 'direct',
        projectAdapter: 'claude-code',
        projectModel: 'pm',
        projectPrompts: [{ id: 'p1', name: 'P', text: 'T' }],
        projectSelectedPromptId: 'p1',
      },
    }, CAPABLE);
    expect(getSidecarLlmSettings(db).enhance).toMatchObject({
      projectAdapter: 'claude-code',
      projectModel: 'pm',
      projectPrompts: [{ id: 'p1', name: 'P', text: 'T' }],
      projectSelectedPromptId: 'p1',
    });
    // switching to an agent backend hides, not clears
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, CAPABLE);
    expect(getSidecarLlmSettings(db).enhance).toMatchObject({ projectAdapter: 'claude-code', projectModel: 'pm' });
    // explicit empty string clears
    updateSidecarLlmSettings(db, { enhance: { backend: 'direct', projectAdapter: '' } }, CAPABLE);
    expect(getSidecarLlmSettings(db).enhance.projectAdapter).toBeUndefined();
    expect(getSidecarLlmSettings(db).enhance.projectModel).toBe('pm');
  });

  it('rejects a project adapter without read-only one-shot', () => {
    expect(() => updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', projectAdapter: 'pi' },
    }, CAPABLE)).toThrow('adapter pi does not support read-only one-shot');
  });

  it('drops project fields on non-enhance sites', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'direct', projectAdapter: 'claude-code', projectModel: 'x' },
    }, CAPABLE);
    expect(getSidecarLlmSettings(db).commit).not.toHaveProperty('projectAdapter');
    expect(getSidecarLlmSettings(db).commit).not.toHaveProperty('projectModel');
  });
});

function insertLegacyBtw(db: Database.Database, row: Record<string, unknown>): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('btw', ?)").run(JSON.stringify(row));
}

function seedCatalogueProfile(db: Database.Database, id: string, agentType: string, model: string): void {
  db.prepare(
    `INSERT INTO agents (id, type, label, created_at) VALUES (?, ?, ?, ?)`,
  ).run(agentType, agentType, agentType, Date.now());
  db.prepare(
    `INSERT INTO agent_models (id, agent_id, model_name, label, enabled_flag, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(id, agentType, model, model, Date.now());
  catalogue.load(db);
}

describe('legacy btw sidecar route', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });
  afterEach(() => db.close());

  it('(a) no btw route + legacy read_only profile → agent_readonly route', () => {
    seedCatalogueProfile(db, 'claude-code:x', 'claude-code', 'sonnet');
    registry.register('claude-code', () => ({ oneShotModes: ['none', 'read_only'] }) as never);
    insertLegacyBtw(db, { btwProfileId: 'claude-code:x' });
    expect(getSidecarLlmSettings(db).btw).toEqual({
      backend: 'agent_readonly', adapter: 'claude-code', model: 'sonnet', enabled: true,
    });
  });

  it('(b) legacy profile whose adapter lacks read_only → default claude-code/claude-haiku-4-5', () => {
    seedCatalogueProfile(db, 'pi:x', 'pi', 'glm');
    registry.register('pi', () => ({ oneShotModes: ['none'] }) as never);
    insertLegacyBtw(db, { btwProfileId: 'pi:x' });
    expect(getSidecarLlmSettings(db).btw).toEqual({
      ...SIDECAR_LLM_DEFAULTS.btw, enabled: true,
    });
  });

  it('(c) legacy timeoutSeconds 90 → timeoutSecs 90; 240 is unset', () => {
    insertLegacyBtw(db, { timeoutSeconds: 90 });
    expect(getSidecarLlmSettings(db).btw.timeoutSecs).toBe(90);
    insertLegacyBtw(db, { timeoutSeconds: 240 });
    expect('timeoutSecs' in getSidecarLlmSettings(db).btw).toBe(false);
  });

  it('(d) a stored btw route wins over legacy', () => {
    insertLegacyBtw(db, { btwProfileId: 'claude-code:x', timeoutSeconds: 90 });
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      btw: { backend: 'direct', model: 'stored-wins' },
    }));
    expect(getSidecarLlmSettings(db).btw).toEqual({
      backend: 'direct', model: 'stored-wins', enabled: true,
    });
  });

  it('(e) no rows at all → SIDECAR_LLM_DEFAULTS.btw', () => {
    expect(getSidecarLlmSettings(db).btw).toEqual({
      ...SIDECAR_LLM_DEFAULTS.btw, enabled: true,
    });
  });

  it('getBtwSettings picks only priming keys so legacy fields do not leak', () => {
    insertLegacyBtw(db, {
      btwProfileId: 'claude-code:haiku-4-5',
      timeoutSeconds: 90,
      primingMode: 'generic',
      primingProfileId: 'x',
    });
    expect(getBtwSettings(db)).toEqual({ primingMode: 'generic', primingProfileId: 'x' });
  });

  it('updateBtwSettings stores only primingMode/primingProfileId, dropping a posted btwProfileId', () => {
    const updated = updateBtwSettings(db, {
      primingMode: 'generic',
      primingProfileId: 'claude-code:sonnet-4-6',
      btwProfileId: 'antigravity:gemini-3.8-flash-medium',
    } as never);
    expect(updated).toEqual({
      primingMode: 'generic', primingProfileId: 'claude-code:sonnet-4-6',
    });
    expect(updated).not.toHaveProperty('btwProfileId');
    const raw = JSON.parse(
      (db.prepare("SELECT value FROM settings WHERE key = 'btw'").get() as { value: string }).value,
    ) as Record<string, unknown>;
    expect(raw.btwProfileId).toBeUndefined();
    expect(raw.primingMode).toBe('generic');
    expect(getBtwSettings(db)).toEqual(updated);
  });
});
