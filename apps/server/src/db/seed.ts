import { homedir } from 'os';
import type { Database } from 'better-sqlite3';
import type { AgentProfile, CompactionSettings, GeneralSettings, VoiceSettings } from '@tierwyn/shared';
import { agentDisplayName, DEFAULT_ROLE_MATCH_KEYWORDS, SANDBOX_SETTINGS_DEFAULTS } from '@tierwyn/shared';
import { readProfiles } from '../profiles.js';
import { readCommands, type SeedCommandEntry } from '../commands.js';
import { normaliseContextWindow } from '../contextWindow.js';
import { SHIPPED_PACKS } from '../schedules/packs/index.js';
import { upsertShippedPack } from '../repositories/schedulePacks.js';

export { readProfiles };

/**
 * Synchronise the agents and agent_models tables with agent-profiles.json.
 *
 * JSON is the source of truth for every field except `id` and `context_window`:
 * existing seed rows are updated in place (label, provider, vision_flag,
 * steer_flag, description overwritten; enabled_flag is set on first insert
 * only and then belongs to the operator), and seed rows whose
 * (agent_id, model_name) no longer appear in the JSON are pruned.
 *
 * FW-7 exception: context_window uses COALESCE(excluded, existing) so a profile
 * that DROPS the field keeps its last known window instead of regressing to
 * "unknown" — a window is corrected by writing the right number, never by
 * omission. Clearing one is a manual UPDATE on this single-user DB.
 *
 * Rows with source='user' (Phase 5 CRUD) and source='discovered' (dynamic
 * adapters) are never touched here.
 *
 * The optional `profiles` parameter is for tests that want to drive the
 * upsert+prune with an in-memory list. Production callers omit it and
 * readProfiles() runs against agent-profiles.json.
 */
export function seedCatalogue(db: Database, profiles?: AgentProfile[]): void {
  const list = profiles ?? readProfiles();
  const now = Date.now();

  const agentTypes = new Map<string, AgentProfile>();
  for (const p of list) {
    if (!agentTypes.has(p.agentType)) agentTypes.set(p.agentType, p);
  }

  const tx = db.transaction(() => {
    const upsertAgent = db.prepare(
      // ponytail: enabled_flag only in the INSERT, never in DO UPDATE — a fresh
      // install lands every agent disabled, a re-seed of a live DB preserves the
      // operator's toggles. Do not add enabled_flag to the DO UPDATE SET list.
      `INSERT INTO agents (id, type, label, description, executable_path, env_vars, enabled_flag, created_at)
       VALUES (@id, @type, @label, @description, NULL, '{}', 0, @now)
       ON CONFLICT(id) DO UPDATE SET
         label = excluded.label,
         description = excluded.description`
    );
    for (const [type, p] of agentTypes) {
      upsertAgent.run({
        id: type, type, label: agentDisplayName(type), description: p.description ?? '', now,
      });
    }

    // Conflict target is the PK `id`, NOT the (agent_id, model_name) unique
    // index: when a profile's model_name is renamed in agent-profiles.json
    // (id stable), matching on (agent_id, model_name) misses and the INSERT
    // hits the PK collision instead — crashing boot. Matching on `id` makes
    // model_name renames safe.
    const upsertModel = db.prepare(
      `INSERT INTO agent_models
         (id, agent_id, model_name, label, provider, vision_flag, steer_flag,
          enabled_flag, description, context_window, source, created_at)
       VALUES (@id, @agent_id, @model_name, @label, @provider, @vision, @steer,
               @enabled, @description, @context_window, 'seed', @now)
       ON CONFLICT(id) DO UPDATE SET
         agent_id = excluded.agent_id,
         model_name = excluded.model_name,
         label = excluded.label,
         provider = excluded.provider,
         vision_flag = excluded.vision_flag,
         steer_flag = excluded.steer_flag,
         -- ponytail: enabled_flag is INSERT-only (like agents above) — the
         -- operator's picker toggle must survive every boot re-seed.
         description = excluded.description,
         context_window = COALESCE(excluded.context_window, agent_models.context_window),
         source = 'seed'`
    );
    for (const p of list) {
      upsertModel.run({
        id: p.id,
        agent_id: p.agentType,
        model_name: p.model,
        label: p.label,
        provider: p.provider ?? null,
        vision: p.vision ? 1 : 0,
        steer: p.steer ? 1 : 0,
        enabled: p.enabled ? 1 : 0,
        description: p.description ?? '',
        context_window: normaliseContextWindow(p.contextWindow),
        now,
      });
    }

    // Prune seed rows whose (agent_id, model_name) is no longer in the JSON.
    // source='user' and source='discovered' rows are exempt.
    if (list.length === 0) {
      // Defensive: readProfiles already guards against a missing file, but
      // an explicitly-empty JSON would still reach here. Refuse to prune in
      // that case so a malformed JSON can never wipe the catalogue.
      throw new Error('agent-profiles.json: empty profiles array — refusing to prune');
    }
    const placeholders = list.map(() => '?').join(',');
    const staleKeys = list.map((p) => `${p.agentType}|${p.model}`);
    // Null out FK references first — sessions/events have no ON DELETE CASCADE.
    db.prepare(
      `UPDATE sessions SET agent_model_id = NULL
       WHERE agent_model_id IN (
         SELECT id FROM agent_models
         WHERE source = 'seed'
           AND (agent_id || '|' || model_name) NOT IN (${placeholders})
       )`
    ).run(...staleKeys);
    db.prepare(
      `UPDATE events SET agent_model_id = NULL
       WHERE agent_model_id IN (
         SELECT id FROM agent_models
         WHERE source = 'seed'
           AND (agent_id || '|' || model_name) NOT IN (${placeholders})
       )`
    ).run(...staleKeys);

    // FW-4 follow-up: re-apply manual metadata overrides after the seed
    // refresh, mirroring upsertDiscoveredModels. Without this, boot seeding
    // reverts operator vision/steer edits on seed rows — and for agents whose
    // listModels() returns [] (e.g. hermes), discovery never re-heals them,
    // so the edit reverts on EVERY restart.
    db.prepare(
      `UPDATE agent_models AS m
          SET vision_flag = COALESCE(o.vision_override, m.vision_flag),
              steer_flag  = COALESCE(o.steer_override,  m.steer_flag)
        FROM agent_model_overrides AS o
       WHERE o.agent_id = m.agent_id
         AND o.model_name = m.model_name`
    ).run();
    db.prepare(
      `DELETE FROM agent_models
       WHERE source = 'seed'
         AND (agent_id || '|' || model_name) NOT IN (${placeholders})`
    ).run(...staleKeys);
  });

  tx();
}

