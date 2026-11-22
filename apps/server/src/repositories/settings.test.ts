import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import { seedDefaultSettings } from '../db/seed.js';
import { getCompactionSettings, updateCompactionSettings, getVoiceSettings, updateVoiceSettings, getGeneralSettings, updateGeneralSettings, getGlobalTasksSettings, updateGlobalTasksSettings, getSessionFloorMs, bumpSessionFloor } from './settings.js';
import { VOICE_DEFAULTS, GENERAL_DEFAULTS } from '../db/seed.js';
import { DEFAULT_ROLE_MATCH_KEYWORDS } from '@tierwyn/shared';
import { getSpawnTokenTtlMs } from '../spawn/tokens.js';
import { getScheduleRunTokenTtlMs } from '../schedules/runTokens.js';
import { getSpawnStallTimeoutMs } from '../spawn/watch.js';

function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db, migrations);
  seedDefaultSettings(db);
  return db;
}

describe('settings repository', () => {
  it('reads default compaction settings', () => {
    const db = freshDb();
    expect(getCompactionSettings(db).outputTokenCap).toBe(4000);
  });

  it('merges partial updates', () => {
    const db = freshDb();
    const updated = updateCompactionSettings(db, { summaryVerbosity: 'high' });
    expect(updated.summaryVerbosity).toBe('high');
    expect(updated.outputTokenCap).toBe(4000); // unchanged
    expect(getCompactionSettings(db).summaryVerbosity).toBe('high');
  });

  it('normalises a legacy row missing the new handoff keys to defaults', () => {
    // Simulate a row written before the four new fields existed — only the
    // original 5 keys are present. getCompactionSettings must backfill the
    // new keys via COMPACTION_DEFAULTS so downstream code can rely on them.
    const db = freshDb();
    const legacy = {
      preferredProfileId: 'claude-code:sonnet-4.6',
      fallbackProfileId: 'claude-code:opus-4.8',
      maxCompactorContextTokens: 100_000,
      summaryVerbosity: 'medium',
      outputTokenCap: 4000,
    };
    db.prepare("UPDATE settings SET value = ? WHERE key = 'compaction'").run(JSON.stringify(legacy));
    const s = getCompactionSettings(db);
    expect(s.compactionEnabled).toBe(true);
    expect(s.handoffMode).toBe('summary');
    expect(s.maxTranscriptHandoffTokens).toBe(150_000);
    expect(s.transcriptContextSafetyFactor).toBe(0.5);
    // Original keys preserved.
    expect(s.outputTokenCap).toBe(4000);
    expect(s.preferredProfileId).toBe('claude-code:sonnet-4.6');
  });

  it('defaults mesh settings to off and coerces reserved/unknown values', () => {
    const db = freshDb();
    const s = getCompactionSettings(db);
    expect(s.meshAwareness).toBe('off');
    expect(s.meshMessaging).toBe('off');
    expect(s.meshMaxPeersPerConversation).toBe(4);
    expect(s.meshMaxHops).toBe(2);
    expect(s.meshAutoEdges).toBe(true);
    const on = updateCompactionSettings(db, { meshAwareness: 'subtree' });
    expect(on.meshAwareness).toBe('subtree');
    const row = db.prepare("SELECT value FROM settings WHERE key = 'compaction'").get() as { value: string };
    const raw = JSON.parse(row.value) as Record<string, unknown>;
    raw.meshAwareness = 'project';
    raw.meshMaxHops = 9;
    delete raw.meshAutoEdges;
    db.prepare("UPDATE settings SET value = ? WHERE key = 'compaction'").run(JSON.stringify(raw));
    const coerced = getCompactionSettings(db);
    expect(coerced.meshAwareness).toBe('off');
    expect(coerced.meshMaxHops).toBe(3);
    expect(coerced.meshAutoEdges).toBe(true);
    expect(updateCompactionSettings(db, { meshAutoEdges: false }).meshAutoEdges).toBe(false);
    expect(updateCompactionSettings(db, { meshAutoEdges: true }).meshAutoEdges).toBe(true);
  });
});

