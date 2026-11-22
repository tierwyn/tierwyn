import React, { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentProfile, ArchiveEntry, CompactionSettings, DirectLlmProfile, DirectLlmTestResult, EnhanceSettings, GeneralSettings,
  ModelRecord,
  Project,
  RetentionStats,
  RoleWhenPreset,
  SidecarLlmSettings, SidecarSite, SidecarSiteRoute, SidecarBackend,
  SpawnTemplate,
  VoiceSettings, WhisperConfigResponse, WhisperDownloadProgress, WhisperModel,
  VoiceCleanupProvider, TtsProvider,
  GrokBotLifecycleStatus, GrokBotAutoStart,
  GlobalTasksSettings as GlobalTasksSettingsRow,
  RemoteHostView,
  SandboxSettings as SandboxSettingsDoc,
} from '@tierwyn/shared';
import {
  DIRECT_LLM_DEFAULT_LABELS,
  DIRECT_LLM_PROFILE_IDS,
  clampSidecarMaxInputChars,
  clampSidecarTimeout,
  DEFAULT_SIDECAR_MAX_INPUT_CHARS,
  DEFAULT_SIDECAR_TIMEOUTS,
  isSidecarAgentBackend,
  TIERWYN_VERSION,
  BUILTIN_DESIGNATIONS,
  SIDECAR_BUILTIN_CONTEXT_PROMPTS,
  BUILTIN_ENHANCE_PROJECT_PROMPTS,
  SIDECAR_BUILTIN_TTS_CODE_PROMPTS,
  SIDECAR_BUILTIN_TTS_DIFF_PROMPTS,
  SIDECAR_BUILTIN_PROMPTS,
  SIDECAR_MAX_INPUT_CHARS_MAX,
  SIDECAR_MAX_INPUT_CHARS_MIN,
  SIDECAR_SITES,
  SIDECAR_SITES_WITH_CWD,
  SIDECAR_SITE_DEFAULT_PROFILE,
  SIDECAR_TIMEOUT_MAX,
  SIDECAR_TIMEOUT_MIN,
  VOICE_PROVIDER_OPTIONS,
  USAGE_AUTO_RESUME_OPTIONS,
  voiceProviderValuesFor,
} from '@tierwyn/shared';
import { api, apiBase, UnauthorizedError, type BackupEntry, type DesignationCatalogue, type OneShotCapableAdapter, type PiperInstalledVoice } from '../api.js';
import { setTtsConfig } from '../speak.js';
import { ModelSelector } from './ModelSelector.js';
import { SidecarPromptManager } from './SidecarPromptManager.js';
import { SelectDropdown, type SelectDropdownOption } from './SelectDropdown.js';
import { PiperVoiceModal } from './PiperVoiceModal.js';
import { CatalogueSettings } from './CatalogueSettings.js';
import { AgentUsageSettings } from './AgentUsageSettings.js';
import { RoleWhenPresetSettings } from './RoleWhenPresetSettings.js';
import { DesignationSettings } from './DesignationSettings.js';
import { ConfirmDialog } from './ConfirmDialog.js';
import { TemplateSettings } from './TemplateSettings.js';
import { CapabilityProfileSettings } from './CapabilityProfileSettings.js';
import { BtwSettings } from './BtwSettings.js';
import { NotificationSettings } from './NotificationSettings.js';
import { DecisionSettingsPanel } from './DecisionSettings.js';
import { PluginSettings } from './PluginSettings.js';
import { McpServerSettings } from './McpServerSettings.js';
import { RemoteHostsSettings } from './RemoteHostsSettings.js';
import { AgentRecurringConsentModal } from './AgentRecurringConsentModal.js';
import { RoleMatchKeywordsEditor } from './RoleMatchKeywordsEditor.js';
import { MeshSettings } from './MeshSettings.js';
import { GlobalTasksSettings } from './GlobalTasksSettings.js';
import { RulePresetsSettings } from './RulePresetsSettings.js';
import { SandboxSettings } from './SandboxSettings.js';
import {
  sttEngineOptions, whisperModelOptions, waveStyleOptions,
  voiceDetectionVisualOptions, voiceProcessingVisualOptions,
  getSttEngine, setSttEngine,
  getWhisperModel, setWhisperModel, getWaveStyle, setWaveStyle,
  getVoiceDetectionVisual, setVoiceDetectionVisual,
  getVoiceProcessingVisual, setVoiceProcessingVisual,
  type WaveStyle, type VoiceDetectionVisual, type VoiceProcessingVisual,
} from '../voiceSettings.js';

export type SettingsTab = 'general' | 'notifications' | 'schedules' | 'voice' | 'directLlm' | 'compaction' | 'sandbox' | 'agents' | 'grokBot' | 'agentUsage' | 'plugins' | 'mcp' | 'remoteHosts' | 'mesh' | 'globalTasks' | 'rulePresets' | 'templates' | 'capabilityProfiles';
type Tab = SettingsTab;

const TAB_ICONS: Record<Tab, React.ReactNode> = {
  general: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  ),
  notifications: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
      <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
    </svg>
  ),
  schedules: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2"/>
      <path d="M16 2v4M8 2v4M3 10h18"/>
    </svg>
  ),
  voice: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" x2="12" y1="19" y2="22"/>
    </svg>
  ),
  directLlm: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2"/>
      <path d="M9 9h6M9 12h6M9 15h4"/>
    </svg>
  ),
  compaction: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m9 15-3-3 3-3"/>
      <path d="m15 9 3 3-3 3"/>
      <path d="M12 5v14"/>
      <path d="M18 12H6"/>
    </svg>
  ),
  sandbox: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  ),
  agents: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8V4H8"/>
      <rect width="16" height="12" x="4" y="8" rx="2"/>
      <path d="M2 14h2"/>
      <path d="M20 14h2"/>
      <path d="M15 13v2"/>
      <path d="M9 13v2"/>
    </svg>
  ),
  grokBot: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="5" y="7" width="14" height="12" rx="2"/>
      <path d="M9 11h.01M15 11h.01"/>
      <path d="M8 15h8"/>
      <path d="M12 7V4"/>
      <circle cx="12" cy="3" r="1"/>
    </svg>
  ),
  agentUsage: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="20" x2="18" y2="10"/>
      <line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/>
    </svg>
  ),
  plugins: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22v-5"/>
      <path d="M9 8V2"/>
      <path d="M15 8V2"/>
      <path d="M18 8v5a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z"/>
    </svg>
  ),
  mcp: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="20" height="8" rx="2" ry="2"/>
      <rect x="2" y="14" width="20" height="8" rx="2" ry="2"/>
      <line x1="6" y1="6" x2="6.01" y2="6"/>
      <line x1="6" y1="18" x2="6.01" y2="18"/>
    </svg>
  ),
  remoteHosts: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="20" height="8" rx="2"/>
      <rect x="6" y="13" width="12" height="8" rx="2"/>
      <path d="M6 7h.01M12 17h.01"/>
    </svg>
  ),
  mesh: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5"/>
      <circle cx="18" cy="6" r="2.5"/>
      <circle cx="12" cy="18" r="2.5"/>
      <path d="M8 7.5 10.5 16"/>
      <path d="M16 7.5 13.5 16"/>
      <path d="M8.5 6h7"/>
    </svg>
  ),
  globalTasks: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 11l3 3L22 4"/>
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>
    </svg>
  ),
  rulePresets: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
      <polyline points="14 2 14 8 20 8"/>
      <line x1="16" y1="13" x2="8" y2="13"/>
      <line x1="16" y1="17" x2="8" y2="17"/>
      <polyline points="10 9 9 9 8 9"/>
    </svg>
  ),
  templates: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  ),
  capabilityProfiles: (
    <svg className="tab-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </svg>
  ),
};

interface Props {
  profiles: AgentProfile[];
  /** Live flag from useWs; ModelSelectors that read App's /profiles must not
   *  treat the initial [] as "no agents enabled". */
  profilesLoaded?: boolean;
  initialTab?: Tab;
  onClose: () => void;
  onCompactionChanged?: (s: CompactionSettings) => void;
  onSandboxChanged?: (s: SandboxSettingsDoc) => void;
  onGeneralChanged?: (s: GeneralSettings) => void;
  onCatalogueChanged: () => void;
  catalogueVersion?: number;
  onVoiceTtsChanged?: (tts: VoiceSettings['tts']) => void;
  onVoiceCleanupChanged?: (cleanup: VoiceSettings['cleanup']) => void;
  onGlobalTasksChanged?: (s: GlobalTasksSettingsRow) => void;
  remoteHosts: RemoteHostView[];
  onRemoteHostsChange: React.Dispatch<React.SetStateAction<RemoteHostView[]>>;
}

