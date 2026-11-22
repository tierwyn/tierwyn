/**
 * GrokBuildAdapter — drives xAI's Grok Build CLI via `grok agent stdio` (ACP,
 * JSON-RPC 2.0 over stdio). Long-lived subprocess per Tierwyn session, with
 * mid-turn steering (follow-up session/prompt on the same native session) and
 * a structured permission round-trip via `session/request_permission`.
 *
 * Architecture (mirrors Hermes — the SAME ACP; cross-checked against Phase 0
 * captures in docs/grok-build/samples/):
 *  - One `grok agent stdio` subprocess per Tierwyn session.
 *  - initialize → session/new (or session/load when resuming) → session/set_model.
 *  - Each prompt = one `session/prompt` request; resolve on its response (stopReason).
 *  - Between turns: long-running steer loop polls getNextSteer(); a non-null
 *    steer is delivered as a follow-up session/prompt on the SAME native session.
 *    Grok 1.0.5 accepts a concurrent session/prompt: it is enqueued
 *    (`_x.ai/queue/changed`) and drained at the turn boundary, and both requests
 *    resolve independently with their own stopReason and `_meta.usage`. It is
 *    NOT mid-turn injection — the second prompt runs as its own turn after the
 *    first finishes. True mid-turn steering is the TUI's
 *    `[ui].follow_up_behavior = "steer"`, which GROK_CONFIG cannot reach (the
 *    overlay allowlist excludes `[ui]`). grok-build therefore stays in
 *    SOFT_CANCEL_ADAPTERS.
 *  - session/cancel interrupts the live turn (used by stop()).
 *
 * CRITICAL — `'end'` semantics (subprocess-adapter footgun, see project memory
 * `feedback_subprocess_adapter_end_event_semantics`):
 *   `session/prompt` resolving = turn-done, NOT session-done.
 *   Emit EventEmitter `'end'` ONLY on subprocess teardown (stop/close/error).
 *   Guarded by `_endEmitted` so a stop()/late-close race can't double-fire —
 *   SessionManager's `once('end')` treats the first 'end' as session-complete
 *   and would tear the session down before queued steers arrive.
 */

import { EventEmitter } from 'events';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { safeNativeSessionId } from '../sessionId.js';
import { termChildProcess } from '../../sandbox/bwrap.js';

import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor,
  EffortLevel, InteractionQuestion, PromptOptions, InteractionMode,
} from '@tierwyn/shared';
import type { ResolvedMcpServer } from '@tierwyn/shared';
import { acpMcpCaps, toAcpMcpServers } from '../../mcp/inject.js';
import { recordAcpMcpCaps } from '../../mcp/resolve.js';
import { redactMcpSecrets } from '../../secrets/mcpRedact.js';
import { contextWindowOccupancy, computeContextWindowPct, clampEffort } from '@tierwyn/shared';
import { readProfiles } from '../../profiles.js';
import { adapterContextWindow } from '../../contextWindow.js';
import { scanSkillDirs, walkPluginSkillCache } from '../skillScan.js';
import { GrokRpc, humanizeGrokError } from './protocol.js';
import type { RequestId, GrokPromptResult, GrokSessionNewResult } from './protocol.js';
import { mapAcpUpdate } from './mapping.js';
import { GrokHelperTracker } from './helpers.js';
import { silentSuccessAckFor } from '../silentSuccessCommands.js';
import { encodeSessionBucket, GROK_SESSIONS_DIR } from './sessionPaths.js';
import { readGrokModelsCache } from './modelsCache.js';

export { encodeSessionBucket } from './sessionPaths.js';

/**
 * ACP builtins from `available_commands_update` (docs/grok-build/samples/*).
 * Cold listCommands cannot spawn a session, so discovery/picker seed these
 * statically — same pattern as Codex `/review`.
 */
export const GROK_BUILTIN_COMMANDS: CommandDescriptor[] = [
  { name: 'compact', label: 'compact', description: 'Compress conversation history to save context window', sourceDetail: 'builtin' },
  { name: 'always-approve', label: 'always-approve', description: 'Toggle always-approve mode (skip all permission prompts)', sourceDetail: 'builtin' },
  { name: 'context', label: 'context', description: 'Show context window usage and session stats', sourceDetail: 'builtin' },
  { name: 'plugins', label: 'plugins', description: 'Manage plugins (list, reload, trust, add, remove)', sourceDetail: 'builtin' },
  { name: 'reload-plugins', label: 'reload-plugins', description: 'Reload plugins from disk (alias for /plugins reload)', sourceDetail: 'builtin' },
  { name: 'session-info', label: 'session-info', description: 'Show session details (model, turns, context usage)', sourceDetail: 'builtin' },
  { name: 'feedback', label: 'feedback', description: 'Send feedback about the current session', sourceDetail: 'builtin' },
  { name: 'deep-research', label: 'deep-research', description: 'Run a deep multi-source research pass', sourceDetail: 'builtin' },
  { name: 'workflow', label: 'workflow', description: 'Run a saved workflow', sourceDetail: 'builtin' },
  { name: 'goal', label: 'goal', description: 'Set, manage, or check an autonomous goal', sourceDetail: 'builtin' },
  { name: 'loop', label: 'loop', description: 'Run a prompt on a recurring interval', sourceDetail: 'builtin' },
];

export class GrokBuildAdapter implements AgentAdapter {
  private readonly _bin = 'grok';
  private _interactionMode: InteractionMode;
  /** Overridable for listCommands tests (default ~/.grok). */
  private readonly _grokHome: string;