describe('grokBotTranscriptEventLimit', () => {
  it('accepts 0, 100, 2000, and 100000 and round-trips', () => {
    const db = freshDb();
    for (const n of [0, 100, 2000, 100_000]) {
      const updated = updateGeneralSettings(db, { grokBotTranscriptEventLimit: n });
      expect(updated.grokBotTranscriptEventLimit).toBe(n);
      expect(getGeneralSettings(db).grokBotTranscriptEventLimit).toBe(n);
    }
  });

  it('rejects 1, 99, −5, 100001, 1.5, and non-integers', () => {
    const db = freshDb();
    const msg = /grokBotTranscriptEventLimit must be 0 \(unlimited\) or an integer 100–100000/;
    for (const n of [1, 99, -5, 100_001, 1.5, 'abc' as unknown as number]) {
      expect(() => updateGeneralSettings(db, { grokBotTranscriptEventLimit: n })).toThrow(msg);
    }
  });

  it('merges the 2000 default onto a general blob that predates this field', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.grokBotTranscriptEventLimit).toBe(2000);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'general'").run(JSON.stringify({
      defaultConversationProfileId: null,
      conversationRetentionDays: 0,
      fileEditsEnabled: false,
      hidePresetPrompts: false,
      hideShippedSchedulePacks: false,
      grokBotAutoCreateRemoteAgents: true,
    }));
    expect(getGeneralSettings(db).grokBotTranscriptEventLimit).toBe(2000);
  });
});

describe('grokBotBackfillEntries and grokBotDeleteBotOnConversationDelete', () => {
  it('defaults backfill to 200 and delete-bot to false', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.grokBotBackfillEntries).toBe(200);
    expect(GENERAL_DEFAULTS.grokBotDeleteBotOnConversationDelete).toBe(false);
    expect(GENERAL_DEFAULTS.grokBotInProjectChats).toBe(false);
    expect(getGeneralSettings(db).grokBotBackfillEntries).toBe(200);
    expect(getGeneralSettings(db).grokBotDeleteBotOnConversationDelete).toBe(false);
    expect(getGeneralSettings(db).grokBotInProjectChats).toBe(false);
  });

  it('accepts 0 and 2000 for backfill and round-trips', () => {
    const db = freshDb();
    for (const n of [0, 200, 2000]) {
      const updated = updateGeneralSettings(db, { grokBotBackfillEntries: n });
      expect(updated.grokBotBackfillEntries).toBe(n);
      expect(getGeneralSettings(db).grokBotBackfillEntries).toBe(n);
    }
  });

  it('rejects -1, 2001, 1.5, and non-integers for backfill', () => {
    const db = freshDb();
    const msg = /grokBotBackfillEntries must be an integer 0–2000/;
    for (const n of [-1, 2001, 1.5, 'x' as unknown as number]) {
      expect(() => updateGeneralSettings(db, { grokBotBackfillEntries: n })).toThrow(msg);
    }
  });

  it('accepts true/false for the delete flag and rejects non-booleans', () => {
    const db = freshDb();
    expect(updateGeneralSettings(db, { grokBotDeleteBotOnConversationDelete: true })
      .grokBotDeleteBotOnConversationDelete).toBe(true);
    expect(updateGeneralSettings(db, { grokBotDeleteBotOnConversationDelete: false })
      .grokBotDeleteBotOnConversationDelete).toBe(false);
    expect(() => updateGeneralSettings(db, {
      grokBotDeleteBotOnConversationDelete: 'yes' as unknown as boolean,
    })).toThrow(/grokBotDeleteBotOnConversationDelete must be a boolean/);
  });

  it('accepts booleans for allowAgentRecurringSchedules and autoArchiveCompletedOneShots and rejects non-booleans', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.allowAgentRecurringSchedules).toBe(false);
    expect(GENERAL_DEFAULTS.autoArchiveCompletedOneShots).toBe(true);

    const updated = updateGeneralSettings(db, {
      allowAgentRecurringSchedules: true,
      autoArchiveCompletedOneShots: false,
    });
    expect(updated.allowAgentRecurringSchedules).toBe(true);
    expect(updated.autoArchiveCompletedOneShots).toBe(false);

    expect(() => updateGeneralSettings(db, {
      allowAgentRecurringSchedules: 'true' as any,
    })).toThrow(/allowAgentRecurringSchedules must be a boolean/);

    expect(() => updateGeneralSettings(db, {
      autoArchiveCompletedOneShots: 1 as any,
    })).toThrow(/autoArchiveCompletedOneShots must be a boolean/);
  });

  it('defaults roleMatchKeywords to a clone of the shared map', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.roleMatchKeywords).toEqual(DEFAULT_ROLE_MATCH_KEYWORDS);
    expect(GENERAL_DEFAULTS.roleMatchKeywords).not.toBe(DEFAULT_ROLE_MATCH_KEYWORDS);
    expect(GENERAL_DEFAULTS.roleMatchKeywords.implement).not.toBe(DEFAULT_ROLE_MATCH_KEYWORDS.implement);
    expect(getGeneralSettings(db).roleMatchKeywords).toEqual(GENERAL_DEFAULTS.roleMatchKeywords);
    expect(getGeneralSettings(db).roleMatchKeywords.implement).not.toBe(DEFAULT_ROLE_MATCH_KEYWORDS.implement);
  });

  it('strips legacy pipelineDefaults on read and subsequent write', () => {
    const db = freshDb();
    db.prepare("UPDATE settings SET value = ? WHERE key = 'general'").run(JSON.stringify({
      defaultConversationProfileId: null,
      conversationRetentionDays: 0,
      fileEditsEnabled: false,
      hidePresetPrompts: false,
      hideShippedSchedulePacks: false,
      pipelineDefaults: { stages: [], commitOnTick: true },
    }));
    const got = getGeneralSettings(db);
    expect((got as Record<string, unknown>).pipelineDefaults).toBeUndefined();
    const saved = updateGeneralSettings(db, { fileEditsEnabled: true });
    expect((saved as Record<string, unknown>).pipelineDefaults).toBeUndefined();
    const row = db.prepare("SELECT value FROM settings WHERE key = 'general'").get() as { value: string };
    expect(row.value).not.toContain('pipelineDefaults');
  });

  it('rejects invalid roleMatchKeywords and round-trips a valid patch', () => {
    const db = freshDb();
    expect(() => updateGeneralSettings(db, {
      roleMatchKeywords: { 'Bad': ['x'] } as any,
    })).toThrow(/roleMatchKeywords/);

    const updated = updateGeneralSettings(db, {
      roleMatchKeywords: { implement: ['Code', 'code', 'Coder'] },
    });
    expect(updated.roleMatchKeywords).toEqual({ implement: ['code', 'coder'] });
    expect(getGeneralSettings(db).roleMatchKeywords).toEqual({ implement: ['code', 'coder'] });
  });
});

