import type { EffortLevel } from './profiles.js';

export type AgentStatus = 'running' | 'idle' | 'waiting' | 'error' | 'done';

export type ChangeKind = 'created' | 'modified' | 'deleted';

export type Sender = 'user' | 'agent' | 'system';

export interface BaseEvent {
  id?: string;
  sessionId: string;
  ts: number;
  seq: number;
  sender?: Sender;
  agentProfileId?: string;
}

export interface SubagentNotifyMeta {
  role?: string;
  /** Absent for deny/expire notifications (no child was ever created). */
  childConversationId?: string;
  /** For parent_message turns: the validated conversation id the reply must
   *  bridge back to (set server-side from the authenticated sender — never
   *  from message content). */
  replyTo?: string;
  /** Per-turn override of edge notifyParent (server-set only). */
  notify?: boolean;
}

export interface PromptEvent extends BaseEvent {
  type: 'prompt';
  payload: {
    text: string;
    attachments?: PromptAttachment[];
    commandName?: string;
    commandArgs?: string;
    /** 'user' (default/absent) = operator-authored prompt. 'subagent_notify'
     *  = silent follow-up turn from a child agent's notifyParent result; UI
     *  suppresses the User card (the ◀ Result spawn marker is the source of
     *  prose) but the prompt is still persisted and fed to the LLM.
     *  'parent_message' = downward message from a validated ancestor. */
    source?: 'user' | 'subagent_notify' | 'parent_message' | 'peer_message';
    /** Present iff source is 'subagent_notify', 'parent_message', or 'peer_message'. */
    subagent?: SubagentNotifyMeta;
    /** Effective (server-clamped) effort level in effect for this turn.
     *  Persisted for the transcript audit pill. Absent for no-effort adapters. */
    effort?: EffortLevel;
    /** True when the turn's process actually ran inside bwrap (effective,
     *  capability-gated). Absent otherwise. Transcript audit pill. */
    sandboxed?: true;
    /** Set when a schedule tick authored this prompt (source stays `'user'`). */
    schedule?: { jobId: string; jobName: string; runId: string };
  };
}

/** Image (or future file) attachment persisted alongside a prompt event.
 *  `base64` is the raw base64 payload (no data URL prefix). */
export interface PromptAttachment {
  base64: string;
  mediaType: string;
  name?: string;
}

export interface SpawnMarker {
  // heartbeat is no longer emitted; kept so old transcript rows parse and the UI can hide them
  kind: 'spawned' | 'result' | 'heartbeat' | 'stalled' | 'denied' | 'expired' | 'message' | 'stopped' | 'handover';
  childConversationId: string;  // ponytail: '' for denied/expired (no child created), keeps web grouping compat
  childTitle?: string;
  text: string;
  role?: string;
  workdir?: string;
  /** Wall-clock ms from spawn_edges.created_at to resolve/stall. Absent on non-terminal markers. */
  durationMs?: number;
}

/** File an agent sent (Grok Bot today). Bytes live on disk under
 *  <dataDir>/attachments/<conversationId>/; never base64 in the event. */
export interface MessageFile {
  name: string;          // display name from the Bot (untrusted, display + download name only)
  mediaType: string;     // guessed from the extension
  size?: number;
  path?: string;         // absolute shard path, present iff status === 'ok'
  status: 'ok' | 'too_large' | 'unavailable';
}

/** Text stand-in so notifications, exports, handoff priming and prose bridging
 *  still mention the file. The UI hides a chunk that equals this exactly. */
export const fileFallbackText = (files: { name: string }[]) =>
  files.map((f) => `📎 ${f.name}`).join('\n');

export interface MessageEvent extends BaseEvent {
  type: 'message';
  payload: {
    chunk: string;
    final?: boolean;
    spawnMarker?: SpawnMarker;
    /** Set when this output came from a native subagent (Claude Code
     *  `Task` tool). Equals the `Task` tool_call's toolUseId, so the UI can group
     *  subagent output under its launching call. Undefined = top-level agent. */
    parentToolUseId?: string;
    /** Bot-sent files (Grok Bot). Bytes are on disk, not in this payload. */
    files?: MessageFile[];
    /** Memory ids pushed ahead of this turn (chip). */
    recalledMemories?: string[];
  };
}

export interface ToolCallEvent extends BaseEvent {
  type: 'tool_call';
  payload: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
    /** See MessageEvent.parentToolUseId — set for tool calls a native subagent makes. */
    parentToolUseId?: string;
  };
}

export interface ToolResultEvent extends BaseEvent {
  type: 'tool_result';
  payload: {
    toolUseId: string;
    content: string;
    isError?: boolean;
    /** See MessageEvent.parentToolUseId — set for tool results inside a native subagent. */
    parentToolUseId?: string;
  };
}

