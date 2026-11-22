import type { Database } from 'better-sqlite3';
import type {
  BtwSettings, CompactionSettings, DirectLlmProfile, DirectLlmProfileId, EnhanceSettings,
  DecisionSettings, GeneralSettings, NotificationSettings, TagCatalogueParseResult, TagCatalogueSettings,
  PublicDecisionSettings, PublicNotificationSettings, PromptCollectionEntry, RoleWhenPreset, SpawnTemplate,
  GlobalTasksSettings,
  VoiceCleanupProvider, VoiceCleanupProviderValues, VoiceCleanupSettings, VoiceSettings,
  VoiceTtsSettings, SidecarBackend, SidecarLlmSettings, SidecarPrompt, SidecarSite, SidecarSiteRoute,
} from '@tierwyn/shared';
import {
  validateMcpIdList,
  DECISION_DEFAULTS, defaultVoiceProviderValues, DIRECT_LLM_DEFAULT_LABELS, DIRECT_LLM_PROFILE_IDS,
  directConnectionConfigured,
  ENHANCE_DEFAULTS, isSidecarAgentBackend, NOTIFICATION_DEFAULTS,
  voiceProviderValuesFor, VOICE_PROVIDER_PRESETS, SIDECAR_LLM_DEFAULTS, SIDECAR_SITES,
  SIDECAR_SITE_DEFAULT_PROFILE, SIDECAR_BACKEND_WIRE_VALUES, clampSidecarTimeout,
  clampSidecarMaxInputChars,
  SIDECAR_SITES_WITH_CWD,
  addCustomDesignation as addCustomDesignationToken,
  removeCustomDesignation as removeCustomDesignationToken,
  designationCatalogue,
  parseDesignationToken,
  isKnownDesignation,
  sanitiseRoleMatchKeywords,
  parseTagCatalogue,
  TAG_CATALOGUE_DEFAULTS,
  sanitiseGlobalTasksSettings,
  TIMER_MAX_DELAY_MS, AGENT_DEFER_MAX_MS,
} from '@tierwyn/shared';
import { COMPACTION_DEFAULTS, GENERAL_DEFAULTS, VOICE_DEFAULTS, DEFAULT_VOICE_CLEANUP_PROMPT } from '../db/seed.js';
import { AGENT_BINARIES } from '../discovery.js';
import { catalogue } from '../catalogue.js';
import { registry } from '../registry.js';
import { setSpawnTokenTtlMs } from '../spawn/tokens.js';
import { setScheduleRunTokenTtlMs } from '../schedules/runTokens.js';
import { setSpawnStallTimeoutMs } from '../spawn/watch.js';

const ALL_VOICE_PROVIDERS: VoiceCleanupProvider[] = ['lmstudio', 'ollama', 'openai', 'gemini'];

/** Structural subset shared by VoiceCleanupSettings and EnhanceSettings. */
type ProviderSyncable = {
  provider: VoiceCleanupProvider;
  providerValues: Record<VoiceCleanupProvider, VoiceCleanupProviderValues>;
  baseUrl: string;
  model: string;
  apiKey: string;
};

/** Backfill providerValues from legacy top-level fields (same logic as migration 020). */
function ensureProviderValues<T extends ProviderSyncable>(
  block: T,
  rawHadProviderValues: boolean,
): T {
  if (rawHadProviderValues && block.providerValues) return block;
  const provider = block.provider ?? 'lmstudio';
  const defaults = defaultVoiceProviderValues();
  const providerValues = { ...defaults };
  providerValues[provider] = {
    baseUrl: block.baseUrl ?? VOICE_PROVIDER_PRESETS[provider].baseUrl,
    model: block.model ?? VOICE_PROVIDER_PRESETS[provider].model,
    apiKey: block.apiKey ?? '',
  };
  return { ...block, providerValues };
}

/** Mirror top-level baseUrl/model/apiKey from the active provider entry. */
function mirrorActiveProvider<T extends ProviderSyncable>(block: T): T {
  const active = voiceProviderValuesFor(
    { providerValues: block.providerValues } as VoiceCleanupSettings,
    block.provider,
  );
  return { ...block, baseUrl: active.baseUrl, model: active.model, apiKey: active.apiKey };
}

/** Keep providerValues[provider] in sync when connection fields are patched. */
function syncProviderValuesPatch<T extends ProviderSyncable>(
  block: T,
  patch: Partial<ProviderSyncable>,
): T {
  let next = ensureProviderValues(block, block.providerValues !== undefined);
  const provider = next.provider;
  const connectionPatch: Partial<VoiceCleanupProviderValues> = {};
  if (patch.baseUrl !== undefined) connectionPatch.baseUrl = patch.baseUrl;
  if (patch.model !== undefined) connectionPatch.model = patch.model;
  if (patch.apiKey !== undefined) connectionPatch.apiKey = patch.apiKey;

  if (Object.keys(connectionPatch).length > 0) {
    next = {
      ...next,
      providerValues: {
        ...next.providerValues,
        [provider]: { ...next.providerValues[provider], ...connectionPatch },
      },
    };
  }

  if (patch.providerValues) {
    next = {
      ...next,
      providerValues: { ...next.providerValues, ...patch.providerValues },
    };
    for (const p of ALL_VOICE_PROVIDERS) {
      if (patch.providerValues[p]) {
        next.providerValues[p] = { ...next.providerValues[p], ...patch.providerValues[p]! };
      }
    }
  }

  return mirrorActiveProvider(next);
}

function clampInt(n: unknown, min: number, max: number, fallback: number): number {
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** Coerce spawn/schedule/stall timeout fields: clamped to valid minute ranges. */
function normaliseTimeouts(s: CompactionSettings): CompactionSettings {
  return {
    ...s,
    spawnTokenIdleTtlMinutes: clampInt(s.spawnTokenIdleTtlMinutes, 5, 1440, 30),
    scheduleRunTokenIdleTtlMinutes: clampInt(s.scheduleRunTokenIdleTtlMinutes, 5, 1440, 30),
    spawnStallTimeoutMinutes: clampInt(s.spawnStallTimeoutMinutes, 1, 240, 15),
  };
}

/** Coerce mesh fields: unknown/reserved enum values become 'off'; hops clamped 1–3. */
function normaliseMesh(s: CompactionSettings): CompactionSettings {
  return normaliseTimeouts(normaliseUsageAutoResume({
    ...s,
    meshAwareness: s.meshAwareness === 'subtree' ? 'subtree' : 'off',
    meshMessaging: s.meshMessaging === 'tree' ? 'tree' : 'off',
    meshMaxPeersPerConversation: clampInt(s.meshMaxPeersPerConversation, 1, 64, 4),
    meshMessagesPerMinute: clampInt(s.meshMessagesPerMinute, 1, 600, 6),
    meshMessagesPerMinuteGlobal: clampInt(s.meshMessagesPerMinuteGlobal, 1, 6000, 20),
    // 1 = no forwarding. 2 (default) = one relay, which is what a coordinator
    // needs. 3 is the ceiling: past that a ring's latency and token cost stop
    // being debuggable. Cycles terminate at the cap regardless of ring length.
    meshMaxHops: clampInt(s.meshMaxHops, 1, 3, 2),
    // Default true: anything but an explicit false (missing field, old settings
    // row) coerces to on. Auto-mint is the intended default; off is the escape hatch.
    meshAutoEdges: s.meshAutoEdges === false ? false : true,
  }));
}

/** Coerce usageAutoResume fields: junk enum values fall back to 'delegates';
 *  deferral clamped 0..TIMER_MAX_DELAY_MS (0 disables); attempts clamped 1–10. */
function normaliseUsageAutoResume(s: CompactionSettings): CompactionSettings {
  return {
    ...s,
    usageAutoResume:
      s.usageAutoResume === 'all' || s.usageAutoResume === 'off' ? s.usageAutoResume : 'delegates',
    usageAutoResumeMaxDeferMs: clampInt(s.usageAutoResumeMaxDeferMs, 0, TIMER_MAX_DELAY_MS, AGENT_DEFER_MAX_MS),
    usageAutoResumeMaxAttempts: clampInt(s.usageAutoResumeMaxAttempts, 1, 10, 3),
  };
}

export function applyTimeoutSettings(
  settings: Pick<CompactionSettings, 'spawnTokenIdleTtlMinutes' | 'scheduleRunTokenIdleTtlMinutes' | 'spawnStallTimeoutMinutes'>
): void {
  setSpawnTokenTtlMs(settings.spawnTokenIdleTtlMinutes * 60_000);
  setScheduleRunTokenTtlMs(settings.scheduleRunTokenIdleTtlMinutes * 60_000);
  setSpawnStallTimeoutMs(settings.spawnStallTimeoutMinutes * 60_000);
}

export function getCompactionSettings(db: Database): CompactionSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'compaction'").get() as { value: string } | undefined;
  if (!row) throw new Error('compaction settings missing — seedDefaultSettings not run');
  // Merge with defaults so legacy rows (seeded before new keys were added)
  // gain the new fields with safe values without requiring a SQL migration.
  const parsed = JSON.parse(row.value) as Partial<CompactionSettings> & { sandbox?: unknown };
  delete parsed.sandbox;
  return normaliseMesh({ ...COMPACTION_DEFAULTS, ...parsed });
}

