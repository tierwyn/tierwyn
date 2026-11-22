/**
 * CodexAdapter — drives OpenAI Codex CLI via `codex app-server` JSON-RPC 2.0 over stdio.
 *
 * Architecture:
 *  - One `codex app-server` subprocess per Tierwyn session (long-lived).
 *  - One `thread` per conversation (created with thread/start; resumed with thread/resume).
 *  - Each user prompt = one `turn/start` RPC.
 *  - Steering mid-turn: `turn/steer` with expectedTurnId.
 *  - Between turns: steer loop polls getNextSteer(); a new turn/start on non-null.
 *  - Approvals: server→client requests when interactionMode !== 'bypass'.
 *
 * CRITICAL — `'end'` semantics (§5 of the plan):
 *   `turn/completed` is turn-done, NOT session-done.
 *   Emit EventEmitter `'end'` ONLY when the subprocess exits.
 *   NEVER emit `'end'` on `turn/completed`.
 */

import { EventEmitter } from 'events';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { spawn, type SpawnOptions } from 'child_process';
import type { SpawnLike } from '../../sandbox/bwrap.js';
import { buildChildEnv } from '../../childEnv.js';
import { safeNativeSessionId } from '../sessionId.js';
import { toCodexArgs } from '../../mcp/inject.js';
import { randomUUID } from 'crypto';
import type { ChildProcess } from 'child_process';
import type { AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor, EffortLevel, PromptOptions, InteractionMode } from '@tierwyn/shared';
import { clampEffort } from '@tierwyn/shared';
import { readProfiles } from '../../profiles.js';
import { scanSkillDirs } from '../skillScan.js';
import { readCodexModelsCache } from './modelsCache.js';
import { CodexRpc } from './protocol.js';
import type { RequestId, Thread, ThreadListResult, TurnStartResult, ReviewStartResult } from './protocol.js';
import { parseCodexRateLimitsNotification } from './probeUsage.js';
import type { ProbedRateLimits } from './probeUsage.js';
import {
  mapThreadStatusChanged,
  mapTurnStarted,
  mapAgentMessageDelta,
  mapItemStarted,
  mapItemCompleted,
  mapTokenUsageUpdated,
  mapTurnCompleted,
  mapError,
} from './mapping.js';
import type { MappingState, EventPayload } from './mapping.js';

export function resolveCodexSandbox(options?: PromptOptions | null): string {
  const raw = options?.['sandbox'];
  if (raw === 'read-only' || raw === 'danger-full-access' || raw === 'workspace-write') return raw;
  return 'workspace-write';
}

export class CodexAdapter implements AgentAdapter {
  // ── Config ────────────────────────────────────────────────────────────────
  private readonly _bin = 'codex';
  private readonly _codexHome: string;
  private _interactionMode: InteractionMode;
  readonly _spawn: SpawnLike;
  private _sandboxed = false;

  // ── Wire ──────────────────────────────────────────────────────────────────
  private _proc: ChildProcess | null = null;
  private _rpc: CodexRpc | null = null;
  private _emitter = new EventEmitter();

  // ── Session ───────────────────────────────────────────────────────────────
  private _sessionId = '';
  private _threadId = '';          // native thread id, set after thread/start or thread/resume
  private _resumeThreadId = '';    // set by loadSession()
  private _threadStarted = false;  // true after the first thread/start or thread/resume
  private _threadSandbox = 'workspace-write'; // sandbox the live thread was started with
  private _model = '';
  /** Session-scoped effort: codex app-server has no per-turn effort field in
   *  0.142.5, so level binds at spawn via `-c model_reasoning_effort=`. The
   *  sendPrompt 4th param is intentionally unused. */
  private _effort: EffortLevel | undefined = undefined;
  private _cwd = '';
  private _seq = 0;
  private _getNextSteer?: SessionConfig['getNextSteer'];
  private _steerLoopRunning = false;
  private _endEmitted = false;     // guard: emit 'end' exactly once

  // ── Per-turn ──────────────────────────────────────────────────────────────
  private _activeTurnId: string | null = null;
  private _mappingState: MappingState = {};

  // ── Account rate limits (pushed via account/rateLimits/updated) ────────────
  private _lastRateLimits?: ProbedRateLimits;

