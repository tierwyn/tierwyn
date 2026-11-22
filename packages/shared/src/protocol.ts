import type { AgentProfile, EffortLevel, EffortPreference } from './profiles.js';
import type { PromptOptions } from './promptOptions.js';
import type { NormalisedEvent, AgentStatus, PromptAttachment } from './events.js';
import type { ModelDescriptor, CommandDescriptor, CommandSourceDetail } from './adapter.js';
import type { Project, Conversation, TranscriptEvent, SessionMeta, CompactionSettings, ResumePlan, ConversationUsage, Workdir, Checkpoint, RunStatus, PublicNotificationSettings, ConversationKind, GrokBotLifecycleStatus, HandoffOverride, InteractionMode, PendingHandoffMode } from './domain.js';
import type { SandboxPath, SandboxSetting } from './sandbox.js';
import type { AgentSearchScopeSetting } from './search.js';
import type { GlobalTaskDto, GlobalTaskCounts } from './globalTasks.js';
import type { BtwQuery, BtwStatus } from './btw.js';
import type { RemoteHostLoginState, RemoteHostView } from './node.js';
import type { MemoryCounts } from './memory.js';

// ── WS client → server ───────────────────────────────────────────────
export interface PromptMessage {
  type: 'prompt';
  projectId: string;
  conversationId: string;
  agent: string;
  model: string;
  profileId: string;
  text: string;
  attachments?: { mediaType: string; base64: string; name?: string }[];
  /** One-shot resume-plan override, honoured directly regardless of the global
   *  handoffMode: skips native resume; 'fresh' resets context. */
  handoffOverride?: HandoffOverride;
  /** Effective (client-clamped) reasoning effort for this turn. Omitted for
   *  adapters with no effort knob. */
  effort?: EffortLevel;
  /** One-shot per-turn adapter options (agy --mode/--sandbox/…). Client-sanitised;
   *  the server re-sanitises. Absent ⇒ no options, i.e. today's behaviour exactly.
   *  NOT persisted and NOT carried into any later turn. */
  options?: PromptOptions;
}

export interface SubscribeMessage {
  type: 'subscribe';
  conversationId: string;
}

export interface StopMessage {
  type: 'stop';
  sessionId: string;
}

export interface SteerMessage {
  type: 'steer';
  conversationId: string;
  sessionId: string;
  text: string;
  attachments?: { mediaType: string; base64: string; name?: string }[];
  /** Operator intent for a running-turn send:
   *   - 'auto'  (default / omitted): inject if live-inject-capable else queue —
   *     the pre-Force-Steer behaviour, unchanged.
   *   - 'queue': force the deferred-follow-up path even if injectable.
   *   - 'force': soft-interrupt the live turn, then deliver as the next turn. */
  intent?: 'auto' | 'queue' | 'force';
  /** When set, drain re-dispatches via handleCommand (structured slash) instead
   *  of handlePrompt with plain text. `text` remains the display form (`/name args`). */
  commandName?: string;
  commandArgs?: string;
  /** Only honoured with intent 'queue': drain re-dispatches this item as a new
   *  turn with this resume override (e.g. 'fresh' = clean session). */
  handoffOverride?: HandoffOverride;
}

export interface CommandMessage {
  type: 'command';
  projectId: string;
  conversationId: string;
  agent: string;
  model: string;
  profileId: string;
  name: string;
  args?: string;
  attachments?: { mediaType: string; base64: string; name?: string }[];
  handoffOverride?: HandoffOverride;
  /** Effective (client-clamped) reasoning effort for this turn. Omitted for
   *  adapters with no effort knobs. */
  effort?: EffortLevel;
  /** One-shot per-turn adapter options. Absent ⇒ no options. */
  options?: PromptOptions;
}

export interface CancelSteerMessage {
  type: 'cancel_steer';
  conversationId: string;
  sessionId: string;
  messageId: string;
}

export interface EditSteerMessage {
  type: 'edit_steer';
  conversationId: string;
  sessionId: string;
  messageId: string;
  text: string;
  attachments?: { mediaType: string; base64: string; name?: string }[];
  /** Re-parsed from the edited text; omit to clear structured slash fields. */
  commandName?: string;
  commandArgs?: string;
}

export interface InteractionResponseMessage {
  type: 'interaction_response';
  conversationId: string;
  sessionId: string;
  requestId: string;
  /** For permission-kind and single-question requests: the operator's
   *  selected choice ids. For multi-question requests: empty — use answers. */
  selection: string[];
  text?: string;
  /** For multi-question AskUserQuestion requests: one entry per question,
   *  in the order questions appeared on the request. Adapters zip this with
   *  the request's question texts to build the {questionText: answer} map
   *  the CLI expects. */
  answers?: { selection: string[]; text?: string }[];
}

/** Client → server latency probe. Answered immediately with a `pong` carrying
 *  the same `id` and the echoed `clientTs`; RTT is measured entirely on the
 *  client clock so server/client skew cannot distort it. On-demand only —
 *  nothing in Tierwyn sends this on a timer. */
export interface PingMessage {
  type: 'ping';
  /** Correlation id chosen by the client; echoed verbatim in the pong. */
  id: string;
  /** Client `Date.now()` at send time; echoed verbatim in the pong. */
  clientTs: number;
}

