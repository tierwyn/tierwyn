import type { NormalisedEvent } from './events.js';
import type { EventEmitter } from 'events';
import type { EffortLevel } from './profiles.js';
import type { PromptOptions } from './promptOptions.js';
import type { McpControlAction, McpLiveStatus, ResolvedMcpServer } from './mcp.js';

export interface SessionConfig {
  sessionId: string;
  conversationId: string;
  cwd: string;
  model: string;
  nativeSessionId?: string;
  getNextSteer?: (signal?: AbortSignal) => Promise<{ text: string; attachments?: Attachment[] } | null>;
  /** When true, the adapter must not use tools — used by the compaction summariser
   *  so it cannot explore the filesystem instead of the inline transcript. */
  textOnly?: boolean;
  /** Reasoning effort level for adapters whose CLI exposes one. Session-scoped
   *  for long-lived transports (claude SDK, codex); per-turn for
   *  spawn-per-turn adapters (claude fallback, antigravity). */
  effort?: EffortLevel;
  /** Sanitised per-turn options for flags that bind at spawn (grok --sandbox, qwen -s).
   *  Turn-scoped options still arrive via sendPrompt; this is only for argv bound
   *  before the first prompt. */
  options?: PromptOptions;
  /** Tierwyn registry MCP servers for the main session (additive to the agent's own config).
   *  Server-internal: carries secret values in memory. Never set for one-shot/textOnly paths. */
  mcpServers?: ResolvedMcpServer[];
  /** When true, ignore native CLI MCP configs (e.g. --strict-mcp-config for claude-code). */
  disableNativeMcp?: boolean;
  /** Specific native CLI MCP server names to disable. */
  disabledNativeMcp?: string[];
  /** Whether the workspace configuration (e.g. repo .claude, .cursor, opencode plugins) is trusted. */
  trustRepoConfig?: boolean;
}

export interface Attachment {
  mediaType: string;   // e.g. "image/jpeg"
  base64: string;      // base64-encoded file data
  tempPath?: string;   // absolute path to temp file (set by image helper)
  name?: string;       // original filename (Grok Bot composer staging)
}

/**
 * A model an adapter can drive. Required fields are name+label (per Phase 3 contract);
 * optional fields let discovery seed the catalogue richly. `name` is the value passed back
 * as SessionConfig.model / sendPrompt(model) — for multi-provider agents encode it as
 * "provider/modelId" (e.g. "ollama/qwen2.5-coder").
 *
 * This is the lighter runtime shape adapters report from discovery; the catalogue layer maps
 * it into the stored AgentProfile (see packages/shared/src/profiles.ts).
 */
export interface ModelDescriptor {
  name: string;
  label: string;
  provider?: string;
  vision?: boolean;
  /** Mirrors AgentProfile.steer — true when the model supports mid-run steering/interruption. */
  steer?: boolean;
  contextWindow?: number;
}

/** Provenance hint for UI grouping — distinct from DB `source` lifecycle column. */
export type CommandSourceDetail = 'skill' | 'plugin' | 'builtin' | 'command-template';

/** A slash command or skill an adapter exposes. Lighter runtime shape for discovery. */
export interface CommandDescriptor {
  name: string;
  label: string;
  description?: string;
  sourceDetail?: CommandSourceDetail;
}

/** Modes an adapter's oneShot can guarantee. Absent oneShotModes ⇒ ['none']. */
export type OneShotMode = 'none' | 'read_only';

export interface OneShotOpts {
  systemPrompt?: string;
  cwd?: string;
  /** Caller-side kill switch. Adapters default to 60 if omitted. */
  timeoutSecs?: number;
  /**
   * @deprecated legacy kill switch. `true` still throws in every adapter.
   * Prefer `mode` — sidecar dispatches via OneShotMode, not this flag.
   */
  allowTools?: boolean;
  /** Default 'none'. Adapters MUST throw for a mode they do not advertise. */
  mode?: OneShotMode;
  model?: string;
  env?: Record<string, string>;
  trustRepoConfig?: boolean;
}

export interface OneShotResult {
  text: string;
  raw?: unknown;
}