describe('voice settings tts', () => {
  it('returns tts defaults from getVoiceSettings', () => {
    const db = freshDb();
    expect(getVoiceSettings(db).tts).toEqual(VOICE_DEFAULTS.tts);
  });

  it('deep-merges partial tts updates', () => {
    const db = freshDb();
    updateVoiceSettings(db, { tts: { provider: 'piper' } });
    const s = getVoiceSettings(db);
    expect(s.tts.provider).toBe('piper');
    expect(s.tts.kokoroUrl).toBe(VOICE_DEFAULTS.tts.kokoroUrl);
  });

  it('cleanup-only save preserves tts block', () => {
    const db = freshDb();
    updateVoiceSettings(db, { tts: { provider: 'kokoro' } });
    updateVoiceSettings(db, { cleanup: { enabled: true } });
    expect(getVoiceSettings(db).tts.provider).toBe('kokoro');
  });

  it('saveRecordings defaults true and merges false', () => {
    const db = freshDb();
    expect(getVoiceSettings(db).tts.saveRecordings).toBe(true);
    updateVoiceSettings(db, { tts: { saveRecordings: false } });
    expect(getVoiceSettings(db).tts.saveRecordings).toBe(false);
  });
});

describe('timeout settings', () => {
  it('reads default timeout settings', () => {
    const db = freshDb();
    const s = getCompactionSettings(db);
    expect(s.spawnTokenIdleTtlMinutes).toBe(30);
    expect(s.scheduleRunTokenIdleTtlMinutes).toBe(30);
    expect(s.spawnStallTimeoutMinutes).toBe(15);
  });

  it('clamps out-of-range timeout values and applies them to runtime setters', () => {
    const db = freshDb();
    // Too low
    const low = updateCompactionSettings(db, {
      spawnTokenIdleTtlMinutes: 1,
      scheduleRunTokenIdleTtlMinutes: -10,
      spawnStallTimeoutMinutes: 0,
    });
    expect(low.spawnTokenIdleTtlMinutes).toBe(5);
    expect(low.scheduleRunTokenIdleTtlMinutes).toBe(5);
    expect(low.spawnStallTimeoutMinutes).toBe(1);
    expect(getSpawnTokenTtlMs()).toBe(5 * 60_000);
    expect(getScheduleRunTokenTtlMs()).toBe(5 * 60_000);
    expect(getSpawnStallTimeoutMs()).toBe(1 * 60_000);

    // Too high
    const high = updateCompactionSettings(db, {
      spawnTokenIdleTtlMinutes: 2000,
      scheduleRunTokenIdleTtlMinutes: 5000,
      spawnStallTimeoutMinutes: 500,
    });
    expect(high.spawnTokenIdleTtlMinutes).toBe(1440);
    expect(high.scheduleRunTokenIdleTtlMinutes).toBe(1440);
    expect(high.spawnStallTimeoutMinutes).toBe(240);
    expect(getSpawnTokenTtlMs()).toBe(1440 * 60_000);
    expect(getScheduleRunTokenTtlMs()).toBe(1440 * 60_000);
    expect(getSpawnStallTimeoutMs()).toBe(240 * 60_000);

    // Valid values
    const valid = updateCompactionSettings(db, {
      spawnTokenIdleTtlMinutes: 45,
      scheduleRunTokenIdleTtlMinutes: 60,
      spawnStallTimeoutMinutes: 20,
    });
    expect(valid.spawnTokenIdleTtlMinutes).toBe(45);
    expect(valid.scheduleRunTokenIdleTtlMinutes).toBe(60);
    expect(valid.spawnStallTimeoutMinutes).toBe(20);
    expect(getSpawnTokenTtlMs()).toBe(45 * 60_000);
    expect(getScheduleRunTokenTtlMs()).toBe(60 * 60_000);
    expect(getSpawnStallTimeoutMs()).toBe(20 * 60_000);

    // Reset back to defaults
    updateCompactionSettings(db, {
      spawnTokenIdleTtlMinutes: 30,
      scheduleRunTokenIdleTtlMinutes: 30,
      spawnStallTimeoutMinutes: 15,
    });
  });
});