/** Operator-only: stop one native CLI helper (Claude Code stopTask). */
export interface StopHelperMessage {
  type: 'stop_helper';
  conversationId: string;
  taskId: string;
}

export type ClientFrame = PromptMessage | CommandMessage | SubscribeMessage | StopMessage
  | SteerMessage | CancelSteerMessage | EditSteerMessage | InteractionResponseMessage | PingMessage
  | StopHelperMessage;

// ── WS server → client ───────────────────────────────────────────────
export interface EventFrame {
  type: 'event';
  conversationId: string;
  event: NormalisedEvent;
}

export interface HeartbeatFrame {
  type: 'heartbeat';
  ts: number;
  connected: boolean;
}

/** Server → client answer to `PingMessage`. Sent only in reply — never pushed. */
export interface PongFrame {
  type: 'pong';
  id: string;
  /** Verbatim echo of the ping's `clientTs`. */
  clientTs: number;
  /** Server `Date.now()` when the pong was written (diagnostic only). */
  serverTs: number;
}

export interface SessionStartedFrame {
  type: 'session_started';
  conversationId: string;
  sessionId: string;
  profileId: string;
  model: string;
}

export interface SessionEndedFrame {
  type: 'session_ended';
  conversationId: string;
  sessionId: string;
  /** Operator Interrupt & Send / hard-stop force: spawn watchers hold
   *  instead of resolving this as the child's result. */
  cause?: 'operator_interrupt';
}

/** Sent once on WS connect so clients hydrate sidebar dots for in-flight
 *  sessions without waiting for a new session_started frame. */
export interface ActiveSessionsFrame {
  type: 'active_sessions';
  sessions: Array<{
    conversationId: string;
    sessionId: string;
    profileId: string;
    model: string;
    /** running | waiting | error — omitted only when the session should not
     *  tint the dot (should not happen for entries in this list). A parked
     *  session with running helpers carries its terminal status. */
    status: AgentStatus;
    /** Native CLI helpers still running in this session. Absent = none / unknown. */
    helpersRunning?: number;
  }>;
}

export interface ConversationUpdatedFrame {
  type: 'conversation_updated';
  conversationId: string;
  ts: number;
  /** Present when this update was triggered by a status event. Absent on
   *  non-status broadcasts (message chunks, tool calls) — clients retain the
   *  last known status. */
  status?: AgentStatus;
  /** Present ONLY on metadata-change broadcasts (rename / description / tags / designation).
   *  Absent = unchanged; clients must not clear a cached value on absence. */
  title?: string;
  description?: string;
  /** FW-15: present when tags were written. `[]` means cleared, not "omit". */
  tags?: string[];
  /** Present when designation was written. `null` means cleared. */
  designation?: string | null;
  /** Present on archive/unarchive broadcasts. Absent = unchanged. */
  archived?: boolean;
  /** Jev interrupt verdict. Present ONLY on terminal (`done`) frames where the filter ran.
   *  false = do not toast. true / absent = today's behaviour. Absence never clears anything. */
  interruptWorthy?: boolean;
  /** Present when the staged next-send action changed. `null` = cleared. */
  pendingHandoffMode?: PendingHandoffMode | null;
  /** Present when conversation sandbox setting changed. `null` = inherit (cleared). */
  sandbox?: SandboxSetting | null;
  /** Present only on helper-driven frames and session end; absence = unchanged. */
  helpersRunning?: number;
  /** True when composer-scoped settings changed (permissionMode, MCP selection,
   *  template, capability profile). Other devices refetch the conversation. */
  settingsChanged?: true;
}

/** Operator-global: pending timers changed (create / edit / cancel / fire) for
 *  these conversations. Ids only; clients refetch the chip row / Timed tab. */
export interface TimersChangedFrame {
  type: 'timers_changed';
  conversationIds: string[];
}

/** Operator-global: conversation rows were created, deleted or moved. Clients
 *  re-list the sidebar. Carries ids only, never row bodies: the list endpoints
 *  own filtering (archived view, schedule-run hiding, visibleOnProjectsTab). */
export interface ConversationsChangedFrame {
  type: 'conversations_changed';
  /** Every project whose list changed (both ends of a move). */
  projectIds: string[];
  createdIds?: string[];
  /** Root + all cascaded descendants. */
  deletedIds?: string[];
}

/** Reply to a `stop` client frame. Sent only to the requesting client. The
 *  side-effect of a successful stop (session_ended) is broadcast separately
 *  via SessionEndedFrame to all clients. */
export interface StopResultFrame {
  type: 'stop_result';
  sessionId: string;
  success: boolean;
  /** Machine-readable reason. `aborted_pre_start` = the session was registered
   *  but the adapter had not yet been spawned when stop arrived; the run was
   *  cancelled without ever invoking the adapter. */
  reason?: 'not_found' | 'already_ended' | 'aborted_pre_start' | 'error';
  message?: string;
}

/** How a steer message was handled. `injected` = folded into the live turn;
 *  `queued` = held for delivery as a follow-up turn; `force_steered` =
 *  soft-interrupt issued (queued force item drains on cancel); `not_found` =
 *  no live session; `ending` = the turn is already stopping; `error` = inject threw. */
export type SteerMode = 'injected' | 'queued' | 'force_steered' | 'not_found' | 'ending' | 'error';