/**
 * Synchronise built-in slash verbs from agent-commands.json into agent_commands
 * with source='seed'. Mirrors seedCatalogue semantics — JSON is source of truth,
 * stale seed rows are pruned, empty list throws.
 */
export function seedCommands(db: Database, commands?: SeedCommandEntry[]): void {
  const list = commands ?? readCommands();
  const now = Date.now();

  const agentTypes = new Set(list.map((c) => c.agentType));

  const tx = db.transaction(() => {
    const upsertAgent = db.prepare(
      `INSERT INTO agents (id, type, label, description, executable_path, env_vars, enabled_flag, created_at)
       VALUES (@id, @id, @label, '', NULL, '{}', 0, @now)
       ON CONFLICT(id) DO NOTHING`
    );
    for (const type of agentTypes) {
      upsertAgent.run({ id: type, label: agentDisplayName(type), now });
    }

    const upsert = db.prepare(
      `INSERT INTO agent_commands
         (id, agent_id, name, label, description, source, source_detail, enabled_flag, created_at)
       VALUES (@id, @agent_id, @name, @label, @description, 'seed', @source_detail, 1, @now)
       ON CONFLICT(agent_id, name) DO UPDATE SET
         label = excluded.label,
         description = excluded.description,
         source_detail = excluded.source_detail,
         source = 'seed'`
    );
    for (const c of list) {
      upsert.run({
        id: `${c.agentType}:${c.name}`,
        agent_id: c.agentType,
        name: c.name,
        label: c.label,
        description: c.description ?? '',
        source_detail: c.sourceDetail ?? 'builtin',
        now,
      });
    }

    if (list.length === 0) {
      throw new Error('agent-commands.json: empty commands array — refusing to prune');
    }
    const placeholders = list.map(() => '?').join(',');
    db.prepare(
      `DELETE FROM agent_commands
       WHERE source = 'seed'
         AND (agent_id || '|' || name) NOT IN (${placeholders})`
    ).run(...list.map((c) => `${c.agentType}|${c.name}`));
  });

  tx();
}

export const GENERAL_DEFAULTS: GeneralSettings = {
  defaultConversationProfileId: null,
  conversationRetentionDays: 0,
  toolResultTrimDays: 0,
  fileEditsEnabled: false,
  hidePresetPrompts: false,
  hideShippedSchedulePacks: false,
  // ponytail: rides the general settings blob; a dedicated key buys nothing here.
  grokBotAutoCreateRemoteAgents: true,
  grokBotAutoStart: 'keep-running',
  // ponytail: rides the general settings blob; a dedicated key buys nothing here.
  grokBotTranscriptEventLimit: 2000,
  grokBotBackfillEntries: 200,
  grokBotDeleteBotOnConversationDelete: false,
  grokBotInProjectChats: false,
  memories: false,
  agentSearchScope: 'project',
  markupHint: 'all',
  allowAgentAutoScheduling: true,
  allowAgentRecurringSchedules: false,
  // ponytail: default on — archive is reversible (unarchive) and completed one-shots are dead rows.
  autoArchiveCompletedOneShots: true,
  roleMatchKeywords: structuredClone(DEFAULT_ROLE_MATCH_KEYWORDS),
};

/** Fixed id so the row is idempotent by primary key and greppable in logs. */
export const REMOTE_AGENTS_PROJECT_ID = '00000000-0000-4000-8000-00000000b07d';

