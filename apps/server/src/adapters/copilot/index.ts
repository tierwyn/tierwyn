/**
 * GitHub Copilot CLI adapter — spawn-per-turn, streaming NDJSON on stdout.
 *
 * Lifecycle follows OpenClaw (one child per sendPrompt, stable native session
 * id). Streaming shape follows Cursor (createInterface over stdout, pure
 * mapping.ts). Copilot is a bypass-mode agent: no steer, no interruptTurn,
 * no respondToInteraction, no slash commands, no native session surgery.
 * Permissions are static spawn-time flags (--allow-all + DENY_TOOLS).
 *
 * Tested against @github/copilot@1.0.82. The JSONL schema is unversioned;
 * --no-auto-update + COPILOT_AUTO_UPDATE=false pin the binary for the run.
 */
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { homedir } from 'os';
import { join, isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { openAgentSqliteReadonly } from '../agentSqlite.js';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, EffortLevel,
  OneShotOpts, OneShotResult, OneShotMode, PromptOptions,
} from '@tierwyn/shared';
import { contextWindowOccupancy, computeContextWindowPct } from '@tierwyn/shared';
import { buildChildEnv } from '../../childEnv.js';
import { safeNativeSessionId } from '../sessionId.js';
import { capForArgvSpawn } from '../../compaction/primingCap.js';
import { withImagePathRefs } from '../../imageHelper.js';
import {
  mapCopilotFrame, createCopilotStreamState, usageFromState, type CopilotStreamState,
} from './mapping.js';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(id: string | undefined): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}

type InnerSpawn = (cmd: string, args: string[], opts: import('child_process').SpawnOptions) => ChildProcess;

function defaultSpawn(
  cmd: string, args: string[], opts: { cwd?: string }, spawnImpl: InnerSpawn = nodeSpawn,
  authEnv?: NodeJS.ProcessEnv,
): ChildProcess {
  return spawnImpl(cmd, args, {
    cwd: opts.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: buildChildEnv({ COPILOT_AUTO_UPDATE: 'false', ...authEnv }, undefined, 'copilot'),
  });
}

export const COPILOT_SANDBOX_TOKEN_MISSING =
  'Sandboxed Copilot needs a Copilot token (fine-grained PAT with only the "Copilot Requests" permission) '
  + '— set COPILOT_GITHUB_TOKEN in Settings → Agents → Copilot → Environment. The keyring sign-in is unreachable inside bwrap.';

// Vault reader installed at boot (hub index.ts) or runNode (remote node main.ts). Default: none (tests).
let copilotTokenSource: () => string | undefined = () => undefined;
export function setCopilotTokenSource(fn: () => string | undefined): void {
  copilotTokenSource = fn;
}

/**
 * Auth env for Copilot:
 * - When sandboxed (bwrap): the desktop keyring is unreachable, so we require a
 *   dedicated token from the vault (`copilotTokenSource()`), and inject both
 *   `COPILOT_GITHUB_TOKEN` and `GH_TOKEN` (the CLI accepts both depending on token type).
 * - When unsandboxed: if a token exists in the vault (e.g. running on a headless remote host
 *   where no interactive keyring exists), inject both `COPILOT_GITHUB_TOKEN` and `GH_TOKEN`.
 *   If no vault token exists, return empty env so local desktop keyring / environment is used.
 */
export function copilotSandboxAuthEnv(token: string | undefined = copilotTokenSource()): NodeJS.ProcessEnv {
  const t = token?.trim();
  if (!t) throw new Error(COPILOT_SANDBOX_TOKEN_MISSING);
  return { COPILOT_GITHUB_TOKEN: t, GH_TOKEN: t, GITHUB_TOKEN: undefined };
}

export function copilotAuthEnv(token: string | undefined = copilotTokenSource()): NodeJS.ProcessEnv | undefined {
  const t = token?.trim();
  if (!t) return undefined;
  return { COPILOT_GITHUB_TOKEN: t, GH_TOKEN: t };
}

// ponytail: deny beats --allow-all, so this is a real backstop, not decoration.
// Static and hardcoded on purpose — a configurable policy is a feature nobody asked for.
export const DENY_TOOLS = [
  'shell(git push)',      // no unattended pushes
  'shell(gh:*)',          // no PR/issue/release mutations via gh
  'github-mcp-server',    // built-in GitHub MCP — invisible to `copilot mcp list`; the shell(gh:*) kind does not cover its tools
  'write(.env)',          // relative pattern matches any .env at any depth
] as const;

export const COPILOT_READONLY_TOOLS = new Set(['view', 'grep', 'glob']);

export type CopilotPromptOptionCtx = {
  hasConcreteModel: boolean;
  activeEffort?: EffortLevel;
};