/** Reply to a `steer` client frame. Sent only to the requesting client. */
export interface SteerResultFrame {
  type: 'steer_result';
  sessionId: string;
  mode: SteerMode;
  queueLength: number;
  message?: string;
}

/** Broadcast to a conversation's subscribers when a steer message is queued,
 *  so every connected client can mirror the pending-queue indicator. */
export interface SteerQueuedFrame {
  type: 'steer_queued';
  conversationId: string;
  sessionId: string;
  queueLength: number;
  text: string;
}

export interface QueuedMessage {
  id: string;
  type: 'steer' | 'queue';
  text: string;
  ts: number;
  attachments?: { base64: string; mediaType: string; name?: string }[];
  /** When set on a 'queue' item: the follow-up drain (adapter 'end' handler)
   *  threads these through handlePrompt so the persisted prompt carries the
   *  same metadata. See PromptEvent.payload.source.
   *  `force` marks an Interrupt & Send item (soft-cancel then next-turn delivery). */
  source?: 'user' | 'subagent_notify' | 'parent_message' | 'peer_message' | 'force';
  subagent?: import('./events.js').SubagentNotifyMeta;
  /** Structured slash command for drain via handleCommand (not plain handlePrompt). */
  commandName?: string;
  commandArgs?: string;
  /** Only honoured with intent 'queue': drain re-dispatches this item as a new
   *  turn with this resume override (e.g. 'fresh' = clean session). */
  handoffOverride?: HandoffOverride;
  /** Adapter-only prefix (hold-open rules update). Persisted prompt uses `text`. */
  adapterPrefix?: string;
  /** Opt-in: run keyword recall when this item is delivered. */
  recall?: boolean;
}

export interface SteerQueueFrame {
  type: 'steer_queue';
  conversationId: string;
  queue: QueuedMessage[];
}

export interface InteractionResultFrame {
  type: 'interaction_result';
  sessionId: string;
  requestId: string;
  accepted: boolean;
  reason?: 'not_found' | 'already_resolved' | 'unsupported' | 'error';
  message?: string;
}

/** Broadcast to the parent conversation's subscribers when a /btw answer completes
 *  or errors. Carries no answer text — client refetches the btw list on receipt. */
export interface BtwUpdatedFrame {
  type: 'btw_updated';
  /** Parent conversation id — used to scope delivery to the right subscribers. */
  conversationId: string;
  btwId: string;
  status: BtwStatus;
}

/** Broadcast to a parent conversation's subscribers when a spawn request is
 *  created (pending) or decided (approved/denied/expired). Carries no payload —
 *  client refetches GET /spawn/requests on receipt. Mirrors BtwUpdatedFrame. */
export interface SpawnRequestUpdatedFrame {
  type: 'spawn_request_updated';
  /** Parent conversation id — scopes delivery to the right subscribers. */
  conversationId: string;
}

/** Broadcast after checkpoint create/delete or rewind. Client refetches checkpoints. */
export interface CheckpointsUpdatedFrame {
  type: 'checkpoints_updated';
  conversationId: string;
}

/** Server-owned composer lock state for one conversation's draft. */
export type DraftProcessing = 'idle' | 'enhancing' | 'transcribing';

/** Broadcast after a draft PUT or DELETE. Carries the new text so other devices
 *  patch without a refetch (mirrors checkpoints_updated but payload-carrying —
 *  the text is small and we want zero-RTT cross-device sync).
 *  `processing` is the server-authoritative composer lock — clients freeze the
 *  input when it is not `'idle'`. // ponytail: no progress/percentage in the
 *  freeze frame; add a progress field only when a job can report one. */
export interface DraftUpdatedFrame {
  type: 'draft_updated';
  conversationId: string;
  /** New draft text; empty string means the draft was cleared/deleted. */
  text: string;
  /** True if the draft has ≥1 attachment. Bytes are NOT carried — a device that
   *  cares refetches GET /draft. Keeps the frame small on mobile links. */
  hasAttachments: boolean;
  /** Server updated_at (epoch ms) — lets a client drop a stale frame. */
  updatedAt: number;
  /** Server-authoritative composer lock. Clients freeze the input when !== 'idle'. */
  processing: DraftProcessing;
  /** epoch ms the current job started; null when idle. */
  processingStartedAt: number | null;
  /** True when a pre-enhance snapshot exists (undo available on any device). */
  canUndo: boolean;
  /** Set only on a failed job so the UI can toast. Not persisted. */
  error?: string;
  /** Persisted draft profile / model selection across devices. */
  profileId?: string | null;
}

/** Broadcast when a worktree's commit draft changes server-side — today only on
 *  background-generation completion or failure. Operator-global (broadcastAll):
 *  a commit draft belongs to a cwd, not to a conversation, so clients filter on
 *  `cwd`. // ponytail: user PUTs do not broadcast — the typing device already
 *  has the text and cross-device commit-box sync is not a use case yet. */
export interface GitCommitDraftUpdatedFrame {
  type: 'git_commit_draft_updated';
  /** Canonical worktree path — matches GitWorkingTreeStatus.cwd. */
  cwd: string;
  /** Current persisted message; unchanged (possibly '') when the job failed. */
  message: string;
  /** Server-authoritative lock state after this transition. */
  generating: boolean;
  /** Set only on a failed generation so the UI can toast. Not persisted. */
  error?: string;
}