  // ── Approvals (interaction_request round-trip) ─────────────────────────────
  // Maps Tierwyn requestId → { rpcId: the server's JSON-RPC id, kind }
  private _pendingApprovals = new Map<string, { rpcId: RequestId; kind: 'permission' }>();

  constructor(opts: {
    interactionMode?: 'bypass' | 'questions' | 'prompt';
    codexHome?: string;
    spawn?: SpawnLike;
    sandboxed?: boolean;
  } = {}) {
    this._interactionMode = opts.interactionMode ?? 'bypass';
    // ponytail: codexHome opt exists only for test isolation; production always uses ~/.codex
    this._codexHome = opts.codexHome ?? join(homedir(), '.codex');
    this._spawn = opts.spawn ?? spawn;
    this._sandboxed = opts.sandboxed === true;
  }

  private _effectiveSandbox(options?: PromptOptions): string {
    if (this._sandboxed) return 'danger-full-access';
    return resolveCodexSandbox(options);
  }

  streamEvents(): EventEmitter {
    return this._emitter;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /** Build `-c model_reasoning_effort=<level>` args when effort is set and
   *  supported (low/medium/high only). Session-scoped — binds at app-server spawn. */
  private _effortCliArgs(): string[] {
    const clamped = clampEffort('codex', this._effort);
    return clamped ? ['-c', `model_reasoning_effort=${clamped}`] : [];
  }

  async start(config: SessionConfig): Promise<void> {
    this._sessionId = config.sessionId;
    this._model = config.model;
    this._effort = config.effort;
    this._cwd = config.cwd ?? process.cwd();
    this._resumeThreadId = safeNativeSessionId(config.nativeSessionId) ?? '';
    this._threadId = '';
    this._threadStarted = false;
    this._threadSandbox = 'workspace-write';
    this._seq = 0;
    this._activeTurnId = null;
    this._mappingState = {};
    this._steerLoopRunning = false;
    this._endEmitted = false;
    this._lastRateLimits = undefined;
    this._getNextSteer = config.getNextSteer;

    // Effort is session-scoped for codex: app-server 0.142.5 has no
    // per-thread/start effort field, so `-c model_reasoning_effort=` must go
    // on the spawn. Changing effort mid-conversation requires a new session.
    const effortArgs = this._effortCliArgs();
    // Registry MCP via `-c mcp_servers.<id>.*` (V4). Secrets never on argv: stdio
    // secret env is forwarded by name (env_vars), secret headers via env_http_headers.
    const mcp = config.textOnly ? { args: [], env: {} } : toCodexArgs(config.mcpServers ?? []);
    // workspace-write blocks all sockets by default — including loopback, so the
    // agent couldn't reach Tierwyn's own API (/spawn, /agent/plugins, …). Keep the
    // file-write jail, allow network. No effect in read-only / danger-full-access.
    const netArgs = ['-c', 'sandbox_workspace_write.network_access=true'];
    const proc = this._spawn(this._bin, ['app-server', ...netArgs, ...effortArgs, ...mcp.args], {
      cwd: this._cwd || undefined,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: buildChildEnv(mcp.env, undefined, 'codex'),
    } as SpawnOptions);
    this._proc = proc;

    if (!proc.stdin || !proc.stdout) {
      this._emitE({ type: 'error', payload: { message: 'codex app-server subprocess has no stdio' } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
      return;
    }

    const rpc = new CodexRpc(proc.stdin, proc.stdout);
    this._rpc = rpc;

    // Wire approval server-request handler
    rpc.onServerRequest((method, id, params) => {
      this._handleApprovalRequest(method, id, params);
    });

    // Wire all notification handlers
    rpc.on('thread/status/changed', (p) => {
      const ev = mapThreadStatusChanged(p as Parameters<typeof mapThreadStatusChanged>[0]);
      if (ev) this._emitE(ev);
    });

    rpc.on('turn/started', (p) => {
      const params = p as { threadId: string; turn: { id: string } };
      // Capture the turn id from the notification (belt-and-suspenders alongside turn/start result)
      if (!this._activeTurnId && params.turn?.id) {
        this._activeTurnId = params.turn.id;
      }
      this._emitE(mapTurnStarted(params as Parameters<typeof mapTurnStarted>[0]));
    });

    rpc.on('item/agentMessage/delta', (p) => {
      this._emitE(mapAgentMessageDelta(p as Parameters<typeof mapAgentMessageDelta>[0]));
    });

    rpc.on('item/started', (p) => {
      const ev = mapItemStarted(p as Parameters<typeof mapItemStarted>[0]);
      if (ev) this._emitE(ev);
    });

    rpc.on('item/completed', (p) => {
      const evs = mapItemCompleted(p as Parameters<typeof mapItemCompleted>[0]);
      for (const ev of evs) this._emitE(ev);
    });

    rpc.on('thread/tokenUsage/updated', (p) => {
      mapTokenUsageUpdated(
        p as Parameters<typeof mapTokenUsageUpdated>[0],
        this._mappingState,
      );
    });

    // Account rate limits pushed mid-session — fresher than any probe and free.
    // Params may be the rateLimits object directly; the dual-shape parser handles
    // both that and a {rateLimits} wrapper.
    rpc.on('account/rateLimits/updated', (p) => {
      this._lastRateLimits = parseCodexRateLimitsNotification(p);
    });

    rpc.on('turn/completed', (p) => {
      this._activeTurnId = null;
      const ev = mapTurnCompleted(p as Parameters<typeof mapTurnCompleted>[0], this._mappingState);
      this._emitE(ev);
      // DO NOT emit 'end' here — subprocess stays alive for the steer loop.
      // Start the steer polling loop so the next prompt can be delivered.
      void this._runSteerLoop().catch(() => { /* swallow */ });
    });

    rpc.on('error', (p) => {
      const evs = mapError(p as Parameters<typeof mapError>[0]);
      for (const ev of evs) this._emitE(ev);
      // No steer-resolver drain here: the steer loop (started in sendPrompt)
      // already holds the parked resolver, and an extra getNextSteer() call
      // would park a SECOND resolver that silently eats the next steer.
      // Cleanup on 'end' resolves parked resolvers with null.
    });

    // Stderr: forward to message events for visibility (debug only — most errors come via notifications)
    if (proc.stderr) {
      const { createInterface } = await import('readline');
      const rlErr = createInterface({ input: proc.stderr });
      rlErr.on('line', (line) => {
        const trimmed = line.trim();
        if (trimmed) {
          // Only log; don't flood the UI
          console.error(`[codex-stderr] ${trimmed}`);
        }
      });
    }

    // On subprocess close/error → emit 'end' (the one true signal)
    proc.on('error', (err) => {
      this._rpc?.drainPending(err.message);
      this._emitE({ type: 'error', payload: { message: `codex subprocess error: ${err.message}` } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
      this._emitEnd();
    });

    proc.on('close', (code) => {
      if (code !== 0 && code !== null) {
        this._emitE({ type: 'error', payload: { message: `codex exited with code ${code}` } });
        this._emitE({ type: 'status', payload: { status: 'error' } });
      }
      this._rpc?.drainPending('subprocess closed');
      this._emitEnd();
    });

    // Initialize handshake (§2.2)
    await rpc.initialize();
  }

  async sendPrompt(text: string, attachments: Attachment[] = [], model?: string, _effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    if (!this._rpc) {
      this._emitE({ type: 'error', payload: { message: 'CodexAdapter.sendPrompt called before start()' } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
      return;
    }

    this._emitE({ type: 'status', payload: { status: 'running' } });

    const activeModel = model ?? this._model;
    const sandbox = this._effectiveSandbox(options);
    this._resetThreadIfSandboxChanged(sandbox);

    await this._ensureThread(activeModel, sandbox);

    // Build user input array (§2.8 — vision support)
    const input = buildUserInput(text, attachments);

    // Start the turn
    const turnResult = await this._rpc.send('turn/start', {
      threadId: this._threadId,
      input,
    }) as TurnStartResult;

    this._activeTurnId = turnResult.turn.id;

    // Immediate steering: park on getNextSteer from turn one so a mid-turn
    // operator steer is injected via turn/steer right away, instead of
    // queueing until the first turn/completed. Guarded no-op on re-entry.
    void this._runSteerLoop().catch(() => { /* swallow */ });
  }

  async steer(text: string, attachments: Attachment[] = []): Promise<void> {
    // Present so `typeof adapter.steer === 'function'` gates `injectable` in SessionManager.
    // If a turn is live, issue turn/steer; otherwise the steer loop handles between-turn steers.
    if (!this._rpc || !this._threadId) return;

    if (this._activeTurnId) {
      const input = buildUserInput(text, attachments);
      try {
        await this._rpc.send('turn/steer', {
          threadId: this._threadId,
          input,
          expectedTurnId: this._activeTurnId,
        });
        this._emitE({ type: 'status', payload: { status: 'running' } });
      } catch (err) {
        // expectedTurnId mismatch is the common failure — the turn may have completed.
        // Silently ignore; the steer loop will deliver it as a new turn.
        console.warn(`[codex] turn/steer failed: ${(err as Error).message}`);
      }
    }
    // Between-turn steers: handled by the steer loop awaiting getNextSteer()
  }

  respondToInteraction(
    requestId: string,
    response: { selection: string[]; text?: string; answers?: { selection: string[]; text?: string }[] },
  ): void {
    const parked = this._pendingApprovals.get(requestId);
    if (!parked) return;
    this._pendingApprovals.delete(requestId);

    const decision = response.selection[0] === 'allow' ? 'accept' : 'decline';
    this._rpc?.respond(parked.rpcId, { decision });

    this._emitE({
      type: 'interaction_resolved',
      payload: { requestId, selection: response.selection, resolution: 'answered' },
    });
    this._emitE({ type: 'status', payload: { status: 'running' } });
  }

  async stop(): Promise<void> {
    // Interrupt any live turn
    if (this._rpc && this._threadId && this._activeTurnId) {
      try {
        await this._rpc.send('turn/interrupt', {
          threadId: this._threadId,
          turnId: this._activeTurnId,
        });
      } catch { /* best effort */ }
    }
    this._activeTurnId = null;

    // Drain pending approvals with decline so codex doesn't hang
    for (const [requestId, parked] of this._pendingApprovals) {
      this._rpc?.respond(parked.rpcId, { decision: 'decline' });
      this._emitE({
        type: 'interaction_resolved',
        payload: { requestId, selection: [], resolution: 'auto' },
      });
    }
    this._pendingApprovals.clear();

    // Resolve the steer loop's parked resolver with null so it exits
    // (getNextSteer() will return null on the next call — SessionManager drains it)
    // We do this by killing the proc, which triggers the 'close' event which emits 'end',
    // which SessionManager intercepts — then it resolves any parked steers with null.

    this._emitE({ type: 'status', payload: { status: 'idle' } });

    try {
      this._proc?.kill('SIGTERM');
    } finally {
      this._proc = null;
      this._rpc = null;
    }
    // 'end' will fire from the 'close' handler on the process (or we emit it here defensively)
    this._emitEnd();
  }

  async setPermissionMode(mode: InteractionMode): Promise<void> {
    this._interactionMode = mode;   // _handleApprovalRequest reads this live for the questions auto-accept
    // approvalPolicy binds at thread/start|resume: re-bind the live thread at the
    // next turn start, preserving context via thread/resume with the same thread id.
    if (this._threadStarted && this._threadId) {
      this._threadStarted = false;
      this._resumeThreadId = this._threadId;
    }
  }

  // ── Sessions ──────────────────────────────────────────────────────────────

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    if (!this._rpc) return [];
    try {
      const result = await this._rpc.send('thread/list', { limit: 50 }) as ThreadListResult;
      return (result.data ?? []).map((t: Thread) => ({
        id: t.id,
        summary: t.preview || t.id,
        createdAt: t.createdAt ? t.createdAt * 1000 : undefined,
      }));
    } catch {
      return [];
    }
  }

  async loadSession(id: string): Promise<void> {
    this._resumeThreadId = safeNativeSessionId(id) ?? '';
  }

  async isNativeSessionAvailable(id: string): Promise<boolean> {
    // Non-spawning on-disk check: codex session files land at
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
    // ponytail: recursive dir walk — shallow tree (4 levels max), acceptable
    const sessionsDir = join(this._codexHome, 'sessions');
    for (let attempt = 0; attempt < 5; attempt++) {
      if (existsSync(sessionsDir) && walkForThread(sessionsDir, id)) return true;
      if (attempt < 4) await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    const review: CommandDescriptor = {
      name: 'review',
      label: 'review',
      description: 'Run a Codex code review on the current changes.',
      sourceDetail: 'builtin',
    };
    // ponytail: filesystem scan, not RPC — discovery calls this on a bare (un-started)
    // adapter, so no app-server subprocess exists. Skills live on disk in SKILL.md format.
    const skills = scanSkillDirs([
      join(this._codexHome, 'skills'),
      join(this._codexHome, 'skills', '.system'),
    ]);
    const seen = new Set(['review']);
    const out: CommandDescriptor[] = [review];
    for (const s of skills) { if (!seen.has(s.name)) { seen.add(s.name); out.push(s); } }
    return out;
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    if (!this._rpc) {
      this._emitE({ type: 'error', payload: { message: 'CodexAdapter.runCommand called before start()' } });
      this._emitE({ type: 'status', payload: { status: 'error' } });
      return;
    }
    this._emitE({ type: 'status', payload: { status: 'running' } });
    const sandbox = this._effectiveSandbox(options);
    this._resetThreadIfSandboxChanged(sandbox);
    await this._ensureThread(undefined, sandbox);

    if (name === 'review') {
      const target = args?.trim()
        ? { type: 'custom' as const, instructions: args.trim() }
        : { type: 'uncommittedChanges' as const };
      const result = await this._rpc.send('review/start', {
        threadId: this._threadId,
        target,
        delivery: 'inline',
      }) as ReviewStartResult;
      this._activeTurnId = result.turn.id;
      return;
    }

    // Skill (or any other listed command): send as a slash prompt. Mirrors claude-code.
    // ponytail: unverified that codex app-server honours "/<skill>" in turn input;
    //           operator smoke test (Task 8) confirms. Fallback = natural-language mention.
    await this.sendPrompt(args?.trim() ? `/${name} ${args}` : `/${name}`, [], undefined, undefined, options);
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const cached = readCodexModelsCache(this._codexHome);
    if (cached.length > 0) return cached;
    return readProfiles()
      .filter((p) => p.agentType === 'codex')
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
    return this._threadId || this._resumeThreadId;
  }

  /** Last rate limits pushed via account/rateLimits/updated, if any. Read by
   *  the usage route via an (adapter as { getLiveRateLimits? }) cast — not part
   *  of the AgentAdapter interface. */
  getLiveRateLimits(): ProbedRateLimits | undefined {
    return this._lastRateLimits;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  /** Drop the live thread so the next _ensureThread call starts a new one with a different sandbox. */
  private _resetThreadIfSandboxChanged(sandbox: string): void {
    if (this._threadStarted && this._threadSandbox !== sandbox) {
      this._threadStarted = false;
      this._resumeThreadId = '';
      this._threadId = '';
    }
  }

  /** Idempotent thread start/resume. Guards on _threadStarted so caller can call multiple times. */
  private async _ensureThread(model?: string, sandbox = 'workspace-write'): Promise<void> {
    if (this._threadStarted) return;
    if (!this._rpc) return;
    const activeModel = model ?? this._model;
    const approvalPolicy = this._interactionMode !== 'bypass' ? 'on-request' : 'never';
    let result: { thread: Thread };
    if (this._resumeThreadId) {
      result = await this._rpc.send('thread/resume', {
        threadId: this._resumeThreadId,
        model: activeModel,
        cwd: this._cwd,
        sandbox,
        approvalPolicy,
      }) as { thread: Thread };
    } else {
      result = await this._rpc.send('thread/start', {
        model: activeModel,
        cwd: this._cwd,
        sandbox,
        approvalPolicy,
      }) as { thread: Thread };
    }
    this._threadId = result.thread.id;
    this._threadSandbox = sandbox;
    this._threadStarted = true;
  }

  /**
   * Long-running steer loop. Started in sendPrompt right after turn/start, so
   * a resolver is parked for the WHOLE session (SessionManager resolves it the
   * moment the operator steers — including mid-turn). Also re-entered from
   * turn/completed as a guarded no-op safety net.
   *
   * Delivery is routed by turn state:
   *  - Live turn → native turn/steer with expectedTurnId (immediate mid-turn
   *    injection). On failure (turn just completed → id mismatch) fall back
   *    to turn/start.
   *  - No live turn → turn/start (a fresh follow-up turn).
   *
   * Null from getNextSteer means session ended — just exit; SessionManager
   * calls stop(). _steerLoopRunning guard prevents two concurrent loops.
   */
  private async _runSteerLoop(): Promise<void> {
    if (this._steerLoopRunning) return;
    if (!this._getNextSteer) return;
    this._steerLoopRunning = true;
    try {
      while (this._proc && this._rpc) {
        const next = await this._getNextSteer();
        if (next === null) {
          // Session ended — stop() will be called by SessionManager
          return;
        }
        if (!this._proc || !this._rpc || !this._threadId) return;

        const input = buildUserInput(next.text, next.attachments ?? []);

        // Mid-turn: inject into the live turn via turn/steer.
        if (this._activeTurnId) {
          try {
            await this._rpc.send('turn/steer', {
              threadId: this._threadId,
              input,
              expectedTurnId: this._activeTurnId,
            });
            this._emitE({ type: 'status', payload: { status: 'running' } });
            continue;
          } catch (err) {
            // Common failure: the turn completed in the race window and the
            // expectedTurnId no longer matches. Deliver as a new turn instead.
            console.warn(`[codex] turn/steer failed, falling back to turn/start: ${(err as Error).message}`);
          }
        }

        // Between turns (or turn/steer fallback): start a fresh turn.
        this._mappingState = {};
        this._emitE({ type: 'status', payload: { status: 'running' } });
        try {
          const turnResult = await this._rpc.send('turn/start', {
            threadId: this._threadId,
            input,
          }) as TurnStartResult;
          this._activeTurnId = turnResult.turn.id;
        } catch (err) {
          this._emitE({ type: 'error', payload: { message: `Failed to start steer turn: ${(err as Error).message}` } });
          this._emitE({ type: 'status', payload: { status: 'error' } });
          return;
        }
      }
    } finally {
      this._steerLoopRunning = false;
    }
  }

  private _handleApprovalRequest(method: string, rpcId: RequestId, params: unknown): void {
    const p = params as Record<string, unknown>;

    // In 'questions' mode auto-allow all non-AskUserQuestion gates (codex doesn't use AskUserQuestion)
    if (this._interactionMode === 'questions') {
      this._rpc?.respond(rpcId, { decision: 'accept' });
      return;
    }

    const requestId = randomUUID();
    let prompt = '';

    switch (method) {
      case 'item/commandExecution/requestApproval':
        prompt = `Allow command: ${(p.command as string) ?? '(unknown)'}`;
        break;
      case 'item/fileChange/requestApproval':
        prompt = `Allow file change${p.reason ? `: ${p.reason}` : ''}`;
        break;
      case 'item/tool/requestUserInput':
        // ponytail: auto-approve in v1 — shape is fiddly and not exercised in spike
        this._rpc?.respond(rpcId, { response: '' });
        return;
      case 'item/permissions/requestApproval':
        prompt = 'Allow permission request';
        break;
      default:
        // Unknown approval type — auto-accept to avoid hanging
        this._rpc?.respond(rpcId, { decision: 'accept' });
        return;
    }

    this._pendingApprovals.set(requestId, { rpcId, kind: 'permission' });

    this._emitE({
      type: 'interaction_request',
      payload: {
        requestId,
        kind: 'permission',
        prompt,
        choices: [
          { id: 'allow', label: 'Allow' },
          { id: 'deny', label: 'Deny' },
        ],
      },
    });
    this._emitE({ type: 'status', payload: { status: 'waiting' } });
  }

  private _emitE(ev: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'> | EventPayload): void {
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
    this._emitter.emit('end');
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Walk dir tree (depth ≤ 5) looking for a rollout-*-<threadId>.jsonl file. */
function walkForThread(dir: string, threadId: string): boolean {
  try {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) {
          if (walkForThread(full, threadId)) return true;
        } else if (entry.endsWith(`-${threadId}.jsonl`)) {
          return true;
        }
      } catch { /* skip unreadable entries */ }
    }
  } catch { /* skip unreadable dirs */ }
  return false;
}

/** Build the turn/start input array from text + attachments (§2.8). */
function buildUserInput(
  text: string,
  attachments: Attachment[],
): unknown[] {
  const inputs: unknown[] = [{ type: 'text', text, text_elements: [] }];
  for (const att of attachments) {
    if (att.tempPath) {
      inputs.push({ type: 'localImage', path: att.tempPath });
    } else if (att.base64) {
      inputs.push({ type: 'image', url: `data:${att.mediaType};base64,${att.base64}` });
    }
  }
  return inputs;
}
