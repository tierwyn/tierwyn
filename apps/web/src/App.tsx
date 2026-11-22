import { copyText } from './clipboard';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWs } from './ws.js';
import { mergeTranscriptWithLive } from './transcriptMerge.js';
import { api, auth, apiBase, UnauthorizedError, type ScheduleTreeResponse } from './api.js';
import { NotificationDispatcher } from './notifications.js';
import { getDevicePrefs } from './notificationDevice.js';
import { readNotificationSettings, writeNotificationSettings } from './notificationSettingsStore.js';
import { Login } from './components/Login.js';
import { LoadingScreen } from './components/LoadingScreen.js';
import { OutputPane } from './components/OutputPane.js';
import { TranscriptErrorBoundary } from './components/TranscriptErrorBoundary.js';
import { InputBar, type InputBarHandle } from './components/InputBar.js';
import { Sidebar } from './components/Sidebar.js';
import { ScheduleBrowser } from './components/ScheduleBrowser.js';
import { ScheduleCalendarPane } from './components/ScheduleCalendarPane.js';
import { SettingsModal, type SettingsTab } from './components/SettingsModal.js';
import { CommandPalette } from './components/CommandPalette.js';
import { isPaletteHotkey, isMessageSearchHotkey, shouldIgnoreHotkeyTarget, type PaletteActionType, type PaletteMode } from './commandPalette.js';
import { UsagePanel } from './components/UsagePanel.js';
import { HandoffChoiceModal } from './components/HandoffChoiceModal.js';
import { handoffChoiceOptions, stagedHandoffSkip, type HandoffChoiceOptions } from './handoffChoice.js';
import { CopyConversationModal } from './components/CopyConversationModal.js';
import { formatConversationCopy, type ConversationCopyMode } from './conversationCopy.js';
import { patchConversationInList } from './conversationPatch.js';
import { HandoffSummaryModal } from './components/HandoffSummaryModal.js';
import { OpenFileContext } from './OpenFileContext.js';
import { SummaryListModal } from './components/SummaryListModal.js';
import { MarkdownListModal } from './components/MarkdownListModal.js';
import { TtsRecordingsModal } from './components/TtsRecordingsModal.js';
import { collectMarkdownPaths } from './markdownPaths.js';
import { TtsParkBar } from './components/TtsParkBar.js';
import { CheckpointListModal } from './components/CheckpointListModal.js';
import { RestoreChoiceModal } from './components/RestoreChoiceModal.js';
import { AddSubagentModal } from './components/AddSubagentModal.js';
import { EditConversationModal } from './components/EditConversationModal.js';
import { RulesModal, type RulesTarget } from './components/RulesModal.js';
import { HelpersModal } from './components/HelpersModal.js';
import { TaskListModal } from './components/TaskListModal.js';
import { BtwPopup } from './components/BtwPopup.js';
import { BtwListModal } from './components/BtwListModal.js';
import { SpawnApprovalModal } from './components/SpawnApprovalModal.js';
import { AgentActivityModal } from './components/AgentActivityModal.js';
import { GlobalTasksModal } from './components/GlobalTasksModal.js';
import { MemoriesModal } from './components/MemoriesModal.js';
import { memoryBadgeCount } from './memories.js';
import type { MemoryCounts } from '@tierwyn/shared';
import { ConnectionModal } from './components/ConnectionModal.js';
import { GitWorkingTreeModal } from './components/GitWorkingTreeModal.js';
import { FileBrowserModal } from './components/FileBrowserModal.js';
import { remoteHostLabel } from './remoteHostLabel.js';
import type { GitPanelOpen } from './gitWorkingTree.js';
import { resolveGitPromptTarget } from './gitLlmPrompts.js';
import { agentActivityButtonClass } from './agentActivity.js';
import { AgentUsageModal } from './components/AgentUsageModal.js';
import { FileModal } from './components/FileModal.js';
import { Modal } from './components/Modal.js';
import { ConfirmDialog } from './components/ConfirmDialog.js';
import { collectHelpers, helpersSignature, latestTodos, runningHelperCount } from './subagents';
import { BARE_PROMPT_ADAPTERS, slashCommandUnsupportedMessage, ttsSummarizeConfigured, DEFAULT_EFFORT, resolveEffortForModel, REMOTE_AGENTS_PROJECT_ID, promptOptionsFor, sanitisePromptOptions, stripCommandIncompatibleOptions, agentSupportsPermissionMode, type InteractionMode, type PromptOptions, type AgentStatus, type Project, type Conversation, type NormalisedEvent, type HandoffMode, type HandoffOverride, type PendingHandoffMode, type Handoff, type SpawnTemplate, type Summary, type TtsRecording, type VoiceTtsSettings, type TtsProvider, type BtwQuery, type BtwUpdatedFrame, type SpawnRequestRow, type SpawnRequestUpdatedFrame, type Checkpoint, type CheckpointsUpdatedFrame, type GitCommitDraftUpdatedFrame, type ScheduleUpdatedFrame, type ConversationsChangedFrame, type Workdir, type EffortLevel, type EffortPreference, type GrokBotLifecycleStatus, type GlobalTasksSettings, type GlobalTaskCounts, type GlobalTaskUpdatedFrame, type RemoteHostView, type SandboxSetting, type SandboxSettings, SANDBOX_SETTINGS_DEFAULTS } from '@tierwyn/shared';
import { sandboxControlState } from './sandboxControl.js';
import { loadSticky, saveSticky, clearSticky } from './promptOptionsSticky.js';
import { setTtsConfig } from './speak.js';
import { readStoredTtsJobId, ttsParkRehydrate } from './ttsParkPlayer.js';
import { findScheduleTreeConversation, isScheduleConversation } from './scheduleCalendar.js';
import { shouldSyncSidebarTabOnSelect, projectsTabRestoreIds } from './sidebarTabs.js';
import type { EffortSessionState } from './components/EffortPill.js';
import type { SessionBadgeFromDot } from './statusDot.js';
import { isWrappingUp, resolveEffectiveStatus } from './effectiveStatus.js';
import { isRemoteAgentsProject, resolveConversationProfile } from './remoteAgentsProfile.js';
import { remoteProfileAvailability } from './remoteProfileAvailability.js';
import { applyGrokBotStatus, grokBotEnabledFromProfiles, isGrokBotChat, statusBanner } from './grokBotStatus.js';
import { filterProfilesForProjectChats } from './grokBotProjectChats.js';
import { decideSteerDispatch } from './steerSend.js';
import { pickerEffortLevels } from './effortLevels.js';
import { ConversationInfoModal } from './components/ConversationInfoModal.js';
import { lsGet, lsSet, lsRemove } from './prefixedStorage.js';
import {
  clampSidebarWidth,
  parseStoredSidebarWidth,
  SIDEBAR_W_MIN,
  SIDEBAR_W_MAX,
  SIDEBAR_W_DEFAULT,
} from './sidebarViews.js';
import { lastResolveIndexByRequestId } from './interactionResolve.js';
import { findGlobalTurnIndexByPromptId } from './groupTurns.js';

const TAIL_TURNS = 20;

/** Adapters whose transport binds effort at session/process start (D2/B3).
 *  Spawn-per-turn adapters (antigravity) always show the plain immediate badge. */
const LONG_LIVED_EFFORT_ADAPTERS = new Set(['claude-code', 'codex']);

const TAB_RESTORE_OPTS = { keepSidebarOpen: true, syncSidebarTab: false } as const;

const HIDE_TOOL_CALLS_KEY = 'tierwyn.hideToolCalls';

function readHideToolCalls(): boolean {
  const v = lsGet(HIDE_TOOL_CALLS_KEY);
  return v === '1' || v === 'true';
}

/** Server-owned composer settings that other devices can change. The sidebar
 *  list snapshot goes stale, so every fresh GET re-applies these. */
function composerSettingsOf(c: Conversation): Partial<Conversation> {
  return {
    pendingHandoffMode: c.pendingHandoffMode,
    sandbox: c.sandbox,
    permissionMode: c.permissionMode,
    effort: c.effort,
    mcpServers: c.mcpServers,
    disableNativeMcp: c.disableNativeMcp,
    disabledNativeMcp: c.disabledNativeMcp,
    templateName: c.templateName,
    capabilityProfile: c.capabilityProfile,
  };
}

function readStoredEffort(): EffortPreference {
  try {
    const v = localStorage.getItem('effort');
    if (v === 'off') return v;
    if (v === 'low' || v === 'medium' || v === 'high' || v === 'xhigh' || v === 'max') return v;
  } catch { /* ignore */ }
  return DEFAULT_EFFORT;
}

/** Main-pane selection: a chat conversation, a schedule job browser, or the calendar. */
type MainSelection =
  | { type: 'conversation'; project: Project; conversation: Conversation }
  | { type: 'schedule_job'; project: Project; jobId: string }
  // project: null — the pane owns its own scope, so the header must not claim one (D5).
  | { type: 'schedule_calendar'; project: null };

type ThemeMode = 'auto' | 'light' | 'dark';

function getTheme(): string { return (document.documentElement.dataset['theme'] as string) ?? ''; }

function readThemeMode(): ThemeMode {
  try {
    const v = localStorage.getItem('theme');
    if (v === 'light' || v === 'dark' || v === 'auto') return v;
  } catch { /* ignore */ }
  return 'dark';
}

function resolveEffectiveTheme(mode: ThemeMode): string {
  if (mode === 'light') return 'light';
  if (mode === 'dark') return '';
  // auto: follow the OS preference
  try {
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
  } catch { /* ignore */ }
  return '';
}

function applyThemeMode(mode: ThemeMode) {
  document.documentElement.dataset['theme'] = resolveEffectiveTheme(mode);
  try { localStorage.setItem('theme', mode); } catch { /* ignore */ }
}

function setThemeMode(mode: ThemeMode) {
  applyThemeMode(mode);
  // re-render so segmented control + accent dot reflect the new selection
  window.dispatchEvent(new Event('tierwyn-theme-change'));
}

export function getThemeColor(): string { return (document.documentElement.dataset['themeColor'] as string) ?? 'cyan'; }
export function setThemeColorDataset(color: string) {
  const html = document.documentElement;
  html.dataset['themeColor'] = color;
  try { localStorage.setItem('theme-color', color); } catch { /* ignore */ }
}

export const THEME_COLORS = [
  { id: 'cyan', name: 'Cyan', lightHex: '#0e7490', darkHex: '#22d3ee' },
  { id: 'sky', name: 'Sky', lightHex: '#0284c7', darkHex: '#38bdf8' },
  { id: 'teal', name: 'Teal', lightHex: '#0f766e', darkHex: '#2dd4bf' },
  { id: 'blue', name: 'Blue', lightHex: '#1d4ed8', darkHex: '#60a5fa' },
  { id: 'purple', name: 'Purple', lightHex: '#6d28d9', darkHex: '#a78bfa' },
  { id: 'green', name: 'Green', lightHex: '#047857', darkHex: '#34d399' },
  { id: 'amber', name: 'Amber', lightHex: '#b45309', darkHex: '#fbbf24' },
  { id: 'orange', name: 'Orange', lightHex: '#c2410c', darkHex: '#ff7849' },
  { id: 'rose', name: 'Rose', lightHex: '#be123c', darkHex: '#fb7185' },
  { id: 'fuchsia', name: 'Fuchsia', lightHex: '#a21caf', darkHex: '#f472b6' },
  { id: 'grey', name: 'Grey', lightHex: '#334155', darkHex: '#94a3b8' },
];


type AuthState = 'checking' | 'authenticated' | 'unauthenticated';

function parseSlashCommand(text: string): { name: string; args?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const commandText = trimmed.slice(1);
  if (!commandText) return null;

  if (commandText.startsWith('skill:')) {
    const skillText = commandText.slice('skill:'.length).trim();
    if (!skillText) return null;
    const [name, ...rest] = skillText.split(/\s+/);
    if (!name) return null;
    const args = rest.join(' ').trim();
    return args ? { name, args } : { name };
  }

  const [name, ...rest] = commandText.split(/\s+/);
  if (!name) return null;
  const args = rest.join(' ').trim();
  return args ? { name, args } : { name };
}

export function App() {
  const [authState, setAuthState] = useState<AuthState>('checking');
  // Whether the server has auth secrets set; when false the login is disabled.
  const [configured, setConfigured] = useState(true);

  // ── Boot: check existing session ──────────────────────────────────────────
  // On PWA cold reload the first /auth/session GET can fail transiently (network
  // not ready). Definitive logout is {authenticated:false}; fetch rejections retry
  // with bounded backoff before showing Login.
  // silent: keep the current screen (Login) instead of flashing LoadingScreen —
  // used for foreground/pageshow rechecks and the login "refresh session" button.
  const checkSession = useCallback((opts?: { silent?: boolean }) => {
    const silent = opts?.silent === true;
    function run(attempt = 0): Promise<boolean> {
      if (!silent) setAuthState('checking');
      return auth.session().then(
        (r) => {
          setConfigured(r.configured);
          if (r.authenticated) { setAuthState('authenticated'); return true; }
          // Definitive: server says not logged in.
          setAuthState('unauthenticated');
          return false;
        },
        () => {
          // Transient: fetch rejected (network not ready on cold reload/resume). Retry, bounded.
          const delays = [300, 700];
          if (attempt < delays.length) {
            return new Promise<boolean>((resolve) =>
              setTimeout(() => resolve(run(attempt + 1)), delays[attempt]));
          }
          setAuthState('unauthenticated');
          return false;
        },
      );
    }
    return run();
  }, []);

  useEffect(() => { void checkSession(); }, [checkSession]);

  // Self-heal: while Login is showing, re-check session when the page returns to foreground.
  useEffect(() => {
    if (authState !== 'unauthenticated') return;
    let inFlight = false;
    const recheck = () => {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      void checkSession({ silent: true }).finally(() => { inFlight = false; });
    };
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('pageshow', recheck);
    return () => {
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('pageshow', recheck);
    };
  }, [authState, checkSession]);

  const handleDeauthenticate = useCallback(() => {
    setAuthState('unauthenticated');
    // Reset conversation/project state by remounting the shell (authState change unmounts it)
  }, []);

  const handleAuthenticated = useCallback(() => {
    setAuthState('authenticated');
  }, []);

  if (authState === 'checking') {
    return <LoadingScreen />;
  }

  if (authState === 'unauthenticated') {
    return <Login onAuthenticated={handleAuthenticated} onRefresh={() => checkSession({ silent: true })} configured={configured} />;
  }

  return <Shell onDeauthenticate={handleDeauthenticate} />;
}

// ── Connection state icon ────────────────────────────────────────────────────
// Signal-bar icon that morphs shape per connection state (3 bars = connected,
// 1 bar = connecting, faded bars + X = disconnected). The coloured dot is kept
// alongside it for at-a-glance colour coding.
function ConnStateIcon({ state }: { state: string }) {
  if (state === 'connected') {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color: 'var(--green)' }}>
        <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
        <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
      </svg>
    );
  }
  const color = state === 'connecting' ? 'var(--amber)' : 'var(--red)';
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
      <path d="M18.84 12.2a4.49 4.49 0 0 0-.8-6.39l-3-3a4.5 4.5 0 0 0-6.36 0l-1.72 1.72" />
      <path d="M5.16 11.8a4.5 4.5 0 0 0 7.16 6.36l1.72-1.72" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  );
}

// ── Shell ─────────────────────────────────────────────────────────────────────
// Extracted so that when auth is revoked the component tree is cleanly unmounted
// (all state reset naturally) and the Login screen is shown.

interface ShellProps { onDeauthenticate: () => void; }