/**
 * Append per-turn Copilot prompt-option flags.
 * Order: --mode → --effort → tools policy → --assisted-approval.
 * Always emits a tools policy (default: --allow-all + DENY_TOOLS) so
 * sendPrompt can call this after model resolution and skip duplicating that slice.
 */
export function appendCopilotPromptOptionArgs(
  args: string[],
  options?: PromptOptions | null,
  ctx: CopilotPromptOptionCtx = { hasConcreteModel: false },
): void {
  const opts = options ?? {};
  const mode = opts['mode'];
  if (mode === 'plan' || mode === 'autopilot') args.push('--mode', mode);

  const effortFromOpts = opts['effort'];
  const effort =
    (effortFromOpts === 'low' || effortFromOpts === 'medium' || effortFromOpts === 'high')
      ? effortFromOpts
      : ctx.activeEffort;
  if (effort && ctx.hasConcreteModel) args.push('--effort', effort);

  if (opts['toolsPolicy'] === 'readOnly') {
    args.push('--available-tools', 'view,grep,glob');
  } else {
    args.push('--allow-all');
  }
  for (const deny of DENY_TOOLS) args.push(`--deny-tool=${deny}`);
  if (opts['toolsPolicy'] === 'readOnly') {
    args.push('--deny-tool=shell(*)', '--deny-tool=write');
  }

  if (opts['assistedApproval'] === true) args.push('--assisted-approval');
}

export class CopilotAdapter implements AgentAdapter {
  readonly oneShotModes: readonly OneShotMode[] = ['none', 'read_only'];
  private _emitter = new EventEmitter();
  private _child: ChildProcess | null = null;
  private _sessionId = '';
  private _nativeSessionId = '';
  private _model = '';
  private _cwd = '';
  private _seq = 0;
  private _resuming = false;
  private _sessionEstablished = false;
  private _hasSpawned = false;
  private _turnProducedContent = false;
  private _stopping = false;
  private _effort: EffortLevel | undefined;
  /** Cumulative `result.filesModified` already surfaced this session. */
  private readonly _resultFilesSeen = new Set<string>();
  private readonly _bin: string;
  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private readonly _copilotHome: string;
  private readonly _customSpawn: boolean;
  private readonly _sandboxed: boolean;

  constructor(opts: { spawn?: SpawnFn; spawnFn?: SpawnFn; bin?: string; copilotHome?: string; sandboxed?: boolean } = {}) {
    this._sandboxed = opts.sandboxed === true;
    this._bin = opts.bin ?? 'copilot';
    this._customSpawn = Boolean(opts.spawn ?? opts.spawnFn);
    const inner = (opts.spawn ?? opts.spawnFn ?? nodeSpawn) as InnerSpawn;
    this._spawnFn = (c, a, o) =>
      defaultSpawn(c, a, o, inner, this._sandboxed ? copilotSandboxAuthEnv() : copilotAuthEnv());
    this._spawn = this._spawnFn;
    this._copilotHome = opts.copilotHome ?? join(homedir(), '.copilot');
  }

  streamEvents(): EventEmitter { return this._emitter; }

  get nativeSessionId(): string { return this._nativeSessionId; }

  private _emit(e: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    this._emitter.emit('event', {
      ...e,
      sessionId: this._sessionId,
      seq: ++this._seq,
      ts: Date.now(),
    } as NormalisedEvent);
  }

  private _fail(message: string): void {
    this._emit({ type: 'error', payload: { message } });
    this._emit({ type: 'status', payload: { status: 'error' } });
  }

  async start(config: SessionConfig): Promise<void> {
    this._sessionId = config.sessionId;
    this._model = config.model;
    this._cwd = config.cwd ?? '';
    this._seq = 0;
    this._effort = config.effort;
    this._stopping = false;
    this._child = null;
    this._sessionEstablished = false;
    this._hasSpawned = false;
    // --session-id rejects anything that is not a v4-shaped UUID, and --resume
    // exits 1 for any id the CLI has no row for in ~/.copilot/session-store.db
    // ("To start a new session with ID: copilot --session-id=<valid-uuid>").
    // A crashed turn can still leave Tierwyn holding a plausible UUID (we
    // persist it as soon as the adapter exposes one), so resume only when the
    // id is BOTH a valid UUID AND registered; otherwise mint a fresh session.
    if (isUuid(config.nativeSessionId) && this._sessionRegistered(config.nativeSessionId)) {
      this._nativeSessionId = config.nativeSessionId;
      this._resuming = true;
    } else {
      this._nativeSessionId = randomUUID();
      this._resuming = false;
    }
  }