/** Broadcast when job/run/step state changes so Sidebar / ScheduleBrowser refresh.
 *  Optional fields let clients patch live run status without a full tree refetch. */
export interface ScheduleUpdatedFrame {
  type: 'schedule_updated';
  projectId: string;
  jobId: string;
  /** Present when the update is about a specific run (dispatch, finalize, reclaim, mid-run agent status). */
  runId?: string;
  /** DB run lifecycle status when known. */
  runStatus?: RunStatus;
  /** Run's conversation id when bound (may be absent for pending/skipped). */
  conversationId?: string;
  /** Live agent status for that conversation when this frame is status-driven mid-run. */
  agentStatus?: AgentStatus;

  /** Job name, so a client can render a notification without having loaded
   *  this project's schedule tree. Set only on notification-worthy broadcasts
   *  (fire / finalize / auto-disable); omitted on mid-run status churn. */
  jobName?: string;

  /** Why this broadcast happened, when the reason is not derivable from
   *  runStatus alone. Absent = a plain state refresh; clients must not
   *  synthesise a notification from an absent value. */
  event?: 'fired' | 'auto_disabled';
  /** Jev interrupt verdict. Present ONLY on terminal `runStatus` frames from finalizeRun where the filter ran.
   *  false = do not toast. true / absent = today's behaviour. Absence never clears anything. */
  interruptWorthy?: boolean;
}

/** Broadcast on Grok Bot supervisor state transitions only (not every probe). */
export interface GrokBotStatusFrame {
  type: 'grokbot_status';
  status: GrokBotLifecycleStatus;
}

/** Broadcast on remote-host connection state transitions only (not every ping). */
export interface RemoteHostStatusFrame {
  type: 'remote_host_status';
  host: RemoteHostView;
}

/** Operator-global: every successful agent or operator write to a global task. */
export interface GlobalTaskUpdatedFrame {
  type: 'global_task_updated';
  taskId: string;
  op: 'upsert' | 'delete';
  task?: GlobalTaskDto;      // present iff op === 'upsert'
  counts: GlobalTaskCounts;  // global counts AFTER this change (ignores projectId filters)
}

/** Broadcast when agent catalogue or models change (discovery, pull, CRUD). */
export interface CatalogueUpdatedFrame {
  type: 'catalogue_updated';
}

/** Operator-global: a memory was saved, superseded, flagged, or reviewed. */
export interface MemoryUpdatedFrame {
  type: 'memory_updated';
  counts: MemoryCounts;
}

export type ServerFrame =
  | EventFrame | HeartbeatFrame | SessionStartedFrame | SessionEndedFrame | ActiveSessionsFrame
  | ConversationUpdatedFrame | StopResultFrame | SteerResultFrame | SteerQueuedFrame | SteerQueueFrame
  | InteractionResultFrame | BtwUpdatedFrame | SpawnRequestUpdatedFrame | CheckpointsUpdatedFrame
  | ScheduleUpdatedFrame | DraftUpdatedFrame | GitCommitDraftUpdatedFrame | PongFrame
  | GrokBotStatusFrame
  | RemoteHostStatusFrame
  | GlobalTaskUpdatedFrame
  | CatalogueUpdatedFrame
  | MemoryUpdatedFrame
  | ConversationsChangedFrame
  | TimersChangedFrame;

/** Return shape for SessionManager.stopSession. Surfaces failure modes so the
 *  WS handler can reply with a StopResultFrame. */
export interface StopSessionResult {
  stopped: boolean;
  reason?: 'not_found' | 'already_ended' | 'aborted_pre_start' | 'error';
  message?: string;
}

/** Return shape for SessionManager.steerSession. */
export interface SteerSessionResult {
  mode: SteerMode;
  queueLength: number;
  message?: string;
}

// ── REST DTOs ────────────────────────────────────────────────────────
export interface ProfilesResponse { profiles: AgentProfile[]; }
export interface ProjectsResponse { projects: Project[]; }
export interface ConversationsResponse { conversations: Conversation[]; }
export interface TranscriptResponse {
  events: TranscriptEvent[];
  /** Present only on paged requests. True when events older than cursor exist. */
  hasMore?: boolean;
  /** "<ts>:<seq>" of the first returned event; pass back as before for the next older page. */
  cursor?: string;
}
export interface ActiveAgentResponse {
  lastSession?: SessionMeta;
  nativeAvailable: boolean;
  contextResumable?: boolean;
  resumePlan?: ResumePlan;
}

/** One in-flight agent session, as surfaced by GET /sessions/active. */
export interface ActiveAgentSessionDto {
  sessionId: string;
  conversationId: string;
  agentType: string;
  profileId: string;
  model: string;
  /** Effective (server-clamped) reasoning effort for the turn that opened this
   *  session. Absent for adapters with no effort knob, for models that bake
   *  effort into the model name, and for internally re-dispatched turns
   *  (queue drain / spawn / schedule tick). */
  effort?: EffortLevel;
  /** Live status. Parked hold-open sessions report 'idle'. */
  status: AgentStatus;
  /** Server epoch ms at session creation. */
  startedAt: number;
}

