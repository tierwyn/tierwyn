import { randomUUID, createHash } from 'crypto';
import { hostname as osHostname } from 'os';
import type { ChildProcess } from 'child_process';
import type { Database } from 'better-sqlite3';
import { catalogue } from './catalogue.js';
import { registry, type AdapterFactoryOpts } from './registry.js';
import { writeTempAttachments, type TempFile } from './imageHelper.js';
import { getDb } from './db/index.js';
import { getProject } from './repositories/projects.js';
import { effectiveAgentSearchScope } from './agentSearchScope.js';
import { assembleAgentPromptText, bareChildResultPath, buildBareChildProtocolNote, buildBarePrimingHostNote } from './promptText.js';
import { recallMemories, isEligibleRecallSource } from './memory/recall.js';
import {
  createSession, getSession, setNativeSessionId, setSessionAgentModel, setSessionUsage, setSessionUsageInflight,
  lastSessionForConversation, lastPreambleFp, setPreambleFp,
} from './repositories/sessions.js';
import { appendEvent, listEventsForConversation, listEventsForSession, listOrphanShellToolCalls } from './repositories/events.js';
import { getLatestSummary } from './repositories/summaries.js';
import { insertHandoff } from './repositories/handoffs.js';
import { touchConversation, getConversation, spawnPolicyDepth, isPolicyRoot, clearConversationPendingHandoffMode } from './repositories/conversations.js';
import { getEdgeByChild, consumeFollowupSlot, resolveSpawnEdge } from './repositories/spawnEdges.js';
import { cancelPendingNonOperatorTimers } from './repositories/conversationTimers.js';
import { resolveConversationProfile } from './repositories/capabilityProfiles.js';
import { createProseAccumulator, frameSubagentProse, failureHint, shortReason } from './spawn/prose.js';
import { getCompactionSettings, getGeneralSettings, getGlobalTasksSettings, getTemplate, listDesignationCatalogue } from './repositories/settings.js';
import {
  assertValidRemoteAgentProfile,
  assertGrokBotConversationWritable,
  assertGrokBotAllowedInProject,
  grokBotBarePrimingEnabled,
} from './repositories/remoteAgents.js';
import {
  buildDelegationPreamble, buildDelegationStub,
  buildScheduleOnlyPreamble, buildScheduleOnlyStub,
  type MarkupHint,
  spawnFpPayload,
  meshFpExtras,
  searchFpExtra,
  scopeAgentPlugins,
  type AgentPlugins,
} from './spawn/preamble.js';
import { shouldInjectPreamble } from './spawn/preamble-gate.js';
import { safePersistedNativeSessionId } from './adapters/sessionId.js';
import { choosePreambleMode, makeFingerprint } from './spawn/preamble-mode.js';
import { hostFacts, remoteHostNote } from './node/hostFacts.js';
import { isProjectMoving, PROJECT_MOVING_ERROR } from './projectMove.js';
import { loadRules, rulesFpExtra, rulesLines } from './spawn/rules.js';
import { MAX_SPAWN_DEPTH, AGENT_SELF_TIMERS } from './spawn/config.js';
import { envPref } from './config/env.js';
import { ensureProjectStateGitExclude } from './git/exclude.js';

import { issueSpawnToken, revokeSpawnTokensForSession, revokeSpawnTokensForConversation, touchSpawnToken, touchSpawnTokensForSession, getLiveTokenForConversation, peekSpawnToken, SPAWN_CAPABILITIES, SCHEDULE_CAPABILITIES, CONVERSATION_CAPABILITIES, getSpawnTokenTtlMs, type TokenCapability } from './spawn/tokens.js';
import { liveEdgeSetHash } from './mesh/edges.js';
import { flushMeshMailbox } from './mesh/mailbox.js';
import { globalTasksAllowed, profileAvailableOnHost, unionSandboxPaths, type RemoteHostView, type ResolvedSandbox, type SandboxPath, type SandboxSetting } from '@tierwyn/shared';
import { SandboxError, bwrapAvailable } from './sandbox/bwrap.js';
import { hasSandboxProfile } from './sandbox/profiles.js';
import { sandboxCapability } from './sandbox/capability.js';
import { getSandboxSettings, resolveSandboxFor } from './repositories/sandboxSettings.js';
import { gateRemoteSandboxPaths } from './sandbox/remotePaths.js';

export function withSessionScope(
  db: ReturnType<typeof getDb>,
  base: ReadonlySet<TokenCapability>,
  conv: { id?: string; parentConversationId?: string | null; kind?: string },
): Set<TokenCapability> {
  const next = new Set(base);
  if (getCompactionSettings(db).meshMessaging !== 'off') next.add('mesh');
  const isRoot = conv.id ? isPolicyRoot(db, conv as { id: string; parentConversationId?: string | null; kind?: string }) : !conv.parentConversationId;
  if (globalTasksAllowed(getGlobalTasksSettings(db), isRoot)) next.add('tasks');
  if (getGeneralSettings(db).memories) next.add('memory');
  return next;
}

/** Which token a session may hold. The one rule shared by session start, the
 *  steer wake path and /reissue-token: bare-prompt adapters get none, templated
 *  convs under the depth/breadth gate get spawn, everything else gets schedule. */
type TokenEntitlement =
  | { kind: 'none' }
  | { kind: 'spawn'; template: SpawnTemplate }
  | { kind: 'schedule' };

function tokenEntitlement(
  db: ReturnType<typeof getDb>,
  conv: NonNullable<ReturnType<typeof getConversation>> | undefined,
  agentType: string | undefined,
  profile: AgentProfile | undefined,
): TokenEntitlement {
  if (!conv || agentTakesBarePrompt(agentType)) return { kind: 'none' };
  if (conv.templateName && shouldInjectPreamble({
    depth: spawnPolicyDepth(db, conv.id), hasTemplate: true, maxDepth: MAX_SPAWN_DEPTH, profile,
  })) {
    const template = getTemplate(db, conv.templateName);
    if (template) return { kind: 'spawn', template };
  }
  return { kind: 'schedule' };
}
// ponytail: preamble rebuilt per parent turn; cache per session if token cost bites
import { buildResumePlan } from './compaction/compactor.js';
import { mergePromptAttachments } from './compaction/handoffAttachments.js';
import { ARGV_PRIMING_BYTES, ARGV_PROMPT_ADAPTERS } from './compaction/primingCap.js';
import { makeAdapterRunner } from './compaction/runner.js';
import { estimateTokens } from './compaction/tokenizer.js';
import { recordAutoCheckpoint } from './checkpointService.js';
import { autoTagConversationIfDue } from './autoTags.js';
import { resolveConversationCwd } from './git/shadowCheckpoint.js';
import { describeConversationIfFirst } from './conversationDescribe.js';
import type { AgentAdapter, AgentProfile, AgentStatus, EffortLevel, HandoffOverride, HandoffRequestedMode, NormalisedEvent, ServerFrame, StatusEvent, StopSessionResult, SteerSessionResult, QueuedMessage, SpawnMarker, SubagentNotifyMeta, PromptOptions, SpawnTemplate } from '@tierwyn/shared';
import { agentSupportsPermissionMode, agentTakesBarePrompt, hostHasFeature, BARE_PROMPT_ADAPTERS, capabilityProfileFp, clampEffort, grokBotUsable, HARD_STOP_ADAPTERS, HOLD_OPEN_FOLLOWUP_ADAPTERS, interactionModeRequiresPermissionCapable, matchesQuotaShape, profileAcceptsImages, profileAllowsMemory, promptOptionsEqual, sanitisePromptOptions, stripCommandIncompatibleOptions, PromptOptionError, type GrokBotLifecycleStatus, selfTimerAllowed } from '@tierwyn/shared';

import type { LimitCandidate } from './schedules/usageLimitWatcher.js';
import type { ResolvedCapabilityProfile, ResolvedMcpServer } from '@tierwyn/shared';
import { resolveSessionMcp, type ResolveResult } from './mcp/resolve.js';
import { getRemoteHost, remoteHostIdFor } from './repositories/remoteHosts.js';

type UsageEstimate = (text: string) => number;
const INFLIGHT_USAGE_DEBOUNCE_MS = 3000;
/** How long a mid-turn parent may stay stream-idle with a sourced notify
 *  queued before we soft-interrupt so the steer loop can drain it.
 *  Natural end-of-stream always drains sooner (no cancel). Tests override via Deps. */
export const DEFAULT_SOURCED_NOTIFY_IDLE_MS = 30_000;

/** True when a CLI supplied a usable token count (0 is valid — e.g. cache-only input). */
function isReportedTokenCount(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0;
}

function appendTrackedUsageText(outputText: string, event: NormalisedEvent): string {
  if (event.type === 'message' && event.payload.chunk) {
    return outputText + event.payload.chunk;
  }
  if (event.type === 'tool_call') {
    try {
      return outputText + JSON.stringify(event.payload.input ?? {});
    } catch {
      return outputText;
    }
  }
  if (event.type === 'tool_result') {
    return outputText + (event.payload.content ?? '');
  }
  return outputText;
}

function shouldScheduleInflightUsage(event: NormalisedEvent): boolean {
  return (event.type === 'message' && !!event.payload.chunk)
    || event.type === 'tool_call'
    || event.type === 'tool_result';
}

function createUsageTracker(initialPrompt: string, estimate?: UsageEstimate) {
  let promptText = initialPrompt;
  let outputText = '';
  const est = estimate ?? ((t: string) => estimateTokens(t));

  return {
    setPromptText(text: string) { promptText = text; },
    trackMessage(event: NormalisedEvent) {
      outputText = appendTrackedUsageText(outputText, event);
    },
    snapshot() {
      return { inputTokens: est(promptText), outputTokens: est(outputText) };
    },
    resolve(payload: StatusEvent['payload']) {
      let {
        inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
        costUsd, contextWindowPct, fiveHourPct, fiveHourResetsAt,
        sevenDayPct, sevenDayResetsAt, tokensEstimated,
      } = payload;

      const needsInput = !isReportedTokenCount(inputTokens);
      const needsOutput = !isReportedTokenCount(outputTokens);
      if (needsInput || needsOutput) {
        if (needsInput) inputTokens = est(promptText);
        if (needsOutput) outputTokens = est(outputText);
        tokensEstimated = true;
      } else {
        tokensEstimated = false;
      }

      return {
        inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
        costUsd, contextWindowPct, fiveHourPct, fiveHourResetsAt,
        sevenDayPct, sevenDayResetsAt, tokensEstimated,
      };
    },
  };
}

function persistTerminalUsage(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  tracker: ReturnType<typeof createUsageTracker>,
  inflightUsage: ReturnType<typeof createInflightUsageFlusher>,
  payload: StatusEvent['payload'],
): void {
  inflightUsage.cancel();
  const status = payload.status;
  if (status === 'done' || status === 'error') {
    setSessionUsage(db, sessionId, tracker.resolve(payload));
    return;
  }
  // stop() on steer-loop adapters (hold-open, etc.) emits idle without usage.
  // Finalize with the best tokenizer estimate we have, but never clobber a
  // prior done/error row that already captured CLI-reported counts.
  if (status === 'idle') {
    const existing = getSession(db, sessionId);
    if (existing?.tokensEstimated === false) return;
    setSessionUsage(db, sessionId, tracker.resolve({ status: 'idle' }));
  }
}

