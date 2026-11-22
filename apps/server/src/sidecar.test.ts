import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  COMMIT_MESSAGE_SYSTEM_PROMPT,
  ENHANCE_DEFAULTS,
  SIDECAR_BUILTIN_PROMPTS,
  SIDECAR_BUILTIN_TTS_CODE_PROMPTS,
  SIDECAR_BUILTIN_TTS_DIFF_PROMPTS,
  DEFAULT_TTS_DIFF_EXPLAIN_PROMPT,
  DEFAULT_ENHANCE_PROJECT_PROMPT,
  SIDECAR_SITES,
  type OneShotMode,
  type RemoteHostView,
} from '@tierwyn/shared';
import { runMigrations } from './db/migrate.js';
import { migrations } from './db/migrations/index.js';
import { seedDefaultSettings, VOICE_DEFAULTS } from './db/seed.js';
import { registry } from './registry.js';
import { sidecarComplete, sidecarDeps, sidecarSiteReady, listOneShotCapableAdapters, resolveSidecarPrompt, enhanceProjectStatus, remoteIneligible, sidecarHostAdvisories } from './sidecar.js';
import { RpcError } from './node/rpc.js';
import type { AdapterFactoryOpts } from './registry.js';
import {
  createDirectLlmProfile,
  deleteDirectLlmProfile,
  listDirectLlmProfiles,
  updateDirectLlmProfile,
  updateEnhanceSettings,
  updateSidecarLlmSettings,
  updateVoiceSettings,
} from './repositories/settings.js';
import { ClaudeCodeAdapter } from './adapters/claude-code/index.js';
import { PiAdapter } from './adapters/pi/index.js';
import { CursorAdapter } from './adapters/cursor/index.js';
import { CopilotAdapter } from './adapters/copilot/index.js';