/** A conversation carrying a live session, or an ancestor of one. */
export interface ActiveAgentConversationDto {
  id: string;
  title: string;
  /** Empty string when the conversation row no longer exists. */
  projectId: string;
  parentConversationId?: string;
  /** Passed through from the conversation row. 'schedule_home' marks a job root
   *  (never holds a session; renders as a ⏱ grouping header). 'chat' or absent = normal chat. */
  kind?: ConversationKind;
  description?: string;
  tags?: string[];
}

/** GET /sessions/active — every in-flight session across every project, plus
 *  enough conversation/project metadata for the client to build the spawn tree
 *  without a global conversations endpoint. */
export interface ActiveSessionsResponse {
  sessions: ActiveAgentSessionDto[];
  /** Session conversations + all their ancestors. */
  conversations: ActiveAgentConversationDto[];
  projects: { id: string; name: string }[];
  /** Server clock at response time — the client derives a skew correction so
   *  runtimes stay right on a device with a drifting clock. */
  now: number;
}
export interface CompactionSettingsResponse { settings: CompactionSettings; }
export interface NotificationSettingsResponse { settings: PublicNotificationSettings; }

/** GET /settings/retention/stats — read-only; no VACUUM, no writes. */
export interface RetentionStats {
  dbSizeBytes: number;
  walSizeBytes: number;
  totalConversations: number;
  eventsCount: number;
  eligibleConversations: number;
  archivedCount: number;
  archiveBytes: number;
  /** True while a nightly or Purge-now drain is in flight or waiting between chunks. */
  purgeRunning: boolean;
}

export interface RetentionPurgeResponse {
  alreadyRunning: boolean;
  deleted: number;
  eventsDeleted: number;
  remaining: number;
  dbSizeBytes: number;
}

/**
 * One `data/archive/<id>.jsonl` file, described from its version-2 header line.
 * No file body is ever sent to the client (FW-11 D1 / D13).
 */
export interface ArchiveEntry {
  /** Conversation id — also the filename stem. */
  id: string;
  title: string;
  /** Project the conversation lived in when it was archived. May no longer exist. */
  projectId: string | null;
  /** Archived parent link. Cleared on restore when the parent is neither live nor restored (D4). */
  parentConversationId: string | null;
  eventCount: number;
  bytes: number;
  /** File mtime, ms epoch. List is sorted by this, newest first. */
  mtime: number;
}

/** GET /settings/retention/archive */
export interface RetentionArchiveListResponse { items: ArchiveEntry[]; }

/** DELETE /settings/retention/archive and DELETE /settings/retention/archive/:id */
export interface RetentionArchiveDeleteResponse { deleted: number; }

/** POST /settings/retention/archive/:id/restore */
export interface RetentionRestoreResponse {
  /** Root first, then descendants in parent-before-child order. */
  restored: { id: string; title: string }[];
  /** Project every restored row landed in. */
  projectId: string;
  eventsRestored: number;
  /** True when the root's archived parent was gone, so it was restored as a root (D4). */
  parentCleared: boolean;
}
export interface ConversationUsageResponse { usage: ConversationUsage; }
export interface CheckpointsResponse { checkpoints: Checkpoint[]; }
export interface GetDraftResponse {
  text: string;
  attachments: PromptAttachment[];
  updatedAt: number | null;
  processing: DraftProcessing;
  processingStartedAt: number | null;
  canUndo: boolean;
  /** Whisper auto-send arm, persisted on the draft so a reload restores it. */
  autoSend: boolean;
  /** Persisted draft profile / model selection across devices. */
  profileId?: string | null;
}
/** Debounced PUT and beacon send `attachments` when they fit (beacon omits when
 *  ≥60 KB to avoid sendBeacon silently dropping the payload). Server semantics:
 *  array (incl. `[]`) = explicit write/clear; `undefined` = preserve existing. */
export interface PutDraftRequest {
  text?: string;
  attachments?: PromptAttachment[];
  profileId?: string;
}
export interface PutDraftResponse {
  text: string;
  attachments: PromptAttachment[];
  updatedAt: number;
  profileId?: string | null;
}
/** 202 response from POST /enhance — the rewrite runs detached on the server. */
export interface EnhanceStartedResponse {
  jobId: string;
  processing: DraftProcessing;
}
/** 409 body returned by draft writes / enhance when a job holds the lock. */
export interface DraftBusyResponse {
  error: 'draft busy';
  processing: DraftProcessing;
}
export interface UndoEnhanceResponse {
  text: string;
  updatedAt: number;
}

export interface RewindConversationRequest {
  eventId: string;
  rewindConversation?: boolean;
  rewindCode?: boolean;
  confirmSharedCode?: boolean;
  createCheckpoint?: boolean;
}

export interface RewindConversationResponse {
  ok: boolean;
  checkpoint?: Checkpoint;
  nativeDrift?: boolean;
  codeApplied?: boolean;
  codeSkippedReason?: 'shared_tree' | 'diverged' | 'no_ref' | 'not_git' | 'remote_host';
}

export interface CreateCheckpointRequest {
  eventId: string;
  label?: string;
  pinned?: boolean;
}

export interface UpdateCheckpointRequest {
  label?: string;
  pinned?: boolean;
}

export interface CreateProjectRequest {
  name: string;
  rootPath: string;
  remoteHostId?: string;
  /** Clone this URL into rootPath (on the host when remoteHostId is set, else on the hub under TIERWYN_PROJECT_ROOTS). */
  cloneUrl?: string;
  /** Create the leaf folder when rootPath is missing (parent must exist inside the allowed roots). Ignored with cloneUrl. */
  createIfMissing?: boolean;
}