export interface AgentAdapter {
  start(config: SessionConfig): Promise<void>;
  sendPrompt(text: string, attachments?: Attachment[], model?: string, effort?: EffortLevel, options?: PromptOptions): Promise<void>;
  streamEvents(): EventEmitter;  // emits 'event' with NormalisedEvent, 'error' with Error, 'end'
  stop(): Promise<void>;
  listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]>;
  loadSession(id: string): Promise<void>;
  /** Optional: report whether the agent's own native session state still exists. */
  isNativeSessionAvailable?(nativeSessionId: string): Promise<boolean>;
  /** Optional: fork this adapter's native session file to keep only the first
   *  `toTurn` user turns, returning the new native session id. */
  rewindNativeSession?(nativeSessionId: string, toTurn: number): Promise<string>;
  /** Optional: fork this adapter's native session file to remove exactly the
   *  Nth user turn (1-indexed, matching isRealUserPrompt counting) and rewire
   *  the parentUuid chain so the result is resumable. Returns the new native
   *  session id; the original file is left on disk.
   *
   *  Implementations MUST reject (throw) when the file has only one turn —
   *  excising the only turn would empty the session; the route maps that to
   *  a 400/409 with "delete the whole conversation instead" messaging.
   *  Absence on an adapter (hermes, opencode) is the safety mechanism — route
   *  callers invoke via optional-call (`?.`) so unsupported = graceful skip. */
  exciseNativeTurn?(nativeSessionId: string, turnToRemove: number): Promise<string>;
  /** Optional: delete this adapter's native session file entirely (whole-conversation
   *  delete). Best-effort: implementations swallow ENOENT. MUST be a no-op / absent
   *  for adapters whose native state is a shared DB (hermes, opencode) — never unlink
   *  a shared file. Route callers invoke via optional-call (`?.`) so absence is the
   *  graceful-skip safety mechanism. */
  deleteNativeSession?(nativeSessionId: string): Promise<void>;
  /** Report every model the agent currently exposes. Used to refresh the catalogue. */
  listModels(): Promise<ModelDescriptor[]>;
  /** Optional tokenizer calibration. When absent, callers fall back to cl100k_base.
   *  Must return synchronously (pure CPU, no I/O) — do NOT return a Promise. */
  estimateTokenCount?(text: string): number;
  /** Optional: enumerate filesystem skills/commands for catalogue discovery. */
  listCommands?(): Promise<CommandDescriptor[]>;
  /** Optional: mid-turn context-window fill from the adapter's last assistant-step
   *  occupancy. GET /usage calls this while a session is still running so the
   *  panel can tick context % during long tool loops without waiting for turn end. */
  getLiveContextWindowUsage?(): { contextWindowPct?: number; contextWindowSize?: number };
  /** Optional (Phase 2): invoke a named command non-interactively when the CLI supports it. */
  runCommand?(name: string, args?: string, options?: PromptOptions): Promise<void>;
  /** Optional: inject a user message into the live, in-flight turn. Implemented
   *  only by adapters with a long-lived transport. Presence of this method AND
   *  AgentProfile.steer === true gate native injection; otherwise the message is
   *  routed to the server-side steer queue. */
  steer?(text: string, attachments?: Attachment[]): Promise<void>;
  /** Optional: soft-end the live prompt without tearing down the session.
   *  Used when a sourced steer (subagent_notify / parent_message) is queued
   *  mid-turn and the adapter cannot inject concurrently — cancel the current
   *  prompt so the post-turn steer loop can drain the queue. Must NOT kill the
   *  subprocess or emit EventEmitter 'end' (that would wipe the SessionRecord). */
  interruptTurn?(): void;
  /** Live MCP status of the running session (claude-code only in phase 1). Throws `no_live_query`. */
  mcpStatus?(): Promise<McpLiveStatus[]>;
  /** Session-scoped MCP toggle/reconnect, not persisted. Throws `no_live_query`. */
  mcpControl?(name: string, action: McpControlAction): Promise<void>;
  /** Resolve a pending interaction_request the adapter previously emitted.
   *  Implemented only by adapters with a live bidirectional transport.
   *
   *  For permission-kind and single-question requests: `selection` and `text`
   *  carry the operator's choice. For multi-question AskUserQuestion requests,
   *  `answers` carries one entry per question (in the order they appeared on
   *  the request); adapters zip it with the parked question texts to build
   *  the agent-tool-specific answer map. */
  respondToInteraction?(
    requestId: string,
    response: { selection: string[]; text?: string; answers?: { selection: string[]; text?: string }[] },
  ): void;
  /** Live interaction-mode switch (WP-2.1). Updates the adapter's baseline
   *  mode and applies it to the live transport where supported (claude SDK
   *  setPermissionMode, ACP session/set_mode). Must not throw when the
   *  transport cannot take it live; the session manager reaps parked sessions
   *  and the parked-adoption guard prevents stale-mode reuse. */
  setPermissionMode?(mode: 'bypass' | 'questions' | 'prompt'): Promise<void>;
  /** WP-2.4: switch the model of a LIVE session in place (claude-code SDK
   *  Query.setModel). Rejects when the live query cannot switch; the caller
   *  then falls back to stop + native-resume respawn. */
  setModelLive?(model: string): Promise<void>;
  /** WP-2.4: replace the injected MCP server set of a LIVE session in place
   *  (claude-code SDK Query.setMcpServers). Resolves false when the new set
   *  cannot be applied live (e.g. it needs secret env values that are not in
   *  the already-spawned child env) — caller keeps next-turn semantics. */
  setMcpServersLive?(servers: ResolvedMcpServer[]): Promise<boolean>;
  /** Stop one native helper (Claude Code stopTask). */
  stopHelper?(taskId: string): Promise<void>;
  /**
   * Ephemeral prompt → answer. MUST NOT touch Tierwyn state (no conversations,
   * events, WS, sessionManager). When `allowTools` is false/omitted, MUST
   * disable all tools or throw. Honour `timeoutSecs` by aborting/killing.
   * Honour `mode` — throw for a mode not listed in `oneShotModes`.
   */
  oneShot?(prompt: string, opts?: OneShotOpts): Promise<OneShotResult>;
  /** Modes this adapter can guarantee. Absent ⇒ ['none']. */
  readonly oneShotModes?: readonly OneShotMode[];
}