export interface FileChangeEvent extends BaseEvent {
  type: 'file_change';
  payload: {
    path: string;
    kind: ChangeKind;
    additions?: number;
    deletions?: number;
    /** Links back to the tool_call event that produced this file change. */
    toolUseId?: string;
    /** Unified diff or patch text when available directly on the file change. */
    diff?: string;
  };
}

export interface StatusEvent extends BaseEvent {
  type: 'status';
  payload: {
    status: AgentStatus;
    /** Terminal-turn cause. `operator_interrupt` is operator stop / force
     *  interrupt — spawn watchers must not treat that `done` as the child's
     *  result. `turn_limit` / `budget_exceeded` come from adapter stop
     *  reasons (e.g. agy `TURN_LIMIT` / `BUDGET_EXCEEDED`). */
    cause?: 'operator_interrupt' | 'turn_limit' | 'budget_exceeded';
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    contextWindowPct?: number;
    fiveHourPct?: number;
    fiveHourResetsAt?: number;
    sevenDayPct?: number;
    sevenDayResetsAt?: number;
    /** True when input/output counts were tokenizer-estimated, not CLI-reported. */
    tokensEstimated?: boolean;
  };
}

export interface ErrorEvent extends BaseEvent {
  type: 'error';
  payload: {
    message: string;
    detail?: string;
  };
}

export interface SteerEvent extends BaseEvent {
  type: 'steer';
  payload: {
    text: string;
    attachments?: PromptAttachment[];
  };
}

export type InteractionKind = 'permission' | 'question';

export interface InteractionChoice {
  id: string;
  label: string;
  description?: string;
}

/** A single question inside an AskUserQuestion tool call. claude-code
 *  accepts N questions per call; the operator's answer map must cover every
 *  questionText or the agent tool_result will be missing entries. */
export interface InteractionQuestion {
  /** Stable identifier used by the UI to track per-question state. Adapters
   *  derive it from the question text (the contract keys the answer map on
   *  the literal question string). */
  id: string;
  /** The question text verbatim — used as the key in the answers map written
   *  back to the CLI. */
  prompt: string;
  /** Optional short header shown above the question. */
  header?: string;
  choices: InteractionChoice[];
  multiSelect?: boolean;
  allowFreeText?: boolean;
}

export interface InteractionRequestEvent extends BaseEvent {
  type: 'interaction_request';
  payload: {
    requestId: string;
    kind: InteractionKind;
    /** For permission-kind: the prompt shown above Allow/Deny. For question-kind
     *  with a single question: same as questions[0].prompt. For question-kind
     *  with multiple questions: a brief umbrella label (or empty). */
    prompt: string;
    /** For permission-kind: Allow/Deny (or Approve/Keep planning for ExitPlanMode).
     *  For question-kind with a single question: same as questions[0].choices. */
    choices: InteractionChoice[];
    multiSelect?: boolean;
    /** Present for question-kind requests with one or more AskUserQuestion
     *  entries. Permission-kind requests leave this undefined. */
    questions?: InteractionQuestion[];
    toolName?: string;
    toolInput?: Record<string, unknown>;
    allowFreeText?: boolean;
  };
}

export interface InteractionResolvedEvent extends BaseEvent {
  type: 'interaction_resolved';
  payload: {
    requestId: string;
    selection: string[];
    text?: string;
    resolution: 'answered' | 'auto' | 'expired';
  };
}

export type HelperStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface HelperEvent extends BaseEvent {
  type: 'helper';
  /** Full current state of ONE helper (snapshot, not a patch). The newest event per taskId wins. */
  payload: {
    taskId: string;
    /** The launching Agent/Task tool_call's toolUseId (joins to the transcript). */
    toolUseId?: string;
    /** task_id of the helper that launched this one (nested helpers). */
    parentTaskId?: string;
    /** subagent_type ("Explore", "general-purpose"), else 'helper'. */
    label: string;
    description: string;
    status: HelperStatus;
    /** Adapter wall clock (ms) at task_started / first sighting. */
    startedAt: number;
    background?: boolean;
    usage?: { totalTokens: number; toolUses: number; durationMs: number };
    lastToolName?: string;
    /** task_progress summary while running; task_notification summary once ended. */
    summary?: string;
  };
}

export type NormalisedEvent =
  | PromptEvent
  | MessageEvent
  | ToolCallEvent
  | ToolResultEvent
  | FileChangeEvent
  | StatusEvent
  | ErrorEvent
  | SteerEvent
  | InteractionRequestEvent
  | InteractionResolvedEvent
  | HelperEvent;

export type NormalisedEventType = NormalisedEvent['type'];