/** GET /project-browse/roots response. */
export interface ProjectBrowseRoots {
  roots: string[];          // hub: TIERWYN_PROJECT_ROOTS (default [home]); remote: hello.roots
  canCreate: boolean;       // hub: roots.length > 0; remote: hostHasFeature(hello,'fs.mkdir') && roots.length > 0
  canClone: boolean;        // hub: roots.length > 0; remote: true
  homedir?: string;
  nodeUpdateRequired?: boolean;
}
/** GET /project-browse/list response (directories only). */
export interface ProjectBrowseListing {
  root: string;
  path: string;             // relative to root, '' = root, '/'-separated
  dirs: Array<{ name: string; mtimeMs: number; symlink?: true }>;
  truncated: boolean;
}
/** GET /project-browse/stat response — same shape as /remote-hosts/:id/stat-path. */
export interface ProjectPathStat { exists: boolean; isDir: boolean; isGitRepo: boolean; underRoots: boolean }
export interface ProjectBrowseStat { path: ProjectPathStat; parent: ProjectPathStat }
/** PATCH /projects/:id body. Either field is optional; at least one required.
 *  `remoteHostId` is create-only — the route 400s if the key is present. */
export interface UpdateProjectRequest {
  name?: string;
  rootPath?: string;
  rules?: string | null;
  rulePresetIds?: string[] | null;
  remoteHostId?: string | null;
  trustRepoConfig?: boolean;
  /** Agent sandbox override. null clears to inherit global. */
  sandbox?: SandboxSetting | null;
  /** Extra bwrap binds for this project. null clears. */
  sandboxPaths?: SandboxPath[] | null;
  /** null clears to inherit global. */
  agentSearchScope?: AgentSearchScopeSetting | null;
}

export interface MoveProjectRequest { rootPath: string; dryRun?: boolean }
export interface MoveProjectResponse { project: Project; from: string; to: string; moved: boolean; repairWarning?: string }
export type MoveProjectErrorCode =
  | 'bad_path'
  | 'path_outside_roots'
  | 'not_found'
  | 'not_dir'
  | 'source_symlink'
  | 'source_is_root'
  | 'parent_missing'
  | 'exists'
  | 'into_self'
  | 'same_path'
  | 'cross_device'
  | 'contains_other_project'
  | 'agents_active'
  | 'move_in_progress'
  | 'host_disconnected'
  | 'node_update_required'
  | 'move_failed'
  | 'rollback_failed'
  | 'move_state_unknown'
  | 'system_project';

export interface RulePresetRef {
  id: string;
  name: string;
  available: boolean;
}

export interface ConversationRulesResponse {
  project: { rules: string | null; presets: RulePresetRef[] } | null;
  chain: Array<{
    conversationId: string;
    title: string;
    rules: string | null;
    presets: RulePresetRef[];
  }>;
  hash: string | null;
  omitted: number;
  rendered: string;
}

export interface ProjectRulesResponse {
  rendered: string;
  hash: string | null;
  omitted: number;
}
export interface CreateConversationRequest {
  projectId: string;
  title: string;
  parentConversationId?: string;
  templateName?: string;
  /** Conversation-level delegate workdir pin. Omit/undefined = per-role. */
  spawnWorkdir?: Workdir;
  /** Capability profile id scoping this conversation's plugin capabilities.
   *  Omit/null = the default profile ('all'). Unknown ids are rejected 400. */
  capabilityProfile?: string | null;
  /** Optional designation token. Null/omit = none; unknown tokens are rejected 400. */
  designation?: string | null;
  /** Optional initial tag list; validated with normaliseTags (400 on error). */
  tags?: string[];
}
export interface RenameConversationRequest { title: string; }

/** PATCH /conversations/:id body. Either field is optional; absent fields are
 *  left untouched. `templateName: null` clears the attachment. */
export interface UpdateConversationRequest {
  title?: string;
  templateName?: string | null;
  /** null clears the pin. */
  spawnWorkdir?: Workdir | null;
  /** Retention-purge exemption pin. false unpins. */
  pinned?: boolean;
  /** Soft-archive flag. false unarchives (restores to the sidebar list). */
  archived?: boolean;
  /** null clears the text. Any value marks the description operator-owned. */
  description?: string | null;
  /** FW-10: re-home this conversation (and its whole spawn subtree) into
   *  another project. Root chats only — see the PATCH route's guards. */
  projectId?: string;
  /** Capability profile id. `null` clears back to the default profile ('all').
   *  A change revokes + re-issues live spawn tokens so the new grant is baked
   *  in immediately. Unknown ids are rejected 400. */
  capabilityProfile?: string | null;
  /** FW-15: replaces the whole tag list. `[]` clears. Absent leaves untouched.
   *  Validated server-side by normaliseTags (10 tags × 32 chars). */
  tags?: string[];
  /** Catalogue token for the function chip. `null` clears. Absent leaves untouched. */
  designation?: string | null;
  /** MCP registry ids. `null` = inherit the template default; `[]` = none. Takes
   *  effect from the next turn (parked sessions are reaped). */
  mcpServers?: string[] | null;
  /** When true, ignore native CLI MCP configs for this conversation. */
  disableNativeMcp?: boolean | null;
  /** Specific native CLI MCP server names to disable for this conversation. */
  disabledNativeMcp?: string[] | null;
  /** Sticky per-conversation permission mode (migration 141, WP-2.1).
   *  `null` clears back to inheriting the global CompactionSettings.interactionMode. */
  permissionMode?: InteractionMode | null;
  /** Per-conversation composer effort (migration 156). null clears. */
  effort?: EffortPreference | null;
  sandbox?: SandboxSetting | null;
  /** Operator-staged "+ menu" session action applied on the next send, then cleared.
   *  `null` clears. Absent leaves untouched. */
  pendingHandoffMode?: PendingHandoffMode | null;
  /** Operator-authored instructions. `null` or empty string clears. Absent leaves untouched. */
  rules?: string | null;
  /** Ordered preset stack. `null` or `[]` clears. Absent leaves untouched. */
  rulePresetIds?: string[] | null;
}