const REPO = mkdtempSync(join(tmpdir(), 'sidecar-repo-'));
afterAll(() => {
  try { rmSync(REPO, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('sidecarComplete', () => {
  let db: Database.Database;
  const origClean = sidecarDeps.clean;
  const origCreate = sidecarDeps.createAdapter;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });

  afterEach(() => {
    sidecarDeps.clean = origClean;
    sidecarDeps.createAdapter = origCreate;
    vi.restoreAllMocks();
    db.close();
  });

  it('default gemini: all four sites call clean with the exact systemPrompt', async () => {
    updateVoiceSettings(db, {
      cleanup: { enabled: true, model: 'cleanup-model', baseUrl: 'http://cleanup.local/v1', apiKey: 'ck' },
    });
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek', timeoutSecs: 77,
    });
    const calls: { cfg: { systemPrompt?: string; timeoutSecs?: number; baseUrl?: string; model?: string; apiKey?: string }; prompt: string }[] = [];
    sidecarDeps.clean = vi.fn(async (cfg, prompt) => {
      calls.push({ cfg, prompt });
      return `cleaned:${prompt}`;
    }) as never;

    const directSites = SIDECAR_SITES.filter((s) => s !== 'btw');
    for (const site of directSites) {
      const out = await sidecarComplete(db, site, `body-${site}`, { systemPrompt: `PROMPT-${site}` });
      expect(out).toBe(`cleaned:body-${site}`);
    }

    expect(calls).toHaveLength(directSites.length);
    for (const site of directSites) {
      const call = calls.find((c) => c.cfg.systemPrompt === `PROMPT-${site}`);
      expect(call).toBeDefined();
      expect(call!.prompt).toBe(`body-${site}`);
    }
    const transcribeCall = calls.find((c) => c.cfg.systemPrompt === 'PROMPT-transcribe');
    const ttsCall = calls.find((c) => c.cfg.systemPrompt === 'PROMPT-tts');
    const enhanceCall = calls.find((c) => c.cfg.systemPrompt === 'PROMPT-enhance');
    const describeCall = calls.find((c) => c.cfg.systemPrompt === 'PROMPT-describe');
    const commitCall = calls.find((c) => c.cfg.systemPrompt === 'PROMPT-commit');
    expect(transcribeCall!.cfg.timeoutSecs).toBe(VOICE_DEFAULTS.cleanup.timeoutSecs);
    expect(ttsCall!.cfg.timeoutSecs).toBe(VOICE_DEFAULTS.cleanup.timeoutSecs);
    expect(enhanceCall!.cfg.timeoutSecs).toBe(77);
    expect(describeCall!.cfg.timeoutSecs).toBe(30);
    expect(commitCall!.cfg.timeoutSecs).toBe(77);
    expect(commitCall!.cfg.model).toBe('enhance-model');
    expect(transcribeCall!.cfg.model).toBe('cleanup-model');
    expect(transcribeCall!.cfg.baseUrl).toBe('http://cleanup.local/v1');
    expect(transcribeCall!.cfg.apiKey).toBe('ck');
    expect(ttsCall!.cfg.model).toBe('cleanup-model');
    expect(ttsCall!.cfg.baseUrl).toBe('http://cleanup.local/v1');
    expect(enhanceCall!.cfg.model).toBe('enhance-model');
    expect(enhanceCall!.cfg.baseUrl).toBe('http://enhance.local/v1');
    expect(describeCall!.cfg.model).toBe('enhance-model');
    expect(describeCall!.cfg.baseUrl).toBe('http://enhance.local/v1');
  });

  it('profile override: describe routed to the cleanup profile uses voice.cleanup transport', async () => {
    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: 'cleanup' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    updateVoiceSettings(db, {
      cleanup: { model: 'cleanup-model', baseUrl: 'http://cleanup.local/v1', apiKey: 'ck' },
    });
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    const clean = vi.fn(async () => 'from-clean');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'describe', 'd-body', { systemPrompt: 'DESCRIBE-SP' });
    expect(clean).toHaveBeenCalledTimes(1);
    const cfg = clean.mock.calls[0]![0] as { model: string; baseUrl: string; systemPrompt: string; timeoutSecs: number };
    expect(cfg.model).toBe('cleanup-model');
    expect(cfg.baseUrl).toBe('http://cleanup.local/v1');
    expect(cfg.systemPrompt).toBe('DESCRIBE-SP');
    expect(cfg.timeoutSecs).toBe(VOICE_DEFAULTS.cleanup.timeoutSecs);
  });

  it('unknown profile id falls back to the site default transport', async () => {
    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: 'ghost' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    updateVoiceSettings(db, {
      cleanup: { model: 'cleanup-model', baseUrl: 'http://cleanup.local/v1' },
    });
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', timeoutSecs: 77,
    });
    const clean = vi.fn(async () => 'from-clean');
    sidecarDeps.clean = clean as never;

    await expect(sidecarComplete(db, 'describe', 'd-body', { systemPrompt: 'DESCRIBE-SP' }))
      .resolves.toBe('from-clean');
    const cfg = clean.mock.calls[0]![0] as { model: string; timeoutSecs: number };
    expect(cfg.model).toBe('enhance-model');
    expect(cfg.timeoutSecs).toBe(30);
  });

  it('mixed config: describe gemini + tts agent routes independently', async () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);

    const clean = vi.fn(async () => 'from-clean');
    sidecarDeps.clean = clean as never;

    const oneShot = vi.fn(async () => ({ text: 'from-agent' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot })) as never;

    const described = await sidecarComplete(db, 'describe', 'd-body', { systemPrompt: 'DESCRIBE-SP' });
    const spoken = await sidecarComplete(db, 'tts', 't-body', { systemPrompt: 'TTS-SP' });

    expect(described).toBe('from-clean');
    expect(spoken).toBe('from-agent');
    expect(clean).toHaveBeenCalledTimes(1);
    expect(clean.mock.calls[0]![1]).toBe('d-body');
    expect((clean.mock.calls[0]![0] as { systemPrompt: string }).systemPrompt).toBe('DESCRIBE-SP');
    expect(oneShot).toHaveBeenCalledTimes(1);
    expect(oneShot.mock.calls[0]![0]).toBe('t-body');
    expect(oneShot.mock.calls[0]![1]).toMatchObject({
      systemPrompt: 'TTS-SP',
      mode: 'none',
      model: 'zai/glm-5.3',
    });
    expect(oneShot.mock.calls[0]![1]).not.toHaveProperty('allowTools');
  });

  it('agent failure does not fall back to Gemini', async () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);

    const clean = vi.fn(async () => 'should-not-run');
    sidecarDeps.clean = clean as never;
    sidecarDeps.createAdapter = () => ({
      oneShot: async () => { throw new Error('agent boom'); },
    }) as never;

    await expect(sidecarComplete(db, 'tts', 'x', { systemPrompt: 'SP' }))
      .rejects.toThrow(/agent boom/);
    expect(clean).not.toHaveBeenCalled();
  });

  it('throws when the adapter has no oneShot', async () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = () => ({}) as never;

    await expect(sidecarComplete(db, 'tts', 'x', { systemPrompt: 'SP' }))
      .rejects.toThrow(/does not support one-shot/);
  });

  it('throws when oneShot returns empty text', async () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = () => ({
      oneShot: async () => ({ text: '   ' }),
    }) as never;

    await expect(sidecarComplete(db, 'tts', 'x', { systemPrompt: 'SP' }))
      .rejects.toThrow(/one-shot returned empty text/);
  });

  it('listOneShotCapableAdapters returns only adapters whose instance has oneShot', () => {
    vi.spyOn(registry, 'registeredTypes').mockReturnValue(new Set(['pi', 'openclaw']));
    vi.spyOn(registry, 'labelFor').mockImplementation((t) => t);
    sidecarDeps.createAdapter = ((type: string) => {
      if (type === 'pi') return { oneShot: async () => ({ text: 'x' }) };
      return {};
    }) as never;

    expect(listOneShotCapableAdapters()).toEqual([{ type: 'pi', label: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
  });

  it('warns then rethrows when createAdapter throws', async () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = () => {
      throw new Error('No adapter registered for agentType: pi');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(sidecarComplete(db, 'tts', 'x', { systemPrompt: 'SP' }))
      .rejects.toThrow(/No adapter registered/);
    expect(warn).toHaveBeenCalledWith(
      '[sidecar %s] agent %s %s: %s',
      'tts',
      'pi',
      'zai/glm-5.3',
      'No adapter registered for agentType: pi',
    );
  });

  it('routes tts to a created extra profile and passes that transport to clean', async () => {
    const { createdId } = createDirectLlmProfile(db);
    updateDirectLlmProfile(db, createdId, {
      model: 'extra-m',
      baseUrl: 'http://extra.local/v1',
      apiKey: 'xk',
      timeoutSecs: 88,
    });
    updateSidecarLlmSettings(db, {
      tts: { backend: 'direct', profile: createdId },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'from-extra');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'tts', 't-body', { systemPrompt: 'TTS-EXTRA' });
    expect(clean).toHaveBeenCalledTimes(1);
    const cfg = clean.mock.calls[0]![0] as {
      baseUrl: string; model: string; apiKey: string; timeoutSecs: number; systemPrompt: string;
    };
    expect(cfg.baseUrl).toBe('http://extra.local/v1');
    expect(cfg.model).toBe('extra-m');
    expect(cfg.apiKey).toBe('xk');
    expect(cfg.timeoutSecs).toBe(88);
    expect(cfg.systemPrompt).toBe('TTS-EXTRA');
    expect(clean.mock.calls[0]![1]).toBe('t-body');
  });

  it('routes enhance to an extra profile timeout when opts.timeoutSecs is omitted', async () => {
    const { createdId } = createDirectLlmProfile(db);
    updateDirectLlmProfile(db, createdId, {
      model: 'e-m', baseUrl: 'http://e.local/v1', timeoutSecs: 99,
    });
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', profile: createdId },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'enhance', 'body', { systemPrompt: 'SP' });
    expect((clean.mock.calls[0]![0] as { timeoutSecs: number }).timeoutSecs).toBe(99);
  });

  it('describe routed to an extra profile uses the profile timeout, not the 30s enhancer default', async () => {
    const { createdId } = createDirectLlmProfile(db);
    updateDirectLlmProfile(db, createdId, {
      model: 'd-m', baseUrl: 'http://d.local/v1', timeoutSecs: 45,
    });
    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: createdId },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'describe', 'body', { systemPrompt: 'SP' });
    expect((clean.mock.calls[0]![0] as { timeoutSecs: number }).timeoutSecs).toBe(45);
  });

  it('deleted extra profile id falls back to the site default', async () => {
    const { createdId } = createDirectLlmProfile(db);
    updateDirectLlmProfile(db, createdId, {
      model: 'extra-m', baseUrl: 'http://extra.local/v1',
    });
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', timeoutSecs: 77,
    });
    updateSidecarLlmSettings(db, {
      describe: { backend: 'direct', profile: createdId },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    // Drop the extra without the delete-reassignment path so sidecar still names the ghost id.
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('direct_llm_profiles', ?)").run('[]');
    const clean = vi.fn(async () => 'from-clean');
    sidecarDeps.clean = clean as never;

    await expect(sidecarComplete(db, 'describe', 'd-body', { systemPrompt: 'DESCRIBE-SP' }))
      .resolves.toBe('from-clean');
    const cfg = clean.mock.calls[0]![0] as { model: string; timeoutSecs: number };
    expect(cfg.model).toBe('enhance-model');
    expect(cfg.timeoutSecs).toBe(30);
  });

  it('transcribe extra profile timeout applies when sidecarComplete is called without timeoutSecs', async () => {
    const { createdId } = createDirectLlmProfile(db);
    updateDirectLlmProfile(db, createdId, {
      model: 't-m', baseUrl: 'http://t.local/v1', timeoutSecs: 99,
    });
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'direct', profile: createdId, enabled: true },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'transcribe', 'raw', { systemPrompt: 'CLEAN' });
    expect((clean.mock.calls[0]![0] as { timeoutSecs: number }).timeoutSecs).toBe(99);
  });

  it('route.timeoutSecs wins over opts.timeoutSecs on the direct backend', async () => {
    updateVoiceSettings(db, {
      cleanup: { model: 'cleanup-model', baseUrl: 'http://cleanup.local/v1', timeoutSecs: 60 },
    });
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'direct', timeoutSecs: 90, enabled: true },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'transcribe', 'body', { systemPrompt: 'SP', timeoutSecs: 30 });
    expect((clean.mock.calls[0]![0] as { timeoutSecs: number }).timeoutSecs).toBe(90);
  });

  it('route.timeoutSecs wins over the agent_readonly 120s floor', async () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm', timeoutSecs: 90 },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    const oneShot = vi.fn(async () => ({ text: 'ok' }));
    sidecarDeps.createAdapter = vi.fn(() => ({
      oneShot, oneShotModes: ['none', 'read_only'],
    })) as never;

    await sidecarComplete(db, 'commit', 'diff', { systemPrompt: 'SP', timeoutSecs: 30, cwd: REPO });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ timeoutSecs: 90, cwd: REPO });
  });

  it('no-override transcribe keeps the cleanup profile timeout (not 60)', async () => {
    const { createdId } = createDirectLlmProfile(db);
    updateDirectLlmProfile(db, createdId, {
      model: 't-m', baseUrl: 'http://t.local/v1', timeoutSecs: 99,
    });
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'direct', profile: createdId, enabled: true },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'transcribe', 'raw', { systemPrompt: 'CLEAN' });
    expect((clean.mock.calls[0]![0] as { timeoutSecs: number }).timeoutSecs).toBe(99);
  });

  it('no-override agent_readonly keeps the 120s floor; agent_oneshot keeps 60', async () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
      tts: { backend: 'agent_oneshot', adapter: 'pi', model: 'm' },
    }, [
      { type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true },
      { type: 'pi', supportsToolsOff: true, supportsReadOnly: false },
    ]);
    const oneShotRo = vi.fn(async () => ({ text: 'ro' }));
    const oneShotNone = vi.fn(async () => ({ text: 'none' }));
    sidecarDeps.createAdapter = vi.fn((type: string) => ({
      oneShot: type === 'claude-code' ? oneShotRo : oneShotNone,
      oneShotModes: type === 'claude-code' ? ['none', 'read_only'] : ['none'],
    })) as never;

    await sidecarComplete(db, 'commit', 'diff', { systemPrompt: 'SP', cwd: REPO });
    await sidecarComplete(db, 'tts', 'body', { systemPrompt: 'SP' });
    expect(oneShotRo.mock.calls[0]![1]).toMatchObject({ timeoutSecs: 120 });
    expect(oneShotNone.mock.calls[0]![1]).toMatchObject({ timeoutSecs: 60 });
  });

  it('no-override describe + enhancer profile keeps the 30s special case', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', timeoutSecs: 60,
    });
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;

    await sidecarComplete(db, 'describe', 'body', { systemPrompt: 'SP' });
    expect((clean.mock.calls[0]![0] as { timeoutSecs: number }).timeoutSecs).toBe(30);
  });

  it('describe and enhance agent_readonly reach oneShot with absolute cwd and throw without it', async () => {
    updateSidecarLlmSettings(db, {
      describe: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
      enhance: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    const oneShot = vi.fn(async () => ({ text: 'ok' }));
    sidecarDeps.createAdapter = vi.fn(() => ({
      oneShot, oneShotModes: ['none', 'read_only'],
    })) as never;

    await sidecarComplete(db, 'describe', 'd', { systemPrompt: 'SP', cwd: REPO });
    await sidecarComplete(db, 'enhance', 'e', { systemPrompt: 'SP', cwd: REPO });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ cwd: REPO, mode: 'read_only' });
    expect(oneShot.mock.calls[1]![1]).toMatchObject({ cwd: REPO, mode: 'read_only' });

    await expect(sidecarComplete(db, 'describe', 'd', { systemPrompt: 'SP' }))
      .rejects.toThrow(/requires an absolute working directory/);
    await expect(sidecarComplete(db, 'enhance', 'e', { systemPrompt: 'SP' }))
      .rejects.toThrow(/requires an absolute working directory/);
  });
});