function createInflightUsageFlusher(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  tracker: ReturnType<typeof createUsageTracker>,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    timer = undefined;
    setSessionUsageInflight(db, sessionId, tracker.snapshot());
  };

  return {
    writeInitial() { flush(); },
    schedule() {
      if (timer) return;
      timer = setTimeout(flush, INFLIGHT_USAGE_DEBOUNCE_MS);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** WP-2.1: effective interaction mode for a turn. Precedence:
 *  turn override (spawn/timer children pin 'bypass') → conversation column
 *  → global CompactionSettings.interactionMode. */
export function effectiveInteractionMode(
  db: Database,
  conversationId: string,
  override?: 'bypass' | 'questions' | 'prompt',
): 'bypass' | 'questions' | 'prompt' {
  if (override) return override;
  try {
    const conv = getConversation(db, conversationId);
    if (conv?.permissionMode) return conv.permissionMode;
  } catch { /* ignore */ }
  try {
    return getCompactionSettings(db).interactionMode ?? 'bypass';
  } catch {
    return 'bypass';
  }
}

export interface SessionRecord {
  id: string;
  conversationId: string;
  agentType: string;
  model: string;
  profileId: string;
  adapter: AgentAdapter;
  startedAt: number;
  /** The interaction mode the adapter was created with (WP-2.1).
   *  Compared at parked adoption to prevent stale-mode reuse. */
  interactionMode: 'bypass' | 'questions' | 'prompt';
  /** Whether agent-sandbox (bwrap) was active when this session was created.
   *  Parked adoption requires equality so a sandbox toggle reaps stale processes. */
  sandbox?: boolean;
  /** Effective (clamped) reasoning effort for the turn that opened this
   *  session. Undefined for adapters with no effort knob and for internal
   *  re-dispatch paths (queue drain / spawn / schedule tick) that do not
   *  thread effort. Surfaced by GET /sessions/active. */
  effort?: EffortLevel;
  /** Tripped by stopSession so handlePrompt's await boundaries can bail
   *  before invoking the adapter. The signal is idempotent — late aborts
   *  after the adapter has started are also fine, since adapter.stop() is
   *  still called. */
  abortController: AbortController;
  /** True once adapter.start() has resolved. stopSession consults this to
   *  decide whether to call adapter.stop() or treat the abort as
   *  pre-start cancellation. */
  started: boolean;
  /** Messages the user sent while this turn was in flight. Kept as QueuedMessage list. */
  steerQueue: QueuedMessage[];
  /** True when native mid-turn injection is possible for this session
   *  (profile.steer === true AND adapter implements steer()). The turn must
   *  also have started — that is checked at steer time, not here. */
  injectable: boolean;
  /** Enough of the originating request to re-dispatch a follow-up turn through
   *  handlePrompt / handleCommand (so resume/compaction/handoff all apply).
   *  Queued items with commandName drain via handleCommand; plain text via handlePrompt. */
  steerOrigin: {
    projectId: string;
    conversationId: string;
    agent: string;
    model: string;
    profileId: string;
    /** Resolved tick/worktree cwd; drain-on-end follow-ups must keep it. */
    cwd?: string;
    interactionMode?: 'bypass' | 'questions' | 'prompt';
  };
  /** Last status event observed for this session ('running' | 'waiting' | 'done' | 'error').
   *  Set from adapterEvents 'event' handler. Used by the subscribe path to
   *  decide whether a re-advertised session_started should pin the client's
   *  status map to 'running' (true mid-turn) or to the terminal status
   *  (session parked after status:done, e.g. a hold-open steer loop). */
  lastStatus?: AgentStatus;
  /** Wall-clock of the last adapter stream event (message/tool/status/…).
   *  Used to decide whether a queued sourced notify should wait for natural
   *  end-of-stream or soft-interrupt after idle. */
  lastActivityAt: number;
  /** Pending idle-interrupt timer for sourced steers (cleared on activity / cleanup). */
  sourcedInterruptTimer?: ReturnType<typeof setTimeout>;
  /** Temp files written for steer-loop / Interrupt & Send attachments (path-only
   *  adapters like grok-build). Cleaned when the session ends. */
  attachmentTempFiles: TempFile[];
  /** Operator Stop / Interrupt & Send: stamp status:done + session_ended so
   *  spawn watchers and the upward bridge do not treat this as a child result. */
  suppressParentNotify?: boolean;
  /** Sanitised option bag the process was actually spawned with.
   *  Parked hold-open adoption compares this to the incoming bag via promptOptionsEqual —
   *  identical bags (including sticky repeats) adopt; a change reaps and respawns. */
  appliedOptions?: PromptOptions;
  /** Template name this session was spawned with (or null if none). */
  templateName?: string | null;
  /** Hash of the template definition at spawn time. */
  templateHash?: string;
  /** Token entitlement kind ('none' | 'spawn' | 'schedule') at spawn time.
   *  Parked adoption requires equality so enabling/disabling maxConcurrentSpawns
   *  on the model reaps the parked session and injects the updated preamble + token. */
  tokenKind?: TokenEntitlement['kind'];
  /** resolveSessionMcp hash the process was spawned with ('' = none). Parked
   *  adoption requires equality so a selection / registry / secret change reaps. */
  mcpHash?: string;
  /** Resolved MCP servers for adapter.start. In memory only — carries secret values. */
  mcpServers?: ResolvedMcpServer[];
  /** When true, ignore native CLI MCP configs. */
  disableNativeMcp?: boolean;
  /** Specific native CLI MCP server names to disable. */
  disabledNativeMcp?: string[];
  /** Hash of operator rules injected at spawn / last adoption (D6 hold-open). */
  rulesHash?: string;
  /** Native CLI helper taskIds currently running in this session. */
  runningHelpers?: Set<string>;
}

/** Prefix for hold-open adoption when operator rules changed since spawn. Adapter-only. */
function holdOpenRulesPrefix(
  db: ReturnType<typeof getDb>,
  adopt: SessionRecord,
  conversationId: string,
  project: NonNullable<ReturnType<typeof getProject>>,
  agentType: string,
): string | undefined {
  if (agentTakesBarePrompt(agentType)) return undefined;
  const conv = getConversation(db, conversationId);
  const view = conv ? loadRules(db, conv, project) : undefined;
  const nextHash = view?.hash ?? '';
  if (nextHash === (adopt.rulesHash ?? '')) return undefined;
  adopt.rulesHash = nextHash;
  const body = view
    ? rulesLines(view, 'full').join('\n').trim()
    : 'Earlier operator rules no longer apply.';
  return [
    '## Operator rules (updated — these replace any earlier operator rules)',
    body,
    '',
    '---',
  ].join('\n');
}

/** WS-boundary allow-list: anything else is treated as no override. */
const VALID_HANDOFF_OVERRIDES = new Set<HandoffOverride>(['summary', 'transcript', 'fresh']);

/** Effective MCP set for a session start and GET /conversations/:id/mcp. Never throws.
 *  Per-message claude `safeMode` wins: nothing injected. Delegating = the session would
 *  hold a spawn-capable token (same rule as tokenEntitlement). */
export function resolveMcpForConversation(
  db: ReturnType<typeof getDb>,
  conversationId: string,
  agentType: string,
  profileId: string | undefined,
  promptOptions?: PromptOptions,
): ResolveResult & { delegating: boolean } {
  const empty = { inject: [], skipped: [], hash: '', selected: [], delegating: false, disableNative: false, disabledNative: [] };
  if (promptOptions?.safeMode === true) return empty;
  try {
    const conv = getConversation(db, conversationId);
    const template = conv?.templateName ? getTemplate(db, conv.templateName) : undefined;
    const delegating = tokenEntitlement(db, conv, agentType, profileId ? catalogue.getProfile(profileId) : undefined).kind === 'spawn';
    const remoteHostId = remoteHostIdFor(db, { conversationId });
    const agentCwd = resolveConversationCwd(db, conversationId) ?? undefined;
    const resolved = resolveSessionMcp({
      db, conv, template, agentType, delegating, remoteHostId,
      // stdio/sse hub rows need the streaming tunnel; http rows fall back to the buffered relay.
      ...(remoteHostId ? { remoteStreaming: hostHasFeature(getRemoteHost(db, remoteHostId)?.hello, 'tunnel.stream') } : {}),
      ...(agentCwd ? { agentCwd } : {}),
    });
    return { ...resolved, delegating };
  } catch (err) {
    console.warn(`[mcp] resolve failed for ${conversationId}: ${(err as Error).message}`);
    return empty;
  }
}

function mcpRecordFields(r: ResolveResult): Pick<SessionRecord, 'mcpHash' | 'mcpServers' | 'disableNativeMcp' | 'disabledNativeMcp'> {
  return {
    mcpHash: r.hash,
    ...(r.inject.length ? { mcpServers: r.inject } : {}),
    ...(r.disableNative ? { disableNativeMcp: true } : {}),
    ...(r.disabledNative.length ? { disabledNativeMcp: r.disabledNative } : {}),
  };
}

function getTemplateHash(template: SpawnTemplate | undefined): string {
  if (!template) return '';
  return createHash('sha1').update(JSON.stringify(template)).digest('hex').slice(0, 12);
}

interface PromptInput {
  projectId: string;
  conversationId: string;
  agent: string;
  model: string;
  profileId: string;
  text: string;
  attachments?: { base64: string; mediaType: string; name?: string }[];
  /** One-shot resume-plan override (skips native resume; 'fresh' resets context). */
  handoffOverride?: HandoffOverride;
  /** Override working directory for the adapter subprocess. Defaults to project.rootPath. */
  cwd?: string;
  /** ponytail: per-prompt override passed to the adapter factory. /spawn uses
   *  this to force 'bypass' on children so they never block on a permission
   *  card the parent can't see. */
  interactionMode?: 'bypass' | 'questions' | 'prompt';
  /** Origin of this prompt. 'subagent_notify' = silent follow-up from a
   *  child's notifyParent result. 'parent_message' = downward message from a
   *  validated ancestor. Affects ONLY persistence + UI rendering (sender
   *  becomes 'system', UI hides the User card); the LLM still receives
   *  input.text verbatim. */
  source?: 'user' | 'subagent_notify' | 'parent_message' | 'peer_message';
  /** Present iff source is 'subagent_notify' or 'parent_message'. */
  subagent?: SubagentNotifyMeta;
  /** Effective reasoning effort for this turn (client-clamped). Server re-clamps
   *  before adapter + prompt-event persistence. */
  effort?: EffortLevel;
  /** One-shot per-turn adapter options. Re-sanitised here; never persisted. */
  options?: PromptOptions;
  /** Schedule-tick metadata persisted on the prompt event (source stays 'user'). */
  schedule?: { jobId: string; jobName: string; runId: string };
  /** Opt out of keyword recall for this turn (follow-up drains, slash, notify). */
  skipRecall?: boolean;
}

/** Resolve handoff + turn attachments for adapter delivery. Reads the just-
 *  persisted prompt row as a fallback so images on the handoff message are not
 *  lost when priming excludes the current session from transcript collection. */
function prepareSendAttachments(
  db: ReturnType<typeof getDb>,
  profile: AgentProfile,
  sessionId: string,
  inputAttachments: { base64: string; mediaType: string; name?: string }[] | undefined,
  primingAttachments: { base64: string; mediaType: string; name?: string }[] | undefined,
): { adapterAttachments: { base64: string; mediaType: string; name?: string; tempPath?: string }[]; tempFiles: TempFile[] } {
  const persistedTurnAtts = listEventsForSession(db, sessionId)
    .filter((e) => e.type === 'prompt')
    .flatMap((e) => (e.payload as { attachments?: { base64: string; mediaType: string; name?: string }[] }).attachments ?? []);
  const turnAttachments = mergePromptAttachments(inputAttachments, persistedTurnAtts);
  const primingAtts = profileAcceptsImages(profile) ? primingAttachments : undefined;
  const sendAttachments = mergePromptAttachments(turnAttachments, primingAtts);
  if (sendAttachments.length === 0) {
    return { adapterAttachments: [], tempFiles: [] };
  }
  const tempFiles = writeTempAttachments(sendAttachments);
  const adapterAttachments = sendAttachments.map((a, i) => ({
    ...a,
    tempPath: tempFiles[i]?.path,
  }));
  return { adapterAttachments, tempFiles };
}

export interface CommandInput {
  projectId: string;
  conversationId: string;
  agent: string;
  model: string;
  profileId: string;
  name: string;
  args?: string;
  attachments?: { base64: string; mediaType: string; name?: string }[];
  handoffOverride?: HandoffOverride;
  /** Effective reasoning effort for this turn (client-clamped). */
  effort?: EffortLevel;
  /** Override working directory (worktree / schedule). Defaults to project root. */
  cwd?: string;
  interactionMode?: 'bypass' | 'questions' | 'prompt';
  /** One-shot per-turn adapter options. Re-sanitised here; never persisted. */
  options?: PromptOptions;
}

interface Deps {
  broadcast: (conversationId: string, frame: ServerFrame) => void;
  /** Fan a frame to every operator socket, bypassing the per-conversation
   *  broadcast wrapper (which appends its own bare conversation_updated). */
  broadcastAll?: (frame: ServerFrame) => void;
  /** Override idle wait before soft-interrupt of a mid-turn parent holding
   *  sourced notifies. Default DEFAULT_SOURCED_NOTIFY_IDLE_MS. */
  sourcedNotifyIdleMs?: number;
  /** Injectable clock for idle-interrupt tests. */
  now?: () => number;
  /** Optional plugin host: roster for preambles + fingerprint over the
   *  enabled agent-callable capability set. */
  pluginHost?: { listForAgent(): AgentPlugins; pluginSetHash(): string };
  /** Usage-limit watcher layer 1: quota-shaped failures at terminal boundaries
   *  arm a candidate (notification-only in Phase 5). */
  usageWatcher?: { arm: (c: LimitCandidate) => void };
  /** Live Grok Bot supervisor snapshot — used to drop grok-bot from the
   *  parent delegation roster when the app is unusable. */
  grokBotStatus?: () => GrokBotLifecycleStatus;
  /** Live (or last-known disconnected) view of a remote host. Missing host → disconnected. */
  remoteHosts?: { view(hostId: string): RemoteHostView | undefined };
}

function assertProfileAvailableOnHost(
  project: NonNullable<ReturnType<typeof getProject>>,
  profile: Pick<AgentProfile, 'agentType' | 'model' | 'label'>,
  view?: (hostId: string) => RemoteHostView | undefined,
): void {
  if (!project.remoteHostId) return;
  const avail = profileAvailableOnHost(profile, view?.(project.remoteHostId));
  if (!avail.ok) {
    throw new Error(`Profile ${profile.label} not available on host: ${avail.reason}`);
  }
}

function assertHostSupportsUntrustedProject(
  project: NonNullable<ReturnType<typeof getProject>>,
  view?: (hostId: string) => RemoteHostView | undefined,
): void {
  if (!project.remoteHostId || project.trustRepoConfig === true) return;
  const hello = view?.(project.remoteHostId)?.hello;
  if (!hostHasFeature(hello, 'trust_repo_config')) {
    throw new Error('Update tierwyn node on the remote host to run untrusted projects');
  }
}

function liveAdapterOpts(
  interactionMode: 'bypass' | 'questions' | 'prompt',
  project: NonNullable<ReturnType<typeof getProject>>,
  conv: { sandbox?: SandboxSetting } | undefined,
  db: ReturnType<typeof getDb>,
  agentType: string,
  view?: (hostId: string) => RemoteHostView | undefined,
): { interactionMode: 'bypass' | 'questions' | 'prompt'; sandbox: boolean; resolved: ResolvedSandbox; remoteHostId?: string; sandboxPaths?: SandboxPath[]; pathNotice?: string } {
  const hostId = project.remoteHostId ?? 'hub';
  const hello = project.remoteHostId ? view?.(project.remoteHostId)?.hello : undefined;
  const resolved = resolveSandboxFor(db, conv ?? {}, project, agentType, sandboxCapability(hostId, agentType, hello));
  const rawPaths = sessionCustomPaths(db, project);
  let sandboxPaths: SandboxPath[] | undefined;
  let pathNotice: string | undefined;
  if (project.remoteHostId) {
    const gated = gateRemoteSandboxPaths({
      paths: rawPaths,
      source: resolved.source,
      on: resolved.on,
      hello,
    });
    sandboxPaths = gated.sandboxPaths;
    pathNotice = gated.notice;
  } else if (rawPaths.length) {
    sandboxPaths = rawPaths;
  }
  return {
    interactionMode,
    sandbox: resolved.on,
    resolved,
    ...(project.remoteHostId ? { remoteHostId: project.remoteHostId } : {}),
    ...(sandboxPaths?.length ? { sandboxPaths } : {}),
    ...(pathNotice ? { pathNotice } : {}),
  };
}

function sessionCustomPaths(
  db: ReturnType<typeof getDb>,
  project: { remoteHostId?: string; sandboxPaths?: SandboxPath[] },
): SandboxPath[] {
  const hostId = project.remoteHostId ?? 'hub';
  const settings = getSandboxSettings(db);
  return unionSandboxPaths(settings.hostPaths[hostId] ?? [], project.sandboxPaths ?? []).map((p) => ({
    path: p.path,
    mode: p.mode,
    ...(p.optional !== undefined ? { optional: p.optional } : {}),
  }));
}

function toFactoryOpts(o: ReturnType<typeof liveAdapterOpts>): AdapterFactoryOpts {
  return {
    interactionMode: o.interactionMode,
    sandbox: o.sandbox,
    ...(o.remoteHostId ? { remoteHostId: o.remoteHostId } : {}),
    ...(o.sandboxPaths?.length ? { sandboxPaths: o.sandboxPaths } : {}),
  };
}

function sandboxUnavailableNotice(resolved: ResolvedSandbox): string {
  const why = resolved.reason ? ` (${resolved.reason})` : '';
  return `Sandbox: off (host can't sandbox)${why}. This turn ran unsandboxed.`;
}

function sandboxTurnNotices(opts: ReturnType<typeof liveAdapterOpts>): string[] {
  const out: string[] = [];
  if (opts.resolved.source === 'unavailable' && opts.resolved.wanted) {
    out.push(sandboxUnavailableNotice(opts.resolved));
  }
  if (opts.pathNotice) out.push(opts.pathNotice);
  return out;
}

/** Record a handoff row when the user switches agent profiles across a turn, or
 *  explicitly resets/hands over on the same profile (handoffOverride set).
 *  Skips native resumes and turns with no prior session. */
export function recordHandoff(
  db: ReturnType<typeof getDb>,
  opts: {
    conversationId: string;
    sessionId: string;
    toProfileId: string;
    handoffOverride: HandoffOverride | undefined;
    handoffMode: string;
    plan: { mode: string; primingPrompt?: string };
  },
): void {
  if (opts.plan.mode === 'native') return;

  const lastGlobal = lastSessionForConversation(db, opts.conversationId, { excludeId: opts.sessionId });
  if (!lastGlobal) return;
  if (!lastGlobal.agentModelId) return;
  if (!opts.handoffOverride && lastGlobal.agentModelId === opts.toProfileId) return;

  // Anchor = last event before this turn's prompt (same session is excluded).
  const events = listEventsForConversation(db, opts.conversationId)
    .filter((e) => e.sessionId !== opts.sessionId);
  if (events.length === 0) return;
  const anchorEventId = events[events.length - 1].id;

  const requestedMode: HandoffRequestedMode =
    opts.handoffOverride ?? (opts.handoffMode === 'transcript' ? 'transcript' : 'summary');

  const resolvedMode = opts.plan.mode as 'compacted' | 'transcript' | 'fresh';

  const summaryId =
    resolvedMode === 'compacted' ? (getLatestSummary(db, opts.conversationId)?.id ?? null) : null;

  insertHandoff(db, {
    conversation_id: opts.conversationId,
    from_profile_id: lastGlobal.agentModelId,
    to_profile_id: opts.toProfileId,
    requested_mode: requestedMode,
    resolved_mode: resolvedMode,
    anchor_event_id: anchorEventId,
    summary_id: summaryId,
    priming_context: opts.plan.primingPrompt ?? null,
  });
}

export class SessionManager {
  private sessions = new Map<string, SessionRecord>();
  private steerResolvers = new Map<string, ((msg: QueuedMessage | null) => void)[]>();
  private shellChildren = new Map<string, { child: ChildProcess; conversationId: string }>();
  /** Serializes reap + in-flight check + session register per conversation so
   *  concurrent mesh/operator prompts cannot open two live sessions. */
  private conversationGates = new Map<string, Promise<unknown>>();
  /** Follow-up drains in flight per conversation. hasPendingSteerWork is true
   *  while this is > 0 so schedule settle cannot finalise in the window after
   *  adapter 'end' cleanup() deletes the session and before handlePrompt
   *  registers the next one. */
  private pendingDrains = new Map<string, number>();
  // ponytail: lost on restart (one repeat), one small set per conversation until then
  private recallShown = new Map<string, Set<string>>();
  constructor(private deps: Deps) {}

  private shownFor(conversationId: string): Set<string> {
    let s = this.recallShown.get(conversationId);
    if (!s) {
      s = new Set();
      this.recallShown.set(conversationId, s);
    }
    return s;
  }

  private persistRecallChip(
    conversationId: string,
    sessionId: string,
    agentProfileId: string,
    ids: string[],
  ): void {
    this.persistAndBroadcast(conversationId, {
      type: 'message',
      sessionId,
      seq: 0,
      ts: Date.now(),
      sender: 'system',
      agentProfileId,
      payload: {
        chunk: '',
        recalledMemories: ids,
      },
    });
  }

  private hostFactsFor(project: { remoteHostId?: string } | undefined) {
    const localPort = parseInt(envPref('LISTEN_PORT') ?? process.env.PORT ?? '8787', 10);
    return hostFacts(project ?? {}, localPort, this.deps.remoteHosts?.view);
  }

  private beginPendingDrain(conversationId: string): void {
    this.pendingDrains.set(conversationId, (this.pendingDrains.get(conversationId) ?? 0) + 1);
  }

  private endPendingDrain(conversationId: string): void {
    const n = (this.pendingDrains.get(conversationId) ?? 1) - 1;
    if (n <= 0) this.pendingDrains.delete(conversationId);
    else this.pendingDrains.set(conversationId, n);
  }

  private async withConversationGate<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.conversationGates.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => { release = r; });
    const tail = prev.then(() => next);
    this.conversationGates.set(conversationId, tail);
    try {
      await prev;
      return await fn();
    } finally {
      release();
      if (this.conversationGates.get(conversationId) === tail) this.conversationGates.delete(conversationId);
    }
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private sourcedIdleMs(): number {
    return this.deps.sourcedNotifyIdleMs ?? DEFAULT_SOURCED_NOTIFY_IDLE_MS;
  }

  private hasSourcedSteer(record: SessionRecord): boolean {
    return record.steerQueue.some(
      (q) => q.source === 'subagent_notify' || q.source === 'parent_message',
    );
  }

  private clearSourcedInterrupt(record: SessionRecord): void {
    if (record.sourcedInterruptTimer) {
      clearTimeout(record.sourcedInterruptTimer);
      record.sourcedInterruptTimer = undefined;
    }
  }

  /**
   * Hybrid sourced-notify delivery: prefer natural end-of-stream (steer loop
   * drains the queue after status:done). Only soft-interrupt when the parent
   * has been stream-idle for sourcedNotifyIdleMs while a sourced item is still
   * queued — unsticks "waiting for kids" without cutting off an active reply.
   */
  private armSourcedInterrupt(sessionId: string): void {
    const record = this.sessions.get(sessionId);
    if (!record) return;
    this.clearSourcedInterrupt(record);
    if (record.abortController.signal.aborted) return;
    if (typeof record.adapter.interruptTurn !== 'function') return;
    if (!this.hasSourcedSteer(record)) return;
    if (record.lastStatus && SessionManager.TERMINAL.has(record.lastStatus)) return;

    const idleMs = this.sourcedIdleMs();
    const elapsed = this.now() - record.lastActivityAt;
    const waitMs = Math.max(0, idleMs - elapsed);

    record.sourcedInterruptTimer = setTimeout(() => {
      record.sourcedInterruptTimer = undefined;
      const live = this.sessions.get(sessionId);
      if (!live || live.abortController.signal.aborted) return;
      if (!this.hasSourcedSteer(live)) return;
      if (live.lastStatus && SessionManager.TERMINAL.has(live.lastStatus)) return;
      // Activity arrived after arming — re-arm from the new baseline.
      if (this.now() - live.lastActivityAt < this.sourcedIdleMs() - 25) {
        this.armSourcedInterrupt(sessionId);
        return;
      }
      try {
        live.adapter.interruptTurn?.();
      } catch {
        /* best-effort; natural end still drains */
      }
    }, waitMs);
  }

  private touchActivity(record: SessionRecord, sessionId: string): void {
    touchSpawnTokensForSession(sessionId);
    record.lastActivityAt = this.now();
    // Active stream → push any pending idle-interrupt further out.
    if (this.hasSourcedSteer(record)) this.armSourcedInterrupt(sessionId);
  }

  /** Stamp operator Interrupt & Send / Stop on status:done; a later running
   *  turn clears the hold so a natural completion can still notify the parent.
   *  Returns null for events that must be dropped entirely. */
  private decorateStreamEvent(record: SessionRecord, event: NormalisedEvent): NormalisedEvent | null {
    if (record.abortController.signal.aborted) {
      // stopSession tripped the abort gate: every error-shaped event after this
      // point is a consequence of the intentional stop (SDK AbortError, SIGTERM
      // exit code, "Turn interrupted" result) — a false error, not a genuine
      // failure. Drop raw error rows; rewrite a terminal error status to a
      // quiet done so the turn closes without a red banner or a
      // conversation-failed notification.
      if (event.type === 'error') return null;
      if (event.type === 'status' && event.payload.status === 'error') {
        return { ...event, payload: { ...event.payload, status: 'done', cause: 'operator_interrupt' } };
      }
    }
    if (event.type === 'helper') {
      const set = (record.runningHelpers ??= new Set());
      if (event.payload.status === 'running') set.add(event.payload.taskId);
      else set.delete(event.payload.taskId);
      return event;
    }
    if (event.type !== 'status') return event;
    if (event.payload.status === 'running') {
      record.suppressParentNotify = false;
      return event;
    }
    if (event.payload.status === 'done' && record.suppressParentNotify) {
      return { ...event, payload: { ...event.payload, cause: 'operator_interrupt' } };
    }
    return event;
  }

  private sessionEndedFrame(record: SessionRecord, conversationId: string, sessionId: string): ServerFrame {
    return {
      type: 'session_ended',
      conversationId,
      sessionId,
      ...(record.suppressParentNotify ? { cause: 'operator_interrupt' as const } : {}),
    };
  }

  isInjectable(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    return !!s && !s.abortController.signal.aborted && s.injectable === true;
  }

  activeSessions(): SessionRecord[] {
    // Filter out aborted records: stopSession aborts the signal at trip time,
    // but the Map entry only disappears when the adapter emits 'end'. If the
    // subprocess dies silently (kill -9, silent crash, stall) 'end' never
    // fires and the record leaks — every downstream gate that asks "is a
    // session live?" (rewind, btw, spawn) then wrongly 409s forever.
    // An aborted signal is never a legitimately in-flight session.
    return [...this.sessions.values()].filter((s) => !s.abortController.signal.aborted);
  }

  /** True when this conversation currently has an in-flight (non-aborted) session. */
  hasLiveSession(conversationId: string): boolean {
    return this.activeSessions().some((s) => s.conversationId === conversationId);
  }

  /** Attach the usage-limit watcher after construction (avoids a boot-order cycle). */
  setUsageWatcher(w: NonNullable<Deps['usageWatcher']>): void {
    this.deps = { ...this.deps, usageWatcher: w };
  }

  /** WP-2.4 / I1: same-agent model change on a live-capable adapter switches in place
   *  (SDK Query.setModel); effort and prompt options stay spawn-bound. Per-message
   *  prompt options cannot be applied live, so any present options fall through
   *  to stop + native-resume respawn so they are bound at spawn.
   *  I1 guards: live switch is only permitted when (1) old and new profile share
   *  the same token entitlement kind (schedule vs spawn), preventing spawn tokens
   *  from landing in sessions carrying non-delegating MCP egress servers, and
   *  (2) the resolved effective MCP set hash is unchanged.
   *  Failure falls back to the historical stop + native-resume respawn. */
  private async maybeLiveModelSwitch(
    live: SessionRecord,
    input: { agent: string; profileId: string; model: string; conversationId: string },
    handoffOverride: string | undefined,
    db: Database,
    promptOptions?: PromptOptions,
  ): Promise<boolean> {
    if (promptOptions && Object.keys(promptOptions).length > 0) return false;
    if (
      live.agentType === input.agent &&
      live.profileId !== input.profileId &&
      !handoffOverride &&
      typeof live.adapter.setModelLive === 'function'
    ) {
      // I1: Guard 1 — Same token entitlement kind
      const conv = getConversation(db, input.conversationId);
      const oldProfile = live.profileId ? catalogue.getProfile(live.profileId) : undefined;
      const newProfile = input.profileId ? catalogue.getProfile(input.profileId) : undefined;
      const oldEnt = tokenEntitlement(db, conv, live.agentType, oldProfile);
      const newEnt = tokenEntitlement(db, conv, input.agent, newProfile);
      if (oldEnt.kind !== newEnt.kind) return false;

      // I1: Guard 2 — Same effective MCP set hash
      const mcp = resolveMcpForConversation(db, input.conversationId, input.agent, input.profileId, undefined);
      if ((mcp.hash ?? '') !== (live.mcpHash ?? '')) return false;

      try {
        await live.adapter.setModelLive(input.model);
        live.profileId = input.profileId;
        live.model = input.model;
        if (live.steerOrigin) live.steerOrigin = { ...live.steerOrigin, profileId: input.profileId, model: input.model };
        setSessionAgentModel(db, live.id, input.profileId);
        return true;
      } catch (err) {
        console.warn(`[sessionManager] setModelLive failed for session ${live.id}:`, err);
      }
    }
    return false;
  }

  async handlePrompt(input: PromptInput): Promise<string> {
    const db = getDb();
    assertValidRemoteAgentProfile(db, input.conversationId, input.projectId, input.profileId);
    assertGrokBotConversationWritable(db, input.conversationId, input.projectId, input.profileId, input.agent);
    assertGrokBotAllowedInProject(db, input.conversationId, input.projectId, input.profileId, input.agent);

    let profile = catalogue.getProfile(input.profileId);
    if (!profile) {
      catalogue.load(db);
      profile = catalogue.getProfile(input.profileId);
    }
    if (!profile || !profile.enabled || profile.agentType !== input.agent) {
      throw new Error(`Unknown or disabled profile: ${input.profileId}`);
    }
    // Reject bypass-only agents only in full 'prompt' mode (tool permission round-trip).
    // ponytail: checked before session creation so no orphan DB rows on rejection.
    const effectiveMode = effectiveInteractionMode(db, input.conversationId, input.interactionMode);
    if (interactionModeRequiresPermissionCapable(effectiveMode) && !agentSupportsPermissionMode(profile.agentType)) {
      throw new Error(
        `Agent ${profile.label} does not support permission mode '${effectiveMode}' — use a capable agent (claude-code, codex, or hermes)`,
      );
    }
    const project = getProject(db, input.projectId);
    if (!project) throw new Error(`Unknown project: ${input.projectId}`);
    if (isProjectMoving(project.id)) throw new Error(PROJECT_MOVING_ERROR);
    assertProfileAvailableOnHost(project, profile, this.deps.remoteHosts?.view);
    assertHostSupportsUntrustedProject(project, this.deps.remoteHosts?.view);
    const promptOptions = sanitisePromptOptions(input.agent, input.options);
    // ponytail: grok-bot owns its own context; a reset/handoff from our side is meaningless.
    const handoffOverride = BARE_PROMPT_ADAPTERS.has(input.agent) || !VALID_HANDOFF_OVERRIDES.has(input.handoffOverride as HandoffOverride) ? undefined : input.handoffOverride;
    // Schedule ticks are agent-authored templates re-sent every run; recall would repeat the same memory each tick.
    const noRecall = !!input.skipRecall || !!input.schedule;

    // [S2-2] A fresh prompt supersedes any pending deferred resume: the
    // operator (or a delivered turn) is driving this conversation again, so
    // stale auto/agent-resume timers must not fire into a live turn later.
    // Operator-origin timers are untouched; a timer being delivered by the
    // sweep was already claimed (fired_at stamped) before this point.
    cancelPendingNonOperatorTimers(db, input.conversationId, Date.now());

    let adoptedId: string | undefined;
    let sessionId = '';
    let adapter!: AgentAdapter;
    let record!: SessionRecord;
    const tempFiles: ReturnType<typeof writeTempAttachments> = [];
    let sandboxOn = false;
    let hubProject = project;
    let cwd = input.cwd
      ?? resolveConversationCwd(db, input.conversationId)
      ?? project.rootPath;
    await this.withConversationGate(input.conversationId, async () => {
    // Gate serializes *starting* a turn (reap + in-flight check + register).
    // sendPrompt is kicked off after this callback and must not hold the gate —
    // Hold-open adapters leave stdin open until child.close.
    // Parked hold-open (grok-build after status:done) must not share
    // the conversation with a new turn — operator Send after a schedule tick
    // otherwise steers into a subprocess dispatch is about to stop.
    await this.reapParkedSessions(input.conversationId);
    let live = this.inFlightSessionForConversation(input.conversationId);
    if (live && (live.agentType !== input.agent || live.profileId !== input.profileId || handoffOverride)) {
      // WP-2.4: same-agent model change on a live-capable adapter switches in place
      // (SDK Query.setModel); effort and prompt options stay spawn-bound. Failure
      // falls back to the historical stop + native-resume respawn.
      const switched = await this.maybeLiveModelSwitch(live, input, handoffOverride, db, promptOptions);
      if (!switched) {
        await this.stopSession(live.id);
        live = undefined;
      }
    }
    if (live && promptOptions && Object.keys(promptOptions).length > 0) {
      throw new PromptOptionError('Prompt options cannot be applied while a turn is in flight');
    }
    const parked = live ? undefined : this.parkedHoldOpenSession(input.conversationId);
    let adopt = live;
    if (parked) {
      const conv = getConversation(db, input.conversationId);
      const currentTemplate = conv?.templateName ? getTemplate(db, conv.templateName) : undefined;
      const currentEnt = tokenEntitlement(db, conv, input.agent, catalogue.getProfile(input.profileId));
      const isSameProfile = parked.agentType === input.agent && parked.profileId === input.profileId;
      const parkedSandboxOn = liveAdapterOpts(effectiveMode, hubProject, conv, db, input.agent, this.deps.remoteHosts?.view).sandbox;
      const isSameTemplate = (parked.templateName ?? null) === (conv?.templateName ?? null)
        && (parked.templateHash ?? '') === getTemplateHash(currentTemplate)
        && (parked.tokenKind ?? currentEnt.kind) === currentEnt.kind
        // MCP servers bind at spawn: a changed selection / registry row / secret reaps.
        && (parked.mcpHash ?? '') === resolveMcpForConversation(db, input.conversationId, input.agent, input.profileId, promptOptions).hash
        // WP-2.1: a parked session created under a different mode must be stopped, not adopted.
        && (parked.interactionMode ?? 'bypass') === effectiveMode
        && (parked.sandbox ?? false) === parkedSandboxOn;
      // Per-turn options are argv, bound at spawn. Adopt only when the parked
      // process already carries the same bag (sticky repeats); otherwise reap
      // so this turn gets a fresh process with the new (or empty) flags.
      // Similarly, if the conversation's delegation template changed, reap
      // so the new turn gets a fresh process with the updated preamble & spawn token.
      if (isSameProfile && isSameTemplate && !handoffOverride && promptOptionsEqual(promptOptions, parked.appliedOptions)) {
        adopt = parked;
      } else {
        await this.stopSession(parked.id);
      }
    }
    if (adopt) {
      const adapterPrefix = holdOpenRulesPrefix(db, adopt, input.conversationId, project, input.agent);
      await this.steerSession(adopt.id, input.text, input.attachments, {
        ...(input.source && input.source !== 'user' ? { source: input.source } : {}),
        ...(input.subagent ? { subagent: input.subagent } : {}),
        ...(parked && adopt === parked ? { intent: 'queue' as const } : {}),
        ...(adapterPrefix ? { adapterPrefix } : {}),
        recall: !noRecall && isEligibleRecallSource(input.source),
      });
      adoptedId = adopt.id;
      return;
    }

    // [review N1] The awaits above (gate, reap, live switch) can straddle a
    // project folder move: it may have started or even finished since the
    // guard at the top of this method ran. Re-check the lock and re-resolve
    // project + cwd so this session cannot register in the vanished folder —
    // a move in progress rejects; a completed move lands here fresh.
    if (isProjectMoving(project.id)) throw new Error(PROJECT_MOVING_ERROR);
    const currentProject = getProject(db, input.projectId);
    if (!currentProject) throw new Error(`Unknown project: ${input.projectId}`);
    hubProject = currentProject;
    cwd = input.cwd
      ?? resolveConversationCwd(db, input.conversationId)
      ?? currentProject.rootPath;

    sessionId = randomUUID();
    const conv = getConversation(db, input.conversationId);
    const adapterOpts = liveAdapterOpts(effectiveMode, currentProject, conv, db, input.agent, this.deps.remoteHosts?.view);
    sandboxOn = adapterOpts.sandbox;
    adapter = registry.create(input.agent, toFactoryOpts(adapterOpts));

    createSession(db, {
      id: sessionId,
      conversationId: input.conversationId,
      agentId: input.agent,
      agentModelId: input.profileId,
    });

    const initialTemplate = conv?.templateName ? getTemplate(db, conv.templateName) : undefined;
    const effectiveEffort = clampEffort(input.agent, input.effort);
    record = {
      id: sessionId, conversationId: input.conversationId, agentType: input.agent,
      model: input.model, profileId: input.profileId, adapter, startedAt: this.now(),
      interactionMode: effectiveMode,
      sandbox: adapterOpts.sandbox,
      abortController: new AbortController(), started: false,
      steerQueue: [],
      injectable: profile.steer === true && typeof adapter.steer === 'function',
      steerOrigin: {
        projectId: input.projectId, conversationId: input.conversationId,
        agent: input.agent, model: input.model, profileId: input.profileId,
        cwd,
        interactionMode: input.interactionMode,
      },
      lastActivityAt: this.now(),
      attachmentTempFiles: [],
      ...(effectiveEffort ? { effort: effectiveEffort } : {}),
      ...(promptOptions ? { appliedOptions: promptOptions } : {}),
      templateName: conv?.templateName ?? null,
      templateHash: getTemplateHash(initialTemplate),
      tokenKind: tokenEntitlement(db, conv, input.agent, catalogue.getProfile(input.profileId)).kind,
      ...mcpRecordFields(resolveMcpForConversation(db, input.conversationId, input.agent, input.profileId, promptOptions)),
      rulesHash: !agentTakesBarePrompt(input.agent) && conv
        ? (loadRules(db, conv, currentProject)?.hash ?? '')
        : '',
    };
    this.sessions.set(sessionId, record);
    this.consumeOrphanToken(input.conversationId);

    // Synchronously announce the session so clients can render the Stop
    // button immediately and a queued stop finds a registered session.
    // Routed through deps.broadcast so index.ts can fan out to all clients
    // (matching the session_ended fan-out).
    this.deps.broadcast(input.conversationId, {
      type: 'session_started',
      conversationId: input.conversationId,
      sessionId,
      profileId: input.profileId,
      model: input.model,
    });

    this.persistAndBroadcast(input.conversationId, {
      type: 'prompt', sessionId, seq: 0, ts: Date.now(),
      sender: input.source && input.source !== 'user' ? 'system' : 'user',
      agentProfileId: input.profileId,
      payload: {
        text: input.text,
        attachments: input.attachments?.map(a => ({
          base64: a.base64, mediaType: a.mediaType, name: a.name,
        })),
        ...(input.source && input.source !== 'user' && input.subagent
          ? { source: input.source, subagent: input.subagent }
          : {}),
        ...(effectiveEffort ? { effort: effectiveEffort } : {}),
        ...(record.sandbox ? { sandboxed: true as const } : {}),
        ...(input.schedule ? { schedule: input.schedule } : {}),
      },
    });
    for (const text of sandboxTurnNotices(adapterOpts)) {
      console.warn(`[sessionManager] ${text} conversation=${input.conversationId}`);
      this.persistAndBroadcast(input.conversationId, {
        type: 'message', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { chunk: text, final: true },
      });
    }
    });

    if (adoptedId) return adoptedId;

    // Detached: a missing description must never fail or delay a turn.
    void describeConversationIfFirst(db, input.conversationId, input.text, this.deps.broadcastAll)
      .catch((e) => console.warn('[describe] failed:', e));


    const adapterEvents = adapter.streamEvents();
    const adapterEstimate = adapter.estimateTokenCount
      ? (t: string) => adapter.estimateTokenCount!(t)
      : undefined;
    const usageTracker = createUsageTracker(input.text, adapterEstimate);
    const inflightUsage = createInflightUsageFlusher(db, sessionId, usageTracker);

    const cleanup = () => {
      inflightUsage.cancel();
      this.clearSourcedInterrupt(record);
      adapterEvents.removeAllListeners('event');
      adapterEvents.removeAllListeners('error');
      for (const f of tempFiles) f.cleanup();
      for (const f of record.attachmentTempFiles) f.cleanup();
      this.sessions.delete(sessionId);
      revokeSpawnTokensForSession(sessionId);
      // NOTE: pending spawn requests are deliberately NOT expired here.
      // The operator's contract is that a queued request "sits there until I
      // approve it" — even if the parent agent's session ends first. Approval
      // is operator-global (the queue lives across all conversations); a stale
      // sweep (expireStale, default 24h) reaps genuinely abandoned rows at
      // list/approve time. Expiring on session end would silently destroy
      // requests the operator hadn't seen yet.
      const resolvers = this.steerResolvers.get(sessionId);
      if (resolvers) {
        for (const res of resolvers) {
          res(null);
        }
        this.steerResolvers.delete(sessionId);
      }
      this.deps.broadcast(input.conversationId, this.sessionEndedFrame(record, input.conversationId, sessionId));
      // Deferred peer messages land as the conversation's next turn (D4 reversed).
      void flushMeshMailbox(this, input.conversationId)
        .catch((e) => console.warn('[mesh] mailbox flush failed:', e));
    };

    // Persist native_session_id the first time the adapter exposes it.
    // Previously this only ran inside the status:running branch — fine for
    // adapters that set the field synchronously before emitting running
    // (claude-code), but a race for adapters that populate it on
    // a later frame (opencode sets it from a stream frame; pi from a state
    // event). When the race lost, the row stayed NULL forever and the
    // native-availability badge never flipped to "available" without a
    // manual browser refresh. Checking on every event closes that gap.
    let nativePersisted = false;
    const persistNativeIfReady = () => {
      if (nativePersisted) return;
      const native = (adapter as unknown as { nativeSessionId?: string }).nativeSessionId;
      if (native) {
        setNativeSessionId(db, sessionId, native);
        nativePersisted = true;
      }
    };

    // ── Upward bridge (Option C + P3 recovery): a turn sourced from another
    // agent, OR a plain operator follow-up when the spawn edge already left
    // `open`, pushes final prose one hop up at terminal. Recursion up the tree
    // is automatic (the notify creates another sourced turn on the next level)
    // and bounded by tree depth. 🔒 Target comes from the validated replyTo
    // (set server-side by the message route), the durable edge row, or the
    // parent link — never from message content (threat-model concern 2).
    // peer_message does NOT bridge upward: a lateral peer is not a task-giver.
    const isBridgeSource = input.source === 'subagent_notify' || input.source === 'parent_message';
    const bridgeEdge = getEdgeByChild(db, input.conversationId);
    const parentConversationId = getConversation(db, input.conversationId)?.parentConversationId;
    // Recovery bridge (P3): operator follow-up on a child whose spawn edge already
    // left `open` (interrupt/stall/restart missed the one-shot watcher notify).
    // Gate on durable edge row + followup_count — NOT on in-memory watchers.
    const isRecoveryBridge = !isBridgeSource
      && !!bridgeEdge
      && bridgeEdge.status !== 'open'
      && bridgeEdge.notifyParent
      && bridgeEdge.followupCount === 0
      && !!parentConversationId;
    const shouldBridge = (isBridgeSource && !!parentConversationId) || isRecoveryBridge;
    const bridgeTarget = shouldBridge
      ? (isBridgeSource
        ? (input.subagent?.replyTo ?? parentConversationId)
        : bridgeEdge!.parentConversationId)
      : undefined;
    // No edge row (spawn predates migration 029) → default to bridging; an
    // explicit notifyParent:false on the edge suppresses the notify turn but
    // still records the transcript marker (cheap, keeps the tree auditable).
    const bridgeNotify = isBridgeSource && input.subagent?.notify !== undefined
      ? input.subagent.notify
      : (bridgeEdge ? bridgeEdge.notifyParent : true);
    const bridgeRole = input.subagent?.role ?? bridgeEdge?.role;
    const bridgeProse = bridgeTarget ? createProseAccumulator() : undefined;
    let bridged = false;
    // Usage-watcher layer 1: one candidate per turn, armed from terminal quota
    // signals. Notification-only in Phase 5 — arming never resumes anything.
    // [S2-8] Accumulate prose for arming on EVERY turn (bridge or not): the
    // terminal scan must see the whole turn, not just the last chunk.
    const armProse = createProseAccumulator();
    let finishedBridgeProse: string | undefined;
    let degenerateBridgeProse = false;
    // Terminal error text of this turn, captured from post-decorate outbound
    // events only — error rows dropped after an operator abort never land
    // here, so the operator-interrupt exclusion holds by construction.
    let lastErrorText: string | undefined;
    let armedThisTurn = false;
    const armUsageWatcher = (reason: LimitCandidate['reason']): void => {
      if (armedThisTurn || !this.deps.usageWatcher) return;
      if (record.abortController.signal.aborted) return;
      armedThisTurn = true;
      this.deps.usageWatcher.arm({
        conversationId: input.conversationId, sessionId, at: Date.now(), reason,
      });
    };

    // Shared terminal settlement for the upward bridge, called from three
    // sites: the event handler (terminal status), the adapter 'error'
    // emitter, and failTurn. Before this closure existed, a bridge turn that
    // died outside the event handler (crashed process, spawn ENOENT, start()
    // throwing) left the parent with no notify, no marker and no session
    // stop — it waited forever. The `bridged`
    // flag still guarantees exactly one settlement per turn; operator
    // interrupts never settle.
    const settleBridge = (status: 'done' | 'error', cause?: string): void => {
      const operatorInterrupt = cause === 'operator_interrupt' || record.abortController.signal.aborted;
      if (!bridgeTarget || !bridgeProse || bridged || operatorInterrupt) return;
      bridged = true;
      const { prose, degenerate } = bridgeProse.finish();
      finishedBridgeProse = prose;
      degenerateBridgeProse = degenerate;
      const errored = status === 'error';
      // Outcome-aware slot consumption: the one-shot recovery slot exists to
      // deliver ONE substantive follow-up result to the parent. A follow-up
      // that errored or produced only degenerate prose delivered nothing —
      // notify (visibility) but keep the slot for the retry that succeeds.
      // Bridge-source turns never consult
      // followup_count, so only the recovery path may consume it — a
      // grandchild cascade must not eat the operator's recovery slot.
      const failed = errored || degenerate;
      // Carry the error only when it explains the outcome: a substantive done
      // with a stray non-fatal error (e.g. agy denials) keeps today's clean frame.
      const error = failed ? lastErrorText : undefined;
      // CAS: two concurrent recovery turns on the same child must yield
      // exactly one parent notify — the marker below still fires for both
      // (visibility), but only the CAS winner spends a parent LLM turn.
      const wonSlot = isRecoveryBridge && !failed && bridgeEdge
        ? consumeFollowupSlot(db, bridgeEdge.id)
        : true; // bridge-source turns are uncapped, never CAS-gated
      this.recordSpawnMarker(bridgeTarget, {
        kind: 'result',
        childConversationId: input.conversationId,
        // ⚠ keys on failed (error OR degenerate), not on empty prose alone:
        // an errored turn WITH substantive prose used to pass unflagged.
        text: `${failed ? '⚠ ' : ''}◀ result (follow-up${errored ? ', failed' : ''}): `
          + (prose || (error ? `error: ${shortReason(error)}` : 'no output')),
        role: bridgeRole,
      });
      if (bridgeNotify && wonSlot) {
        let text = frameSubagentProse(prose, {
          role: bridgeRole,
          childConversationId: input.conversationId,
          followup: true,
          failed,
          error,
        });
        if (failed) text += failureHint(input.conversationId, bridgeTarget, error);
        this.notifyParentSubagentResult(
          bridgeTarget,
          text,
          { role: bridgeRole, childConversationId: input.conversationId },
        );
      }
      // Same PID-leak discipline as the route's onResult: the SDK parks the
      // subprocess after done; wait for any pending steer queue to drain
      // before stopping the session.
      void this.stopWhenSettled(input.conversationId, sessionId);
    };

    adapterEvents.on('event', (event: NormalisedEvent) => {
      usageTracker.trackMessage(event);
      if (shouldScheduleInflightUsage(event)) inflightUsage.schedule();
      persistNativeIfReady();
      // Stream activity resets the idle-interrupt clock (hybrid sourced notify).
      this.touchActivity(record, sessionId);
      if (event.type === 'message' && (event.payload as { chunk?: string }).chunk) {
        const chunk = (event.payload as { chunk: string }).chunk;
        armProse.addChunk(chunk);
        if (bridgeProse) bridgeProse.addChunk(chunk);
      }
      if (event.type === 'tool_call' || event.type === 'tool_result') {
        armProse.toolBoundary();
        if (bridgeProse) bridgeProse.toolBoundary();
      }
      const outbound = this.decorateStreamEvent(record, event);
      if (!outbound) return;
      const saved = this.persistAndBroadcast(input.conversationId, {
        ...outbound, sessionId, sender: 'agent', agentProfileId: input.profileId,
      });
      // Capture this turn's terminal error text (post-decorate: abort-dropped
      // error rows never reach this point) so settleBridge can frame it.
      if (outbound.type === 'error') {
        const m = (outbound.payload as { message?: string }).message;
        if (typeof m === 'string' && m) lastErrorText = m;
      }
      if (outbound.type === 'error'
        && matchesQuotaShape((outbound.payload as { message?: string }).message ?? '')) {
        armUsageWatcher('error_text');
      }
      if (outbound.type === 'status') {
        record.lastStatus = outbound.payload.status;
        // Natural end-of-stream: cancel any pending idle interrupt; steer loop
        // / drain-on-end will deliver queued sourced notifies without cancel.
        if (outbound.payload.status === 'done' || outbound.payload.status === 'error' || outbound.payload.status === 'idle') {
          this.clearSourcedInterrupt(record);
          persistTerminalUsage(db, sessionId, usageTracker, inflightUsage, outbound.payload);
        }
        const operatorInterrupt = outbound.payload.cause === 'operator_interrupt'
          || record.abortController.signal.aborted;
        const terminal = outbound.payload.status === 'done' || outbound.payload.status === 'error';
        if (terminal) {
          // One settlement per turn, from any terminal path — the guards live
          // inside settleBridge (bridge eligibility, `bridged`, operator stop).
          settleBridge(
            outbound.payload.status === 'error' ? 'error' : 'done',
            outbound.payload.cause,
          );
        }
        // Layer-1 arming for the usage-limit watcher: quota language in the
        // final prose/error, or a degenerate done (no output at all), arms a
        // candidate. Never fires on operator interrupts; never resumes.
        if (terminal && !operatorInterrupt) {
          // [S2-8] Scan the ACCUMULATED turn prose (armProse is fed on every
          // turn), not just the last message chunk — quota language can be
          // split across chunks or followed by an innocuous tail. When a
          // bridge target existed, finishedBridgeProse holds the same
          // accumulation and wins.
          const prose = (finishedBridgeProse ?? armProse.finish().prose).slice(-4096);
          if (matchesQuotaShape(prose)) {
            armUsageWatcher('final_prose');
          } else if (outbound.payload.status === 'done' && (degenerateBridgeProse || !prose)) {
            armUsageWatcher('degenerate');
          }
        }
        if (outbound.payload.status === 'done') {
          // Detached: the checkpoint (local git or remote git.call) must never fail or delay the turn.
          void recordAutoCheckpoint(db, {
            conversationId: input.conversationId,
            sessionId,
            eventId: saved.id,
          })
            .then(() => {
              this.deps.broadcast(input.conversationId, {
                type: 'checkpoints_updated',
                conversationId: input.conversationId,
              });
            })
            .catch(() => { /* checkpoint must never fail the turn */ });
          // Detached: auto-tagging must never fail or delay a turn.
          void autoTagConversationIfDue(db, input.conversationId, this.deps.broadcastAll).catch(() => {});
        }
      }
    });

    adapterEvents.on('error', (err: Error) => {
      // After an intentional stop, adapter infrastructure errors (EPIPE on the
      // killed child, aborted SDK request) are stop consequences — not failures.
      if (record.abortController.signal.aborted) return;
      this.persistAndBroadcast(input.conversationId, {
        type: 'error', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { message: err.message },
      });
      this.persistAndBroadcast(input.conversationId, {
        type: 'status', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { status: 'error' },
      });
      // G2: a bridge turn that dies on this emitter (crashed process, spawn
      // ENOENT, aborted SDK request) must still settle the bridge — the
      // parent would otherwise wait forever with no notify and no marker.
      lastErrorText = err.message;
      settleBridge('error');
    });

    adapterEvents.once('end', () => {
      // Drain everything still queued. ponytail: plain mid-turn steers used to be
      // discarded here — if the turn ended before the adapter's steer loop pulled
      // one, the operator's message vanished with no trace. Nothing consumed it,
      // so re-dispatching it as a follow-up turn is the only non-lossy option.
      const followUpQueue = [...record.steerQueue];
      const aborted = record.abortController.signal.aborted;
      const origin = { ...record.steerOrigin };
      if (!aborted && followUpQueue.length > 0) {
        this.beginPendingDrain(origin.conversationId);
      }
      cleanup();
      this.drainFollowUpQueue(origin, followUpQueue, aborted);
    });

    const failTurn = (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.persistAndBroadcast(input.conversationId, {
        type: 'error', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { message: msg },
      });
      this.persistAndBroadcast(input.conversationId, {
        type: 'status', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { status: 'error' },
      });
      // G2: failTurn (start() throw, synchronous boot failure) is a terminal
      // path too — settle the bridge before cleanup tears the listeners down.
      lastErrorText = msg;
      settleBridge('error');
      cleanup();
    };

    try {
      const runner = makeAdapterRunner({
        // ponytail: compaction summariser stays on the hub; the preferred agent must be installed locally
        createAdapter: (agentType, opts) => registry.create(agentType, opts),
        resolveModel: (profileId) => catalogue.getProfile(profileId)?.model ?? input.model,
        cwd,
      });
      const isNativeAvailable = adapter.isNativeSessionAvailable?.bind(adapter)
        ?? (() => Promise.resolve(false));
      const settings = getCompactionSettings(db);
      const preferredAgentType = settings.preferredProfileId.split(':')[0];
      const compactor = registry.has(preferredAgentType)
        // ponytail: tool-free summariser needs the agent on the hub
        ? registry.create(preferredAgentType)
        : undefined;
      const estimate = compactor?.estimateTokenCount
        ? (t: string) => compactor.estimateTokenCount!(t)
        : undefined;
      const plan = await buildResumePlan(db, input.conversationId, {
        runner,
        isNativeAvailable,
        estimate,
        // Resume-within-adapter: only native-resume a prior session belonging to
        // the same adapter. Across-adapter switches fall through to compaction.
        // excludeId = the freshly-created empty session row from above, so it
        // can't win the "last session" lookup and force a fresh native session.
        agentId: input.agent,
        excludeId: sessionId,
        override: handoffOverride,
        priming: ARGV_PROMPT_ADAPTERS.has(input.agent) ? { framing: 'resume', maxBytes: ARGV_PRIMING_BYTES } : undefined,
        // Resolve the target adapter/model's context window from its live
        // listModels(). Returns Infinity on any failure so the auto-fallback
        // can't trigger (covers agy, which advertises no window).
        //
        // FW-7 note: agent_models.context_window IS persisted now, and
        // catalogue.getProfile(input.profileId)?.contextWindow would give this
        // block a DB fallback. Deliberately NOT wired here (FW-7 D6): swapping
        // Infinity for a real number changes WHEN compaction auto-fallback
        // fires, which is a handoff-behaviour change needing its own roster row
        // and verification. Usage reporting (the FW-7 scope) is unaffected.
        getTargetContextWindow: async () => {
          try {
            if (!registry.has(input.agent)) return Infinity;
            const targetAdapter = registry.create(input.agent, project.remoteHostId ? { remoteHostId: project.remoteHostId } : undefined);
            const models = await targetAdapter.listModels();
            const hit = models.find((m) => m.name === input.model);
            return hit?.contextWindow ?? Infinity;
          } catch {
            return Infinity;
          }
        },
      });

      recordHandoff(db, {
        conversationId: input.conversationId,
        sessionId,
        toProfileId: input.profileId,
        handoffOverride,
        handoffMode: settings.handoffMode,
        plan,
      });

      // Stop arrived during compaction. Bail without ever spawning the
      // adapter — saves a process spawn the user has already cancelled.
      if (record.abortController.signal.aborted) {
        cleanup();
        return sessionId;
      }

      if (sandboxOn && !hubProject.remoteHostId) {
        if (!hasSandboxProfile(input.agent)) throw new SandboxError('sandbox_unsupported_agent');
        if (!bwrapAvailable()) throw new SandboxError('sandbox_unavailable');
      }

      ensureProjectStateGitExclude(cwd);
      await adapter.start({
        sessionId,
        conversationId: input.conversationId,
        cwd,
        model: input.model,
        nativeSessionId: plan.mode === 'native' ? safePersistedNativeSessionId(plan.nativeSessionId) : undefined,
        effort: input.effort,
        getNextSteer: async (signal) => {
          return this.pullNextSteer(sessionId, signal);
        },
        trustRepoConfig: project?.trustRepoConfig === true,
        ...(promptOptions ? { options: promptOptions } : {}),
        ...(record.mcpServers?.length ? { mcpServers: record.mcpServers } : {}),
        ...(record.disableNativeMcp ? { disableNativeMcp: true } : {}),
        ...(record.disabledNativeMcp?.length ? { disabledNativeMcp: record.disabledNativeMcp } : {}),
      });
      record.started = true;

      // Stop arrived between adapter.start() and sendPrompt(). The adapter
      // subprocess is alive — but its stop() will be invoked by stopSession
      // since `started` is now true, so we only need to skip sendPrompt.
      if (record.abortController.signal.aborted) {
        return sessionId;
      }

      // Delegation preamble: full recipe only when the agent cannot already know
      // it (first prompt, non-native resume, roster/kind change, staleness).
      // Native resume with an unchanged fingerprint gets a short stub + new Bearer.
      let delegationPreamble = '';
      let wantFp = '';
      let build: ((mode: 'full' | 'stub') => string) | undefined;
      const conv = getConversation(db, input.conversationId);
      const facts = this.hostFactsFor(project);
      const port = facts.port;
      const barePrompt = agentTakesBarePrompt(profile.agentType);
      const ent = tokenEntitlement(db, conv, profile.agentType, catalogue.getProfile(input.profileId));
      const operatorRules = ent.kind !== 'none' && conv
        ? loadRules(db, conv, project)
        : undefined;
      if (ent.kind === 'spawn' && conv) {
        const template = ent.template;
        // Mint before the mode decision — a stub without a live Bearer is useless.
        // Revoked in cleanup() when this session ends.
        const caps = this.capabilityArgs(conv);
        const spawnToken = issueSpawnToken(
          input.conversationId,
          sessionId,
          withSessionScope(db, SPAWN_CAPABILITIES, conv),
          caps.capProfile,
        );
        const compactionSettings = getCompactionSettings(db);
        const parentProfId = conv.parentConversationId
          ? lastSessionForConversation(db, conv.parentConversationId)?.agentModelId
          : undefined;
        const parentProfileLabel = parentProfId
          ? (catalogue.getProfile(parentProfId)?.label ?? parentProfId)
          : undefined;
        const isRoot = isPolicyRoot(db, conv);
        // Schedule pointer at every depth — authorizeAgentScheduleCreate is
        // depth-agnostic, so withholding it here just hid a capability the
        // token already had (children invented cron/cloud routines instead).
        const common = {
          template,
          parentConversationId: input.conversationId,
          spawnToken,
          port,
          spawnApprovalRequired: compactionSettings.spawnApprovalRequired,
          parentInteractionMode: effectiveInteractionMode(db, input.conversationId, input.interactionMode),
          resolveAgentType: (profileId: string) => catalogue.getProfile(profileId)?.agentType,
          parentProfileLabel,
          scheduleCreate: { projectId: conv.projectId },
          selfConversationId: conv.id,
          selfParentConversationId: conv.parentConversationId ?? undefined,
          plugins: caps.plugins,
          usage: caps.usage,
          pluginSetHash: caps.pluginSetHash,
          meshAwareness: compactionSettings.meshAwareness,
          meshMessaging: compactionSettings.meshMessaging,
          meshEdgeSetHash: compactionSettings.meshMessaging === 'tree'
            ? liveEdgeSetHash(db, input.conversationId)
            : undefined,
          designations: listDesignationCatalogue(db),
          isAgentUsable: (t: string) => t !== 'grok-bot' || grokBotUsable(this.deps.grokBotStatus?.()),
          selfTimer: selfTimerAllowed(AGENT_SELF_TIMERS, isRoot)
            ? { conversationId: conv.id, isChild: !isRoot }
            : undefined,
          globalTasks: globalTasksAllowed(getGlobalTasksSettings(db), isRoot)
            ? { conversationId: conv.id, isChild: !isRoot }
            : undefined,
          memoryEnabled: getGeneralSettings(db).memories && profileAllowsMemory(caps.capProfile),
          operatorRules,
          markupHint: markupHintFor(db),
          searchScope: effectiveAgentSearchScope(db, conv, hubProject),
        };
        wantFp = makeFingerprint('spawn', spawnFpPayload(common));
        build = (m) => m === 'full' ? buildDelegationPreamble(common) : buildDelegationStub(common);
      }
      if (ent.kind === 'schedule' && conv) {
        // Depth-agnostic (Requirement A): every conversation without a spawn preamble
        // gets a schedule-only token, at ANY depth.
        const caps = this.capabilityArgs(conv);
        const scheduleToken = issueSpawnToken(conv.id, sessionId, withSessionScope(db, CONVERSATION_CAPABILITIES, conv), caps.capProfile);
        const compactionSettings = getCompactionSettings(db);
        const isRoot = isPolicyRoot(db, conv);
        const common = {
          projectId: conv.projectId,
          token: scheduleToken,
          port,
          plugins: caps.plugins,
          usage: caps.usage,
          meshAwareness: compactionSettings.meshAwareness,
          meshMessaging: compactionSettings.meshMessaging,
          selfTimer: selfTimerAllowed(AGENT_SELF_TIMERS, isRoot)
            ? { conversationId: conv.id, isChild: !isRoot }
            : undefined,
          globalTasks: globalTasksAllowed(getGlobalTasksSettings(db), isRoot)
            ? { conversationId: conv.id, isChild: !isRoot }
            : undefined,
          memoryEnabled: getGeneralSettings(db).memories && profileAllowsMemory(caps.capProfile),
          operatorRules,
          markupHint: markupHintFor(db),
          selfConversationId: conv.id,
          selfParentConversationId: conv.parentConversationId ?? undefined,
          searchScope: effectiveAgentSearchScope(db, conv, hubProject),
        };
        // v3: capability-profile-aware pluginSetHash — a profile change forces one full re-preamble.
        wantFp = makeFingerprint('schedule', {
          v: 3,
          pluginSetHash: caps.pluginSetHash,
          ...meshFpExtras(common),
          ...(common.selfTimer ? { st: common.selfTimer.isChild ? 2 : 1 } : {}),
          ...(common.globalTasks ? { gt: common.globalTasks.isChild ? 2 : 1 } : {}),
          ...rulesFpExtra(operatorRules),
          ...(common.markupHint ? { mk: common.markupHint } : {}),
          ...searchFpExtra(common.searchScope, common.memoryEnabled),
        });
        build = (m) => m === 'full' ? buildScheduleOnlyPreamble(common) : buildScheduleOnlyStub(common);
      }

      if (build) {
        const { mode, nextFp } = choosePreambleMode({
          want: wantFp,
          prev: lastPreambleFp(db, input.conversationId, { excludeId: sessionId }),
          resumeMode: plan.mode,
        });
        delegationPreamble = build(mode);
        try {
          setPreambleFp(db, sessionId, nextFp);
        } catch (err) {
          console.warn('failed to persist preamble_fp', err);
        }
      }

      // Bare-prompt (grok-bot): no spawn/schedule preamble or Bearer. Handoff
      // priming + host/CWD note only when Settings allows project chats, or the
      // conversation is already under Grok Bots (Remote Agents).
      const barePriming = barePrompt
        && !!plan.primingPrompt
        && grokBotBarePrimingEnabled(db, input.conversationId, input.projectId);
      const childEdge = barePrompt && conv?.parentConversationId ? getEdgeByChild(db, conv.id) : undefined;
      let bareChildNote: string | undefined;
      if (childEdge) {
        if (!cwd) {
          console.warn('bare spawn child note omitted: cwd undefined');
        } else {
          bareChildNote = buildBareChildProtocolNote({
            hostname: osHostname(),
            cwd,
            resultPath: bareChildResultPath(cwd, childEdge.role, conv!.id),
          });
        }
      }
      if (plan.mode !== 'native') this.recallShown.delete(input.conversationId);
      const recalled = noRecall
        ? null
        : recallMemories({
          db,
          conversationId: input.conversationId,
          projectId: input.projectId,
          text: input.text,
          source: input.source,
          agentType: input.agent,
          shown: this.shownFor(input.conversationId),
        });
      const textToSend = assembleAgentPromptText({
        barePrompt,
        userText: input.text,
        delegationPreamble,
        primingPrompt: barePrompt && !barePriming ? undefined : plan.primingPrompt,
        hostNote: !barePrompt && facts.remote ? remoteHostNote(facts, cwd, input.conversationId) : undefined,
        barePrimingNote: barePriming
          ? buildBarePrimingHostNote({ hostname: osHostname(), cwd })
          : undefined,
        bareChildNote,
        recalledMemories: recalled?.block,
      });
      if (recalled) this.persistRecallChip(input.conversationId, sessionId, input.profileId, recalled.ids);
      usageTracker.setPromptText(textToSend);
      inflightUsage.writeInitial();

      const primingAtts = profileAcceptsImages(profile) ? plan.primingAttachments : undefined;
      const { adapterAttachments, tempFiles: attachmentTempFiles } = prepareSendAttachments(
        db, profile, sessionId, input.attachments, primingAtts,
      );
      tempFiles.push(...attachmentTempFiles);
      // Do not await child lifetime. Hold-open sendPrompt resolves on
      // child.close; errors after start still hit persist/broadcast/cleanup
      // via this catch and the existing 'end' handler.
      void adapter.sendPrompt(textToSend, adapterAttachments, input.model, input.effort, ...(promptOptions ? [promptOptions] : [])).catch((err) => {
        failTurn(err);
      });
    } catch (err) {
      failTurn(err);
    }

    return sessionId;
  }

  async handleCommand(input: CommandInput): Promise<string> {
    const db = getDb();
    assertValidRemoteAgentProfile(db, input.conversationId, input.projectId, input.profileId);
    assertGrokBotConversationWritable(db, input.conversationId, input.projectId, input.profileId, input.agent);
    assertGrokBotAllowedInProject(db, input.conversationId, input.projectId, input.profileId, input.agent);

    let profile = catalogue.getProfile(input.profileId);
    if (!profile) {
      catalogue.load(db);
      profile = catalogue.getProfile(input.profileId);
    }
    if (!profile || !profile.enabled || profile.agentType !== input.agent) {
      throw new Error(`Unknown or disabled profile: ${input.profileId}`);
    }
    const project = getProject(db, input.projectId);
    if (!project) throw new Error(`Unknown project: ${input.projectId}`);
    if (isProjectMoving(project.id)) throw new Error(PROJECT_MOVING_ERROR);
    assertProfileAvailableOnHost(project, profile, this.deps.remoteHosts?.view);
    assertHostSupportsUntrustedProject(project, this.deps.remoteHosts?.view);
    const promptOptions = sanitisePromptOptions(input.agent, stripCommandIncompatibleOptions(input.options));
    // ponytail: grok-bot owns its own context; a reset/handoff from our side is meaningless.
    const handoffOverride = BARE_PROMPT_ADAPTERS.has(input.agent) || !VALID_HANDOFF_OVERRIDES.has(input.handoffOverride as HandoffOverride) ? undefined : input.handoffOverride;
    const effectiveMode = effectiveInteractionMode(db, input.conversationId, input.interactionMode);

    let adoptedId: string | undefined;
    let sessionId = '';
    let adapter!: AgentAdapter;
    let record!: SessionRecord;
    const slashText = `/${input.name}${input.args ? ` ${input.args}` : ''}`;
    let cmdSandboxOn = false;
    let hubProject = project;
    let cwd = input.cwd
      ?? resolveConversationCwd(db, input.conversationId)
      ?? project.rootPath;
    await this.withConversationGate(input.conversationId, async () => {
    await this.reapParkedSessions(input.conversationId);
    let live = this.inFlightSessionForConversation(input.conversationId);
    if (live && (live.agentType !== input.agent || live.profileId !== input.profileId || handoffOverride)) {
      // WP-2.4: same-agent model change on a live-capable adapter switches in place
      // (SDK Query.setModel); effort and prompt options stay spawn-bound. Failure
      // falls back to the historical stop + native-resume respawn.
      const switched = await this.maybeLiveModelSwitch(live, input, handoffOverride, db, promptOptions);
      if (!switched) {
        await this.stopSession(live.id);
        live = undefined;
      }
    }
    if (live && promptOptions && Object.keys(promptOptions).length > 0) {
      throw new PromptOptionError('Prompt options cannot be applied while a turn is in flight');
    }
    const parked = live ? undefined : this.parkedHoldOpenSession(input.conversationId);
    let adopt = live;
    if (parked) {
      const conv = getConversation(db, input.conversationId);
      const currentTemplate = conv?.templateName ? getTemplate(db, conv.templateName) : undefined;
      const currentEnt = tokenEntitlement(db, conv, input.agent, catalogue.getProfile(input.profileId));
      const isSameProfile = parked.agentType === input.agent && parked.profileId === input.profileId;
      const parkedSandboxOn = liveAdapterOpts(effectiveMode, hubProject, conv, db, input.agent, this.deps.remoteHosts?.view).sandbox;
      const isSameTemplate = (parked.templateName ?? null) === (conv?.templateName ?? null)
        && (parked.templateHash ?? '') === getTemplateHash(currentTemplate)
        && (parked.tokenKind ?? currentEnt.kind) === currentEnt.kind
        // MCP servers bind at spawn: a changed selection / registry row / secret reaps.
        && (parked.mcpHash ?? '') === resolveMcpForConversation(db, input.conversationId, input.agent, input.profileId, promptOptions).hash
        // WP-2.1: a parked session created under a different mode must be stopped, not adopted.
        && (parked.interactionMode ?? 'bypass') === effectiveMode
        && (parked.sandbox ?? false) === parkedSandboxOn;
      // Per-turn options are argv, bound at spawn. Adopt only when the parked
      // process already carries the same bag (sticky repeats); otherwise reap
      // so this turn gets a fresh process with the new (or empty) flags.
      // Similarly, if the conversation's delegation template changed, reap
      // so the new turn gets a fresh process with the updated preamble & spawn token.
      if (isSameProfile && isSameTemplate && !handoffOverride && promptOptionsEqual(promptOptions, parked.appliedOptions)) {
        adopt = parked;
      } else {
        await this.stopSession(parked.id);
      }
    }
    if (adopt) {
      const adapterPrefix = holdOpenRulesPrefix(db, adopt, input.conversationId, project, input.agent);
      await this.steerSession(adopt.id, slashText, input.attachments, {
        commandName: input.name,
        ...(input.args !== undefined ? { commandArgs: input.args } : {}),
        ...(parked && adopt === parked ? { intent: 'queue' as const } : {}),
        ...(adapterPrefix ? { adapterPrefix } : {}),
      });
      adoptedId = adopt.id;
      return;
    }

    // [review N1] Same race as handlePrompt: re-check the move lock and
    // re-resolve project + cwd after the gate's awaits.
    if (isProjectMoving(project.id)) throw new Error(PROJECT_MOVING_ERROR);
    const currentProject = getProject(db, input.projectId);
    if (!currentProject) throw new Error(`Unknown project: ${input.projectId}`);
    hubProject = currentProject;
    cwd = input.cwd
      ?? resolveConversationCwd(db, input.conversationId)
      ?? currentProject.rootPath;

    sessionId = randomUUID();
    const conv = getConversation(db, input.conversationId);
    const cmdAdapterOpts = liveAdapterOpts(effectiveMode, currentProject, conv, db, input.agent, this.deps.remoteHosts?.view);
    cmdSandboxOn = cmdAdapterOpts.sandbox;
    adapter = registry.create(input.agent, toFactoryOpts(cmdAdapterOpts));

    createSession(db, {
      id: sessionId,
      conversationId: input.conversationId,
      agentId: input.agent,
      agentModelId: input.profileId,
    });

    const initialTemplate = conv?.templateName ? getTemplate(db, conv.templateName) : undefined;
    const commandEffort = clampEffort(input.agent, input.effort);
    record = {
      id: sessionId, conversationId: input.conversationId, agentType: input.agent,
      model: input.model, profileId: input.profileId, adapter, startedAt: this.now(),
      interactionMode: effectiveMode,
      sandbox: cmdAdapterOpts.sandbox,
      abortController: new AbortController(), started: false,
      steerQueue: [],
      // Injectable adapters (pi, grok-build, hermes) need getNextSteer + injectable
      // so mid-turn Queue items drain after the command turn. Without this, those
      // adapters never enter a steer loop and never emit 'end' — queue sticks forever.
      injectable: profile.steer === true && typeof adapter.steer === 'function',
      steerOrigin: {
        projectId: input.projectId, conversationId: input.conversationId,
        agent: input.agent, model: input.model, profileId: input.profileId,
        cwd,
        interactionMode: input.interactionMode,
      },
      lastActivityAt: this.now(),
      attachmentTempFiles: [],
      ...(commandEffort ? { effort: commandEffort } : {}),
      ...(promptOptions ? { appliedOptions: promptOptions } : {}),
      templateName: conv?.templateName ?? null,
      templateHash: getTemplateHash(initialTemplate),
      tokenKind: tokenEntitlement(db, conv, input.agent, catalogue.getProfile(input.profileId)).kind,
      ...mcpRecordFields(resolveMcpForConversation(db, input.conversationId, input.agent, input.profileId, promptOptions)),
      rulesHash: !agentTakesBarePrompt(input.agent) && conv
        ? (loadRules(db, conv, currentProject)?.hash ?? '')
        : '',
    };
    this.sessions.set(sessionId, record);
    this.consumeOrphanToken(input.conversationId);

    this.deps.broadcast(input.conversationId, {
      type: 'session_started',
      conversationId: input.conversationId,
      sessionId,
      profileId: input.profileId,
      model: input.model,
    });

    this.persistAndBroadcast(input.conversationId, {
      type: 'prompt', sessionId, seq: 0, ts: Date.now(),
      sender: 'user', agentProfileId: input.profileId,
      payload: {
        text: slashText,
        attachments: input.attachments?.map((a) => ({
          base64: a.base64, mediaType: a.mediaType, name: a.name,
        })) ?? [],
        commandName: input.name,
        ...(input.args !== undefined ? { commandArgs: input.args } : {}),
        ...(commandEffort ? { effort: commandEffort } : {}),
        ...(record.sandbox ? { sandboxed: true as const } : {}),
      },
    });
    for (const text of sandboxTurnNotices(cmdAdapterOpts)) {
      console.warn(`[sessionManager] ${text} conversation=${input.conversationId}`);
      this.persistAndBroadcast(input.conversationId, {
        type: 'message', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { chunk: text, final: true },
      });
    }
    });

    if (adoptedId) return adoptedId;

    const tempFiles: ReturnType<typeof writeTempAttachments> = [];

    const adapterEvents = adapter.streamEvents();
    const adapterEstimate = adapter.estimateTokenCount
      ? (t: string) => adapter.estimateTokenCount!(t)
      : undefined;
    const usageTracker = createUsageTracker(slashText, adapterEstimate);
    const inflightUsage = createInflightUsageFlusher(db, sessionId, usageTracker);

    const cleanup = () => {
      inflightUsage.cancel();
      this.clearSourcedInterrupt(record);
      adapterEvents.removeAllListeners('event');
      adapterEvents.removeAllListeners('error');
      for (const f of tempFiles) f.cleanup();
      for (const f of record.attachmentTempFiles) f.cleanup();
      this.sessions.delete(sessionId);
      const resolvers = this.steerResolvers.get(sessionId);
      if (resolvers) {
        for (const res of resolvers) {
          res(null);
        }
        this.steerResolvers.delete(sessionId);
      }
      this.deps.broadcast(input.conversationId, this.sessionEndedFrame(record, input.conversationId, sessionId));
      // Deferred peer messages land as the conversation's next turn (D4 reversed).
      void flushMeshMailbox(this, input.conversationId)
        .catch((e) => console.warn('[mesh] mailbox flush failed:', e));
    };

    // Persist native_session_id the first time the adapter exposes it.
    // Same race fix as handlePrompt: opencode/pi populate nativeSessionId on
    // a later frame than status:running, so checking on every event is
    // required or the row stays NULL and the availability badge needs a
    // manual refresh to flip.
    let nativePersisted = false;
    const persistNativeIfReady = () => {
      if (nativePersisted) return;
      const native = (adapter as unknown as { nativeSessionId?: string }).nativeSessionId;
      if (native) {
        setNativeSessionId(db, sessionId, native);
        nativePersisted = true;
      }
    };

    adapterEvents.on('event', (event: NormalisedEvent) => {
      usageTracker.trackMessage(event);
      if (shouldScheduleInflightUsage(event)) inflightUsage.schedule();
      persistNativeIfReady();
      this.touchActivity(record, sessionId);
      const outbound = this.decorateStreamEvent(record, event);
      if (!outbound) return;
      const saved = this.persistAndBroadcast(input.conversationId, {
        ...outbound, sessionId, sender: 'agent', agentProfileId: input.profileId,
      });
      if (outbound.type === 'status') {
        record.lastStatus = outbound.payload.status;
        if (outbound.payload.status === 'done' || outbound.payload.status === 'error' || outbound.payload.status === 'idle') {
          this.clearSourcedInterrupt(record);
          persistTerminalUsage(db, sessionId, usageTracker, inflightUsage, outbound.payload);
        }
        if (outbound.payload.status === 'done') {
          // Detached: the checkpoint (local git or remote git.call) must never fail or delay the turn.
          void recordAutoCheckpoint(db, {
            conversationId: input.conversationId,
            sessionId,
            eventId: saved.id,
          })
            .then(() => {
              this.deps.broadcast(input.conversationId, {
                type: 'checkpoints_updated',
                conversationId: input.conversationId,
              });
            })
            .catch(() => { /* checkpoint must never fail the turn */ });
        }
      }
    });

    adapterEvents.on('error', (err: Error) => {
      // After an intentional stop, adapter infrastructure errors (EPIPE on the
      // killed child, aborted SDK request) are stop consequences — not failures.
      if (record.abortController.signal.aborted) return;
      this.persistAndBroadcast(input.conversationId, {
        type: 'error', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { message: err.message },
      });
      this.persistAndBroadcast(input.conversationId, {
        type: 'status', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { status: 'error' },
      });
    });

    adapterEvents.once('end', () => {
      // Drain everything still queued. ponytail: plain mid-turn steers used to be
      // discarded here — if the turn ended before the adapter's steer loop pulled
      // one, the operator's message vanished with no trace. Nothing consumed it,
      // so re-dispatching it as a follow-up turn is the only non-lossy option.
      const followUpQueue = [...record.steerQueue];
      const aborted = record.abortController.signal.aborted;
      const origin = { ...record.steerOrigin };
      if (!aborted && followUpQueue.length > 0) {
        this.beginPendingDrain(origin.conversationId);
      }
      cleanup();
      this.drainFollowUpQueue(origin, followUpQueue, aborted);
    });

    try {
      const runner = makeAdapterRunner({
        // ponytail: compaction summariser stays on the hub; the preferred agent must be installed locally
        createAdapter: (agentType, opts) => registry.create(agentType, opts),
        resolveModel: (profileId) => catalogue.getProfile(profileId)?.model ?? input.model,
        cwd,
      });
      const isNativeAvailable = adapter.isNativeSessionAvailable?.bind(adapter)
        ?? (() => Promise.resolve(false));
      const settings = getCompactionSettings(db);
      const preferredAgentType = settings.preferredProfileId.split(':')[0];
      const compactor = registry.has(preferredAgentType)
        // ponytail: tool-free summariser needs the agent on the hub
        ? registry.create(preferredAgentType)
        : undefined;
      const estimate = compactor?.estimateTokenCount
        ? (t: string) => compactor.estimateTokenCount!(t)
        : undefined;
      const plan = await buildResumePlan(db, input.conversationId, {
        runner,
        isNativeAvailable,
        estimate,
        agentId: input.agent,
        excludeId: sessionId,
        override: handoffOverride,
        priming: ARGV_PROMPT_ADAPTERS.has(input.agent) ? { framing: 'resume', maxBytes: ARGV_PRIMING_BYTES } : undefined,
        getTargetContextWindow: async () => {
          try {
            if (!registry.has(input.agent)) return Infinity;
            const targetAdapter = registry.create(input.agent, project.remoteHostId ? { remoteHostId: project.remoteHostId } : undefined);
            const models = await targetAdapter.listModels();
            const hit = models.find((m) => m.name === input.model);
            return hit?.contextWindow ?? Infinity;
          } catch {
            return Infinity;
          }
        },
      });

      recordHandoff(db, {
        conversationId: input.conversationId,
        sessionId,
        toProfileId: input.profileId,
        handoffOverride,
        handoffMode: settings.handoffMode,
        plan,
      });

      if (record.abortController.signal.aborted) {
        cleanup();
        return sessionId;
      }

      if (cmdSandboxOn && !hubProject.remoteHostId) {
        if (!hasSandboxProfile(input.agent)) throw new SandboxError('sandbox_unsupported_agent');
        if (!bwrapAvailable()) throw new SandboxError('sandbox_unavailable');
      }

      ensureProjectStateGitExclude(cwd);
      await adapter.start({
        sessionId,
        conversationId: input.conversationId,
        cwd,
        model: input.model,
        nativeSessionId: plan.mode === 'native' ? safePersistedNativeSessionId(plan.nativeSessionId) : undefined,
        effort: input.effort,
        // Same as handlePrompt: soft-cancel adapters (grok-build) park a steer
        // loop after the command turn so mid-turn Queue items can drain.
        getNextSteer: async (signal) => {
          return this.pullNextSteer(sessionId, signal);
        },
        trustRepoConfig: project?.trustRepoConfig === true,
        ...(promptOptions ? { options: promptOptions } : {}),
        ...(record.mcpServers?.length ? { mcpServers: record.mcpServers } : {}),
        ...(record.disableNativeMcp ? { disableNativeMcp: true } : {}),
        ...(record.disabledNativeMcp?.length ? { disabledNativeMcp: record.disabledNativeMcp } : {}),
      });
      record.started = true;

      if (record.abortController.signal.aborted) {
        return sessionId;
      }

      if (adapter.runCommand) {
        inflightUsage.writeInitial();
        await adapter.runCommand(input.name, input.args, ...(promptOptions ? [promptOptions] : []));
      } else {
        const barePrompt = agentTakesBarePrompt(profile.agentType);
        const barePriming = barePrompt
          && !!plan.primingPrompt
          && grokBotBarePrimingEnabled(db, input.conversationId, input.projectId);
        const facts = this.hostFactsFor(project);
        const textToSend = assembleAgentPromptText({
          barePrompt,
          userText: slashText,
          primingPrompt: barePrompt && !barePriming ? undefined : plan.primingPrompt,
          hostNote: !barePrompt && facts.remote ? remoteHostNote(facts, cwd, input.conversationId) : undefined,
          barePrimingNote: barePriming
            ? buildBarePrimingHostNote({ hostname: osHostname(), cwd })
            : undefined,
        });
        usageTracker.setPromptText(textToSend);
        inflightUsage.writeInitial();
        const { adapterAttachments, tempFiles: attachmentTempFiles } = prepareSendAttachments(
          db, profile, sessionId, input.attachments, plan.primingAttachments,
        );
        tempFiles.push(...attachmentTempFiles);
        await adapter.sendPrompt(textToSend, adapterAttachments, input.model, input.effort, ...(promptOptions ? [promptOptions] : []));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.persistAndBroadcast(input.conversationId, {
        type: 'error', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { message: msg },
      });
      this.persistAndBroadcast(input.conversationId, {
        type: 'status', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: input.profileId,
        payload: { status: 'error' },
      });
      cleanup();
    }

    return sessionId;
  }

  /**
   * Re-dispatch items that were queued mid-turn after the prior session ends.
   * Structured slash items (commandName set) go through handleCommand; plain
   * text (and sourced notifies) through handlePrompt. Sequential so each turn
   * settles before the next starts.
   */
  private drainFollowUpQueue(
    origin: SessionRecord['steerOrigin'],
    items: QueuedMessage[],
    aborted: boolean,
  ): void {
    if (aborted || items.length === 0) return;
    void (async () => {
      try {
        for (const item of items) {
          try {
            if (item.commandName) {
              await this.handleCommand({
                projectId: origin.projectId,
                conversationId: origin.conversationId,
                agent: origin.agent,
                model: origin.model,
                profileId: origin.profileId,
                name: item.commandName,
                ...(item.commandArgs !== undefined ? { args: item.commandArgs } : {}),
                attachments: item.attachments,
                ...(item.handoffOverride ? { handoffOverride: item.handoffOverride } : {}),
                cwd: origin.cwd,
              });
            } else {
              const firstNotify =
                item.source === 'subagent_notify' || item.source === 'parent_message'
                  ? item
                  : undefined;
              await this.handlePrompt({
                ...origin,
                text: item.text,
                attachments: item.attachments,
                skipRecall: item.recall !== true,
                ...(item.handoffOverride ? { handoffOverride: item.handoffOverride } : {}),
                ...(firstNotify
                  ? { source: firstNotify.source as 'subagent_notify' | 'parent_message', subagent: firstNotify.subagent }
                  : {}),
              });
            }
            // ignoreDrain: this wait is inside the drain whose counter
            // hasPendingSteerWork would otherwise spin on until timeout.
            await this.waitForConversationSettle(origin.conversationId, {
              hasOpenNotifyChildren: () => false,
              timeoutMs: 600_000,
              ignoreDrain: true,
            });
          } catch (err) {
            console.warn(
              `[sessionManager] follow-up drain failed for ${origin.conversationId}:`,
              err instanceof Error ? err.message : err,
            );
          }
        }
      } finally {
        this.endPendingDrain(origin.conversationId);
      }
    })();
  }

  private persistAndBroadcast(conversationId: string, event: NormalisedEvent) {
    const db = getDb();
    const savedEvent = appendEvent(db, {
      sessionId: event.sessionId,
      type: event.type,
      payload: event.payload as unknown,
      sender: event.sender ?? 'agent',
      agentModelId: event.agentProfileId,
      seq: event.seq,
      ts: event.ts,
    });
    touchConversation(db, conversationId, event.ts);
    this.deps.broadcast(conversationId, { type: 'event', conversationId, event: savedEvent as unknown as NormalisedEvent });
    return savedEvent;
  }

  async stopSession(sessionId: string, opts?: { initiatedBy?: 'operator' | 'system' }): Promise<StopSessionResult> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { stopped: false, reason: 'not_found', message: 'Session not found' };
    }
    if (opts?.initiatedBy === 'operator') {
      // Open spawn edge: CAS to interrupted so the child's watcher cannot
      // publish a premature ◀ result / parent notify from this stop.
      // Interrupt & Send does NOT take this path (session stays live).
      const edge = getEdgeByChild(getDb(), record.conversationId);
      if (edge?.status === 'open') resolveSpawnEdge(getDb(), edge.id, 'interrupted', 'interrupted');
    }
    // Trip the abort gate first so handlePrompt's await boundaries bail
    // cleanly even if adapter.start() hasn't run yet. Idempotent — late
    // aborts after the adapter has started are harmless because we still
    // call adapter.stop() below when `started` is true.
    record.abortController.abort();
    this.clearSourcedInterrupt(record);
    // Discard any queued steer messages — a stopped turn must not spawn a
    // follow-up turn from the drain-on-end handler.
    if (record.steerQueue.length > 0) {
      const count = record.steerQueue.length;
      record.steerQueue.length = 0;
      this.deps.broadcast(record.conversationId, {
        type: 'steer_queue',
        conversationId: record.conversationId,
        queue: [],
      });
      this.persistAndBroadcast(record.conversationId, {
        type: 'error', sessionId, seq: 0, ts: Date.now(), sender: 'system',
        agentProfileId: record.profileId,
        payload: { message: `⚠ ${count} queued message(s) discarded when the session was stopped` },
      });
    }
    try {
      if (record.started) {
        await record.adapter.stop();
      }
      return { stopped: true, reason: record.started ? undefined : 'aborted_pre_start' };
    } catch (err) {
      return {
        stopped: false,
        reason: 'error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Re-issue a fresh spawn token for a conversation.
   * If there is an active session, injects the new token stub directly
   * so the agent receives the updated Bearer token immediately.
   */
  /** conversationId → synthetic sessionId for an orphan (no live session) token. */
  private orphanTokenSession = new Map<string, string>();

  private consumeOrphanToken(conversationId: string): void {
    const prev = this.orphanTokenSession.get(conversationId);
    if (!prev) return;
    revokeSpawnTokensForSession(prev);
    this.orphanTokenSession.delete(conversationId);
  }

  async reissueSpawnToken(conversationId: string): Promise<{
    token: string;
    expiresAt: number;
    injected: boolean;
  } | null> {
    const db = getDb();
    const record = [...this.sessions.values()].find(
      (s) => s.conversationId === conversationId && !s.abortController.signal.aborted,
    );
    let sessionId: string;
    if (record) {
      this.consumeOrphanToken(conversationId);
      sessionId = record.id;
    } else {
      const prev = this.orphanTokenSession.get(conversationId);
      if (prev) revokeSpawnTokensForSession(prev);
      sessionId = randomUUID();
      this.orphanTokenSession.set(conversationId, sessionId);
    }
    const last = record ? undefined : lastSessionForConversation(db, conversationId);
    const minted = this.mintTokenStub(conversationId, sessionId,
      record?.agentType ?? last?.agentId ?? undefined, record?.profileId ?? last?.agentModelId ?? undefined);
    if (!minted) {
      if (!record) this.orphanTokenSession.delete(conversationId);
      return null;
    }
    const expiresAt = peekSpawnToken(minted.token)?.expiresAt ?? Date.now() + getSpawnTokenTtlMs();
    let injected = false;
    if (record) {
      await this.steerSession(record.id, minted.stub, undefined, { source: 'user', intent: 'auto' });
      injected = true;
    }
    return { token: minted.token, expiresAt, injected };
  }

  /** Resolve a conversation's capability profile once and derive everything
   *  the preamble/token mint needs from it: the profile-scoped plugin roster,
   *  the usage grant, and a pluginSetHash that folds in the profile fingerprint
   *  so narrowing/widening forces exactly one full re-preamble. */
  private capabilityArgs(conv: NonNullable<ReturnType<typeof getConversation>>): {
    capProfile: ResolvedCapabilityProfile;
    plugins: AgentPlugins;
    usage: boolean;
    pluginSetHash: string;
  } {
    const capProfile = resolveConversationProfile(getDb(), conv.capabilityProfile);
    return {
      capProfile,
      plugins: scopeAgentPlugins(this.deps.pluginHost?.listForAgent() ?? [], capProfile),
      usage: capProfile.usage,
      pluginSetHash: `${this.deps.pluginHost?.pluginSetHash() ?? ''}|${capabilityProfileFp(capProfile)}`,
    };
  }

  /** Mint a token per tokenEntitlement and build the matching short stub.
   *  null ⇒ this conversation takes no token (bare-prompt adapter / no conv). */
  private mintTokenStub(conversationId: string, sessionId: string, agentType: string | undefined,
    profileId: string | undefined): { token: string; stub: string } | null {
    const db = getDb();
    const conv = getConversation(db, conversationId);
    const ent = tokenEntitlement(db, conv, agentType, profileId ? catalogue.getProfile(profileId) : undefined);
    if (ent.kind === 'none' || !conv) return null;
    const port = this.hostFactsFor(getProject(db, conv.projectId)).port;
    const caps = this.capabilityArgs(conv);
    const isRoot = isPolicyRoot(db, conv);
    const selfTimer = selfTimerAllowed(AGENT_SELF_TIMERS, isRoot)
      ? { conversationId: conv.id, isChild: !isRoot }
      : undefined;
    const globalTasks = globalTasksAllowed(getGlobalTasksSettings(db), isRoot)
      ? { conversationId: conv.id, isChild: !isRoot }
      : undefined;
    if (ent.kind === 'spawn') {
      const token = issueSpawnToken(conversationId, sessionId, withSessionScope(db, SPAWN_CAPABILITIES, conv), caps.capProfile);
      return {
        token,
        stub: buildDelegationStub({
          parentConversationId: conversationId,
          spawnToken: token,
          port,
          scheduleCreate: conv.projectId ? { projectId: conv.projectId } : undefined,
          selfConversationId: conv.id,
          selfParentConversationId: conv.parentConversationId ?? undefined,
          plugins: caps.plugins,
          usage: caps.usage,
          selfTimer,
          globalTasks,
          memoryEnabled: getGeneralSettings(db).memories && profileAllowsMemory(caps.capProfile),
          searchScope: effectiveAgentSearchScope(db, conv, getProject(db, conv.projectId)),
        }),
      };
    }
    const token = issueSpawnToken(conversationId, sessionId, withSessionScope(db, CONVERSATION_CAPABILITIES, conv), caps.capProfile);
    return { token, stub: buildScheduleOnlyStub({
      projectId: conv.projectId, token, port, plugins: caps.plugins, usage: caps.usage, selfTimer, globalTasks,
      memoryEnabled: getGeneralSettings(db).memories && profileAllowsMemory(caps.capProfile),
      searchScope: effectiveAgentSearchScope(db, conv, getProject(db, conv.projectId)),
    }) };
  }


  async steerSession(
    sessionId: string,
    text: string,
    attachments?: { base64: string; mediaType: string; name?: string }[],
    meta?: {
      source?: 'user' | 'subagent_notify' | 'parent_message' | 'peer_message' | 'force';
      subagent?: SubagentNotifyMeta;
      intent?: 'auto' | 'queue' | 'force';
      commandName?: string;
      commandArgs?: string;
      handoffOverride?: HandoffOverride;
      adapterPrefix?: string;
      recall?: boolean;
    },
  ): Promise<SteerSessionResult> {
    const record = this.sessions.get(sessionId);
    if (!record) {
      return { mode: 'not_found', queueLength: 0, message: 'Session not found' };
    }
    if (record.abortController.signal.aborted) {
      return { mode: 'ending', queueLength: record.steerQueue.length };
    }

    const intent = meta?.intent ?? 'auto';
    const commandFields = {
      ...(meta?.commandName ? { commandName: meta.commandName } : {}),
      ...(meta?.commandArgs !== undefined ? { commandArgs: meta.commandArgs } : {}),
      ...(meta?.recall ? { recall: true } : {}),
    };

    // intent:'queue' — always park as a post-turn follow-up (never inject).
    if (intent === 'queue') {
      const queuedItem: QueuedMessage = {
        id: randomUUID(),
        type: 'queue',
        text,
        ts: Date.now(),
        attachments,
        ...(meta?.source ? { source: meta.source } : {}),
        ...(meta?.subagent ? { subagent: meta.subagent } : {}),
        ...(meta?.handoffOverride ? { handoffOverride: meta.handoffOverride } : {}),
        ...(meta?.adapterPrefix ? { adapterPrefix: meta.adapterPrefix } : {}),
        ...commandFields,
      };
      record.steerQueue.push(queuedItem);
      // Soft-cancel adapters park a pullNextSteer resolver after status:done.
      // If we only push and never wake it, Queue sits at IDLE forever. Only
      // wake when the turn is already terminal (mid-turn Queue stays parked
      // until natural end — live-inject resolvers must not steal it).
      if (record.lastStatus && SessionManager.TERMINAL.has(record.lastStatus)) {
        const resolvers = this.steerResolvers.get(sessionId);
        const res = resolvers?.shift();
        if (res) {
          const idx = record.steerQueue.findIndex((q) => q.id === queuedItem.id);
          if (idx !== -1) record.steerQueue.splice(idx, 1);
          res(queuedItem);
          this.deps.broadcast(record.conversationId, {
            type: 'steer_queue',
            conversationId: record.conversationId,
            queue: record.steerQueue,
          });
          return { mode: 'queued', queueLength: record.steerQueue.length };
        }
      }
      const queueLength = record.steerQueue.length;
      this.deps.broadcast(record.conversationId, {
        type: 'steer_queue',
        conversationId: record.conversationId,
        queue: record.steerQueue,
      });
      this.deps.broadcast(record.conversationId, {
        type: 'steer_queued',
        conversationId: record.conversationId,
        sessionId,
        queueLength,
        text,
      });
      return { mode: 'queued', queueLength };
    }

    // intent:'force' — interrupt now, deliver as next turn via drain.
    // Soft-cancel: interruptTurn() (session stays alive, steer-loop drains).
    // Hard-stop (cursor/opencode/kilocode): adapter.stop() without aborting or
    // clearing the queue — once('end') drain fires handlePrompt. Do NOT use
    // stopSession (it aborts + clears steerQueue). Do NOT use armSourcedInterrupt.
    if (intent === 'force') {
      const hasSoftCancel = typeof record.adapter.interruptTurn === 'function';
      const isHardStop = HARD_STOP_ADAPTERS.has(record.agentType);

      if (hasSoftCancel || isHardStop) {
        // Operator Interrupt & Send: hold spawn-parent notify until the
        // follow-up turn completes (or errors). Do not mark the edge
        // interrupted — the watcher must stay owner of the first result.
        record.suppressParentNotify = true;
      }

      if (!hasSoftCancel && !isHardStop) {
        const queuedItem: QueuedMessage = {
          id: randomUUID(),
          type: 'queue',
          text,
          ts: Date.now(),
          attachments,
          ...commandFields,
        };
        record.steerQueue.push(queuedItem);
        const queueLength = record.steerQueue.length;
        this.deps.broadcast(record.conversationId, {
          type: 'steer_queue',
          conversationId: record.conversationId,
          queue: record.steerQueue,
        });
        this.deps.broadcast(record.conversationId, {
          type: 'steer_queued',
          conversationId: record.conversationId,
          sessionId,
          queueLength,
          text,
        });
        return {
          mode: 'queued',
          queueLength,
          message: 'Force Steer unsupported; queued.',
        };
      }

      const queuedItem: QueuedMessage = {
        id: randomUUID(),
        type: 'queue',
        text,
        ts: Date.now(),
        attachments,
        source: 'force',
        ...(meta?.subagent ? { subagent: meta.subagent } : {}),
        ...commandFields,
      };
      record.steerQueue.push(queuedItem);
      const queueLength = record.steerQueue.length;
      this.deps.broadcast(record.conversationId, {
        type: 'steer_queue',
        conversationId: record.conversationId,
        queue: record.steerQueue,
      });
      this.deps.broadcast(record.conversationId, {
        type: 'steer_queued',
        conversationId: record.conversationId,
        sessionId,
        queueLength,
        text,
      });

      // Race: natural status:done already started the steer loop and parked a
      // resolver before cancel took effect. Hand the force item off directly so
      // it isn't stuck behind a waiter that only wakes on type:'steer' inject.
      // (Hard-stop adapters typically have no parked resolver — this is a no-op.)
      const resolvers = this.steerResolvers.get(sessionId);
      const res = resolvers?.shift();
      if (res) {
        const idx = record.steerQueue.findIndex((q) => q.id === queuedItem.id);
        if (idx !== -1) record.steerQueue.splice(idx, 1);
        res(queuedItem);
        this.deps.broadcast(record.conversationId, {
          type: 'steer_queue',
          conversationId: record.conversationId,
          queue: record.steerQueue,
        });
        return { mode: 'force_steered', queueLength: record.steerQueue.length };
      }

      if (hasSoftCancel) {
        try {
          record.adapter.interruptTurn!();
        } catch {
          /* best-effort; natural end / steer loop still drains */
        }
        return { mode: 'force_steered', queueLength };
      }

      // Hard stop: kill subprocess; do not abort / clear queue. 'end' drain
      // reinjects via handlePrompt on a fresh session.
      try {
        await record.adapter.stop();
      } catch {
        /* best-effort; if stop failed the force item remains queued for natural end */
      }
      return { mode: 'force_steered', queueLength };
    }

    // intent:'auto' (default) — unchanged pre-Force-Steer behaviour.
    const type = record.injectable ? 'steer' : 'queue';
    const queuedItem: QueuedMessage = {
      id: randomUUID(),
      type,
      text,
      ts: Date.now(),
      attachments,
      ...(meta?.source ? { source: meta.source } : {}),
      ...(meta?.subagent ? { subagent: meta.subagent } : {}),
      ...(meta?.adapterPrefix ? { adapterPrefix: meta.adapterPrefix } : {}),
      ...commandFields,
    };

    // If the adapter is injectable AND a steer loop is currently parked on
    // pullNextSteer, hand the item off directly (mode 'injected'). Otherwise
    // — including the case where the adapter is injectable in principle but
    // hasn't entered its steer loop yet (e.g. Hermes during sendPrompt, or any
    // adapter whose loop hasn't been authored) — fall through to the queue.
    // Reporting 'injected' when nothing consumed the message hides the steer
    // from the operator: it never reaches the adapter and never drains.
    if (type === 'steer') {
      const resolvers = this.steerResolvers.get(sessionId);
      const res = resolvers?.shift();
      if (res) {
        res(queuedItem);
        this.deps.broadcast(record.conversationId, {
          type: 'steer_queue',
          conversationId: record.conversationId,
          queue: record.steerQueue,
        });
        return { mode: 'injected', queueLength: record.steerQueue.length };
      }
    }

    record.steerQueue.push(queuedItem);
    const queueLength = record.steerQueue.length;

    this.deps.broadcast(record.conversationId, {
      type: 'steer_queue',
      conversationId: record.conversationId,
      queue: record.steerQueue,
    });

    this.deps.broadcast(record.conversationId, {
      type: 'steer_queued',
      conversationId: record.conversationId,
      sessionId,
      queueLength,
      text,
    });

    // Sourced steers (child→parent notify / parent→child message) queued mid-turn:
    // prefer natural end-of-stream (steer loop drains after status:done). Only
    // soft-interrupt after the parent has been stream-idle long enough — that
    // unsticks "waiting for kids" without cutting off an active reply.
    // Do NOT stopSession here: that clears the queue and kills the subprocess.
    if (meta?.source === 'subagent_notify' || meta?.source === 'parent_message' || meta?.source === 'peer_message') {
      this.armSourcedInterrupt(sessionId);
    }

    // Always 'queued' here: we only reach this branch when no parked resolver
    // consumed the item, regardless of record.injectable.
    return { mode: 'queued', queueLength };
  }

  async cancelSteerMessage(conversationId: string, sessionId: string, messageId: string): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;

    const idx = record.steerQueue.findIndex((q) => q.id === messageId);
    if (idx !== -1) {
      record.steerQueue.splice(idx, 1);
      this.deps.broadcast(conversationId, {
        type: 'steer_queue',
        conversationId,
        queue: record.steerQueue,
      });
    }
  }

  async editSteerMessage(
    conversationId: string,
    sessionId: string,
    messageId: string,
    text: string,
    attachments?: { base64: string; mediaType: string; name?: string }[],
    meta?: { commandName?: string; commandArgs?: string },
  ): Promise<void> {
    const record = this.sessions.get(sessionId);
    if (!record) return;

    const item = record.steerQueue.find((q) => q.id === messageId);
    if (!item) return;

    item.text = text;
    if (attachments !== undefined) item.attachments = attachments;
    if (meta?.commandName) {
      item.commandName = meta.commandName;
      if (meta.commandArgs !== undefined) item.commandArgs = meta.commandArgs;
      else delete item.commandArgs;
    } else {
      delete item.commandName;
      delete item.commandArgs;
    }

    this.deps.broadcast(conversationId, {
      type: 'steer_queue',
      conversationId,
      queue: record.steerQueue,
    });
  }

  private async pullNextSteer(sessionId: string, signal?: AbortSignal): Promise<{ text: string; attachments?: any[] } | null> {
    const record = this.sessions.get(sessionId);
    if (!record) return null;

    // Drainable: mid-turn steers + every post-turn queue item (plain Queue and
    // Interrupt & Send). Injectable adapters (pi/grok-build/hermes) keep the
    // subprocess alive and never emit EventEmitter 'end' between turns — pi's
    // steer loop parks from ready (mid-run inject), the others only after
    // status:done. If type:'queue' stayed end-only, the UI would show
    // "Pending Messages" forever after IDLE.
    const isDrainable = (q: QueuedMessage) =>
      q.type === 'steer' || q.type === 'queue';

    // Structured slash commands and items with a handoff override must leave the
    // hold-open session and re-enter via handleCommand or handlePrompt.
    // Returning null ends the steer loop → adapter emits 'end' → drainFollowUpQueue
    // dispatches with the command or handoff override intact.
    // Leave the queue intact so the end handler still sees the items.
    const needsNewTurn = (q: QueuedMessage) => !!q.commandName || !!q.handoffOverride;

    const exitForStructuredDrain = (first?: QueuedMessage): null => {
      if (first) record.steerQueue.unshift(first);
      return null;
    };

    // ponytail: batch multiple steers queued during one turn — drain all ready
    // plain-text items after the first arrives and combine into one stdin write.
    // Stop combining when we hit a structured command or handoff override (leave it for end-drain).
    const drainAndCombine = (first: QueuedMessage) => {
      if (needsNewTurn(first)) return exitForStructuredDrain(first);
      const items: QueuedMessage[] = [first];
      let idx: number;
      while ((idx = record.steerQueue.findIndex(isDrainable)) !== -1) {
        if (needsNewTurn(record.steerQueue[idx]!)) break;
        items.push(...record.steerQueue.splice(idx, 1));
      }
      this.deps.broadcast(record.conversationId, {
        type: 'steer_queue',
        conversationId: record.conversationId,
        queue: record.steerQueue,
      });
      for (const msg of items) {
        // Post-turn queue (plain Queue + Interrupt & Send) must open a *new*
        // transcript turn. Persisting as `steer` nests under the prior turn
        // and leaves the operator looking at a false mid-turn inject.
        const isFollowUpTurn = msg.type === 'queue';
        this.persistAndBroadcast(record.conversationId, {
          type: isFollowUpTurn ? 'prompt' : 'steer',
          sessionId,
          seq: 0,
          ts: Date.now(),
          sender: 'user',
          agentProfileId: record.profileId,
          payload: {
            text: msg.text,
            attachments: msg.attachments?.map((a) => ({ base64: a.base64, mediaType: a.mediaType, name: a.name })),
            ...(isFollowUpTurn && record.sandbox ? { sandboxed: true as const } : {}),
          },
        });
      }
      // Path-only adapters (grok-build, opencode, antigravity, …) need tempPath
      // for @path / --file delivery. handlePrompt writes temps via
      // prepareSendAttachments; the soft-cancel steer loop never hits that path,
      // so Interrupt & Send / Queue images would arrive as base64-only and be
      // silently dropped. Materialize here — same dir as imageHelper.
      const rawAtts = items.flatMap((m) => m.attachments ?? []);
      let adapterAtts = rawAtts;
      if (rawAtts.length > 0) {
        const temps = writeTempAttachments(rawAtts);
        record.attachmentTempFiles.push(...temps);
        adapterAtts = rawAtts.map((a, i) => ({
          ...a,
          tempPath: temps[i]?.path,
        }));
      }

      // Any wake-up (operator, subagent_notify, parent_message, peer_message) slides the
      // token, or reissues it under session-start rules if the idle backstop fired
      // or the model's spawn entitlement changed while the session was running.
      let stubPrefix = '';
      if (record.tokenKind !== undefined) {
        const db = getDb();
        const currentEnt = tokenEntitlement(
          db,
          getConversation(db, record.conversationId),
          record.agentType,
          record.profileId ? catalogue.getProfile(record.profileId) : undefined,
        );
        if (record.tokenKind !== currentEnt.kind) {
          record.tokenKind = currentEnt.kind;
          revokeSpawnTokensForConversation(record.conversationId);
        }
      }
      const liveToken = getLiveTokenForConversation(record.conversationId);
      if (liveToken) touchSpawnToken(liveToken.token);
      else stubPrefix = this.mintTokenStub(record.conversationId, sessionId, record.agentType, record.profileId)?.stub ?? '';

      const combinedText = items.map((m) => (
        m.adapterPrefix ? `${m.adapterPrefix}\n\n${m.text}` : m.text
      )).join('\n\n');
      const recallItems = items.filter((m) => m.recall && isEligibleRecallSource(m.source));
      const recallText = recallItems.map((m) => m.text).join('\n\n');
      let recallBlock = '';
      if (recallText) {
        const db = getDb();
        const conv = getConversation(db, record.conversationId);
        const recalled = recallMemories({
          db,
          conversationId: record.conversationId,
          projectId: conv?.projectId ?? '',
          text: recallText,
          source: recallItems[0]?.source,
          agentType: record.agentType,
          shown: this.shownFor(record.conversationId),
        });
        if (recalled) {
          recallBlock = recalled.block;
          this.persistRecallChip(record.conversationId, sessionId, record.profileId, recalled.ids);
        }
      }
      const body = recallBlock ? `${recallBlock}\n\n${combinedText}` : combinedText;
      return {
        text: stubPrefix ? [stubPrefix, body].join('\n\n') : body,
        attachments: adapterAtts,
      };
    };

    const steerIdx = record.steerQueue.findIndex(isDrainable);
    if (steerIdx !== -1) {
      if (needsNewTurn(record.steerQueue[steerIdx]!)) {
        // Leave all items in the queue for once('end') structured drain.
        return null;
      }
      const [first] = record.steerQueue.splice(steerIdx, 1);
      return drainAndCombine(first!);
    }

    return new Promise<{ text: string; attachments?: any[] } | null>((resolve) => {
      if (!this.steerResolvers.has(sessionId)) {
        this.steerResolvers.set(sessionId, []);
      }
      const list = this.steerResolvers.get(sessionId)!;
      const resolver = (msg: QueuedMessage | null) => {
        signal?.removeEventListener('abort', onAbort);
        if (!msg) { resolve(null); return; }
        if (needsNewTurn(msg)) {
          resolve(exitForStructuredDrain(msg));
          return;
        }
        resolve(drainAndCombine(msg));
      };
      const onAbort = () => {
        const i = list.indexOf(resolver);
        if (i !== -1) list.splice(i, 1);
        if (list.length === 0) this.steerResolvers.delete(sessionId);
        resolve(null);
      };
      list.push(resolver);
      if (!signal) return;
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  respondToInteraction(
    sessionId: string,
    requestId: string,
    response: { selection: string[]; text?: string; answers?: { selection: string[]; text?: string }[] },
  ): { accepted: boolean; reason?: 'not_found' | 'unsupported' | 'error'; message?: string } {
    const record = this.sessions.get(sessionId);
    if (!record) return { accepted: false, reason: 'not_found', message: 'Session not found' };
    if (typeof record.adapter.respondToInteraction !== 'function') {
      return { accepted: false, reason: 'unsupported', message: 'Adapter cannot answer interactions' };
    }
    try {
      record.adapter.respondToInteraction(requestId, response);
      return { accepted: true };
    } catch (err) {
      return { accepted: false, reason: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  /** Append a cross-thread breadcrumb (⇪ spawned / ◀ result) to a transcript.
   *  Goes through the same persist+broadcast path so the marker is durable AND
   *  reaches live subscribers. Reuses the parent's most recent real session so
   *  the marker does NOT create a null-agent session row — that would win the
   *  "last session" lookup (polluting /active-agent + /usage agentType + native
   *  availability) and inflate session_count. Only a never-prompted parent
   *  (manual spawn from a fresh conversation) needs a synthetic row, and there
   *  nothing real exists to pollute.
   *  ponytail: reuse-or-create; synthetic path is the rare fresh-parent case. */
  recordSpawnMarker(parentConversationId: string, marker: SpawnMarker): void {
    const db = getDb();
    let sessionId = lastSessionForConversation(db, parentConversationId)?.id;
    if (!sessionId) {
      sessionId = randomUUID();
      createSession(db, { id: sessionId, conversationId: parentConversationId });
    }
    this.persistAndBroadcast(parentConversationId, {
      type: 'message', sessionId, seq: 0, ts: Date.now(),
      sender: 'system',
      payload: { chunk: marker.text, spawnMarker: marker },
    });
  }

  /** Ensure a session row exists for shell events (reuse last real session so we
   *  never mint a null-agent session that poisons lastSessionForConversation). */
  private ensureShellSessionId(conversationId: string): string {
    const db = getDb();
    let sessionId = lastSessionForConversation(db, conversationId)?.id;
    if (!sessionId) {
      sessionId = randomUUID();
      createSession(db, { id: sessionId, conversationId });
    }
    return sessionId;
  }

  /** Broadcast the operator-shell tool_call immediately when a command is accepted
   *  (before spawn finishes) so the UI can show a running state. Returns toolUseId
   *  for the matching recordShellResult. tool_call name:'shell' is the discriminator. */
  recordShellStart(
    conversationId: string,
    echo: { command: string; cwd: string },
  ): string {
    const sessionId = this.ensureShellSessionId(conversationId);
    const toolUseId = randomUUID();
    this.persistAndBroadcast(conversationId, {
      type: 'tool_call', sessionId, seq: 0, ts: Date.now(), sender: 'user',
      payload: { toolUseId, name: 'shell', input: { command: echo.command, cwd: echo.cwd } },
    });
    return toolUseId;
  }

  /** Track a live shell child so shutdown can settle it before process.exit. */
  registerShellChild(toolUseId: string, child: ChildProcess, conversationId: string): void {
    this.shellChildren.set(toolUseId, { child, conversationId });
    child.once('close', () => this.shellChildren.delete(toolUseId));
  }

  /** Broadcast the operator-shell tool_result when the process exits (or fails). */
  recordShellResult(
    conversationId: string,
    toolUseId: string,
    result: { content: string; isError: boolean },
  ): void {
    this.shellChildren.delete(toolUseId);
    const sessionId = this.ensureShellSessionId(conversationId);
    this.persistAndBroadcast(conversationId, {
      type: 'tool_result', sessionId, seq: 0, ts: Date.now(), sender: 'system',
      payload: { toolUseId, content: result.content, isError: result.isError },
    });
  }

  /** Boot backstop: synthesize a tool_result for every shell tool_call the previous
   *  process died before settling. Idempotent — a synthesized result removes the
   *  orphan from the next scan. Returns the count reconciled. */
  reconcileOrphanShellResults(db: Database): number {
    const orphans = listOrphanShellToolCalls(db);
    for (const { toolUseId, conversationId } of orphans) {
      this.recordShellResult(conversationId, toolUseId, {
        content: '⚠ Server restarted while this command was running — output was lost.',
        isError: true,
      });
    }
    return orphans.length;
  }

  /** Shutdown: settle any still-running shell children synchronously so the common
   *  self-restart case (deploy) records a result before we exit, rather than
   *  relying on the next-boot reconcile. */
  settleShellChildrenForShutdown(): void {
    for (const [toolUseId, { child, conversationId }] of this.shellChildren) {
      this.shellChildren.delete(toolUseId);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      this.recordShellResult(conversationId, toolUseId, {
        content: '⚠ Server shutting down — command interrupted. Output may be partial.',
        isError: true,
      });
    }
    this.shellChildren.clear();
  }

  /** Persist a shell command echo + result in one shot (refusals / sync failures).
   *  Prefer recordShellStart + recordShellResult for long-running accepted commands
   *  so the operator sees the call card while the process runs. */
  recordShellTurn(
    conversationId: string,
    echo: { command: string; cwd: string },
    result: { content: string; isError: boolean },
  ): void {
    const toolUseId = this.recordShellStart(conversationId, echo);
    this.recordShellResult(conversationId, toolUseId, result);
  }

  /** The live in-flight session for a conversation, if any. Used to steer a
   *  finished async child's result back into the parent agent (notifyParent). */
  activeSessionForConversation(conversationId: string): SessionRecord | undefined {
    return this.activeSessions().find((s) => s.conversationId === conversationId);
  }

  // ponytail: single source of truth — spawn.ts:261 duplicates this locally; keep in sync.
  private static readonly TERMINAL = new Set<AgentStatus>(['idle', 'done', 'error']);

  /** A session that is genuinely mid-turn (not a parked hold-open subprocess).
   *  lastStatus undefined = started but no status yet → treat as in-flight.
   *  NB: do NOT change activeSessions()/activeSessionForConversation() globally —
   *  notifyParentSubagentResult and native-availability rely on parked sessions
   *  staying visible. This predicate is for the rewind gate only. */
  inFlightSessionForConversation(conversationId: string): SessionRecord | undefined {
    return this.activeSessions().find((s) =>
      s.conversationId === conversationId &&
      (!s.lastStatus || !SessionManager.TERMINAL.has(s.lastStatus)));
  }

  /** True when the conversation still has undelivered steers or a mid-turn agent.
   *  Schedules use this after the first status:done so soft-ended notifies can
   *  drain via the steer loop before stopSession wipes the queue. */
  hasPendingSteerWork(conversationId: string, opts?: { ignoreDrain?: boolean }): boolean {
    if (!opts?.ignoreDrain && (this.pendingDrains.get(conversationId) ?? 0) > 0) return true;
    const s = this.activeSessionForConversation(conversationId);
    if (!s) return false;
    if (s.steerQueue.length > 0) return true;
    return !s.lastStatus || !SessionManager.TERMINAL.has(s.lastStatus);
  }

  /**
   * Poll until the conversation is idle for schedule finalization:
   * no open notifyParent child edges, empty steer queue, and not mid-turn.
   * Parked hold-open (status:done + empty queue) counts as settled.
   * Resolves on timeout without throwing — caller still finalizes.
   */
  async waitForConversationSettle(
    conversationId: string,
    opts: {
      hasOpenNotifyChildren: () => boolean;
      timeoutMs?: number;
      pollMs?: number;
      /** Drain's own inter-item wait must not spin on pendingDrains. */
      ignoreDrain?: boolean;
    },
  ): Promise<void> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const pollMs = opts.pollMs ?? 100;
    const deadline = Date.now() + timeoutMs;
    const steerOpts = opts.ignoreDrain ? { ignoreDrain: true } : undefined;
    while (Date.now() < deadline) {
      const openKids = opts.hasOpenNotifyChildren();
      if (!openKids && !this.hasPendingSteerWork(conversationId, steerOpts) && !this.inFlightSessionForConversation(conversationId)) return;
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Settle-then-stop with a gate-held recheck. The wait is outside the gate (it
   *  polls); the decision is inside, so a concurrent handlePrompt either lands
   *  first (we see its work and re-wait) or blocks behind us. Deadline force-stops
   *  so the PID-leak backstop survives. */
  async stopWhenSettled(conversationId: string, sessionId: string, timeoutMs = 600_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await this.waitForConversationSettle(conversationId, {
        // Reuse the notify-children poll for native helpers still running after done.
        hasOpenNotifyChildren: () => this.runningHelperCount(conversationId) > 0,
        timeoutMs: Math.max(0, deadline - Date.now()),
      });
      const done = await this.withConversationGate(conversationId, async () => {
        if (Date.now() < deadline && (this.hasPendingSteerWork(conversationId) || this.runningHelperCount(conversationId) > 0)) return false;
        await this.stopSession(sessionId);
        return true;
      });
      if (done) return;
    }
  }

  private static hasRunningHelpers(s: SessionRecord): boolean {
    return (s.runningHelpers?.size ?? 0) > 0;
  }

  runningHelperCount(conversationId: string): number {
    return this.activeSessions()
      .filter((s) => s.conversationId === conversationId)
      .reduce((n, s) => n + (s.runningHelpers?.size ?? 0), 0);
  }

  async stopHelper(conversationId: string, taskId: string): Promise<boolean> {
    const s = this.activeSessionForConversation(conversationId);
    if (!s?.adapter.stopHelper) return false;
    try {
      await s.adapter.stopHelper(taskId);
      return true;
    } catch (err) {
      console.warn('[helpers] stopHelper failed:', err instanceof Error ? err.message : 'error');
      return false;
    }
  }

  /** Reap parked (terminal-status) hold-open sessions for a conversation so their
   *  subprocess exits and the Map entry clears. Await before mutating the transcript. */
  async reapParkedSessions(conversationId: string, opts?: { all?: boolean }): Promise<void> {
    const parked = this.activeSessions().filter((s) =>
      s.conversationId === conversationId &&
      s.lastStatus && SessionManager.TERMINAL.has(s.lastStatus) &&
      (opts?.all || (!HOLD_OPEN_FOLLOWUP_ADAPTERS.has(s.agentType) && !SessionManager.hasRunningHelpers(s))));
    await Promise.all(parked.map((s) => this.stopSession(s.id)));
  }

  /** Reap parked sessions of one agent type so the next turn picks up a new child env. Live turns are left running. */
  async reapParkedSessionsByAgent(agentType: string): Promise<void> {
    const parked = this.activeSessions().filter((s) =>
      s.agentType === agentType &&
      s.lastStatus && SessionManager.TERMINAL.has(s.lastStatus));
    await Promise.all(parked.map((s) => this.stopSession(s.id)));
  }

  /** Reap parked sessions on one remote host (toggle flips change its vault access). Live turns are left running. */
  async reapParkedSessionsByHost(hostId: string): Promise<void> {
    const parked = this.activeSessions().filter((s) =>
      s.lastStatus && SessionManager.TERMINAL.has(s.lastStatus) &&
      remoteHostIdFor(getDb(), { conversationId: s.conversationId }) === hostId);
    await Promise.all(parked.map((s) => this.stopSession(s.id)));
  }

  /** Parked hold-open session that cannot native-resume in a new process. */
  private parkedHoldOpenSession(conversationId: string): SessionRecord | undefined {
    return this.activeSessions().find((s) =>
      s.conversationId === conversationId &&
      (HOLD_OPEN_FOLLOWUP_ADAPTERS.has(s.agentType) || SessionManager.hasRunningHelpers(s)) &&
      !!s.lastStatus && SessionManager.TERMINAL.has(s.lastStatus));
  }

  /** WP-2.1: apply a persisted conversation.permissionMode change to any live or
   *  parked session. Live-capable adapters get setPermissionMode(); everything
   *  else reaps parked sessions ({ all: true }, mirroring mcpServers PATCH) so
   *  the next turn respawns under the new mode. In-flight turns without live
   *  support finish under the old mode — the adoption guard (e) rejects stale
   *  parking afterwards. */
  async applyConversationPermissionMode(
    conversationId: string,
  ): Promise<{ applied: 'live' | 'reaped' | 'none'; mode: 'bypass' | 'questions' | 'prompt' }> {
    const db = getDb();
    const mode = effectiveInteractionMode(db, conversationId);
    const live = this.inFlightSessionForConversation(conversationId);
    const target = live ?? this.parkedHoldOpenSession(conversationId);
    if (target?.adapter && typeof target.adapter.setPermissionMode === 'function') {
      try {
        await target.adapter.setPermissionMode(mode);
        target.interactionMode = mode;
        return { applied: 'live', mode };
      } catch (err) {
        console.warn(`[sessionManager] setPermissionMode failed for session ${target.id}:`, err);
      }
    }
    const hadSessions = Boolean(target || this.activeSessions().some((s) => s.conversationId === conversationId));
    await this.reapParkedSessions(conversationId, { all: true });
    return { applied: hadSessions ? 'reaped' : 'none', mode };
  }

  /** Reap or stop sessions when conversation/project sandbox setting changes —
   *  sandbox binds at adapter spawn; there is no live toggle. */
  async applyConversationSandbox(conversationId: string): Promise<'reaped' | 'none'> {
    const live = this.inFlightSessionForConversation(conversationId);
    const hadSessions = Boolean(
      live
      || this.parkedHoldOpenSession(conversationId)
      || this.activeSessions().some((s) => s.conversationId === conversationId),
    );
    if (live) await this.stopSession(live.id);
    await this.reapParkedSessions(conversationId, { all: true });
    return hadSessions ? 'reaped' : 'none';
  }

  /** WP-2.4: apply a persisted mcpServers selection change. claude-code with a
   *  live query swaps the set in place (SDK Query.setMcpServers) and updates the
   *  record hash so adoption stays consistent; anything else (or a set needing
   *  new secret env) keeps the next-turn semantics via parked reap. */
  async applyConversationMcpServers(conversationId: string): Promise<'live' | 'reaped' | 'none'> {
    const live = this.inFlightSessionForConversation(conversationId);
    if (live?.adapter && typeof live.adapter.setMcpServersLive === 'function') {
      const resolved = resolveMcpForConversation(getDb(), conversationId, live.agentType, live.profileId, undefined);
      try {
        if (await live.adapter.setMcpServersLive(resolved.inject)) {
          Object.assign(live, mcpRecordFields(resolved));
          return 'live';
        }
      } catch (err) {
        console.warn(`[sessionManager] setMcpServersLive failed for session ${live.id}:`, err);
      }
    }
    const hadSessions = Boolean(live || this.activeSessions().some((s) => s.conversationId === conversationId));
    await this.reapParkedSessions(conversationId, { all: true });
    return hadSessions ? 'reaped' : 'none';
  }

  /** Re-feed a finished async child's prose into the parent agent (notifyParent).
   *  Genuinely mid-turn parent → steer/inject or queue for drain-on-end.
   *  Parked (post-done hold-open) or fully ended parent → reap then start a
   *  fresh `subagent_notify` turn. No resumable session → visible marker only
   *  (never a silent drop — R3).
   *
   *  The follow-up is persisted as a silent `source: 'subagent_notify'` prompt
   *  (sender 'system', UI hides the User card). The full `text` is still what
   *  the LLM sees. */
  notifyParentSubagentResult(
    parentConversationId: string,
    text: string,
    meta: SubagentNotifyMeta,
  ): void {
    // Parked hold-open sessions must NOT count as live — steering into them
    // either never drains (queue) or is discarded on end (steer).
    const live = this.inFlightSessionForConversation(parentConversationId);
    if (live) {
      void this.steerSession(live.id, text, undefined, { source: 'subagent_notify', subagent: meta });
      return;
    }

    void this.reapParkedSessions(parentConversationId).then(() => {
      this.resumeNotifyTurn(parentConversationId, text, meta);
    });
  }

  /** Fresh-turn branch of notifyParentSubagentResult (parked/ended parent). */
  private resumeNotifyTurn(
    parentConversationId: string,
    text: string,
    meta: SubagentNotifyMeta,
  ): void {
    const db = getDb();
    const parent = getConversation(db, parentConversationId);
    const last = lastSessionForConversation(db, parentConversationId);
    if (!parent || !last?.agentId || !last.agentModelId) {
      this.recordUndeliverableNotify(parentConversationId, meta);
      return;
    }

    const profile = catalogue.getProfile(last.agentModelId);
    if (!profile?.enabled || profile.agentType !== last.agentId) {
      this.recordUndeliverableNotify(parentConversationId, meta);
      return;
    }

    void this.handlePrompt({
      projectId: parent.projectId,
      conversationId: parentConversationId,
      agent: last.agentId,
      model: profile.model,
      profileId: last.agentModelId,
      text,
      source: 'subagent_notify',
      subagent: meta,
    });
  }

  private recordUndeliverableNotify(
    parentConversationId: string,
    meta: SubagentNotifyMeta,
  ): void {
    const childId = meta.childConversationId ?? '';
    this.recordSpawnMarker(parentConversationId, {
      kind: 'result',
      childConversationId: childId,
      text: '⚠ sub-agent result could not be delivered to the parent agent (no resumable session) — fetch it via GET /spawn/'
        + childId + '/result',
      role: meta.role,
    });
  }

  /** Deliver a downward message from a validated ancestor to a descendant
   *  conversation. Mirrors notifyParentSubagentResult's three branches but
   *  with source 'parent_message' and a replyTo so the descendant's reply
   *  turn bridges back to the actual sender (which may be a grandparent).
   *  🔒 Callers MUST have descent-validated (route does); replyTo is the
   *  authenticated sender id, never caller-supplied content. */
  messageDescendant(
    targetConversationId: string,
    text: string,
    meta: {
      replyTo: string;
      role?: string;
      profileId?: string;
      notify?: boolean;
      handoff?: HandoffOverride;
      onStartError?: (msg: string) => void;
    },
  ): 'steered' | 'new_turn' | 'dropped' {
    const subagent: SubagentNotifyMeta = {
      role: meta.role,
      childConversationId: targetConversationId,
      replyTo: meta.replyTo,
      ...(meta.notify !== undefined ? { notify: meta.notify } : {}),
    };
    // Same parked-session bug as notifyParent: only steer into a live turn.
    const live = this.inFlightSessionForConversation(targetConversationId);
    if (live) {
      void this.steerSession(live.id, text, undefined, { source: 'parent_message', subagent, recall: true });
      return 'steered';
    }
    const db = getDb();
    const target = getConversation(db, targetConversationId);
    const last = lastSessionForConversation(db, targetConversationId);
    if (!target || !last?.agentId || !last.agentModelId) return 'dropped';

    const overrideId = meta.profileId;
    const profile = catalogue.getProfile(overrideId ?? last.agentModelId);
    if (!profile?.enabled) return 'dropped';
    if (!overrideId && profile.agentType !== last.agentId) return 'dropped';

    // Only a cross-agent switch needs a handoff; a same-agent model change keeps native resume.
    const crossAgent = !!overrideId && profile.agentType !== last.agentId;
    const staged = target.pendingHandoffMode;
    const handoffOverride = meta.handoff
      ?? staged
      ?? (crossAgent && getCompactionSettings(db).handoffMode === 'prompt' ? 'summary' : undefined);

    if (staged && clearConversationPendingHandoffMode(db, targetConversationId)) {
      this.deps.broadcastAll?.({
        type: 'conversation_updated',
        conversationId: targetConversationId,
        ts: Date.now(),
        pendingHandoffMode: null,
      });
    }

    // Reap any parked hold-open session before starting a fresh turn.
    void this.reapParkedSessions(targetConversationId).then(() => {
      return this.handlePrompt({
        projectId: target.projectId,
        conversationId: targetConversationId,
        agent: profile.agentType,
        model: profile.model,
        profileId: overrideId ?? last.agentModelId!,
        text,
        source: 'parent_message',
        subagent,
        interactionMode: 'bypass', // children always run bypass (unchanged policy)
        ...(handoffOverride ? { handoffOverride } : {}),
      });
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      if (meta.onStartError) {
        meta.onStartError(msg);
      } else {
        console.warn('[messageDescendant] handlePrompt start failed:', msg);
      }
    });
    return 'new_turn';
  }

  /** Fire a dictated transcript as a user prompt into `conversationId`. Called by
   *  the /transcribe route when auto-send is armed. Steers a live turn (injectable
   *  → inject, else → queue after the turn), else starts a fresh turn. Profile is
   *  taken from the client-supplied ctx (closes the never-prompted gap), falling
   *  back to the conversation's last session. Source is a normal user turn.
   *  Returns 'dropped' when there is no live turn and no resolvable profile. */
  autoSendTranscript(
    conversationId: string,
    text: string,
    ctx: { profileId: string; agent: string; model: string } | null,
  ): 'steered' | 'new_turn' | 'dropped' {
    // Live turn → steer/queue (D4). steerSession handles both agent classes.
    const live = this.inFlightSessionForConversation(conversationId);
    if (live) {
      void this.steerSession(live.id, text, undefined, { recall: true });   // no source → normal user turn (D5)
      return 'steered';
    }

    const db = getDb();
    const conv = getConversation(db, conversationId);
    if (!conv) return 'dropped';

    // Resolve profile: client ctx first (D7), else the conversation's last session.
    let agent = ctx?.agent;
    let model = ctx?.model;
    let profileId = ctx?.profileId;
    if (!profileId || !agent) {
      const last = lastSessionForConversation(db, conversationId);
      if (!last?.agentId || !last.agentModelId) return 'dropped';
      const p = catalogue.getProfile(last.agentModelId);
      if (!p) return 'dropped';
      agent = last.agentId; model = p.model; profileId = last.agentModelId;
    }

    // Risk #4 — pre-validate before returning 'new_turn' so autoSent:true is honest
    // and a bad client-supplied ctx cannot throw async after the HTTP response.
    const profile = catalogue.getProfile(profileId!);
    if (!profile?.enabled || profile.agentType !== agent) return 'dropped';
    const effectiveMode = effectiveInteractionMode(db, conversationId);
    if (interactionModeRequiresPermissionCapable(effectiveMode) && !agentSupportsPermissionMode(profile.agentType)) {
      return 'dropped';
    }

    // Reap any parked hold-open session before a fresh turn (mirror messageDescendant).
    void this.reapParkedSessions(conversationId).then(() => {
      void this.handlePrompt({
        projectId: conv.projectId,
        conversationId,
        agent: agent!,
        model: model!,
        profileId: profileId!,
        text,
        source: 'user',            // renders as a normal User message (D5)
      });
    });
    return 'new_turn';
  }
}

// Placeholder removed in C4 — index.ts creates its own SessionManager instance.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const sessionManager = null as any;

/** Settings → markup hint mode for the preamble; undefined = no hint. */
function markupHintFor(db: Database): MarkupHint | undefined {
  const m = getGeneralSettings(db).markupHint ?? 'all';
  return m === 'off' ? undefined : m;
}