// ── Cross-agent spawn DTOs ───────────────────────────────────────────
export interface SpawnRequest {
  parentConversationId: string;
  profileId?: string;     // exactly one of profileId | role required
  role?: string;
  prompt: string;
  wait?: boolean;
  workdir?: 'shared' | 'worktree';
  confirmShared?: boolean;
  notifyParent?: boolean;
  /** Optional catalogue token for the child function chip. */
  designation?: string;
}
export interface SpawnResponse {
  conversationId: string;
  workdir: string;
  /** Set when a requested worktree spawn ran shared instead (remote-host P1). */
  workdirNote?: string;
  result?: string;        // present only when wait:true
  /** True when the child terminated via status:error rather than a natural
   *  done. A parent-authorized POST /spawn/:id/stop force-settles the waiter
   *  with `stopped: true` instead of hanging. */
  errored?: boolean;
  /** True when a wait:true spawn/message was force-settled by a parent stop. */
  stopped?: boolean;
  /** Absolute RESULT.md path for bare-prompt (Grok Bot) children. */
  resultPath?: string;
}

/** Returned when a bearer spawn is queued for operator approval (flag on). */
export interface SpawnPendingResponse { requestId: string; status: 'pending'; }

/** A spawn_requests DB row in camelCase — returned by the list endpoint. */
export interface SpawnRequestRow {
  id: string;
  parentConversationId: string;
  parentSessionId: string;
  role?: string;
  profileId?: string;
  prompt: string;
  workdir?: 'shared' | 'worktree';
  wait: boolean;
  notifyParent: boolean;
  /** Catalogue token queued with the spawn; re-dispatched on approve. */
  designation?: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'dispatched';
  childConversationId?: string;
  createdAt: number;
  decidedAt?: number;
  decidedBy?: string;
  error?: string;
}

export interface SpawnResultResponse {
  conversationId: string;
  parentConversationId: string;
  /** Assembled assistant prose: all message events where sender === agent, joined by \n\n, trimmed. */
  prose: string;
  /** True when prose trims to empty (child ended on a tool_call or terse ack with no closing prose). */
  degenerate: boolean;
  /** Raw event stream for the child conversation (for deeper inspection). */
  events: TranscriptEvent[];
  /** conversations.stopped_at when a parent stop has marked this child. */
  stoppedAt?: number;
}

/** POST /spawn/:childId/stop 200 body. */
export interface SpawnStopResponse {
  ok: true;
  childId: string;
  previousStatus: AgentStatus | 'stopped';
  stopped: 'killed' | 'settled-naturally' | 'already-stopped';
  alreadyStopped: boolean;
  notifyFired: boolean;
  timerCancelled: boolean;
  wrapUpDelivered: boolean;
}

// ── Catalogue / agent-discovery DTOs (Phase 5) ───────────────────────
/** An agent in the catalogue. `installed`/`installHint` are additive discovery
 *  metadata (binary present on PATH), not stored on the row. */
export interface AgentRecord {
  id: string;
  type: string;
  label: string;
  description: string;
  executablePath: string | null;
  envVars: Record<string, string>;
  /** Agent-level master switch (agents.enabled_flag). A disabled agent hides all
   *  its models from /profiles even when the model rows stay enabled. Virtual
   *  (known-but-unstored) agent types report false. */
  enabled: boolean;
  installed?: boolean;
  installHint?: string;
  /** True when the adapter's listModels() returns live data; false when the
   *  operator must configure models manually. Computed at response time —
   *  not stored in the DB. Absent means unknown (treat as true). */
  supportsModelDiscovery?: boolean;
  /** Installed CLI version from `<bin> --version` (version cache, refreshed every 12 h). */
  installedVersion?: string;
  /** Latest published version (npm registry / GitHub releases; 12 h cache). */
  latestVersion?: string;
  /** true when installedVersion < latestVersion (semver-ish compare); absent when unknown. */
  behind?: boolean;
  /** true when AGENT_BINARIES has a scripted install this agent can be upgraded with. */
  upgradeable?: boolean;
  /** true while an upgrade command for this agent is running. */
  upgrading?: boolean;
  /** Outcome of the last finished upgrade/install command for this agent (in-memory; lost on restart). */
  upgradeResult?: { ok: boolean; tail?: string; at: number };
  /** When the version cache for this agent was last probed (ms epoch). */
  versionCheckedAt?: number;
  /** Hub-local login probe (fs + env + agent-env vault). Absent = no probe for this agent. */
  loggedIn?: boolean;
  /** In-flight or failed hub-local interactive login (Settings → Agents). In-memory. */
  login?: RemoteHostLoginState;
}