describe('sidecarSiteReady', () => {
  let db: Database.Database;
  const origClean = sidecarDeps.clean;
  const origCreate = sidecarDeps.createAdapter;
  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });
  afterEach(() => {
    sidecarDeps.clean = origClean;
    sidecarDeps.createAdapter = origCreate;
    vi.restoreAllMocks();
    db.close();
  });

  it('no sidecarLlm row: transcribe false, enhance/tts/describe follow gemini creds', () => {
    expect(sidecarSiteReady(db, 'transcribe')).toBe(false);
    expect(sidecarSiteReady(db, 'enhance')).toBe(false);
    expect(sidecarSiteReady(db, 'tts')).toBe(false);
    expect(sidecarSiteReady(db, 'describe')).toBe(false);
  });

  it('gemini-ready: all four sites true once enhance and voice cleanup creds exist', () => {
    updateEnhanceSettings(db, { model: 'gemini-m', baseUrl: 'http://127.0.0.1:1234/v1' });
    updateVoiceSettings(db, { cleanup: { enabled: true, model: 'voice-m', baseUrl: 'http://127.0.0.1:1234/v1' } });
    for (const site of SIDECAR_SITES.filter((s) => s !== 'btw')) {
      expect(sidecarSiteReady(db, site)).toBe(true);
    }
  });

  it('sidecarSiteReady(btw) is true with the default route and a read_only claude-code', () => {
    sidecarDeps.createAdapter = ((type: string) => {
      if (type !== 'claude-code') throw new Error(`unexpected adapter ${type}`);
      return { oneShot: async () => ({ text: 'x' }), oneShotModes: ['none', 'read_only'] };
    }) as never;
    expect(sidecarSiteReady(db, 'btw')).toBe(true);
  });

  it('agent-ready: all sites true with adapter+model', () => {
    updateVoiceSettings(db, { cleanup: { enabled: true } });
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
      enhance: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
      tts: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
      describe: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
      commit: { backend: 'agent', adapter: 'pi', model: 'zai/glm-5.3' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    sidecarDeps.createAdapter = (() => ({ oneShot: async () => ({ text: 'x' }) })) as never;
    for (const site of SIDECAR_SITES.filter((s) => s !== 'btw')) {
      expect(sidecarSiteReady(db, site)).toBe(true);
    }
  });

  it('agent-incomplete (model empty): all sites false', () => {
    updateSidecarLlmSettings(db, {
      transcribe: { backend: 'agent', adapter: 'pi' },
      enhance: { backend: 'agent', adapter: 'pi' },
      tts: { backend: 'agent', adapter: 'pi' },
      describe: { backend: 'agent', adapter: 'pi' },
      commit: { backend: 'agent', adapter: 'pi' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    for (const site of SIDECAR_SITES.filter((s) => s !== 'btw')) {
      expect(sidecarSiteReady(db, site)).toBe(false);
    }
  });

  it('direct backend + unconfigured profile ⇒ sidecarSiteReady false', () => {
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', profile: 'cleanup' },
      tts: { backend: 'direct', profile: 'enhancer' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    updateEnhanceSettings(db, { model: 'enh-m', baseUrl: 'http://127.0.0.1:1234/v1' });
    // cleanup profile is unconfigured (seed defaults); enhancer is configured
    expect(sidecarSiteReady(db, 'transcribe')).toBe(false);
    expect(sidecarSiteReady(db, 'enhance')).toBe(false);
    expect(sidecarSiteReady(db, 'tts')).toBe(true);
    expect(sidecarSiteReady(db, 'describe')).toBe(true);
  });

  it('sidecarSiteReady is false for an unconfigured extra profile and true once model+baseUrl are set', () => {
    const { createdId } = createDirectLlmProfile(db);
    updateSidecarLlmSettings(db, {
      tts: { backend: 'direct', profile: createdId },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    expect(sidecarSiteReady(db, 'tts')).toBe(false);
    updateDirectLlmProfile(db, createdId, {
      model: 'ready-m', baseUrl: 'http://127.0.0.1:1234/v1',
    });
    expect(sidecarSiteReady(db, 'tts')).toBe(true);
  });

  it('sidecarSiteReady(transcribe) follows voice.cleanup.enabled', () => {
    updateVoiceSettings(db, {
      cleanup: { enabled: true, model: 'm', baseUrl: 'http://127.0.0.1:1234/v1' },
    });
    expect(sidecarSiteReady(db, 'transcribe')).toBe(true);
    updateVoiceSettings(db, { cleanup: { enabled: false } });
    expect(sidecarSiteReady(db, 'transcribe')).toBe(false);
  });

  it('zero profiles: all four direct sites are not ready and complete rejects', async () => {
    for (const p of listDirectLlmProfiles(db)) {
      deleteDirectLlmProfile(db, p.id);
    }
    expect(listDirectLlmProfiles(db)).toEqual([]);
    for (const site of SIDECAR_SITES.filter((s) => s !== 'btw')) {
      expect(sidecarSiteReady(db, site)).toBe(false);
    }
    await expect(sidecarComplete(db, 'enhance', 'x', { systemPrompt: 's' }))
      .rejects.toThrow(/No Direct LLM profile available/);
  });

  it('enabled: false on a configured enhance route short-circuits sidecarSiteReady', async () => {
    updateEnhanceSettings(db, { model: 'enh-m', baseUrl: 'http://127.0.0.1:1234/v1' });
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', enabled: false },
    }, []);
    expect(sidecarSiteReady(db, 'enhance')).toBe(false);

    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;
    await expect(sidecarComplete(db, 'enhance', 'x', { systemPrompt: 's' }))
      .rejects.toThrow(/sidecar site enhance is disabled/);
    expect(clean).not.toHaveBeenCalled();
  });

  it('S1: listOneShotCapableAdapters derives supportsToolsOff / supportsReadOnly from oneShotModes', () => {
    vi.spyOn(registry, 'registeredTypes').mockReturnValue(new Set(['pi', 'claude-code']));
    vi.spyOn(registry, 'labelFor').mockImplementation((t) => t);
    sidecarDeps.createAdapter = ((type: string) => {
      if (type === 'claude-code') {
        return { oneShot: async () => ({ text: 'x' }), oneShotModes: ['none', 'read_only'] };
      }
      return { oneShot: async () => ({ text: 'x' }) };
    }) as never;

    expect(listOneShotCapableAdapters()).toEqual([
      { type: 'pi', label: 'pi', supportsToolsOff: true, supportsReadOnly: false },
      { type: 'claude-code', label: 'claude-code', supportsToolsOff: true, supportsReadOnly: true },
    ]);
  });

  it('S2: agent_oneshot calls oneShot with mode none and no allowTools', async () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent_oneshot', adapter: 'pi', model: 'm' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const oneShot = vi.fn(async () => ({ text: 'ok' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: ['none'] })) as never;

    await sidecarComplete(db, 'tts', 'body', { systemPrompt: 'SP' });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'none', model: 'm' });
    expect(oneShot.mock.calls[0]![1]).not.toHaveProperty('allowTools');
  });

  it('S3: agent_readonly forwards mode read_only, cwd, and 120s default timeout', async () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    const oneShot = vi.fn(async () => ({ text: 'msg' }));
    sidecarDeps.createAdapter = vi.fn(() => ({
      oneShot, oneShotModes: ['none', 'read_only'],
    })) as never;

    await sidecarComplete(db, 'commit', 'diff', {
      systemPrompt: 'SP',
      cwd: REPO,
    });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({
      mode: 'read_only',
      cwd: REPO,
      timeoutSecs: 120,
      model: 'm',
    });
  });

  it('S4: agent_readonly on tools-off-only adapter ⇒ sidecarSiteReady false', () => {
    // Capability lost after save: seed the blob directly (write-time would reject).
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)").run(JSON.stringify({
      commit: { backend: 'agent_readonly', adapter: 'pi', model: 'm' },
    }));
    vi.spyOn(registry, 'registeredTypes').mockReturnValue(new Set(['pi']));
    vi.spyOn(registry, 'labelFor').mockImplementation((t) => t);
    sidecarDeps.createAdapter = (() => ({ oneShot: async () => ({ text: 'x' }) })) as never;
    expect(sidecarSiteReady(db, 'commit')).toBe(false);
  });

  it('agent_readonly on site without cwd rejects on update', () => {
    expect(() => updateSidecarLlmSettings(db, {
      tts: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }])).toThrow(
      /sidecar site tts does not support read-only mode/,
    );
    expect(() => updateSidecarLlmSettings(db, {
      transcribe: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }])).toThrow(
      /sidecar site transcribe does not support read-only mode/,
    );
  });

  it('S5: agent_readonly without absolute cwd rejects', async () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    sidecarDeps.createAdapter = (() => ({
      oneShot: async () => ({ text: 'x' }),
      oneShotModes: ['none', 'read_only'],
    })) as never;

    await expect(sidecarComplete(db, 'commit', 'diff', { systemPrompt: 'SP' }))
      .rejects.toThrow(/requires an absolute working directory/);
    await expect(sidecarComplete(db, 'commit', 'diff', { systemPrompt: 'SP', cwd: 'relative/repo' }))
      .rejects.toThrow(/requires an absolute working directory/);
    await expect(sidecarComplete(db, 'commit', 'diff', { systemPrompt: 'SP', cwd: '   ' }))
      .rejects.toThrow(/requires an absolute working directory/);
  });

  it('S6: legacy backend agent behaves like agent_oneshot end-to-end', async () => {
    updateSidecarLlmSettings(db, {
      tts: { backend: 'agent', adapter: 'pi', model: 'm' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const oneShot = vi.fn(async () => ({ text: 'legacy' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot })) as never;

    const out = await sidecarComplete(db, 'tts', 'body', { systemPrompt: 'SP' });
    expect(out).toBe('legacy');
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'none' });
  });

  it('S8: enabled false on agent_readonly short-circuits ready and complete', async () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm', enabled: false },
    }, [{ type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true }]);
    expect(sidecarSiteReady(db, 'commit')).toBe(false);
    await expect(sidecarComplete(db, 'commit', 'x', { systemPrompt: 's', cwd: REPO }))
      .rejects.toThrow(/sidecar site commit is disabled/);
  });

  it('one-shot adapters declare oneShotModes with none and read_only', () => {
    const claude = new ClaudeCodeAdapter({ spawnFn: () => { throw new Error('stub'); } });
    const pi = new PiAdapter({ spawnFn: () => { throw new Error('stub'); } });
    const cursor = new CursorAdapter({ spawnFn: () => { throw new Error('stub'); } });
    const copilot = new CopilotAdapter({ spawnFn: () => { throw new Error('stub'); } });

    for (const [name, adapter] of Object.entries({ claude, pi, cursor, copilot })) {
      expect(adapter.oneShotModes, `${name} must declare oneShotModes`).toEqual(['none', 'read_only']);
    }
  });

  describe('resolveSidecarPrompt', () => {
    const CAPABLE = [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }];

    it('returns the first builtin for a fresh DB, for every site', () => {
      for (const site of SIDECAR_SITES) {
        expect(resolveSidecarPrompt(db, site)).toBe(SIDECAR_BUILTIN_PROMPTS[site][0]!.text);
      }
    });

    it('honours route.selectedPromptId pointing at a builtin', () => {
      updateSidecarLlmSettings(db, {
        transcribe: { backend: 'direct', selectedPromptId: 'builtin-2' },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'transcribe')).toBe(SIDECAR_BUILTIN_PROMPTS.transcribe[1]!.text);
    });

    it('honours route.selectedPromptId pointing at a route custom prompt', () => {
      updateSidecarLlmSettings(db, {
        commit: {
          backend: 'direct',
          prompts: [{ id: 'mine', name: 'Mine', text: 'MY PROMPT' }],
          selectedPromptId: 'mine',
        },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'commit')).toBe('MY PROMPT');
    });

    it('prefers explicitPromptId over route.selectedPromptId', () => {
      updateSidecarLlmSettings(db, {
        commit: {
          backend: 'direct',
          prompts: [{ id: 'mine', name: 'Mine', text: 'MY PROMPT' }],
          selectedPromptId: 'mine',
        },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'commit', undefined, 'commit-builtin-1'))
        .toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
    });

    it('falls back to the first builtin when the selected id dangles', () => {
      updateSidecarLlmSettings(db, {
        commit: { backend: 'direct', selectedPromptId: 'ghost' },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'commit')).toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
    });

    it('reads contextPrompts for site=enhance subMode=context', () => {
      updateSidecarLlmSettings(db, {
        enhance: {
          backend: 'direct',
          contextPrompts: [{ id: 'cx', name: 'Cx', text: 'CTX PROMPT' }],
          contextSelectedPromptId: 'cx',
        },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'enhance', 'context')).toBe('CTX PROMPT');
      expect(resolveSidecarPrompt(db, 'enhance', 'quick')).toBe(SIDECAR_BUILTIN_PROMPTS.enhance[0]!.text);
    });

    it('ignores subMode=context on a non-enhance site', () => {
      expect(resolveSidecarPrompt(db, 'commit', 'context')).toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
    });

    it('reads codePrompts for site=tts subMode=code', () => {
      updateSidecarLlmSettings(db, {
        tts: {
          backend: 'direct',
          codePrompts: [{ id: 'tcode', name: 'TCode', text: 'CODE PROMPT' }],
          codeSelectedPromptId: 'tcode',
        },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'tts', 'code')).toBe('CODE PROMPT');
      expect(resolveSidecarPrompt(db, 'tts')).toBe(SIDECAR_BUILTIN_PROMPTS.tts[0]!.text);
    });

    it('falls back to the code builtin when codeSelectedPromptId dangles', () => {
      updateSidecarLlmSettings(db, {
        tts: { backend: 'direct', codeSelectedPromptId: 'ghost' },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'tts', 'code')).toBe(SIDECAR_BUILTIN_TTS_CODE_PROMPTS[0]!.text);
    });

    it('ignores subMode=code on a non-tts site', () => {
      expect(resolveSidecarPrompt(db, 'commit', 'code')).toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
    });

    it('tts + subMode=diff with no config → DEFAULT_TTS_DIFF_EXPLAIN_PROMPT', () => {
      expect(resolveSidecarPrompt(db, 'tts', 'diff')).toBe(DEFAULT_TTS_DIFF_EXPLAIN_PROMPT);
      expect(resolveSidecarPrompt(db, 'tts', 'diff')).toBe(SIDECAR_BUILTIN_TTS_DIFF_PROMPTS[0]!.text);
    });

    it('tts + subMode=diff honours custom diffPrompts / diffSelectedPromptId', () => {
      updateSidecarLlmSettings(db, {
        tts: {
          backend: 'direct',
          diffPrompts: [{ id: 'tdiff', name: 'TDiff', text: 'DIFF PROMPT' }],
          diffSelectedPromptId: 'tdiff',
        },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'tts', 'diff')).toBe('DIFF PROMPT');
    });

    it('tts code and diff slots are isolated from each other', () => {
      updateSidecarLlmSettings(db, {
        tts: {
          backend: 'direct',
          codePrompts: [{ id: 'c', name: 'C', text: 'CODE ONLY' }],
          codeSelectedPromptId: 'c',
          diffPrompts: [{ id: 'd', name: 'D', text: 'DIFF ONLY' }],
          diffSelectedPromptId: 'd',
        },
      }, CAPABLE);
      expect(resolveSidecarPrompt(db, 'tts', 'code')).toBe('CODE ONLY');
      expect(resolveSidecarPrompt(db, 'tts', 'diff')).toBe('DIFF ONLY');
      expect(resolveSidecarPrompt(db, 'tts', 'code')).not.toBe('DIFF ONLY');
      expect(resolveSidecarPrompt(db, 'tts', 'diff')).not.toBe('CODE ONLY');
    });

    it('enhance + subMode=diff falls back to enhance builtins (no throw)', () => {
      expect(resolveSidecarPrompt(db, 'enhance', 'diff')).toBe(SIDECAR_BUILTIN_PROMPTS.enhance[0]!.text);
    });

    it('resolves from the legacy voice.cleanup blob when the route has no prompts', () => {
      updateVoiceSettings(db, {
        cleanup: { prompts: [{ id: 'c1', name: 'Mine', text: 'LEGACY CLEANUP' }], selectedPromptId: 'c1' },
      });
      expect(resolveSidecarPrompt(db, 'transcribe')).toBe('LEGACY CLEANUP');
    });
  });

  it('resolves the configured system prompt when the caller omits it', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;
    await sidecarComplete(db, 'commit', 'body', {});
    expect((clean.mock.calls[0]![0] as { systemPrompt: string }).systemPrompt)
      .toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
  });

  it('uses an operator-selected custom prompt when the caller omits systemPrompt', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    updateSidecarLlmSettings(db, {
      commit: {
        backend: 'direct',
        prompts: [{ id: 'x', name: 'X', text: 'CUSTOM-COMMIT' }],
        selectedPromptId: 'x',
      },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;
    await sidecarComplete(db, 'commit', 'body', {});
    expect((clean.mock.calls[0]![0] as { systemPrompt: string }).systemPrompt).toBe('CUSTOM-COMMIT');
  });

  it('still honours an explicit systemPrompt override', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;
    await sidecarComplete(db, 'commit', 'body', { systemPrompt: 'OVERRIDE' });
    expect((clean.mock.calls[0]![0] as { systemPrompt: string }).systemPrompt).toBe('OVERRIDE');
  });

  it('treats an empty-string systemPrompt as omitted', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;
    await sidecarComplete(db, 'commit', 'body', { systemPrompt: '' });
    expect((clean.mock.calls[0]![0] as { systemPrompt: string }).systemPrompt)
      .toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
  });

  it('passes subMode through to enhance context resolution', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    updateSidecarLlmSettings(db, {
      enhance: {
        backend: 'direct',
        contextPrompts: [{ id: 'cx', name: 'Cx', text: 'CTX-SP' }],
        contextSelectedPromptId: 'cx',
      },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;
    await sidecarComplete(db, 'enhance', 'body', { subMode: 'context' });
    expect((clean.mock.calls[0]![0] as { systemPrompt: string }).systemPrompt).toBe('CTX-SP');
  });

  it('passes promptId through as the explicit override', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    updateSidecarLlmSettings(db, {
      commit: {
        backend: 'direct',
        prompts: [{ id: 'x', name: 'X', text: 'CUSTOM-COMMIT' }],
        selectedPromptId: 'x',
      },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const clean = vi.fn(async () => 'ok');
    sidecarDeps.clean = clean as never;
    await sidecarComplete(db, 'commit', 'body', { promptId: 'commit-builtin-1' });
    expect((clean.mock.calls[0]![0] as { systemPrompt: string }).systemPrompt)
      .toBe(COMMIT_MESSAGE_SYSTEM_PROMPT);
  });

  it('resolves for the agent backend path too, not just direct', async () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'm' },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: false }]);
    const oneShot = vi.fn(async () => ({ text: 'from-agent' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot })) as never;
    await sidecarComplete(db, 'commit', 'body', {});
    expect(oneShot.mock.calls[0]![1]).toMatchObject({
      systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
    });
  });
});