  async sendPrompt(
    text: string,
    attachments: Attachment[] = [],
    model?: string,
    effort?: EffortLevel,
    options?: PromptOptions,
  ): Promise<void> {
    this._turnProducedContent = false;
    this._stopping = false;
    // Resume only once the CLI has actually echoed a session id on a `result`
    // frame — i.e. a session really exists on its side. And when starting a
    // new session after a previous spawn on this instance (a crashed turn),
    // re-mint the id: the old one may have a stale session-state dir but no
    // store row, and --session-id must not resurrect it.
    const useResume = this._resuming || this._sessionEstablished;
    if (!useResume && this._hasSpawned) this._nativeSessionId = randomUUID();
    this._hasSpawned = true;
    const activeModel = model ?? this._model;
    const activeEffort = effort ?? this._effort;
    const prompt = capForArgvSpawn(withImagePathRefs(text, attachments));

    const args: string[] = [
      '-p', prompt,
      '--output-format', 'json',
      '--stream', 'on',
    ];
    if (useResume) args.push(`--resume=${this._nativeSessionId}`);
    else args.push('--session-id', this._nativeSessionId);
    if (this._cwd) args.push('-C', this._cwd);
    const hasConcreteModel = activeModel !== '' && activeModel !== 'auto';
    if (hasConcreteModel) args.push('--model', activeModel);
    // Effort + tools policy live in the helper so per-message options can
    // override profile effort and swap --allow-all for read_only.
    // The CLI's auto router rejects --effort; the helper keeps that guard.
    appendCopilotPromptOptionArgs(args, options, { hasConcreteModel, activeEffort });
    args.push(
      '--no-ask-user',
      '--no-remote-export',
      '--no-auto-update',
      '--disable-builtin-mcps',
      '--log-level', 'none',
    );
    for (const a of attachments) {
      if (a.tempPath) args.push('--attachment', a.tempPath);
    }

    if (this._sandboxed && !copilotTokenSource()?.trim()) {
      this._fail(COPILOT_SANDBOX_TOKEN_MISSING);
      return;
    }
    const child = this._spawnFn(this._bin, args, { cwd: this._cwd || undefined });
    this._child = child;

    let err = '';
    child.stderr?.on('data', (d: Buffer) => { err += d.toString(); });

    const streamState = createCopilotStreamState(this._resultFilesSeen);
    const rl = child.stdout ? createInterface({ input: child.stdout }) : null;
    rl?.on('line', (line) => {
      let frame: Record<string, unknown>;
      try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }
      this._ingestFrame(frame, streamState);
    });

    return new Promise<void>((resolve) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        rl?.close();
        this._child = null;
        fn();
        this._emitter.emit('end');
        resolve();
      };