describe('global_tasks settings', () => {
  it('absent row returns defaults', () => {
    const db = freshDb();
    expect(getGlobalTasksSettings(db)).toEqual({
      enabled: true, scope: 'roots', staleAfterHours: 48, autoDeleteHiddenAfterDays: 30,
    });
  });

  it('update({scope:all}) merges and persists', () => {
    const db = freshDb();
    const next = updateGlobalTasksSettings(db, { scope: 'all' });
    expect(next).toEqual({
      enabled: true, scope: 'all', staleAfterHours: 48, autoDeleteHiddenAfterDays: 30,
    });
    expect(getGlobalTasksSettings(db).scope).toBe('all');
  });

  it('invalid field resets to the default, not the previous value', () => {
    const db = freshDb();
    updateGlobalTasksSettings(db, { staleAfterHours: 10 });
    expect(getGlobalTasksSettings(db).staleAfterHours).toBe(10);
    const next = updateGlobalTasksSettings(db, { staleAfterHours: -5 });
    expect(next.staleAfterHours).toBe(48);
  });
});

describe('agentSearchScope setting', () => {
  it('defaults to project, including for a legacy row without the key', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.agentSearchScope).toBe('project');
    expect(getGeneralSettings(db).agentSearchScope).toBe('project');
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('general', ?)")
      .run(JSON.stringify({ fileEditsEnabled: true }));
    expect(getGeneralSettings(db).agentSearchScope).toBe('project');
  });

  it('round-trips off | project | all and rejects other values', () => {
    const db = freshDb();
    expect(updateGeneralSettings(db, { agentSearchScope: 'off' }).agentSearchScope).toBe('off');
    expect(updateGeneralSettings(db, { agentSearchScope: 'all' }).agentSearchScope).toBe('all');
    expect(updateGeneralSettings(db, { agentSearchScope: 'project' }).agentSearchScope).toBe('project');
    expect(() => updateGeneralSettings(db, { agentSearchScope: 'global' as 'all' }))
      .toThrow(/agentSearchScope must be off \| project \| all/);
  });
});

describe('memories setting', () => {
  it('defaults to false, including for a legacy row without the key', () => {
    const db = freshDb();
    expect(GENERAL_DEFAULTS.memories).toBe(false);
    expect(getGeneralSettings(db).memories).toBe(false);
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('general', ?)")
      .run(JSON.stringify({ fileEditsEnabled: true }));
    expect(getGeneralSettings(db).memories).toBe(false);
  });

  it('round-trips booleans and rejects non-booleans', () => {
    const db = freshDb();
    expect(updateGeneralSettings(db, { memories: true }).memories).toBe(true);
    expect(getGeneralSettings(db).memories).toBe(true);
    expect(updateGeneralSettings(db, { memories: false }).memories).toBe(false);
    expect(() => updateGeneralSettings(db, { memories: 'yes' as unknown as boolean }))
      .toThrow(/memories must be a boolean/);
  });
});

describe('session floor', () => {
  it('starts at 0 and round-trips bumpSessionFloor', () => {
    const db = freshDb();
    expect(getSessionFloorMs(db)).toBe(0);
    expect(bumpSessionFloor(db, 1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(getSessionFloorMs(db)).toBe(1_700_000_000_000);
    bumpSessionFloor(db, 1_700_000_000_001);
    expect(getSessionFloorMs(db)).toBe(1_700_000_000_001);
  });
});