describe('sidecarComplete oneShotMode override', () => {
  let db: Database.Database;
  const origClean = sidecarDeps.clean;
  const origCreate = sidecarDeps.createAdapter;
  const CAP = [
    { type: 'claude-code', supportsToolsOff: true, supportsReadOnly: true },
    { type: 'pi', supportsToolsOff: true, supportsReadOnly: false },
  ];
  function stub(modes: string[]) {
    const oneShot = vi.fn(async (_p: string, _o: Record<string, unknown>) => ({ text: 'ok' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: modes })) as never;
    return oneShot;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });
  afterEach(() => {
    sidecarDeps.clean = origClean;
    sidecarDeps.createAdapter = origCreate;
    vi.restoreAllMocks();
    db.close();
  });

  it('read_only override on an agent_oneshot row uses the row adapter, read_only, cwd, 120s floor', async () => {
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_oneshot', adapter: 'claude-code', model: 'm' } }, CAP);
    const oneShot = stub(['none', 'read_only']);
    await sidecarComplete(db, 'enhance', 'p', { subMode: 'project', cwd: REPO, timeoutSecs: 60, oneShotMode: 'read_only' });
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('claude-code');
    expect(oneShot.mock.calls[0]![1]).toMatchObject({
      mode: 'read_only', cwd: REPO, model: 'm', timeoutSecs: 120,
      systemPrompt: DEFAULT_ENHANCE_PROJECT_PROMPT,
    });
  });

  it('read_only override on a direct row uses projectAdapter/projectModel and never calls clean', async () => {
    updateSidecarLlmSettings(db, { enhance: { backend: 'direct', projectAdapter: 'claude-code', projectModel: 'pm' } }, CAP);
    const clean = vi.fn(async () => 'direct');
    sidecarDeps.clean = clean as never;
    const oneShot = stub(['none', 'read_only']);
    await sidecarComplete(db, 'enhance', 'p', { subMode: 'project', cwd: REPO, oneShotMode: 'read_only' });
    expect(clean).not.toHaveBeenCalled();
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'read_only', model: 'pm' });
  });

  it('read_only override on a direct row with no project adapter fails closed', async () => {
    const clean = vi.fn(async () => 'direct');
    sidecarDeps.clean = clean as never;
    await expect(sidecarComplete(db, 'enhance', 'p', { cwd: REPO, oneShotMode: 'read_only' }))
      .rejects.toThrow('sidecar enhance: read-only one-shot needs an adapter and model');
    expect(clean).not.toHaveBeenCalled();
  });

  it('none override on an agent_readonly row downgrades to tools-off', async () => {
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' } }, CAP);
    const oneShot = stub(['none', 'read_only']);
    await sidecarComplete(db, 'enhance', 'p', { subMode: 'quick', cwd: REPO, oneShotMode: 'none' });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'none' });
  });

  it('none override on a direct row still calls clean', async () => {
    updateEnhanceSettings(db, { model: 'e', baseUrl: 'http://e.local/v1' });
    const clean = vi.fn(async () => 'direct');
    sidecarDeps.clean = clean as never;
    await expect(sidecarComplete(db, 'enhance', 'p', { subMode: 'quick', oneShotMode: 'none' })).resolves.toBe('direct');
  });

  it('read_only override on an adapter without read_only fails closed', async () => {
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_oneshot', adapter: 'pi', model: 'm' } }, CAP);
    const oneShot = stub(['none']);
    await expect(sidecarComplete(db, 'enhance', 'p', { cwd: REPO, oneShotMode: 'read_only' }))
      .rejects.toThrow('sidecar enhance: adapter pi cannot run a read-only one-shot');
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('none override on an adapter without tools-off fails closed and never passes read_only', async () => {
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' } }, CAP);
    const oneShot = stub(['read_only']);
    await expect(sidecarComplete(db, 'enhance', 'p', { cwd: REPO, oneShotMode: 'none' }))
      .rejects.toThrow('sidecar enhance: adapter claude-code cannot run a tools-off one-shot');
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('read_only timeout: 30 is raised to 120, 180 stays 180', async () => {
    const oneShot = stub(['none', 'read_only']);
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_oneshot', adapter: 'claude-code', model: 'm', timeoutSecs: 30 } }, CAP);
    await sidecarComplete(db, 'enhance', 'p', { cwd: REPO, oneShotMode: 'read_only' });
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_oneshot', adapter: 'claude-code', model: 'm', timeoutSecs: 180 } }, CAP);
    await sidecarComplete(db, 'enhance', 'p', { cwd: REPO, oneShotMode: 'read_only' });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ timeoutSecs: 120 });
    expect(oneShot.mock.calls[1]![1]).toMatchObject({ timeoutSecs: 180 });
  });

  it('none override keeps the quick/context timeout chain (route 30 stays 30)', async () => {
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_oneshot', adapter: 'claude-code', model: 'm', timeoutSecs: 30 } }, CAP);
    const oneShot = stub(['none', 'read_only']);
    await sidecarComplete(db, 'enhance', 'p', { timeoutSecs: 60, oneShotMode: 'none' });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ timeoutSecs: 30 });
  });

  it('no-override agent_readonly still runs read_only (commit unchanged)', async () => {
    updateSidecarLlmSettings(db, { commit: { backend: 'agent_readonly', adapter: 'claude-code', model: 'm' } }, CAP);
    const oneShot = stub(['none', 'read_only']);
    await sidecarComplete(db, 'commit', 'diff', { systemPrompt: 'SP', cwd: REPO });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ mode: 'read_only', timeoutSecs: 120 });
  });

  it('project sub-mode resolves the project library, never quick', () => {
    expect(resolveSidecarPrompt(db, 'enhance', 'project')).toBe(DEFAULT_ENHANCE_PROJECT_PROMPT);
    expect(resolveSidecarPrompt(db, 'enhance', 'project', 'enhance-quick-1')).toBe(DEFAULT_ENHANCE_PROJECT_PROMPT);
    updateSidecarLlmSettings(db, {
      enhance: { backend: 'direct', projectPrompts: [{ id: 'pp', name: 'P', text: 'PROJECT-CUSTOM' }], projectSelectedPromptId: 'pp' },
    }, CAP);
    expect(resolveSidecarPrompt(db, 'enhance', 'project')).toBe('PROJECT-CUSTOM');
  });

  it('enhanceProjectStatus: off, unset, no read_only, configured', () => {
    stub(['none']);
    expect(enhanceProjectStatus(db)).toEqual({
      configured: false, reason: 'Configure Settings → Enhance project reads (adapter + model) first',
    });
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_oneshot', adapter: 'pi', model: 'm' } }, CAP);
    expect(enhanceProjectStatus(db)).toEqual({
      configured: false, reason: 'This adapter cannot do a read-only one-shot',
    });
    stub(['none', 'read_only']);
    expect(enhanceProjectStatus(db)).toEqual({ configured: true });
    updateSidecarLlmSettings(db, { enhance: { backend: 'agent_oneshot', adapter: 'pi', model: 'm', enabled: false } }, CAP);
    expect(enhanceProjectStatus(db)).toEqual({
      configured: false, reason: 'Enhance is switched off in Settings → Sidecar job routing',
    });
  });
});