const verbosityOptions: SelectDropdownOption<CompactionSettings['summaryVerbosity']>[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

const handoffModeOptions: SelectDropdownOption<CompactionSettings['handoffMode']>[] = [
  { value: 'summary', label: 'Always summarize' },
  { value: 'transcript', label: 'Pass full transcript' },
  { value: 'prompt', label: 'Ask at each handoff' },
];

const ttsProviderOptions: SelectDropdownOption<TtsProvider>[] = [
  { value: 'browser', label: 'Browser (on-device)' },
  { value: 'piper', label: 'Piper (self-hosted sidecar)' },
  { value: 'kokoro', label: 'Kokoro (self-hosted sidecar)' },
];

const interactionModeOptions: SelectDropdownOption<CompactionSettings['interactionMode']>[] = [
  { value: 'bypass', label: 'Bypass (auto-approve all tools)' },
  { value: 'questions', label: 'Questions only (bypass permissions, surface plans/questions)' },
  { value: 'prompt', label: 'Prompt (ask for permissions and questions)' },
];

const SIDECAR_BACKEND_OPTIONS: SelectDropdownOption<SidecarBackend>[] = [
  { value: 'direct', label: 'Direct LLM profile' },
  { value: 'agent_oneshot', label: 'Agent one-shot (no tools)' },
  { value: 'agent_readonly', label: 'Agent read-only (file read only)' },
];

type RowSave = { state: 'idle' | 'saving' | 'saved' | 'error'; error?: string; at?: number };

const SIDECAR_SITE_ROWS: { site: SidecarSite; label: string; blurb: string }[] = [
  { site: 'transcribe', label: 'Transcript cleanup', blurb: 'Cleans up the raw speech-to-text transcript after dictation.' },
  { site: 'enhance', label: 'Dictation enhance', blurb: 'Rewrites a draft or dictation clip, optionally using conversation context. Also used by Roster Templates (✨ Suggest) to draft Artificial Analysis "use when" hints (tools-off).' },
  { site: 'tts', label: 'TTS summary', blurb: 'Summarises text, a code file, or a diff before it is spoken aloud.' },
  { site: 'describe', label: 'Conversation description', blurb: 'Writes a one-line sidebar subtitle on first prompt. Edit Conversation → Regenerate still works when this is off.' },
  { site: 'commit', label: 'Commit message', blurb: 'Drafts a git commit message from the staged diff.' },
  { site: 'btw', label: 'BTW side question', blurb: 'Answers a side question about the current conversation without interrupting the running agent.' },
];

function sidecarBackendHint(backend: SidecarBackend): string {
  if (backend === 'direct') return 'Calls a Direct LLM HTTP profile (provider, URL, model, and key).';
  if (backend === 'agent_oneshot') return 'Spawns a headless agent with every tool disabled.';
  return 'Spawns a headless agent that may only read files under the job\'s working directory. Write and shell stay off.';
}

function sidecarTimeoutHint(site: SidecarSite): string {
  const when = {
    transcribe: 'When the timer expires the call is aborted; cleanup is skipped and the raw transcript is kept.',
    enhance: 'When the timer expires the call is aborted and the rewrite fails.',
    tts: 'When the timer expires the call is aborted and summarize or explain fails.',
    describe: 'When the timer expires the call is aborted and a short fallback phrase is used instead.',
    commit: 'When the timer expires the call is aborted and message generation fails.',
    btw: 'When the timer expires the call is aborted and the side question is marked failed.',
  }[site];
  return `${when} Blank uses the default (${DEFAULT_SIDECAR_TIMEOUTS[site]} s).`;
}

function sidecarMaxInputHint(site: SidecarSite): string {
  const blank = `Blank uses the default (${DEFAULT_SIDECAR_MAX_INPUT_CHARS[site]} chars).`;
  if (site === 'transcribe') return `Cleanup currently sends the whole transcript regardless of this cap. ${blank}`;
  if (site === 'enhance') return `Caps conversation context for context-aware enhance (about one token per four characters). The draft itself is not sliced. ${blank}`;
  if (site === 'tts') return `Caps both summarize input and read-aloud length. ${blank}`;
  if (site === 'describe') return `Truncates the conversation bundle (or first prompt) sent to the model. ${blank}`;
  if (site === 'commit') return `Caps the staged diff sent to the model; oversize diffs fall back to a --stat summary. ${blank}`;
  return `Bounds both the conversation context and the question. A question that is too long is rejected. Agent backends are capped at about 120,000 characters regardless. ${blank}`;
}

function sidecarPromptHint(kind: 'default' | 'enhance-quick' | 'enhance-context' | 'enhance-project' | 'tts-code' | 'tts-diff'): string {
  const edit = 'Edit prompts lets you add your own.';
  if (kind === 'enhance-quick') return `System instruction the model receives for a quick rewrite. ${edit}`;
  if (kind === 'enhance-context') return `System instruction used when the rewrite includes conversation context. ${edit}`;
  if (kind === 'enhance-project') return `System instruction used by Enhance with the project. ${edit}`;
  if (kind === 'tts-code') return `System instruction for summarising a code file before speech. ${edit}`;
  if (kind === 'tts-diff') return `System instruction for explaining a diff before speech. ${edit}`;
  return `System instruction the model receives for this job. ${edit}`;
}

const ENHANCE_PROJECT_DIRECT_HINT =
  'Used only by Enhance with the project. Quick and context keep using the Direct LLM profile.';
const ENHANCE_PROJECT_AGENT_HINT =
  'Enhance with the project uses the adapter and model above, and only if that adapter supports read-only one-shot. Quick and context on an agent_readonly row run tools-off.';

// Grouped by concern; the rail renders a heading whenever `group` changes.
const TABS: { id: Tab; label: string; group: string }[] = [
  { id: 'general', label: 'General', group: 'General' },
  { id: 'notifications', label: 'Notifications', group: 'General' },
  { id: 'voice', label: 'Voice', group: 'General' },
  { id: 'globalTasks', label: 'Global Tasks', group: 'General' },
  { id: 'agents', label: 'Agents', group: 'Agents' },
  { id: 'remoteHosts', label: 'Remote Hosts', group: 'Agents' },
  { id: 'grokBot', label: 'Grok Bot', group: 'Agents' },
  { id: 'agentUsage', label: 'Usage', group: 'Agents' },
  { id: 'templates', label: 'Templates', group: 'Orchestration' },
  { id: 'schedules', label: 'Schedules', group: 'Orchestration' },
  { id: 'mesh', label: 'Agent Mesh', group: 'Orchestration' },
  { id: 'compaction', label: 'Compaction', group: 'Orchestration' },
  { id: 'mcp', label: 'MCP Servers', group: 'Tools & Context' },
  { id: 'plugins', label: 'Plugins', group: 'Tools & Context' },
  { id: 'rulePresets', label: 'Rule Presets', group: 'Tools & Context' },
  { id: 'directLlm', label: 'Sidecar LLMs', group: 'Tools & Context' },
  { id: 'sandbox', label: 'Sandbox', group: 'Security' },
  { id: 'capabilityProfiles', label: 'Capability Profiles', group: 'Security' },
];

const TAB_OPTIONS: SelectDropdownOption<Tab>[] = TABS.map(({ id, label, group }) => ({ value: id, label, badge: group }));

function formatBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

function formatCount(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? m.toFixed(1) : m.toFixed(2)}M`;
  }
  return n.toLocaleString('en-GB');
}

function formatRetentionStatsLine(s: RetentionStats, days: number): string {
  const db = s.walSizeBytes > 0
    ? `DB ${formatBytes(s.dbSizeBytes)} (+${formatBytes(s.walSizeBytes)} WAL)`
    : `DB ${formatBytes(s.dbSizeBytes)}`;
  const parts = [db, `${formatCount(s.totalConversations)} conversations`, `${formatCount(s.eventsCount)} events`];
  if (days > 0) parts.push(`${formatCount(s.eligibleConversations)} eligible for purge`);
  else parts.push('retention off — nothing eligible');
  parts.push(s.archivedCount > 0
    ? `archive: ${formatCount(s.archivedCount)} files (${formatBytes(s.archiveBytes)})`
    : 'archive: none');
  return parts.join(' · ');
}

/**
 * [S3-5] What the "Max deferral (hours)" input does on blur / Enter.
 * Empty, whitespace, non-finite or out-of-range text keeps the previously
 * persisted value — an empty field must NEVER persist 0 (that silently
 * disables deferral) — and surfaces a validation hint. Valid numbers,
 * including partials like "12" typed on the way to "120", still save.
 * `null` means the field isn't being edited (no draft), so blur is a no-op.
 */
export type DeferralHoursDecision =
  | { kind: 'save'; ms: number }
  | { kind: 'keep'; error: string }
  | { kind: 'idle' };

export function decideDeferralHours(raw: string | null): DeferralHoursDecision {
  if (raw === null) return { kind: 'idle' };
  const trimmed = raw.trim();
  if (trimmed === '') return { kind: 'keep', error: 'Enter hours (0–168). Empty keeps the saved value.' };
  const hours = Number(trimmed);
  if (!Number.isFinite(hours) || hours < 0 || hours > 168) {
    return { kind: 'keep', error: 'Deferral must be between 0 and 168 hours.' };
  }
  return { kind: 'save', ms: Math.round(hours * 3_600_000) };
}

export function SettingsModal({
  profiles,
  profilesLoaded: agentProfilesLoaded = true,
  initialTab = 'general',
  onClose,
  onCompactionChanged,
  onSandboxChanged,
  onGeneralChanged,
  onCatalogueChanged,
  catalogueVersion,
  onVoiceTtsChanged,
  onVoiceCleanupChanged,
  onGlobalTasksChanged,
  remoteHosts,
  onRemoteHostsChange,
}: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [tabSearch, setTabSearch] = useState('');

  const filteredTabs = useMemo(() => {
    const q = tabSearch.trim().toLowerCase();
    if (!q) return TABS;
    return TABS.filter(
      (t) =>
        t.label.toLowerCase().includes(q) ||
        t.group.toLowerCase().includes(q) ||
        t.id.toLowerCase().includes(q)
    );
  }, [tabSearch]);
  const [compaction, setCompaction] = useState<CompactionSettings | null>(null);
  /** [S3-5] Draft text for "Max deferral (hours)". null = not editing → show the persisted value. */
  const [deferHoursDraft, setDeferHoursDraft] = useState<string | null>(null);
  const [deferHoursError, setDeferHoursError] = useState<string | null>(null);
  const [general, setGeneral] = useState<GeneralSettings | null>(null);
  const [showRecurringConsentModal, setShowRecurringConsentModal] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [grokStatus, setGrokStatus] = useState<GrokBotLifecycleStatus | null>(null);
  const [grokEnableError, setGrokEnableError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<SpawnTemplate[]>([]);
  const [voice, setVoice] = useState<VoiceSettings | null>(null);
  const [whisperCfg, setWhisperCfg] = useState<WhisperConfigResponse | null>(null);
  const [whisperModel, setWhisperModelState] = useState<WhisperModel>(getWhisperModel());
  const [download, setDownload] = useState<WhisperDownloadProgress | null>(null);
  const [enhance, setEnhance] = useState<EnhanceSettings | null>(null);
  const [enhanceTest, setEnhanceTest] = useState<{ ok: boolean; reply?: string; error?: string } | null>(null);
  const [sidecar, setSidecar] = useState<SidecarLlmSettings | null>(null);
  const [sidecarAdapters, setSidecarAdapters] = useState<OneShotCapableAdapter[]>([]);
  const [directProfiles, setDirectProfiles] = useState<DirectLlmProfile[]>([]);
  const [profilesLoaded, setProfilesLoaded] = useState(false);
  const [selectedProfileId, setSelectedProfileId] = useState<string>('cleanup');
  const [profileRev, setProfileRev] = useState(0);
  const [profileTest, setProfileTest] = useState<DirectLlmTestResult | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileTesting, setProfileTesting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const pendingProfileSave = useRef<Promise<unknown>>(Promise.resolve());
  const [rowSave, setRowSave] = useState<Record<SidecarSite, RowSave>>({
    transcribe: { state: 'idle' },
    enhance: { state: 'idle' },
    tts: { state: 'idle' },
    describe: { state: 'idle' },
    commit: { state: 'idle' },
    btw: { state: 'idle' },
  });
  const modelDebounce = useRef<Partial<Record<SidecarSite, ReturnType<typeof setTimeout>>>>({});
  const sidecarRef = useRef<SidecarLlmSettings | null>(null);
  sidecarRef.current = sidecar;
  const [profileLabelError, setProfileLabelError] = useState<Partial<Record<string, string>>>({});
  const [catalogueModels, setCatalogueModels] = useState<ModelRecord[]>([]);
  const [sttEngine, setSttEngineState] = useState(getSttEngine());
  const [waveStyle, setWaveStyleState] = useState<WaveStyle>(getWaveStyle());
  const [detectionVisual, setDetectionVisualState] = useState<VoiceDetectionVisual>(getVoiceDetectionVisual());
  const [processingVisual, setProcessingVisualState] = useState<VoiceProcessingVisual>(getVoiceProcessingVisual());
  const [piperInstalled, setPiperInstalled] = useState<PiperInstalledVoice[]>([]);
  const [piperModalOpen, setPiperModalOpen] = useState(false);
  const [kokoroVoices, setKokoroVoices] = useState<{ id: string; name: string }[]>([]);
  const [kokoroVoicesError, setKokoroVoicesError] = useState<string | null>(null);
  /** Lifted for Templates tab: library card + role-row dropdown share one list. */
  const [roleWhenPresets, setRoleWhenPresets] = useState<RoleWhenPreset[]>([]);
  const [designations, setDesignations] = useState<DesignationCatalogue>({
    builtins: [...BUILTIN_DESIGNATIONS],
    custom: [],
    catalogue: [...BUILTIN_DESIGNATIONS],
  });
  /** Sub-tabs under Templates: left = saved templates, right = used-when presets. */
  const [templatesSubTab, setTemplatesSubTab] = useState<'saved' | 'presets' | 'designations'>('saved');
  const [purgeStatus, setPurgeStatus] = useState<string | null>(null);
  const [purging, setPurging] = useState(false);
  const [showPurgeConfirm, setShowPurgeConfirm] = useState(false);
  const [retentionStats, setRetentionStats] = useState<RetentionStats | null>(null);
  const [watchPurge, setWatchPurge] = useState(false);
  const sawPurgeRunning = useRef(false);
  /** FW-11 archive browser. Opt-in: the list costs one open+read per archive file. */
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archive, setArchive] = useState<ArchiveEntry[] | null>(null);
  const [archiveProjects, setArchiveProjects] = useState<Project[]>([]);
  const [restoreTarget, setRestoreTarget] = useState<string>('');
  const [restoringEntry, setRestoringEntry] = useState<ArchiveEntry | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deletingEntry, setDeletingEntry] = useState<ArchiveEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteAllStep, setDeleteAllStep] = useState<0 | 1 | 2>(0);
  const [deletingAll, setDeletingAll] = useState(false);

  // FW-17 backups
  const [backups, setBackups] = useState<BackupEntry[] | null>(null);
  const [audioBytes, setAudioBytes] = useState(0);
  const [audioFiles, setAudioFiles] = useState(0);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [backupStatus, setBackupStatus] = useState<string | null>(null);
  const [deletingBackup, setDeletingBackup] = useState<BackupEntry | null>(null);
  const [backupDeleting, setBackupDeleting] = useState(false);

  const refreshPiperVoices = () => api.listPiperVoices().then((r) => setPiperInstalled(r.installed)).catch(() => { /* offline */ });

  const refreshKokoroVoices = () => {
    setKokoroVoicesError(null);
    api.listKokoroVoices()
      .then((r) => setKokoroVoices(r.voices ?? []))
      .catch((e) => {
        setKokoroVoices([]);
        setKokoroVoicesError(e instanceof Error ? e.message : 'Kokoro voices unavailable');
      });
  };

  const refreshWhisper = () => api.getWhisperConfig().then(setWhisperCfg).catch(() => { /* offline */ });

  useEffect(() => {
    api.getCompaction().then(setCompaction);
    api.getGeneral().then(setGeneral);
    api.listTemplates().then(setTemplates).catch(() => {});
    api.getVoiceSettings().then(setVoice).catch(() => { /* offline */ });
    api.getEnhanceConfig().then((r) => setEnhance(r.settings)).catch(() => { /* offline */ });
    api.getSidecarLlmSettings().then((r) => {
      setSidecar(r.settings);
      setSidecarAdapters(r.capableAdapters);
    }).catch(() => { /* offline */ });
    api.getDirectLlmProfiles()
      .then(setDirectProfiles)
      .catch(() => { /* offline */ })
      .finally(() => setProfilesLoaded(true));
    api.getCatalogue().then((c) => setCatalogueModels(c.models)).catch(() => { /* offline */ });
    api.getRetentionStats().then((s) => {
      setRetentionStats(s);
      if (s.purgeRunning) {
        sawPurgeRunning.current = true;
        setWatchPurge(true);
        setPurgeStatus('A purge is already running.');
      }
    }).catch(() => { /* offline */ });
    refreshWhisper();
    refreshPiperVoices();
  }, []);

  useEffect(() => {
    if (!watchPurge && !retentionStats?.purgeRunning) return;
    const t = window.setInterval(() => {
      api.getRetentionStats().then((s) => {
        setRetentionStats(s);
        if (s.purgeRunning) {
          sawPurgeRunning.current = true;
        } else if (sawPurgeRunning.current) {
          sawPurgeRunning.current = false;
          setWatchPurge(false);
          setPurgeStatus(`Purge finished. DB now ${formatBytes(s.dbSizeBytes)}.`);
        }
      }).catch(() => { /* keep polling */ });
    }, 5000);
    return () => window.clearInterval(t);
  }, [watchPurge, retentionStats?.purgeRunning]);

  // Fetch when the Templates tab is opened (and once if already open).
  useEffect(() => {
    if (tab !== 'templates') return;
    api.listRolePresets().then(setRoleWhenPresets).catch(() => setRoleWhenPresets([]));
    api.listDesignations().then(setDesignations).catch(() => {});
  }, [tab]);

  useEffect(() => {
    if (tab !== 'grokBot') return;
    let cancelled = false;
    const load = () => {
      api.getGrokBotStatus().then((s) => { if (!cancelled) setGrokStatus(s); }).catch(() => {});
    };
    load();
    const t = window.setInterval(load, 5000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [tab]);

  useEffect(() => {
    if (voice?.tts.provider === 'piper') refreshPiperVoices();
    if (voice?.tts.provider === 'kokoro' || voice?.tts.provider === 'browser') refreshKokoroVoices();
  }, [voice?.tts.provider, voice?.tts.kokoroUrl]);

  // Poll the download at ~1 Hz while one is in flight.
  useEffect(() => {
    if (!download || download.done) return;
    const t = setInterval(async () => {
      try {
        const p = await api.getDownloadProgress(download.model);
        setDownload(p);
        if (p.done) {
          clearInterval(t);
          // Give the server a moment to clear its in-memory tracker, then refetch config.
          setTimeout(refreshWhisper, 600);
        }
      } catch { /* keep polling */ }
    }, 1000);
    return () => clearInterval(t);
  }, [download]);

  const saveVoice = async (patch: { cleanup?: Partial<VoiceSettings['cleanup']>; tts?: Partial<VoiceSettings['tts']> }) => {
    const updated = await api.updateVoiceSettings(patch);
    setVoice(updated);
    if (updated.tts) {
      setTtsConfig(updated.tts);
      onVoiceTtsChanged?.(updated.tts);
    }
    if (patch.cleanup) {
      setWhisperCfg((c) => c ? { ...c, cleanup: updated.cleanup } : c);
      onVoiceCleanupChanged?.(updated.cleanup);
      if (patch.cleanup.enabled !== undefined) {
        void api.getSidecarLlmSettings().then((r) => setSidecar(r.settings)).catch(() => { /* offline */ });
      }
    }
    void api.getDirectLlmProfiles().then(setDirectProfiles).catch(() => { /* offline */ });
  };

  const startDownload = async (model: WhisperModel) => {
    setDownload({ model, downloaded: 0, total: 0, pct: 0, done: false, error: null });
    try {
      await api.downloadWhisperModel(model);
    } catch (e) {
      setDownload({ model, downloaded: 0, total: 0, pct: 0, done: true, error: e instanceof Error ? e.message : String(e) });
    }
  };

  const refreshLegacyBlobs = async () => {
    const [v, e] = await Promise.all([
      api.getVoiceSettings().catch(() => null),
      api.getEnhanceConfig().catch(() => null),
    ]);
    if (v) {
      setVoice(v);
      onVoiceCleanupChanged?.(v.cleanup);
      setWhisperCfg((c) => c ? { ...c, cleanup: v.cleanup } : c);
    }
    if (e) setEnhance(e.settings);
    window.dispatchEvent(new Event('enhance-settings-changed'));
  };

  const persistSidecarSite = (site: SidecarSite, route: SidecarSiteRoute) => {
    const pending = modelDebounce.current[site];
    if (pending) {
      clearTimeout(pending);
      modelDebounce.current[site] = undefined;
    }
    // Write the ref in this tick (not only on the next render) so a blur-on-unmount
    // that fires after a Direct persist sees backend:'direct' and refuses to POST agent.
    if (sidecarRef.current) {
      sidecarRef.current = { ...sidecarRef.current, [site]: route };
    }
    setSidecar((s) => s ? { ...s, [site]: route } : s);
    setRowSave((r) => ({ ...r, [site]: { state: 'saving' } }));
    void api.updateSidecarLlmSettings({ [site]: route })
      .then(async (res) => {
        setSidecar(res.settings);
        setSidecarAdapters(res.capableAdapters);
        setRowSave((r) => ({ ...r, [site]: { state: 'saved', at: Date.now() } }));
        setTimeout(() => {
          setRowSave((r) => (r[site]?.state === 'saved' ? { ...r, [site]: { state: 'idle' } } : r));
        }, 2500);
        if (site === 'transcribe' || site === 'describe') await refreshLegacyBlobs();
        else if (site === 'enhance' || site === 'tts') {
          window.dispatchEvent(new Event('enhance-settings-changed'));
        }
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setRowSave((r) => ({ ...r, [site]: { state: 'error', error: msg } }));
        void api.getSidecarLlmSettings().then((res) => setSidecar(res.settings));
      });
  };

  const commitTimeout = (site: SidecarSite, raw: string) => {
    const current = sidecarRef.current?.[site];
    if (!current) return;
    const next = raw.trim() === '' ? null : clampSidecarTimeout(raw);
    if ((current.timeoutSecs ?? null) === (next ?? null)) return;   // no-op blur
    persistSidecarSite(site, { ...current, timeoutSecs: next as number | undefined });
  };

  const commitMaxInputChars = (site: SidecarSite, raw: string, el: HTMLInputElement) => {
    const current = sidecarRef.current?.[site];
    if (!current) return;
    const trimmed = raw.trim();
    if (trimmed === '') {
      if ((current.maxInputChars ?? null) === null) {
        el.value = '';
        return;
      }
      persistSidecarSite(site, { ...current, maxInputChars: null as unknown as number | undefined });
      return;
    }
    const next = clampSidecarMaxInputChars(raw);
    if (next === undefined) {
      el.value = current.maxInputChars != null ? String(current.maxInputChars) : '';
      return;
    }
    if (current.maxInputChars === next) {
      el.value = String(next);
      return;
    }
    persistSidecarSite(site, { ...current, maxInputChars: next });
  };

  const flushSidecarModelDebounce = () => {
    for (const site of SIDECAR_SITES) {
      const t = modelDebounce.current[site];
      if (!t) continue;
      clearTimeout(t);
      modelDebounce.current[site] = undefined;
      const route = sidecarRef.current?.[site];
      if (route && isSidecarAgentBackend(route.backend)) persistSidecarSite(site, route);
    }
  };

  const isMountedRef = useRef(true);

  const closeModal = () => {
    flushSidecarModelDebounce();
    onClose();
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      flushSidecarModelDebounce();
    };
  }, []);

  const sidecarModelOptions = (adapter: string | undefined, savedModel?: string): SelectDropdownOption<string>[] => {
    if (!adapter) return [];
    const opts = catalogueModels
      .filter((m) => m.agentId === adapter && m.enabled)
      .map((m) => ({ value: m.modelName, label: m.label || m.modelName }));
    if (savedModel && !opts.some((o) => o.value === savedModel)) {
      opts.unshift({ value: savedModel, label: `${savedModel} (not in catalogue)` });
    }
    return opts;
  };

  const runEnhanceTest = async () => {
    setEnhanceTest({ ok: true });
    const r = await api.testEnhance();
    setEnhanceTest(r);
  };

  const saveCompaction = async (patch: Partial<CompactionSettings>) => {
    const updated = await api.updateCompaction(patch);
    setCompaction(updated);
    onCompactionChanged?.(updated);
  };

  const saveGeneral = async (patch: Partial<GeneralSettings>) => {
    try {
      if (isMountedRef.current) setGeneralError(null);
      const updated = await api.updateGeneral(patch);
      if (isMountedRef.current) {
        setGeneral(updated);
        onGeneralChanged?.(updated);
      }
      api.getRetentionStats().then((stats) => {
        if (isMountedRef.current) setRetentionStats(stats);
      }).catch(() => { /* offline */ });
    } catch (e) {
      if (isMountedRef.current) {
        const msg = e instanceof Error ? e.message : String(e);
        setGeneralError(msg);
      }
    }
  };

  const doPurgeNow = async () => {
    setShowPurgeConfirm(false);
    if (!general || general.conversationRetentionDays <= 0) return;
    setPurging(true);
    setPurgeStatus(null);
    try {
      const r = await api.purgeRetentionNow();
      const dbNow = r.dbSizeBytes ? ` DB now ${formatBytes(r.dbSizeBytes)}.` : '';
      if (r.alreadyRunning) {
        setPurgeStatus('A purge is already running.');
        sawPurgeRunning.current = true;
        setWatchPurge(true);
      } else if (r.remaining > 0) {
        setPurgeStatus(
          `Purged ${r.deleted} conversations (${r.eventsDeleted.toLocaleString('en-GB')} events).${dbNow} ${r.remaining} remaining — continuing in background.`,
        );
        sawPurgeRunning.current = true;
        setWatchPurge(true);
      } else {
        setPurgeStatus(
          `Purged ${r.deleted} conversations (${r.eventsDeleted.toLocaleString('en-GB')} events).${dbNow}`,
        );
      }
      api.getRetentionStats().then(setRetentionStats).catch(() => { /* offline */ });
    } catch (e) {
      setPurgeStatus(e instanceof Error ? e.message : 'Purge failed');
    } finally {
      setPurging(false);
    }
  };

  const refreshBackups = async () => {
    try {
      const r = await api.listBackups();
      setBackups(r.items);
      setAudioBytes(r.audioBytes);
      setAudioFiles(r.audioFiles);
    } catch {
      setBackups([]); // offline / 401 — the panel just shows the empty state
    }
  };

  useEffect(() => { void refreshBackups(); }, []);

  const runBackupNow = async () => {
    setBackingUp(true);
    setBackupStatus(null);
    try {
      const r = await api.createBackup(includeAudio);
      const rotated = r.rotated.length > 0
        ? ` Removed ${r.rotated.length} older backup${r.rotated.length === 1 ? '' : 's'}.`
        : '';
      setBackupStatus(`Backup written: ${r.backup.name} (${formatBytes(r.backup.bytes)}).${rotated}`);
      await refreshBackups();
    } catch (e) {
      setBackupStatus(`Backup failed: ${e instanceof Error ? e.message : 'unknown error'}.`);
    } finally {
      setBackingUp(false);
    }
  };

  // FW-9 pattern: a hidden <a download> instead of location.href — a 404/500
  // must not navigate the SPA away, and the anchor sends the session cookie.
  const downloadBackup = (entry: BackupEntry) => {
    const a = document.createElement('a');
    a.href = `${apiBase}/settings/backups/${encodeURIComponent(entry.name)}/download`;
    a.download = entry.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const confirmDeleteBackup = async (entry: BackupEntry) => {
    setBackupDeleting(true);
    try {
      await api.deleteBackup(entry.name);
      setBackupStatus(`Deleted backup ${entry.name}.`);
      await refreshBackups();
    } catch (e) {
      setBackupStatus(`Delete failed: ${e instanceof Error ? e.message : 'unknown error'}.`);
    } finally {
      setBackupDeleting(false);
      setDeletingBackup(null);
    }
  };

  const openArchive = async () => {
    setArchiveOpen(true);
    setArchive(null);
    try {
      const [items, projects] = await Promise.all([
        api.listRetentionArchive(),
        api.listProjects().catch(() => [] as Project[]),
      ]);
      setArchive(items);
      setArchiveProjects(projects);
    } catch (e) {
      setArchive([]);
      setPurgeStatus(e instanceof Error ? e.message : 'Could not read the archive.');
    }
  };

  const restoreArchived = async (entry: ArchiveEntry) => {
    setRestoring(true);
    setPurgeStatus(null);
    try {
      const r = await api.restoreRetentionArchive(entry.id, restoreTarget || undefined);
      const extra = r.restored.length > 1 ? ` (+${r.restored.length - 1} child conversation(s))` : '';
      const orphan = r.parentCleared ? ' Its parent was gone, so it was restored as a top-level chat.' : '';
      setPurgeStatus(
        `Restored "${entry.title}"${extra} with ${r.eventsRestored} event(s).${orphan} Reload to see it in the sidebar.`,
      );
      setRestoringEntry(null);
      await refreshArchiveAndStats();
    } catch (e) {
      setPurgeStatus(e instanceof Error ? e.message : 'Restore failed.');
    } finally {
      setRestoring(false);
    }
  };

  const refreshArchiveAndStats = async () => {
    const [items, stats] = await Promise.all([
      api.listRetentionArchive(),
      api.getRetentionStats(),
    ]);
    setArchive(items);
    setRetentionStats(stats);
    if (items.length === 0) setDeleteAllStep(0);
  };

  const deleteArchived = async (entry: ArchiveEntry) => {
    setDeleting(true);
    setPurgeStatus(null);
    try {
      await api.deleteRetentionArchive(entry.id);
      setPurgeStatus(`Deleted archive "${entry.title}".`);
      setDeletingEntry(null);
      await refreshArchiveAndStats();
    } catch (e) {
      setPurgeStatus(e instanceof Error ? e.message : 'Delete failed.');
    } finally {
      setDeleting(false);
    }
  };

  const deleteAllArchived = async () => {
    setDeletingAll(true);
    setPurgeStatus(null);
    try {
      const r = await api.deleteAllRetentionArchives();
      setPurgeStatus(
        r.deleted === 0
          ? 'Archive folder was already empty.'
          : `Deleted ${r.deleted} archive file${r.deleted === 1 ? '' : 's'}.`,
      );
      setDeleteAllStep(0);
      await refreshArchiveAndStats();
    } catch (e) {
      setPurgeStatus(e instanceof Error ? e.message : 'Delete all failed.');
    } finally {
      setDeletingAll(false);
    }
  };

  const archiveBusy = restoring || deleting || deletingAll;

  const disabled: React.CSSProperties = { opacity: 0.5, pointerEvents: 'none' };
  const disabledLook: React.CSSProperties = { opacity: 0.5 };

  const installedVoiceOptions: SelectDropdownOption<string>[] = (() => {
    const opts = piperInstalled.map((v) => ({ value: v.id, label: v.label }));
    if (voice && !opts.some((o) => o.value === voice.tts.piperVoice)) {
      // ponytail: don't drop a configured-but-missing voice from the list.
      opts.unshift({ value: voice.tts.piperVoice, label: `${voice.tts.piperVoice} (not installed)` });
    }
    return opts;
  })();

  /** Prefix hint for Kokoro ids (af_heart → American ♀). */
  const kokoroVoiceOptions: SelectDropdownOption<string>[] = (() => {
    const PREFIX: Record<string, string> = {
      af: 'American ♀', am: 'American ♂',
      bf: 'British ♀', bm: 'British ♂',
      ef: 'Spanish ♀', em: 'Spanish ♂',
      ff: 'French ♀',
      hf: 'Hindi ♀', hm: 'Hindi ♂',
      if: 'Italian ♀', im: 'Italian ♂',
      jf: 'Japanese ♀', jm: 'Japanese ♂',
      pf: 'Portuguese ♀', pm: 'Portuguese ♂',
      zf: 'Chinese ♀', zm: 'Chinese ♂',
    };
    const label = (id: string) => {
      const m = /^([a-z]{2})_/.exec(id);
      const hint = m ? PREFIX[m[1]!] : undefined;
      return hint ? `${id} · ${hint}` : id;
    };
    const opts = kokoroVoices.map((v) => ({ value: v.id, label: label(v.id) }));
    if (voice && voice.tts.kokoroVoice && !opts.some((o) => o.value === voice.tts.kokoroVoice)) {
      opts.unshift({
        value: voice.tts.kokoroVoice,
        label: `${label(voice.tts.kokoroVoice)} (not in sidecar list)`,
      });
    }
    if (opts.length === 0) {
      opts.push({ value: 'af_heart', label: 'af_heart · American ♀ (default)' });
    }
    return opts;
  })();

  const sitesUsingProfile = (profileId: string): string[] => {
    if (!sidecar) return [];
    return SIDECAR_SITE_ROWS.filter(({ site }) => {
      const route = sidecar[site];
      if (route.backend !== 'direct') return false;
      const resolved = route.profile?.trim() || SIDECAR_SITE_DEFAULT_PROFILE[site];
      return resolved === profileId;
    }).map((r) => r.label);
  };

  const noProfiles = profilesLoaded && directProfiles.length === 0;
  const selected = directProfiles.find((p) => p.id === selectedProfileId) ?? directProfiles[0];
  // Built-in ids still map to the voice/enhance blobs (refresh on save/delete).
  // They are no longer protected from Delete.
  const builtinSelected = selected
    ? (DIRECT_LLM_PROFILE_IDS as readonly string[]).includes(selected.id)
    : false;

  const saveProfile = (patch: Partial<DirectLlmProfile>) => {
    if (!selected) return Promise.resolve();
    const id = selected.id;
    setProfileLabelError((e) => {
      if (e[id] === undefined) return e;
      const next = { ...e };
      delete next[id];
      return next;
    });
    const p = api.updateDirectLlmProfile(id, patch)
      .then(async (profiles) => {
        setDirectProfiles(profiles);
        if (builtinSelected) await refreshLegacyBlobs();
        return profiles;
      })
      .catch((err) => {
        if (err instanceof UnauthorizedError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        setProfileLabelError((e) => ({ ...e, [id]: msg }));
        setProfileRev((r) => r + 1);
        return api.getDirectLlmProfiles().then(setDirectProfiles);
      });
    pendingProfileSave.current = p;
    return p;
  };

  const createProfile = async () => {
    setProfileLabelError((e) => {
      const { _create, ...rest } = e;
      return rest;
    });
    setProfileBusy(true);
    try {
      const r = await api.createDirectLlmProfile();
      setDirectProfiles(r.profiles);
      setSelectedProfileId(r.createdId);
      setProfileRev((n) => n + 1);
      setProfileTest(null);
      setConfirmDelete(false);
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      setProfileLabelError((e) => ({ ...e, _create: msg }));
    } finally {
      setProfileBusy(false);
    }
  };

  const deleteSelectedProfile = async () => {
    if (!selected) return;
    const deletingBuiltin = (DIRECT_LLM_PROFILE_IDS as readonly string[]).includes(selected.id);
    setProfileBusy(true);
    try {
      const r = await api.deleteDirectLlmProfile(selected.id);
      setDirectProfiles(r.profiles);
      setSidecar(r.sidecar);
      setSelectedProfileId(r.profiles[0]?.id ?? '');
      setProfileRev((n) => n + 1);
      setProfileTest(null);
      setConfirmDelete(false);
      if (deletingBuiltin) await refreshLegacyBlobs();
    } catch (err) {
      if (err instanceof UnauthorizedError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      setProfileLabelError((e) => ({ ...e, [selected.id]: msg }));
      setConfirmDelete(false);
    } finally {
      setProfileBusy(false);
    }
  };

  const sidecarRowChip = (site: SidecarSite): { text: string; amber: boolean } | null => {
    const save = rowSave[site];
    if (save.state === 'saving') return { text: 'Saving…', amber: false };
    if (save.state === 'error') return { text: `Not saved — ${save.error ?? 'error'}`, amber: true };
    if (save.state === 'saved') return { text: 'Saved ✓', amber: false };

    const route = sidecar?.[site];
    if (!route) return null;
    if (route.enabled === false) return { text: 'Disabled', amber: false };

    if (isSidecarAgentBackend(route.backend)) {
      if (!route.adapter?.trim()) return { text: 'Incomplete — pick an adapter. Job is off.', amber: true };
      if (!route.model?.trim()) return { text: 'Incomplete — pick a model. Job is off.', amber: true };
      return { text: 'Ready ✓', amber: false };
    }

    if (!profilesLoaded) return null;
    if (noProfiles) return { text: 'No profiles — feature disabled', amber: true };
    const routedId = route.profile?.trim() || SIDECAR_SITE_DEFAULT_PROFILE[site];
    const p = directProfiles.find((x) => x.id === routedId) ?? directProfiles[0];
    if (!p) return { text: 'No profiles — feature disabled', amber: true };
    if (!p.configured) return { text: 'Profile not configured', amber: true };
    return { text: 'Ready ✓', amber: false };
  };

  const persistSidecarModelDebounced = (site: SidecarSite, model: string) => {
    setSidecar((s) => s ? { ...s, [site]: { ...s[site], model } } : s);
    if (modelDebounce.current[site]) clearTimeout(modelDebounce.current[site]);
    if (!isSidecarAgentBackend(sidecarRef.current?.[site]?.backend ?? '')) {
      modelDebounce.current[site] = undefined;
      return;
    }
    modelDebounce.current[site] = setTimeout(() => {
      modelDebounce.current[site] = undefined;
      const route = sidecarRef.current?.[site];
      if (route && isSidecarAgentBackend(route.backend)) {
        persistSidecarSite(site, { ...route, model });
      }
    }, 600);
  };

  return (
    <div className="modal-overlay" onClick={closeModal}>
      <div
        className="modal-content settings-modal"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Left tab rail */}
        <div className="settings-tabs">
          <div className="settings-tabs-title">Settings</div>
          <div className="settings-tabs-search">
            <input
              type="search"
              className="settings-tabs-search-input"
              placeholder="Search settings…"
              value={tabSearch}
              onChange={(e) => setTabSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && filteredTabs.length > 0) {
                  setTab(filteredTabs[0].id);
                }
              }}
              aria-label="Search settings tabs"
            />
          </div>
          {filteredTabs.length === 0 ? (
            <div className="settings-tabs-empty">No settings match &ldquo;{tabSearch}&rdquo;</div>
          ) : (
            filteredTabs.map(({ id, label, group }, i) => (
              <Fragment key={id}>
                {group !== filteredTabs[i - 1]?.group && (
                  <div className="settings-tab-group">{group}</div>
                )}
                <button
                  className={`settings-tab${tab === id ? ' active' : ''}`}
                  onClick={() => setTab(id)}
                >
                  {TAB_ICONS[id]}
                  <span className="tab-label-text">{label}</span>
                </button>
              </Fragment>
            ))
          )}
        </div>

        {/* Right content */}
        <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="modal-header settings-modal-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '16px 20px', gap: '12px' }}>
            <div className="settings-header-leading">
              <span className="settings-header-title settings-header-title--desktop">
                {TABS.find((t) => t.id === tab)?.label} Settings
              </span>
              <div className="settings-tab-picker">
                <SelectDropdown
                  options={TAB_OPTIONS}
                  value={tab}
                  onChange={setTab}
                  placement="bottom"
                  searchable
                />
              </div>
            </div>
            <button className="usage-close" onClick={closeModal} style={{ fontSize: '18px' }} aria-label="Close settings">×</button>
          </div>

          <div
            className={`modal-body${tab === 'templates' ? ' modal-body--templates' : ''}`}
            style={{ flex: 1, overflowY: tab === 'templates' ? 'hidden' : 'auto', padding: '0 20px 20px' }}
          >

            {/* ── General ─────────────────────────────────────────── */}
            {tab === 'general' && general && compaction && (
              <>
              {generalError && (
                <div style={{ color: 'var(--accent-danger, #ef4444)', fontSize: '12px', marginBottom: '12px', padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                  {generalError}
                </div>
              )}
              <div className="settings-section">
                <div className="settings-section-title">General Preferences</div>
                <div className="settings-card active">
                  <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div className="modal-field modal-field-row">
                      <div>
                        <span className="modal-label">Enable file edits</span>
                        <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                          Saving overwrites files on disk inside project roots / this conversation's worktree.
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={general.fileEditsEnabled}
                        className={`toggle-switch${general.fileEditsEnabled ? ' on' : ''}`}
                        onClick={() => { void saveGeneral({ fileEditsEnabled: !general.fileEditsEnabled }); }}
                        aria-label="Enable file edits"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>

                    <div className="modal-field modal-field-row">
                      <div>
                        <span className="modal-label">Hide built-in prompts</span>
                        <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                          Built-in presets are not listed in the Prompt Collection modal.
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={general.hidePresetPrompts}
                        className={`toggle-switch${general.hidePresetPrompts ? ' on' : ''}`}
                        onClick={() => { void saveGeneral({ hidePresetPrompts: !general.hidePresetPrompts }); }}
                        aria-label="Hide built-in prompts"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>

                    <div className="modal-field modal-field-row">
                      <div>
                        <span className="modal-label">Project memories</span>
                        <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                          Agents save and recall project notes. Review them from the header button.
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={general.memories === true}
                        className={`toggle-switch${general.memories ? ' on' : ''}`}
                        onClick={() => { void saveGeneral({ memories: !general.memories }); }}
                        aria-label="Project memories"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>

                    <div className="modal-field">
                      <span className="modal-label">Agent history search</span>
                      <div
                        className="seg-switch"
                        role="radiogroup"
                        aria-label="Agent history search"
                        style={{ '--seg-n': 3, '--seg-i': ['off', 'project', 'all'].indexOf(general.agentSearchScope ?? 'project') } as React.CSSProperties}
                      >
                        <span className="seg-thumb" aria-hidden="true" />
                        {(['off', 'project', 'all'] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={(general.agentSearchScope ?? 'project') === v}
                            onClick={() => { void saveGeneral({ agentSearchScope: v }); }}
                          >
                            {v === 'off' ? 'Off' : v === 'project' ? 'This project' : 'All projects'}
                          </button>
                        ))}
                      </div>
                      <span className="modal-hint" style={{ display: 'block' }}>
                        Allows agents to search past conversation transcripts via GET /agent/search. 'This project' keeps strict project isolation; 'All projects' permits cross-project search (opt-in).
                      </span>
                    </div>

                    <div className="modal-field">
                      <span className="modal-label">Extended markup hint</span>
                      <div
                        className="seg-switch"
                        role="radiogroup"
                        aria-label="Extended markup hint"
                        style={{ '--seg-n': 3, '--seg-i': ['off', 'all', 'chat'].indexOf(general.markupHint ?? 'all') } as React.CSSProperties}
                      >
                        <span className="seg-thumb" aria-hidden="true" />
                        {(['off', 'all', 'chat'] as const).map((v) => (
                          <button
                            key={v}
                            type="button"
                            role="radio"
                            aria-checked={(general.markupHint ?? 'all') === v}
                            onClick={() => { void saveGeneral({ markupHint: v }); }}
                          >
                            {v === 'off' ? 'Off' : v === 'all' ? 'Chat + files' : 'Chat only'}
                          </button>
                        ))}
                      </div>
                      <span className="modal-hint" style={{ display: 'block' }}>
                        Tells agents they can use coloured status, highlights, keys, badges and <code>{'> [!NOTE]'}</code> alerts (~105 tokens per full preamble). Rendering is always on. <em>Chat only</em> keeps the inline tags out of files; alerts are fine anywhere.
                      </span>
                      <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                        e.g. <span className="md-color md-color-ok">passing</span> <span className="md-color md-color-error">failed</span> <mark className="md-mark">note</mark> <kbd className="md-kbd">Ctrl+S</kbd> <span className="md-badge md-badge-info">v2.1</span>
                        {' '}— <code>{':color[passing]{.ok}'}</code>
                      </span>
                    </div>

                    <div className="modal-field">
                      <span className="modal-label">Default conversation model</span>
                      <ModelSelector
                        profiles={profiles}
                        profilesLoaded={agentProfilesLoaded}
                        selectedProfileId={general.defaultConversationProfileId ?? ''}
                        onChange={(val) => saveGeneral({ defaultConversationProfileId: val || null })}
                        placement="bottom"
                        permissionMode={compaction.interactionMode}
                      />
                      {/* Warn when default profile is bypass-only and full permission mode is active */}
                      {compaction.interactionMode === 'prompt' && (() => {
                        const defaultProfile = profiles.find((p) => p.id === general.defaultConversationProfileId);
                        if (defaultProfile && !defaultProfile.permissionCapable) {
                          return (
                            <div className="modal-hint" style={{ color: 'var(--amber, #f59e0b)', marginTop: 4 }}>
                              ⚠ The default profile uses {defaultProfile.agentType}, which runs bypass-equivalent
                              regardless of the interaction mode setting. Switch to claude-code, codex,
                              or hermes to enforce permission mode.
                            </div>
                          );
                        }
                        return null;
                      })()}
                    </div>

                    <div className="modal-field">
                      <span className="modal-label">Interaction mode</span>
                      <SelectDropdown
                        options={interactionModeOptions}
                        value={compaction.interactionMode}
                        onChange={(val) => saveCompaction({ interactionMode: val })}
                        placement="bottom"
                      />
                    </div>

                    <div className="modal-field">
                      <span className="modal-label">Handoff mode</span>
                      <SelectDropdown
                        options={handoffModeOptions}
                        value={compaction.handoffMode}
                        onChange={(val) => saveCompaction({ handoffMode: val })}
                        placement="bottom"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <DecisionSettingsPanel />
              <div className="settings-section">
                <div className="settings-section-title">Conversation Retention</div>
                <div className="settings-card active">
                  <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div className="modal-field">
                      <span className="modal-label">Conversation retention (days)</span>
                      <div className="settings-input-group">
                        <input
                          className="modal-input"
                          type="number"
                          min={0}
                          max={3650}
                          value={general.conversationRetentionDays}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw.trim() === '') return; // mid-edit; don't save 0
                            const v = Number(raw);
                            if (Number.isFinite(v) && v >= 0 && v <= 3650) {
                              saveGeneral({ conversationRetentionDays: Math.floor(v) });
                            }
                          }}
                          onBlur={(e) => {
                            // Normalise a cleared/garbage field back to the saved value
                            if (e.target.value.trim() === '' || !Number.isFinite(Number(e.target.value))) {
                              e.target.value = String(general.conversationRetentionDays);
                            }
                          }}
                          style={{ width: 120 }}
                        />
                        {general.conversationRetentionDays > 0 && (
                          <button
                            type="button"
                            className="modal-btn"
                            disabled={purging || Boolean(retentionStats?.purgeRunning)}
                            onClick={() => setShowPurgeConfirm(true)}
                          >
                            {purging || retentionStats?.purgeRunning ? 'Purging…' : 'Purge now'}
                          </button>
                        )}
                      </div>
                      <div className="modal-hint">
                        Conversations idle for more than this many days are archived and deleted
                        nightly around 03:00. Default 0 = keep forever. Pinned conversations (📌 in
                        the sidebar) are always exempt.
                      </div>
                      {retentionStats && (
                        <div className="modal-hint">
                          {formatRetentionStatsLine(retentionStats, general.conversationRetentionDays)}
                        </div>
                      )}
                      {purgeStatus && <div className="modal-hint">{purgeStatus}</div>}
                    </div>
                    <div className="modal-field">
                      <span className="modal-label">Trim old tool output (days)</span>
                      <div className="settings-input-group">
                        <input
                          className="modal-input"
                          type="number"
                          min={0}
                          max={3650}
                          value={general.toolResultTrimDays ?? 0}
                          onChange={(e) => {
                            const raw = e.target.value;
                            if (raw.trim() === '') return;
                            const v = Number(raw);
                            if (Number.isFinite(v) && v >= 0 && v <= 3650) {
                              saveGeneral({ toolResultTrimDays: Math.floor(v) });
                            }
                          }}
                          onBlur={(e) => {
                            if (e.target.value.trim() === '' || !Number.isFinite(Number(e.target.value))) {
                              e.target.value = String(general.toolResultTrimDays ?? 0);
                            }
                          }}
                          style={{ width: 120 }}
                        />
                      </div>
                      <div className="modal-hint">
                        Tool output (file reads, command output) older than this many days is cut to
                        its first 2,000 characters in the same nightly pass, then the database is
                        compacted. Prompts and agent replies are kept in full, so search is
                        unaffected. Default 0 = never trim.
                      </div>
                    </div>
                    {retentionStats && retentionStats.archivedCount > 0 && (
                      <div style={{ marginTop: 8 }}>
                        <button
                          type="button"
                          className="modal-btn"
                          onClick={() => {
                            if (archiveOpen) { setArchiveOpen(false); return; }
                            void openArchive();
                          }}
                        >
                          {archiveOpen
                            ? 'Hide archive'
                            : `Show archive (${retentionStats.archivedCount})`}
                        </button>

                          {archiveOpen && archive === null && (
                            <div className="modal-hint">Reading archive…</div>
                          )}

                          {archiveOpen && archive !== null && archive.length === 0 && (
                            <div className="modal-hint">
                              No readable archive files in data/archive.
                            </div>
                          )}

                          {archiveOpen && archive !== null && archive.length > 0 && (
                            <>
                              {archiveProjects.length > 1 && (
                                <div className="modal-field" style={{ marginTop: 8 }}>
                                  <span className="modal-label">Restore into</span>
                                  <select
                                    className="modal-input"
                                    value={restoreTarget}
                                    onChange={(e) => setRestoreTarget(e.target.value)}
                                    style={{ maxWidth: 280 }}
                                  >
                                    <option value="">Original project</option>
                                    {archiveProjects.map((p) => (
                                      <option key={p.id} value={p.id}>{p.name}</option>
                                    ))}
                                  </select>
                                </div>
                              )}
                              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                                <button
                                  type="button"
                                  className="modal-btn"
                                  disabled={archiveBusy}
                                  onClick={() => setDeleteAllStep(1)}
                                  style={{ color: 'var(--red, #e5484d)' }}
                                >
                                  Delete all
                                </button>
                              </div>
                              <div className="settings-archive-list" style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                                {archive.map((entry) => (
                                  <div
                                    key={entry.id}
                                    className="settings-archive-item"
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      justifyContent: 'space-between',
                                      gap: 12,
                                      padding: '8px 10px',
                                      background: 'var(--surface-2)',
                                      border: '1px solid var(--border)',
                                      borderRadius: 6,
                                      flexWrap: 'wrap',
                                    }}
                                  >
                                    <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                                      <div style={{ wordBreak: 'break-word', fontWeight: 500, fontSize: 13, color: 'var(--text-1)' }}>
                                        {entry.title}
                                      </div>
                                      <div style={{ display: 'flex', gap: 8, marginTop: 2, fontSize: 11, color: 'var(--text-3)' }}>
                                        <span>{formatBytes(entry.bytes)}</span>
                                        <span>·</span>
                                        <span>{new Date(entry.mtime).toLocaleDateString()}</span>
                                      </div>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                      <button
                                        type="button"
                                        className="modal-btn"
                                        disabled={archiveBusy}
                                        onClick={() => setRestoringEntry(entry)}
                                      >
                                        Restore
                                      </button>
                                      <button
                                        type="button"
                                        className="modal-btn"
                                        disabled={archiveBusy}
                                        onClick={() => setDeletingEntry(entry)}
                                        style={{ color: 'var(--red, #e5484d)' }}
                                      >
                                        Delete
                                      </button>
                                    </div>
                                  </div>
                                ))}
                              </div>
                              <div className="modal-hint">
                                Restoring keeps the conversation's original id and dates, so a chat that
                                is still older than the retention window becomes eligible for the next
                                nightly purge again — pin it if you want to keep it. The archive file is
                                left on disk, so restoring the same chat twice is refused. Delete removes
                                the archive file only — it does not change live chats.
                              </div>
                            </>
                          )}
                        </div>
                      )}

                      {/* Purge Now Confirm Modal */}
                      {showPurgeConfirm && (
                        <ConfirmDialog
                          title="Purge idle conversations"
                          danger
                          confirmLabel="Purge now"
                          body={(
                            <>
                              Archive and delete conversations idle longer than the retention window now?
                              <br /><br />
                              Pinned and live conversations are kept. Archived conversations can be restored below.
                            </>
                          )}
                          onCancel={() => setShowPurgeConfirm(false)}
                          onConfirm={() => void doPurgeNow()}
                        />
                      )}

                      {/* Restore Single Entry Confirm Modal */}
                      {restoringEntry && (
                        <ConfirmDialog
                          title="Restore conversation"
                          busy={restoring}
                          confirmLabel="Restore"
                          body={(
                            <>
                              Restore <strong>&ldquo;{restoringEntry.title}&rdquo;</strong> ({formatBytes(restoringEntry.bytes)}) into the live database?
                              <br /><br />
                              The archive file stays on disk. The conversation will be restored into {restoreTarget ? 'the selected project' : 'its original project'}.
                            </>
                          )}
                          onCancel={() => setRestoringEntry(null)}
                          onConfirm={() => void restoreArchived(restoringEntry)}
                        />
                      )}

                      {/* Delete Single Entry Confirm Modal */}
                      {deletingEntry && (
                        <ConfirmDialog
                          title="Delete archive file"
                          danger
                          busy={deleting}
                          confirmLabel="Delete"
                          body={(
                            <>
                              Permanently delete the archive file for <strong>&ldquo;{deletingEntry.title}&rdquo;</strong> ({formatBytes(deletingEntry.bytes)})?
                              <br /><br />
                              This removes the file from <code>data/archive</code>. Live conversations are not touched. This action cannot be undone.
                            </>
                          )}
                          onCancel={() => setDeletingEntry(null)}
                          onConfirm={() => void deleteArchived(deletingEntry)}
                        />
                      )}

                      {/* Delete All Archives Confirm Modal (Step 1) */}
                      {deleteAllStep === 1 && archive && (
                        <ConfirmDialog
                          title="Delete all archives"
                          danger
                          confirmLabel="Proceed…"
                          body={(
                            <>
                              Permanently remove all <strong>{archive.length} archive file{archive.length === 1 ? '' : 's'}</strong> from <code>data/archive</code>?
                              <br /><br />
                              Live conversations in the database are not touched. You will be asked to confirm one more time before files are removed.
                            </>
                          )}
                          onCancel={() => setDeleteAllStep(0)}
                          onConfirm={() => setDeleteAllStep(2)}
                        />
                      )}

                      {/* Delete All Archives Double Confirm Modal (Step 2) */}
                      {deleteAllStep === 2 && archive && (
                        <ConfirmDialog
                          title="Are you absolutely sure?"
                          danger
                          busy={deletingAll}
                          confirmLabel="Yes, delete all archives"
                          body={(
                            <>
                              <strong>Final warning:</strong> This will permanently delete <strong>{archive.length} archive file{archive.length === 1 ? '' : 's'}</strong>.
                              <br /><br />
                              Once deleted, these archived conversations cannot be restored.
                            </>
                          )}
                          onCancel={() => setDeleteAllStep(0)}
                          onConfirm={() => void deleteAllArchived()}
                        />
                      )}
                  </div>
                </div>
              </div>
              <div className="settings-section">
                <div className="settings-section-title">Database Backups</div>
                <div className="settings-card active">
                  <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div className="modal-field">
                      <div className="settings-input-group">
                        <button
                          type="button"
                          className="modal-btn"
                          disabled={backingUp}
                          onClick={() => { void runBackupNow(); }}
                        >
                          {backingUp ? 'Backing up…' : 'Back up now'}
                        </button>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-2)' }}>
                          <input
                            type="checkbox"
                            checked={includeAudio}
                            disabled={backingUp}
                            onChange={(e) => setIncludeAudio(e.target.checked)}
                          />
                          Include audio recordings
                        </label>
                      </div>
                      <div className="modal-hint">
                        {audioFiles > 0
                          ? `Adds ${audioFiles} recording${audioFiles === 1 ? '' : 's'} (${formatBytes(audioBytes)}) and produces an uncompressed .tar instead of a plain .db.`
                          : 'No audio recordings on disk — the backup will be a plain .db.'}
                      </div>
                      {backupStatus && <div className="modal-hint">{backupStatus}</div>}

                      {backups !== null && backups.length === 0 && (
                        <div className="modal-hint">
                          No backups yet. &ldquo;Back up now&rdquo; writes one to <code>data/backups</code>.
                        </div>
                      )}

                      {backups !== null && backups.length > 0 && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
                          {backups.map((entry) => (
                            <div
                              key={entry.name}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                gap: 12,
                                padding: '8px 10px',
                                background: 'var(--surface-2)',
                                border: '1px solid var(--border)',
                                borderRadius: 6,
                                flexWrap: 'wrap',
                              }}
                            >
                              <div style={{ flex: '1 1 200px', minWidth: 0 }}>
                                <div style={{ wordBreak: 'break-all', fontWeight: 500, fontSize: 13, color: 'var(--text-1)' }}>
                                  {entry.name}
                                </div>
                                <div style={{ display: 'flex', gap: 8, marginTop: 2, fontSize: 11, color: 'var(--text-3)' }}>
                                  <span>{entry.kind === 'full' ? 'Full' : 'DB'}</span>
                                  <span>·</span>
                                  <span>{formatBytes(entry.bytes)}</span>
                                  <span>·</span>
                                  <span>{new Date(entry.createdAt).toLocaleString()}</span>
                                </div>
                              </div>
                              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                                <button
                                  type="button"
                                  className="modal-btn"
                                  onClick={() => downloadBackup(entry)}
                                >
                                  Download
                                </button>
                                <button
                                  type="button"
                                  className="modal-btn"
                                  disabled={backupDeleting}
                                  onClick={() => setDeletingBackup(entry)}
                                  style={{ color: 'var(--red, #e5484d)' }}
                                >
                                  Delete
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}

                      <div className="modal-hint">
                        Backups are plain files in <code>data/backups</code>. The newest 10 are kept —
                        older ones are deleted automatically after each new backup. To restore: download
                        a <code>.db</code>, stop the server, and point <code>TIERWYN_DB</code> at it. A
                        Full backup is an uncompressed <code>.tar</code> holding the <code>.db</code>
                        plus the <code>tts-recordings</code> folder — extract it next to the database.
                      </div>

                      {deletingBackup && (
                        <ConfirmDialog
                          title="Delete backup"
                          danger
                          busy={backupDeleting}
                          confirmLabel="Delete"
                          body={(
                            <>
                              Permanently delete <strong>{deletingBackup.name}</strong> ({formatBytes(deletingBackup.bytes)})?
                              <br /><br />
                              This removes the file from <code>data/backups</code>. The live database is not touched.
                            </>
                          )}
                          onCancel={() => setDeletingBackup(null)}
                          onConfirm={() => void confirmDeleteBackup(deletingBackup)}
                        />
                      )}
                    </div>
                  </div>
                </div>
              </div>
              </>
            )}

            {/* ── Notifications ───────────────────────────────────── */}
            {tab === 'notifications' && <NotificationSettings />}

            {/* ── Schedules ───────────────────────────────────────── */}
            {tab === 'schedules' && general && (
              <>
                {generalError && (
                  <div style={{ color: 'var(--accent-danger, #ef4444)', fontSize: '12px', marginBottom: '12px', padding: '8px 12px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
                    {generalError}
                  </div>
                )}
                <div className="settings-section">
                  <div className="settings-section-title">Schedule jobs</div>
                  <div className="settings-card active">
                    <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      <div className="modal-field modal-field-row">
                        <div>
                          <span className="modal-label">Hide built-in schedule packs</span>
                          <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                            Shipped packs are not listed in the schedule Pack picker. Imported packs stay visible.
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={general.hideShippedSchedulePacks}
                          className={`toggle-switch${general.hideShippedSchedulePacks ? ' on' : ''}`}
                          onClick={() => { void saveGeneral({ hideShippedSchedulePacks: !general.hideShippedSchedulePacks }); }}
                          aria-label="Hide built-in schedule packs"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>

                      <div className="modal-field modal-field-row">
                        <div>
                          <span className="modal-label">Auto-archive completed one-shot schedules</span>
                          <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                            When an agent one-shot schedule finishes and calls complete-job, archive it immediately to free its project cap slot.
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={general.autoArchiveCompletedOneShots ?? true}
                          className={`toggle-switch${(general.autoArchiveCompletedOneShots ?? true) ? ' on' : ''}`}
                          onClick={() => { void saveGeneral({ autoArchiveCompletedOneShots: !(general.autoArchiveCompletedOneShots ?? true) }); }}
                          aria-label="Auto-archive completed one-shot schedules"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>

                      <div className="modal-field modal-field-row">
                        <div>
                          <span className="modal-label">Allow agent auto-scheduling</span>
                          <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                            When off, every schedule an agent creates (one-shot or recurring) is created disabled and never fires until you enable it. Your own schedules are unaffected.
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={general.allowAgentAutoScheduling ?? true}
                          className={`toggle-switch${(general.allowAgentAutoScheduling ?? true) ? ' on' : ''}`}
                          onClick={() => { void saveGeneral({ allowAgentAutoScheduling: !(general.allowAgentAutoScheduling ?? true) }); }}
                          aria-label="Allow agent auto-scheduling"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>

                      <div className="modal-field modal-field-row">
                        <div>
                          <span className="modal-label">Allow agent recurring schedules</span>
                          <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                            Allow agents to create recurring interval schedules that start firing automatically without operator approval.
                            {(general.allowAgentAutoScheduling ?? true) ? '' : ' Has no effect while agent auto-scheduling is off.'}
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          disabled={!(general.allowAgentAutoScheduling ?? true)}
                          aria-checked={general.allowAgentRecurringSchedules ?? false}
                          className={`toggle-switch${(general.allowAgentRecurringSchedules ?? false) ? ' on' : ''}`}
                          onClick={() => {
                            if (general.allowAgentRecurringSchedules) {
                              void saveGeneral({ allowAgentRecurringSchedules: false });
                            } else {
                              setShowRecurringConsentModal(true);
                            }
                          }}
                          aria-label="Allow agent recurring schedules"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="settings-section">
                  <div className="settings-section-title">Role auto-matching</div>
                  <div className="settings-card active">
                    <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                      <span className="modal-hint">
                        When a pack is applied, each pipeline stage is assigned the template delegate whose <em>use when</em> text best matches these keywords
                        (&quot;primary&quot; preferred, &quot;secondary&quot; de-prioritised). Change the result per job in its Variables tab.
                      </span>
                      <RoleMatchKeywordsEditor
                        value={general.roleMatchKeywords ?? {}}
                        onChange={(v) => { void saveGeneral({ roleMatchKeywords: v }); }}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}

            {/* ── Voice ─────────────────────────────────────────────── */}
            {tab === 'voice' && (
              <div className="settings-section">
                <div className="settings-section-title">Voice & Audio Settings</div>
                
                <div className="settings-card active">
                  <div className="settings-card-body">
                    <div className="settings-grid-2">
                      <div className="modal-field">
                        <span className="modal-label">Voice dictation engine (speech&nbsp;→&nbsp;text)</span>
                        <SelectDropdown
                          options={sttEngineOptions}
                          value={sttEngine}
                          onChange={(val) => { setSttEngine(val); setSttEngineState(val); }}
                          placement="bottom"
                        />
                      </div>

                      <div className="modal-field">
                        <span className="modal-label">Wave colour style</span>
                        <SelectDropdown
                          options={waveStyleOptions}
                          value={waveStyle}
                          onChange={(val) => { setWaveStyle(val); setWaveStyleState(val); }}
                          placement="bottom"
                        />
                      </div>

                      <div className="modal-field">
                        <span className="modal-label">Voice detection visual</span>
                        <SelectDropdown
                          options={voiceDetectionVisualOptions}
                          value={detectionVisual}
                          onChange={(val) => { setVoiceDetectionVisual(val); setDetectionVisualState(val); }}
                          placement="bottom"
                        />
                        <span className="modal-hint">Shown while recording — reacts to microphone input.</span>
                      </div>

                      <div className="modal-field">
                        <span className="modal-label">Voice processing visual</span>
                        <SelectDropdown
                          options={voiceProcessingVisualOptions}
                          value={processingVisual}
                          onChange={(val) => { setVoiceProcessingVisual(val); setProcessingVisualState(val); }}
                          placement="bottom"
                        />
                        <span className="modal-hint">Shown while transcribing — predetermined motion.</span>
                      </div>
                    </div>
                  </div>
                </div>

                {whisperCfg && !whisperCfg.binaryFound && (
                  <div className="voice-warning-chip" style={{ display: 'flex', alignItems: 'center' }}>
                    <svg className="chip-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: 8, flexShrink: 0 }}>
                      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
                      <line x1="12" x2="12" y1="9" y2="13"/>
                      <line x1="12" x2="12.01" y1="17" y2="17"/>
                    </svg>
                    <span>
                      whisper-cli not found on the server — set <code>WHISPER_BIN_PATH</code> or install whisper.cpp to <code>~/.local/share/mewisper/bin/whisper-cli</code>.
                    </span>
                  </div>
                )}

                {sttEngine === 'whisper' && (
                  <div className="settings-card active">
                    <div className="settings-card-header">
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent)' }}>
                          <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                          <line x1="12" x2="12" y1="19" y2="22"/>
                        </svg>
                        <span className="settings-card-title">Local Whisper Engine Settings</span>
                      </div>
                    </div>
                    
                    <div className="settings-card-body">
                      <div className="modal-field">
                        <span className="modal-label">Selected Whisper model</span>
                        <SelectDropdown
                          options={whisperModelOptions}
                          value={whisperModel}
                          onChange={(val) => { setWhisperModel(val); setWhisperModelState(val); }}
                          placement="bottom"
                        />
                      </div>

                      <div className="whisper-models-container">
                        <div className="whisper-models-header">Model files status</div>
                        <div className="whisper-models-grid">
                          {whisperCfg && whisperCfg.models.map((m) => {
                            const isDownloading = download && download.model === m.id && !download.done;
                            return (
                              <div className={`whisper-model-card${m.available ? ' available' : ''}${isDownloading ? ' downloading' : ''}`} key={m.id}>
                                <div className="whisper-model-info">
                                  <span className="whisper-model-name">ggml-{m.id}.bin</span>
                                  <span className="whisper-model-status">
                                    {m.available && m.sizeBytes !== null
                                      ? `Available (${(m.sizeBytes / 1024 / 1024).toFixed(0)} MB)`
                                      : 'Not downloaded'}
                                  </span>
                                </div>
                                {!m.available && (
                                  <button
                                    type="button"
                                    className="modal-btn whisper-download-btn"
                                    disabled={!!download && !download.done}
                                    onClick={() => startDownload(m.id)}
                                  >
                                    {isDownloading ? 'Downloading…' : 'Download'}
                                  </button>
                                )}
                                {m.available && (
                                  <div className="whisper-model-check" title="Available">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                                      <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                  </div>
                                )}
                                {isDownloading && download && download.total > 0 && (
                                  <div className="whisper-card-progress">
                                    <div className="voice-progress-bar">
                                      <div className="voice-progress-fill" style={{ width: `${Math.min(100, download.pct)}%` }} />
                                    </div>
                                    <div className="whisper-progress-text">
                                      {download.pct.toFixed(1)}% of {(download.total / 1024 / 1024).toFixed(0)} MB
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                      
                      {download && download.done && download.error && (
                        <div className="voice-warning-chip" style={{ marginTop: 12 }}>
                          Download failed: {download.error}
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {voice && (
                  <div className={`settings-card${voice.tts.enabled ? ' active' : ''}`}>
                    <div className="settings-card-header">
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: voice.tts.enabled ? 'var(--accent)' : 'var(--text-3)' }}>
                          <path d="M11 5 6 9H2v6h4l5 4V5z"/>
                          <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/>
                        </svg>
                        <span className="settings-card-title">Read aloud (text → speech)</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={voice.tts.enabled}
                        className={`toggle-switch${voice.tts.enabled ? ' on' : ''}`}
                        onClick={() => saveVoice({ tts: { enabled: !voice.tts.enabled } })}
                        aria-label="Toggle read aloud"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>

                    <div className="settings-card-body" style={voice.tts.enabled ? undefined : disabled}>
                      <div className="modal-field">
                        <span className="modal-label">TTS provider</span>
                        <SelectDropdown<TtsProvider>
                          options={ttsProviderOptions}
                          value={voice.tts.provider}
                          onChange={(provider) => {
                            setVoice((v) => v ? { ...v, tts: { ...v.tts, provider } } : v);
                            saveVoice({ tts: { provider } });
                          }}
                          placement="bottom"
                        />
                      </div>

                      {(voice.tts.provider === 'piper' || voice.tts.provider === 'browser') && (
                        <div className="settings-grid-2">
                          <div className="modal-field">
                            <span className="modal-label">Piper URL</span>
                            <input
                              type="text"
                              className="modal-input"
                              value={voice.tts.piperUrl}
                              onChange={(e) => setVoice((v) => v ? { ...v, tts: { ...v.tts, piperUrl: e.target.value } } : v)}
                              onBlur={(e) => saveVoice({ tts: { piperUrl: e.target.value } })}
                              placeholder="http://127.0.0.1:5000"
                            />
                          </div>
                          <div className="modal-field">
                            <span className="modal-label">Piper voice</span>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                              <div style={{ flex: 1, minWidth: 180 }}>
                                <SelectDropdown
                                  searchable
                                  options={installedVoiceOptions}
                                  value={voice.tts.piperVoice}
                                  onChange={(v) => saveVoice({ tts: { piperVoice: v } })}
                                  placement="bottom"
                                />
                              </div>
                              <button
                                type="button"
                                className="modal-btn primary"
                                onClick={() => setPiperModalOpen(true)}
                              >
                                Download more voices…
                              </button>
                            </div>
                          </div>
                        </div>
                      )}

                      {(voice.tts.provider === 'kokoro' || voice.tts.provider === 'browser') && (
                        <div className="settings-grid-2">
                          <div className="modal-field">
                            <span className="modal-label">Kokoro URL</span>
                            <input
                              type="text"
                              className="modal-input"
                              value={voice.tts.kokoroUrl}
                              onChange={(e) => setVoice((v) => v ? { ...v, tts: { ...v.tts, kokoroUrl: e.target.value } } : v)}
                              onBlur={(e) => saveVoice({ tts: { kokoroUrl: e.target.value } })}
                              placeholder="http://127.0.0.1:8880"
                            />
                          </div>
                          <div className="modal-field">
                            <span className="modal-label">Kokoro voice</span>
                            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', flexWrap: 'wrap' }}>
                              <div style={{ flex: 1, minWidth: 180 }}>
                                <SelectDropdown
                                  searchable
                                  options={kokoroVoiceOptions}
                                  value={voice.tts.kokoroVoice || 'af_heart'}
                                  onChange={(v) => saveVoice({ tts: { kokoroVoice: v } })}
                                  placement="bottom"
                                />
                              </div>
                              <button
                                type="button"
                                className="modal-btn"
                                onClick={() => refreshKokoroVoices()}
                                title="Re-fetch voices from the Kokoro sidecar"
                              >
                                Refresh list
                              </button>
                            </div>
                            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                              {kokoroVoicesError
                                ? `Could not list voices (${kokoroVoicesError}). Is the Kokoro sidecar running?`
                                : kokoroVoices.length > 0
                                  ? `${kokoroVoices.length} voices from sidecar (baked into the Docker image).`
                                  : 'Voices load from Kokoro when the sidecar is up.'}
                            </div>
                          </div>
                        </div>
                      )}
                      {/* ponytail: catalogue downloader in PiperVoiceModal — installed set is ~/piper-voices/*.onnx. */}

                      <div className="modal-field" style={{ marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                        <div>
                          <span className="modal-label">Save Piper/Kokoro recordings</span>
                          <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>
                            Store WAVs per conversation (options → Recordings). Browser TTS is never saved.
                            Close-browser recovery (reopen and see a finished job) needs this on — off keeps
                            playback only for ~10 minutes and hides the row from the library.
                          </div>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={voice.tts.saveRecordings !== false}
                          className={`toggle-switch${voice.tts.saveRecordings !== false ? ' on' : ''}`}
                          onClick={() => saveVoice({ tts: { saveRecordings: !(voice.tts.saveRecordings !== false) } })}
                          aria-label="Toggle save TTS recordings"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>

                      <span className="modal-hint" style={{ display: 'block', marginTop: 12 }}>
                        System prompt and LLM connection are configured in Settings → Sidecar LLMs.
                      </span>
                    </div>
                  </div>
                )}

                {piperModalOpen && voice && (
                  <PiperVoiceModal
                    onClose={() => setPiperModalOpen(false)}
                    onVoiceSelected={(id) => saveVoice({ tts: { piperVoice: id } })}
                    onDownloaded={() => { refreshPiperVoices(); }}
                  />
                )}

                {voice && (
                  <div className={`settings-card${voice.cleanup.enabled ? ' active' : ''}`}>
                    <div className="settings-card-header">
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: voice.cleanup.enabled ? 'var(--accent)' : 'var(--text-3)' }}>
                          <path d="m12 3-1.912 5.886L4.202 9l5.886 1.912L12 16.8l1.912-5.888 5.886-1.912-5.886-1.912Z"/>
                          <path d="m5 3 1 2.5L8.5 6 6 7 5 9.5 4 7 1.5 6 4 5.5Z"/>
                          <path d="m19 17 1 2.5 2.5.5-2.5 1-1 2.5-1-2.5-2.5-1 2.5-1Z"/>
                        </svg>
                        <span className="settings-card-title">Transcript cleanup (dictation)</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={voice.cleanup.enabled}
                        className={`toggle-switch${voice.cleanup.enabled ? ' on' : ''}`}
                        onClick={() => saveVoice({ cleanup: { ...voice.cleanup, enabled: !voice.cleanup.enabled } })}
                        aria-label="Toggle Transcript Cleanup"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>

                    <div className="settings-card-body" style={voice.cleanup.enabled ? undefined : disabled}>
                      <span className="modal-hint" style={{ display: 'block', marginBottom: 12 }}>
                        System prompt and LLM connection are configured in Settings → Sidecar LLMs.
                      </span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Sidecar LLMs ─────────────────────────────────────── */}
            {tab === 'directLlm' && (
              <div className="settings-section">
                <div className="settings-section-title">Sidecar LLMs</div>
                <span className="modal-hint" style={{ display: 'block', marginBottom: 12 }}>
                  Sidecar jobs are the small non-conversational LLM tasks below. Each job routes to a direct LLM connection or to an agent one-shot. Direct LLM profiles are the direct connections.
                </span>

                <div className="settings-card active">
                    <div className="settings-card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent)' }}>
                          <rect x="4" y="4" width="16" height="16" rx="2"/>
                          <path d="M9 9h6M9 12h6M9 15h4"/>
                        </svg>
                        <span className="settings-card-title">Direct LLM profiles</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                        {directProfiles.length > 0 && selected && (
                          <SelectDropdown<string>
                            options={directProfiles.map((p) => ({
                              value: p.id,
                              label: `${p.configured ? '●' : '○'} ${p.label}`,
                            }))}
                            value={selected.id}
                            onChange={(id) => {
                              setSelectedProfileId(id);
                              setProfileRev((r) => r + 1);
                              setProfileTest(null);
                              setConfirmDelete(false);
                            }}
                            placement="bottom"
                          />
                        )}
                        <button
                          type="button"
                          className="modal-btn"
                          disabled={profileBusy}
                          onClick={() => { void createProfile(); }}
                        >
                          + New connection
                        </button>
                        {profileLabelError._create && (
                          <span className="voice-warning-chip" style={{ padding: '2px 8px', fontSize: 11 }}>
                            {profileLabelError._create}
                          </span>
                        )}
                        <button
                          type="button"
                          className="modal-btn"
                          disabled={profileBusy || !selected}
                          title="Delete this profile"
                          onClick={() => setConfirmDelete(true)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                    <div className="settings-card-body">
                      {noProfiles ? (
                        <span className="modal-hint" style={{ display: 'block' }}>
                          No Direct LLM profiles configured. Click “+ New connection” to create one.
                        </span>
                      ) : selected ? (
                      <>
                      {confirmDelete && (
                        <div className="modal-field" style={{ marginBottom: 12 }}>
                          <span className="modal-hint" style={{ display: 'block', marginBottom: 8 }}>
                            Delete "{selected.label}"?
                            {directProfiles.length === 1
                              ? ' This is the last profile — every sidecar job on the Direct backend will be turned off until you create a new one.'
                              : sitesUsingProfile(selected.id).length > 0
                                ? ` ${sitesUsingProfile(selected.id).join(' and ')} will be repointed to the first remaining profile.`
                                : ' This profile is not used by any sidecar job.'}
                          </span>
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button type="button" className="modal-btn" disabled={profileBusy} onClick={() => { void deleteSelectedProfile(); }}>
                              Delete
                            </button>
                            <button type="button" className="modal-btn" disabled={profileBusy} onClick={() => setConfirmDelete(false)}>
                              Cancel
                            </button>
                          </div>
                        </div>
                      )}
                      <div key={`${selected.id}:${profileRev}`}>
                        <div className="modal-field">
                          <span className="modal-label" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <span>Profile label</span>
                            {profileLabelError[selected.id] && (
                              <span className="voice-warning-chip" style={{ padding: '2px 8px', fontSize: 11 }}>
                                Not saved — {profileLabelError[selected.id]}
                              </span>
                            )}
                          </span>
                          <input
                            type="text"
                            className="modal-input"
                            defaultValue={selected.label}
                            onBlur={(e) => { void saveProfile({ label: e.target.value }); }}
                            placeholder={DIRECT_LLM_DEFAULT_LABELS[selected.id] ?? 'New connection'}
                          />
                        </div>
                        <div className="modal-field">
                          <span className="modal-label">Provider preset</span>
                          <SelectDropdown<VoiceCleanupProvider>
                            options={VOICE_PROVIDER_OPTIONS}
                            value={selected.provider}
                            onChange={(provider) => {
                              const target = voiceProviderValuesFor(selected as unknown as VoiceSettings['cleanup'], provider);
                              void saveProfile({
                                provider,
                                baseUrl: target.baseUrl,
                                model: target.model,
                                apiKey: target.apiKey,
                              }).then(() => setProfileRev((r) => r + 1));
                            }}
                            placement="bottom"
                          />
                          <span className="modal-hint">Each provider remembers its own URL, model, and API key.</span>
                        </div>
                        <div className="settings-grid-2">
                          <div className="modal-field">
                            <span className="modal-label">Base URL</span>
                            <input
                              type="text"
                              className="modal-input"
                              defaultValue={selected.baseUrl}
                              onBlur={(e) => { void saveProfile({ baseUrl: e.target.value }); }}
                              placeholder="http://localhost:1234/v1"
                            />
                          </div>
                          <div className="modal-field">
                            <span className="modal-label">Timeout & Test</span>
                            <div className="settings-input-group">
                              <input
                                type="number"
                                min={1}
                                max={120}
                                className="modal-input timeout-input"
                                style={{ width: 80 }}
                                defaultValue={selected.timeoutSecs}
                                onBlur={(e) => {
                                  void saveProfile({ timeoutSecs: Math.max(1, Number(e.target.value) || 60) });
                                }}
                              />
                              <span className="settings-input-unit">sec</span>
                              <button
                                type="button"
                                className="modal-btn test-conn-btn"
                                disabled={profileTesting}
                                onClick={() => {
                                  void (async () => {
                                    setProfileTest(null);
                                    setProfileTesting(true);
                                    try {
                                      await pendingProfileSave.current;
                                      setProfileTest(await api.testDirectLlmProfile(selected.id));
                                    } catch (err) {
                                      if (err instanceof UnauthorizedError) throw err;
                                      setProfileTest({ ok: false, error: err instanceof Error ? err.message : String(err) });
                                    } finally {
                                      setProfileTesting(false);
                                    }
                                  })();
                                }}
                              >
                                Test
                              </button>
                            </div>
                          </div>
                          <div className="modal-field">
                            <span className="modal-label">Model</span>
                            <input
                              type="text"
                              className="modal-input"
                              defaultValue={selected.model}
                              onBlur={(e) => { void saveProfile({ model: e.target.value }); }}
                              placeholder="e.g. gemma-3-4b-it"
                            />
                          </div>
                          <div className="modal-field">
                            <span className="modal-label">API key (optional)</span>
                            <input
                              type="password"
                              className="modal-input"
                              defaultValue={selected.apiKey}
                              onBlur={(e) => { void saveProfile({ apiKey: e.target.value }); }}
                              placeholder="lm studio leaves this blank"
                            />
                          </div>
                        </div>
                      </div>
                      <span className="modal-hint" style={{ display: 'block', marginTop: 10 }}>
                        {sitesUsingProfile(selected.id).length > 0
                          ? `Used by: ${sitesUsingProfile(selected.id).join(', ')}`
                          : 'Not used by any sidecar job.'}
                      </span>
                      {profileTesting && (
                        <div className="settings-test-result" style={{ marginTop: 12 }}>
                          <div className="voice-warning-chip" style={{ display: 'flex', alignItems: 'center' }}>
                            <span className="test-status-dot" style={{
                              width: 6, height: 6, borderRadius: '50%', background: 'currentColor', marginRight: 8,
                            }} />
                            <span>Testing…</span>
                          </div>
                        </div>
                      )}
                      {profileTest && !profileTesting && (
                        <div className="settings-test-result" style={{ marginTop: 12 }}>
                          <div className={`voice-warning-chip${profileTest.ok && !profileTest.error ? ' ok' : ''}`} style={{ display: 'flex', alignItems: 'center' }}>
                            <span className="test-status-dot" style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              background: 'currentColor',
                              marginRight: 8,
                              boxShadow: profileTest.ok && !profileTest.error ? '0 0 6px var(--accent)' : '0 0 6px var(--amber)'
                            }} />
                            <span>
                              {profileTest.ok && !profileTest.error
                                ? `${profileTest.reply ?? 'OK'}${profileTest.latencyMs != null ? ` · ${profileTest.latencyMs} ms` : ''}`
                                : profileTest.error ?? 'Test failed'}
                            </span>
                          </div>
                        </div>
                      )}
                      </>
                      ) : null}
                    </div>
                  </div>

                {sidecar && (
                  <div className="settings-card active">
                    <div className="settings-card-header">
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: 'var(--accent)' }}>
                          <circle cx="12" cy="12" r="3"/>
                          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
                        </svg>
                        <span className="settings-card-title">Sidecar job routing</span>
                      </div>
                    </div>
                    <div className="settings-card-body sidecar-routing-body">
                      <span className="modal-hint" style={{ display: 'block' }}>
                        Each row picks a direct LLM profile, an agent one-shot with no tools, or an agent restricted to reading files. Incomplete agent rows persist but the job stays off until adapter and model are set. A job with its switch off keeps its configuration but never runs.
                      </span>
                      {SIDECAR_SITE_ROWS.map(({ site, label, blurb }) => {
                        const route = sidecar[site];
                        const agentRow = isSidecarAgentBackend(route.backend);
                        const eligible = sidecarAdapters.filter((a) =>
                          route.backend === 'agent_readonly' ? a.supportsReadOnly : a.supportsToolsOff);
                        const adapterOpts: SelectDropdownOption<string>[] = eligible.length > 0
                          ? eligible.map((a) => ({ value: a.type, label: a.label }))
                          : [{ value: '', label: 'No adapter supports this mode' }];
                        if (eligible.length > 0 && !route.adapter) {
                          adapterOpts.unshift({ value: '', label: 'Select adapter' });
                        }
                        const modelOpts = sidecarModelOptions(route.adapter, route.model);
                        const chip = sidecarRowChip(site);
                        const profileOpts: SelectDropdownOption<string>[] =
                          directProfiles.length > 0
                            ? directProfiles.map((p) => ({
                              value: p.id,
                              label: `${p.label}${p.configured ? '' : ' · not configured'}`,
                            }))
                            : [{ value: '', label: noProfiles ? 'No profiles available' : 'Loading…' }];
                        const adapterHint = route.backend === 'agent_readonly'
                          ? 'Which agent binary runs the one-shot. Only adapters that can prove write and shell tools are unavailable appear here.'
                          : 'Which agent binary runs the one-shot. Only adapters that can run headless with all tools disabled appear here.';
                        return (
                          <div key={site} className={`settings-card${route.enabled !== false ? ' active' : ''}`}>
                            <div className="settings-card-header" style={{ flexWrap: 'wrap', gap: 8 }}>
                              <div className="settings-card-title-group" style={{ flexWrap: 'wrap', rowGap: 6 }}>
                                <span className="settings-card-title">{label}</span>
                                {route.backend === 'agent_readonly' && eligible.length === 0 && (
                                  <span className="voice-warning-chip" style={{ padding: '2px 8px', fontSize: 11 }}>
                                    No adapter supports read-only one-shot
                                  </span>
                                )}
                              </div>
                              <div className="sidecar-header-actions">
                                {chip && (
                                  <span
                                    className={`voice-warning-chip${chip.amber ? '' : ' ok'}`}
                                    style={{ padding: '2px 8px', fontSize: 11 }}
                                  >
                                    {chip.text}
                                  </span>
                                )}
                                <button
                                  type="button"
                                  role="switch"
                                  aria-checked={route.enabled !== false}
                                  aria-label={`Toggle ${label}`}
                                  className={`toggle-switch${route.enabled !== false ? ' on' : ''}`}
                                  onClick={() => persistSidecarSite(site, { ...route, enabled: route.enabled === false })}
                                >
                                  <span className="toggle-knob" />
                                </button>
                              </div>
                            </div>
                            <div className="settings-card-body sidecar-site-body" style={route.enabled === false ? disabledLook : undefined}>
                              <span className="modal-hint" style={{ display: 'block' }}>{blurb}</span>
                              {site === 'enhance' && agentRow && (
                                <span className="modal-hint" style={{ display: 'block' }}>{ENHANCE_PROJECT_AGENT_HINT}</span>
                              )}
                              <div className="sidecar-site-group">
                                <div
                                  className={`sidecar-site-grid${agentRow ? ' sidecar-site-grid--agent' : ''}`}
                                >
                                  <div className="modal-field">
                                    <span className="modal-label">Backend</span>
                                    <SelectDropdown<SidecarBackend>
                                      options={
                                        SIDECAR_SITES_WITH_CWD.includes(site)
                                          ? SIDECAR_BACKEND_OPTIONS
                                          : SIDECAR_BACKEND_OPTIONS.filter((o) => o.value !== 'agent_readonly')
                                      }
                                      value={route.backend}
                                      onChange={(backend) => {
                                        const keep = !isSidecarAgentBackend(backend) ? undefined
                                          : sidecarAdapters.find((a) => a.type === route.adapter
                                              && (backend === 'agent_readonly' ? a.supportsReadOnly : a.supportsToolsOff));
                                        persistSidecarSite(site, keep
                                          ? { ...route, backend }
                                          : { ...route, backend, adapter: undefined, model: undefined });
                                      }}
                                      placement="bottom"
                                      disabled={route.enabled === false}
                                    />
                                    <span className="modal-hint">{sidecarBackendHint(route.backend)}</span>
                                  </div>
                                  {route.backend === 'direct' && (
                                    <div className="modal-field">
                                      <span className="modal-label">Profile</span>
                                      <SelectDropdown<string>
                                        options={profileOpts}
                                        value={directProfiles.length > 0 ? (route.profile ?? SIDECAR_SITE_DEFAULT_PROFILE[site]) : ''}
                                        onChange={(profile) => persistSidecarSite(site, { ...route, backend: 'direct', profile })}
                                        placement="bottom"
                                        disabled={route.enabled === false || directProfiles.length === 0}
                                      />
                                      <span className="modal-hint">Which Direct LLM connection this job calls.</span>
                                    </div>
                                  )}
                                  {site === 'enhance' && route.backend === 'direct' && (() => {
                                    const roAdapters = sidecarAdapters.filter((a) => a.supportsReadOnly);
                                    const projAdapterOpts: SelectDropdownOption<string>[] = [
                                      { value: '', label: roAdapters.length > 0 ? 'None' : 'No adapter supports read-only one-shot' },
                                      ...roAdapters.map((a) => ({ value: a.type, label: a.label })),
                                    ];
                                    const projModelOpts = sidecarModelOptions(route.projectAdapter, route.projectModel);
                                    return (
                                      <>
                                        <div className="modal-field">
                                          <span className="modal-label">Adapter for project reads</span>
                                          <SelectDropdown<string>
                                            options={projAdapterOpts}
                                            value={route.projectAdapter ?? ''}
                                            // '' (not undefined) so the key survives JSON and the server clears it
                                            onChange={(projectAdapter) => persistSidecarSite(site, { ...route, projectAdapter, projectModel: '' })}
                                            placement="bottom"
                                            disabled={route.enabled === false || roAdapters.length === 0}
                                          />
                                          <span className="modal-hint">{ENHANCE_PROJECT_DIRECT_HINT}</span>
                                        </div>
                                        <div className="modal-field">
                                          <span className="modal-label">Model for project reads</span>
                                          {projModelOpts.length === 0 ? (
                                            <input
                                              type="text"
                                              className="modal-input"
                                              key={route.projectAdapter ?? ''}
                                              defaultValue={route.projectModel ?? ''}
                                              disabled={route.enabled === false || !route.projectAdapter}
                                              onBlur={(e) => {
                                                const v = e.target.value.trim();
                                                if (v !== (route.projectModel ?? '')) persistSidecarSite(site, { ...route, projectModel: v });
                                              }}
                                            />
                                          ) : (
                                            <SelectDropdown<string>
                                              options={projModelOpts}
                                              value={route.projectModel ?? ''}
                                              onChange={(projectModel) => persistSidecarSite(site, { ...route, projectModel })}
                                              placement="bottom"
                                              disabled={route.enabled === false || !route.projectAdapter}
                                            />
                                          )}
                                        </div>
                                      </>
                                    );
                                  })()}
                                  {agentRow && (
                                    <>
                                      <div className="modal-field">
                                        <span className="modal-label">Adapter</span>
                                        <SelectDropdown<string>
                                          options={adapterOpts}
                                          value={route.adapter ?? ''}
                                          onChange={(adapter) => persistSidecarSite(site, { ...route, adapter, model: undefined })}
                                          placement="bottom"
                                          disabled={route.enabled === false || eligible.length === 0}
                                        />
                                        <span className="modal-hint">{adapterHint}</span>
                                      </div>
                                      <div className="modal-field">
                                        <span className="modal-label">Model</span>
                                        {modelOpts.length === 0 ? (
                                          <input
                                            type="text"
                                            className="modal-input"
                                            value={route.model ?? ''}
                                            onChange={(e) => persistSidecarModelDebounced(site, e.target.value)}
                                            onBlur={(e) => {
                                              if (modelDebounce.current[site]) {
                                                clearTimeout(modelDebounce.current[site]);
                                                modelDebounce.current[site] = undefined;
                                              }
                                              const current = sidecarRef.current?.[site];
                                              if (!current || !isSidecarAgentBackend(current.backend)) return;
                                              persistSidecarSite(site, { ...current, adapter: current.adapter, model: e.target.value });
                                            }}
                                            placeholder="model id"
                                            disabled={route.enabled === false}
                                          />
                                        ) : (
                                          <SelectDropdown<string>
                                            options={modelOpts}
                                            value={route.model ?? ''}
                                            onChange={(model) => persistSidecarSite(site, { ...route, adapter: route.adapter, model })}
                                            placement="bottom"
                                            disabled={route.enabled === false}
                                          />
                                        )}
                                        <span className="modal-hint">Which model that adapter should use for this job.</span>
                                      </div>
                                    </>
                                  )}
                                </div>
                              </div>
                              <div className="sidecar-site-group">
                                <div className="sidecar-site-grid">
                                  <div className="modal-field">
                                    <span className="modal-label">Timeout</span>
                                    <div className="settings-input-group">
                                      <input
                                        type="number"
                                        inputMode="numeric"
                                        className="modal-input timeout-input"
                                        style={{ width: 80 }}
                                        min={SIDECAR_TIMEOUT_MIN}
                                        max={SIDECAR_TIMEOUT_MAX}
                                        key={route.timeoutSecs ?? 'default'}
                                        defaultValue={route.timeoutSecs ?? ''}
                                        placeholder={String(DEFAULT_SIDECAR_TIMEOUTS[site])}
                                        disabled={route.enabled === false}
                                        onBlur={(e) => commitTimeout(site, e.target.value)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                        aria-label={`${label} timeout in seconds`}
                                      />
                                      <span className="settings-input-unit">sec</span>
                                    </div>
                                    <span className="modal-hint">
                                      {sidecarTimeoutHint(site)}
                                    </span>
                                  </div>
                                  <div className="modal-field">
                                    <span className="modal-label">Max input</span>
                                    <div className="settings-input-group">
                                      <input
                                        type="number"
                                        inputMode="numeric"
                                        className="modal-input timeout-input"
                                        style={{ width: 96 }}
                                        min={SIDECAR_MAX_INPUT_CHARS_MIN}
                                        max={SIDECAR_MAX_INPUT_CHARS_MAX}
                                        key={route.maxInputChars ?? 'default'}
                                        defaultValue={route.maxInputChars ?? ''}
                                        placeholder={String(DEFAULT_SIDECAR_MAX_INPUT_CHARS[site])}
                                        disabled={route.enabled === false}
                                        onBlur={(e) => commitMaxInputChars(site, e.target.value, e.currentTarget)}
                                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                                        aria-label={`${label} max input characters`}
                                      />
                                      <span className="settings-input-unit">chars</span>
                                    </div>
                                    <span className="modal-hint">
                                      {sidecarMaxInputHint(site)}
                                    </span>
                                  </div>
                                </div>
                              </div>
                              {site === 'enhance' && (
                                <div className="sidecar-site-actions">
                                  <div className="modal-field">
                                    <button
                                      type="button"
                                      className="modal-btn test-conn-btn"
                                      disabled={route.enabled === false}
                                      onClick={() => { void runEnhanceTest(); }}
                                    >
                                      Test
                                    </button>
                                    <span className="modal-hint" style={{ display: 'block' }}>
                                      Exercises the enhance sidecar route (direct profile or agent one-shot).
                                    </span>
                                    {enhanceTest && (
                                      <div className="settings-test-result" style={{ marginTop: 12 }}>
                                        <div className={`voice-warning-chip${enhanceTest.ok && !enhanceTest.error ? ' ok' : ''}`} style={{ display: 'flex', alignItems: 'center' }}>
                                          <span className="test-status-dot" style={{
                                            width: 6,
                                            height: 6,
                                            borderRadius: '50%',
                                            background: 'currentColor',
                                            marginRight: 8,
                                            boxShadow: enhanceTest.ok && !enhanceTest.error ? '0 0 6px var(--accent)' : '0 0 6px var(--amber)'
                                          }} />
                                          <span>
                                            {enhanceTest.ok && !enhanceTest.error
                                              ? enhanceTest.reply
                                              : enhanceTest.error ?? 'Test failed'}
                                          </span>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                </div>
                              )}
                              {site === 'btw' && (
                                <div className="sidecar-site-group">
                                  <span className="modal-label">Context priming</span>
                                  <BtwSettings
                                    profiles={profiles}
                                    profilesLoaded={agentProfilesLoaded}
                                    disabled={route.enabled === false}
                                  />
                                </div>
                              )}
                              <div className="sidecar-site-prompts">
                                <SidecarPromptManager
                                  collapsible
                                  disabled={route.enabled === false}
                                  builtins={SIDECAR_BUILTIN_PROMPTS[site]}
                                  prompts={route.prompts ?? []}
                                  selectedPromptId={route.selectedPromptId ?? SIDECAR_BUILTIN_PROMPTS[site][0]!.id}
                                  label={site === 'enhance' ? 'Quick enhance prompt' : 'Prompt instructions'}
                                  onChange={(patch) => persistSidecarSite(site, { ...route, ...patch })}
                                />
                                <span className="modal-hint">
                                  {sidecarPromptHint(site === 'enhance' ? 'enhance-quick' : 'default')}
                                </span>
                                {site === 'enhance' && (
                                  <>
                                  <SidecarPromptManager
                                    collapsible
                                    disabled={route.enabled === false}
                                    builtins={SIDECAR_BUILTIN_CONTEXT_PROMPTS}
                                    prompts={route.contextPrompts ?? []}
                                    selectedPromptId={route.contextSelectedPromptId ?? SIDECAR_BUILTIN_CONTEXT_PROMPTS[0]!.id}
                                    label="Context-aware enhance prompt"
                                    onChange={(patch) => persistSidecarSite(site, {
                                      ...route,
                                      ...(patch.prompts !== undefined ? { contextPrompts: patch.prompts } : {}),
                                      ...(patch.selectedPromptId !== undefined ? { contextSelectedPromptId: patch.selectedPromptId } : {}),
                                    })}
                                  />
                                  <span className="modal-hint">{sidecarPromptHint('enhance-context')}</span>
                                  <SidecarPromptManager
                                    collapsible
                                    disabled={route.enabled === false}
                                    builtins={BUILTIN_ENHANCE_PROJECT_PROMPTS}
                                    prompts={route.projectPrompts ?? []}
                                    selectedPromptId={route.projectSelectedPromptId ?? BUILTIN_ENHANCE_PROJECT_PROMPTS[0]!.id}
                                    label="Project-reads enhance prompt"
                                    onChange={(patch) => persistSidecarSite(site, {
                                      ...route,
                                      ...(patch.prompts !== undefined ? { projectPrompts: patch.prompts } : {}),
                                      ...(patch.selectedPromptId !== undefined ? { projectSelectedPromptId: patch.selectedPromptId } : {}),
                                    })}
                                  />
                                  <span className="modal-hint">{sidecarPromptHint('enhance-project')}</span>
                                  </>
                                )}
                                {site === 'tts' && (
                                  <>
                                    <SidecarPromptManager
                                      collapsible
                                      disabled={route.enabled === false}
                                      builtins={SIDECAR_BUILTIN_TTS_CODE_PROMPTS}
                                      prompts={route.codePrompts ?? []}
                                      selectedPromptId={route.codeSelectedPromptId ?? SIDECAR_BUILTIN_TTS_CODE_PROMPTS[0]!.id}
                                      label="Code-file summarize prompt"
                                      onChange={(patch) => persistSidecarSite(site, {
                                        ...route,
                                        ...(patch.prompts !== undefined ? { codePrompts: patch.prompts } : {}),
                                        ...(patch.selectedPromptId !== undefined ? { codeSelectedPromptId: patch.selectedPromptId } : {}),
                                      })}
                                    />
                                    <span className="modal-hint">{sidecarPromptHint('tts-code')}</span>
                                    <SidecarPromptManager
                                      collapsible
                                      disabled={route.enabled === false}
                                      builtins={SIDECAR_BUILTIN_TTS_DIFF_PROMPTS}
                                      prompts={route.diffPrompts ?? []}
                                      selectedPromptId={route.diffSelectedPromptId ?? SIDECAR_BUILTIN_TTS_DIFF_PROMPTS[0]!.id}
                                      label="Diff explanation prompt"
                                      onChange={(patch) => persistSidecarSite(site, {
                                        ...route,
                                        ...(patch.prompts !== undefined ? { diffPrompts: patch.prompts } : {}),
                                        ...(patch.selectedPromptId !== undefined ? { diffSelectedPromptId: patch.selectedPromptId } : {}),
                                      })}
                                    />
                                    <span className="modal-hint">{sidecarPromptHint('tts-diff')}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Compaction ───────────────────────────────────────── */}
            {tab === 'compaction' && compaction && (() => {
              const c = compaction;
              const showSummary = c.compactionEnabled && (c.handoffMode === 'summary' || c.handoffMode === 'prompt');
              const showTranscript = c.compactionEnabled && c.handoffMode === 'transcript';
              return (
                <div className="settings-section">
                  <div className="settings-section-title">Handoff Priming & Compaction</div>
                  
                  <div className={`settings-card${c.compactionEnabled ? ' active' : ''}`}>
                    <div className="settings-card-header">
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: c.compactionEnabled ? 'var(--accent)' : 'var(--text-3)' }}>
                          <path d="M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"/>
                          <path d="M12 6v6l4 2"/>
                        </svg>
                        <span className="settings-card-title">Handoff Priming</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={c.compactionEnabled}
                        className={`toggle-switch${c.compactionEnabled ? ' on' : ''}`}
                        onClick={() => saveCompaction({ compactionEnabled: !c.compactionEnabled })}
                        aria-label="Toggle Handoff Priming"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>

                    <div className="settings-card-body" style={c.compactionEnabled ? undefined : disabled}>
                      {showSummary && (
                        <div className="settings-card-body" style={{ gap: 12 }}>
                          <div className="modal-field">
                            <span className="modal-label">Preferred Summariser</span>
                            <ModelSelector
                              profiles={profiles}
                              profilesLoaded={agentProfilesLoaded}
                              selectedProfileId={c.preferredProfileId}
                              onChange={(val) => saveCompaction({ preferredProfileId: val })}
                              placement="bottom"
                            />
                          </div>

                          <div className="modal-field">
                            <span className="modal-label">Fallback Summariser</span>
                            <ModelSelector
                              profiles={profiles}
                              profilesLoaded={agentProfilesLoaded}
                              selectedProfileId={c.fallbackProfileId}
                              onChange={(val) => saveCompaction({ fallbackProfileId: val })}
                              placement="bottom"
                            />
                          </div>

                          <div className="modal-field">
                            <span className="modal-label">Max Compactor Context (Tokens)</span>
                            <input
                              type="number"
                              className="modal-input"
                              value={c.maxCompactorContextTokens}
                              onChange={(e) => saveCompaction({ maxCompactorContextTokens: Number(e.target.value) })}
                            />
                          </div>

                          <div className="modal-field">
                            <span className="modal-label">Summary Verbosity</span>
                            <SelectDropdown
                              options={verbosityOptions}
                              value={c.summaryVerbosity}
                              onChange={(val) => saveCompaction({ summaryVerbosity: val })}
                              placement="bottom"
                            />
                          </div>

                          <div className="modal-field">
                            <span className="modal-label">Output Token Cap</span>
                            <input
                              type="number"
                              className="modal-input"
                              value={c.outputTokenCap}
                              onChange={(e) => saveCompaction({ outputTokenCap: Number(e.target.value) })}
                            />
                          </div>
                          
                          {c.handoffMode === 'prompt' && (
                            <div className="modal-field" style={{ fontStyle: 'italic', opacity: 0.7, fontSize: '12px', marginTop: '6px' }}>
                              User will choose per handoff (Summarize / Pass full transcript).
                            </div>
                          )}
                        </div>
                      )}

                      {showTranscript && (
                        <div className="settings-card-body" style={{ gap: 12 }}>
                          <div className="modal-field">
                            <span className="modal-label">Max Transcript Tokens</span>
                            <input
                              type="number"
                              className="modal-input"
                              value={c.maxTranscriptHandoffTokens}
                              onChange={(e) => saveCompaction({ maxTranscriptHandoffTokens: Number(e.target.value) })}
                            />
                          </div>

                          <div className="modal-field">
                            <span className="modal-label">Context Safety Factor (0.1–0.9)</span>
                            <input
                              type="number"
                              className="modal-input"
                              min={0.1}
                              max={0.9}
                              step={0.05}
                              value={c.transcriptContextSafetyFactor}
                              onChange={(e) => saveCompaction({ transcriptContextSafetyFactor: Number(e.target.value) })}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>

                  <div className={`settings-card${c.spawnApprovalRequired ? ' active' : ''}`}>
                    <div className="settings-card-header">
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: c.spawnApprovalRequired ? 'var(--accent)' : 'var(--text-3)' }}>
                          <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
                          <path d="M6 8.5v7M6 15c0-4 12-1 12-6" />
                        </svg>
                        <span className="settings-card-title">Spawn Approval</span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={c.spawnApprovalRequired}
                        className={`toggle-switch${c.spawnApprovalRequired ? ' on' : ''}`}
                        onClick={() => saveCompaction({ spawnApprovalRequired: !c.spawnApprovalRequired })}
                        aria-label="Toggle Spawn Approval"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>
                    <div className="settings-card-body">
                      <div className="modal-field" style={{ fontStyle: 'italic', opacity: 0.7, fontSize: '12px' }}>
                        Require operator approval before any agent-spawned child runs. When off, agent spawns execute immediately (bypass).
                      </div>
                    </div>
                  </div>

                  <div className="settings-card active">
                    <div className="settings-card-header">
                      <div className="settings-card-title-group">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: c.usageAutoResume !== 'off' ? 'var(--accent)' : 'var(--text-3)' }}>
                          <path d="M21 12a9 9 0 1 1-3-6.7" /><polyline points="21 3 21 9 15 9" />
                        </svg>
                        <span className="settings-card-title">Usage auto-resume</span>
                      </div>
                      <SelectDropdown
                        options={USAGE_AUTO_RESUME_OPTIONS}
                        value={c.usageAutoResume}
                        onChange={(val) => saveCompaction({ usageAutoResume: val })}
                        placement="bottom"
                      />
                    </div>
                    <div className="settings-card-body">
                      <div className="modal-field">
                        <span className="modal-label">Max deferral (hours)</span>
                        <input
                          type="number"
                          className="modal-input"
                          min={0}
                          max={168}
                          value={deferHoursDraft ?? String(Math.round(c.usageAutoResumeMaxDeferMs / 3_600_000))}
                          onChange={(e) => {
                            setDeferHoursDraft(e.target.value);
                            setDeferHoursError(null);
                          }}
                          onBlur={() => {
                            const decision = decideDeferralHours(deferHoursDraft);
                            if (decision.kind === 'save') void saveCompaction({ usageAutoResumeMaxDeferMs: decision.ms });
                            setDeferHoursError(decision.kind === 'keep' ? decision.error : null);
                            setDeferHoursDraft(null);
                          }}
                          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        />
                        {deferHoursError && (
                          <div className="modal-hint" style={{ color: 'var(--red, #ef4444)' }}>{deferHoursError}</div>
                        )}
                      </div>
                      <div className="modal-field">
                        <span className="modal-label">Max attempts per episode</span>
                        <input
                          type="number"
                          className="modal-input"
                          min={1}
                          max={10}
                          value={c.usageAutoResumeMaxAttempts}
                          onChange={(e) => saveCompaction({ usageAutoResumeMaxAttempts: Number(e.target.value) })}
                        />
                      </div>
                      <div className="modal-field" style={{ fontStyle: 'italic', opacity: 0.7, fontSize: '12px' }}>
                        Parents can still switch a child's profile immediately. This setting only gates automatic recovery and how long anything may park a resume.
                      </div>
                    </div>
                  </div>
                </div>
              );
            })()}

            {tab === 'sandbox' && (
              <SandboxSettings remoteHosts={remoteHosts} onSaved={onSandboxChanged} />
            )}

            {tab === 'grokBot' && general && (
              <div className="settings-section">
                <div className="settings-section-title">Grok Bot</div>
                <div className="modal-hint template-settings-head-hint">
                  Grok Bot is the official desktop app, not a CLI. Tierwyn attaches to a running
                  window, so a graphical session is required. On a headless or terminal-only
                  host Grok Bot cannot be used. A locked screen often suspends that session, so
                  inbound Bot messages may stop until you unlock (and may need the app restarted
                  if it stalled hard).
                </div>
                <div className="settings-card active">
                  <div className="settings-card-body" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                    <div className="modal-field modal-field-row">
                      <div>
                        <span className="modal-label">Enable Grok Bot</span>
                        <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                          Master switch. Off hides the Grok Bots project, skips the watcher and prune, and refuses launches.
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={grokStatus?.enabled === true}
                        className={`toggle-switch${grokStatus?.enabled ? ' on' : ''}`}
                        onClick={() => {
                          const next = grokStatus?.enabled !== true;
                          setGrokEnableError(null);
                          void api.updateAgent('grok-bot', { enabled: next }).then(() => {
                            onCatalogueChanged();
                            return api.getGrokBotStatus().then(setGrokStatus);
                          }).catch((err: unknown) => {
                            setGrokEnableError(err instanceof Error ? err.message : String(err));
                          });
                        }}
                        aria-label="Enable Grok Bot"
                      >
                        <span className="toggle-knob" />
                      </button>
                    </div>
                    {grokEnableError && <div className="modal-hint" style={{ color: 'var(--red, #ef4444)' }}>{grokEnableError}</div>}

                    <fieldset disabled={grokStatus?.enabled !== true} style={{ border: 0, padding: 0, margin: 0, minWidth: 0, opacity: grokStatus?.enabled !== true ? 0.5 : 1 }}>
                      <div className="modal-field">
                        <span className="modal-label">Install</span>
                        <div className="modal-hint">
                          Layout: {grokStatus?.layout ?? '…'}
                          {grokStatus?.state === 'not-installed' && grokStatus.lastError ? ` — ${grokStatus.lastError}` : ''}
                        </div>
                      </div>
                      <div className="modal-field">
                        <span className="modal-label">Status</span>
                        <div className="modal-hint">
                          {grokStatus ? `${grokStatus.state}` : '…'}
                          {grokStatus?.lastError ? ` — ${grokStatus.lastError}` : ''}
                          {grokStatus?.nextAttemptAt ? ` · next ${new Date(grokStatus.nextAttemptAt).toLocaleTimeString()}` : ''}
                          {grokStatus?.launcher ? ` · launcher ${grokStatus.launcher}` : ''}
                          {grokStatus?.attribution ? ` · ${grokStatus.attribution}` : ''}
                          {grokStatus?.envLocks.autostart ? ' · AUTOSTART=0' : ''}
                          {grokStatus?.envLocks.watch ? ' · WATCH=0' : ''}
                        </div>
                        <button
                          type="button"
                          className="modal-btn"
                          style={{ marginTop: 8 }}
                          disabled={grokStatus?.envLocks.autostart === true}
                          onClick={() => {
                            void api.startGrokBot('manual').then(() => api.getGrokBotStatus().then(setGrokStatus)).catch(() => {});
                          }}
                        >
                          {grokStatus?.state === 'failed' || grokStatus?.state === 'backoff' ? 'Retry' : 'Start'}
                        </button>
                      </div>
                      <div className="modal-field">
                        <span className="modal-label">Auto-start</span>
                        <div
                          className="seg-switch"
                          role="radiogroup"
                          aria-label="Grok Bot auto-start"
                          style={{ '--seg-n': 3, '--seg-i': ['off', 'on-demand', 'keep-running'].indexOf(general.grokBotAutoStart ?? 'keep-running'), ...(grokStatus?.envLocks.autostart ? { opacity: 0.5 } : {}) } as React.CSSProperties}
                        >
                          <span className="seg-thumb" aria-hidden="true" />
                          {(['off', 'on-demand', 'keep-running'] as GrokBotAutoStart[]).map((v) => (
                            <button
                              key={v}
                              type="button"
                              role="radio"
                              aria-checked={(general.grokBotAutoStart ?? 'keep-running') === v}
                              disabled={grokStatus?.envLocks.autostart === true}
                              onClick={() => { void saveGeneral({ grokBotAutoStart: v }); }}
                            >
                              {v === 'off' ? 'Off' : v === 'on-demand' ? 'On demand' : 'Keep running'}
                            </button>
                          ))}
                        </div>
                        {grokStatus?.envLocks.autostart && (
                          <div className="modal-hint">Locked by TIERWYN_GROKBOT_AUTOSTART=0</div>
                        )}
                      </div>

                      <div className="modal-field modal-field-row">
                        <div>
                          <span className="modal-label">Allow in project chats</span>
                          <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                            Off (default): Grok Bot only appears under the Grok Bots project. On: selectable in other projects, with handoff priming and Hostname/CWD context when switching agents.
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={general.grokBotInProjectChats === true}
                          className={`toggle-switch${general.grokBotInProjectChats ? ' on' : ''}`}
                          onClick={() => { void saveGeneral({ grokBotInProjectChats: !general.grokBotInProjectChats }); }}
                          aria-label="Allow Grok Bot in project chats"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>
                      <div className="modal-field modal-field-row">
                        <div>
                          <span className="modal-label">Auto-create Grok Bots</span>
                          <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                            When a Grok Bot appears in the app roster, create a conversation for it under the Grok Bots project. Existing conversations are still watched, renamed, and retired.
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={general.grokBotAutoCreateRemoteAgents}
                          className={`toggle-switch${general.grokBotAutoCreateRemoteAgents ? ' on' : ''}`}
                          onClick={() => { void saveGeneral({ grokBotAutoCreateRemoteAgents: !general.grokBotAutoCreateRemoteAgents }); }}
                          aria-label="Auto-create Grok Bots"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>
                      <div className="modal-field">
                        <span className="modal-label">Grok Bot transcript limit (events)</span>
                        <div className="settings-input-group">
                          <input
                            className="modal-input"
                            type="number"
                            min={0}
                            max={100000}
                            value={general.grokBotTranscriptEventLimit ?? 2000}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw.trim() === '') return;
                              const v = Number(raw);
                              if (Number.isFinite(v) && (v === 0 || (v >= 100 && v <= 100000))) {
                                saveGeneral({ grokBotTranscriptEventLimit: Math.floor(v) });
                              }
                            }}
                            onBlur={(e) => {
                              if (e.target.value.trim() === '' || !Number.isFinite(Number(e.target.value))) {
                                e.target.value = String(general.grokBotTranscriptEventLimit ?? 2000);
                              }
                            }}
                            style={{ width: 120 }}
                          />
                        </div>
                        <div className="modal-hint">
                          Keeps only the most recent N events in each Grok Bots conversation. 0 = unlimited.
                        </div>
                      </div>
                      <div className="modal-field">
                        <span className="modal-label">Grok Bot history backfill (entries)</span>
                        <div className="settings-input-group">
                          <input
                            className="modal-input"
                            type="number"
                            min={0}
                            max={2000}
                            value={general.grokBotBackfillEntries ?? 200}
                            onChange={(e) => {
                              const raw = e.target.value;
                              if (raw.trim() === '') return;
                              const v = Number(raw);
                              if (Number.isFinite(v) && v >= 0 && v <= 2000) {
                                saveGeneral({ grokBotBackfillEntries: Math.floor(v) });
                              }
                            }}
                            onBlur={(e) => {
                              if (e.target.value.trim() === '' || !Number.isFinite(Number(e.target.value))) {
                                e.target.value = String(general.grokBotBackfillEntries ?? 200);
                              }
                            }}
                            style={{ width: 120 }}
                          />
                        </div>
                        <div className="modal-hint">
                          When a Bot is adopted into Grok Bots, replay this many replica entries
                          into the new conversation. 0 = start from now (no history). Historical
                          entries keep their original timestamps and do not raise notifications.
                        </div>
                      </div>
                      <div className="modal-field modal-field-row">
                        <div>
                          <span className="modal-label">Delete Bot with conversation</span>
                          <span className="modal-hint" style={{ display: 'block', marginTop: 4 }}>
                            Irreversible: deleting a Grok Bots conversation also deletes the Bot
                            in the Grok Bot app (via its own Delete confirm). Off (default): the
                            conversation reappears on the next watcher tick, with history if backfill
                            is on.
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={general.grokBotDeleteBotOnConversationDelete === true}
                          className={`toggle-switch${general.grokBotDeleteBotOnConversationDelete ? ' on' : ''}`}
                          onClick={() => { void saveGeneral({ grokBotDeleteBotOnConversationDelete: !general.grokBotDeleteBotOnConversationDelete }); }}
                          aria-label="Delete Bot with conversation"
                        >
                          <span className="toggle-knob" />
                        </button>
                      </div>
                    </fieldset>
                  </div>
                </div>
              </div>
            )}

            {/* ── Agents ──────────────────────────────────────────── */}
            {tab === 'agents' && (
              <CatalogueSettings
                embedded
                onClose={closeModal}
                onChanged={onCatalogueChanged}
                catalogueVersion={catalogueVersion}
              />
            )}

            {/* ── Agent Usage ─────────────────────────────────────── */}
            {tab === 'agentUsage' && <AgentUsageSettings />}

            {tab === 'plugins' && <PluginSettings />}

            {tab === 'mcp' && <McpServerSettings />}

            {tab === 'remoteHosts' && <RemoteHostsSettings hosts={remoteHosts} onHostsChange={onRemoteHostsChange} />}

            {tab === 'mesh' && compaction && (
              <MeshSettings settings={compaction} onSave={saveCompaction} />
            )}

            {/* ── Templates ───────────────────────────────────────── */}
            {tab === 'templates' && (
              <div className="templates-subpanel">
                <div className="templates-subtabs" role="tablist" aria-label="Templates sections">
                  <button
                    type="button"
                    role="tab"
                    id="templates-subtab-saved"
                    aria-selected={templatesSubTab === 'saved'}
                    aria-controls="templates-subpanel-saved"
                    className={`templates-subtab${templatesSubTab === 'saved' ? ' active' : ''}`}
                    onClick={() => setTemplatesSubTab('saved')}
                  >
                    Roster
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="templates-subtab-presets"
                    aria-selected={templatesSubTab === 'presets'}
                    aria-controls="templates-subpanel-presets"
                    className={`templates-subtab${templatesSubTab === 'presets' ? ' active' : ''}`}
                    onClick={() => setTemplatesSubTab('presets')}
                  >
                    Used-when presets
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="templates-subtab-designations"
                    aria-selected={templatesSubTab === 'designations'}
                    aria-controls="templates-subpanel-designations"
                    className={`templates-subtab${templatesSubTab === 'designations' ? ' active' : ''}`}
                    onClick={() => setTemplatesSubTab('designations')}
                  >
                    Designations
                  </button>
                </div>
                <div className="templates-subpanel-scroll">
                  <div
                    id="templates-subpanel-saved"
                    role="tabpanel"
                    aria-labelledby="templates-subtab-saved"
                    hidden={templatesSubTab !== 'saved'}
                  >
                    {templatesSubTab === 'saved' && (
                      <TemplateSettings profiles={profiles} profilesLoaded={agentProfilesLoaded} presets={roleWhenPresets} designations={designations.catalogue} />
                    )}
                  </div>
                  <div
                    id="templates-subpanel-presets"
                    role="tabpanel"
                    aria-labelledby="templates-subtab-presets"
                    hidden={templatesSubTab !== 'presets'}
                  >
                    {templatesSubTab === 'presets' && (
                      <RoleWhenPresetSettings
                        presets={roleWhenPresets}
                        onPresetsChanged={setRoleWhenPresets}
                      />
                    )}
                  </div>
                  <div
                    id="templates-subpanel-designations"
                    role="tabpanel"
                    aria-labelledby="templates-subtab-designations"
                    hidden={templatesSubTab !== 'designations'}
                  >
                    {templatesSubTab === 'designations' && (
                      <DesignationSettings
                        catalogue={designations}
                        onCatalogueChanged={setDesignations}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            {tab === 'globalTasks' && (
              <GlobalTasksSettings onChanged={onGlobalTasksChanged} />
            )}

            {tab === 'rulePresets' && (
              <RulePresetsSettings />
            )}

            {tab === 'capabilityProfiles' && (
              <CapabilityProfileSettings />
            )}
          </div>

          <div className="modal-footer">
            <span className="modal-footer-version">Tierwyn v{TIERWYN_VERSION}</span>
            <button className="modal-btn primary" onClick={closeModal}>Done</button>
          </div>
        </div>
      </div>

      {showRecurringConsentModal && (
        <AgentRecurringConsentModal
          onAccept={() => {
            setShowRecurringConsentModal(false);
            void saveGeneral({ allowAgentRecurringSchedules: true });
          }}
          onCancel={() => {
            setShowRecurringConsentModal(false);
          }}
        />
      )}
    </div>
  );
}