export function updateCompactionSettings(
  db: Database, patch: Partial<CompactionSettings>
): CompactionSettings {
  const current = getCompactionSettings(db);
  const next = normaliseMesh({ ...current, ...patch });
  delete (next as unknown as { sandbox?: unknown }).sandbox;
  db.prepare("UPDATE settings SET value = ? WHERE key = 'compaction'").run(JSON.stringify(next));
  applyTimeoutSettings(next);
  return next;
}

export function getGeneralSettings(db: Database): GeneralSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'general'").get() as { value: string } | undefined;
  if (!row) return { ...GENERAL_DEFAULTS };
  const merged: GeneralSettings = { ...GENERAL_DEFAULTS, ...(JSON.parse(row.value) as Partial<GeneralSettings>) };
  // ponytail: legacy key stripped on read; no migration needed.
  delete (merged as unknown as Record<string, unknown>).pipelineDefaults;
  return merged;
}

export function updateGeneralSettings(db: Database, patch: Partial<GeneralSettings>): GeneralSettings {
  const next: GeneralSettings = { ...getGeneralSettings(db), ...patch };
  if (patch.conversationRetentionDays !== undefined) {
    const d = Number(patch.conversationRetentionDays);
    if (!Number.isInteger(d) || d < 0 || d > 3650) {
      throw new Error('conversationRetentionDays must be an integer 0–3650 (0 = keep forever)');
    }
    next.conversationRetentionDays = d;
  }
  if (patch.toolResultTrimDays !== undefined) {
    const d = Number(patch.toolResultTrimDays);
    if (!Number.isInteger(d) || d < 0 || d > 3650) {
      throw new Error('toolResultTrimDays must be an integer 0–3650 (0 = never trim)');
    }
    next.toolResultTrimDays = d;
  }
  if (patch.grokBotTranscriptEventLimit !== undefined) {
    const n = Number(patch.grokBotTranscriptEventLimit);
    if (!Number.isInteger(n) || n < 0 || (n > 0 && n < 100) || n > 100_000) {
      throw new Error('grokBotTranscriptEventLimit must be 0 (unlimited) or an integer 100–100000');
    }
    next.grokBotTranscriptEventLimit = n;
  }
  if (patch.grokBotBackfillEntries !== undefined) {
    const n = Number(patch.grokBotBackfillEntries);
    if (!Number.isInteger(n) || n < 0 || n > 2000) {
      throw new Error('grokBotBackfillEntries must be an integer 0–2000 (0 = start from now)');
    }
    next.grokBotBackfillEntries = n;
  }
  if (patch.markupHint !== undefined && !['off', 'all', 'chat'].includes(patch.markupHint)) {
    throw new Error('markupHint must be off | all | chat');
  }
  if (patch.agentSearchScope !== undefined && !['off', 'project', 'all'].includes(patch.agentSearchScope)) {
    throw new Error('agentSearchScope must be off | project | all');
  }
  if (patch.grokBotAutoStart !== undefined) {
    const v = patch.grokBotAutoStart;
    if (v !== 'off' && v !== 'on-demand' && v !== 'keep-running') {
      throw new Error('grokBotAutoStart must be off | on-demand | keep-running');
    }
    next.grokBotAutoStart = v;
  }
  for (const key of [
    'hidePresetPrompts', 'hideShippedSchedulePacks', 'grokBotAutoCreateRemoteAgents',
    'grokBotDeleteBotOnConversationDelete', 'grokBotInProjectChats', 'memories',
    'allowAgentAutoScheduling', 'allowAgentRecurringSchedules', 'autoArchiveCompletedOneShots',
  ] as const) {
    if (patch[key] !== undefined && typeof patch[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean`);
    }
  }
  if (patch.roleMatchKeywords !== undefined) {
    const r = sanitiseRoleMatchKeywords(patch.roleMatchKeywords);
    if (!r.ok) throw new Error(r.error);
    next.roleMatchKeywords = r.value;
  }
  // ponytail: legacy key stripped on write; no migration needed.
  delete (next as unknown as Record<string, unknown>).pipelineDefaults;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('general', ?)").run(JSON.stringify(next));
  return next;
}

export function getNotificationSettings(db: Database): NotificationSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'notifications'").get() as { value: string } | undefined;
  if (!row) return { ...NOTIFICATION_DEFAULTS };
  return { ...NOTIFICATION_DEFAULTS, ...(JSON.parse(row.value) as Partial<NotificationSettings>) };
}

export function updateNotificationSettings(
  db: Database,
  patch: Partial<NotificationSettings>,
): NotificationSettings {
  const next: NotificationSettings = { ...getNotificationSettings(db), ...patch };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('notifications', ?)").run(JSON.stringify(next));
  return next;
}

export function publicNotificationSettings(s: NotificationSettings): PublicNotificationSettings {
  const { vapidPrivateKey: _omit, ...pub } = s;
  return pub;
}

export function getGlobalTasksSettings(db: Database): GlobalTasksSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'global_tasks'").get() as { value: string } | undefined;
  if (!row) return sanitiseGlobalTasksSettings(null);
  try {
    return sanitiseGlobalTasksSettings(JSON.parse(row.value));
  } catch {
    return sanitiseGlobalTasksSettings(null);
  }
}

export function updateGlobalTasksSettings(db: Database, patch: unknown): GlobalTasksSettings {
  const current = getGlobalTasksSettings(db);
  const merged = (patch && typeof patch === 'object' && !Array.isArray(patch))
    ? { ...current, ...(patch as Record<string, unknown>) }
    : current;
  const next = sanitiseGlobalTasksSettings(merged);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('global_tasks', ?)").run(JSON.stringify(next));
  return next;
}

export function getDecisionSettings(db: Database): DecisionSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'decision'").get() as { value: string } | undefined;
  if (!row) return { ...DECISION_DEFAULTS };
  try {
    return { ...DECISION_DEFAULTS, ...(JSON.parse(row.value) as Partial<DecisionSettings>) };
  } catch {
    return { ...DECISION_DEFAULTS };
  }
}

export function updateDecisionSettings(db: Database, patch: Partial<DecisionSettings>): DecisionSettings {
  const next: DecisionSettings = { ...getDecisionSettings(db), ...patch };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('decision', ?)").run(JSON.stringify(next));
  return next;
}

export function publicDecisionSettings(s: DecisionSettings): PublicDecisionSettings {
  const { apiKey, ...pub } = s;
  return { ...pub, apiKeySet: apiKey.length > 0 };
}

const TAG_CATALOGUE_KEY = 'conversation_tag_catalogue';

/**
 * Jev auto-tag catalogue. A missing or corrupt row fails closed to built-ins only. A row that
 * only references since-evolved built-ins is read leniently so the operator's customs survive.
 */
export function getTagCatalogueSettings(db: Database): TagCatalogueSettings {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(TAG_CATALOGUE_KEY) as { value: string } | undefined;
  if (!row) return { ...TAG_CATALOGUE_DEFAULTS };
  try {
    const parsed = parseTagCatalogue(JSON.parse(row.value), { lenient: true });
    return parsed.ok ? parsed.catalogue : { ...TAG_CATALOGUE_DEFAULTS };
  } catch {
    return { ...TAG_CATALOGUE_DEFAULTS };
  }
}

/** Validates the whole document, then replaces the row. Nothing is written on failure. */
export function setTagCatalogueSettings(db: Database, raw: unknown): TagCatalogueParseResult {
  const parsed = parseTagCatalogue(raw);
  if (parsed.ok) {
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(TAG_CATALOGUE_KEY, JSON.stringify(parsed.catalogue));
  }
  return parsed;
}

export function getVoiceSettings(db: Database): VoiceSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'voice'").get() as { value: string } | undefined;
  if (!row) return { ...VOICE_DEFAULTS };
  const parsed = JSON.parse(row.value) as Partial<VoiceSettings>;
  const rawCleanup = (parsed.cleanup ?? {}) as Partial<VoiceCleanupSettings>;
  const cleanup: VoiceCleanupSettings = { ...VOICE_DEFAULTS.cleanup, ...rawCleanup };

  // Legacy migration: rows written before the prompt library have no
  // selectedPromptId. If they carried a non-default custom systemPrompt, keep
  // it as an 'imported-legacy' custom prompt and select it — no words lost.
  // ponytail: read-only derivation with a stable id; persisted only when the
  // user next saves. Idempotent because a real save adds selectedPromptId.
  if (rawCleanup.selectedPromptId === undefined) {
    const legacy = rawCleanup.systemPrompt;
    if (legacy && legacy !== DEFAULT_VOICE_CLEANUP_PROMPT) {
      cleanup.prompts = [{ id: 'imported-legacy', name: 'Imported (legacy)', text: legacy }];
      cleanup.selectedPromptId = 'imported-legacy';
    } else {
      cleanup.selectedPromptId = 'builtin-1';
    }
  }
  const rawTts = (parsed.tts ?? {}) as Partial<VoiceTtsSettings>;
  const tts: VoiceTtsSettings = { ...VOICE_DEFAULTS.tts, ...rawTts };
  // ponytail: rows written before TTS prompt library — fill defaults on read.
  if (rawTts.selectedPromptId === undefined) tts.selectedPromptId = 'tts-builtin-1';
  if (rawTts.prompts === undefined) tts.prompts = [];
  // ponytail: pre-recordings rows omit saveRecordings — default true via VOICE_DEFAULTS merge,
  // but re-assert when the field was explicitly missing (spread already handled).
  if (rawTts.saveRecordings === undefined) tts.saveRecordings = true;
  return {
    cleanup: mirrorActiveProvider(ensureProviderValues(cleanup, rawCleanup.providerValues !== undefined)),
    tts,
  };
}

/** Patch shape for voice settings — deep partials so callers can update a
 *  single field without resending the whole block. */
export type VoiceSettingsPatch = {
  cleanup?: Partial<VoiceCleanupSettings>;
  tts?: Partial<VoiceTtsSettings>;
};

export function updateVoiceSettings(db: Database, patch: VoiceSettingsPatch): VoiceSettings {
  const current = getVoiceSettings(db);
  const p = patch.cleanup ?? {};
  const cleanup = syncProviderValuesPatch({ ...current.cleanup, ...p }, p);
  const tts = { ...current.tts, ...(patch.tts ?? {}) };
  const next: VoiceSettings = { cleanup, tts };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('voice', ?)").run(JSON.stringify(next));
  return next;
}

export function getEnhanceSettings(db: Database): EnhanceSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'enhance'").get() as { value: string } | undefined;
  if (!row) return { ...ENHANCE_DEFAULTS, providerValues: defaultVoiceProviderValues() };
  const parsed = JSON.parse(row.value) as Partial<EnhanceSettings>;
  const raw: EnhanceSettings = {
    ...ENHANCE_DEFAULTS,
    ...parsed,
    providerValues: parsed.providerValues
      ? { ...defaultVoiceProviderValues(), ...parsed.providerValues }
      : defaultVoiceProviderValues(),
  };
  // ponytail: fill missing prompt-library fields on read (no seed row).
  if (raw.quickPrompts === undefined) raw.quickPrompts = [];
  if (raw.contextPrompts === undefined) raw.contextPrompts = [];
  if (!raw.quickSelectedPromptId) raw.quickSelectedPromptId = ENHANCE_DEFAULTS.quickSelectedPromptId;
  if (!raw.contextSelectedPromptId) raw.contextSelectedPromptId = ENHANCE_DEFAULTS.contextSelectedPromptId;
  if (typeof raw.describeEnabled !== 'boolean') raw.describeEnabled = true;
  return mirrorActiveProvider(ensureProviderValues(raw, parsed.providerValues !== undefined));
}

export function updateEnhanceSettings(db: Database, patch: Partial<EnhanceSettings>): EnhanceSettings {
  const current = getEnhanceSettings(db);
  const next = syncProviderValuesPatch({ ...current, ...patch }, patch);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('enhance', ?)").run(JSON.stringify(next));
  return next;
}

function emptyRoute(site: SidecarSite): SidecarSiteRoute {
  return { ...SIDECAR_LLM_DEFAULTS[site] };
}

/** Map on-disk / wire backend spellings to the canonical SidecarBackend. */
function normaliseBackend(raw: unknown): SidecarBackend {
  if (raw === 'agent' || raw === 'agent_oneshot') return 'agent_oneshot';  // legacy alias
  if (raw === 'agent_readonly') return 'agent_readonly';
  return 'direct';                                                          // incl. 'gemini', junk
}

/** Cap on a single stored prompt body. Matches the spirit of PROMPT_BODY_MAX
 *  without coupling the sidecar library to the slash-command prompt table. */
const SIDECAR_PROMPT_TEXT_MAX = 10_000;
const SIDECAR_PROMPTS_MAX = 50;   // ponytail: bounds a settings row an operator could otherwise grow unbounded

function sanitisePromptList(raw: unknown): SidecarPrompt[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SidecarPrompt[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const { id, name, text } = item as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim()) continue;
    if (typeof name !== 'string' || typeof text !== 'string') continue;
    out.push({ id: id.trim(), name: name.slice(0, 200), text: text.slice(0, SIDECAR_PROMPT_TEXT_MAX) });
    if (out.length >= SIDECAR_PROMPTS_MAX) break;
  }
  return out;
}

function sanitisePromptId(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

/** Warn-once-per-process set for retired/unknown sidecar route adapters. */
const warnedRetiredAdapters = new Set<string>();

function sanitiseStoredRoute(site: SidecarSite, raw: unknown, fallback: SidecarSiteRoute): SidecarSiteRoute {
  if (!raw || typeof raw !== 'object') return { ...fallback };
  const src = raw as Partial<SidecarSiteRoute> & { backend?: string };
  // ponytail: 'gemini'→'direct', 'agent'→'agent_oneshot'. No migration; rewritten on next save.
  let backend = normaliseBackend(src.backend);
  if (backend === 'agent_readonly' && !SIDECAR_SITES_WITH_CWD.includes(site)) {
    backend = 'agent_oneshot';
  }
  const route: SidecarSiteRoute = { backend };
  if (typeof src.profile === 'string' && src.profile.trim()) route.profile = src.profile.trim();
  if (typeof src.adapter === 'string' && src.adapter.trim()) route.adapter = src.adapter.trim();
  if (typeof src.model === 'string' && src.model.trim()) route.model = src.model.trim();
  if (typeof src.enabled === 'boolean') route.enabled = src.enabled;
  const t = clampSidecarTimeout(src.timeoutSecs);
  if (t !== undefined) route.timeoutSecs = t;
  const mic = clampSidecarMaxInputChars(src.maxInputChars);
  if (mic !== undefined) route.maxInputChars = mic;
  const prompts = sanitisePromptList(src.prompts);
  if (prompts) route.prompts = prompts;
  const sel = sanitisePromptId(src.selectedPromptId);
  if (sel) route.selectedPromptId = sel;
  if (site === 'enhance') {
    const cp = sanitisePromptList((src as { contextPrompts?: unknown }).contextPrompts);
    if (cp) route.contextPrompts = cp;
    const csel = sanitisePromptId((src as { contextSelectedPromptId?: unknown }).contextSelectedPromptId);
    if (csel) route.contextSelectedPromptId = csel;
    const s2 = src as { projectAdapter?: unknown; projectModel?: unknown; projectPrompts?: unknown; projectSelectedPromptId?: unknown };
    if (typeof s2.projectAdapter === 'string' && s2.projectAdapter.trim()) route.projectAdapter = s2.projectAdapter.trim();
    if (typeof s2.projectModel === 'string' && s2.projectModel.trim()) route.projectModel = s2.projectModel.trim();
    const pp = sanitisePromptList(s2.projectPrompts);
    if (pp) route.projectPrompts = pp;
    const psel = sanitisePromptId(s2.projectSelectedPromptId);
    if (psel) route.projectSelectedPromptId = psel;
  }
  if (site === 'tts') {
    const cp = sanitisePromptList((src as { codePrompts?: unknown }).codePrompts);
    if (cp) route.codePrompts = cp;
    const csel = sanitisePromptId((src as { codeSelectedPromptId?: unknown }).codeSelectedPromptId);
    if (csel) route.codeSelectedPromptId = csel;
    const dp = sanitisePromptList((src as { diffPrompts?: unknown }).diffPrompts);
    if (dp) route.diffPrompts = dp;
    const dsel = sanitisePromptId((src as { diffSelectedPromptId?: unknown }).diffSelectedPromptId);
    if (dsel) route.diffSelectedPromptId = dsel;
  }
  if (
    isSidecarAgentBackend(route.backend)
    && route.adapter
    && !Object.prototype.hasOwnProperty.call(AGENT_BINARIES, route.adapter)
  ) {
    const key = `${site}:${route.adapter}`;
    if (!warnedRetiredAdapters.has(key)) {
      warnedRetiredAdapters.add(key);
      console.warn(
        `[sidecarLlm] site=${site} names retired/unknown adapter '${route.adapter}'`
        + `${route.model ? ` (${route.model})` : ''}; falling back to direct`,
      );
    }
    return { ...fallback };
  }
  return route;
}

function derivedEnabled(db: Database, site: SidecarSite, stored: boolean | undefined): boolean {
  if (site === 'transcribe') return getVoiceSettings(db).cleanup.enabled;
  if (site === 'describe') return getEnhanceSettings(db).describeEnabled !== false;
  return stored !== false;   // enhance / tts: unset ⇒ on
}

/** Drop derived `enabled` from transcribe/describe so those flags stay single-source. */
function stripDerivedEnabled(settings: SidecarLlmSettings): SidecarLlmSettings {
  const drop = (route: SidecarSiteRoute): SidecarSiteRoute => {
    const { enabled: _drop, ...rest } = route;
    return rest;
  };
  return {
    ...settings,
    transcribe: drop(settings.transcribe),
    describe: drop(settings.describe),
  };
}

function stampDerivedEnabled(db: Database, settings: SidecarLlmSettings): SidecarLlmSettings {
  const out: SidecarLlmSettings = { ...settings };
  for (const site of SIDECAR_SITES) {
    out[site] = { ...out[site], enabled: derivedEnabled(db, site, out[site].enabled) };
  }
  return out;
}

/** Spec §5.2 — transparent read fallback to the pre-consolidation prompt homes.
 *  ponytail: read-time only. Saving a site copies that site's promoted prompts into
 *  the sidecarLlm row (legacy blob untouched) and that site stops consulting the
 *  blob. A PATCH of one site does not persist other sites' promoted prompts.
 *  An explicit empty `prompts: []` is stored and stops further promotion. */
function withLegacyPrompts(db: Database, s: SidecarLlmSettings): SidecarLlmSettings {
  const voice = getVoiceSettings(db);
  const enh = getEnhanceSettings(db);
  const merge = (
    route: SidecarSiteRoute,
    prompts: SidecarPrompt[] | undefined,
    selected: string | undefined,
  ): SidecarSiteRoute => {
    if (route.prompts !== undefined) return route;
    const legacy = sanitisePromptList(prompts);
    if (!legacy?.length) return route;
    return {
      ...route,
      prompts: legacy,
      ...(route.selectedPromptId ? {} : { selectedPromptId: sanitisePromptId(selected) }),
    };
  };
  const enhanceRoute = merge(s.enhance, enh.quickPrompts, enh.quickSelectedPromptId);
  let transcribe = merge(s.transcribe, voice.cleanup.prompts, voice.cleanup.selectedPromptId);
  if (transcribe.prompts === undefined) {
    const text = voice.cleanup.systemPrompt?.trim();
    if (!voice.cleanup.prompts?.length && text && text !== DEFAULT_VOICE_CLEANUP_PROMPT) {
      transcribe = {
        ...transcribe,
        prompts: [{ id: 'legacy-systemPrompt', name: 'Legacy cleanup prompt', text: voice.cleanup.systemPrompt! }],
        selectedPromptId: 'legacy-systemPrompt',
      };
    }
  }
  return {
    ...s,
    transcribe,
    tts: merge(s.tts, voice.tts.prompts, voice.tts.selectedPromptId),
    enhance: enhanceRoute.contextPrompts !== undefined
      ? enhanceRoute
      : {
        ...enhanceRoute,
        ...(sanitisePromptList(enh.contextPrompts)?.length
          ? {
            contextPrompts: sanitisePromptList(enh.contextPrompts),
            ...(enhanceRoute.contextSelectedPromptId
              ? {}
              : { contextSelectedPromptId: sanitisePromptId(enh.contextSelectedPromptId) }),
          }
          : {}),
      },
  };
}

/** D4: when sidecarLlm has no btw key, derive a route from the legacy `btw` settings row. */
function legacyBtwRoute(db: Database): SidecarSiteRoute {
  const fallback: SidecarSiteRoute = { ...SIDECAR_LLM_DEFAULTS.btw };
  const row = db.prepare("SELECT value FROM settings WHERE key = 'btw'").get() as { value: string } | undefined;
  if (!row) return fallback;
  let parsed: Record<string, unknown> = {};
  try { parsed = JSON.parse(row.value) as Record<string, unknown>; }
  catch { return fallback; }

  let route: SidecarSiteRoute = { ...fallback };
  const profileId = typeof parsed.btwProfileId === 'string' ? parsed.btwProfileId : '';
  if (profileId) {
    const profile = catalogue.getProfile(profileId);
    const type = profile?.agentType;
    if (profile && type) {
      try {
        if (registry.has(type) && registry.create(type).oneShotModes?.includes('read_only')) {
          route = { backend: 'agent_readonly', adapter: type, model: profile.model };
        }
      } catch { /* keep fallback */ }
    }
  }
  const timeout = clampSidecarTimeout(parsed.timeoutSeconds);
  if (timeout !== undefined && timeout !== 240) {
    route = { ...route, timeoutSecs: timeout };
  }
  return route;
}

function parseStoredSidecarLlm(db: Database): SidecarLlmSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'sidecarLlm'").get() as { value: string } | undefined;
  if (!row) {
    return {
      transcribe: emptyRoute('transcribe'),
      enhance: emptyRoute('enhance'),
      tts: emptyRoute('tts'),
      describe: emptyRoute('describe'),
      commit: emptyRoute('commit'),
      btw: legacyBtwRoute(db),
    };
  }
  let parsed: Partial<SidecarLlmSettings> = {};
  try { parsed = JSON.parse(row.value) as Partial<SidecarLlmSettings>; }
  catch { parsed = {}; }
  return {
    transcribe: sanitiseStoredRoute('transcribe', parsed.transcribe, SIDECAR_LLM_DEFAULTS.transcribe),
    enhance: sanitiseStoredRoute('enhance', parsed.enhance, SIDECAR_LLM_DEFAULTS.enhance),
    tts: sanitiseStoredRoute('tts', parsed.tts, SIDECAR_LLM_DEFAULTS.tts),
    describe: sanitiseStoredRoute('describe', parsed.describe, SIDECAR_LLM_DEFAULTS.describe),
    commit: sanitiseStoredRoute('commit', parsed.commit, SIDECAR_LLM_DEFAULTS.commit),
    btw: parsed.btw
      ? sanitiseStoredRoute('btw', parsed.btw, SIDECAR_LLM_DEFAULTS.btw)
      : legacyBtwRoute(db),
  };
}

export function getSidecarLlmSettings(db: Database): SidecarLlmSettings {
  return stampDerivedEnabled(db, withLegacyPrompts(db, parseStoredSidecarLlm(db)));
}

export function updateSidecarLlmSettings(
  db: Database,
  patch: Partial<SidecarLlmSettings>,
  capableAdapters: readonly { type: string; supportsToolsOff: boolean; supportsReadOnly: boolean }[],
): SidecarLlmSettings {
  for (const key of Object.keys(patch)) {
    if (!(SIDECAR_SITES as readonly string[]).includes(key)) {
      throw new Error(`unknown sidecar site: ${key}`);
    }
  }
  const stored = parseStoredSidecarLlm(db);
  const current = getSidecarLlmSettings(db);
  const next: SidecarLlmSettings = {
    transcribe: { ...stored.transcribe },
    enhance: { ...stored.enhance },
    tts: { ...stored.tts },
    describe: { ...stored.describe },
    commit: { ...stored.commit },
    btw: { ...stored.btw },
  };
  const legacyWrites: Array<() => void> = [];
  for (const site of SIDECAR_SITES) {
    const raw = patch[site];
    if (!raw) continue;
    const incoming = raw as Partial<SidecarSiteRoute> & {
      backend?: string;
      timeoutSecs?: number | null;
      maxInputChars?: number | null;
      prompts?: unknown;
      selectedPromptId?: unknown;
      contextPrompts?: unknown;
      contextSelectedPromptId?: unknown;
      projectAdapter?: unknown;
      projectModel?: unknown;
      projectPrompts?: unknown;
      projectSelectedPromptId?: unknown;
      codePrompts?: unknown;
      codeSelectedPromptId?: unknown;
      diffPrompts?: unknown;
      diffSelectedPromptId?: unknown;
    };
    // Reject genuinely unknown strings; only widen the accepted set. Silent
    // coercion of typos to `direct` would be a footgun.
    if (incoming.backend === undefined
        || !SIDECAR_BACKEND_WIRE_VALUES.includes(incoming.backend as never)) {
      throw new Error(`invalid sidecar backend: ${String(incoming.backend)}`);
    }
    const backend = normaliseBackend(incoming.backend);
    // Retain-on-omit is for `direct` toggles (spec §3.2). Agent patches take
    // adapter/model from the payload only — JSON.stringify drops `undefined`,
    // so an adapter pick arrives with no model key and must clear it.
    const pickRetain = (key: 'adapter' | 'model' | 'profile'): string | undefined => {
      if (key in incoming) {
        const v = incoming[key];
        return typeof v === 'string' && v.trim() ? v.trim() : undefined;
      }
      const cur = current[site][key];
      return typeof cur === 'string' && cur.trim() ? cur.trim() : undefined;
    };
    const pickFromPayload = (key: 'adapter' | 'model'): string | undefined => {
      if (!(key in incoming)) return undefined;
      const v = incoming[key];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    const adapter = isSidecarAgentBackend(backend) ? pickFromPayload('adapter') : pickRetain('adapter');
    const model = isSidecarAgentBackend(backend) ? pickFromPayload('model') : pickRetain('model');
    const profile = pickRetain('profile');
    if (backend === 'agent_readonly' && !SIDECAR_SITES_WITH_CWD.includes(site)) {
      throw new Error(`sidecar site ${site} does not support read-only mode`);
    }
    if (isSidecarAgentBackend(backend) && adapter) {
      const cap = capableAdapters.find((a) => a.type === adapter);
      if (!cap) throw new Error(`adapter ${adapter} does not support one-shot`);
      if (backend === 'agent_readonly' && !cap.supportsReadOnly) {
        throw new Error(`adapter ${adapter} does not support read-only one-shot`);
      }
    }
    const route: SidecarSiteRoute = { backend };
    if (adapter) route.adapter = adapter;
    if (model) route.model = model;
    if (profile) route.profile = profile;
    const enabled = typeof incoming.enabled === 'boolean' ? incoming.enabled : undefined;
    if (enabled !== undefined) {
      // ponytail: a client PATCHing { transcribe: { backend, enabled: true } } turns
      // on voice cleanup globally — that is the intent (D4). Do not store a second copy.
      // M2: buffer legacy writes and flush only after the whole validation loop succeeds.
      if (site === 'transcribe') legacyWrites.push(() => updateVoiceSettings(db, { cleanup: { enabled } }));
      else if (site === 'describe') legacyWrites.push(() => updateEnhanceSettings(db, { describeEnabled: enabled }));
      else route.enabled = enabled;
    } else if (site !== 'transcribe' && site !== 'describe') {
      // retain-on-omit, same rule as adapter/model for `direct`
      if (typeof current[site].enabled === 'boolean') route.enabled = current[site].enabled;
    }
    // retain-on-omit like `profile`; explicit null clears the override
    const timeoutSecs = 'timeoutSecs' in incoming
      ? (incoming.timeoutSecs === null ? undefined : clampSidecarTimeout(incoming.timeoutSecs))
      : current[site].timeoutSecs;
    if (timeoutSecs !== undefined) route.timeoutSecs = timeoutSecs;

    const maxInputChars = 'maxInputChars' in incoming
      ? (incoming.maxInputChars === null ? undefined : clampSidecarMaxInputChars(incoming.maxInputChars))
      : current[site].maxInputChars;
    if (maxInputChars !== undefined) route.maxInputChars = maxInputChars;

    if ('prompts' in incoming && incoming.prompts !== undefined && !Array.isArray(incoming.prompts)) {
      throw new Error('prompts must be an array');
    }
    const prompts = 'prompts' in incoming ? sanitisePromptList(incoming.prompts) : current[site].prompts;
    if (prompts !== undefined) route.prompts = prompts;
    const selectedPromptId = 'selectedPromptId' in incoming
      ? sanitisePromptId(incoming.selectedPromptId)
      : current[site].selectedPromptId;
    if (selectedPromptId) route.selectedPromptId = selectedPromptId;

    if (site === 'enhance') {
      if ('contextPrompts' in incoming && incoming.contextPrompts !== undefined && !Array.isArray(incoming.contextPrompts)) {
        throw new Error('contextPrompts must be an array');
      }
      const contextPrompts = 'contextPrompts' in incoming
        ? sanitisePromptList(incoming.contextPrompts)
        : current[site].contextPrompts;
      if (contextPrompts !== undefined) route.contextPrompts = contextPrompts;
      const contextSelectedPromptId = 'contextSelectedPromptId' in incoming
        ? sanitisePromptId(incoming.contextSelectedPromptId)
        : current[site].contextSelectedPromptId;
      if (contextSelectedPromptId) route.contextSelectedPromptId = contextSelectedPromptId;
      // Enhance-with-the-project. Retain on omit; '' clears (the web sends ''
      // rather than undefined because JSON.stringify drops undefined keys).
      const pickProject = (key: 'projectAdapter' | 'projectModel'): string | undefined => {
        if (key in incoming) {
          const v = incoming[key];
          return typeof v === 'string' && v.trim() ? v.trim() : undefined;
        }
        return current.enhance[key];
      };
      const projectAdapter = pickProject('projectAdapter');
      if (projectAdapter && 'projectAdapter' in incoming) {
        const cap = capableAdapters.find((a) => a.type === projectAdapter);
        if (!cap?.supportsReadOnly) {
          throw new Error(`adapter ${projectAdapter} does not support read-only one-shot`);
        }
      }
      if (projectAdapter) route.projectAdapter = projectAdapter;
      const projectModel = pickProject('projectModel');
      if (projectModel) route.projectModel = projectModel;
      if ('projectPrompts' in incoming && incoming.projectPrompts !== undefined && !Array.isArray(incoming.projectPrompts)) {
        throw new Error('projectPrompts must be an array');
      }
      const projectPrompts = 'projectPrompts' in incoming
        ? sanitisePromptList(incoming.projectPrompts)
        : current.enhance.projectPrompts;
      if (projectPrompts !== undefined) route.projectPrompts = projectPrompts;
      const projectSelectedPromptId = 'projectSelectedPromptId' in incoming
        ? sanitisePromptId(incoming.projectSelectedPromptId)
        : current.enhance.projectSelectedPromptId;
      if (projectSelectedPromptId) route.projectSelectedPromptId = projectSelectedPromptId;
    }
    if (site === 'tts') {
      if ('codePrompts' in incoming && incoming.codePrompts !== undefined && !Array.isArray(incoming.codePrompts)) {
        throw new Error('codePrompts must be an array');
      }
      const codePrompts = 'codePrompts' in incoming
        ? sanitisePromptList(incoming.codePrompts)
        : current[site].codePrompts;
      if (codePrompts !== undefined) route.codePrompts = codePrompts;
      const codeSelectedPromptId = 'codeSelectedPromptId' in incoming
        ? sanitisePromptId(incoming.codeSelectedPromptId)
        : current[site].codeSelectedPromptId;
      if (codeSelectedPromptId) route.codeSelectedPromptId = codeSelectedPromptId;
      if ('diffPrompts' in incoming && incoming.diffPrompts !== undefined && !Array.isArray(incoming.diffPrompts)) {
        throw new Error('diffPrompts must be an array');
      }
      const diffPrompts = 'diffPrompts' in incoming
        ? sanitisePromptList(incoming.diffPrompts)
        : current[site].diffPrompts;
      if (diffPrompts !== undefined) route.diffPrompts = diffPrompts;
      const diffSelectedPromptId = 'diffSelectedPromptId' in incoming
        ? sanitisePromptId(incoming.diffSelectedPromptId)
        : current[site].diffSelectedPromptId;
      if (diffSelectedPromptId) route.diffSelectedPromptId = diffSelectedPromptId;
    }
    next[site] = route;
  }
  for (const write of legacyWrites) write();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)")
    .run(JSON.stringify(stripDerivedEnabled(next)));
  return getSidecarLlmSettings(db);
}

function toProfile(
  id: 'cleanup' | 'enhancer',
  blob: VoiceCleanupSettings | EnhanceSettings,
): DirectLlmProfile {
  const custom = typeof blob.profileLabel === 'string' ? blob.profileLabel.trim() : undefined;
  return {
    id,
    label: custom || DIRECT_LLM_DEFAULT_LABELS[id]!,
    provider: blob.provider,
    providerValues: blob.providerValues,
    baseUrl: blob.baseUrl,
    apiKey: blob.apiKey,
    model: blob.model,
    timeoutSecs: blob.timeoutSecs,
    configured: directConnectionConfigured(blob),
  };
}

const DIRECT_LLM_EXTRAS_KEY = 'direct_llm_profiles';
const DIRECT_LLM_TOMBSTONE_KEY = 'direct_llm_deleted_builtins';
const BUILTIN_PROFILE_IDS = new Set<string>(DIRECT_LLM_PROFILE_IDS);

/** Ids of built-ins the operator deleted. Missing/corrupt row ⇒ []. */
function readDeletedBuiltins(db: Database): Set<string> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(DIRECT_LLM_TOMBSTONE_KEY) as { value: string } | undefined;
  if (!row) return new Set();
  try {
    const v = JSON.parse(row.value) as unknown;
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeDeletedBuiltins(db: Database, ids: Set<string>): void {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)')
    .run(DIRECT_LLM_TOMBSTONE_KEY, JSON.stringify([...ids]));
}

function isPlausibleProfile(v: unknown): v is DirectLlmProfile {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<DirectLlmProfile>;
  return (
    typeof o.id === 'string' &&
    o.id.trim().length > 0 &&
    !BUILTIN_PROFILE_IDS.has(o.id) &&
    typeof o.label === 'string' &&
    typeof o.provider === 'string' &&
    typeof o.baseUrl === 'string' &&
    typeof o.timeoutSecs === 'number'
  );
}

/** Extra (non-built-in) profiles. Missing/corrupt row ⇒ []. */
function readExtraProfiles(db: Database): DirectLlmProfile[] {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DIRECT_LLM_EXTRAS_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    return Array.isArray(v) ? v.filter(isPlausibleProfile) : [];
  } catch {
    return [];
  }
}

function writeExtraProfiles(db: Database, rows: DirectLlmProfile[]): void {
  const persisted = rows.map(({ configured: _configured, ...rest }) => rest);
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(
    DIRECT_LLM_EXTRAS_KEY,
    JSON.stringify(persisted),
  );
}

function mintExtraId(taken: Set<string>): string {
  const base = `profile-${Date.now().toString(36)}`;
  let id = base;
  let n = 0;
  while (taken.has(id)) {
    n += 1;
    id = `${base}-${n}`;
  }
  return id;
}

function uniqueDefaultLabel(taken: string[]): string {
  const used = new Set(taken.map((s) => s.trim().toLowerCase()));
  const base = 'New connection';
  if (!used.has(base.toLowerCase())) return base;
  let n = 2;
  while (used.has(`${base} ${n}`.toLowerCase())) n += 1;
  return `${base} ${n}`;
}

export function listDirectLlmProfiles(db: Database): DirectLlmProfile[] {
  const dead = readDeletedBuiltins(db);
  const out: DirectLlmProfile[] = [];
  if (!dead.has('cleanup')) out.push(toProfile('cleanup', getVoiceSettings(db).cleanup));
  if (!dead.has('enhancer')) out.push(toProfile('enhancer', getEnhanceSettings(db)));
  out.push(...readExtraProfiles(db).map((p) => ({ ...p, configured: directConnectionConfigured(p) })));
  return out;
}

export function createDirectLlmProfile(
  db: Database,
  input?: Partial<Pick<DirectLlmProfile, 'label' | 'provider' | 'baseUrl' | 'apiKey' | 'model' | 'timeoutSecs'>>,
): { profiles: DirectLlmProfile[]; createdId: string } {
  const existing = listDirectLlmProfiles(db);
  const takenIds = new Set(existing.map((p) => p.id));
  const createdId = mintExtraId(takenIds);
  const provider = input?.provider ?? 'lmstudio';
  const label = input?.label?.trim() || uniqueDefaultLabel(existing.map((p) => p.label));
  let row: DirectLlmProfile = {
    id: createdId,
    label,
    provider,
    providerValues: defaultVoiceProviderValues(),
    baseUrl: '',
    apiKey: '',
    model: '',
    timeoutSecs: input?.timeoutSecs ?? 60,
    configured: false,
  };
  row = mirrorActiveProvider(row);
  const connectionPatch: Partial<ProviderSyncable> = {};
  if (input?.baseUrl !== undefined) connectionPatch.baseUrl = input.baseUrl;
  if (input?.model !== undefined) connectionPatch.model = input.model;
  if (input?.apiKey !== undefined) connectionPatch.apiKey = input.apiKey;
  if (Object.keys(connectionPatch).length > 0) {
    row = syncProviderValuesPatch(row, connectionPatch);
  }
  writeExtraProfiles(db, [...readExtraProfiles(db), row]);
  return { profiles: listDirectLlmProfiles(db), createdId };
}

/** Dispatch a connection patch to whichever blob backs this profile id. */
export function updateDirectLlmProfile(
  db: Database,
  id: DirectLlmProfileId,
  patch: Partial<Pick<DirectLlmProfile, 'label' | 'provider' | 'providerValues' | 'baseUrl' | 'apiKey' | 'model' | 'timeoutSecs'>>,
): DirectLlmProfile[] {
  const { label, ...rest } = patch;
  const timeoutClamped = rest.timeoutSecs !== undefined ? clampInt(rest.timeoutSecs, 1, 120, 60) : undefined;
  const blobPatch = {
    ...rest,
    ...(timeoutClamped !== undefined ? { timeoutSecs: timeoutClamped } : {}),
    ...(label !== undefined ? { profileLabel: label } : {}),
  };
  if (BUILTIN_PROFILE_IDS.has(id) && readDeletedBuiltins(db).has(id)) {
    throw new Error(`unknown direct llm profile: ${id}`);
  }
  if (id === 'cleanup') updateVoiceSettings(db, { cleanup: blobPatch });
  else if (id === 'enhancer') updateEnhanceSettings(db, blobPatch as Partial<EnhanceSettings>);
  else {
    const extras = readExtraProfiles(db);
    const idx = extras.findIndex((p) => p.id === id);
    if (idx < 0) throw new Error(`unknown direct llm profile: ${id}`);
    const found = extras[idx]!;
    const synced = syncProviderValuesPatch({ ...found, ...rest }, rest);
    const nextLabel = label !== undefined ? (label.trim() || found.label) : found.label;
    extras[idx] = {
      ...synced,
      id: found.id,
      label: nextLabel,
      timeoutSecs: rest.timeoutSecs !== undefined
        ? clampInt(rest.timeoutSecs, 1, 120, found.timeoutSecs)
        : found.timeoutSecs,
    };
    writeExtraProfiles(db, extras);
  }
  return listDirectLlmProfiles(db);
}

/** Re-aim every `direct` route at a profile that still exists. Unset ⇒ implicit
 *  site default, which may itself have been deleted. Zero profiles ⇒ clear the
 *  key so the site reads as "no profile". */
function repointSidecarRoutes(db: Database): void {
  const alive = listDirectLlmProfiles(db);
  const fallback = alive[0]?.id;
  const current = getSidecarLlmSettings(db);
  const next: SidecarLlmSettings = { ...current };
  let dirty = false;
  for (const site of SIDECAR_SITES) {
    const route = current[site];
    if (route.backend !== 'direct') continue;
    const resolved = route.profile ?? SIDECAR_SITE_DEFAULT_PROFILE[site];
    if (alive.some((p) => p.id === resolved)) continue;
    const { profile: _drop, ...rest } = route;
    next[site] = fallback ? { ...rest, profile: fallback } : rest;
    dirty = true;
  }
  if (!dirty) return;
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('sidecarLlm', ?)")
    .run(JSON.stringify(stripDerivedEnabled(next)));
}

export function deleteDirectLlmProfile(db: Database, id: DirectLlmProfileId): {
  profiles: DirectLlmProfile[];
  sidecar: SidecarLlmSettings;
} {
  const before = listDirectLlmProfiles(db);
  if (!before.some((p) => p.id === id)) {
    throw new Error(`unknown direct llm profile: ${id}`);
  }

  if (BUILTIN_PROFILE_IDS.has(id)) {
    // D1 + D2: tombstone the connection view, wipe credentials across all providers,
    // keep the prompt library and describe switch that share the blob.
    // M1: blank provider values across all providers so no API keys remain at rest.
    const blank = { baseUrl: '', model: '', apiKey: '' };
    const wipe = {
      baseUrl: '',
      apiKey: '',
      model: '',
      providerValues: { lmstudio: blank, ollama: blank, openai: blank, gemini: blank },
    };
    if (id === 'cleanup') updateVoiceSettings(db, { cleanup: wipe });
    else updateEnhanceSettings(db, wipe as Partial<EnhanceSettings>);
    const dead = readDeletedBuiltins(db);
    dead.add(id);
    writeDeletedBuiltins(db, dead);
  } else {
    writeExtraProfiles(db, readExtraProfiles(db).filter((p) => p.id !== id));
  }

  repointSidecarRoutes(db);
  return { profiles: listDirectLlmProfiles(db), sidecar: getSidecarLlmSettings(db) };
}

export function listTemplates(db: Database): SpawnTemplate[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'spawn_templates'").get() as { value: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.value) as SpawnTemplate[]; } catch { return []; }
}

export function getTemplate(db: Database, name: string): SpawnTemplate | undefined {
  return listTemplates(db).find((t) => t.name === name);
}

export function saveTemplate(db: Database, t: SpawnTemplate): SpawnTemplate[] {
  const next = [...listTemplates(db).filter((x) => x.name !== t.name), t];
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('spawn_templates', ?)").run(JSON.stringify(next));
  return next;
}

export function deleteTemplate(db: Database, name: string): SpawnTemplate[] {
  const next = listTemplates(db).filter((x) => x.name !== name);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('spawn_templates', ?)").run(JSON.stringify(next));
  return next;
}

/** Reusable "used when" prose for template roles (settings blob, no SQL table). */
export function listRoleWhenPresets(db: Database): RoleWhenPreset[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'role_when_presets'").get() as { value: string } | undefined;
  if (!row) return [];
  try { return JSON.parse(row.value) as RoleWhenPreset[]; } catch { return []; }
}

export function saveRoleWhenPreset(db: Database, p: RoleWhenPreset): RoleWhenPreset[] {
  const next = [...listRoleWhenPresets(db).filter((x) => x.id !== p.id), p];
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('role_when_presets', ?)").run(JSON.stringify(next));
  return next;
}

export function deleteRoleWhenPreset(db: Database, id: string): RoleWhenPreset[] {
  const next = listRoleWhenPresets(db).filter((x) => x.id !== id);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('role_when_presets', ?)").run(JSON.stringify(next));
  return next;
}

const DESIGNATIONS_KEY = 'conversation_designations';

export function listCustomDesignations(db: Database): string[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(DESIGNATIONS_KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed: unknown = JSON.parse(row.value);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function persistCustomDesignations(db: Database, custom: string[]): string[] {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(DESIGNATIONS_KEY, JSON.stringify(custom));
  return custom;
}

export function listDesignationCatalogue(db: Database): string[] {
  return designationCatalogue(listCustomDesignations(db));
}

export function addCustomDesignation(
  db: Database,
  raw: unknown,
): { ok: true; custom: string[] } | { ok: false; error: string } {
  const result = addCustomDesignationToken(listCustomDesignations(db), raw);
  if (!result.ok) return result;
  return { ok: true, custom: persistCustomDesignations(db, result.custom) };
}

export function deleteCustomDesignation(
  db: Database,
  raw: unknown,
): { ok: true; custom: string[] } | { ok: false; error: string } {
  const result = removeCustomDesignationToken(listCustomDesignations(db), raw);
  if (!result.ok) return result;
  return { ok: true, custom: persistCustomDesignations(db, result.custom) };
}

// ponytail: upgrade to migration 115 + prompts table if search, per-project scoping, or volume grows past ~few hundred.
export function listCustomPrompts(db: Database): PromptCollectionEntry[] {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'prompt_collection'").get() as { value: string } | undefined;
  if (!row) return [];
  try {
    const v = JSON.parse(row.value) as unknown;
    return Array.isArray(v) ? (v as PromptCollectionEntry[]) : [];
  } catch { return []; }
}

export function saveCustomPrompt(db: Database, p: PromptCollectionEntry): PromptCollectionEntry[] {
  const existing = listCustomPrompts(db).find((x) => x.id === p.id);
  const row: PromptCollectionEntry = existing
    ? { ...p, createdAt: existing.createdAt ?? p.createdAt, updatedAt: Date.now() }
    : p;
  const next = [...listCustomPrompts(db).filter((x) => x.id !== row.id), row];
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('prompt_collection', ?)").run(JSON.stringify(next));
  return next;
}

export function deleteCustomPrompt(db: Database, id: string): PromptCollectionEntry[] {
  const next = listCustomPrompts(db).filter((x) => x.id !== id);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('prompt_collection', ?)").run(JSON.stringify(next));
  return next;
}

export function importCustomPrompts(
  db: Database,
  incoming: PromptCollectionEntry[],
  overwrite: boolean,
): { prompts: PromptCollectionEntry[]; imported: string[]; skipped: Array<{ id: string; name: string }> } {
  const existing = listCustomPrompts(db);
  const byId = new Map(existing.map((p) => [p.id, p]));
  const imported: string[] = [];
  const skipped: Array<{ id: string; name: string }> = [];
  const now = Date.now();

  for (const row of incoming) {
    const hit = byId.get(row.id);
    if (hit) {
      if (!overwrite) {
        skipped.push({ id: row.id, name: row.name });
        continue;
      }
      byId.set(row.id, {
        ...row,
        createdAt: hit.createdAt ?? row.createdAt,
        updatedAt: now,
      });
      imported.push(row.id);
    } else {
      byId.set(row.id, row);
      imported.push(row.id);
    }
  }

  const prompts = [...byId.values()];
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('prompt_collection', ?)").run(JSON.stringify(prompts));
  return { prompts, imported, skipped };
}

export const BTW_DEFAULTS: BtwSettings = {
  primingMode: 'question-aware',
  primingProfileId: null,
};

export function getBtwSettings(db: Database): BtwSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'btw'").get() as { value: string } | undefined;
  if (!row) return { ...BTW_DEFAULTS };
  let parsed: Partial<BtwSettings> = {};
  try { parsed = JSON.parse(row.value) as Partial<BtwSettings>; }
  catch { return { ...BTW_DEFAULTS }; }
  return {
    primingMode: parsed.primingMode === 'generic' ? 'generic' : BTW_DEFAULTS.primingMode,
    primingProfileId: typeof parsed.primingProfileId === 'string' || parsed.primingProfileId === null
      ? parsed.primingProfileId
      : BTW_DEFAULTS.primingProfileId,
  };
}

export function updateBtwSettings(db: Database, patch: Partial<BtwSettings>): BtwSettings {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'btw'").get() as { value: string } | undefined;
  let stored: Record<string, unknown> = {};
  if (row) {
    try { stored = JSON.parse(row.value) as Record<string, unknown>; } catch { stored = {}; }
  }
  const current = getBtwSettings(db);
  const nextSettings: BtwSettings = {
    primingMode: patch.primingMode === 'generic' || patch.primingMode === 'question-aware'
      ? patch.primingMode
      : current.primingMode,
    primingProfileId: patch.primingProfileId !== undefined
      ? (typeof patch.primingProfileId === 'string' || patch.primingProfileId === null
        ? patch.primingProfileId
        : current.primingProfileId)
      : current.primingProfileId,
  };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('btw', ?)")
    .run(JSON.stringify({ ...stored, ...nextSettings }));
  return nextSettings;
}

/** Returns the priming profile override if BTW set one AND it's enabled,
 *  else undefined (= use compaction.preferredProfileId downstream). */
export function getBtwPrimingProfileId(db: Database): string | undefined {
  const id = getBtwSettings(db).primingProfileId;
  return id && catalogue.getProfile(id)?.enabled ? id : undefined;
}

/** First role.profileId that is unknown or disabled in the catalogue, else
 *  undefined. Used by the POST /settings/templates route to reject templates
 *  that would point at non-spawnable profiles. ponytail: linear scan of N
 *  roles against a Map lookup — O(N), N is tiny (template roles ≤ ~5). */
export function invalidTemplateProfile(t: SpawnTemplate): string | undefined {
  for (const r of t.roles) {
    const p = catalogue.getProfile(r.profileId);
    if (!p || !p.enabled) return r.profileId;
  }
  return undefined;
}

const TEMPLATE_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

/** First role.effort that is set but not a known EffortLevel token, else undefined.
 *  Agent/level pairs are not rejected here — clampEffort drops them at spawn. */
export function invalidTemplateEffort(t: SpawnTemplate): string | undefined {
  for (const r of t.roles ?? []) {
    if (r.effort === undefined) continue;
    if (!TEMPLATE_EFFORT_LEVELS.has(r.effort)) return String(r.effort);
  }
  return undefined;
}

/** Format error for optional template/role `mcpServers` lists, else undefined.
 *  Unknown ids are allowed (dangling ids are ignored by the resolver). */
export function invalidTemplateMcp(t: SpawnTemplate): string | undefined {
  if (t.mcpServers !== undefined) {
    const e = validateMcpIdList(t.mcpServers, 'template mcpServers');
    if (e) return e;
  }
  for (const r of t.roles ?? []) {
    if (r.mcpServers === undefined) continue;
    const e = validateMcpIdList(r.mcpServers, `role ${r.role} mcpServers`);
    if (e) return e;
  }
  return undefined;
}

/** First role.defaultDesignation that is not in the current catalogue, else undefined. */
export function invalidTemplateDesignation(t: SpawnTemplate, custom: string[]): string | undefined {
  for (const r of t.roles) {
    if (!r.defaultDesignation) continue;
    const parsed = parseDesignationToken(r.defaultDesignation);
    if (!parsed.ok) return r.defaultDesignation;
    if (!isKnownDesignation(parsed.token, custom)) return parsed.token;
  }
  return undefined;
}

/** Operator-disabled plugin ids. Settings blob key `plugins` = `{ disabled: string[] }`. */
export function getPluginState(db: Database): { disabled: string[] } {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'plugins'").get() as { value: string } | undefined;
  if (!row) return { disabled: [] };
  try {
    const v = JSON.parse(row.value) as { disabled?: unknown };
    const disabled = Array.isArray(v.disabled)
      ? v.disabled.filter((x): x is string => typeof x === 'string')
      : [];
    return { disabled };
  } catch {
    return { disabled: [] };
  }
}

export function setPluginDisabled(db: Database, pluginId: string, disabled: boolean): { disabled: string[] } {
  const current = new Set(getPluginState(db).disabled);
  if (disabled) current.add(pluginId);
  else current.delete(pluginId);
  const next = { disabled: [...current].sort() };
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('plugins', ?)").run(JSON.stringify(next));
  return next;
}

export function deletePluginSettings(db: Database, pluginId: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(`plugin:${pluginId}`);
}

const SESSION_FLOOR_KEY = 'auth.session_floor_ms';

/** Logout revocation floor. Tokens with `iatMs` below this are rejected. */
export function getSessionFloorMs(db: Database): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(SESSION_FLOOR_KEY) as { value: string } | undefined;
  if (!row) return 0;
  const n = Number(row.value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Persist a new floor (logout-everywhere). Returns `now`. */
export function bumpSessionFloor(db: Database, now: number): number {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SESSION_FLOOR_KEY, String(now));
  return now;
}