describe('sidecarComplete remote cascade', () => {
  let db: Database.Database;
  const origClean = sidecarDeps.clean;
  const origCreate = sidecarDeps.createAdapter;
  const origHostView = sidecarDeps.hostView;
  const dirs: string[] = [];
  const CAP = [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: true }];

  function tmpCwd(): string {
    const d = mkdtempSync(join(tmpdir(), 'sidecar-cwd-'));
    dirs.push(d);
    return d;
  }

  function view(over: {
    state?: RemoteHostView['state'];
    installed?: boolean;
    methods?: string[];
    oneShotModes?: OneShotMode[];
    models?: string[];
    adapter?: string;
  } = {}): RemoteHostView {
    const adapter = over.adapter ?? 'pi';
    return {
      id: 'h1',
      name: 'host',
      state: over.state ?? 'connected',
      hello: {
        agents: {
          [adapter]: {
            installed: over.installed ?? true,
            methods: over.methods ?? ['oneShot'],
            ...(over.oneShotModes ? { oneShotModes: over.oneShotModes } : {}),
          },
        },
        models: { [adapter]: over.models ?? ['m'] },
      },
      allowMcpSecrets: true,
      createdAt: 0,
    };
  }

  function stubPair(
    remote: { oneShot: ReturnType<typeof vi.fn>; oneShotModes?: OneShotMode[] },
    hub?: { oneShot: ReturnType<typeof vi.fn>; oneShotModes?: OneShotMode[] },
  ) {
    sidecarDeps.createAdapter = vi.fn((_type: string, opts?: AdapterFactoryOpts) => (
      opts?.remoteHostId ? remote : (hub ?? remote)
    )) as never;
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'm' },
    }, CAP);
  });

  afterEach(() => {
    sidecarDeps.clean = origClean;
    sidecarDeps.createAdapter = origCreate;
    sidecarDeps.hostView = origHostView;
    vi.restoreAllMocks();
    db.close();
    for (const d of dirs.splice(0)) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('remote happy path calls the proxy with the remote cwd', async () => {
    sidecarDeps.hostView = () => view();
    const oneShot = vi.fn(async () => ({ text: 'from-remote' }));
    stubPair({ oneShot, oneShotModes: ['none'] });
    const out = await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    });
    expect(out).toBe('from-remote');
    expect(sidecarDeps.createAdapter).toHaveBeenCalledTimes(1);
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi', { remoteHostId: 'h1' });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ cwd: '/remote/path', mode: 'none' });
  });

  it('remote read_only happy path keeps cwd and floors timeout at 120', async () => {
    sidecarDeps.hostView = () => view({ oneShotModes: ['none', 'read_only'] });
    const oneShot = vi.fn(async () => ({ text: 'from-remote' }));
    stubPair({ oneShot, oneShotModes: ['none', 'read_only'] });
    await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1', oneShotMode: 'read_only',
    });
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi', { remoteHostId: 'h1' });
    expect(oneShot.mock.calls[0]![1]).toMatchObject({
      cwd: '/remote/path', mode: 'read_only',
    });
    expect((oneShot.mock.calls[0]![1] as { timeoutSecs: number }).timeoutSecs).toBeGreaterThanOrEqual(120);
  });

  it('disconnected host falls back to hub tools-off with no cwd', async () => {
    sidecarDeps.hostView = () => undefined;
    const hubShot = vi.fn(async () => ({ text: 'from-hub' }));
    stubPair({ oneShot: vi.fn(async () => ({ text: 'remote' })) }, { oneShot: hubShot, oneShotModes: ['none'] });
    const out = await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    });
    expect(out).toBe('from-hub');
    expect(sidecarDeps.createAdapter).toHaveBeenCalledTimes(1);
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi');
    expect(hubShot.mock.calls[0]![1]).toMatchObject({ mode: 'none' });
    expect(hubShot.mock.calls[0]![1]).not.toHaveProperty('cwd');
  });

  it('agent not installed on host falls back to hub', async () => {
    sidecarDeps.hostView = () => view({ installed: false });
    const hubShot = vi.fn(async () => ({ text: 'from-hub' }));
    stubPair({ oneShot: vi.fn() }, { oneShot: hubShot, oneShotModes: ['none'] });
    await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    });
    expect(sidecarDeps.createAdapter).toHaveBeenCalledTimes(1);
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi');
    expect(hubShot).toHaveBeenCalledOnce();
    expect(hubShot.mock.calls[0]![1]).not.toHaveProperty('cwd');
  });

  it('model not on host falls back to hub', async () => {
    sidecarDeps.hostView = () => view({ models: ['other'] });
    const hubShot = vi.fn(async () => ({ text: 'from-hub' }));
    stubPair({ oneShot: vi.fn() }, { oneShot: hubShot, oneShotModes: ['none'] });
    await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    });
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi');
    expect(hubShot).toHaveBeenCalledOnce();
    expect(hubShot.mock.calls[0]![1]).not.toHaveProperty('cwd');
  });

  it('no oneShot on host methods falls back to hub', async () => {
    sidecarDeps.hostView = () => view({ methods: ['listModels'] });
    const hubShot = vi.fn(async () => ({ text: 'from-hub' }));
    stubPair({ oneShot: vi.fn() }, { oneShot: hubShot, oneShotModes: ['none'] });
    await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    });
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi');
    expect(hubShot).toHaveBeenCalledOnce();
    expect(hubShot.mock.calls[0]![1]).not.toHaveProperty('cwd');
  });

  it('read_only requested but unsupported on host falls back to hub none', async () => {
    sidecarDeps.hostView = () => view({ oneShotModes: ['none'] });
    const hubShot = vi.fn(async () => ({ text: 'from-hub' }));
    stubPair({ oneShot: vi.fn() }, { oneShot: hubShot, oneShotModes: ['none'] });
    await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1', oneShotMode: 'read_only',
    });
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi');
    expect(hubShot.mock.calls[0]![1]).toMatchObject({ mode: 'none' });
    expect(hubShot.mock.calls[0]![1]).not.toHaveProperty('cwd');
  });

  it('remote oneShot reject falls back to hub and returns hub text', async () => {
    sidecarDeps.hostView = () => view();
    const remoteShot = vi.fn(async () => { throw new RpcError('timeout', 'rpc timeout'); });
    const hubShot = vi.fn(async () => ({ text: 'from-hub' }));
    stubPair({ oneShot: remoteShot, oneShotModes: ['none'] }, { oneShot: hubShot, oneShotModes: ['none'] });
    const out = await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    });
    expect(out).toBe('from-hub');
    expect(remoteShot).toHaveBeenCalledOnce();
    expect(hubShot).toHaveBeenCalledOnce();
  });

  it('remote empty text falls back to hub', async () => {
    sidecarDeps.hostView = () => view();
    const remoteShot = vi.fn(async () => ({ text: '   ' }));
    const hubShot = vi.fn(async () => ({ text: 'from-hub' }));
    stubPair({ oneShot: remoteShot, oneShotModes: ['none'] }, { oneShot: hubShot, oneShotModes: ['none'] });
    const out = await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    });
    expect(out).toBe('from-hub');
    expect(remoteShot).toHaveBeenCalledOnce();
    expect(hubShot).toHaveBeenCalledOnce();
  });

  it('both legs failing mentions remote reason and hub fallback', async () => {
    sidecarDeps.hostView = () => view();
    stubPair(
      { oneShot: vi.fn(async () => { throw new Error('remote boom'); }), oneShotModes: ['none'] },
      { oneShot: vi.fn(async () => { throw new Error('hub boom'); }), oneShotModes: ['none'] },
    );
    await expect(sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/remote/path', remoteHostId: 'h1',
    })).rejects.toThrow(/remote.*hub fallback failed/i);
  });

  it('local parity passes cwd to the hub adapter', async () => {
    const cwd = tmpCwd();
    const oneShot = vi.fn(async () => ({ text: 'from-local' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: ['none'] })) as never;
    const out = await sidecarComplete(db, 'commit', 'body', { systemPrompt: 'SP', cwd });
    expect(out).toBe('from-local');
    expect(sidecarDeps.createAdapter).toHaveBeenCalledTimes(1);
    expect(sidecarDeps.createAdapter).toHaveBeenCalledWith('pi');
    expect(oneShot.mock.calls[0]![1]).toMatchObject({ cwd, mode: 'none' });
  });

  it('local missing cwd with mode none drops cwd and still runs', async () => {
    const oneShot = vi.fn(async () => ({ text: 'ok' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: ['none'] })) as never;
    await sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/no/such/sidecar-cwd',
    });
    expect(oneShot).toHaveBeenCalledOnce();
    expect(oneShot.mock.calls[0]![1]).not.toHaveProperty('cwd');
  });

  it('local missing cwd with read_only throws and never spawns', async () => {
    const oneShot = vi.fn(async () => ({ text: 'ok' }));
    sidecarDeps.createAdapter = vi.fn(() => ({ oneShot, oneShotModes: ['none', 'read_only'] })) as never;
    await expect(sidecarComplete(db, 'commit', 'body', {
      systemPrompt: 'SP', cwd: '/no/such/sidecar-cwd', oneShotMode: 'read_only',
    })).rejects.toThrow(/does not exist on this host/);
    expect(oneShot).not.toHaveBeenCalled();
  });

  it('direct-LLM backend with remoteHostId never creates an adapter', async () => {
    updateEnhanceSettings(db, {
      model: 'enhance-model', baseUrl: 'http://enhance.local/v1', apiKey: 'ek',
    });
    updateSidecarLlmSettings(db, { describe: { backend: 'direct' } }, CAP);
    const clean = vi.fn(async () => 'from-clean');
    sidecarDeps.clean = clean as never;
    sidecarDeps.createAdapter = vi.fn(() => { throw new Error('should not create'); }) as never;
    const out = await sidecarComplete(db, 'describe', 'body', {
      systemPrompt: 'SP', remoteHostId: 'h1',
    });
    expect(out).toBe('from-clean');
    expect(sidecarDeps.createAdapter).not.toHaveBeenCalled();
  });

  it('remoteIneligible table covers each rejection reason', () => {
    const target = { adapter: 'pi', model: 'm' };
    expect(remoteIneligible(undefined, target, 'none')).toBe('host_disconnected');
    expect(remoteIneligible(view({ state: 'disconnected' }), target, 'none')).toBe('host_disconnected');
    expect(remoteIneligible(view({ installed: false }), target, 'none')).toBe('agent_not_installed');
    expect(remoteIneligible(view({ models: ['other'] }), target, 'none')).toBe('model_not_on_host');
    expect(remoteIneligible(view({ adapter: 'grok-bot' }), { adapter: 'grok-bot', model: 'm' }, 'none'))
      .toBe('agent_not_remote');
    expect(remoteIneligible(view({ methods: ['listModels'] }), target, 'none')).toBe('no_one_shot_on_host');
    expect(remoteIneligible(view({ oneShotModes: ['none'] }), target, 'read_only'))
      .toBe('mode_read_only_unsupported_on_host');
    expect(remoteIneligible(view({ oneShotModes: ['none', 'read_only'] }), target, 'read_only')).toBeNull();
    expect(remoteIneligible(view(), target, 'none')).toBeNull();
  });
});