export function ensureRemoteAgentsProject(db: Database): string {
  db.prepare(
    'INSERT OR IGNORE INTO projects (id, name, root_path, created_at, system) VALUES (?,?,?,?,1)',
  ).run(REMOTE_AGENTS_PROJECT_ID, 'Grok Bots', homedir(), Date.now());
  // Re-assert the flag and ensure the name is kept current:
  db.prepare('UPDATE projects SET system = 1, name = ? WHERE id = ?').run('Grok Bots', REMOTE_AGENTS_PROJECT_ID);
  return REMOTE_AGENTS_PROJECT_ID;
}

export const COMPACTION_DEFAULTS: CompactionSettings = {
  // Both defaults are claude-code. If that CLI is missing on a fresh install,
  // compact() tries preferred then fallback, both throw, and buildResumePlan
  // falls back to a capped transcript. We do not auto-pick an arbitrary enabled
  // catalogue profile — most adapters are not tool-free summariser-capable.
  preferredProfileId: 'claude-code:sonnet-4.6',
  fallbackProfileId: 'claude-code:opus-4.8',
  maxCompactorContextTokens: 100_000,
  summaryVerbosity: 'medium',
  outputTokenCap: 4000,
  compactionEnabled: true,
  handoffMode: 'summary',
  maxTranscriptHandoffTokens: 150_000,
  transcriptContextSafetyFactor: 0.5,
  interactionMode: 'bypass',
  spawnApprovalRequired: false,
  meshAwareness: 'off',
  meshMessaging: 'off',
  meshMaxPeersPerConversation: 4,
  meshMessagesPerMinute: 6,
  meshMessagesPerMinuteGlobal: 20,
  meshMaxHops: 2,
  meshAutoEdges: true,
  usageAutoResume: 'delegates',
  usageAutoResumeMaxDeferMs: 8 * 60 * 60 * 1000,
  usageAutoResumeMaxAttempts: 3,
  spawnTokenIdleTtlMinutes: 30,
  scheduleRunTokenIdleTtlMinutes: 30,
  spawnStallTimeoutMinutes: 15,
};

// Prompt constants now live in @tierwyn/shared so the web picker can render
// them. Re-export here to keep existing importers (settings repo, tests) working.
export { DEFAULT_VOICE_CLEANUP_PROMPT, STRUCTURED_VOICE_CLEANUP_PROMPT, BUILTIN_VOICE_PROMPTS } from '@tierwyn/shared';
import { DEFAULT_VOICE_CLEANUP_PROMPT, defaultVoiceProviderValues } from '@tierwyn/shared';

const VOICE_PROVIDER_VALUES = defaultVoiceProviderValues();

export const VOICE_DEFAULTS: VoiceSettings = {
  cleanup: {
    // Default OFF for the first deploy — the operator must point it at a local
    // LM Studio (or other OpenAI-compatible endpoint) and pick a model before
    // it fires. Raw transcript still flows through to the InputBar.
    enabled: false,
    provider: 'lmstudio',
    providerValues: VOICE_PROVIDER_VALUES,
    baseUrl: VOICE_PROVIDER_VALUES.lmstudio.baseUrl,
    apiKey: VOICE_PROVIDER_VALUES.lmstudio.apiKey,
    model: VOICE_PROVIDER_VALUES.lmstudio.model,
    systemPrompt: DEFAULT_VOICE_CLEANUP_PROMPT, // legacy fallback field
    timeoutSecs: 20,
    selectedPromptId: 'builtin-1',
    prompts: [],
  },
  // ponytail: browser default — zero infra, works on first boot before any sidecar exists.
  tts: {
    enabled: true,
    provider: 'browser',
    piperUrl: 'http://127.0.0.1:5000',
    piperVoice: 'en_US-lessac-medium',
    kokoroUrl: 'http://127.0.0.1:8880',
    kokoroVoice: 'af_heart',
    selectedPromptId: 'tts-builtin-1',
    prompts: [],
    saveRecordings: true,
  },
};

export function seedDefaultSettings(db: Database): void {
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('compaction', ?)")
    .run(JSON.stringify(COMPACTION_DEFAULTS));
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('sandbox', ?)")
    .run(JSON.stringify(SANDBOX_SETTINGS_DEFAULTS));
  db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('voice', ?)")
    .run(JSON.stringify(VOICE_DEFAULTS));
}

/** Idempotent. Re-upserts shipped packs from source; never touches imported rows. */
export function seedSchedulePacks(db: Database): void {
  for (const pack of SHIPPED_PACKS) upsertShippedPack(db, pack);
}

/**
 * Enable every stored agent. Production never calls this — the operator toggles
 * agents in Settings → Agents, which runs an install probe first. It exists so
 * server tests can keep asserting against a fully-populated listProfiles() after
 * seedCatalogue(), which now inserts agents disabled.
 */
export function enableAllAgents(db: Database): void {
  db.prepare('UPDATE agents SET enabled_flag = 1').run();
}