  // ── Wire ──────────────────────────────────────────────────────────────────
  private _proc: ChildProcess | null = null;
  private _rpc: GrokRpc | null = null;
  private _emitter = new EventEmitter();
  private _endEmitted = false; // guard: emit 'end' exactly once (Codex pattern)

  // ── Session ───────────────────────────────────────────────────────────────
  private _sessionId = '';
  private _nativeSessionId = '';
  private _resumeSessionId = '';
  private _cwd = '';
  private _model = '';
  /** Session-scoped reasoning effort, applied via _meta.reasoningEffort on
   *  session/new, session/load and every session/set_model (CONFIRMED 1.0.5 —
   *  set_model resets effort to the model default when _meta is omitted). */
  private _effort: EffortLevel | undefined = undefined;
  private _appliedEffort: EffortLevel | undefined = undefined;
  /** True when the last prompt applied a one-turn _meta override; next sendPrompt
   *  without options must re-bind conversation _sessionMeta(). */
  private _turnMetaOverridden = false;
  private _seq = 0;
  private _accepting = false; // true only after sendPrompt(); suppresses session/load replays
  private _sawMessageChunk = false;
  /** Builtin slash (e.g. /compact) that legitimately returns no assistant text. */
  private _silentSuccessAck: string | null = null;
  private _commands: CommandDescriptor[] = [];
  // Sub-shape of StatusEvent.payload — only the fields we stamp on status:done.
  // inputTokens is stored Anthropic-shaped (uncached portion only); cache reads
  // live in cacheReadTokens so getConversationUsage totalInput = sum of both.
  private _usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
  } = {};
  /** Last-turn input-side occupancy (uncached + cache read) for context %. */
  private _lastTurnOccupancy = 0;
  /** Active model window size from catalogue seed (listModels). */
  private _contextWindowSize: number | undefined = undefined;
  private _getNextSteer?: SessionConfig['getNextSteer'];
  private _steerLoopRunning = false;
  /** Set by interruptTurn() while a session/prompt is in flight. Causes the
   *  sendPrompt catch/empty path to soft-end (status:done + steer loop) instead
   *  of hard-error exit — so queued subagent_notify items can drain. */
  private _turnInterrupted = false;
  /** Native spawn_subagent lifecycle. Path A helper snapshots; no stopHelper. */
  private _helpers: GrokHelperTracker | null = null;

  // ── Approvals (interaction_request round-trip) ─────────────────────────────
  // Maps Tierwyn requestId → the server's JSON-RPC id for session/request_permission
  private _pendingApprovals = new Map<string, { rpcId: RequestId }>();
  /** Same round-trip for `_x.ai/ask_user_question` (Grok's builtin question
   *  tool). Reply contract (live-verified against grok 1.0.30):
   *  { outcome:'accepted', answers: { "<question text>": "<answer>" | ["a","b"] } }
   *  or { outcome:'cancelled' } — anything else deserializes as
   *  "Client returned an invalid response to user question: …". */
  private _pendingQuestions = new Map<string, { rpcId: RequestId; questions: GrokAskQuestion[] }>();

  readonly _spawn: (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;
  private readonly _spawnFn: (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;

  constructor(opts: {
    interactionMode?: 'bypass' | 'questions' | 'prompt';
    spawn?: (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;
    spawnFn?: (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;
    /** Test isolation for cold listCommands skill scan (default ~/.grok). */
    grokHome?: string;
  } = {}) {
    this._interactionMode = opts.interactionMode ?? 'bypass';
    this._grokHome = opts.grokHome ?? join(homedir(), '.grok');
    // Default spawn: detached into a new process group so we control teardown
    // via process.kill(-pid). The grok binary kills its own process group on
    // fatal exit; detaching isolates it from the server's group so a grok crash
    // cannot SIGKILL Tierwyn. spawnFn is overridable for tests (NEVER spawn real grok).
    const inner = opts.spawn ?? opts.spawnFn ?? spawn;
    this._spawn = (cmd, args, o) => inner(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: o.cwd || undefined,
      env: buildChildEnv(undefined, undefined, 'grok-build'),
      detached: true,
    });
    this._spawnFn = this._spawn;
  }

  streamEvents(): EventEmitter { return this._emitter; }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Registry MCP for the main session (one-shot paths keep `mcpServers: []`). */
  private _mcpServers: ResolvedMcpServer[] = [];

  async start(config: SessionConfig): Promise<void> {
    this._mcpServers = config.textOnly ? [] : (config.mcpServers ?? []);
    this._sessionId = config.sessionId;
    this._model = config.model;
    this._effort = clampEffort('grok-build', config.effort);
    this._appliedEffort = this._effort;
    this._turnMetaOverridden = false;
    this._cwd = config.cwd ?? process.cwd();
    this._resumeSessionId = safeNativeSessionId(config.nativeSessionId) ?? '';
    this._nativeSessionId = '';
    this._seq = 0;
    this._accepting = false;
    this._sawMessageChunk = false;
    this._usage = {};
    this._lastTurnOccupancy = 0;
    this._contextWindowSize = undefined;
    this._commands = [];
    this._pendingApprovals.clear();
    this._pendingQuestions.clear();
    this._endEmitted = false;
    this._steerLoopRunning = false;
    this._getNextSteer = config.getNextSteer;
    this._helpers?.close();
    this._helpers = new GrokHelperTracker({
      emit: (ev) => this._emitE(ev),
      sessionDir: () => this._helperSessionDir(),
    });

    // Resolve context-window size so status:done can compute contextWindowPct.
    // Best-effort; undefined → pct omitted (mirrors claude-code).
    // Awaited so the first turn never races a late listModels resolution.
    try {
      this._contextWindowSize = adapterContextWindow('grok-build', await this.listModels(), this._model);
    } catch {
      this._contextWindowSize = adapterContextWindow('grok-build', [], this._model);
    }

    // --sandbox is a top-level grok flag and must precede the `agent` subcommand.
    const sandbox = config.options?.['sandbox'];
    const preArgs = typeof sandbox === 'string' && sandbox ? ['--sandbox', sandbox] : [];
    const proc = this._spawnFn(this._bin, [...preArgs, 'agent', 'stdio'], { cwd: this._cwd || undefined });
    this._proc = proc;

    if (!proc.stdin || !proc.stdout) {
      this._emitE({ type: 'error', payload: { message: 'grok agent stdio subprocess has no stdio' } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
      return;
    }

    const rpc = new GrokRpc(proc.stdin, proc.stdout);
    this._rpc = rpc;

    // Server→client request handlers
    rpc.onServerRequest((method, id, params) => {
      if (method === 'session/request_permission') {
        this._handlePermissionRequest(id, (params ?? {}) as Record<string, unknown>);
      } else if (method === '_x.ai/ask_user_question') {
        this._handleAskUserQuestion(id, (params ?? {}) as Record<string, unknown>);
      } else {
        // Unknown server→client request — ack with empty result to avoid hanging.
        rpc.respond(id, {});
      }
    });

    // session/update notifications — the workhorse stream
    rpc.on('session/update', (p) => {
      const params = (p ?? {}) as Record<string, unknown>;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const variant = update.sessionUpdate as string | undefined;

      if (variant === 'available_commands_update') {
        const cmds = (update.availableCommands ?? []) as Array<{ name?: string; description?: string }>;
        this._commands = cmds
          .filter((c) => c.name)
          .map((c) => ({ name: String(c.name), label: String(c.name), description: c.description ?? '', sourceDetail: 'builtin' as const }));
        return;
      }
      // Grok emits no `cost` variant; usage comes via _x.ai/session_notification
      // (turn_completed) AND the session/prompt result _meta. We capture both.
      if (this._accepting) {
        for (const partial of mapAcpUpdate(update)) {
          if (partial.type === 'message' && (partial.payload as { chunk?: string }).chunk) {
            this._sawMessageChunk = true;
          }
          this._emitE(partial);
        }
        this._helpers?.observe(update);
      }
    });

    // turn_completed carries the canonical usage block (acp-prompt.jsonl).
    rpc.on('_x.ai/session_notification', (p) => {
      const update = (((p ?? {}) as Record<string, unknown>).update ?? {}) as Record<string, unknown>;
      if (update.sessionUpdate !== 'turn_completed') return;
      this._applyUsage((update.usage ?? {}) as Record<string, number>);
    });

    rpc.on('error', (err: unknown) => {
      // GrokRpc doesn't emit 'error' today (defensive only).
      const msg = humanizeGrokError(err instanceof Error ? err.message : String(err));
      this._emitE({ type: 'error', payload: { message: msg } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
    });

    // stderr — forward to logs only; most errors arrive via JSON-RPC.
    if (proc.stderr) {
      proc.stderr.on('data', (d: Buffer) => {
        const line = d.toString().trim();
        if (line) console.error(`[grok-stderr] ${redactMcpSecrets(line)}`);
      });
    }

    // Subprocess teardown → the one true 'end' signal.
    proc.on('error', (err) => {
      this._rpc?.drainPending(`grok subprocess error: ${err.message}`);
      this._emitE({ type: 'error', payload: { message: `grok subprocess error: ${err.message}` } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
      this._emitEnd();
    });
    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this._emitE({ type: 'error', payload: { message: `grok agent stdio exited with code ${code}` } });
        this._emitE({ type: 'status', payload: { status: 'error' } });
      }
      this._rpc?.drainPending('grok agent stdio closed');
      this._emitEnd();
    });

    // ── ACP handshake ──────────────────────────────────────────────────────
    // NOTE: we intentionally do NOT send an `initialized` notification — Grok
    // 0.2.101 logs "Method not found" to stderr when it receives one
    // (acp-init.jsonl line 6). initialize alone completes the handshake.
    const init = await rpc.initialize();
    const cwd = this._cwd || process.cwd();
    const canLoad = Boolean(init.agentCapabilities?.loadSession);
    // Registry MCP: literal values over stdin (not argv). http/sse only where advertised (V6).
    const mcpCaps = acpMcpCaps(init);
    recordAcpMcpCaps('grok-build', mcpCaps);
    const mcpServers = toAcpMcpServers(this._mcpServers, mcpCaps);

    if (this._resumeSessionId && canLoad) {
      await rpc.send('session/load', { sessionId: this._resumeSessionId, cwd, mcpServers, _meta: this._sessionMeta() });
      this._nativeSessionId = this._resumeSessionId;
      // session/load restores history but Grok honours the resumed model; send
      // set_model defensively (matches Hermes behaviour and is a safe no-op if
      // the model id is already current). Every set_model must carry
      // _meta.reasoningEffort — omitting it resets effort to the model default
      // (CONFIRMED 1.0.5).
      if (this._model) {
        await rpc.send('session/set_model', {
          sessionId: this._nativeSessionId,
          modelId: this._model,
          _meta: this._sessionMeta(),
        }).catch(() => { /* set_model is best-effort on resume */ });
      }
    } else {
      const created = await rpc.send<GrokSessionNewResult>('session/new', { cwd, mcpServers, _meta: this._sessionMeta() });
      this._nativeSessionId = safeNativeSessionId(created.sessionId) ?? '';
      if (this._model && this._nativeSessionId) {
        await rpc.send('session/set_model', {
          sessionId: this._nativeSessionId,
          modelId: this._model,
          _meta: this._sessionMeta(),
        }).catch(() => { /* unknown model id → safe no-op */ });
      }
    }
  }

  async sendPrompt(text: string, attachments?: Attachment[], _model?: string, effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    const rpc = this._rpc;
    if (!rpc || !this._nativeSessionId) {
      this._emitE({ type: 'error', payload: { message: 'GrokBuildAdapter.sendPrompt called before start() resolved a session' } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
      return;
    }

    await this._applyEffort(effort, options);

    // Open the gate so all notifications from this turn are captured.
    // session/load replays (during start()) are suppressed because _accepting
    // is false until here.
    this._accepting = true;
    this._sawMessageChunk = false;
    this._silentSuccessAck = silentSuccessAckFor(text);
    this._usage = {};
    this._lastTurnOccupancy = 0;
    this._turnInterrupted = false;
    // status:running fires after nativeSessionId is set in start(), so
    // sessionManager persists the native id (sessionManager.ts:139-140).
    this._emitE({ type: 'status', payload: { status: 'running' } });

    let errored = false;
    let interrupted = false;
    try {
      const result = await rpc.send<GrokPromptResult>('session/prompt', {
        sessionId: this._nativeSessionId,
        prompt: [{ type: 'text', text: this._withImageRefs(text, attachments) }],
      });
      // Capture usage from the session/prompt result _meta (acp-prompt.jsonl).
      // Prefer turn_completed when it already wrote occupancy; _meta is the
      // fallback when the notification order races the result.
      this._applyUsage((result?._meta?.usage ?? {}) as Record<string, number>);
      // Soft-cancel often resolves with stopReason cancelled/interrupted.
      const reason = (result?.stopReason ?? '').toLowerCase();
      if (this._turnInterrupted || reason === 'cancelled' || reason === 'interrupted' || reason === 'canceled') {
        interrupted = true;
      }
    } catch (err) {
      if (this._turnInterrupted) {
        // interruptTurn() asked us to yield — not a hard failure. Soft-end so
        // the steer loop can drain queued subagent_notify / parent_message.
        interrupted = true;
      } else {
        errored = true;
        this._emitE({
          type: 'error',
          payload: { message: humanizeGrokError(err instanceof Error ? err.message : String(err)) },
        });
        this._emitE({ type: 'status', payload: { status: 'error', ...this._statusUsage() } });
      }
    } finally {
      this._turnInterrupted = false;
    }

    if (!errored && !interrupted && !this._sawMessageChunk) {
      if (this._silentSuccessAck) {
        // Builtins like /compact complete with auto_compact_completed and no
        // agent_message_chunk. Emit an ack so the UI is not blank and so we do
        // not take the hard-error path (which skips the steer loop and leaves
        // mid-turn Queue items stuck forever).
        this._emitE({ type: 'message', payload: { chunk: this._silentSuccessAck, final: true } });
        this._sawMessageChunk = true;
      } else {
        // Grok resolved the turn without streaming any message chunk — treat as
        // silent failure (mirrors Hermes defence against set_model no-op cases).
        errored = true;
        this._emitE({
          type: 'error',
          payload: {
            message: `Grok returned no output (model: ${this._model || 'unset'}). `
              + 'Check the profile model id and that the cached token at ~/.grok/auth.json is valid.',
          },
        });
        this._emitE({ type: 'status', payload: { status: 'error', ...this._statusUsage() } });
      }
    }

    if (!errored) {
      // interrupted with no chunks still gets a clean done so the session parks
      // and the steer loop can deliver queued notifies.
      if (!this._sawMessageChunk) {
        this._emitE({ type: 'message', payload: { chunk: '', final: true } });
      } else if (!this._silentSuccessAck) {
        // Non-silent turns already streamed chunks; still emit final marker.
        this._emitE({ type: 'message', payload: { chunk: '', final: true } });
      }
      this._emitE({ type: 'status', payload: { status: 'done', ...this._statusUsage() } });
    }

    // After the turn, enter the long-running steer polling loop (if a steer
    // source was provided). DO NOT emit 'end' here in either case —
    // SessionManager treats 'end' as session-complete and would tear down the
    // SessionRecord. The subprocess stays alive between turns; 'end' fires only
    // on real teardown (subprocess close/error or stop()). Matches Codex.
    // Soft-interrupt also enters the loop so queued sourced steers drain.
    // Enter even after error when the process is still up so queued follow-ups
    // (including structured slash) can exit the loop and hit once('end') drain.
    if (this._getNextSteer && this._rpc && this._proc) {
      void this._runSteerLoop().catch(() => { /* loop exit is benign */ });
    }
  }

  /**
   * Soft-end the live session/prompt without killing the subprocess.
   * SessionManager calls this when a subagent_notify is queued mid-turn so the
   * post-turn steer loop can deliver it. Idempotent / no-op when no turn is live.
   */
  interruptTurn(): void {
    if (!this._rpc || !this._nativeSessionId) return;
    this._turnInterrupted = true;
    this._rpc.notify('session/cancel', { sessionId: this._nativeSessionId });
  }

  /**
   * Long-running steer loop. A non-null steer is delivered as a follow-up
   * `session/prompt` on the SAME native session. Grok 1.0.5 accepts a concurrent
   * session/prompt as a turn-boundary queue (`_x.ai/queue/changed`), not as
   * mid-turn injection — the second prompt runs after the first finishes. True
   * mid-turn steering is the TUI's `[ui].follow_up_behavior = "steer"`, which
   * GROK_CONFIG cannot reach. grok-build stays in SOFT_CANCEL_ADAPTERS; steer()
   * routes to the queue and this loop drains it. Null from getNextSteer means
   * session ended — exit; SessionManager calls stop().
   */
  private async _runSteerLoop(): Promise<void> {
    if (this._steerLoopRunning) return;
    this._steerLoopRunning = true;
    try {
      while (this._proc && this._rpc) {
        let next: { text: string; attachments?: Attachment[] } | null;
        try {
          next = await this._getNextSteer!();
        } catch { break; }
        if (!next) break;
        const rpc = this._rpc;
        if (!rpc || !this._nativeSessionId) break;
        try {
          this._sawMessageChunk = false;
          this._usage = {};
          this._lastTurnOccupancy = 0;
          this._emitE({ type: 'status', payload: { status: 'running' } });
          const result = await rpc.send<GrokPromptResult>('session/prompt', {
            sessionId: this._nativeSessionId,
            prompt: [{ type: 'text', text: this._withImageRefs(next.text, next.attachments) }],
          });
          this._applyUsage((result?._meta?.usage ?? {}) as Record<string, number>);
          if (!this._sawMessageChunk) {
            this._emitE({ type: 'error', payload: { message: 'Grok returned no output on steer follow-up.' } });
            this._emitE({ type: 'status', payload: { status: 'error', ...this._statusUsage() } });
            break;
          }
          this._emitE({ type: 'message', payload: { chunk: '', final: true } });
          this._emitE({ type: 'status', payload: { status: 'done', ...this._statusUsage() } });
        } catch (err) {
          this._emitE({
            type: 'error',
            payload: { message: humanizeGrokError(err instanceof Error ? err.message : String(err)) },
          });
          this._emitE({ type: 'status', payload: { status: 'error', ...this._statusUsage() } });
          break;
        }
      }
    } finally {
      this._steerLoopRunning = false;
    }
    // Loop exited → session is finished. Emit 'end' once.
    this._emitEnd();
  }

  /**
   * Not reachable from sessionManager today (`grep adapter.steer(` in
   * apps/server/src returns nothing). The method exists so that
   * `record.injectable` (sessionManager.ts:458,887) evaluates true, which is
   * what routes grok through the Queue-vs-Interrupt modal.
   * ponytail: do not delete — removing it silently flips injectable to false
   * and changes the UI's steer affordance.
   *
   * Grok 1.0.5 accepts a concurrent session/prompt as a turn-boundary queue
   * (not mid-turn folding). We send the prompt here; the steer loop (or the
   * next turn) drains it. Swallow send errors — the text is already queued
   * server-side when a turn is live.
   */
  async steer(text: string, attachments?: Attachment[]): Promise<void> {
    const rpc = this._rpc;
    if (!rpc || !this._nativeSessionId) return;
    try {
      await rpc.send('session/prompt', {
        sessionId: this._nativeSessionId,
        prompt: [{ type: 'text', text: this._withImageRefs(text, attachments) }],
      });
    } catch (err) {
      console.warn(`[grok] steer session/prompt failed: ${(err as Error).message}`);
    }
  }

  // ── Permission round-trip ──────────────────────────────────────────────────

  private _handlePermissionRequest(rpcId: RequestId, params: Record<string, unknown>): void {
    // Tool-gate permissions: 'questions' mode only surfaces ask_user_question
    // (see _handleAskUserQuestion); every ACP permission is a gate, so
    // auto-allow here like bypass.
    if (this._interactionMode === 'bypass' || this._interactionMode === 'questions') {
      autoAllowPermission(params, (result) => this._rpc?.respond(rpcId, result));
      return;
    }
    const requestId = randomUUID();
    const options = (params.options ?? []) as Array<{ optionId: string; kind?: string; name?: string }>;
    this._pendingApprovals.set(requestId, { rpcId });
    this._emitE({
      type: 'interaction_request',
      payload: {
        requestId,
        kind: 'permission',
        // Grok describes the gate at top level; fall back to a generic prompt.
        prompt: describePermission(params),
        // Grok's label field is `name` (acp-permission.jsonl line 82).
        choices: options.map((o) => ({ id: o.optionId, label: o.name ?? o.kind ?? o.optionId })),
        allowFreeText: false,
      },
    });
    this._emitE({ type: 'status', payload: { status: 'waiting' } });
  }

  // ── ask_user_question round-trip (_x.ai/ask_user_question) ─────────────────

  /**
   * Grok's builtin `ask_user_question` tool round-trips a dedicated extension
   * request (NOT session/request_permission — the standard ACP surface has no
   * question method). Until recent updates this hit the unknown-request `{}` ack,
   * which grok deserialized as a missing-`outcome` failure and the tool hard-
   * errored every time ("ask_user_question keeps failing").
   *
   * Mode semantics (mirrors claude-code, where AskUserQuestion is surfaced
   * before any permission-mode branch):
   *  - questions / prompt: emit a question-kind interaction_request card and
   *    block until the operator answers.
   *  - bypass: non-interactive — reply `cancelled` (a tested, clean outcome)
   *    so unattended runs proceed on the model's best judgment without
   *    fabricating consent or hanging for grok's 1800s tool timeout.
   */
  private _handleAskUserQuestion(rpcId: RequestId, params: Record<string, unknown>): void {
    const rawQuestions = (Array.isArray(params.questions) ? params.questions : []) as GrokAskQuestion[];
    if (this._interactionMode === 'bypass' || rawQuestions.length === 0) {
      this._rpc?.respond(rpcId, { outcome: 'cancelled' });
      return;
    }
    const requestId = randomUUID();
    const mapped: InteractionQuestion[] = rawQuestions.map((q) => {
      const qText = String(q.question ?? '');
      const options = (Array.isArray(q.options) ? q.options : []) as Array<{ label?: unknown; description?: unknown }>;
      return {
        id: qText,
        prompt: qText,
        choices: options
          .filter((o) => typeof o.label === 'string' && o.label)
          .map((o) => ({ id: String(o.label), label: String(o.label), ...(typeof o.description === 'string' ? { description: o.description } : {}) })),
        multiSelect: Boolean(q.multiSelect),
        allowFreeText: false,
      };
    });
    this._pendingQuestions.set(requestId, { rpcId, questions: rawQuestions });
    const first = mapped[0];
    this._emitE({
      type: 'interaction_request',
      payload: {
        requestId,
        kind: 'question',
        prompt:
          mapped.length > 1
            ? `The agent has ${mapped.length} questions`
            : (first?.prompt ?? 'The agent has a question'),
        multiSelect: first ? Boolean(first.multiSelect) : false,
        choices: first?.choices ?? [],
        questions: mapped,
        allowFreeText: true,
        toolName: 'ask_user_question',
      },
    });
    this._emitE({ type: 'status', payload: { status: 'waiting' } });
  }

  respondToInteraction(
    requestId: string,
    response: { selection: string[]; text?: string; answers?: { selection: string[]; text?: string }[] },
  ): void {
    const parkedQuestion = this._pendingQuestions.get(requestId);
    if (parkedQuestion) {
      this._pendingQuestions.delete(requestId);
      const answers = response.answers ?? [];
      if (answers.length === 0) {
        // No usable answer (legacy client path) — decline cleanly.
        this._rpc?.respond(parkedQuestion.rpcId, { outcome: 'cancelled' });
        this._emitE({
          type: 'interaction_resolved',
          payload: { requestId, selection: [], resolution: 'auto' },
        });
      } else {
        // Grok keys the answer map on the literal question text. Single-select
        // answers are plain strings; multi-select arrays (both accepted).
        const answerMap: Record<string, string | string[]> = {};
        parkedQuestion.questions.forEach((q, i) => {
          const a = answers[i];
          if (!a) return;
          const value =
            a.text !== undefined && a.text !== '' ? a.text
            : a.selection.length > 1 ? a.selection
            : (a.selection[0] ?? '');
          answerMap[String(q.question ?? '')] = value;
        });
        this._rpc?.respond(parkedQuestion.rpcId, { outcome: 'accepted', answers: answerMap });
        this._emitE({
          type: 'interaction_resolved',
          payload: { requestId, selection: [], text: response.text, resolution: 'answered' },
        });
      }
      this._emitE({ type: 'status', payload: { status: 'running' } });
      return;
    }
    const parked = this._pendingApprovals.get(requestId);
    if (!parked) return;
    this._pendingApprovals.delete(requestId);
    const optionId = response.selection[0] ?? '';
    this._rpc?.respond(parked.rpcId, { outcome: { outcome: 'selected', optionId } });
    this._emitE({
      type: 'interaction_resolved',
      payload: { requestId, selection: response.selection, text: response.text, resolution: 'answered' },
    });
    this._emitE({ type: 'status', payload: { status: 'running' } });
  }

  async setPermissionMode(mode: InteractionMode): Promise<void> {
    this._interactionMode = mode;
    if (this._rpc && this._nativeSessionId && this._model) {
      await this._rpc.send('session/set_model', {
        sessionId: this._nativeSessionId,
        modelId: this._model,
        _meta: this._sessionMeta(),
      }).catch(() => { /* permission mode change is best-effort */ });
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    // Grok stores sessions at ~/.grok/sessions/<percent-encoded-cwd>/<sessionId>/
    // (CONFIRMED Phase 0). List the bucket for the configured cwd; if cwd is
    // unset, return [] (we can't infer which bucket to read).
    const bucket = encodeSessionBucket(this._cwd);
    if (!bucket) return [];
    const dir = join(GROK_SESSIONS_DIR, bucket);
    let entries: string[];
    try {
      const { readdirSync } = await import('fs');
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    return entries.map((id) => ({ id, summary: id }));
  }

  async loadSession(id: string): Promise<void> {
    this._resumeSessionId = safeNativeSessionId(id) ?? '';
  }

  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId) return false;
    // Sessions are bucketed by percent-encoded cwd (Phase 0). If we know the
    // cwd, check that bucket; otherwise scan all buckets for a match.
    const bucket = encodeSessionBucket(this._cwd);
    if (bucket) {
      return existsSync(join(GROK_SESSIONS_DIR, bucket, nativeSessionId));
    }
    try {
      const { readdirSync } = await import('fs');
      const buckets = readdirSync(GROK_SESSIONS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
      return buckets.some((b) => existsSync(join(GROK_SESSIONS_DIR, b, nativeSessionId)));
    } catch {
      return false;
    }
  }

  // ── Commands / models ─────────────────────────────────────────────────────

  async listCommands(): Promise<CommandDescriptor[]> {
    // Live session: ACP already pushed available_commands_update (builtins + skills).
    if (this._commands.length > 0) return this._commands;

    // Cold path (boot discovery / pull-commands / picker before a session):
    // seed ACP builtins + scan the skill roots Grok itself loads. Without the
    // builtins, /compact works when typed but never appears in the slash list.
    const seen = new Set<string>();
    const out: CommandDescriptor[] = [];
    for (const b of GROK_BUILTIN_COMMANDS) {
      seen.add(b.name);
      out.push(b);
    }
    // Order: user skills → bundled → agents → claude/cursor compat (first wins).
    const skills = scanSkillDirs([
      join(this._grokHome, 'skills'),
      join(this._grokHome, 'bundled', 'skills'),
      join(homedir(), '.agents', 'skills'),
      join(homedir(), '.claude', 'skills'),
      join(homedir(), '.cursor', 'skills'),
    ]);
    const pluginSkills = walkPluginSkillCache(join(homedir(), '.claude', 'plugins', 'cache'));
    for (const s of [...skills, ...pluginSkills]) {
      if (seen.has(s.name)) continue;
      seen.add(s.name);
      out.push(s);
    }
    return out;
  }

  async runCommand(name: string, args?: string): Promise<void> {
    const prefix = `/${name}`;
    // Same path as a typed slash prompt so silent builtins (/compact) get
    // silentSuccessAckFor and the post-turn steer loop still starts.
    await this.sendPrompt(args?.trim() ? `${prefix} ${args}` : prefix);
  }

  async listModels(): Promise<ModelDescriptor[]> {
    // Grok writes its authoritative model list to ~/.grok/models_cache.json on
    // every catalogue refresh (id, name, context_window, reasoning menu). Read it
    // — no spawn, no network. `grok models` also works but is plain text with no
    // --json, so the cache is strictly better.
    const cached = readGrokModelsCache(this._grokHome);
    if (cached.length > 0) return cached;
    // ponytail: cold start / grok never launched → catalogue seed is the fallback.
    return readProfiles()
      .filter((p) => p.agentType === 'grok-build')
      .map((p) => ({
        name: p.model,
        label: p.label,
        provider: p.provider,
        vision: p.vision,
        steer: p.steer,
        contextWindow: p.contextWindow,
      }));
  }

  get nativeSessionId(): string {
    return this._nativeSessionId || this._resumeSessionId;
  }

  async stop(): Promise<void> {
    // Drain pending approvals with cancelled so Grok doesn't hang.
    for (const [requestId, parked] of this._pendingApprovals) {
      this._rpc?.respond(parked.rpcId, { outcome: { outcome: 'cancelled' } });
      this._emitE({
        type: 'interaction_resolved',
        payload: { requestId, selection: [], resolution: 'auto' },
      });
    }
    this._pendingApprovals.clear();

    // Drain pending ask_user_question round-trips with cancelled so grok's
    // tool doesn't sit in its 1800s timeout after the session is gone.
    for (const [requestId, parked] of this._pendingQuestions) {
      this._rpc?.respond(parked.rpcId, { outcome: 'cancelled' });
      this._emitE({
        type: 'interaction_resolved',
        payload: { requestId, selection: [], resolution: 'auto' },
      });
    }
    this._pendingQuestions.clear();
    this._helpers?.close();
    this._helpers = null;

    // Best-effort interrupt of the live turn.
    if (this._rpc && this._nativeSessionId) {
      this._rpc.notify('session/cancel', { sessionId: this._nativeSessionId });
    }
    this._emitE({ type: 'status', payload: { status: 'idle' } });

    // Tear down the whole detached process group. grok kills its own process
    // group on fatal exit; we spawned it detached (new group) precisely so
    // we can signal the entire group here without it ever being in the server's
    // group. `process.kill(-pid)` targets the group leader (= pid when detached).
    // Fallback to plain kill if pid is 0 or unknown. Tests override spawnFn
    // and may emit 'close' from kill().
    const proc = this._proc;
    try {
      termChildProcess(proc, { group: true });
    } finally {
      this._proc = null;
      this._rpc = null;
    }
    // 'end' fires from the 'close' handler on the process (defensive fallback
    // here in case the close event never arrives).
    this._emitEnd();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** `_meta` for session/new, session/load and session/set_model. Always sends
   *  yoloMode (see Task 3.1) and reasoningEffort when one is set. Per-message
   *  `options` overlay this turn only — they do not persist on `_effort`. */
  private _sessionMeta(overrides?: PromptOptions): Record<string, unknown> {
    const meta: Record<string, unknown> = {
      // CONFIRMED 1.0.5: _meta.yoloMode overrides `[ui] permission_mode` from
      // ~/.grok/config.toml for this session. Sent EXPLICITLY (including false) —
      // omitting it lets an operator's always-approve config silently defeat
      // Tierwyn's 'prompt' mode, which is what happened before update.
      yoloMode: this._interactionMode !== 'prompt',
      ...(this._effort ? { reasoningEffort: this._effort } : {}),
    };
    if (!overrides) return meta;
    if (typeof overrides.reasoningEffort === 'string') {
      const clamped = clampEffort('grok-build', overrides.reasoningEffort as EffortLevel);
      if (clamped) meta.reasoningEffort = clamped;
    }
    if (overrides.yoloMode === 'on') meta.yoloMode = true;
    else if (overrides.yoloMode === 'off') meta.yoloMode = false;
    return meta;
  }

  /** Re-bind reasoning effort / per-turn _meta before session/prompt.
   *  session/set_model is the only in-session lever (CONFIRMED 1.0.5); it is a
   *  cheap no-op when the model id is unchanged. Best-effort: a failure must not
   *  fail the turn. One set_model covers effort change, option overlay, or
   *  restoring conversation meta after a one-turn override. */
  private async _applyEffort(effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    const next = clampEffort('grok-build', effort);
    if (next) this._effort = next;
    const hasOverrides = !!(options && (options.reasoningEffort || options.yoloMode));
    const effortChanged = !!(next && next !== this._appliedEffort);
    const restore = this._turnMetaOverridden && !hasOverrides;
    if (!hasOverrides && !effortChanged && !restore) return;
    if (!this._rpc || !this._nativeSessionId || !this._model) return;
    await this._rpc.send('session/set_model', {
      sessionId: this._nativeSessionId,
      modelId: this._model,
      _meta: this._sessionMeta(hasOverrides ? options : undefined),
    }).catch(() => { /* effort/options are advisory — keep the turn */ });
    this._appliedEffort = this._effort;
    this._turnMetaOverridden = hasOverrides;
  }

  /** Append `@<tempPath>` mentions so Grok resolves images by local path reference. */
  private _withImageRefs(text: string, attachments?: Attachment[]): string {
    const pathRefs = (attachments ?? [])
      .map(a => a.tempPath)
      .filter((p): p is string => Boolean(p));
    return pathRefs.length > 0
      ? `${text}\n\n${pathRefs.map(p => `@${p}`).join('\n')}`
      : text;
  }

  /**
   * Capture Grok ACP usage into Anthropic-shaped session fields + occupancy.
   *
   * Observed (acp-resume-run2.jsonl): `inputTokens` is the full prompt size
   * (includes cache hits); `cachedReadTokens` is a subset. We split so
   * getConversationUsage's totalInput = uncached + cache_read does not double
   * count, and occupancy matches claude-code (input + cache, no output).
   */
  private _applyUsage(usage: Record<string, number | undefined>): void {
    const fullInput = typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined;
    const cacheRead = typeof usage.cachedReadTokens === 'number' ? usage.cachedReadTokens : undefined;
    const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined;

    if (fullInput !== undefined) {
      const read = cacheRead ?? 0;
      const uncached = Math.max(0, fullInput - read);
      this._usage.inputTokens = uncached;
      if (read > 0) this._usage.cacheReadTokens = read;
      else delete this._usage.cacheReadTokens;
      this._lastTurnOccupancy = contextWindowOccupancy({
        inputTokens: uncached,
        cacheReadTokens: read > 0 ? read : undefined,
      });
    } else if (cacheRead !== undefined && cacheRead > 0) {
      this._usage.cacheReadTokens = cacheRead;
      this._lastTurnOccupancy = contextWindowOccupancy({
        inputTokens: this._usage.inputTokens,
        cacheReadTokens: cacheRead,
      });
    }
    if (output !== undefined) this._usage.outputTokens = output;
  }

  /** Status payload fields: token counts + contextWindowPct when computable. */
  private _statusUsage(): {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    contextWindowPct?: number;
  } {
    const contextWindowPct = computeContextWindowPct(this._lastTurnOccupancy, this._contextWindowSize);
    return { ...this._usage, contextWindowPct };
  }

  private _emitE(ev: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    const full: NormalisedEvent = {
      ...(ev as Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>),
      sessionId: this._sessionId,
      seq: ++this._seq,
      ts: Date.now(),
    } as NormalisedEvent;
    this._emitter.emit('event', full);
  }

  /** Emit EventEmitter 'end' exactly once (subprocess lifecycle signal). */
  private _emitEnd(): void {
    if (this._endEmitted) return;
    this._endEmitted = true;
    this._helpers?.close();
    this._helpers = null;
    this._emitter.emit('end');
  }

  /** ~/.grok/sessions/<bucket>/<nativeId> — subagents/<id>/output.json lives here. */
  private _helperSessionDir(): string | null {
    const sid = this._nativeSessionId || this._resumeSessionId;
    if (!sid || !this._cwd) return null;
    return join(GROK_SESSIONS_DIR, encodeSessionBucket(this._cwd), sid);
  }

  /** Mid-turn context % from the latest turn_completed occupancy snapshot. */
  getLiveContextWindowUsage(): { contextWindowPct?: number; contextWindowSize?: number } {
    if (!this._contextWindowSize || this._lastTurnOccupancy <= 0) return {};
    const contextWindowPct = computeContextWindowPct(this._lastTurnOccupancy, this._contextWindowSize);
    return { contextWindowPct, contextWindowSize: this._contextWindowSize };
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** One entry of the `_x.ai/ask_user_question` params.questions array.
 *  Shape live-verified against grok 1.0.30. */
interface GrokAskQuestion {
  question?: unknown;
  options?: unknown;
  multiSelect?: unknown;
}

/**
 * Auto-approve an inbound permission request. Pick an option whose kind
 * contains "allow", else the first option. (acp-permission.jsonl shows
 * options carry `kind` ∈ {allow_always, allow_once, reject_once}.)
 */
export function autoAllowPermission(
  params: Record<string, unknown>,
  reply: (result: unknown) => void,
): void {
  const options = (params.options ?? []) as Array<{ optionId: string; kind?: string }>;
  const allow = options.find((o) => (o.kind ?? '').includes('allow')) ?? options[0];
  reply(allow ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } });
}

/** Build a human prompt for a permission request from Grok's toolCall block. */
function describePermission(params: Record<string, unknown>): string {
  const toolCall = (params.toolCall ?? {}) as Record<string, unknown>;
  const title = toolCall.title ? String(toolCall.title) : '';
  const rawInput = (toolCall.rawInput ?? {}) as Record<string, unknown>;
  const path = rawInput.file_path ? String(rawInput.file_path) : rawInput.path ? String(rawInput.path) : '';
  if (title && path) return `${title} → ${path}`;
  if (title) return title;
  if (path) return `Allow file change: ${path}`;
  return 'Grok is requesting permission';
}