describe('sidecarHostAdvisories', () => {
  let db: Database.Database;
  const CAP = [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: true }];

  function hostView(over: {
    state?: RemoteHostView['state'];
    hello?: RemoteHostView['hello'];
    installed?: boolean;
    methods?: string[];
    oneShotModes?: OneShotMode[];
    models?: string[];
    adapter?: string;
  } = {}): RemoteHostView {
    if (over.hello) {
      return {
        id: 'h1', name: 'host', state: over.state ?? 'connected',
        hello: over.hello, allowMcpSecrets: true, createdAt: 0,
      };
    }
    const adapter = over.adapter ?? 'pi';
    return {
      id: 'h1',
      name: 'host',
      state: over.state ?? 'connected',
      hello: {
        agents: {
          [adapter]: {
            installed: over.installed ?? true,
            methods: over.methods ?? ['oneShot'],
            ...(over.oneShotModes ? { oneShotModes: over.oneShotModes } : {}),
          },
        },
        models: { [adapter]: over.models ?? ['m'] },
      },
      allowMcpSecrets: true,
      createdAt: 0,
    };
  }

  function onlyCommitPi() {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'm' },
      describe: { backend: 'direct', enabled: false },
      enhance: { backend: 'direct', enabled: false },
      btw: { backend: 'agent_readonly', adapter: 'pi', model: 'm', enabled: false },
    }, CAP);
  }

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db, migrations);
    seedDefaultSettings(db);
  });

  afterEach(() => {
    db.close();
  });

  it('agent missing → advisory', () => {
    onlyCommitPi();
    const rows = sidecarHostAdvisories(db, hostView({ installed: false }));
    expect(rows).toEqual([{ site: 'commit', adapter: 'pi', model: 'm', reason: 'agent_not_installed' }]);
  });

  it('model missing → advisory', () => {
    onlyCommitPi();
    const rows = sidecarHostAdvisories(db, hostView({ models: ['other'] }));
    expect(rows).toEqual([{ site: 'commit', adapter: 'pi', model: 'm', reason: 'model_not_on_host' }]);
  });

  it('oneShot missing from methods → advisory', () => {
    onlyCommitPi();
    const rows = sidecarHostAdvisories(db, hostView({ methods: ['listModels'] }));
    expect(rows).toEqual([{ site: 'commit', adapter: 'pi', model: 'm', reason: 'no_one_shot_on_host' }]);
  });

  it('read_only missing from oneShotModes → only the enhance-project advisory', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'm' },
      describe: { backend: 'direct', enabled: false },
      enhance: { backend: 'agent_oneshot', adapter: 'pi', model: 'm' },
      btw: { backend: 'agent_readonly', adapter: 'pi', model: 'm', enabled: false },
    }, CAP);
    const rows = sidecarHostAdvisories(db, hostView({ oneShotModes: ['none'] }));
    expect(rows).toEqual([{
      site: 'enhance', adapter: 'pi', model: 'm', reason: 'mode_read_only_unsupported_on_host',
    }]);
  });

  it('a direct-LLM route → none', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'direct' },
      describe: { backend: 'direct' },
      enhance: { backend: 'direct' },
      btw: { backend: 'direct', enabled: false },
    }, CAP);
    expect(sidecarHostAdvisories(db, hostView())).toEqual([]);
  });

  it('a disabled site → none', () => {
    updateSidecarLlmSettings(db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'm', enabled: false },
      describe: { backend: 'direct', enabled: false },
      enhance: { backend: 'direct', enabled: false },
      btw: { backend: 'agent_readonly', adapter: 'pi', model: 'm', enabled: false },
    }, CAP);
    expect(sidecarHostAdvisories(db, hostView({ installed: false }))).toEqual([]);
  });

  it('a disconnected host with full parity → none', () => {
    onlyCommitPi();
    expect(sidecarHostAdvisories(db, hostView({ state: 'disconnected' }))).toEqual([]);
  });

  it('empty hello → none', () => {
    onlyCommitPi();
    expect(sidecarHostAdvisories(db, hostView({ hello: {} }))).toEqual([]);
    expect(sidecarHostAdvisories(db, hostView({ hello: { hostname: 'box' } }))).toEqual([]);
  });
});