/** A model row (agent_models) in camelCase for the catalogue UI. */
export interface ModelRecord {
  id: string;
  agentId: string;
  modelName: string;
  label: string;
  provider: string | null;
  vision: boolean;
  steer: boolean;
  enabled: boolean;
  description: string;
  maxConcurrentSpawns?: number;
  maxGrandchildSpawns?: number;
}

/** What POST /agents/install-all targets. */
export type InstallAllMode = 'missing' | 'missing+behind';
/** A target the bulk installer will not touch (live sessions / no scripted install). */
export interface InstallAllSkip { type: string; reason: string; }
export interface AgentsInstallAllResponse { ok: true; started: boolean; targets: string[]; skipped: InstallAllSkip[]; }
/** In-memory bulk-install state surfaced on GET /agents while a batch runs. */
export interface AgentsBatchState { running: boolean; remaining: string[]; }

export interface AgentsResponse {
  agents: AgentRecord[];
  /** Present while a bulk install-all runs (or holds its final queue state). */
  batch?: AgentsBatchState;
  /** true while a forced version refresh is in flight (POST /agents/versions/refresh). */
  versionsRefreshing?: boolean;
  /** Agent types with a bwrap sandbox profile (server SANDBOX_PROFILES keys). */
  supportedSandboxAgents: string[];
  /** Hub-local bwrap usable (namespaced probe). Remote hosts advertise their own via hello.sandbox. */
  sandboxAvailable: boolean;
}
export interface CatalogueResponse {
  agents: AgentRecord[];
  models: ModelRecord[];
  /** Present while a bulk install-all runs (or holds its final queue state). */
  batch?: AgentsBatchState;
  /** true while a forced version refresh is in flight (POST /agents/versions/refresh). */
  versionsRefreshing?: boolean;
  /** Agent types with a bwrap sandbox profile (server SANDBOX_PROFILES keys). */
  supportedSandboxAgents: string[];
  /** Hub-local bwrap usable (namespaced probe). Remote hosts advertise their own via hello.sandbox. */
  sandboxAvailable: boolean;
}
export interface PullModelsResponse { models: ModelDescriptor[]; }
/** POST /agents/versions/refresh — forces a version re-probe for every agent. */
export interface VersionsRefreshResponse { ok: true; started: boolean; }

/** A command row (agent_commands) in camelCase for the catalogue UI. */
export interface CommandRecord {
  id: string;
  agentId: string;
  name: string;
  label: string;
  description: string;
  source: 'seed' | 'discovered' | 'user';
  sourceDetail?: CommandSourceDetail | null;
  enabled: boolean;
}

export interface CommandsResponse {
  commands: CommandRecord[];
  /** Remote-host project: the host could not be queried; file-backed skills are omitted. */
  hostOffline?: boolean;
}
export interface PullCommandsResponse { commands: CommandDescriptor[]; }

/** Create a catalogue agent. `type` must match a registered adapter; `id` defaults to `type`. */
export interface CreateAgentRequest {
  type: string;
  id?: string;
  label: string;
  description?: string;
  executablePath?: string | null;
  envVars?: Record<string, string>;
}
export interface UpdateAgentRequest {
  label?: string;
  description?: string;
  executablePath?: string | null;
  envVars?: Record<string, string>;
  /** true is rejected with 400 when the binary is not installed. */
  enabled?: boolean;
}

/** POST /agents/:id/upgrade — starts the fixed AGENT_BINARIES install command in the background. */
export interface UpgradeAgentResponse { ok: true; started: boolean; }

export interface CreateModelRequest {
  modelName: string;
  label: string;
  provider?: string | null;
  vision?: boolean;
  steer?: boolean;
  enabled?: boolean;
  description?: string;
  maxConcurrentSpawns?: number;
  maxGrandchildSpawns?: number;
}
export interface UpdateModelRequest {
  modelName?: string;
  label?: string;
  provider?: string | null;
  vision?: boolean;
  steer?: boolean;
  enabled?: boolean;
  description?: string;
  maxConcurrentSpawns?: number;
  maxGrandchildSpawns?: number;
}

/** Create a user-authored slash command for an agent (source='user'). */
export interface CreateCommandRequest {
  name: string;
  label?: string;
  description?: string;
  enabled?: boolean;
}
export interface UpdateCommandRequest {
  name?: string;
  label?: string;
  description?: string;
  enabled?: boolean;
}
export interface CommandResponse { command: CommandRecord; }

// ── /btw side-question DTOs ──────────────────────────────────────────
export interface BtwAskResponse { id: string; }
export interface BtwForkResponse { conversation: Conversation; }
export interface BtwListResponse { queries: BtwQuery[]; }

// ── Auth DTOs ────────────────────────────────────────────────────────
export interface LoginRequest { password: string; }
export interface LoginResponse { ok: true; }
/**
 * `authenticated` — caller has a valid session cookie (or auth is disabled).
 * `configured` — the server has the operator secrets set; when false the login
 * cannot succeed and the UI should prompt the operator to configure `.env`.
 */
export interface SessionResponse { authenticated: boolean; configured: boolean; }