function Shell({ onDeauthenticate }: ShellProps) {
  // Ref so the btwUpdated callback stays stable while always seeing the latest conversationId
  const btwConversationIdRef = useRef<string | null>(null);
  // InputBar owns its own draft text (so typing doesn't re-render the whole
  // conversation); App pushes text in imperatively via this ref when needed.
  // Declared before useWs so onDraftUpdated can close over it safely.
  const inputBarRef = useRef<InputBarHandle>(null);
  const loadTranscriptTailRef = useRef<((convId: string, turns?: number) => Promise<any>) | null>(null);
  const [transcriptHasMore, setTranscriptHasMore] = useState(false);
  const [transcriptCursor, setTranscriptCursor] = useState<string | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const loadedTurnsRef = useRef<number>(TAIL_TURNS);
  const transcriptGenerationRef = useRef<number>(0);
  const [grokBotStatus, setGrokBotStatus] = useState<GrokBotLifecycleStatus | null>(null);
  const [remoteHosts, setRemoteHosts] = useState<RemoteHostView[]>([]);
  const grokOnDemandAtRef = useRef(0);
  /** Mid-turn steer confirmed before session_started — flush once the id arrives. */
  const deferredSteerRef = useRef<{
    conversationId: string;
    text: string;
    attachments: { base64: string; mediaType: string; name?: string }[];
    intent?: 'auto' | 'queue' | 'force';
    command?: { name: string; args?: string };
    handoffOverride?: HandoffOverride;
  } | null>(null);
  const directoryRef = useRef<{
    projects: Project[];
    conversations: Record<string, Conversation[]>;
    scheduleTrees: Record<string, ScheduleTreeResponse>;
  }>({ projects: [], conversations: {}, scheduleTrees: {} });
  const [directoryVersion, setDirectoryVersion] = useState(0);
  const selectConversationByIdRef = useRef<(id: string) => void>(() => {});
  const selectedConversationIdRef = useRef<string | null>(null);
  const dispatcherRef = useRef<NotificationDispatcher | null>(null);
  if (!dispatcherRef.current) {
    dispatcherRef.current = new NotificationDispatcher(() => ({
      settings: readNotificationSettings(),
      deviceEnabled: getDevicePrefs().enabled,
      selectedConversationId: selectedConversationIdRef.current,
      lookup: (cid) => {
        const { projects, conversations, scheduleTrees } = directoryRef.current;
        for (const p of projects) {
          const hit = (conversations[p.id] ?? []).find((c) => c.id === cid);
          if (hit) return { title: hit.title, description: hit.description, projectName: p.name };
        }
        for (const p of projects) {
          const tree = scheduleTrees[p.id];
          if (!tree) continue;
          for (const entry of tree.jobs) {
            if (entry.job.homeConversationId === cid) {
              return { title: `⏱ ${entry.job.name}`, projectName: p.name };
            }
            for (const r of entry.runs) {
              if (r.conversation?.id === cid) {
                return { title: r.conversation.title, description: r.conversation.description, projectName: p.name };
              }
              const desc = r.descendants.find((c) => c.id === cid);
              if (desc) return { title: desc.title, description: desc.description, projectName: p.name };
            }
          }
        }
        return {};
      },
      lookupProjectName: (pid) => directoryRef.current.projects.find((p) => p.id === pid)?.name,
      onClick: (id) => { selectConversationByIdRef.current(id); },
    }));
  }
  const [catalogueVersion, setCatalogueVersion] = useState(0);
  const remoteDeletedRef = useRef<(ids: string[]) => void>(() => {});
  const sidebarBumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { connState, profiles, profilesLoaded, events, activeConversationIds, conversationStatuses, liveActivityAt, errorRecoveredConversationIds, wsObservedConversationIds, unreadConversationIds, clearUnread, acknowledgeConversationError, setEvents, flushEvents, isSocketOpen, refreshProfiles, subscribe, sendPrompt, sendCommand, sendSteer, steerQueueLengths, steerQueues, cancelSteer, editSteer, currentSessionId, requestStop, stopSessionById, pendingPromptConversationId, stopResult, clearStopResult, sendInteractionResponse, forceInterruptedPromptIds, forceSteerToast, clearForceSteerToast, pingOnce, helpersRunningIds, stopHelper } = useWs({
    enabled: true,
    onUnauthorized: onDeauthenticate,
    onExternalSessionStarted: () => setSidebarRefetchTrigger((prev) => prev + 1),
    // ponytail: btw_updated = side-channel signal; refetch the btw list without touching parent state
    onBtwUpdated: (_frame: BtwUpdatedFrame) => {
      const convId = btwConversationIdRef.current;
      if (!convId) return;
      api.listBtw(convId).then(setBtwQueries).catch(() => {});
    },
    // spawn_request_updated = operator-global signal (fires regardless of which
    // conversation is open); refetch the unscoped approval queue and auto-open
    // the approval modal on a 0→N transition (new request arrived while none
    // were pending). If another modal is already open, the badge stays lit but
    // we don't steal focus. This callback is stored in a ref inside useWs and
    // refreshed on every render, so it always closes over the latest state.
    onSpawnRequestUpdated: (_frame: SpawnRequestUpdatedFrame) => {
      const prevCount = spawnRequests.length;
      api.listSpawnRequests().then((reqs) => {
        setSpawnRequests(reqs);
        const anyModalOpen = showSettings || showUsage || showAddSubagentModal
          || !!summaryModal || btwListOpen || !!btwOpenFile || spawnApprovalOpen
          || showAgentActivity || showAgentUsage || showGlobalTasks;
        if (prevCount === 0 && reqs.length > 0 && !anyModalOpen) {
          setSpawnApprovalOpen(true);
        }
      }).catch(() => {});
    },
    onCheckpointsUpdated: (_frame: CheckpointsUpdatedFrame) => {
      const convId = btwConversationIdRef.current;
      if (!convId) return;
      Promise.all([
        loadTranscriptTailRef.current ? loadTranscriptTailRef.current(convId) : api.transcript(convId),
        api.checkpoints(convId),
      ])
        .then(([page, cps]) => {
          if (page) setCheckpoints(cps);
        })
        .catch(() => {});
    },
    onDraftUpdated: (frame) => {
      inputBarRef.current?.applyRemoteDraft(frame);
      // Echo guard: our own write-through (handleProfileChange) broadcasts a
      // draft_updated carrying the pick we just applied. Only move the picker
      // for a DIFFERENT profile — a peer device's genuine cross-device change.
      if (frame.profileId && frame.profileId !== selectedProfileId
        && frame.conversationId === btwConversationIdRef.current) {
        setSelectedProfileId(frame.profileId);
        refreshNativeAvailable(frame.profileId.split(':')[0]);
      }
    },
    onGitCommitDraftUpdated: (frame) => setGitCommitDraftFrame(frame),
    onScheduleUpdated: (frame: ScheduleUpdatedFrame) => {
      dispatcherRef.current?.handleScheduleUpdated(frame);
      // Mid-run agentStatus ticks already patch conversationStatuses in ws.ts.
      // Skip structural tree refetch for those so we don't storm listConversations
      // / scheduleTree on every waiting/running status event.
      // Lifecycle frames (dispatch bind, finalize, reclaim, REST) omit agentStatus
      // or only carry runStatus — those still bump refetch triggers.
      if (frame.agentStatus !== undefined) {
        return;
      }
      setScheduleRefetchTrigger((n) => n + 1);
      setSidebarRefetchTrigger((n) => n + 1);
    },
    onConversationUpdated: (frame) => {
      dispatcherRef.current?.handleConversationUpdated(frame);
      // Permission mode / effort / MCP / template / capability profile changed on some
      // device — re-read the open conversation so its composer controls follow.
      if (frame.settingsChanged && frame.conversationId === btwConversationIdRef.current) {
        const cid = frame.conversationId;
        void api.getConversation(cid).then((fresh) => {
          setSelection((cur) => {
            if (cur?.type !== 'conversation' || cur.conversation.id !== cid) return cur;
            return {
              ...cur,
              conversation: { ...cur.conversation, ...composerSettingsOf(fresh) },
            };
          });
        }).catch(() => {});
      }
    },
    onConversationMeta: (meta) => {
      setLiveConversationMeta(meta);
      setSelection((cur) => {
        if (cur?.type !== 'conversation') return cur;
        if (cur.conversation.id !== meta.conversationId) return cur;
        const patch: Partial<Conversation> & { id: string } = { id: meta.conversationId };
        if (meta.title !== undefined) patch.title = meta.title;
        if (meta.description !== undefined) patch.description = meta.description;
        if (meta.tags !== undefined) patch.tags = meta.tags;
        if (meta.designation !== undefined) patch.designation = meta.designation ?? undefined;
        if (meta.archived !== undefined) patch.archived = meta.archived || undefined;
        if (meta.pendingHandoffMode !== undefined) patch.pendingHandoffMode = meta.pendingHandoffMode ?? undefined;
        if (meta.sandbox !== undefined) patch.sandbox = meta.sandbox ?? undefined;
        const list = patchConversationInList([cur.conversation], patch);
        const next = list?.[0];
        if (!next || next === cur.conversation) return cur;
        return { ...cur, conversation: next };
      });
      // Archive/unarchive changes sidebar membership in BOTH views —
      // bump the refetch trigger so every tab re-lists the project.
      if (meta.archived !== undefined) setSidebarRefetchTrigger((n) => n + 1);
    },
    onConversationsChanged: (frame: ConversationsChangedFrame) => {
      if (frame.deletedIds?.length) {
        remoteDeletedRef.current(frame.deletedIds);
        setPruneConversationIds(frame.deletedIds);
      }
      if (sidebarBumpTimerRef.current) clearTimeout(sidebarBumpTimerRef.current);
      sidebarBumpTimerRef.current = setTimeout(() => {
        sidebarBumpTimerRef.current = null;
        setSidebarRefetchTrigger((n) => n + 1);
      }, 250);
    },
    onGrokBotStatus: (frame) => setGrokBotStatus((prev) => applyGrokBotStatus(prev, frame.status, 'frame')),
    onRemoteHostStatus: (frame) => {
      setRemoteHosts((prev) => {
        const i = prev.findIndex((h) => h.id === frame.host.id);
        if (i < 0) return [...prev, frame.host];
        const next = prev.slice();
        next[i] = frame.host;
        return next;
      });
    },
    onGlobalTaskUpdated: (f) => {
      setGlobalTaskCounts(f.counts);
      setLastTaskFrame(f);
    },
    onMemoryUpdated: (f) => {
      setMemoryCounts(f.counts);
      setMemoryRefreshKey((k) => k + 1);
    },
    onCatalogueUpdated: () => setCatalogueVersion((v) => v + 1),
  });
  const [selection, setSelection] = useState<MainSelection | null>(null);
  const [liveConversationMeta, setLiveConversationMeta] = useState<{
    conversationId: string; title?: string; description?: string; tags?: string[];
    designation?: string | null; archived?: boolean;
    pendingHandoffMode?: PendingHandoffMode | null;
    sandbox?: SandboxSetting | null;
  } | null>(null);
  const [pruneConversationIds, setPruneConversationIds] = useState<string[]>([]);
  const [remoteDeleteToast, setRemoteDeleteToast] = useState<string | null>(null);
  const project = selection?.project ?? null;
  const conversation = selection?.type === 'conversation' ? selection.conversation : null;
  selectedConversationIdRef.current = conversation?.id ?? null;

  useEffect(() => {
    api.getNotificationSettings().then(writeNotificationSettings).catch(() => {});
  }, []);

  useEffect(() => {
    const dispatcher = dispatcherRef.current;
    if (!dispatcher) return;
    for (const [cid, status] of Object.entries(conversationStatuses)) {
      dispatcher.observeStatus(cid, status);
    }
  }, [conversationStatuses]);
  const selectedJobId = selection?.type === 'schedule_job' ? selection.jobId : null;
  /** Schedule view session-header pill — mirrors sidebar job-row aggregate. */
  const [scheduleJobBadge, setScheduleJobBadge] = useState<SessionBadgeFromDot | null>(null);
  const onScheduleJobStatusChange = useCallback((badge: SessionBadgeFromDot | null) => {
    setScheduleJobBadge(badge);
  }, []);
  useEffect(() => {
    if (selection?.type !== 'schedule_job') setScheduleJobBadge(null);
  }, [selection]);

  // Keep ref in sync so the stable btwUpdated callback always sees the latest conversation id
  useEffect(() => { btwConversationIdRef.current = conversation?.id ?? null; }, [conversation]);
  const [sidebarRefetchTrigger, setSidebarRefetchTrigger] = useState(0);
  const [scheduleRefetchTrigger, setScheduleRefetchTrigger] = useState(0);
  const [selectedProfileId, setSelectedProfileId] = useState('');
  // Effort is per conversation (conversations.effort, synced via settingsChanged).
  // The device default (localStorage 'effort', last pick) covers conversations
  // that never picked one. Client clamp via resolveEffort never mutates either.
  const [defaultEffort, setDefaultEffort] = useState<EffortPreference>(readStoredEffort);
  const effort: EffortPreference = conversation?.effort ?? defaultEffort;
  // Level bound when the current long-lived session started (B3).
  const [activeSessionEffort, setActiveSessionEffort] = useState<EffortLevel | undefined>(undefined);
  // Per-turn adapter options. Sticky bags persist in localStorage keyed by
  // (conversationId, agentType); one-shot bags clear after the next send.
  const [promptOptions, setPromptOptions] = useState<PromptOptions>({});
  const [promptOptionsSticky, setPromptOptionsSticky] = useState(false);
  const [optionsClearedBanner, setOptionsClearedBanner] = useState<string | null>(null);
  const prevAgentTypeRef = useRef<string | undefined>(undefined);
  const prevStickyRef = useRef(false);
  const prevOptionsRef = useRef<PromptOptions>({});
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [nativeAvailable, setNativeAvailable] = useState(false);
  const [contextResumable, setContextResumable] = useState(false);
  const [activeAgentType, setActiveAgentType] = useState<string | undefined>(undefined);
  // True once we have evidence of at least one session for the current
  // conversation — either a prior session found on open (active.lastSession)
  // or a session_started frame in the current turn (currentSessionId). Used
  // to gate the native-session badge so we don't render "unavailable"
  // during the agent-startup window on a fresh conversation, where
  // native_session_id hasn't been persisted yet. "Unavailable" should mean
  // "this adapter's session can't be resumed natively", not "agent hasn't
  // started yet" — those are different states.
  const [hasSession, setHasSession] = useState(false);
  // Profile ID of the LAST COMPLETED turn — the "from" side of any cross-adapter
  // handoff. Deliberately not touched by handleProfileChange (which only
  // updates the dropdown's selectedProfileId); only set on conversation open
  // and on dispatchPrompt (a turn was sent under that profile).
  const [lastSessionProfileId, setLastSessionProfileId] = useState<string | undefined>(undefined);
  const [showSettings, setShowSettings] = useState(false);
  const [connModalOpen, setConnModalOpen] = useState(false);
  const [showAgentActivity, setShowAgentActivity] = useState(false);
  const [activeAgentCount, setActiveAgentCount] = useState(0);
  const [timedAgentCount, setTimedAgentCount] = useState(0);
  const [showGlobalTasks, setShowGlobalTasks] = useState(false);
  const [globalTasksEnabled, setGlobalTasksEnabled] = useState(true);
  const [globalTaskCounts, setGlobalTaskCounts] = useState<GlobalTaskCounts>({
    inProgress: 0,
    completedVisible: 0,
    hidden: 0,
  });
  const [lastTaskFrame, setLastTaskFrame] = useState<GlobalTaskUpdatedFrame | null>(null);

  const [showMemories, setShowMemories] = useState(false);
  const [memoriesEnabled, setMemoriesEnabled] = useState(false);
  const [memoryCounts, setMemoryCounts] = useState<MemoryCounts>({ pendingSuggestions: 0, flagged: 0 });
  const [memoryRefreshKey, setMemoryRefreshKey] = useState(0);
  const [memoryFocusId, setMemoryFocusId] = useState<string | null>(null);
  const [rulesPromoteRef, setRulesPromoteRef] = useState<{ memoryId: string; text: string } | null>(null);
  const [rulesPrefill, setRulesPrefill] = useState<string | undefined>(undefined);

  // Fetch global task settings + counts when connected / on reconnect. When the
  // feature is disabled the header icon is hidden and the counts route 403s,
  // so the count fetch is skipped entirely.
  useEffect(() => {
    if (connState !== 'connected') return;
    const ac = new AbortController();
    const swallow = (err: unknown) => {
      if (err instanceof UnauthorizedError) return;
      if (err instanceof Error && err.name === 'AbortError') return;
    };
    api.globalTasksSettings()
      .then((s) => {
        setGlobalTasksEnabled(s.enabled);
        if (!s.enabled) return;
        return api.globalTaskCount(ac.signal).then((c) => setGlobalTaskCounts(c));
      })
      .catch(swallow);
    if (memoriesEnabled) {
      api.memoryCounts(ac.signal).then(setMemoryCounts).catch(swallow);
    }
    return () => ac.abort();
  }, [connState, memoriesEnabled]);

  // Disabled feature → the modal must close with the header icon.
  useEffect(() => {
    if (!globalTasksEnabled) setShowGlobalTasks(false);
  }, [globalTasksEnabled]);

  // Stable so GlobalTasksSettings' load effect does not refetch per App render.
  const handleGlobalTasksSettingsChanged = useCallback((updated: GlobalTasksSettings) => {
    setGlobalTasksEnabled(updated.enabled);
    if (updated.enabled) {
      api.globalTaskCount().then(setGlobalTaskCounts).catch(() => {});
    }
  }, []);

  // Poll active session count and pending timer count while the Agent Activity modal is closed so the
  // heartbeat/hourglass icon can animate or reflect state whenever agents are running or timed to wake.
  // When the modal is open, AgentActivityModal polls and passes the counts up via callbacks.
  useEffect(() => {
    if (connState !== 'connected' || showAgentActivity) return;

    let mounted = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const ac = new AbortController();

    const fetchCount = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      api.activeSessions(ac.signal)
        .then((p) => {
          if (!mounted) return;
          setActiveAgentCount(p.sessions.length);
        })
        .catch((err: unknown) => {
          if (!mounted) return;
          if (err instanceof UnauthorizedError) {
            setActiveAgentCount(0);
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return;
        });

      api.pendingTimers(ac.signal)
        .then((p) => {
          if (!mounted) return;
          setTimedAgentCount(p.timers.length);
        })
        .catch((err: unknown) => {
          if (!mounted) return;
          if (err instanceof UnauthorizedError) {
            setTimedAgentCount(0);
            return;
          }
          if (err instanceof Error && err.name === 'AbortError') return;
        });
    };

    fetchCount();
    timer = setInterval(fetchCount, 3000);

    const onVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        fetchCount();
      }
    };
    const onTimersChanged = () => {
      fetchCount();
    };
    window.addEventListener('visibilitychange', onVisibilityOrFocus);
    window.addEventListener('focus', onVisibilityOrFocus);
    window.addEventListener('conversation-timers-changed', onTimersChanged);

    return () => {
      mounted = false;
      if (timer !== undefined) clearInterval(timer);
      ac.abort();
      window.removeEventListener('visibilitychange', onVisibilityOrFocus);
      window.removeEventListener('focus', onVisibilityOrFocus);
      window.removeEventListener('conversation-timers-changed', onTimersChanged);
    };
  }, [
    connState,
    showAgentActivity,
    sidebarRefetchTrigger,
    currentSessionId,
    pendingPromptConversationId,
    stopResult,
    activeConversationIds,
  ]);

  const [showAgentUsage, setShowAgentUsage] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general');
  const [duplicateConfirmConv, setDuplicateConfirmConv] = useState<Conversation | null>(null);
  const [rulesTarget, setRulesTarget] = useState<RulesTarget | null>(null);
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  const [alertDialog, setAlertDialog] = useState<{ title?: string; message: React.ReactNode } | null>(null);
  const showAlert = useCallback((message: React.ReactNode, title = 'Notice') => {
    setAlertDialog({ message, title });
  }, []);
  const [defaultConversationProfileId, setDefaultConversationProfileId] = useState<string | null>(null);
  const [fileEditsEnabled, setFileEditsEnabled] = useState(false);
  const [hideShippedSchedulePacks, setHideShippedSchedulePacks] = useState(false);
  const [grokBotInProjectChats, setGrokBotInProjectChats] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [showAddSubagentModal, setShowAddSubagentModal] = useState(false);
  const [editConvOpen, setEditConvOpen] = useState(false);
  // /btw side-question state
  const [btwQueries, setBtwQueries] = useState<BtwQuery[]>([]);
  const [btwPopupQueryId, setBtwPopupQueryId] = useState<string | null>(null);
  const [btwListOpen, setBtwListOpen] = useState(false);
  const [btwUnavailable, setBtwUnavailable] = useState<string | null>(null);

  useEffect(() => {
    api.getBtwAvailability()
      .then((a) => setBtwUnavailable(a.ready ? null : (a.reason ?? 'BTW unavailable')))
      .catch(() => {});
  }, [conversation?.id, showSettings]);
  // Spawn approval queue state
  const [spawnRequests, setSpawnRequests] = useState<SpawnRequestRow[]>([]);
  const [spawnApprovalOpen, setSpawnApprovalOpen] = useState(false);
  // File-modal path for files opened from inside the BTW popup (path links in
  // the answer). Rendered at App level because BtwPopup lives outside OutputPane,
  // which owns its own FileModal instance.
  const [btwOpenFile, setBtwOpenFile] = useState<string | null>(null);
  const [showHelpers, setShowHelpers] = useState(false);
  const [helperFocus, setHelperFocus] = useState<string | undefined>(undefined);
  const [helperHighlightQuery, setHelperHighlightQuery] = useState<string | undefined>(undefined);
  // Manual "push result up" feedback toast (success or server error string).
  const [pushResultToast, setPushResultToast] = useState<string | null>(null);
  const [pushResultPending, setPushResultPending] = useState(false);
  const pushResultToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showTaskList, setShowTaskList] = useState(false);
  const [spawnTemplate, setSpawnTemplate] = useState<SpawnTemplate | undefined>(undefined);

  // Load the conversation's spawn template so prompt-collection roster pickers
  // (and the spawn modal) have role names without waiting for a spawn click.
  useEffect(() => {
    if (!conversation?.templateName) {
      setSpawnTemplate(undefined);
      return;
    }
    const name = conversation.templateName;
    let cancelled = false;
    void api.listTemplates()
      .then((ts) => {
        if (!cancelled) setSpawnTemplate(ts.find((t) => t.name === name));
      })
      .catch(() => {
        if (!cancelled) setSpawnTemplate(undefined);
      });
    return () => { cancelled = true; };
  }, [conversation?.id, conversation?.templateName]);
  const [allCollapsed, setAllCollapsed] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [showActionsDropdown, setShowActionsDropdown] = useState(false);
  // Global handoff mode, fetched once on boot so InputBar can decide whether to
  // show the inline per-handoff choice (only relevant when mode === 'prompt').
  const [handoffMode, setHandoffMode] = useState<HandoffMode | undefined>(undefined);
  const [defaultSpawnWorkdir, setDefaultSpawnWorkdir] = useState<Workdir | undefined>(undefined);
  const [defaultInteractionMode, setDefaultInteractionMode] = useState<InteractionMode>('bypass');
  const [sandboxSettings, setSandboxSettings] = useState<SandboxSettings>(SANDBOX_SETTINGS_DEFAULTS);
  const [sandboxSupport, setSandboxSupport] = useState<{ supportedAgents: string[]; hubAvailable: boolean | undefined }>({
    supportedAgents: [],
    hubAvailable: undefined,
  });
  const [, forceRender] = useState(0);
  // True for ~5s after a turn completes (running→done) so the header pill can
  // flash green before fading to the grey default. Mirrors the sidebar's
  // "unread = green" semantics: the user is already viewing this conversation,
  // so the brief green pulse is the equivalent of "fresh response just landed".
  const [recentlyCompleted, setRecentlyCompleted] = useState(false);
  const [copiedConv, setCopiedConv] = useState(false);
  const [showCopyConversationModal, setShowCopyConversationModal] = useState(false);
  const [hideToolCalls, setHideToolCalls] = useState(readHideToolCalls);
  const [showConversationInfo, setShowConversationInfo] = useState(false);
  const [themeColor, setThemeColor] = useState(getThemeColor);
  const [showAppearance, setShowAppearance] = useState(false);
  const appearanceRef = useRef<HTMLDivElement>(null);
  const [showTopbarOverflow, setShowTopbarOverflow] = useState(false);
  const topbarOverflowRef = useRef<HTMLDivElement>(null);

  const [summaryByEventId, setSummaryByEventId] = useState<Record<string, string>>({});
  const [handoffByAnchorId, setHandoffByAnchorId] = useState<Record<string, Handoff>>({});
  const [summaryModal, setSummaryModal] = useState<{ text: string; handoff?: Handoff } | null>(null);
  const [showSummaryList, setShowSummaryList] = useState(false);
  const [summaryList, setSummaryList] = useState<Summary[]>([]);
  const [handoffBySummaryId, setHandoffBySummaryId] = useState<Record<string, Handoff>>({});
  /** True if the spawn tree of the current conversation has ≥1 summary.
   *  Probed on switch ONLY when the conversation itself has none, so the
   *  Summaries dropdown stays enabled on a child with no own summaries but
   *  with a summary elsewhere in the tree (typically a parent's compaction) —
   *  the user can then open the modal and toggle tree mode to see it.
   *  The WS reconnect path (App.tsx ~531) does NOT probe: it fires after a
   *  summary was written to THIS conversation, so summaryList is non-empty
   *  and the dropdown gate passes without needing the tree flag. */
  const [summaryTreeHasSummaries, setSummaryTreeHasSummaries] = useState(false);
  const [showMarkdownList, setShowMarkdownList] = useState(false);
  const [showTtsRecordings, setShowTtsRecordings] = useState(false);
  const [ttsRecordings, setTtsRecordings] = useState<TtsRecording[]>([]);
  /** conversation_id → title for source labels in the project recordings modal. */
  const [ttsConvTitles, setTtsConvTitles] = useState<Record<string, string>>({});
  const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
  const [showCheckpointList, setShowCheckpointList] = useState(false);
  const [gitPanel, setGitPanel] = useState<GitPanelOpen | null>(null);
  const [fileBrowserOpen, setFileBrowserOpen] = useState(false);
  const [gitCommitDraftFrame, setGitCommitDraftFrame] = useState<GitCommitDraftUpdatedFrame | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<{ cp: Checkpoint; hasCode: boolean } | null>(null);
  const [tts, setTts] = useState<VoiceTtsSettings | null>(null);
  const [ttsSummarizeAvailable, setTtsSummarizeAvailable] = useState(false);

  // Refresh the summary list when the user opens the modal — summaries can be
  // written mid-session by compaction, so the snapshot taken at conversation
  // open may be stale.
  const openSummaryList = useCallback(async () => {
    const conv = conversationRef.current;
    if (!conv) return;
    try {
      const [summs, hands] = await Promise.all([api.summaries(conv.id).then((r) => r.summaries), api.handoffs(conv.id)]);
      setSummaryList(summs);
      setHandoffBySummaryId(Object.fromEntries(hands.filter((h) => h.summary_id).map((h) => [h.summary_id as string, h])));
    } catch { /* leave existing snapshot in place */ }
    setShowSummaryList(true);
  }, []);

  // Project-scoped recordings modal list (dropdown → Recordings).
  const refreshTtsRecordings = useCallback(async (projectId?: string) => {
    const id = projectId ?? selection?.project?.id;
    if (!id) return;
    try {
      const r = await api.listProjectTtsRecordings(id);
      setTtsRecordings(r.recordings);
      const map: Record<string, string> = {};
      for (const c of r.conversations ?? []) map[c.id] = c.title;
      setTtsConvTitles(map);
    } catch { /* leave existing snapshot */ }
  }, [selection?.project?.id]);

  // Fresh list on open — recordings appear mid-session after each Piper/Kokoro speak.
  const openTtsRecordings = useCallback(async () => {
    const projectId = selection?.project?.id;
    if (!projectId) return;
    await refreshTtsRecordings(projectId);
    setShowTtsRecordings(true);
  }, [refreshTtsRecordings, selection?.project?.id]);

  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [pendingFork, setPendingFork] = useState<{ eventId: string; title: string } | null>(null);

  // Task 5: if a WS checkpoint-update prunes the checkpoint the restore modal is pointing at,
  // close the modal gracefully rather than letting it act on a deleted checkpoint.
  useEffect(() => {
    if (restoreTarget && !checkpoints.some((c) => c.id === restoreTarget.cp.id)) {
      setRestoreTarget(null);
    }
  }, [checkpoints, restoreTarget]);

  const handleSetThemeColor = useCallback((color: string) => {
    setThemeColor(color);
    setThemeColorDataset(color);
  }, []);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const t = event.target as Node;
      if (appearanceRef.current && !appearanceRef.current.contains(t)) {
        setShowAppearance(false);
      }
      if (topbarOverflowRef.current && !topbarOverflowRef.current.contains(t)) {
        setShowTopbarOverflow(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);


  useEffect(() => {
    if (hideToolCalls) {
      document.body.classList.add('hide-tool-calls');
    } else {
      document.body.classList.remove('hide-tool-calls');
    }
    return () => {
      document.body.classList.remove('hide-tool-calls');
    };
  }, [hideToolCalls]);

  useEffect(() => {
    api.getCompaction()
      .then((s) => {
        setHandoffMode(s.handoffMode);
        setDefaultSpawnWorkdir(s.defaultSpawnWorkdir);
        if (s.interactionMode) setDefaultInteractionMode(s.interactionMode);
      })
      .catch((err) => { if (err instanceof UnauthorizedError) onDeauthenticate(); });
    api.getSandboxSettings()
      .then((s) => setSandboxSettings(s))
      .catch((err) => { if (err instanceof UnauthorizedError) onDeauthenticate(); });
    api.getGeneral()
      .then((s) => {
        setDefaultConversationProfileId(s.defaultConversationProfileId);
        setFileEditsEnabled(!!s.fileEditsEnabled);
        setHideShippedSchedulePacks(!!s.hideShippedSchedulePacks);
        setGrokBotInProjectChats(!!s.grokBotInProjectChats);
        if (s.memories === true) {
          setMemoriesEnabled(true);
          api.memoryCounts().then(setMemoryCounts).catch(() => {});
        } else {
          setMemoriesEnabled(false);
        }
      })
      .catch(() => {/* non-critical */});
    // Prefer /tts/config so the letter (B/P/K) and speak.ts module config share one source after refresh.
    // Fall back to /settings/voice if the tts route is unavailable.
    api.getTtsConfig()
      .then((v) => {
        setTts(v.tts);
        setTtsConfig(v.tts);
        setTtsSummarizeAvailable(!!v.summarizeConfigured);
      })
      .catch(() => {
        api.getVoiceSettings()
          .then((v) => {
            setTts(v.tts);
            setTtsConfig(v.tts);
            setTtsSummarizeAvailable(ttsSummarizeConfigured(v.cleanup));
          })
          .catch((err) => { if (err instanceof UnauthorizedError) onDeauthenticate(); });
      });
    // Bootstrap the global approval queue — badge shows immediately on page load
    // without needing a WS signal or an open conversation.
    api.listSpawnRequests().then(setSpawnRequests).catch(() => {});

    // Re-hydrate park bar from last TTS job started in this browser (localStorage).
    const storedJobId = readStoredTtsJobId();
    if (storedJobId) {
      api.getTtsRecording(storedJobId)
        .then(({ recording }) => {
          if (recording.status === 'running') {
            ttsParkRehydrate(recording, { resumePoll: true });
          } else if (recording.status === 'done') {
            // ready — no autoplay without a gesture
            ttsParkRehydrate(recording);
          } else if (recording.status === 'error') {
            ttsParkRehydrate(recording);
          }
        })
        .catch(() => {
          // 404 or network — clear stale key
          lsRemove('tierwyn.tts.job');
        });
    }
  }, [onDeauthenticate]);

  const cycleTtsProvider = useCallback(async () => {
    if (!tts) return;
    const order: TtsProvider[] = ['browser', 'piper', 'kokoro'];
    const next = order[(order.indexOf(tts.provider) + 1) % order.length]!;
    const updated = await api.updateVoiceSettings({ tts: { provider: next } });
    setTts(updated.tts);
    setTtsConfig(updated.tts);
  }, [tts]);

  // Re-fetch transcript when the WS reconnects after an unexpected disconnect so
  // stale "running" events from a killed server don't leave a stuck spinner.
  const conversationRef = useRef(conversation);
  useEffect(() => { conversationRef.current = conversation; }, [conversation]);

  const loadTranscriptTail = useCallback(async (convId: string, turns = loadedTurnsRef.current) => {
    const gen = ++transcriptGenerationRef.current;
    try {
      if (!Number.isFinite(turns)) {
        const full = await api.transcript(convId);
        if (gen !== transcriptGenerationRef.current || (conversationRef.current?.id ?? btwConversationIdRef.current) !== convId) {
          return null;
        }
        flushEvents();
        setEvents((live) => mergeTranscriptWithLive(full as unknown as NormalisedEvent[], live));
        setTranscriptHasMore(false);
        setTranscriptCursor(null);
        return { events: full, hasMore: false };
      }
      const page = await api.transcriptPage(convId, { tailTurns: turns });
      if (gen !== transcriptGenerationRef.current || (conversationRef.current?.id ?? btwConversationIdRef.current) !== convId) {
        return null;
      }
      flushEvents();
      setEvents((live) => mergeTranscriptWithLive(page.events as unknown as NormalisedEvent[], live));
      setTranscriptHasMore(Boolean(page.hasMore));
      setTranscriptCursor(page.cursor ?? null);
      return page;
    } catch {
      return null;
    }
  }, [setEvents, flushEvents]);

  useEffect(() => {
    loadTranscriptTailRef.current = loadTranscriptTail;
  }, [loadTranscriptTail]);

  const loadAll = useCallback(async (convId?: string | unknown) => {
    const targetId = typeof convId === 'string' ? convId : (conversationRef.current?.id ?? btwConversationIdRef.current);
    if (!targetId || loadingAll) return;
    setLoadingAll(true);
    const gen = ++transcriptGenerationRef.current;
    try {
      const full = await api.transcript(targetId);
      if (gen !== transcriptGenerationRef.current || (conversationRef.current?.id ?? btwConversationIdRef.current) !== targetId) {
        return;
      }
      flushEvents();
      setEvents((live) => mergeTranscriptWithLive(full as unknown as NormalisedEvent[], live));
      setTranscriptHasMore(false);
      setTranscriptCursor(null);
      loadedTurnsRef.current = Infinity;
    } catch (err) {
      console.error('Failed to load full transcript:', err);
    } finally {
      setLoadingAll(false);
    }
  }, [setEvents, flushEvents, loadingAll]);

  const loadEarlier = useCallback(async () => {
    const convId = conversationRef.current?.id ?? btwConversationIdRef.current;
    if (!convId || !transcriptCursor || !transcriptHasMore || loadingEarlier || loadingAll) return;
    setLoadingEarlier(true);
    const gen = transcriptGenerationRef.current;
    try {
      const page = await api.transcriptPage(convId, { tailTurns: TAIL_TURNS, before: transcriptCursor });
      if (gen !== transcriptGenerationRef.current || (conversationRef.current?.id ?? btwConversationIdRef.current) !== convId) {
        return;
      }
      setEvents((prev: NormalisedEvent[]) => {
        const existingIds = new Set(prev.map((e) => e.id).filter(Boolean));
        const older = (page.events as unknown as NormalisedEvent[]).filter(
          (e) => !e.id || !existingIds.has(e.id),
        );
        return [...older, ...prev];
      });
      setTranscriptHasMore(Boolean(page.hasMore));
      setTranscriptCursor(page.cursor ?? null);
      loadedTurnsRef.current += TAIL_TURNS;
    } catch (err) {
      console.error('Failed to load earlier transcript messages:', err);
    } finally {
      setLoadingEarlier(false);
    }
  }, [transcriptCursor, transcriptHasMore, loadingEarlier, loadingAll, setEvents]);

  // Re-render on theme changes: explicit (setThemeMode dispatches) and OS
  // prefers-color-scheme flips while mode is 'auto'. The data-theme attribute
  // is updated by the handler; this just wakes React so the segmented control
  // and accent dots re-read the effective theme.
  useEffect(() => {
    const wake = () => forceRender((n) => n + 1);
    const mql = window.matchMedia?.('(prefers-color-scheme: light)');
    const onScheme = () => {
      // Only the effective theme depends on OS scheme (auto mode).
      if (readThemeMode() === 'auto') {
        document.documentElement.dataset['theme'] = resolveEffectiveTheme('auto');
        wake();
      }
    };
    mql?.addEventListener?.('change', onScheme);
    window.addEventListener('tierwyn-theme-change', wake);
    return () => {
      mql?.removeEventListener?.('change', onScheme);
      window.removeEventListener('tierwyn-theme-change', wake);
    };
  }, []);
  const wasDisconnectedRef = useRef(false);
  useEffect(() => {
    if (connState === 'disconnected') { wasDisconnectedRef.current = true; return; }
    if (connState === 'connected' && wasDisconnectedRef.current) {
      wasDisconnectedRef.current = false;
      setSidebarRefetchTrigger((n) => n + 1);
      const conv = conversationRef.current;
      if (!conv) return;
      loadTranscriptTail(conv.id).catch(() => {});
      api.summaries(conv.id)
        .then((r) => {
          const s = r.summaries;
          setSummaryByEventId(Object.fromEntries(s.map((x) => [x.last_event_id, x.summary_text])));
          setSummaryList(s);
        })
        .catch(() => {});
      api.handoffs(conv.id)
        .then((h) => {
          setHandoffByAnchorId(Object.fromEntries(h.map((x) => [x.anchor_event_id, x])));
          setHandoffBySummaryId(Object.fromEntries(h.filter((x) => x.summary_id).map((x) => [x.summary_id as string, x])));
        })
        .catch(() => {});
      // Re-sync approval queue after reconnect — WS signals sent while
      // disconnected are lost, so refetch on every reconnect.
      api.listSpawnRequests().then(setSpawnRequests).catch(() => {});
    }
  }, [connState, setEvents, setSummaryByEventId]);

  // Unified status source. The WS map is authoritative while a turn is
  // running, waiting, or errored — it fires earlier than the adapter's first
  // status event (sendPrompt sets it optimistically) and survives adapter
  // subprocess hangs that delay the close-driven status:done. events[]
  // drives the 'done' pulse via recentlyCompleted below. Sidebar mirrors
  // this value through selectedBadgeStatus, so the title pill and the
  // selected row now share ONE source of truth.
  const wsStatus = conversation ? conversationStatuses[conversation.id] : undefined;
  const latestStatus = useMemo(() => [...events].reverse().find((e) => e.type === 'status'), [events]);
  const markdownPaths = useMemo(() => collectMarkdownPaths(events), [events]);
  const eventsStatus: AgentStatus = latestStatus?.type === 'status' ? latestStatus.payload.status : 'idle';
  // ponytail: a transcript tail of running/waiting from a session the server no
  // longer holds (restart, crashed adapter, zombie session) must not keep the UI
  // "running" — while the socket is up the live view (conversationStatuses +
  // activeConversationIds) is authoritative. Without this the composer stays in
  // steer mode against a dead session and messages go nowhere.
  const staleRunning =
    connState === 'connected' &&
    !wsStatus &&
    !currentSessionId &&
    !!conversation &&
    !activeConversationIds.includes(conversation.id) &&
    (eventsStatus === 'running' || eventsStatus === 'waiting');
  const effectiveStatus: AgentStatus = resolveEffectiveStatus({
    wsStatus, eventsStatus, staleRunning,
  });
  const isRunning = effectiveStatus === 'running' || effectiveStatus === 'waiting';
  // Wrapping-up window: the server already cleared the live-status map (turn
  // done / hold-open teardown) while the transcript buffer still streams and
  // the session record is still addressable — keep a dimmed force-Stop
  // reachable instead of a dead zone. Zombie sessions (staleRunning) never
  // qualify: isWrappingUp requires currentSessionId.
  const wrappingUp = isWrappingUp({
    connected: connState === 'connected',
    effectiveStatus,
    eventsStatus,
    hasCurrentSession: !!currentSessionId,
  });

  // Centralised native-availability refetch, scoped to a single adapter. Shared
  // by every trigger that needs to refresh the badge: model switch
  // (handleProfileChange), prompt/command dispatch (optimistic confirm at send
  // time), the adapter-started transition (Effect 2 — the authoritative
  // moment), and turn completion (Effect 1).
  const refreshNativeAvailable = useCallback((agentType: string | undefined) => {
    // ponytail: ref-read so this callback stays stable — it transitively feeds
    // InputBar's draft-load effect deps via handleProfileChange.
    const conv = conversationRef.current;
    if (!conv || !agentType) return;
    api.activeAgent(conv.id, agentType)
      .then((active) => {
        setNativeAvailable(active.nativeAvailable);
        setContextResumable(active.contextResumable ?? false);
        if (active.lastSession) setHasSession(true);
      })
      .catch((err) => { if (err instanceof UnauthorizedError) onDeauthenticate(); });
  }, [onDeauthenticate]);

  const refreshHandoffMetadata = useCallback(() => {
    if (!conversation) return;
    api.summaries(conversation.id)
      .then((r) => r.summaries)
      .then((s) => setSummaryByEventId(Object.fromEntries(s.map((x) => [x.last_event_id, x.summary_text]))))
      .catch(() => {});
    api.handoffs(conversation.id)
      .then((h) => setHandoffByAnchorId(Object.fromEntries(h.map((x) => [x.anchor_event_id, x]))))
      .catch(() => {});
  }, [conversation]);

  // Effect 1 — re-fetch native-availability when a prompt finishes. The session
  // row gets its native_session_id during prompt execution, so this final
  // refetch guarantees the indicator reflects the just-completed session.
  const prevStatusRef = useRef<AgentStatus>('idle');
  useEffect(() => {
    const prev = prevStatusRef.current;
    prevStatusRef.current = effectiveStatus;
    if (activeAgentType && prev === 'running' && (effectiveStatus === 'done' || effectiveStatus === 'error')) {
      refreshNativeAvailable(activeAgentType);
      refreshHandoffMetadata();
    }
    // Flash green for ~5s after a turn completes, then fade to grey. Error
    // transitions are left to the red badge — only done pulses green.
    if (prev === 'running' && effectiveStatus === 'done') {
      setRecentlyCompleted(true);
      const t = setTimeout(() => setRecentlyCompleted(false), 5000);
      return () => clearTimeout(t);
    }
  }, [effectiveStatus, activeAgentType, refreshNativeAvailable, refreshHandoffMetadata]);

  // Effect 2 — re-fetch native-availability the instant the adapter reports it
  // is working. This is the authoritative "agent is up" signal: the server
  // persists native_session_id to the DB right before broadcasting its first
  // status:'running' event (sessionManager calls setNativeSessionId() ahead of
  // the emit), so by the time events[] shows a *→running transition the row is
  // already updated and the refetch returns fresh data. We deliberately key off
  // the events-stream status (eventsStatus), NOT effectiveStatus: effectiveStatus
  // flips to 'running' on the session_started WS frame — before native_session_id
  // exists — so keying off it would race and read stale/empty state.
  const prevEventStatusRef = useRef<AgentStatus>('idle');
  useEffect(() => {
    const prev = prevEventStatusRef.current;
    prevEventStatusRef.current = eventsStatus;
    if (activeAgentType && prev !== 'running' && eventsStatus === 'running') {
      refreshNativeAvailable(activeAgentType);
      refreshHandoffMetadata();
    }
    // Refresh again when status flips to 'waiting'. By then the adapter has
    // emitted system/init (native session persisted server-side AND the
    // adapter has written the session file to disk), so /active-agent will report
    // nativeAvailable=true. Without this the badge stays at "session not
    // created yet" for the entire run because the running-transition refresh
    // raced ahead of system/init. Also handles the waiting→unavailable false
    // negative (isRunning now includes 'waiting', but the badge variant still
    // needs nativeAvailable=true to flip green).
    if (activeAgentType && eventsStatus === 'waiting') {
      refreshNativeAvailable(activeAgentType);
    }
  }, [eventsStatus, activeAgentType, refreshNativeAvailable, refreshHandoffMetadata]);

  // Effect 3 — refetch native availability when the server signals the turn
  // is over. currentSessionId is set on session_started and cleared on
  // session_ended (and on WS close); the ID→null transition means the
  // adapter has finished, the session row is committed, and any
  // native_session_id that was persisted during the turn is now readable.
  // This is defense-in-depth alongside Effect 1 (running→done) — it covers
  // adapters that close the WS without emitting a clean status:done event.
  const prevSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevSessionIdRef.current;
    prevSessionIdRef.current = currentSessionId;
    if (prev && !currentSessionId && conversation && activeAgentType) {
      refreshNativeAvailable(activeAgentType);
    }
  }, [currentSessionId, conversation, activeAgentType, refreshNativeAvailable]);

  // Effect 4 — refetch native availability when the adapter emits its first
  // tool_call or interaction_request during a turn. These event types
  // unambiguously prove the agent has bootstrapped (system/init was received
  // and persisted), so /active-agent will report nativeAvailable=true. This
  // closes the race in Effect 2: eventsStatus flips to 'running' on the
  // adapter's pre-spawn status:running emit, BEFORE system/init arrives, so
  // Effect 2's refetch reads stale (nativeAvailable=false) data. Effect 4
  // catches up after the first real per-turn event lands. Idempotent — if
  // nativeAvailable was already true this is a wasted round-trip, not a bug.
  const sawFirstTurnEventRef = useRef(false);
  useEffect(() => {
    if (!conversation || !activeAgentType) { sawFirstTurnEventRef.current = false; return; }
    const hasToolOrInteraction = events.some(
      (e) => e.type === 'tool_call' || e.type === 'interaction_request'
    );
    if (hasToolOrInteraction && !sawFirstTurnEventRef.current) {
      sawFirstTurnEventRef.current = true;
      refreshNativeAvailable(activeAgentType);
    }
    if (!hasToolOrInteraction) {
      sawFirstTurnEventRef.current = false;
    }
  }, [events, conversation, activeAgentType, refreshNativeAvailable]);

  // Reset the recent-completion pulse on conversation switch so opening a
  // different conversation doesn't inherit a stale green from the prior one.
  useEffect(() => {
    setRecentlyCompleted(false);
  }, [conversation?.id]);

  // Reset hasSession on conversation switch (it'll be re-set after the
  // /active-agent fetch in onSelectConversation). And flip it to true
  // whenever a session_started frame arrives for the current conversation —
  // this is what suppresses the badge during the first-turn agent-startup
  // window on a fresh conversation, where activeAgentType is already set
  // optimistically but the adapter hasn't created its session yet.
  useEffect(() => { setHasSession(false); setContextResumable(false); setNativeAvailable(false); }, [conversation?.id]);
  useEffect(() => {
    if (currentSessionId) {
      setHasSession(true);
      setContextResumable(true);
    }
  }, [currentSessionId]);

  // Surface stop failures via alert. Synthetic results (sessionId='') arrive
  // when the user clicks Stop with nothing to stop; server replies carry a
  // sessionId and a reason. Both paths use the same UX.
  useEffect(() => {
    if (stopResult && !stopResult.success) {
      showAlert(stopResult.message ?? 'Failed to stop agent', 'Stop Agent');
      clearStopResult();
    }
  }, [stopResult, clearStopResult, showAlert]);

  // Stop-button disable state. Set on click to absorb double-clicks; cleared
  // by stop_result arrival (success or failure) or after 1.5s as a fallback.
  const [stopRequested, setStopRequested] = useState(false);
  useEffect(() => {
    if (!stopRequested) return;
    const t = setTimeout(() => setStopRequested(false), 1500);
    return () => clearTimeout(t);
  }, [stopRequested]);
  useEffect(() => {
    if (stopResult) setStopRequested(false);
  }, [stopResult]);

  // ── Sidebar state & drawer ────────────────────────────────────────────────
  const SIDEBAR_PINNED_KEY = 'tierwyn:sidebar-pinned';
  const [sidebarPinned, setSidebarPinned] = useState<boolean>(() => {
    try {
      const stored = lsGet(SIDEBAR_PINNED_KEY);
      if (stored !== null) return stored === 'true';
    } catch { /* ignore */ }
    return true;
  });
  /** Pin state while in native fullscreen — kept separate so leaving
   *  fullscreen restores the regular pinned preference. Defaults off
   *  (fullscreen = collapsed) to preserve the old behaviour. */
  const SIDEBAR_PINNED_FS_KEY = 'tierwyn:sidebar-pinned-fullscreen';
  const [sidebarPinnedFs, setSidebarPinnedFs] = useState<boolean>(() => {
    try {
      const stored = lsGet(SIDEBAR_PINNED_FS_KEY);
      if (stored !== null) return stored === 'true';
    } catch { /* ignore */ }
    return false;
  });
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const sidebarHideTimeout = useRef<number | null>(null);

  // ── Native Fullscreen ─────────────────────────────────────────────────────
  const [isFullscreen, setIsFullscreen] = useState(() => Boolean(document.fullscreenElement));

  useEffect(() => {
    const onFullscreenChange = () => {
      const fs = Boolean(document.fullscreenElement);
      setIsFullscreen(fs);
      if (!fs) {
        setSidebarPeek(false);
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    try {
      if (!document.fullscreenElement) {
        await document.documentElement.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    } catch (err) {
      console.error('Fullscreen toggle failed:', err);
    }
  }, []);

  const handleLeftEdgeEnter = useCallback(() => {
    if (sidebarHideTimeout.current) clearTimeout(sidebarHideTimeout.current);
    setSidebarPeek(true);
  }, []);

  const handleSidebarEnter = useCallback(() => {
    if (sidebarHideTimeout.current) clearTimeout(sidebarHideTimeout.current);
    setSidebarPeek(true);
  }, []);

  const [storedSidebarWidth, setStoredSidebarWidth] = useState(() =>
    parseStoredSidebarWidth(lsGet('tierwyn:sidebar-width')),
  );
  const [viewportW, setViewportW] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : 1440,
  );
  const sidebarWidth = clampSidebarWidth(storedSidebarWidth, viewportW);
  const shellRef = useRef<HTMLDivElement>(null);
  const resizingRef = useRef(false);

  useEffect(() => {
    const onResize = () => {
      setViewportW(window.innerWidth);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleSidebarWidthChange = useCallback((newW: number) => {
    setStoredSidebarWidth(newW);
    lsSet('tierwyn:sidebar-width', String(newW));
  }, []);

  const handleSidebarLeave = useCallback(() => {
    if (resizingRef.current) return;
    if (sidebarHideTimeout.current) clearTimeout(sidebarHideTimeout.current);
    sidebarHideTimeout.current = window.setTimeout(() => {
      setSidebarPeek(false);
    }, 280);
  }, []);

  const toggleSidebarPinned = useCallback(() => {
    if (isFullscreen) {
      setSidebarPinnedFs((prev) => {
        const next = !prev;
        lsSet(SIDEBAR_PINNED_FS_KEY, String(next));
        if (!next) {
          setSidebarOpen(false);
          setSidebarPeek(false);
        }
        return next;
      });
      return;
    }
    setSidebarPinned((prev) => {
      const next = !prev;
      lsSet(SIDEBAR_PINNED_KEY, String(next));
      if (!next) {
        setSidebarOpen(false);
        setSidebarPeek(false);
      }
      return next;
    });
  }, [isFullscreen]);

  const sidebarPinnedActive = isFullscreen ? sidebarPinnedFs : sidebarPinned;
  const isSidebarCollapsed = !sidebarPinnedActive;
  const isSidebarDrawerOpen = sidebarOpen || (isSidebarCollapsed && sidebarPeek);
  // ponytail: gates the loading placeholder. Set before the transcript await,
  // cleared in finally. Lives here rather than derived because transcript
  // length isn't knowable until the fetch resolves.
  const [isLoadingTranscript, setIsLoadingTranscript] = useState(false);
  /** Bumped on every conversation select so an in-flight load cannot apply
   *  setEvents / follow-up fetches after the operator has already moved on. */
  const selectGenerationRef = useRef(0);
  // FW-12: set once, right after a transcript loads, when the operator opened the
  // conversation from a content-search hit. OutputPane consumes and clears it.
  const [focusEventId, setFocusEventId] = useState<string | null>(null);
  const [focusQuery, setFocusQuery] = useState<string | null>(null);
  const clearFocusEvent = useCallback(() => {
    setFocusEventId(null);
    setFocusQuery(null);
    if (lastProjectsSelectionRef.current?.type === 'conversation' && lastProjectsSelectionRef.current.focusEvent) {
      lastProjectsSelectionRef.current = { ...lastProjectsSelectionRef.current, focusEvent: undefined };
    }
    if (lastSchedulesSelectionRef.current?.type === 'conversation' && lastSchedulesSelectionRef.current.focusEvent) {
      lastSchedulesSelectionRef.current = { ...lastSchedulesSelectionRef.current, focusEvent: undefined };
    }
  }, []);
  // FW-12 follow-up: ⋮ menu Find increments this so OutputPane opens the bar
  // (phones have no Ctrl/Cmd+F). 0 = never requested this mount.
  const [findOpenTick, setFindOpenTick] = useState(0);

  // FW-16: Global Command Palette (Ctrl/Cmd+K)
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [paletteFocusTick, setPaletteFocusTick] = useState(0);
  const [paletteInitialMode, setPaletteInitialMode] = useState<PaletteMode>('all');
  const [openNewConvTick, setOpenNewConvTick] = useState(0);
  const [targetNewConvProjectId, setTargetNewConvProjectId] = useState<string | null>(null);
  const [requestedSidebarTab, setRequestedSidebarTab] = useState<{ tab: 'projects' | 'schedules'; tick: number } | null>(null);
  const [sidebarRevealTick, setSidebarRevealTick] = useState(0);

  const openCommandPalette = useCallback((mode: PaletteMode = 'all') => {
    // Always open; bump focusTick so a second open re-selects the query
    // (VS Code). Do not put setPaletteFocusTick inside a state updater —
    // StrictMode double-invokes updaters (C3).
    setPaletteInitialMode(mode);
    setCommandPaletteOpen(true);
    setPaletteFocusTick((t) => t + 1);
  }, []);

  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      const msg = isMessageSearchHotkey(e);
      if (!msg && !isPaletteHotkey(e)) return;
      if (shouldIgnoreHotkeyTarget(e.target)) return;

      e.preventDefault();
      e.stopPropagation();
      openCommandPalette(msg ? 'messages' : 'all');
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, [openCommandPalette]);

  // Auto-close the drawer when the viewport widens back to desktop width
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 900px)');
    const handler = (e: MediaQueryListEvent) => {
      if (!e.matches) setSidebarOpen(false);
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  // Close the drawer overlay on Escape
  useEffect(() => {
    if (!sidebarOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [sidebarOpen]);

  type StoredTabSelection =
    | { type: 'conversation'; project: Project; conversation: Conversation; focusEvent?: string }
    | { type: 'schedule_job'; project: Project; jobId: string }
    | { type: 'schedule_calendar'; project: null };

  const lastProjectsSelectionRef = useRef<StoredTabSelection | null>(null);
  const lastSchedulesSelectionRef = useRef<StoredTabSelection | null>(null);

  const onSelectConversation = useCallback(async (
    p: Project,
    c: Conversation,
    focusEvent?: string,
    opts?: { keepSidebarOpen?: boolean; syncSidebarTab?: boolean; focusQuery?: string },
  ) => {
    const gen = ++selectGenerationRef.current;
    const stillCurrent = () => selectGenerationRef.current === gen;

    setSelection({ type: 'conversation', project: p, conversation: c });
    // ponytail: clear immediately so the loading placeholder shows on switch,
    // not the prior conversation's events hanging during the fetch.
    // Must be urgent (not startTransition): a deferred clear raced with WS
    // updates and left every conversation stuck on an empty events array.
    setEvents([]);
    setFocusEventId(null);
    setFocusQuery(null);
    // Drop adapter-tracking state from the prior conversation so a quick send
    // during the transcript fetch can't compare against stale profile/agent ids.
    setActiveAgentType(undefined);
    setLastSessionProfileId(undefined);
    setAllCollapsed(false);
    if (!opts?.keepSidebarOpen) {
      setSidebarOpen(false);
    }
    // Reset the status-tracking refs so Effect 1 (running→done) and Effect 2
    // (*→running) reliably fire for the freshly-loaded conversation. Without
    // this, a stale 'running' carried over from the prior conversation (or
    // from this conversation's own interrupted prior turn) blocks Effect 2's
    // prev !== 'running' guard — the badge stays stale until manual refresh.
    prevStatusRef.current = 'idle';
    prevEventStatusRef.current = 'idle';
    subscribe(c.id);

    const isSchedule = c.kind === 'schedule_home'
      || isScheduleConversation(c.id, directoryRef.current.scheduleTrees);

    if (shouldSyncSidebarTabOnSelect(opts)) {
      if (isSchedule) {
        setRequestedSidebarTab({ tab: 'schedules', tick: Date.now() });
      } else if (Object.keys(directoryRef.current.scheduleTrees).length > 0) {
        // Trees not hydrated yet — Sidebar sync will follow schedule runs once
        // the tree arrives; do not snap to Projects prematurely on boot.
        setRequestedSidebarTab({ tab: 'projects', tick: Date.now() });
      }
    }

    if (isSchedule) {
      lastSchedulesSelectionRef.current = { type: 'conversation', project: p, conversation: c, focusEvent };
      try {
        localStorage.setItem('lastSchedulesType', 'conversation');
        localStorage.setItem('lastSchedulesProjectId', p.id);
        localStorage.setItem('lastSchedulesConversationId', c.id);
      } catch { /* ignore */ }
    } else {
      lastProjectsSelectionRef.current = { type: 'conversation', project: p, conversation: c, focusEvent };
      try {
        localStorage.setItem('lastProjectsProjectId', p.id);
        localStorage.setItem('lastProjectsConversationId', c.id);
      } catch { /* ignore */ }
    }

    try {
      localStorage.setItem('lastProjectId', p.id);
      localStorage.setItem('lastConversationId', c.id);
      localStorage.removeItem('lastScheduleJobId');
    } catch { /* ignore */ }
    setJustForkedConversationId(prev => prev === c.id ? prev : null); // preserve flag when switching INTO the freshly-forked conversation; clear for any unrelated switch
    setSummaryByEventId({}); // clear stale map before async fetches so old summaries don't flash on the new conversation
    setHandoffByAnchorId({});
    setSummaryList([]);
    setHandoffBySummaryId({});
    setSummaryTreeHasSummaries(false);
    setTtsRecordings([]);
    setTtsConvTitles({});
    setShowTtsRecordings(false);
    setCheckpoints([]);
    // The clicked row may be a stale list snapshot (search, activity modal,
    // another device staged it) — re-read fresh conversation state from the server.
    void api.getConversation(c.id).then((fresh) => {
      if (!stillCurrent()) return;
      setSelection((cur) => {
        if (cur?.type !== 'conversation' || cur.conversation.id !== c.id) return cur;
        return { ...cur, conversation: { ...cur.conversation, ...composerSettingsOf(fresh) } };
      });
    }).catch(() => {});
    setIsLoadingTranscript(true);
    loadedTurnsRef.current = TAIL_TURNS;
    const transcriptGen = ++transcriptGenerationRef.current;
    try {
      if (focusEvent) {
        const transcript = await api.transcript(c.id);
        if (!stillCurrent() || transcriptGen !== transcriptGenerationRef.current) return;
        flushEvents();
        setEvents((live) => mergeTranscriptWithLive(transcript as unknown as NormalisedEvent[], live));
        setTranscriptHasMore(false);
        setTranscriptCursor(null);
        loadedTurnsRef.current = Infinity;
      } else {
        const page = await api.transcriptPage(c.id, { tailTurns: TAIL_TURNS });
        if (!stillCurrent() || transcriptGen !== transcriptGenerationRef.current) return;
        flushEvents();
        setEvents((live) => mergeTranscriptWithLive(page.events as unknown as NormalisedEvent[], live));
        setTranscriptHasMore(Boolean(page.hasMore));
        setTranscriptCursor(page.cursor ?? null);
      }
      // MUST be after setEvents: OutputPane resolves the id against the merged turns,
      // so the transcript has to be in state before the id arrives.
      setFocusEventId(focusEvent ?? null);
      setFocusQuery(focusEvent && opts?.focusQuery ? opts.focusQuery : null);
      const summaries = (await api.summaries(c.id)).summaries;
      if (!stillCurrent()) return;
      setSummaryByEventId(Object.fromEntries(summaries.map((s) => [s.last_event_id, s.summary_text])));
      setSummaryList(summaries);
      // If this conversation has no own summaries, probe the spawn tree so
      // the dropdown stays enabled when a parent or sibling has a summary
      // the user could reach via the modal's tree toggle. Avoids the trap
      // where a child with zero summaries gets its Summaries entry locked.
      // (Compaction typically writes at the parent, so this probe often hits.)
      // The WS reconnect path above does NOT probe — it fires after a summary
      // was written to THIS conversation, so summaryList is non-empty and the
      // dropdown gate passes without the tree flag.
      if (summaries.length === 0) {
        try {
          const tree = await api.summaries(c.id, { tree: true });
          if (!stillCurrent()) return;
          setSummaryTreeHasSummaries(tree.summaries.length > 0);
        } catch { /* non-critical — dropdown just stays disabled */ }
      }
      const handoffs = await api.handoffs(c.id);
      if (!stillCurrent()) return;
      setHandoffByAnchorId(Object.fromEntries(handoffs.map((h) => [h.anchor_event_id, h])));
      setHandoffBySummaryId(Object.fromEntries(handoffs.filter((h) => h.summary_id).map((h) => [h.summary_id as string, h])));
      try {
        // Project-scoped list is a superset of conversation + spawn-tree lists.
        const r = await api.listProjectTtsRecordings(p.id);
        if (!stillCurrent()) return;
        setTtsRecordings(r.recordings);
        const map: Record<string, string> = {};
        for (const conv of r.conversations ?? []) map[conv.id] = conv.title;
        setTtsConvTitles(map);
      } catch { /* non-critical */ }
      try {
        const cps = await api.checkpoints(c.id);
        if (!stillCurrent()) return;
        setCheckpoints(cps);
      } catch { /* non-critical */ }
      // Fetch any existing /btw side questions so the header button is enabled
      // immediately on open, not only after the next /btw is fired.
      try {
        const btwQueries = await api.listBtw(c.id);
        if (!stillCurrent()) return;
        setBtwQueries(btwQueries);
      } catch { /* non-critical */ }
      // Fetch pending spawn requests (operator-global queue) so the approval
      // badge reflects every pending request across all conversations.
      try {
        const spawnReqs = await api.listSpawnRequests();
        if (!stillCurrent()) return;
        setSpawnRequests(spawnReqs);
      } catch { /* non-critical */ }
      // On open: no client-side adapter selection yet, so fetch the globally-last
      // session to seed activeAgentType. Once a profile is chosen, handleSend
      // re-fetches with that agentId so the native-availability reflects the
      // adapter the user is actually using.
      const active = await api.activeAgent(c.id);
      if (!stillCurrent()) return;
      setNativeAvailable(active.nativeAvailable);
      setContextResumable(active.contextResumable ?? false);
      // Track whether a session already exists for this conversation so the
      // native-session badge doesn't render "unavailable" during the
      // agent-startup window on the first turn of a fresh conversation.
      setHasSession(!!active.lastSession);
      setActiveAgentType(active.lastSession?.agentId);
      // Seed profile: an unsent pick persisted on the draft row wins — it is
      // newer than the last sent turn and survives app restarts (cross-device
      // model persistence). Then last session's agent, then default, then blank.
      // NOTE: this seed lands AFTER InputBar's own draft GET has applied the
      // same persisted pick — seeding from lastSession here would clobber it
      // (the "picker reverts on conversation open" bug).
      const draftRow = await api.getDraft(c.id).catch(() => null);
      if (!stillCurrent()) return;
      const isRemote = isRemoteAgentsProject(c.projectId);
      const seedProfile = isRemote
        ? (active.lastSession?.agentModelId ?? (draftRow?.profileId?.startsWith('grok-bot:') ? draftRow.profileId : ''))
        : (draftRow?.profileId ?? active.lastSession?.agentModelId ?? defaultConversationProfileId ?? '');
      setSelectedProfileId(seedProfile);
      setLastSessionProfileId(active.lastSession?.agentModelId);
      if (isRemote && (!seedProfile || !profiles.some((p) => p.id === seedProfile))) {
        refreshProfiles();
      }
    } catch (err) {
      if (!stillCurrent()) return;
      if (err instanceof UnauthorizedError) onDeauthenticate();
    } finally {
      if (stillCurrent()) setIsLoadingTranscript(false);
    }
  }, [subscribe, setEvents, flushEvents, onDeauthenticate, defaultConversationProfileId, profiles, refreshProfiles]);

  const selectConversationById = useCallback(async (cid: string) => {
    try {
      const target = await api.getConversation(cid);
      const projects = await api.listProjects();
      const p = projects.find((proj) => proj.id === target.projectId);
      if (!p) return;
      setSidebarRevealTick((t) => t + 1);
      await onSelectConversation(p, target);
    } catch {
      /* garbage id or deleted conversation: silent no-op */
    }
  }, [onSelectConversation]);
  selectConversationByIdRef.current = (id) => { void selectConversationById(id); };

  const handleSelectProjectFromPalette = useCallback((p: Project) => {
    const convs = directoryRef.current.conversations[p.id] ?? [];
    if (convs.length > 0) {
      const sorted = [...convs].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      setSidebarRevealTick((t) => t + 1);
      void onSelectConversation(p, sorted[0]);
    } else {
      setTargetNewConvProjectId(p.id);
      setOpenNewConvTick((t) => t + 1);
      setSidebarOpen(true);
    }
  }, [onSelectConversation]);

  useEffect(() => {
    const cid = new URLSearchParams(window.location.search).get('c');
    if (!cid) return;
    window.history.replaceState({}, '', window.location.pathname);
    void selectConversationById(cid);
  }, [selectConversationById]);

  useEffect(() => {
    const sw = navigator.serviceWorker;
    if (!sw) return;
    const handler = (e: MessageEvent) => {
      const data = e.data as { type?: string; conversationId?: string } | null;
      if (!data || data.type !== 'tierwyn:navigate' || typeof data.conversationId !== 'string') return;
      void selectConversationById(data.conversationId);
    };
    sw.addEventListener('message', handler);
    return () => sw.removeEventListener('message', handler);
  }, [selectConversationById]);

  const onConversationDeleted = useCallback((deletedId: string | string[]) => {
    const ids = Array.isArray(deletedId) ? deletedId : [deletedId];
    if (conversation && ids.includes(conversation.id)) {
      setSelection(null);
      setEvents([]);
      setSummaryByEventId({});
      setHandoffByAnchorId({});
      setNativeAvailable(false);
      setActiveAgentType(undefined);
      setLastSessionProfileId(undefined);
      setShowUsage(false);
      setIsLoadingTranscript(false);
      try {
        localStorage.removeItem('lastProjectId');
        localStorage.removeItem('lastConversationId');
        localStorage.removeItem('lastScheduleJobId');
      } catch { /* ignore */ }
    }
  }, [conversation, setEvents]);
  remoteDeletedRef.current = (ids) => {
    const selectedId = selectedConversationIdRef.current;
    if (selectedId && ids.includes(selectedId)) {
      onConversationDeleted(ids);
      setRemoteDeleteToast('This conversation was deleted on another device.');
    }
  };

  const onConversationRenamed = useCallback((updated: Conversation) => {
    // Patch the selected conversation in place — no transcript refetch,
    // no event clearing. Title in the header reads from selection.conversation.
    // FW-10 follow-up: a cross-project move must also rebind selection.project.
    // dispatchPrompt / handleSend send project.id (not conversation.projectId),
    // so leaving the old Project object here makes the next send (including
    // Repeat) launch under the source project's cwd while the row lives in the
    // destination — the stale-workdir / wrong-session failure mode.
    const moved =
      conversation?.id === updated.id
      && project != null
      && updated.projectId !== project.id;

    setSelection((cur) => {
      if (cur?.type !== 'conversation') return cur;
      if (cur.conversation.id !== updated.id) return cur;
      if (updated.projectId === cur.project.id) {
        return { ...cur, conversation: updated };
      }
      const nextProject =
        directoryRef.current.projects.find((p) => p.id === updated.projectId)
        ?? null;
      if (!nextProject) {
        // Directory not yet refreshed — keep the conversation patch and fetch
        // the destination project below so selection.project catches up.
        return { ...cur, conversation: updated };
      }
      try {
        localStorage.setItem('lastProjectId', nextProject.id);
        localStorage.setItem('lastConversationId', updated.id);
      } catch { /* ignore */ }
      return { ...cur, project: nextProject, conversation: updated };
    });

    if (moved) {
      // Native resume was cleared server-side on move; drop client adapter
      // tracking so the next send does not treat this as a same-session continue.
      setActiveAgentType(undefined);
      setLastSessionProfileId(undefined);
      // If directoryRef lagged (rare — e.g. edit opened before first sidebar
      // hydrate finished), resolve the destination project from the API.
      if (!directoryRef.current.projects.some((p) => p.id === updated.projectId)) {
        void api.listProjects().then((projects) => {
          const nextProject = projects.find((p) => p.id === updated.projectId);
          if (!nextProject) return;
          setSelection((cur) => {
            if (cur?.type !== 'conversation') return cur;
            if (cur.conversation.id !== updated.id) return cur;
            if (cur.project.id === nextProject.id) return cur;
            try {
              localStorage.setItem('lastProjectId', nextProject.id);
            } catch { /* ignore */ }
            return { ...cur, project: nextProject };
          });
        }).catch(() => {});
      }
    }
  }, [conversation?.id, project]);

  const handlePermissionModeChange = useCallback((mode: InteractionMode | null) => {
    if (!conversation) return;
    void api.updateConversation(conversation.id, { permissionMode: mode })
      .then((updated) => {
        setSelection((cur) => {
          if (cur?.type !== 'conversation' || cur.conversation.id !== updated.id) return cur;
          return { ...cur, conversation: { ...cur.conversation, permissionMode: updated.permissionMode } };
        });
      })
      .catch((err) => {
        console.error('Failed to update permission mode:', err);
      });
  }, [conversation]);

  const handleSandboxChange = useCallback((v: SandboxSetting | null) => {
    if (!conversation) return;
    void api.updateConversation(conversation.id, { sandbox: v })
      .then((updated) => {
        setSelection((cur) => {
          if (cur?.type !== 'conversation' || cur.conversation.id !== updated.id) return cur;
          return { ...cur, conversation: { ...cur.conversation, sandbox: updated.sandbox } };
        });
        // Patch directoryRef so switching away and back does not revert to the
        // stale sandbox value from the sidebar's conversation list snapshot.
        const pid = updated.projectId;
        const patched = patchConversationInList(directoryRef.current.conversations[pid], { id: updated.id, sandbox: updated.sandbox ?? undefined });
        if (patched && patched !== directoryRef.current.conversations[pid]) {
          directoryRef.current = { ...directoryRef.current, conversations: { ...directoryRef.current.conversations, [pid]: patched } };
        }
      })
      .catch((err) => {
        console.error('Failed to update sandbox:', err);
      });
  }, [conversation]);

  const handleMcpServersChange = useCallback((mcpServers: string[] | null) => {
    setSelection((cur) => {
      if (cur?.type !== 'conversation') return cur;
      return {
        ...cur,
        conversation: {
          ...cur.conversation,
          mcpServers: mcpServers ?? undefined,
        },
      };
    });
  }, []);

  const onScheduleJobDeleted = useCallback((jobId: string, deletedConversationIds: string[]) => {
    if (selection?.type === 'schedule_job' && selection.jobId === jobId) {
      setSelection(null);
      try { localStorage.removeItem('lastScheduleJobId'); } catch { /* ignore */ }
    }
    if (conversation && deletedConversationIds.includes(conversation.id)) {
      onConversationDeleted(deletedConversationIds);
    }
    setScheduleRefetchTrigger((n) => n + 1);
    setSidebarRefetchTrigger((n) => n + 1);
  }, [selection, conversation, onConversationDeleted]);

  const onScheduleJobArchived = useCallback((jobId: string) => {
    if (selection?.type === 'schedule_job' && selection.jobId === jobId) {
      setSelection(null);
      try { localStorage.removeItem('lastScheduleJobId'); } catch { /* ignore */ }
    }
    setScheduleRefetchTrigger((n) => n + 1);
    setSidebarRefetchTrigger((n) => n + 1);
  }, [selection]);

  const onProjectDeleted = useCallback((deletedId: string) => {
    if (project?.id === deletedId) {
      setSelection(null);
      setEvents([]);
      setSummaryByEventId({});
      setHandoffByAnchorId({});
      setNativeAvailable(false);
      setActiveAgentType(undefined);
      setLastSessionProfileId(undefined);
      setShowUsage(false);
      setIsLoadingTranscript(false);
      try {
        localStorage.removeItem('lastProjectId');
        localStorage.removeItem('lastConversationId');
        localStorage.removeItem('lastScheduleJobId');
      } catch { /* ignore */ }
    }
  }, [project]);

  /** Select a schedule job → Schedule browser main pane (never open home as chat). */
  const onSelectScheduleJob = useCallback((
    p: Project,
    jobId: string,
    opts?: { keepSidebarOpen?: boolean },
  ) => {
    setSelection({ type: 'schedule_job', project: p, jobId });
    setEvents([]);
    setActiveAgentType(undefined);
    if (!opts?.keepSidebarOpen) {
      setSidebarOpen(false);
    }
    lastSchedulesSelectionRef.current = { type: 'schedule_job', project: p, jobId };
    try {
      localStorage.setItem('lastSchedulesType', 'job');
      localStorage.setItem('lastSchedulesProjectId', p.id);
      localStorage.setItem('lastSchedulesJobId', jobId);
    } catch { /* ignore */ }
    // Project-scoped recordings remain available while browsing a schedule job.
    void (async () => {
      try {
        const r = await api.listProjectTtsRecordings(p.id);
        setTtsRecordings(r.recordings);
        const map: Record<string, string> = {};
        for (const conv of r.conversations ?? []) map[conv.id] = conv.title;
        setTtsConvTitles(map);
      } catch { /* non-critical */ }
    })();
    setLastSessionProfileId(undefined);
    setNativeAvailable(false);
    setHasSession(false);
    setShowUsage(false);
    setIsLoadingTranscript(false);
    setSummaryByEventId({});
    setHandoffByAnchorId({});
    setBtwQueries([]);
    try {
      localStorage.setItem('lastProjectId', p.id);
      localStorage.setItem('lastScheduleJobId', jobId);
      localStorage.removeItem('lastConversationId');
    } catch { /* ignore */ }
  }, [setEvents]);

  /**
   * Open the full-window schedule calendar, unconditionally — Calendar row and
   * palette action. Explicit opens win even over a drilled-in schedule job:
   * the row is the only way back to the calendar after selecting a job (D4b).
   * Stable identity — Sidebar's requestedMainTab effect depends on setMainTab (D13).
   */
  const openScheduleCalendar = useCallback((opts?: { keepSidebarOpen?: boolean }) => {
    setSelection({ type: 'schedule_calendar', project: null });
    setEvents([]);
    if (!opts?.keepSidebarOpen) {
      setSidebarOpen(false);
    }
    lastSchedulesSelectionRef.current = { type: 'schedule_calendar', project: null };
    try {
      localStorage.setItem('lastSchedulesType', 'calendar');
    } catch { /* ignore */ }
  }, [setEvents]);

  /**
   * Tab-switch handler: restores the last selected item for each tab (conversations,
   * schedule jobs, subagent conversations, or calendar) instead of resetting to calendar.
   */
  const onMainTabChange = useCallback((tab: 'projects' | 'schedules') => {
    if (tab === 'projects') {
      const prev = lastProjectsSelectionRef.current;
      if (prev && prev.type === 'conversation') {
        if (isScheduleConversation(prev.conversation.id, directoryRef.current.scheduleTrees)
          || prev.conversation.kind === 'schedule_home') {
          // Stale last-projects pointer at a schedule run — leave the tab switch alone.
        } else if (selection?.type === 'conversation' && selection.conversation.id === prev.conversation.id) {
          return;
        } else {
          void onSelectConversation(prev.project, prev.conversation, prev.focusEvent, TAB_RESTORE_OPTS);
          return;
        }
      }
      try {
        const ids = projectsTabRestoreIds({
          lastProjectsProjectId: localStorage.getItem('lastProjectsProjectId'),
          lastProjectsConversationId: localStorage.getItem('lastProjectsConversationId'),
        });
        if (ids) {
          const p = directoryRef.current.projects.find((proj) => proj.id === ids.pid);
          const c = (directoryRef.current.conversations[ids.pid] ?? []).find((conv) => conv.id === ids.cid);
          if (p && c && c.kind !== 'schedule_home'
            && !isScheduleConversation(c.id, directoryRef.current.scheduleTrees)) {
            if (selection?.type === 'conversation' && selection.conversation.id === c.id) return;
            void onSelectConversation(p, c, undefined, TAB_RESTORE_OPTS);
            return;
          }
        }
      } catch { /* ignore */ }
    } else if (tab === 'schedules') {
      const prev = lastSchedulesSelectionRef.current;
      if (prev) {
        if (prev.type === 'conversation') {
          if (selection?.type === 'conversation' && selection.conversation.id === prev.conversation.id) {
            return;
          }
          void onSelectConversation(prev.project, prev.conversation, prev.focusEvent, TAB_RESTORE_OPTS);
          return;
        } else if (prev.type === 'schedule_job') {
          if (selection?.type === 'schedule_job' && selection.jobId === prev.jobId) {
            return;
          }
          onSelectScheduleJob(prev.project, prev.jobId, { keepSidebarOpen: true });
          return;
        } else if (prev.type === 'schedule_calendar') {
          if (selection?.type === 'schedule_calendar') {
            return;
          }
          openScheduleCalendar({ keepSidebarOpen: true });
          return;
        }
      }
      try {
        const sType = localStorage.getItem('lastSchedulesType');
        const sPid = localStorage.getItem('lastSchedulesProjectId');
        const sJobId = localStorage.getItem('lastSchedulesJobId');
        const sCid = localStorage.getItem('lastSchedulesConversationId');
        if (sType === 'job' && sPid && sJobId) {
          const p = directoryRef.current.projects.find((proj) => proj.id === sPid);
          const tree = directoryRef.current.scheduleTrees[sPid];
          const hasJob = !tree || tree.jobs.some((entry) => entry.job.id === sJobId);
          if (p && hasJob) {
            if (selection?.type === 'schedule_job' && selection.jobId === sJobId) return;
            onSelectScheduleJob(p, sJobId, { keepSidebarOpen: true });
            return;
          }
        } else if (sType === 'conversation' && sPid && sCid) {
          const p = directoryRef.current.projects.find((proj) => proj.id === sPid);
          // Projects-tab `conversations` omits schedule-tree rows; look in the tree.
          const c = findScheduleTreeConversation(
            directoryRef.current.scheduleTrees[sPid],
            sCid,
          );
          if (p && c) {
            if (selection?.type === 'conversation' && selection.conversation.id === c.id) return;
            void onSelectConversation(p, c, undefined, TAB_RESTORE_OPTS);
            return;
          }
        }
      } catch { /* ignore */ }
      if (selection?.type !== 'schedule_calendar') {
        openScheduleCalendar({ keepSidebarOpen: true });
      }
    }
  }, [selection, onSelectConversation, onSelectScheduleJob, openScheduleCalendar]);

  const handleForkConversation = useCallback((eventId: string) => {
    if (!conversation || !project) return;
    setPendingFork({ eventId, title: `Fork of ${conversation.title}` });
  }, [conversation, project]);

  const refetchAfterRewind = useCallback(async () => {
    if (!conversation) return;
    const [page, cps] = await Promise.all([
      loadTranscriptTail(conversation.id),
      api.checkpoints(conversation.id),
    ]);
    if (page) {
      setCheckpoints(cps);
    }
    setShowCheckpointList(false);
  }, [conversation, loadTranscriptTail]);

  const checkpointByEventId = useMemo(
    () => Object.fromEntries(checkpoints.map((c) => [c.eventId, c])),
    [checkpoints],
  );

  const confirmFork = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pendingFork || !conversation || !project) return;
    try {
      const forked = await api.forkConversation(conversation.id, pendingFork.eventId, pendingFork.title.trim() || undefined);
      setPendingFork(null);
      setSidebarRefetchTrigger(prev => prev + 1);
      setJustForkedConversationId(forked.id);
      onSelectConversation(project, forked);
    } catch (err) {
      showAlert(`Fork conversation failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    }
  }, [pendingFork, conversation, project, onSelectConversation, showAlert]);

  // FW-13: duplicate the OPEN conversation from the header ⋯ menu. Distinct
  // from "Copy conversation" (clipboard markdown) right above it in the menu.
  const handleDuplicateConversation = useCallback(() => {
    if (!conversation || !project) return;
    setDuplicateConfirmConv(conversation);
  }, [conversation, project]);

  const submitDuplicateConversation = async () => {
    if (!duplicateConfirmConv || !project) return;
    setDuplicateBusy(true);
    try {
      const copy = await api.duplicateConversation(duplicateConfirmConv.id);
      setSidebarRefetchTrigger((prev) => prev + 1);
      onSelectConversation(project, copy);
      setDuplicateConfirmConv(null);
    } catch (err) {
      showAlert(`Duplicate conversation failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    } finally {
      setDuplicateBusy(false);
    }
  };

  // Copy a BTW answer to the clipboard.
  const handleCopyBtw = useCallback((q: BtwQuery) => {
    if (!q.answer) return;
    void copyText(q.answer);
  }, []);

  // Fork a BTW answer into a new sidebar conversation. The BTW child already
  // holds the Q&A as its transcript; fork it from its last event so the new
  // conversation starts with the full exchange ready to continue.
  const handleForkBtw = useCallback(async (q: BtwQuery) => {
    if (!project) return;
    try {
      const forked = await api.forkBtw(q.parentConvId, q.id);
      setSidebarRefetchTrigger(prev => prev + 1);
      setBtwPopupQueryId(null);
      onSelectConversation(project, forked);
    } catch (err) {
      showAlert(`Fork BTW failed: ${err instanceof Error ? err.message : String(err)}`, 'Error');
    }
  }, [project, onSelectConversation, showAlert]);

  // Open a conversation by id (spawn child). A child may be an ordinary chat
  // child or part of a schedule tree, so we fetch it directly by id.
  const openConversationById = useCallback(async (conversationId: string) => {
    try {
      const target = await api.getConversation(conversationId);
      let p = project?.id === target.projectId ? project : undefined;
      if (!p) {
        const projects = await api.listProjects();
        p = projects.find((proj) => proj.id === target.projectId);
      }
      if (!p) return;
      setSidebarRefetchTrigger((prev) => prev + 1);
      setSidebarRevealTick((t) => t + 1);
      await onSelectConversation(p, target, undefined, { syncSidebarTab: true });
    } catch {
      /* deleted conversation or network error */
    }
  }, [project, onSelectConversation]);

  // Open the manual add subagent modal.
  const openAddSubagentModal = useCallback(() => {
    setShowAddSubagentModal(true);
  }, []);

  const askBtw = useCallback((question: string) => {
    if (!conversation) return;
    if (btwUnavailable) {
      showAlert(btwUnavailable, 'BTW');
      return;
    }
    const optimisticId = `optimistic-${Date.now()}`;
    setBtwQueries((prev) => [{
      id: optimisticId, parentConvId: conversation.id, childConvId: null, forkedConvId: null,
      question, answer: null, status: 'asking' as const, agentId: '', model: null,
      errorMessage: null, createdAt: Date.now(), completedAt: null,
    }, ...prev]);
    setBtwPopupQueryId(optimisticId);
    api.askBtw(conversation.id, question)
      .then((resp) => {
        setBtwQueries((prev) => prev.map((q) =>
          q.id === optimisticId ? { ...q, id: resp.id } : q,
        ));
        setBtwPopupQueryId(resp.id);
        return api.listBtw(conversation.id);
      })
      .then(setBtwQueries)
      .catch((err) => {
        setBtwQueries((prev) => prev.map((q) =>
          q.id === optimisticId
            ? { ...q, status: 'error' as const, errorMessage: String(err) }
            : q,
        ));
      });
  }, [conversation, btwUnavailable, showAlert]);

  const handleRepeatQuestion = useCallback((
    promptText: string,
    eventIdsToDelete: string[],
    attachments?: { base64: string; mediaType: string; name?: string }[],
  ) => {
    if (eventIdsToDelete.length === 0) return;
    Promise.all(eventIdsToDelete.map(id => api.deleteEvent(id))).then(() => {
      const toRemove = new Set(eventIdsToDelete);
      setEvents(events.filter(e => e.id ? !toRemove.has(e.id) : true));
      // setText commits the draft (server sync) and focuses the field.
      // Always pass attachments (possibly []) so Repeat restores the original
      // thumbs instead of leaving whatever was already in the composer.
      inputBarRef.current?.setText(promptText, attachments ?? []);
    }).catch(err => {
      showAlert("Failed to repeat question / delete event(s): " + (err instanceof Error ? err.message : String(err)), 'Error');
    });
  }, [events, setEvents, showAlert]);

  const handleProfileChange = useCallback((profileId: string, opts?: { persist?: boolean }) => {
    const conv = conversationRef.current;
    if (conv?.projectId === REMOTE_AGENTS_PROJECT_ID) return;
    setSelectedProfileId(profileId);
    // Write-through: persist the pick on the draft row immediately (text and
    // attachments are preserved server-side when omitted). Without this, the
    // server holds a superseded profile and any draft GET re-applies it,
    // reverting the picker — the revert-loop bug.
    // ponytail: read the conversation from the ref, not the closure. InputBar
    // now ref-reads this callback so identity churn cannot re-GET the draft.
    // persist:false = server already has this profile (GET seed / peer frame).
    // Re-PUT would broadcast the stored text — empty on a fresh draft — and
    // wipe in-progress typing after the debounce timer has fired.
    if (opts?.persist !== false) {
      const conv = conversationRef.current;
      if (conv) {
        api.putDraft(conv.id, undefined, undefined, profileId).catch(() => {});
      }
    }
    // Refetch native-availability scoped to the selected adapter so the header
    // indicator stays accurate. NOTE: we deliberately do NOT setActiveAgentType
    // here — that state tracks the LAST COMPLETED turn's adapter, which is what
    // handleSend needs to detect a cross-adapter switch for the prompt-mode
    // handoff modal. Overwriting it on the dropdown change would erase the "from"
    // side of the comparison and the modal would never fire.
    refreshNativeAvailable(profileId.split(':')[0]);
  }, [refreshNativeAvailable]);

  // When handoffMode='prompt' and the user sends under a different profile than
  // the prior turn, we stash the prompt and pop a modal so they can pick
  // Summarize vs Pass-full-transcript per handoff. The pending ref holds the
  // captured args until the user decides (or cancels).

  const notConnectedNotice = useCallback(() =>
    showAlert('Not connected to the server — your message is still in the composer. Reconnecting…', 'Not connected'), [showAlert]);

  const dispatchPrompt = useCallback((
    text: string, profileId: string, agent: string, model: string,
    attachments: { base64: string; mediaType: string; name?: string }[],
    handoffOverride?: HandoffOverride,
  ) => {
    if (!project || !conversation) { showAlert('Select a conversation first', 'Notice'); return false; }
    if (!isSocketOpen()) { notConnectedNotice(); return false; }
    setSelectedProfileId(profileId);
    setActiveAgentType(agent);
    // Track the profile we just sent under so the NEXT cross-adapter switch
    // has an accurate "from" label. This deliberately fires BEFORE the WS
    // round-trip — if the turn fails server-side, the next send still needs
    // to know what the user *intended* the prior adapter to be, and a stale
    // "from" label is a cosmetic issue, not a correctness one.
    setLastSessionProfileId(profileId);
    // Reset the status-tracking refs so the upcoming turn's running event is
    // detected as a transition (prev='idle' → current='running') even when the
    // previous turn was interrupted before reaching done/error and left the
    // ref pinned at 'running'. Without this, Effect 2's prev !== 'running'
    // guard would block the authoritative native-availability refetch.
    prevStatusRef.current = 'idle';
    prevEventStatusRef.current = 'idle';
    // Optimistically confirm current native-availability for the chosen adapter
    // at send time. The authoritative refresh fires when the adapter reports
    // running (Effect 2), once its native_session_id is persisted server-side.
    refreshNativeAvailable(agent);
    const sentEffort = resolveEffortForModel(agent, model, effort);
    if (sentEffort) setActiveSessionEffort(sentEffort);
    let sentOptions: PromptOptions | undefined;
    try {
      sentOptions = sanitisePromptOptions(agent, promptOptions);
    } catch (err) {
      showAlert(err instanceof Error ? err.message : String(err), 'Prompt Options Error');
      return false;
    }
    if (!sendPrompt({
      projectId: project.id, conversationId: conversation.id, profileId, agent, model, text, attachments, handoffOverride,
      ...(sentEffort ? { effort: sentEffort } : {}),
      ...(sentOptions ? { options: sentOptions } : {}),
    })) {
      notConnectedNotice();
      return false;
    }
    if (!promptOptionsSticky) {
      setPromptOptions({});
    }
    setOptionsClearedBanner(null);
    return true;
  }, [project, conversation, isSocketOpen, notConnectedNotice, sendPrompt, refreshNativeAvailable, effort, showAlert, promptOptions, promptOptionsSticky]);

  const dispatchCommand = useCallback((
    name: string, args: string | undefined, profileId: string, agent: string, model: string,
    handoffOverride?: HandoffOverride,
    attachments: { base64: string; mediaType: string; name?: string }[] = [],
  ) => {
    if (!project || !conversation) { showAlert('Select a conversation first', 'Notice'); return false; }
    if (!isSocketOpen()) { notConnectedNotice(); return false; }
    const unsupported = slashCommandUnsupportedMessage(agent);
    if (unsupported) {
      showAlert(unsupported, 'Unsupported Command');
      return false;
    }
    setSelectedProfileId(profileId);
    setActiveAgentType(agent);
    setLastSessionProfileId(profileId);
    prevStatusRef.current = 'idle';
    prevEventStatusRef.current = 'idle';
    refreshNativeAvailable(agent);
    const sentEffort = resolveEffortForModel(agent, model, effort);
    if (sentEffort) setActiveSessionEffort(sentEffort);
    let sentOptions: PromptOptions | undefined;
    const strippedOptions = stripCommandIncompatibleOptions(promptOptions);
    try {
      sentOptions = sanitisePromptOptions(agent, strippedOptions);
    } catch (err) {
      showAlert(err instanceof Error ? err.message : String(err), 'Prompt Options Error');
      return false;
    }
    if (!sendCommand({
      projectId: project.id,
      conversationId: conversation.id,
      profileId,
      agent,
      model,
      name,
      args,
      attachments,
      handoffOverride,
      ...(sentEffort ? { effort: sentEffort } : {}),
      ...(sentOptions ? { options: sentOptions } : {}),
    })) {
      notConnectedNotice();
      return false;
    }
    if (!promptOptionsSticky) {
      setPromptOptions({});
    }
    setOptionsClearedBanner(null);
    return true;
  }, [project, conversation, isSocketOpen, notConnectedNotice, sendCommand, refreshNativeAvailable, effort, showAlert, promptOptions, promptOptionsSticky]);

  const handleLogout = useCallback(async () => {
    await auth.logout().catch(() => {});
    onDeauthenticate();
  }, [onDeauthenticate]);

  const handleCopyConversationChoose = useCallback((mode: ConversationCopyMode) => {
    const text = formatConversationCopy(events, mode);
    copyText(text).then(() => {
      setCopiedConv(true);
      setTimeout(() => setCopiedConv(false), 2000);
    }).catch(() => {});
    setShowCopyConversationModal(false);
  }, [events]);

  const chatProfiles = useMemo(
    () => filterProfilesForProjectChats(profiles, {
      projectId: conversation?.projectId ?? project?.id,
      grokBotInProjectChats,
      grokBotStatus,
    }),
    [profiles, conversation?.projectId, project?.id, grokBotInProjectChats, grokBotStatus],
  );

  const selectedProfile = useMemo(
    () => resolveConversationProfile(
      chatProfiles,
      selectedProfileId,
      conversation?.projectId,
      lastSessionProfileId,
      conversation?.title,
    ),
    [chatProfiles, selectedProfileId, conversation?.projectId, lastSessionProfileId, conversation?.title],
  );

  const grokBotEnabled = grokBotEnabledFromProfiles(profiles, profilesLoaded);
  const grokChat = isGrokBotChat(conversation, selectedProfile, {
    lastSessionProfileId,
    selectedProfileId: selectedProfile?.id,
  }, profiles);
  const grokBotBanner = statusBanner(grokBotStatus, { enabled: grokBotEnabled, isGrokChat: grokChat });

  useEffect(() => {
    if (!grokBotEnabled) { setGrokBotStatus(null); return; }
    if (connState !== 'connected') return;
    void api.getGrokBotStatus().then((s) => setGrokBotStatus((prev) => applyGrokBotStatus(prev, s))).catch(() => {});
  }, [grokBotEnabled, connState]);

  useEffect(() => {
    if (connState !== 'connected') return;
    void api.listRemoteHosts().then(setRemoteHosts).catch(() => {});
  }, [connState]);

  useEffect(() => {
    if (connState !== 'connected') return;
    void api.getSandboxSupport().then(setSandboxSupport).catch(() => {});
  }, [connState, catalogueVersion]);

  const hostForCurrent = useMemo(() => {
    const id = project?.remoteHostId;
    if (!id) return undefined;
    return remoteHosts.find((h) => h.id === id);
  }, [project?.remoteHostId, remoteHosts]);
  const sandboxState = useMemo(
    () => sandboxControlState({
      agentType: selectedProfile?.agentType,
      conv: conversation?.sandbox,
      project: project?.sandbox,
      settings: sandboxSettings,
      hostId: project?.remoteHostId ?? 'hub',
      supportedAgents: sandboxSupport.supportedAgents,
      hubAvailable: sandboxSupport.hubAvailable,
      remote: !!project?.remoteHostId,
      hostHello: hostForCurrent?.hello,
    }),
    [
      selectedProfile?.agentType,
      conversation?.sandbox,
      project?.sandbox,
      project?.remoteHostId,
      sandboxSettings,
      sandboxSupport.supportedAgents,
      sandboxSupport.hubAvailable,
      hostForCurrent?.hello,
    ],
  );
  const unavailableProfiles = useMemo(
    () => remoteProfileAvailability(chatProfiles, hostForCurrent),
    [chatProfiles, hostForCurrent],
  );

  useEffect(() => {
    if (!grokChat || !grokBotEnabled) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - grokOnDemandAtRef.current < 60_000) return;
    grokOnDemandAtRef.current = now;
    void api.startGrokBot('on-demand').then(() => api.getGrokBotStatus().then((s) => setGrokBotStatus((prev) => applyGrokBotStatus(prev, s)))).catch(() => {});
  }, [conversation?.id, selectedProfile?.id, grokChat, grokBotEnabled]);

  const effortLevels = useMemo(
    () => pickerEffortLevels(selectedProfile),
    [selectedProfile],
  );
  const effectiveEffort = useMemo(
    () => resolveEffortForModel(selectedProfile?.agentType, selectedProfile?.model, effort),
    [selectedProfile?.agentType, selectedProfile?.model, effort],
  );
  const handleEffortChange = useCallback((level: EffortPreference) => {
    setDefaultEffort(level);
    try { localStorage.setItem('effort', level); } catch { /* ignore */ }
    if (!conversation) return;
    const cid = conversation.id;
    setSelection((cur) => (cur?.type === 'conversation' && cur.conversation.id === cid
      ? { ...cur, conversation: { ...cur.conversation, effort: level } }
      : cur));
    api.updateConversation(cid, { effort: level }).catch((err) => {
      console.error('Failed to save effort:', err);
    });
  }, [conversation]);

  // B3: while a long-lived session is live, show whether the selected level
  // matches the session-bound level or only applies next session.
  const effortSessionState: EffortSessionState = useMemo(() => {
    const agentType = selectedProfile?.agentType;
    if (!agentType || effortLevels.length === 0) return 'immediate';
    if (!LONG_LIVED_EFFORT_ADAPTERS.has(agentType)) return 'immediate';
    const sessionLive = !!currentSessionId || isRunning;
    if (!sessionLive || activeSessionEffort === undefined) return 'immediate';
    return activeSessionEffort === effectiveEffort ? 'active' : 'next-session';
  }, [selectedProfile?.agentType, effortLevels.length, currentSessionId, isRunning, activeSessionEffort, effectiveEffort]);

  // Clear session-bound effort when the live session ends.
  useEffect(() => {
    if (!currentSessionId && !isRunning) {
      setActiveSessionEffort(undefined);
    }
  }, [currentSessionId, isRunning]);

  const promptOptionDescriptors = useMemo(
    () => promptOptionsFor(selectedProfile?.agentType),
    [selectedProfile?.agentType],
  );
  const [stagedPromptOptions, stagedPromptOptionsError] = useMemo(() => {
    try {
      return [sanitisePromptOptions(selectedProfile?.agentType, promptOptions) ?? {}, null] as const;
    } catch (err) {
      return [promptOptions, err instanceof Error ? err.message : String(err)] as const;
    }
  }, [selectedProfile?.agentType, promptOptions]);
  const stagedPromptOptionCount = Object.keys(stagedPromptOptions).length;

  // Load sticky/one-shot bags when conversation or agent changes. Warn only when
  // unsaved non-sticky staged values are dropped by an agent switch.
  useEffect(() => {
    const agentType = selectedProfile?.agentType;
    const prevAgent = prevAgentTypeRef.current;
    const outgoingWasLossy =
      Boolean(prevAgent) &&
      Boolean(agentType) &&
      prevAgent !== agentType &&
      !prevStickyRef.current &&
      Object.keys(prevOptionsRef.current).length > 0;

    if (!conversation?.id || !agentType) {
      setPromptOptions({});
      setPromptOptionsSticky(false);
      prevAgentTypeRef.current = agentType;
      prevStickyRef.current = false;
      prevOptionsRef.current = {};
      return;
    }

    if (outgoingWasLossy) {
      const prevLabel = profiles.find((p) => p.agentType === prevAgent)?.label ?? prevAgent;
      const nextLabel = selectedProfile?.label ?? agentType;
      const msg = `${prevLabel} prompt options were cleared because the agent was changed to ${nextLabel}.`;
      setOptionsClearedBanner(msg);
      if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = setTimeout(() => {
        setOptionsClearedBanner(null);
      }, 4000);
    } else {
      setOptionsClearedBanner(null);
    }

    const entry = loadSticky(conversation.id, agentType);
    setPromptOptions(entry.options);
    setPromptOptionsSticky(entry.sticky);
    prevAgentTypeRef.current = agentType;
    prevStickyRef.current = entry.sticky;
    prevOptionsRef.current = entry.options;
  }, [conversation?.id, selectedProfile?.agentType, selectedProfile?.label, profiles]);

  // Keep refs in sync so the load effect can detect lossy agent switches.
  useEffect(() => {
    prevStickyRef.current = promptOptionsSticky;
    prevOptionsRef.current = promptOptions;
  }, [promptOptionsSticky, promptOptions]);

  // Clean up banner timer on unmount (MINOR-5)
  useEffect(() => () => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
  }, []);

  const handlePromptOptionsApply = useCallback((options: PromptOptions, sticky: boolean) => {
    setPromptOptions(options);
    setPromptOptionsSticky(sticky);
    const agentType = selectedProfile?.agentType;
    if (conversation?.id && agentType) {
      saveSticky(conversation.id, agentType, { sticky, options });
    }
  }, [conversation?.id, selectedProfile?.agentType]);

  const handlePromptOptionsClear = useCallback(() => {
    setPromptOptions({});
    setPromptOptionsSticky(false);
    const agentType = selectedProfile?.agentType;
    if (conversation?.id && agentType) {
      clearSticky(conversation.id, agentType);
    }
  }, [conversation?.id, selectedProfile?.agentType]);

  const lastResolveIndexById = useMemo(() => lastResolveIndexByRequestId(events), [events]);

  const helperLive = !!conversation && activeConversationIds.includes(conversation.id);
  const helperRuns = useMemo(() => collectHelpers(events, { live: helperLive }), [events, helperLive]);
  const helperSig = helpersSignature(helperRuns);
  const helpersByToolUseId = useMemo(() => new Map(helperRuns.filter((r) => r.toolUseId).map((r) => [r.toolUseId!, r])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [helperSig]);
  const helpersRunning = runningHelperCount(helperRuns);

  const handleInteractionResponse = useCallback((requestId: string, sessionId: string, selection: string[], text?: string, answers?: { selection: string[]; text?: string }[]) => {
    // Use the request event's own sessionId so responses work after a page
    // reload, when currentSessionId (set only by session_started frames) is null.
    const sid = sessionId || currentSessionId;
    if (!sid || !conversation) return;
    sendInteractionResponse({ conversationId: conversation.id, sessionId: sid, requestId, selection, text, answers });
  }, [currentSessionId, conversation, sendInteractionResponse]);

  const profileLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const p of profiles) m[p.id] = p.label;
    return m;
  }, [profiles]);

  // One-shot flag set after fork; cleared on first send (routes through handover
  // modal) or on conversation switch. Transient: survives only within the same
  // page session — acceptable per operator decision.
  const [justForkedConversationId, setJustForkedConversationId] = useState<string | null>(null);

  // When handoffMode='prompt' and the user sends under a different profile than
  // the prior turn, we stash the prompt and pop a modal so they can pick
  // Summarize vs Pass-full-transcript per handoff.
  const [pendingHandoff, setPendingHandoff] = useState<{
    text: string;
    profileId: string;
    agent: string;
    model: string;
    attachments: { base64: string; mediaType: string; name?: string }[];
    fromLabel: string;
    toLabel: string;
    options: HandoffChoiceOptions;
    slashCommand?: { name: string; args?: string };
    /** Fork first-send: restore the one-shot flag if the operator cancels. */
    restoreForkConversationId?: string;
  } | null>(null);

  // Operator-staged `+` menu action (New session / Handover summary). Persisted
  // on the conversation (migration 142) and synced across devices.
  const pendingSessionAction = conversation?.pendingHandoffMode ?? null;
  const patchSelectedPending = (mode: PendingHandoffMode | null) => {
    setSelection((cur) =>
      cur?.type === 'conversation' && cur.conversation.pendingHandoffMode !== (mode ?? undefined)
        ? { ...cur, conversation: { ...cur.conversation, pendingHandoffMode: mode ?? undefined } }
        : cur
    );
  };
  const stageSessionAction = useCallback((mode: PendingHandoffMode | null) => {
    if (!conversation) return;
    const prev = conversation.pendingHandoffMode ?? null;
    patchSelectedPending(mode);
    void api.updateConversation(conversation.id, { pendingHandoffMode: mode })
      .catch((e) => {
        patchSelectedPending(prev);
        showAlert(String(e), 'Session action');
      });
  }, [conversation, showAlert]);
  const hasPriorTurn = useMemo(() => events.some((e) => e.type === 'prompt'), [events]);
  const isRemoteAgentsConv = !!conversation && isRemoteAgentsProject(conversation.projectId);
  const sessionActionsDisabled = !conversation || !hasPriorTurn || isRemoteAgentsConv || BARE_PROMPT_ADAPTERS.has(activeAgentType ?? '');

  const profileLabelFor = (profileId: string, fallbackAgent?: string) =>
    profileLabels[profileId] ?? fallbackAgent ?? profileId;

  const handleSend = useCallback((
    text: string, profileId: string, agent: string, model: string,
    attachments: { base64: string; mediaType: string; name?: string }[],
  ): boolean | void => {
    if (!project || !conversation) { showAlert('Select a conversation first', 'Notice'); return false; }
    const command = parseSlashCommand(text);
    if (command?.name === 'btw') {
      if (command.args?.trim()) askBtw(command.args.trim());
      return;
    }
    const slashCommand = command ?? undefined;
    if (slashCommand) {
      // Pass text so Tierwyn-native verbs (/btw) stay exempt if routing changes.
      const unsupported = slashCommandUnsupportedMessage(agent, text);
      if (unsupported) {
        showAlert(unsupported, 'Unsupported Command');
        return false;
      }
    }
    const handoffPayload = {
      text, profileId, agent, model, attachments,
      slashCommand: slashCommand ? { name: slashCommand.name, args: slashCommand.args } : undefined,
    };
    // Fork handover: first send after a fork always shows the modal so the user
    // can explicitly pick Summarize vs Pass-full-transcript. One-shot — the flag
    // is cleared here and the regular cross-profile check runs from the second
    // send onward. Fires regardless of handoffMode (always-show on fork).
    // return false: InputBar must keep the composer until Confirm (Cancel).
    if (justForkedConversationId === conversation.id) {
      setJustForkedConversationId(null);
      const options = handoffChoiceOptions({ toAgent: agent, nativeAvailable, handoffMode, fork: true });
      const skip = stagedHandoffSkip(pendingSessionAction, options);
      if (skip) {
        if (stagedPromptOptionsError) { showAlert(stagedPromptOptionsError, 'Prompt Options Error'); return false; }
        const ok = slashCommand
          ? dispatchCommand(slashCommand.name, slashCommand.args, profileId, agent, model, skip, attachments)
          : dispatchPrompt(text, profileId, agent, model, attachments, skip);
        if (ok === false) {
          setJustForkedConversationId(conversation.id);
        } else if (ok !== undefined) {
          patchSelectedPending(null);
        }
        return ok;
      }
      setPendingHandoff({
        ...handoffPayload,
        fromLabel: 'Original conversation',
        toLabel: profileLabelFor(profileId, agent),
        options,
        restoreForkConversationId: conversation.id,
      });
      return false;
    }
    // Server handoffs key off profile id (agentModelId), not just agent type —
    // switching e.g. Claude Sonnet → Claude Opus is still a handoff.
    // Remote Agents conversations are permanently bound 1:1 to their Grok Bot;
    // they can never be handed off to another adapter.
    const isCrossProfileHandoff = !isRemoteAgentsConv && !!lastSessionProfileId && profileId !== lastSessionProfileId;
    // A repeat-question that removed the conversation's only turn leaves no
    // prior content to carry over — treat the next send as a first send
    // (clean slate) even when the profile changed. Repeating a later turn
    // keeps earlier prompt events, so those still hand off.
    if (isCrossProfileHandoff && hasPriorTurn) {
      const fromAgent = profiles.find((p) => p.id === lastSessionProfileId)?.agentType ?? activeAgentType;
      const options = handoffChoiceOptions({ fromAgent, toAgent: agent, nativeAvailable, handoffMode });
      const skip = stagedHandoffSkip(pendingSessionAction, options);
      if (skip) {
        if (stagedPromptOptionsError) { showAlert(stagedPromptOptionsError, 'Prompt Options Error'); return false; }
        const ok = slashCommand
          ? dispatchCommand(slashCommand.name, slashCommand.args, profileId, agent, model, skip, attachments)
          : dispatchPrompt(text, profileId, agent, model, attachments, skip);
        if (ok !== false && ok !== undefined) patchSelectedPending(null);
        return ok;
      }
      setPendingHandoff({
        ...handoffPayload,
        // lastSessionProfileId tracks the LAST COMPLETED turn's profile (or the
        // conversation's seeded profile on open). Using selectedProfileId here
        // would show the NEW profile in both pills — the bug we're fixing —
        // because handleProfileChange updates selectedProfileId on dropdown
        // change before Enter is pressed.
        fromLabel: profileLabelFor(lastSessionProfileId ?? selectedProfileId, activeAgentType),
        toLabel: profileLabelFor(profileId, agent),
        options,
      });
      return false;
    }
    if (stagedPromptOptionsError) {
      showAlert(stagedPromptOptionsError, 'Prompt Options Error');
      return false;
    }
    const override = pendingSessionAction ?? undefined;
    const ok = slashCommand
      ? dispatchCommand(slashCommand.name, slashCommand.args, profileId, agent, model, override, attachments)
      : dispatchPrompt(text, profileId, agent, model, attachments, override);
    if (ok !== false && ok !== undefined) patchSelectedPending(null);
    return ok;
  }, [project, conversation, hasPriorTurn, handoffMode, activeAgentType, selectedProfileId, lastSessionProfileId, profiles, nativeAvailable, pendingSessionAction, profileLabels, justForkedConversationId, dispatchPrompt, dispatchCommand, askBtw, showAlert, stagedPromptOptionsError]);

  const handleHandoffChoose = useCallback((choice: 'continue' | HandoffOverride) => {
    const p = pendingHandoff;
    setPendingHandoff(null);
    if (!p) return;
    const mode = choice === 'continue' ? undefined : choice;
    const ok = p.slashCommand
      ? dispatchCommand(p.slashCommand.name, p.slashCommand.args, p.profileId, p.agent, p.model, mode, p.attachments)
      : dispatchPrompt(p.text, p.profileId, p.agent, p.model, p.attachments, mode);
    if (ok !== false) {
      patchSelectedPending(null); // the modal choice consumes any staged `+` menu action
      inputBarRef.current?.clearAfterSend();
    }
  }, [pendingHandoff, dispatchPrompt, dispatchCommand, patchSelectedPending]);

  const handleHandoffCancel = useCallback(() => {
    const p = pendingHandoff;
    setPendingHandoff(null);
    if (p?.restoreForkConversationId) setJustForkedConversationId(p.restoreForkConversationId);
  }, [pendingHandoff]);

  const handleSteer = useCallback((
    text: string,
    attachments: { base64: string; mediaType: string; name?: string }[],
    intent?: 'auto' | 'queue' | 'force',
    command?: { name: string; args?: string },
    handoffOverride?: HandoffOverride,
  ): boolean | void => {
    if (!conversation) return;
    // Parked hold-open after done: isRunning is false while currentSessionId may
    // still be set — a plain prompt adopts the parked process (server intent
    // queue). Do not steer into a dying subprocess.
    //
    // Pre-session_started gap: isRunning is already true (optimistic) but
    // currentSessionId is still null. Falling back to prompt here used to adopt
    // the live session with intent auto and silently queue — skipping the
    // Queue vs Interrupt modal choice. Defer until session_started instead.
    const decision = decideSteerDispatch({ isRunning, currentSessionId });
    if (decision.kind === 'prompt') {
      deferredSteerRef.current = null;
      const ok = command
        ? dispatchCommand(command.name, command.args, selectedProfile?.id ?? '', selectedProfile?.agentType ?? '', selectedProfile?.model ?? '', handoffOverride, attachments)
        : dispatchPrompt(text, selectedProfile?.id ?? '', selectedProfile?.agentType ?? '', selectedProfile?.model ?? '', attachments, handoffOverride);
      if (ok !== false && handoffOverride) patchSelectedPending(null);
      return ok;
    }
    if (decision.kind === 'defer') {
      deferredSteerRef.current = {
        conversationId: conversation.id,
        text,
        attachments,
        intent,
        command,
        handoffOverride,
      };
      if (handoffOverride) patchSelectedPending(null);
      return;
    }
    deferredSteerRef.current = null;
    const ok = sendSteer({
      conversationId: conversation.id,
      sessionId: decision.sessionId,
      text,
      attachments,
      intent,
      ...(command ? { commandName: command.name, commandArgs: command.args } : {}),
      ...(handoffOverride ? { handoffOverride } : {}),
    });
    if (!ok) {
      notConnectedNotice();
      return false;
    }
    if (handoffOverride) patchSelectedPending(null);
  }, [conversation, currentSessionId, isRunning, sendSteer, notConnectedNotice, dispatchPrompt, dispatchCommand, selectedProfile, patchSelectedPending]);

  // Git LLM ops: same dispatch the composer uses — queue while running, plain
  // send when idle. Cross-conversation dispatch is disabled (a prompt frame to a
  // non-selected conversation either live-injects or stopSession's its turn).
  const gitPanelConversation = gitPanel
    ? (gitPanel.via === 'conversation' ? gitPanel.conversation : conversation)
    : null;
  const gitPromptTarget = resolveGitPromptTarget({
    panelConversation: gitPanelConversation
      ? {
        id: gitPanelConversation.id,
        title: gitPanelConversation.title,
        archived: Boolean(gitPanelConversation.archived),
      }
      : null,
    profile: selectedProfile
      ? { id: selectedProfile.id, agentType: selectedProfile.agentType, model: selectedProfile.model }
      : null,
    // Only the selected conversation is submittable; reuse the composer's
    // isRunning (effectiveStatus after the staleRunning guard), not a hand-rolled
    // OR of REST liveStatus / activeConversationIds.
    isRunning,
    differsFromSelection: Boolean(gitPanelConversation && gitPanelConversation.id !== conversation?.id),
  });

  const submitGitPrompt = useCallback((text: string) => {
    if (!conversation || !selectedProfile || gitPromptTarget.kind !== 'ok') return;
    // Panel teardown (incl. commit-draft frame) is owned by GitWorkingTreeModal's
    // onClose, called from the LLM modal submit path — do not duplicate it here.
    if (isRunning) handleSteer(text, [], 'queue');
    else handleSend(text, selectedProfile.id, selectedProfile.agentType, selectedProfile.model, []);
  }, [conversation, selectedProfile, gitPromptTarget.kind, isRunning, handleSteer, handleSend]);

  // Flush a steer that was confirmed while session_started was still in flight.
  useEffect(() => {
    const pending = deferredSteerRef.current;
    if (!pending || !currentSessionId || !isRunning) return;
    if (pending.conversationId !== conversation?.id) {
      deferredSteerRef.current = null;
      return;
    }
    deferredSteerRef.current = null;
    if (!sendSteer({
      conversationId: pending.conversationId,
      sessionId: currentSessionId,
      text: pending.text,
      attachments: pending.attachments,
      intent: pending.intent,
      ...(pending.command
        ? { commandName: pending.command.name, commandArgs: pending.command.args }
        : {}),
      ...(pending.handoffOverride ? { handoffOverride: pending.handoffOverride } : {}),
    })) {
      notConnectedNotice();
    }
  }, [currentSessionId, isRunning, conversation?.id, sendSteer, notConnectedNotice]);

  // Drop deferred steer on conversation switch or when the optimistic run ends
  // without a session (failed start) — promote to a normal prompt so the text
  // is not lost.
  useEffect(() => {
    const pending = deferredSteerRef.current;
    if (!pending) return;
    if (pending.conversationId !== conversation?.id) {
      deferredSteerRef.current = null;
      return;
    }
    if (!isRunning && !currentSessionId) {
      deferredSteerRef.current = null;
      if (pending.command) {
        dispatchCommand(
          pending.command.name,
          pending.command.args,
          selectedProfile?.id ?? '',
          selectedProfile?.agentType ?? '',
          selectedProfile?.model ?? '',
          pending.handoffOverride,
          pending.attachments,
        );
      } else {
        dispatchPrompt(
          pending.text,
          selectedProfile?.id ?? '',
          selectedProfile?.agentType ?? '',
          selectedProfile?.model ?? '',
          pending.attachments,
          pending.handoffOverride,
        );
      }
    }
  }, [conversation?.id, isRunning, currentSessionId, dispatchPrompt, dispatchCommand, selectedProfile]);

  const handleEditSteer = useCallback((
    messageId: string,
    text: string,
    attachments: { base64: string; mediaType: string; name?: string }[],
    command?: { name: string; args?: string },
  ) => {
    if (!conversation || !currentSessionId) return;
    editSteer({
      conversationId: conversation.id,
      sessionId: currentSessionId,
      messageId,
      text,
      attachments,
      ...(command ? { commandName: command.name, commandArgs: command.args } : {}),
    });
  }, [conversation, currentSessionId, editSteer]);

  const themeMode = readThemeMode();
  const isLightTheme = getTheme() === 'light';

  // Map effective status to a display class for the header pill. Grey is the
  // default; green pulses briefly when a turn completes; running/waiting=amber,
  // error=red. Mirrors the sidebar semantics so the two indicators stay in sync.
  let badgeStatus: 'running' | 'waiting' | 'error' | 'done' | 'grey';
  if (effectiveStatus === 'running' || effectiveStatus === 'waiting') {
    badgeStatus = effectiveStatus;
  } else if (effectiveStatus === 'error') {
    badgeStatus = 'error';
  } else if (recentlyCompleted) {
    badgeStatus = 'done';
  } else {
    badgeStatus = 'grey';
  }

  const titleInFlight = badgeStatus === 'running' || badgeStatus === 'waiting';

  // Short status word for session-header pill (title lives in topbar — Option C).
  const statusWord =
    badgeStatus === 'running' ? 'running'
      : badgeStatus === 'waiting' ? 'waiting'
        : badgeStatus === 'error' ? 'error'
          : badgeStatus === 'done' ? 'done'
            : 'idle';

  const conversationTitleLabel = conversation
    ? (conversation.title || 'Untitled')
    : selection?.type === 'schedule_job'
      ? 'Schedule'
      : selection?.type === 'schedule_calendar'
        ? 'Schedule calendar'
        : '';

  const conversationTitleBar = project && conversationTitleLabel
    ? `${project.name}: ${conversationTitleLabel}`
    : conversationTitleLabel;

  // Layout toggles are always inline; everything else lives in the 3-dot menu.
  const renderLayoutToggles = () => (
    <>
      <button
        className={`icon-btn ${!hideToolCalls ? 'active' : ''}`}
        onClick={() => {
          setHideToolCalls((h) => {
            const next = !h;
            lsSet(HIDE_TOOL_CALLS_KEY, next ? '1' : '0');
            return next;
          });
        }}
        title={hideToolCalls ? 'Show tool calls and results' : 'Hide tool calls and results'}
      >
        {hideToolCalls ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        )}
      </button>
      <button
        className={`icon-btn ${showConversationInfo ? 'active' : ''}`}
        onClick={() => setShowConversationInfo(true)}
        title="Conversation overview — all turns, tools, and files"
        aria-label="Conversation overview"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          <line x1="8" y1="6" x2="16" y2="6" />
          <line x1="8" y1="10" x2="16" y2="10" />
          <line x1="8" y1="14" x2="12" y2="14" />
        </svg>
      </button>
      <button
        className={`icon-btn ${autoScroll ? 'active' : ''}`}
        onClick={() => setAutoScroll((a) => !a)}
        title={autoScroll ? 'Disable auto-scroll' : 'Enable auto-scroll'}
      >
        {autoScroll ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="7 13 12 18 17 13" />
            <polyline points="7 6 12 11 17 6" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.6 }}>
            <polyline points="7 13 12 18 17 13" />
            <polyline points="7 6 12 11 17 6" />
            <line x1="2" y1="2" x2="22" y2="22" />
          </svg>
        )}
      </button>
      <button
        className={`icon-btn ${allCollapsed ? 'active' : ''}`}
        onClick={() => setAllCollapsed((c) => !c)}
        title={allCollapsed ? 'Expand all' : 'Collapse all'}
      >
        {allCollapsed ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="7 9 12 4 17 9" />
            <polyline points="7 15 12 20 17 15" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="7 4 12 9 17 4" />
            <polyline points="7 20 12 15 17 20" />
          </svg>
        )}
      </button>
      <button
        className={`icon-btn fullscreen-layout-toggle${isFullscreen ? ' active' : ''}`}
        onClick={toggleFullscreen}
        title={isFullscreen ? 'Exit full screen (Esc)' : 'Full screen conversation'}
        aria-label={isFullscreen ? 'Exit full screen' : 'Full screen conversation'}
        aria-pressed={isFullscreen}
      >
        {isFullscreen ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 14 10 14 10 20" />
            <polyline points="20 10 14 10 14 4" />
            <line x1="14" y1="10" x2="21" y2="3" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        )}
      </button>
    </>
  );

  // FW-9: hidden <a download> instead of location.href — a 404/500 must not navigate the
  // SPA away, and the anchor sends the session cookie same-origin for free.
  const exportConversationMarkdown = () => {
    if (!conversation) return;
    const a = document.createElement('a');
    a.href = `${apiBase}/conversations/${conversation.id}/export`;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const handleExecutePaletteAction = useCallback((actionType: PaletteActionType) => {
    const openSettings = (tab: typeof settingsTab) => {
      setSettingsTab(tab);
      setShowSettings(true);
    };
    switch (actionType) {
      case 'new_chat': {
        const pid = project?.id ?? localStorage.getItem('lastProjectId') ?? directoryRef.current.projects[0]?.id ?? null;
        setTargetNewConvProjectId(pid);
        setOpenNewConvTick((t) => t + 1);
        setSidebarOpen(true);
        break;
      }
      case 'open_schedules':
        setRequestedSidebarTab({ tab: 'schedules', tick: Date.now() });
        setSidebarOpen(true);
        break;
      case 'open_schedule_calendar':
        openScheduleCalendar();
        setRequestedSidebarTab({ tab: 'schedules', tick: Date.now() });
        setSidebarOpen(true);
        break;
      case 'open_settings':
        openSettings('general');
        break;
      case 'settings_voice':
        openSettings('voice');
        break;
      case 'settings_directLlm':
        openSettings('directLlm');
        break;
      case 'settings_compaction':
        openSettings('compaction');
        break;
      case 'settings_sandbox':
        openSettings('sandbox');
        break;
      case 'settings_btw':
        openSettings('directLlm');
        break;
      case 'settings_agents':
        openSettings('agents');
        break;
      case 'open_agent_usage':
        setShowAgentUsage(true);
        break;
      case 'settings_templates':
        openSettings('templates');
        break;
      case 'edit_conversation':
        if (conversation) setEditConvOpen(true);
        break;
      case 'find_in_transcript':
        if (conversation) setFindOpenTick((n) => n + 1);
        break;
      case 'spawn_subagent':
        void openAddSubagentModal();
        break;
      case 'open_helpers':
        setHelperFocus(undefined);
        setHelperHighlightQuery(undefined);
        setShowHelpers(true);
        break;
      case 'open_tasks':
        setShowTaskList(true);
        break;
      case 'open_summaries':
        void openSummaryList();
        break;
      case 'open_markdown':
        if (conversation) setShowMarkdownList(true);
        break;
      case 'open_recordings':
        void openTtsRecordings();
        break;
      case 'open_checkpoints':
        setShowCheckpointList(true);
        break;
      case 'open_git_panel':
        setGitPanel({ via: 'palette' });
        break;
      case 'open_file_browser':
        setFileBrowserOpen(true);
        break;
      case 'open_btw':
        setBtwListOpen(true);
        break;
      case 'open_usage':
        setShowUsage(true);
        break;
      case 'copy_conversation':
        setShowCopyConversationModal(true);
        break;
      case 'duplicate_conversation':
        void handleDuplicateConversation();
        break;
      case 'export_markdown':
        exportConversationMarkdown();
        break;
      case 'print_conversation':
        if (transcriptHasMore) {
          void loadAll().then(() => {
            setTimeout(() => window.print(), 100);
          });
        } else {
          window.print();
        }
        break;
      case 'approve_spawns':
        setSpawnApprovalOpen(true);
        break;
    }
  }, [project, conversation, openAddSubagentModal, openSummaryList, openTtsRecordings, handleDuplicateConversation, openScheduleCalendar]);

  /** Manual "push result up" — operator forwards this child conversation's
   *  latest answer to its parent (side quests after the recovery slot is
   *  spent, or edges with notifyParent:false). Server does marker + notify. */
  const handlePushResultUp = useCallback(async () => {
    if (!conversation?.parentConversationId || pushResultPending) return;
    if (pushResultToastTimerRef.current) clearTimeout(pushResultToastTimerRef.current);
    setPushResultPending(true);
    try {
      const r = await api.pushResultUp(conversation.id);
      setPushResultToast(`Result pushed to parent (${r.proseLength} chars)`);
    } catch (err) {
      setPushResultToast(`Push failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    } finally {
      setPushResultPending(false);
    }
    pushResultToastTimerRef.current = setTimeout(() => setPushResultToast(null), 4000);
  }, [conversation, pushResultPending]);

  /** Manual "re-issue spawn token" — mints a fresh token and injects the
   *  delegation stub into an active session or copies it to clipboard. */
  const handleReissueToken = useCallback(async () => {
    if (!conversation) return;
    if (pushResultToastTimerRef.current) clearTimeout(pushResultToastTimerRef.current);
    try {
      const res = await api.reissueSpawnToken(conversation.id);
      try {
        await copyText(res.token);
      } catch {
        // clipboard write optional
      }
      setPushResultToast(
        res.injected
          ? 'Spawn token re-issued and injected into active session'
          : 'Spawn token re-issued (copied to clipboard)',
      );
    } catch (err) {
      setPushResultToast(`Token re-issue failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
    pushResultToastTimerRef.current = setTimeout(() => setPushResultToast(null), 4000);
  }, [conversation]);

  const renderActionItems = (close: () => void) => (
    <>
      <button
        className="dropdown-item"
        disabled={!conversation}
        onClick={() => { setEditConvOpen(true); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
          </svg>
        </span>
        <span>Edit conversation</span>
      </button>
      <button
        className="dropdown-item"
        disabled={!conversation}
        onClick={() => { setFindOpenTick((n) => n + 1); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <line x1="16.5" y1="16.5" x2="21" y2="21" />
          </svg>
        </span>
        <span>Find in transcript</span>
      </button>
      <button
        className="dropdown-item"
        onClick={() => { void openAddSubagentModal(); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
            <path d="M6 8.5v7M6 15c0-4 12-1 12-6" />
          </svg>
        </span>
        <span>Add subagent</span>
      </button>
      <button
        className="dropdown-item"
        disabled={!conversation}
        onClick={() => { void handleReissueToken(); close(); }}
        title="Re-issue a fresh Bearer token for subagents and delegation"
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </span>
        <span>Re-issue agent token</span>
      </button>
      <button
        className="dropdown-item"
        disabled={helperRuns.length === 0}
        onClick={() => { setHelperFocus(undefined); setHelperHighlightQuery(undefined); setShowHelpers(true); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="5" cy="6" r="2" /><circle cx="5" cy="18" r="2" /><circle cx="19" cy="12" r="2" />
            <path d="M7 6h6a2 2 0 0 1 2 2v2M7 18h6a2 2 0 0 0 2-2v-2" />
          </svg>
        </span>
        <span>Helpers</span>
      </button>
      {conversation?.parentConversationId && (
        <button
          className="dropdown-item"
          disabled={pushResultPending}
          onClick={() => { void handlePushResultUp(); close(); }}
        >
          <span className="dropdown-icon">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 19V5" />
              <path d="M5 12l7-7 7 7" />
            </svg>
          </span>
          <span>Push result up</span>
        </button>
      )}
      <button
        className="dropdown-item"
        disabled={latestTodos(events) === null}
        onClick={() => { setShowTaskList(true); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 7 6 9 10 5" />
            <polyline points="4 17 6 19 10 15" />
            <line x1="14" y1="8" x2="20" y2="8" />
            <line x1="14" y1="18" x2="20" y2="18" />
          </svg>
        </span>
        <span>Tasks</span>
      </button>
      <button
        className="dropdown-item"
        disabled={summaryList.length === 0 && !summaryTreeHasSummaries}
        onClick={() => { void openSummaryList(); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h12a2 2 0 0 1 2 2v14H6a2 2 0 0 1-2-2V4z" />
            <path d="M4 4v14a2 2 0 0 0 2 2" />
            <line x1="8" y1="9" x2="14" y2="9" />
            <line x1="8" y1="13" x2="14" y2="13" />
          </svg>
        </span>
        <span>Summaries</span>
      </button>
      <button
        className="dropdown-item"
        disabled={markdownPaths.length === 0}
        onClick={() => { setShowMarkdownList(true); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
        </span>
        <span>Markdown</span>
      </button>
      <button
        className="dropdown-item"
        disabled={ttsRecordings.length === 0}
        onClick={() => { void openTtsRecordings(); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" y1="19" x2="12" y2="23" />
            <line x1="8" y1="23" x2="16" y2="23" />
          </svg>
        </span>
        <span>Recordings</span>
      </button>
      <button
        className="dropdown-item"
        disabled={checkpoints.length === 0}
        onClick={() => { setShowCheckpointList(true); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2v4" /><path d="M12 18v4" /><circle cx="12" cy="12" r="3" />
            <path d="M4.93 4.93l2.83 2.83" /><path d="M16.24 16.24l2.83 2.83" />
          </svg>
        </span>
        <span>Checkpoints</span>
      </button>
      <button
        className="dropdown-item"
        disabled={btwQueries.length === 0}
        onClick={() => { setBtwListOpen(true); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </span>
        <span>BTW</span>
      </button>
      <button
        className="dropdown-item"
        onClick={() => { setShowUsage((s) => !s); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={showUsage ? "var(--accent, #6366f1)" : "currentColor"} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="20" x2="18" y2="10" />
            <line x1="12" y1="20" x2="12" y2="4" />
            <line x1="6" y1="20" x2="6" y2="14" />
          </svg>
        </span>
        <span>Usage statistics</span>
      </button>
      <button
        className="dropdown-item"
        onClick={() => { setShowCopyConversationModal(true); close(); }}
      >
        <span className="dropdown-icon">
          {copiedConv ? (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--green, #10b981)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
              <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
            </svg>
          )}
        </span>
        <span>{copiedConv ? 'Copied!' : 'Copy conversation'}</span>
      </button>
      <button
        className="dropdown-item"
        disabled={!conversation}
        onClick={() => { void handleDuplicateConversation(); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <rect width="13" height="13" x="9" y="9" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </span>
        <span>Duplicate</span>
      </button>
      <button
        className="dropdown-item"
        disabled={!conversation}
        onClick={() => { exportConversationMarkdown(); close(); }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
        </span>
        <span>Export as Markdown</span>
      </button>
      <button
        className="dropdown-item"
        onClick={() => {
          if (transcriptHasMore) {
            void loadAll().then(() => {
              setTimeout(() => window.print(), 100);
            });
          } else {
            window.print();
          }
          close();
        }}
      >
        <span className="dropdown-icon">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="6 9 6 2 18 2 18 9" />
            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
            <rect x="6" y="14" width="12" height="8" />
          </svg>
        </span>
        <span>Print conversation</span>
      </button>
      {spawnRequests.length > 0 && (
        <button
          className="dropdown-item"
          onClick={() => { close(); setSpawnApprovalOpen(true); }}
        >
          <span className="dropdown-icon" style={{ position: 'relative' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="2.5" /><circle cx="6" cy="18" r="2.5" /><circle cx="18" cy="9" r="2.5" />
              <path d="M6 8.5v7M6 15c0-4 12-1 12-6" />
              <circle cx="18" cy="9" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
              <line x1="18" y1="7" x2="18" y2="11" /><line x1="16" y1="9" x2="20" y2="9" />
            </svg>
          </span>
          <span>Approve spawns ({spawnRequests.length})</span>
        </button>
      )}
    </>
  );

  const handleClearAllUnread = useCallback(async (ids?: string[]) => {
    await api.markConversationsRead(ids);
    if (ids) {
      for (const id of ids) {
        clearUnread(id);
        acknowledgeConversationError(id);
      }
    } else {
      for (const id of unreadConversationIds) clearUnread(id);
      for (const [id, status] of Object.entries(conversationStatuses)) {
        if (status === 'error') acknowledgeConversationError(id);
      }
    }
    setSidebarRefetchTrigger((v) => v + 1);
  }, [clearUnread, unreadConversationIds, acknowledgeConversationError, conversationStatuses]);

  const handleMarkSingleRead = useCallback(async (conversationId: string) => {
    await api.markConversationRead(conversationId);
    clearUnread(conversationId);
    acknowledgeConversationError(conversationId);
    setSidebarRefetchTrigger((v) => v + 1);
  }, [clearUnread, acknowledgeConversationError]);

  return (
    <OpenFileContext.Provider value={setBtwOpenFile}>
      <div
        ref={shellRef}
        style={{ '--sidebar-w': `${sidebarWidth}px` } as React.CSSProperties}
        className={`shell${isSidebarCollapsed ? ' sidebar-collapsed' : ''}${isFullscreen ? ' fullscreen-mode' : ''}`}
      >
      <div className="ambient-glow" />
      <header className="topbar">
        <div className="topbar-left">
          <button
            className="sidebar-toggle"
            onClick={() => setSidebarOpen((s) => !s)}
            aria-label="Toggle navigation"
            aria-expanded={sidebarOpen}
            title="Toggle navigation"
          >
            {sidebarOpen ? '✕' : '☰'}
          </button>
          {/* Brand: logo mark + app name only. Conversation title lives in
              the session header (above the status pill), not up here. */}
          <div className="logo">
            <span className="logo-mark" aria-hidden="true" />
            <span className="logo-text">Tierwyn</span>
          </div>
        </div>
        <div className="topbar-right">
          <button
            type="button"
            className={`conn-status topbar-conn conn-status-btn${connModalOpen ? ' active' : ''}`}
            onClick={() => setConnModalOpen(true)}
            title="Connection & server status"
            aria-label="Connection and server status"
            aria-haspopup="dialog"
            aria-expanded={connModalOpen}
          >
            <ConnStateIcon state={connState} />
          </button>
          <button
            type="button"
            className={`theme-toggle${commandPaletteOpen ? ' active' : ''}`}
            onClick={() => openCommandPalette()}
            title="Jump to…"
            aria-label="Command palette"
            aria-expanded={commandPaletteOpen}
            aria-haspopup="dialog"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
              <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />
            </svg>
          </button>
          <button
            type="button"
            className={`theme-toggle topbar-git${gitPanel ? ' active' : ''}`}
            onClick={() => setGitPanel({ via: 'topbar' })}
            title="Git working tree"
            aria-label="Git working tree"
            aria-haspopup="dialog"
            aria-expanded={!!gitPanel}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
          <button
            type="button"
            className={`theme-toggle topbar-filebrowser${fileBrowserOpen ? ' active' : ''}`}
            onClick={() => setFileBrowserOpen(true)}
            title="File browser"
            aria-label="File browser"
            aria-haspopup="dialog"
            aria-expanded={fileBrowserOpen}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          {globalTasksEnabled && (
            <button
              type="button"
              className={`theme-toggle gt-header-btn${showGlobalTasks ? ' active' : ''}`}
              onClick={() => setShowGlobalTasks((v) => !v)}
              title={
                globalTaskCounts.inProgress > 0
                  ? `Global tasks (${globalTaskCounts.inProgress} in progress)`
                  : 'Global tasks'
              }
              aria-label={
                globalTaskCounts.inProgress > 0
                  ? `Global tasks (${globalTaskCounts.inProgress} in progress)`
                  : 'Global tasks'
              }
              aria-haspopup="dialog"
              aria-expanded={showGlobalTasks}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
                <path d="M9 11l3 3L22 4" />
                <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
              </svg>
              {globalTaskCounts.inProgress > 0 && (
                <span className="gt-badge">
                  {globalTaskCounts.inProgress > 99 ? '99+' : globalTaskCounts.inProgress}
                </span>
              )}
            </button>
          )}
          {memoriesEnabled && (
            <button
              type="button"
              className={`theme-toggle gt-header-btn${showMemories ? ' active' : ''}`}
              onClick={() => {
                setMemoryFocusId(null);
                setShowMemories((v) => !v);
              }}
              title={
                memoryBadgeCount(memoryCounts) > 0
                  ? `Project memories (${memoryBadgeCount(memoryCounts)} pending)`
                  : 'Project memories'
              }
              aria-label={
                memoryBadgeCount(memoryCounts) > 0
                  ? `Project memories (${memoryBadgeCount(memoryCounts)} pending)`
                  : 'Project memories'
              }
              aria-haspopup="dialog"
              aria-expanded={showMemories}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
                <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
                <path d="M9 21h6" />
              </svg>
              {memoryBadgeCount(memoryCounts) > 0 && (
                <span className="gt-badge">
                  {memoryBadgeCount(memoryCounts) > 99 ? '99+' : memoryBadgeCount(memoryCounts)}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            className={agentActivityButtonClass(showAgentActivity, activeAgentCount, timedAgentCount)}
            onClick={() => setShowAgentActivity((v) => !v)}
            title={
              activeAgentCount > 0
                ? `Agent activity (${activeAgentCount} active)`
                : timedAgentCount > 0
                  ? `Agent activity (${timedAgentCount} timed waiting)`
                  : 'Agent activity'
            }
            aria-label={
              activeAgentCount > 0
                ? `Agent activity (${activeAgentCount} active)`
                : timedAgentCount > 0
                  ? `Agent activity (${timedAgentCount} timed waiting)`
                  : 'Agent activity'
            }
            aria-haspopup="dialog"
            aria-expanded={showAgentActivity}
          >
            {activeAgentCount === 0 && timedAgentCount > 0 ? (
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: 'block' }}
                aria-hidden="true"
              >
                <path d="M5 22h14" />
                <path d="M5 2h14" />
                <path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22" />
                <path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2" />
              </svg>
            ) : (
              <svg
                className={activeAgentCount > 0 ? 'active-agent-heartbeat' : undefined}
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ display: 'block' }}
                aria-hidden="true"
              >
                <path d="M12 8V4H8" />
                <rect width="16" height="12" x="4" y="8" rx="2" />
                <path d="M2 14h2" />
                <path d="M20 14h2" />
                <path d="M15 13v2" />
                <path d="M9 13v2" />
              </svg>
            )}
            {activeAgentCount > 0 && (
              <span className="gt-badge">
                {activeAgentCount > 99 ? '99+' : activeAgentCount}
              </span>
            )}
          </button>
          <button
            type="button"
            className={`theme-toggle${showAgentUsage ? ' active' : ''}`}
            onClick={() => setShowAgentUsage((v) => !v)}
            title="Usage credits"
            aria-label="Usage credits"
            aria-haspopup="dialog"
            aria-expanded={showAgentUsage}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
              <line x1="18" y1="20" x2="18" y2="10" />
              <line x1="12" y1="20" x2="12" y2="4" />
              <line x1="6" y1="20" x2="6" y2="14" />
            </svg>
          </button>
          {/* Appearance popover: merges theme toggle + colour picker (desktop) */}
          <div className={`appearance-wrap topbar-appearance${showAppearance ? ' open' : ''}`} ref={appearanceRef}>
            <button
              type="button"
              className={`theme-toggle${showAppearance ? ' active' : ''}`}
              onClick={() => setShowAppearance((v) => !v)}
              title="Appearance"
              aria-expanded={showAppearance}
              aria-haspopup="true"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
              </svg>
            </button>
            {showAppearance && (
              <div className="appearance-popover">
                <div className="appearance-popover-row">
                  <span className="appearance-popover-label">Theme</span>
                  <div className="theme-segmented theme-control-group" role="group" aria-label="Color theme">
                    {([
                      { id: 'auto', label: 'Auto', title: 'Follow browser / OS' },
                      { id: 'light', label: 'Light', title: 'Light' },
                      { id: 'dark', label: 'Dark', title: 'Dark' },
                    ] as const).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`theme-toggle${themeMode === opt.id ? ' active' : ''}`}
                        onClick={() => setThemeMode(opt.id)}
                        title={opt.title}
                        aria-pressed={themeMode === opt.id}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="color-picker-title">Accent</div>
                <div className="color-picker-grid">
                  {THEME_COLORS.map((color) => (
                    <button
                      key={color.id}
                      className={`color-option ${themeColor === color.id ? 'active' : ''}`}
                      onClick={() => handleSetThemeColor(color.id)}
                      title={color.name}
                    >
                      <span className="color-dot" style={{ backgroundColor: isLightTheme ? color.lightHex : color.darkHex }} />
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button
            className={`theme-toggle ${showSettings ? 'active' : ''}`}
            onClick={() => { setSettingsTab('general'); setShowSettings((s) => !s); }}
            title="Settings"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
          <button
            type="button"
            className="theme-toggle topbar-signout"
            onClick={() => setShowLogoutConfirm(true)}
            title="Sign out"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
              <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
              <line x1="12" y1="2" x2="12" y2="12" />
            </svg>
          </button>
          {/* Mobile ≤600px: git + file browser + appearance + sign-out demoted into overflow */}
          <div className="topbar-overflow-wrap" ref={topbarOverflowRef}>
            <button
              type="button"
              className={`theme-toggle topbar-overflow-btn${showTopbarOverflow ? ' active' : ''}`}
              onClick={() => setShowTopbarOverflow((v) => !v)}
              title="More"
              aria-label="More topbar actions"
              aria-expanded={showTopbarOverflow}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
                <circle cx="12" cy="12" r="1.5" />
                <circle cx="12" cy="5" r="1.5" />
                <circle cx="12" cy="19" r="1.5" />
              </svg>
            </button>
            {showTopbarOverflow && (
              <div className="topbar-overflow-menu">
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setShowTopbarOverflow(false);
                    setGitPanel({ via: 'topbar' });
                  }}
                >
                  <span className="dropdown-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
                      <line x1="6" y1="3" x2="6" y2="15" />
                      <circle cx="18" cy="6" r="3" />
                      <circle cx="6" cy="18" r="3" />
                      <path d="M18 9a9 9 0 0 1-9 9" />
                    </svg>
                  </span>
                  <span>Git working tree</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setShowTopbarOverflow(false);
                    setFileBrowserOpen(true);
                  }}
                >
                  <span className="dropdown-icon">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }} aria-hidden="true">
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                  </span>
                  <span>File browser</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setShowTopbarOverflow(false);
                    setShowAppearance(true);
                  }}
                >
                  <span className="dropdown-icon">
                    {/* Same sun/rays mark as desktop topbar Appearance control */}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="4" />
                      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
                    </svg>
                  </span>
                  <span>Appearance</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setShowTopbarOverflow(false);
                    window.location.reload();
                  }}
                >
                  <span className="dropdown-icon">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                      <polyline points="21 3 21 9 15 9" />
                    </svg>
                  </span>
                  <span>Refresh page</span>
                </button>
                <button
                  type="button"
                  className="dropdown-item"
                  onClick={() => {
                    setShowTopbarOverflow(false);
                    setShowLogoutConfirm(true);
                  }}
                >
                  <span className="dropdown-icon">
                    {/* Same power mark as desktop topbar Sign out control */}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M18.36 6.64a9 9 0 1 1-12.73 0" />
                      <line x1="12" y1="2" x2="12" y2="12" />
                    </svg>
                  </span>
                  <span>Sign out</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {isSidebarCollapsed && (
        <div
          className="sidebar-touch-edge"
          onMouseEnter={handleLeftEdgeEnter}
          aria-hidden="true"
        />
      )}

      <Sidebar
        selectedProjectId={project?.id ?? null}
        selectedConversationId={conversation?.id ?? null}
        onSelectConversation={onSelectConversation}
        onConversationRenamed={onConversationRenamed}
        liveConversationMeta={liveConversationMeta}
        onConversationDeleted={onConversationDeleted}
        onScheduleJobDeleted={onScheduleJobDeleted}
        onScheduleJobArchived={onScheduleJobArchived}
        onProjectDeleted={onProjectDeleted}
        activeConversationIds={activeConversationIds}
        conversationStatuses={conversationStatuses}
        errorRecoveredConversationIds={errorRecoveredConversationIds}
        wsObservedConversationIds={wsObservedConversationIds}
        helpersRunningIds={helpersRunningIds}
        unreadConversationIds={unreadConversationIds}
        clearUnread={clearUnread}
        selectedBadgeStatus={conversation ? badgeStatus : undefined}
        isOpen={isSidebarDrawerOpen}
        onClose={() => { setSidebarOpen(false); setSidebarPeek(false); }}
        onMouseEnter={handleSidebarEnter}
        onMouseLeave={handleSidebarLeave}
        isPinned={sidebarPinnedActive}
        onTogglePin={toggleSidebarPinned}
        refetchTrigger={sidebarRefetchTrigger}
        pruneConversationIds={pruneConversationIds}
        profileLabels={profileLabels}
        profilesLoaded={profilesLoaded}
        grokBotEnabled={grokBotEnabled}
        grokBotState={grokBotStatus?.state}
        grokBotInProjectChats={grokBotInProjectChats}
        grokBotStatus={grokBotStatus}
        remoteHosts={remoteHosts}
        selectedJobId={selectedJobId}
        onSelectJob={onSelectScheduleJob}
        onMainTabChange={onMainTabChange}
        onOpenScheduleCalendar={openScheduleCalendar}
        scheduleCalendarSelected={selection?.type === 'schedule_calendar'}
        onDirectoryChange={(dir) => {
          directoryRef.current = dir;
          setDirectoryVersion((v) => v + 1);
        }}
        openNewConversationTick={openNewConvTick}
        targetNewConversationProjectId={targetNewConvProjectId}
        requestedMainTab={requestedSidebarTab}
        hideShippedSchedulePacks={hideShippedSchedulePacks}
        revealSelectionTick={sidebarRevealTick}
        onRevealSelection={() => setSidebarRevealTick((t) => t + 1)}
        onOpenGitPanel={(conv) => setGitPanel({ via: 'conversation', conversation: conv })}
        onOpenGitPanelForProject={(project) => setGitPanel({ via: 'folder', project })}
        onOpenProjectRules={(p) => setRulesTarget({ kind: 'project', project: p })}
        onOpenConversationRules={(c, p) => setRulesTarget({ kind: 'conversation', conversation: c, project: p })}
        onOpenSandboxSettings={() => { setSettingsTab('sandbox'); setShowSettings(true); }}
        sidebarWidth={sidebarWidth}
        onSidebarWidthChange={handleSidebarWidthChange}
        shellRef={shellRef}
        resizingRef={resizingRef}
        liveActivityAt={liveActivityAt}
      />
      <div
        className={`sidebar-backdrop${isSidebarDrawerOpen ? ' open' : ''}`}
        onClick={() => { setSidebarOpen(false); setSidebarPeek(false); }}
      />

      <main
        className="main"
        onClickCapture={() => {
          if (isSidebarDrawerOpen) {
            setSidebarOpen(false);
            setSidebarPeek(false);
          }
        }}
      >
        {/* Third header: full-width conversation title (between topbar and session toolbar). */}
        {conversationTitleLabel ? (
          <div className="conversation-title-bar" aria-label="Conversation title">
            <div className="conversation-title-bar-heading">
            <h1 className="conversation-title-bar-text" title={conversationTitleBar}>
              {project ? (
                <>
                  <span className="conversation-title-bar-project">{project.name}</span>
                  <span className="conversation-title-bar-sep">: </span>
                </>
              ) : null}
              <span className="conversation-title-bar-label">{conversationTitleLabel}</span>
            </h1>
              {conversation?.designation ? (
                <span className="conversation-title-bar-designation">{conversation.designation}</span>
              ) : null}
            </div>
            {conversation?.description ? (
              <p className="conversation-title-bar-desc" title={conversation.description}>
                {conversation.description}
              </p>
            ) : null}
          </div>
        ) : null}

        <div className="session-header">
          <div className="session-title">
            {selection?.type === 'schedule_job' ? (
              (() => {
                const b = scheduleJobBadge;
                const cls = b?.badgeClass ?? 'grey';
                const label = b?.label ?? '…';
                const inFlight = b?.inFlight ?? false;
                return (
                  <div
                    className={`session-agent-badge status-${cls}${inFlight ? ' session-agent-badge--in-flight' : ''}`}
                    title={label}
                  >
                    <span className={`status-dot ${cls}`} style={{ width: 6, height: 6, flexShrink: 0 }} />
                    <span className="session-title-text">{label}</span>
                  </div>
                );
              })()
            ) : conversation ? (
              <div className={`session-agent-badge status-${badgeStatus}${titleInFlight ? ' session-agent-badge--in-flight' : ''}`}>
                <span className={`status-dot ${badgeStatus === 'grey' ? 'grey' : badgeStatus}`} style={{ width: 6, height: 6, flexShrink: 0 }} />
                <span className="session-title-text" title={statusWord}>{statusWord}</span>
              </div>
            ) : (
              <div className="session-agent-badge status-grey">
                <span className="status-dot grey" style={{ width: 6, height: 6, flexShrink: 0 }} />
                <span className="session-title-text">idle</span>
              </div>
            )}
            {/* Native / context resume badge:
                - available (green): native session is available, or turn is in-flight,
                  or conversation is resumable from a context/compaction perspective.
                - unavailable (red): neither native resume nor context resumption is
                  available (e.g. compaction disabled with no native session). */}
            {(() => {
              if (!conversation || !activeAgentType) return null;
              const inFlight = isRunning || pendingPromptConversationId === conversation.id;
              if (!hasSession && !inFlight) return null;
              let variant: 'available' | 'pending' | 'unavailable';
              let label: string;
              let title: string;
              if (inFlight) {
                variant = 'available';
                label = 'resumable';
                title = 'Session in progress';
              } else if (nativeAvailable) {
                variant = 'available';
                label = 'resumable';
                title = 'Resumable (native session)';
              } else if (contextResumable) {
                variant = 'available';
                label = 'resumable';
                title = 'Resumable from context (compaction)';
              } else {
                variant = 'unavailable';
                label = 'no resume';
                title = 'No session or context available to resume';
              }
              return (
                <span className={`native-session-badge ${variant}`} title={title}>
                  <span className="status-dot" style={{ width: 6, height: 6 }} />
                  {label}
                </span>
              );
            })()}
          </div>
          <div className="session-actions">
            {conversation && (
              <>
                <div className="session-action-toolbar">
                  {renderLayoutToggles()}
                  <div className="session-actions-dropdown-wrap">
                    <button
                      className={`icon-btn ${showActionsDropdown ? 'active' : ''}`}
                      onClick={() => setShowActionsDropdown((v) => !v)}
                      title="More actions"
                      style={{ position: 'relative' }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="5" r="1.5" />
                        <circle cx="12" cy="19" r="1.5" />
                      </svg>
                      {spawnRequests.length > 0 && (
                        <span className="header-badge-count">{spawnRequests.length}</span>
                      )}
                    </button>
                    {showActionsDropdown && (
                      <>
                        <div className="dropdown-backdrop" onClick={() => setShowActionsDropdown(false)} />
                        <div className="session-actions-dropdown">
                          {renderActionItems(() => setShowActionsDropdown(false))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
            {/* Schedule-job selection: dedicated Recordings button (layout/chat actions N/A). */}
            {selection?.type === 'schedule_job' && (
              <div className="session-action-toolbar">
                <button
                  className="icon-btn"
                  disabled={ttsRecordings.length === 0}
                  onClick={() => { void openTtsRecordings(); }}
                  title={ttsRecordings.length === 0 ? 'No project recordings yet' : 'Project recordings'}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
        {/* Own row under the status pills: only exists while helpers run, so the
            header grows temporarily instead of crowding the pill row on mobile. */}
        {helpersRunning > 0 && conversation && (
          <div className="helpers-row">
            <button
              type="button"
              className="helpers-chip"
              onClick={() => { setHelperFocus(undefined); setHelperHighlightQuery(undefined); setShowHelpers(true); }}
              title="Native helpers still running"
            >
              ⑂ {helpersRunning} helper{helpersRunning === 1 ? '' : 's'} running
            </button>
          </div>
        )}

        {selection?.type === 'schedule_calendar' ? (
          <ScheduleCalendarPane
            refetchTrigger={scheduleRefetchTrigger}
            onSelectJob={onSelectScheduleJob}
          />
        ) : selection?.type === 'schedule_job' ? (
          <ScheduleBrowser
            projectId={selection.project.id}
            jobId={selection.jobId}
            refetchTrigger={scheduleRefetchTrigger}
            profiles={filterProfilesForProjectChats(profiles, {
              projectId: selection.project.id,
              grokBotInProjectChats,
              grokBotStatus,
            })}
            profilesLoaded={profilesLoaded}
            conversationStatuses={conversationStatuses}
            unreadConversationIds={unreadConversationIds}
            errorRecoveredConversationIds={errorRecoveredConversationIds}
            wsObservedConversationIds={wsObservedConversationIds}
            onJobStatusChange={onScheduleJobStatusChange}
            tts={tts}
            ttsSummarizeAvailable={ttsSummarizeAvailable}
            fileEditsEnabled={fileEditsEnabled}
            onOpenRun={(conversationId) => {
              void openConversationById(conversationId);
            }}
            onSelectJob={(id) => onSelectScheduleJob(selection.project, id)}
            onOpenCalendar={openScheduleCalendar}
            onJobDeleted={onScheduleJobDeleted}
            onJobArchived={onScheduleJobArchived}
            onRunConversationDeleted={(deletedIds) => {
              onConversationDeleted(deletedIds);
              setScheduleRefetchTrigger((n) => n + 1);
            }}
          />
        ) : (
          <>
            <TranscriptErrorBoundary resetKey={conversation?.id ?? ''}>
            <OutputPane
              events={events}
              activeConversationIds={activeConversationIds}
              helpersByToolUseId={helpersByToolUseId}
              onOpenHelper={(k, hq) => { setHelperFocus(k); setHelperHighlightQuery(hq); setShowHelpers(true); }}
              agentStatus={effectiveStatus}
              liveSessionId={currentSessionId}
              remoteHostName={remoteHostLabel(project?.remoteHostId, remoteHosts)}
              profileLabels={profileLabels}
              allCollapsed={allCollapsed}
              isLoading={isLoadingTranscript}
              focusEventId={focusEventId}
              focusQuery={focusQuery}
              onFocusConsumed={clearFocusEvent}
              findOpenTick={findOpenTick}
              forceInterruptedPromptIds={forceInterruptedPromptIds}
              onDeleteEvent={(ids) => {
                const idArray = Array.isArray(ids) ? ids : [ids];
                Promise.all(idArray.map(id => api.deleteEvent(id))).then(() => {
                  const toRemove = new Set(idArray);
                  const remaining = events.filter(e => e.id ? !toRemove.has(e.id) : true);
                  setEvents(remaining);
                  // ponytail: re-derive last-adapter/profile from remaining events
                  // so a cross-adapter handoff modal re-fires if the user deletes
                  // the post-handoff turn and re-sends to the original adapter.
                  let lastProfile: string | undefined;
                  for (let i = remaining.length - 1; i >= 0; i--) {
                    const pid = remaining[i].agentProfileId;
                    if (pid) { lastProfile = pid; break; }
                  }
                  if (lastProfile) {
                    setLastSessionProfileId(lastProfile);
                    setActiveAgentType(profiles.find(p => p.id === lastProfile)?.agentType);
                  } else {
                    // No agent-bearing events remain — reset to "fresh" so the
                    // next send is treated as the first turn of the conversation.
                    setLastSessionProfileId(undefined);
                    setActiveAgentType(undefined);
                  }
                }).catch(err => {
                  showAlert("Failed to delete event(s): " + (err instanceof Error ? err.message : String(err)), 'Error');
                });
              }}
              autoScroll={autoScroll}
              nativeSyncAvailable={
                // v1: only claude-code surfaces the Transcript+session
                // fork option. pi/codex/etc are deferred. AND only when a native
                // session file actually exists for the active agent (the badge signal
                // from GET /conversations/:id/active-agent — same source the native
                // "session available" pill uses).
                !!nativeAvailable && activeAgentType === 'claude-code'
              }
              onDeleteFromPointNative={async (anchorEventId) => {
                if (!conversation) return;
                try {
                  await api.rewindConversation(conversation.id, {
                    eventId: anchorEventId,
                    rewindConversation: true,
                    rewindCode: false,
                    createCheckpoint: false,
                  });
                  await refetchAfterRewind();
                } catch (err) {
                  showAlert('Failed to delete from this point (native): ' + (err instanceof Error ? err.message : String(err)), 'Error');
                }
              }}
              onDeleteOneNative={async (turnIndex, eventIds, promptEventId) => {
                // v2: surgical single-turn delete. Same agent gate as the suffix
                // flow (nativeSyncAvailable already covers it). The route converts
                // the 0-indexed turnIndex to the helper's 1-indexed counting.
                if (!conversation) return;
                try {
                  let targetIndex = turnIndex;
                  if (transcriptHasMore && promptEventId) {
                    const full = await api.transcript(conversation.id);
                    setEvents(full as unknown as NormalisedEvent[]);
                    setTranscriptHasMore(false);
                    setTranscriptCursor(null);
                    loadedTurnsRef.current = Infinity;
                    const recomputedIndex = findGlobalTurnIndexByPromptId(
                      full as unknown as NormalisedEvent[],
                      promptEventId,
                      forceInterruptedPromptIds,
                    );
                    if (recomputedIndex === -1) {
                      showAlert('Could not find the target turn in global history to excise.', 'Error');
                      return;
                    }
                    targetIndex = recomputedIndex;
                  }
                  await api.exciseTurn(conversation.id, { turnIndex: targetIndex, eventIds });
                  await refetchAfterRewind();
                } catch (err) {
                  showAlert('Failed to delete message (native): ' + (err instanceof Error ? err.message : String(err)), 'Error');
                }
              }}
              hasMore={transcriptHasMore}
              onLoadEarlier={loadEarlier}
              onLoadAll={loadAll}
              loadingEarlier={loadingEarlier}
              loadingAll={loadingAll}
              conversationId={conversation?.id}
              projectId={project?.id}
              lastResolveIndexByRequestId={lastResolveIndexById}
              onRespond={handleInteractionResponse}
              hideToolCalls={hideToolCalls}
              onForkConversation={handleForkConversation}
              onRepeatQuestion={handleRepeatQuestion}
              summaryByEventId={summaryByEventId}
              handoffByAnchorId={handoffByAnchorId}
              checkpointByEventId={checkpointByEventId}
              onViewSummary={(text, handoff) => setSummaryModal({ text, handoff })}
              onOpenMemory={(id) => {
                setMemoryFocusId(id);
                setShowMemories(true);
              }}
              onOpenConversation={openConversationById}
              onInjectText={(text) => inputBarRef.current?.setText(text)}
              onAddAttachment={(att) => inputBarRef.current?.addAttachment?.(att)}
              tts={tts}
              ttsSummarizeAvailable={ttsSummarizeAvailable}
              fileEditsEnabled={fileEditsEnabled}
              onCycleTtsProvider={() => { void cycleTtsProvider(); }}
              onOpenSidebar={() => setSidebarOpen(true)}
            />
            </TranscriptErrorBoundary>

            <BtwPopup
              query={btwPopupQueryId ? (btwQueries.find((q) => q.id === btwPopupQueryId) ?? null) : null}
              onClose={() => setBtwPopupQueryId(null)}
              onCopy={handleCopyBtw}
              onFork={handleForkBtw}
              onOpenFile={setBtwOpenFile}
              conversationId={conversation?.id ?? null}
              projectId={project?.id ?? null}
              ttsEnabled={tts?.enabled}
              ttsProvider={tts?.provider}
              ttsSummarizeAvailable={ttsSummarizeAvailable}
              onCycleTtsProvider={() => { void cycleTtsProvider(); }}
            />
          </>
        )}
        {/* Park bar above InputBar so prompt stays usable while a recording plays. */}
        <TtsParkBar />
        {conversation?.archived && (
          <div className="composer-banner">
            {project?.system
              ? 'This Bot is no longer present in Grok Bot. The conversation is read-only.'
              : 'Archived — unarchive to continue.'}
          </div>
        )}
        {optionsClearedBanner && (
          <div className="composer-banner warning" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>{optionsClearedBanner}</span>
            <button
              type="button"
              className="ghost-btn icon-only"
              style={{ padding: '0 4px', fontSize: '14px', lineHeight: 1, background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }}
              onClick={() => setOptionsClearedBanner(null)}
              aria-label="Dismiss notice"
            >
              ×
            </button>
          </div>
        )}
        {stagedPromptOptionsError && (
          <div className="composer-banner warning" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>⚠️ Option error: {stagedPromptOptionsError}</span>
            <button
              type="button"
              className="ghost-btn"
              style={{ padding: '2px 6px', fontSize: '12px', textDecoration: 'underline', background: 'transparent', border: 'none', cursor: 'pointer', color: 'inherit' }}
              onClick={handlePromptOptionsClear}
            >
              Clear options
            </button>
          </div>
        )}
        {selection?.type !== 'schedule_job' && selection?.type !== 'schedule_calendar' && (
          <InputBar
            ref={inputBarRef}
            profiles={chatProfiles}
            profilesLoaded={profilesLoaded}
            unavailable={unavailableProfiles}
            selectedProfileId={selectedProfile?.id ?? ''}
            onProfileChange={handleProfileChange}
            onSend={handleSend}
            onSteer={handleSteer}
            onEditSteer={handleEditSteer}
            isRunning={isRunning}
            wrappingUp={wrappingUp}
            steerQueueLength={conversation ? (steerQueueLengths[conversation.id] ?? 0) : 0}
            steerQueue={conversation ? (steerQueues[conversation.id] ?? []) : []}
            onCancelSteer={(messageId) => {
              if (conversation) cancelSteer({ conversationId: conversation.id, sessionId: currentSessionId ?? '', messageId });
            }}
            disabled={!conversation || pendingHandoff !== null || Boolean(conversation?.archived)}
            onStop={() => {
              if (!conversation) return;
              setStopRequested(true);
              requestStop(conversation.id);
            }}
            stopDisabled={stopRequested}
            showStop={!!conversation && (isRunning || pendingPromptConversationId === conversation.id)}
            conversationId={conversation?.id}
            projectId={project?.id}
            conversationTitle={conversation?.title}
            isScheduleHome={conversation?.kind === 'schedule_home'}
            roles={(spawnTemplate?.roles ?? []).map((r) => r.role)}
            onBtw={conversation ? () => inputBarRef.current?.setText('/btw ') : undefined}
            onBtwQuestion={conversation ? askBtw : undefined}
            btwDisabledReason={btwUnavailable ?? undefined}
            onOpenFile={setBtwOpenFile}
            effort={effort}
            effectiveEffort={effectiveEffort}
            effortLevels={effortLevels}
            effortSessionState={effortSessionState}
            onEffortChange={handleEffortChange}
            permissionMode={conversation?.permissionMode ?? null}
            permissionDefaultMode={defaultInteractionMode}
            permissionCapable={agentSupportsPermissionMode(selectedProfile?.agentType)}
            onPermissionModeChange={conversation && !grokChat && selectedProfile?.agentType !== 'grok-bot' ? handlePermissionModeChange : undefined}
            sandbox={conversation?.sandbox ?? null}
            sandboxState={sandboxState}
            onSandboxChange={conversation && !grokChat && selectedProfile?.agentType !== 'grok-bot' ? handleSandboxChange : undefined}
            promptOptionDescriptors={promptOptionDescriptors}
            promptOptions={promptOptions}
            promptOptionCount={stagedPromptOptionCount}
            promptOptionsError={stagedPromptOptionsError}
            promptOptionsSticky={promptOptionsSticky}
            onPromptOptionsApply={handlePromptOptionsApply}
            onPromptOptionsClear={handlePromptOptionsClear}
            lastSessionProfileId={lastSessionProfileId}
            pendingSessionAction={pendingSessionAction}
            onSessionActionChange={stageSessionAction}
            sessionActionsDisabled={sessionActionsDisabled}
            grokBotBanner={grokBotBanner}
            grokBotInputDisabled={grokChat && !grokBotEnabled}
            onGrokBotAction={() => {
              void api.startGrokBot('manual').then(() => api.getGrokBotStatus().then((s) => setGrokBotStatus((prev) => applyGrokBotStatus(prev, s)))).catch(() => {});
            }}
            isSidebarOpen={isSidebarDrawerOpen}
            onCloseSidebar={() => { setSidebarOpen(false); setSidebarPeek(false); }}
            liveAgentType={activeAgentType}
            hasLiveSession={Boolean(currentSessionId || isRunning)}
            onMcpServersChange={handleMcpServersChange}
            onOpenRules={conversation && project && !project.system ? () => setRulesTarget({ kind: 'conversation', conversation, project }) : undefined}
          />
        )}
      </main>

      {showAgentActivity && (
        <AgentActivityModal
          profiles={profiles}
          stopResult={stopResult}
          onStop={stopSessionById}
          onJump={(cid) => {
            void selectConversationById(cid);
          }}
          onUnauthorized={onDeauthenticate}
          onClose={() => setShowAgentActivity(false)}
          onActiveCountChange={setActiveAgentCount}
          onTimedCountChange={setTimedAgentCount}
          unreadConversationIds={unreadConversationIds}
          conversations={directoryRef.current.conversations}
          projects={directoryRef.current.projects}
          onClearAllUnread={handleClearAllUnread}
          onMarkSingleRead={handleMarkSingleRead}
          conversationStatuses={conversationStatuses}
          errorRecoveredConversationIds={errorRecoveredConversationIds}
          spawnRequests={spawnRequests}
          onOpenSpawnApprovals={() => { setShowAgentActivity(false); setSpawnApprovalOpen(true); }}
        />
      )}
      {showGlobalTasks && globalTasksEnabled && (
        <GlobalTasksModal
          onClose={() => setShowGlobalTasks(false)}
          onJump={(cid) => {
            void selectConversationById(cid);
            setShowGlobalTasks(false);
          }}
          onUnauthorized={onDeauthenticate}
          onCountsChange={setGlobalTaskCounts}
          frame={lastTaskFrame}
        />
      )}
      {showMemories && (
        <MemoriesModal
          onClose={() => {
            setShowMemories(false);
            setMemoryFocusId(null);
          }}
          projects={directoryRef.current.projects}
          refreshKey={memoryRefreshKey}
          focusId={memoryFocusId}
          onAddAsRule={(m) => {
            const proj = directoryRef.current.projects.find((p) => p.id === m.projectId);
            if (proj) {
              setRulesTarget({ kind: 'project', project: proj });
              setRulesPromoteRef({ memoryId: m.id, text: m.text });
              setRulesPrefill(m.text);
            }
          }}
          onJumpToConversation={(cid) => {
            void selectConversationById(cid);
            setShowMemories(false);
            setMemoryFocusId(null);
          }}
        />
      )}
      {showAgentUsage && (
        <AgentUsageModal
          onClose={() => setShowAgentUsage(false)}
        />
      )}
      {connModalOpen && (
        <ConnectionModal
          onClose={() => setConnModalOpen(false)}
          connState={connState}
          pingOnce={pingOnce}
        />
      )}
      {showSettings && (
        <SettingsModal
          key={settingsTab}
          profiles={profiles}
          profilesLoaded={profilesLoaded}
          initialTab={settingsTab}
          onClose={() => { setShowSettings(false); }}
          onCompactionChanged={(updated) => {
            setHandoffMode(updated.handoffMode);
            setDefaultSpawnWorkdir(updated.defaultSpawnWorkdir);
            if (updated.interactionMode) setDefaultInteractionMode(updated.interactionMode);
          }}
          onSandboxChanged={setSandboxSettings}
          onGeneralChanged={(updated) => {
            setDefaultConversationProfileId(updated.defaultConversationProfileId);
            setFileEditsEnabled(!!updated.fileEditsEnabled);
            setHideShippedSchedulePacks(!!updated.hideShippedSchedulePacks);
            setGrokBotInProjectChats(!!updated.grokBotInProjectChats);
            if (updated.memories !== undefined) {
              setMemoriesEnabled(updated.memories === true);
              if (updated.memories === true) {
                api.memoryCounts().then(setMemoryCounts).catch(() => {});
              }
            }
          }}
          onCatalogueChanged={refreshProfiles}
          catalogueVersion={catalogueVersion}
          onGlobalTasksChanged={handleGlobalTasksSettingsChanged}
          onVoiceTtsChanged={(updated) => { setTts(updated); setTtsConfig(updated); }}
          onVoiceCleanupChanged={(cleanup) => setTtsSummarizeAvailable(ttsSummarizeConfigured(cleanup))}
          remoteHosts={remoteHosts}
          onRemoteHostsChange={setRemoteHosts}
        />
      )}
      {rulesTarget && (
        <RulesModal
          target={rulesTarget}
          prefill={rulesPrefill}
          onClose={() => {
            setRulesTarget(null);
            setRulesPromoteRef(null);
            setRulesPrefill(undefined);
          }}
          onRulesSubmitted={() => {
            if (rulesPromoteRef) {
              const memId = rulesPromoteRef.memoryId;
              api.promoteMemory(memId).catch(() => {});
              setRulesPromoteRef(null);
              setRulesPrefill(undefined);
            }
          }}
          onSaved={(updated) => {
            setSidebarRefetchTrigger((n) => n + 1);
            setSelection((cur) => {
              if (!cur) return cur;
              if ('rootPath' in updated) {
                if (cur.project && cur.project.id === updated.id) {
                  return { ...cur, project: updated };
                }
                return cur;
              }
              if (cur.type === 'conversation' && cur.conversation.id === updated.id) {
                return { ...cur, conversation: updated };
              }
              return cur;
            });
          }}
        />
      )}
      {showAddSubagentModal && conversation && (
        <AddSubagentModal
          conversation={conversation}
          template={spawnTemplate}
          conversationPin={conversation.spawnWorkdir ?? null}
          globalDefault={defaultSpawnWorkdir}
          onClose={() => setShowAddSubagentModal(false)}
          onCreated={(child) => { void openConversationById(child.id); }}
        />
      )}
      {editConvOpen && conversation && (
        <EditConversationModal
          conversation={conversation}
          profileLabels={profileLabels}
          onClose={() => setEditConvOpen(false)}
          onSaved={(updated) => {
            onConversationRenamed(updated);
            setSidebarRefetchTrigger((n) => n + 1);
          }}
        />
      )}
      {btwListOpen && (
        <BtwListModal
          queries={btwQueries}
          onSelect={(q) => { setBtwPopupQueryId(q.id); setBtwListOpen(false); }}
          onClose={() => setBtwListOpen(false)}
        />
      )}
      {spawnApprovalOpen && (
        <SpawnApprovalModal
          requests={spawnRequests}
          onApprove={async (id) => {
            try { await api.approveSpawnRequest(id); } catch { /* 409 = already decided */ }
            api.listSpawnRequests().then(setSpawnRequests).catch(() => {});
          }}
          onDeny={async (id, reason) => {
            try { await api.denySpawnRequest(id, reason); } catch { /* 409 = already decided */ }
            api.listSpawnRequests().then(setSpawnRequests).catch(() => {});
          }}
          onClose={() => setSpawnApprovalOpen(false)}
        />
      )}
      {btwOpenFile && (
        <FileModal
          path={btwOpenFile}
          remoteHostName={remoteHostLabel(project?.remoteHostId, remoteHosts)}
          onClose={() => setBtwOpenFile(null)}
          onOpenFile={setBtwOpenFile}
          conversationId={conversation?.id}
          projectId={project?.id}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
          agentRunning={isRunning}
          fileEditsEnabled={fileEditsEnabled}
        />
      )}
      {showHelpers && helperRuns.length > 0 && conversation && (
        <HelpersModal
          runs={helperRuns}
          events={events}
          focusKey={helperFocus}
          highlightQuery={helperHighlightQuery}
          canStop={activeAgentType === 'claude-code' && helperLive}
          onStop={(t) => stopHelper(conversation.id, t)}
          onClose={() => { setShowHelpers(false); setHelperFocus(undefined); setHelperHighlightQuery(undefined); }}
        />
      )}
      {showTaskList && (() => {
        const todos = latestTodos(events);
        return todos ? <TaskListModal todos={todos} onClose={() => setShowTaskList(false)} /> : null;
      })()}
      {showUsage && conversation && (
        <UsagePanel
          conversationId={conversation.id}
          agentType={activeAgentType}
          isRunning={isRunning}
          onClose={() => setShowUsage(false)}
        />
      )}
      {pendingFork && (
        <div className="modal-overlay">
          <form className="modal-content" onSubmit={confirmFork}>
            <div className="modal-header">Fork Conversation</div>
            <div className="modal-body">
              <div className="modal-field">
                <label className="modal-label">New conversation title</label>
                <input
                  type="text"
                  className="modal-input"
                  value={pendingFork.title}
                  onChange={(e) => setPendingFork({ ...pendingFork, title: e.target.value })}
                  required
                  autoFocus
                />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="modal-btn" onClick={() => setPendingFork(null)}>Cancel</button>
              <button type="submit" className="modal-btn primary">Fork</button>
            </div>
          </form>
        </div>
      )}
      {pendingHandoff && (
        <HandoffChoiceModal
          pending={{ fromLabel: pendingHandoff.fromLabel, toLabel: pendingHandoff.toLabel }}
          options={pendingHandoff.options}
          onChoose={handleHandoffChoose}
          onCancel={handleHandoffCancel}
        />
      )}
      {forceSteerToast && (
        <div className="force-steer-toast" role="status" onClick={clearForceSteerToast}>
          {forceSteerToast}
        </div>
      )}
      {pushResultToast && (
        <div className="force-steer-toast" role="status" onClick={() => setPushResultToast(null)}>
          {pushResultToast}
        </div>
      )}
      {remoteDeleteToast && (
        <div className="force-steer-toast" role="status" onClick={() => setRemoteDeleteToast(null)}>
          {remoteDeleteToast}
        </div>
      )}
      {showCopyConversationModal && (
        <CopyConversationModal
          onChoose={handleCopyConversationChoose}
          onCancel={() => setShowCopyConversationModal(false)}
        />
      )}
      {showConversationInfo && conversation && (
        <ConversationInfoModal
          events={events}
          conversationTitle={conversation.title || 'Untitled'}
          agentModel={selectedProfile?.label}
          isConversationActive={effectiveStatus === 'running' || effectiveStatus === 'waiting'}
          forceInterruptedPromptIds={forceInterruptedPromptIds}
          onOpenFile={setBtwOpenFile}
          onClose={() => setShowConversationInfo(false)}
        />
      )}
      {summaryModal && (
        <HandoffSummaryModal
          text={summaryModal.text}
          handoff={summaryModal.handoff}
          profileLabels={profileLabels}
          onClose={() => setSummaryModal(null)}
          onOpenFile={setBtwOpenFile}
          ttsEnabled={tts?.enabled ?? false}
          ttsProvider={tts?.provider}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
        />
      )}
      {showSummaryList && conversation && (
        <SummaryListModal
          conversationId={conversation.id}
          summaries={summaryList}
          handoffsBySummaryId={handoffBySummaryId}
          profileLabels={profileLabels}
          onSelect={(text, handoff) => {
            setSummaryModal({ text, handoff });
            setShowSummaryList(false);
          }}
          onClose={() => setShowSummaryList(false)}
        />
      )}
      {showMarkdownList && conversation && (
        <MarkdownListModal
          paths={markdownPaths}
          conversationId={conversation.id}
          onSelect={(path) => {
            setBtwOpenFile(path);
            setShowMarkdownList(false);
          }}
          onClose={() => setShowMarkdownList(false)}
        />
      )}
      {showTtsRecordings && project && (
        <TtsRecordingsModal
          projectId={project.id}
          conversationId={conversation?.id ?? null}
          recordings={ttsRecordings}
          convTitles={ttsConvTitles}
          onDeleted={(id) => setTtsRecordings((list) => list.filter((r) => r.id !== id))}
          onClose={() => setShowTtsRecordings(false)}
        />
      )}
      {gitPanel && (
        <GitWorkingTreeModal
          open={gitPanel}
          selectedConversation={conversation}
          selectedProject={project}
          onClose={() => {
            setGitPanel(null);
            // Single-consume: a remount must not replay a stale generate/error frame.
            setGitCommitDraftFrame(null);
          }}
          onUnauthorized={onDeauthenticate}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
          fileEditsEnabled={fileEditsEnabled}
          commitDraftFrame={gitCommitDraftFrame}
          onSubmitPrompt={submitGitPrompt}
          submitTarget={gitPromptTarget}
        />
      )}
      {fileBrowserOpen && (
        <FileBrowserModal
          selectedConversation={conversation}
          selectedProject={project}
          remoteHosts={remoteHosts}
          onClose={() => setFileBrowserOpen(false)}
          onUnauthorized={onDeauthenticate}
          tts={tts}
          ttsSummarizeAvailable={ttsSummarizeAvailable}
          fileEditsEnabled={fileEditsEnabled}
          agentRunning={isRunning}
        />
      )}
      {showCheckpointList && conversation && (
        <CheckpointListModal
          conversationId={conversation.id}
          checkpoints={checkpoints}
          workdirPath={conversation.workdirPath}
          isRunning={isRunning}
          restoreInFlight={restoreTarget !== null}
          onRestore={(cp, hasCode) => setRestoreTarget({ cp, hasCode })}
          onClose={() => setShowCheckpointList(false)}
        />
      )}
      {restoreTarget && conversation && (
        <RestoreChoiceModal
          checkpoint={restoreTarget.cp}
          hasCodeChanges={restoreTarget.hasCode}
          isSharedRoot={!conversation.workdirPath}
          onRestore={async (opts) => {
            const result = await api.rewindConversation(conversation.id, {
              eventId: restoreTarget.cp.eventId,
              ...opts,
            });
            await refetchAfterRewind();
            return result;
          }}
          onClose={() => setRestoreTarget(null)}
        />
      )}
      {showLogoutConfirm && (
        <ConfirmDialog
          title="Confirm Sign Out"
          danger
          confirmLabel="Sign out"
          body="Are you sure you want to sign out?"
          onCancel={() => setShowLogoutConfirm(false)}
          onConfirm={handleLogout}
        />
      )}
      {duplicateConfirmConv && (
        <ConfirmDialog
          title="Duplicate conversation"
          busy={duplicateBusy}
          confirmLabel="Duplicate"
          body={(
            <>
              Duplicate <code>{duplicateConfirmConv.title}</code>?
              <br /><br />
              A new chat titled “Copy of {duplicateConfirmConv.title}” will appear in the sidebar.
            </>
          )}
          onCancel={() => setDuplicateConfirmConv(null)}
          onConfirm={() => { void submitDuplicateConversation(); }}
        />
      )}
      {alertDialog && (
        <ConfirmDialog
          title={alertDialog.title ?? 'Notice'}
          body={alertDialog.message}
          confirmLabel="OK"
          onConfirm={() => setAlertDialog(null)}
        />
      )}
      <CommandPalette
        isOpen={commandPaletteOpen}
        onClose={() => setCommandPaletteOpen(false)}
        projects={directoryRef.current.projects}
        conversations={directoryRef.current.conversations}
        onSelectConversation={(p, c, focusEventId, focusQuery) => {
          setSidebarRevealTick((t) => t + 1);
          void onSelectConversation(p, c, focusEventId, focusQuery ? { focusQuery } : undefined);
        }}
        onSelectProject={handleSelectProjectFromPalette}
        onExecuteAction={handleExecutePaletteAction}
        focusTick={paletteFocusTick}
        initialMode={paletteInitialMode}
        activeProjectId={project?.id ?? null}
      />
      </div>
    </OpenFileContext.Provider>
  );
}