      child.on('error', (e: Error) => {
        finish(() => this._fail(e.message));
      });
      child.on('close', (code: number | null) => {
        finish(() => this._onClose(code, err, streamState));
      });
    });
  }

  private _ingestFrame(frame: Record<string, unknown>, state: CopilotStreamState): void {
    if (frame.type === 'result' && typeof frame.sessionId === 'string' && frame.sessionId) {
      const sid = safeNativeSessionId(frame.sessionId);
      if (sid) this._nativeSessionId = sid;
      this._sessionEstablished = true;
    }
    for (const partial of mapCopilotFrame(frame, state)) {
      this._emit(partial);
      if (partial.type === 'tool_call') this._turnProducedContent = true;
      if (partial.type === 'message' && 'chunk' in partial.payload && partial.payload.chunk) {
        this._turnProducedContent = true;
      }
    }
  }

  private _onClose(code: number | null, err: string, state: CopilotStreamState): void {
    if (this._stopping) return;
    const lastErr = err.trim().split('\n').pop() ?? '';
    if (code !== 0 && code !== null) {
      this._fail(`copilot exited with code ${code}${lastErr ? `: ${lastErr}` : ''}`);
      return;
    }
    if (!this._turnProducedContent) {
      this._fail(
        `Copilot produced no output for this turn.${lastErr ? ` ${lastErr}` : ''}`,
      );
      return;
    }
    const usage = usageFromState(state);
    const occ = contextWindowOccupancy({
      inputTokens: usage.inputTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheCreationTokens: usage.cacheCreationTokens,
    });
    const contextWindowPct = computeContextWindowPct(occ, usage.maxPromptTokens || undefined);
    this._emit({
      type: 'status',
      payload: {
        status: 'done',
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheCreationTokens: usage.cacheCreationTokens,
        contextWindowPct,
      },
    });
  }

  async stop(): Promise<void> {
    this._stopping = true;
    try {
      this._child?.kill('SIGTERM');
      this._emit({ type: 'status', payload: { status: 'idle' } });
    } finally {
      this._child = null;
      this._emitter.emit('end');
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return [];
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    return [];
  }

  async loadSession(id: string): Promise<void> {
    if (isUuid(id) && this._sessionRegistered(id)) {
      this._nativeSessionId = id;
      this._resuming = true;
    } else {
      this._nativeSessionId = randomUUID();
      this._resuming = false;
    }
  }

  /** True when the CLI's session store actually knows this id. The
   *  session-state/<id> directories are NOT proof — a turn that crashes before
   *  any work still leaves one behind, and --resume of such an id exits 1. */
  private _sessionRegistered(id: string): boolean {
    if (!id) return false;
    try {
      const db = openAgentSqliteReadonly(join(this._copilotHome, 'session-store.db'));
      try {
        return !!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id);
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  }

  async isNativeSessionAvailable(id: string): Promise<boolean> {
    return isUuid(id) && this._sessionRegistered(id);
  }

  async oneShot(prompt: string, opts: OneShotOpts = {}): Promise<OneShotResult> {
    const mode: OneShotMode = opts.mode ?? 'none';
    if (opts.allowTools === true) {
      throw new Error('copilot oneShot refuses allowTools=true');
    }
    const modes: readonly OneShotMode[] = (this as AgentAdapter).oneShotModes ?? ['none'];
    if (!modes.includes(mode)) {
      throw new Error(`copilot oneShot does not support mode ${mode}`);
    }
    const cwd = opts.cwd?.trim();
    if (mode === 'read_only' && (!cwd || !isAbsolute(cwd))) {
      throw new Error('copilot oneShot read_only requires an absolute cwd');
    }
    const secs = opts.timeoutSecs ?? (mode === 'read_only' ? 120 : 60);
    const promptText = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
    const args: string[] = [
      '-p', promptText,
      '--output-format', 'json',
      '--stream', 'on',
      '--available-tools', mode === 'read_only' ? 'view,grep,glob' : '',
      '--no-ask-user',
      '--no-remote-export',
      '--no-auto-update',
      '--disable-builtin-mcps',
      '--log-level', 'none',
    ];
    if (opts.model && opts.model !== '' && opts.model !== 'auto') args.push('--model', opts.model);
    if (cwd) args.push('-C', cwd);
    for (const deny of DENY_TOOLS) args.push(`--deny-tool=${deny}`);
    if (mode === 'read_only') {
      args.push('--deny-tool=shell(*)', '--deny-tool=write');
    }

    const spawnOpts = { cwd: cwd || undefined };
    const child = this._customSpawn
      ? this._spawnFn(this._bin, args, spawnOpts)
      : nodeSpawn(this._bin, args, {
          cwd: spawnOpts.cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildChildEnv({
            COPILOT_AUTO_UPDATE: 'false',
            ...(opts.env as NodeJS.ProcessEnv | undefined),
          }, undefined, 'copilot'),
        });

    return new Promise<OneShotResult>((resolve, reject) => {
      const errChunks: Buffer[] = [];
      let text = '';
      let lastFrame: unknown;
      let toolInvoked = false;
      let disallowedTool: string | null = null;
      let settled = false;
      let killFollowup: ReturnType<typeof setTimeout> | undefined;

      child.stdin?.end();
      child.stderr?.on('data', (d: Buffer) => errChunks.push(d));

      const rl = child.stdout ? createInterface({ input: child.stdout }) : null;
      rl?.on('line', (line) => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        lastFrame = frame;
        if (frame.type === 'tool.execution_start') {
          const data = frame.data as Record<string, unknown> | undefined;
          const name = String(data?.toolName ?? 'tool');
          if (mode === 'none') {
            toolInvoked = true;
          } else if (mode === 'read_only') {
            if (!COPILOT_READONLY_TOOLS.has(name)) {
              disallowedTool = name;
            }
          }
        }
        if (frame.type === 'assistant.message') {
          const data = frame.data as { content?: unknown } | undefined;
          if (typeof data?.content === 'string' && data.content.trim()) text = data.content.trim();
        }
      });

      const finish = (error: Error | null, result?: OneShotResult, keepKill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (!keepKill && killFollowup) clearTimeout(killFollowup);
        rl?.close();
        if (error) reject(error);
        else resolve(result!);
      };

      const hardTimer = setTimeout(() => {
        child.kill('SIGTERM');
        killFollowup = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new Error(`copilot oneShot timed out after ${secs}s`));
        }, 2000);
        finish(new Error(`copilot oneShot timed out after ${secs}s`), undefined, true);
      }, secs * 1000);

      child.on('error', (e) => finish(e));
      child.on('close', (code) => {
        if (toolInvoked) {
          finish(new Error('copilot oneShot invoked a tool'));
          return;
        }
        if (disallowedTool) {
          finish(new Error(`copilot oneShot invoked disallowed tool "${disallowedTool}"`));
          return;
        }
        if (code && code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
          const lastErr = stderr.split('\n').pop() ?? '';
          finish(new Error(lastErr || `copilot oneShot exited with code ${code}`));
          return;
        }
        if (!text) {
          finish(new Error('copilot oneShot returned empty text'));
          return;
        }
        finish(null, { text, raw: lastFrame });
      });
    });
  }
}
