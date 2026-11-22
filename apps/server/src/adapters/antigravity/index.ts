/**
 * Antigravity adapter for Tierwyn — drives the `agy` CLI (v1.1.8+).
 *
 * One process per session: `--input-format stream-json --output-format
 * stream-json --print=` (empty print is required; a bare `--print` or a
 * non-empty `--print TEXT` dies). Turns are NDJSON `{event:user}` lines on
 * stdin. Mapping lives in mapping.ts. Print mode still caps the wait at 5m
 * unless we pass `--print-timeout` (we use 30m).
 *
 * `event: result` ends a *turn* (`status: done`) but not the session.
 * `'end'` fires when the child actually closes or `stop()` runs. Between
 * turns, `_runSteerLoop` parks on `getNextSteer` (hold-open, not live-inject).
 *
 * Native session support: agy stores one SQLite database per conversation at
 * `~/.gemini/antigravity-cli/conversations/<uuid>.db`. The conversation id is
 * on the stream-json `init`/`result` frames (preferred) and was historically
 * logged to stderr as `Created conversation <uuid>`. sendPrompt captures this
 * id, exposes it via the `nativeSessionId` getter, and re-emits
 * `status: running` so the persistence hook in sessionManager.ts picks it up.
 */

import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import { spawn as nodeSpawn } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { safeNativeSessionId } from '../sessionId.js';
import { escalateKill } from '../escalateKill.js';
import { createInterface } from 'readline';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import type { AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor, EffortLevel, PromptOptions, InteractionMode } from '@tierwyn/shared';
import { clampEffort, computeContextWindowPct, modelNameBakesEffort, modelRejectsEffort } from '@tierwyn/shared';
import { mapAgyChunk, AgyStreamMapper, agyConversationId, agySubagentLaunches } from './mapping.js';
import { enrichAgyMappedFileTools } from './fileToolParams.js';
import { probeAgyRateLimits, type ProbedRateLimits } from './probeUsage.js';
import { ReorderBuffer } from './reorder.js';
import { SubagentTailerSet } from './subagentTail.js';
import {
  attachStdinGuard,
  closeStdin,
  createStreamPipe,
  writeUserTurn,
  type StreamPipe,
} from './streamRpc.js';
import { scanSkillDirs, scanGeminiPluginSkills } from '../skillScan.js';

export { modelNameBakesEffort };

/** Known context-window sizes for Antigravity-served model families (agy does not report them). */
export function contextWindowForAgyModel(model: string): number | undefined {
  const m = model.toLowerCase();
  if (!m) return undefined;
  if (m.includes('gemini')) return 1_000_000;
  if (m.includes('claude')) return m.includes('1m') ? 1_000_000 : 200_000;
  if (m.includes('gpt')) return 200_000;
  return undefined;
}

export function detectPermissionBlock(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Ignore structured JSON frames: assistant text, tool calls, and tool results
  // often contain phrases like "awaiting approval", "permission denied", or
  // license text. Only unparsed plain-text CLI prompts/errors are permission blocks.
  if (trimmed.startsWith('{')) {
    try {
      JSON.parse(trimmed);
      return null;
    } catch {
      // Not valid JSON — fall through to plain-text regex
    }
  }
  if (/permission denied|requires approval|needs your approval|awaiting approval/i.test(trimmed)) {
    return 'The agent needed approval to continue, but this agent runs non-interactively in Tierwyn. '
      + 'Set its interaction mode to bypass, or run it interactively in a terminal.';
  }
  return null;
}

/** Fatal CLI lines on stderr that should surface as NormalisedEvent errors. */
export function detectAgyFatalStderr(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // Benign interrupt or cancel messages on stderr during stop/cancel
  if (/interrupt|abort|cancel|context canceled/i.test(trimmed)) return null;
  // agy prints "Error: …" for invalid model/effort and auth failures.
  if (/^Error:\s+/i.test(trimmed)) return trimmed;
  // printmode fatal path also logs this without the Error: prefix sometimes.
  if (/invalid model selection/i.test(trimmed)) return trimmed;
  return null;
}

export type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

export type RateLimitProbeFn = (opts: { model?: string; cwd?: string; force?: boolean }) => Promise<ProbedRateLimits>;

/** Default agy conversations dir. Override via constructor for tests. */
const DEFAULT_CONVERSATIONS_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'conversations');

/**
 * agy's project-id cache: maps an absolute workspace path -> a stable project
 * id. agy resolves the active project from this file ("discovered project … via
 * cache") and then SYNCS its workspace to that project's canonical root,
 * IGNORING the process cwd we pass via spawn().
 *
 * The cache can become polluted: when agy is launched from $HOME (e.g. the
 * Antigravity IDE desktop app, whose process cwd is $HOME), a sibling project
 * dir can be written with $HOME's project id. On the next launch agy resolves
 * that sibling dir to $HOME's project and switches its workspace to
 * /home/$user, so every tool call lands in the wrong directory. The repair in
 * sendPrompt() unwinds exactly that pollution. Override via constructor for
 * tests.
 */
const DEFAULT_PROJECTS_CACHE_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'projects.json');

/** agy's user settings; carries the persistent `toolPermission` policy. */
const DEFAULT_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');

/**
 * Tierwyn never passes --dangerously-skip-permissions (see sendPrompt), so a
 * headless `--print` agy denies every tool call unless settings.json carries
 * `"toolPermission": "always-proceed"`. A fresh host (hub or `tierwyn node`)
 * never has it, so add it when the key is absent. An explicit operator value
 * is left alone; a missing file is created; invalid JSON is left untouched.
 */
export async function ensureAgyAlwaysProceed(settingsPath: string): Promise<void> {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(await fs.readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings) || 'toolPermission' in settings) return;
  settings.toolPermission = 'always-proceed';
  try {
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  } catch {
    // Best-effort: agy then surfaces its own "denied by safety policy" error.
  }
}

/** Matches `Created conversation <uuid>` from agy's stderr (server.go:788). */
const CREATED_CONVERSATION_RE = /Created conversation ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * True when `maybeAncestor` is a strict ancestor directory of `dir` on the
 * filesystem (i.e. `dir` lives inside `maybeAncestor`). Both inputs are
 * resolved to absolute form first; root (`/`) counts as an ancestor of
 * everything. Uses path.relative so trailing-slash and `.` differences don't
 * cause false negatives. Used to detect the cache-pollution signature where a
 * subdir shares a project id with one of its ancestor dirs.
 */
function isAncestorDir(maybeAncestor: string, dir: string): boolean {
  const a = path.resolve(maybeAncestor);
  const d = path.resolve(dir);
  if (a === d) return false;
  const rel = path.relative(a, d);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export class AntigravityAdapter implements AgentAdapter {
  private _emitter = new EventEmitter();
  private _child: ChildProcess | null = null;
  private _sessionId = '';
  private _model = '';
  private _effort: EffortLevel | undefined = undefined;
  private _options: PromptOptions = {};
  private _cwd = '';
  private _resumeId = '';          // value of --conversation <id> when resuming
  private _nativeSessionId = '';   // captured during sendPrompt from stderr
  private _seq = 0;
  private _spawnTime = 0;          // used to disambiguate newest file in fallback scan
  private _getNextSteer?: SessionConfig['getNextSteer'];
  private _pipe: StreamPipe = createStreamPipe();
  private _steerLoopRunning = false;
  private _turnInFlight = false;
  private _turnSettled = true;
  private _turnResolve: (() => void) | null = null;
  private _activeModel = '';
  private _listenersBound = false;
  private _sawDone = false;
  private _explicitFinish = false;
  private _lastDoneUsage: Record<string, unknown> = {};
  private _lastTurnOccupancy = 0;
  private _mapper = new AgyStreamMapper();
  private _fatalStderrEmitted = false;
  private _permissionBlockEmitted = false;
  private _reorder = new ReorderBuffer<string>();
  private _finishingTurn: Promise<void> | null = null;
  private _exited: Promise<void> = Promise.resolve();
  private _stopped = false;
  private _sawInterruptStderr = false;

  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private readonly _bin: string;
  private readonly _conversationsDir: string;
  private readonly _projectsCachePath: string;
  private readonly _settingsPath: string | null;
  private readonly _probeRateLimits: RateLimitProbeFn;
  private readonly _subagentPollMs: number;
  private readonly _subagentMissingMs: number;
  private _subagentTails: SubagentTailerSet | null = null;
  private _interactionMode: InteractionMode;

  constructor(opts: {
    spawn?: SpawnFn;
    spawnFn?: SpawnFn;
    bin?: string;
    conversationsDir?: string;
    projectsCachePath?: string;
    /** null = never touch agy settings. Defaults to the real file only when spawnFn is not injected (tests). */
    settingsPath?: string | null;
    probeRateLimits?: RateLimitProbeFn;
    subagentPollMs?: number;
    subagentMissingMs?: number;
    interactionMode?: InteractionMode;
  } = {}) {
    const inner = opts.spawn ?? opts.spawnFn ?? nodeSpawn;
    this._spawn = (cmd, args, o) => inner(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'antigravity') });
    this._spawnFn = this._spawn;
    this._bin = opts.bin ?? 'agy';
    this._conversationsDir = opts.conversationsDir ?? DEFAULT_CONVERSATIONS_DIR;
    this._projectsCachePath = opts.projectsCachePath ?? DEFAULT_PROJECTS_CACHE_PATH;
    this._settingsPath = opts.settingsPath !== undefined ? opts.settingsPath : (opts.spawnFn ? null : DEFAULT_SETTINGS_PATH);
    this._probeRateLimits = opts.probeRateLimits ?? ((o) => probeAgyRateLimits(o));
    this._subagentPollMs = opts.subagentPollMs ?? 1500;
    this._subagentMissingMs = opts.subagentMissingMs ?? 30_000;
    this._interactionMode = opts.interactionMode ?? 'bypass';
  }

  /** Captured native conversation id (empty until observed on stderr). */
  get nativeSessionId(): string {
    return this._nativeSessionId;
  }

  streamEvents(): EventEmitter {
    return this._emitter;
  }

  private _emit(event: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    const full: NormalisedEvent = {
      ...event,
      sessionId: this._sessionId,
      seq: ++this._seq,
      ts: Date.now(),
    } as NormalisedEvent;
    this._emitter.emit('event', full);
  }

  async start(config: SessionConfig): Promise<void> {
    this._sessionId = config.sessionId;
    this._model = config.model ?? '';
    this._effort = config.effort;
    this._options = {};
    this._cwd = config.cwd ?? '';
    this._resumeId = safeNativeSessionId(config.nativeSessionId) ?? '';
    this._nativeSessionId = this._resumeId;
    this._seq = 0;
    this._child = null;
    this._getNextSteer = config.getNextSteer;
    this._pipe = createStreamPipe();
    this._steerLoopRunning = false;
    this._turnInFlight = false;
    this._turnSettled = true;
    this._turnResolve = null;
    this._listenersBound = false;
    this._finishingTurn = null;
    this._sawDone = false;
    this._explicitFinish = false;
    this._lastDoneUsage = {};
    this._mapper = new AgyStreamMapper();
    this._fatalStderrEmitted = false;
    this._permissionBlockEmitted = false;
    this._reorder = new ReorderBuffer<string>();
    this._stopped = false;
    this._sawInterruptStderr = false;
  }

  async sendPrompt(text: string, attachments: Attachment[] = [], model?: string, effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    this._sawInterruptStderr = false;
    this._effort = effort ?? this._effort;
    this._options = options ?? {};
    const effectiveModel = model ?? this._model;
    if (model && model !== this._model) {
      this._model = model;
    }
    this._activeModel = effectiveModel;

    // Follow-up on the live child: same stdin, no second spawn.
    if (this._child && !this._pipe.stdinClosed) {
      // Defensive: SessionManager rejects prompt options on in-flight turns before steering,
      // so this branch is structurally unreachable in normal server dispatch.
      if (options && Object.keys(options).length > 0) {
        this._emit({
          type: 'error',
          payload: {
            message: 'Prompt options could not be applied: this agy process is already running '
                   + 'with fixed flags. Stop the session and resend.',
          },
        });
      }
      this._emit({ type: 'status', payload: { status: 'running' } });
      const turn = this._armTurn();
      if (!writeUserTurn(this._child.stdin, this._pipe, text, attachments)) {
        this._emit({ type: 'error', payload: { message: 'agy stdin is closed' } });
        this._emit({ type: 'status', payload: { status: 'error' } });
        this._settleTurn();
        return;
      }
      await turn;
      return;
    }

    const activeEffort = clampEffort('antigravity', this._effort);

    // Reset capture state. _spawnTime is used by the close-handler fallback to
    // disambiguate which .db file was created by THIS invocation.
    this._nativeSessionId = this._resumeId;  // carry through if resuming
    this._spawnTime = Date.now();
    this._pipe = createStreamPipe();
    this._steerLoopRunning = false;
    this._fatalStderrEmitted = false;
    this._permissionBlockEmitted = false;
    this._mapper = new AgyStreamMapper();
    this._reorder = new ReorderBuffer<string>();
    this._listenersBound = false;

    // Repair agy's project-id cache before spawning: agy resolves the workspace
    // from this cache and can misroute our cwd to an ancestor's project root
    // when the cache is polluted (see _repairProjectsCache). Best-effort, runs
    // before spawn because agy re-resolves from the cache at process start.
    await this._repairProjectsCache(this._cwd);
    if (this._settingsPath) await ensureAgyAlwaysProceed(this._settingsPath);

    // agy has TWO workspace concepts that must BOTH be set, else tool calls
    // land in ~/.gemini/antigravity-cli/scratch:
    //   1. workspaceDirs — set by --add-dir=<cwd>. Determines where agy looks
    //      for project files (skills, knowledge, etc).
    //   2. project ID — agy reads cache/default_project_id.txt (literal value
    //      "default-cli-project") and dynamically switches the active project
    //      to it ("synced active project to Default Project from conversation
    //      switch" — agy log). Tools inherit the project's configured workspace,
    //      which for "Default Project" is the scratch dir, NOT our cwd.
    //      --project <id> overrides this; we pass the project id agy already
    //      cached for this cwd (from projects.json). If the id is missing
    //      (first launch against an uncached cwd), --add-dir alone still
    //      works for the workspaceDirs concept; agy will write a fresh entry
    //      to projects.json on success and subsequent launches will have it.
    //
    // Resume (--conversation) ignores BOTH --add-dir and --project and reuses
    // the original conversation's project root — that's agy's design, not our
    // bug, so we only emit these flags for fresh conversations.
    const projectId = !this._resumeId ? await this._readProjectIdForCwd(this._cwd) : '';

    // No --dangerously-skip-permissions: agy's settings.json sets
    // "toolPermission": "always-proceed" (ensured above by
    // ensureAgyAlwaysProceed), the persistent equivalent. Passing
    // the CLI flag on top embeds the literal token in agy's system prompt to
    // Gemini, triggering hallucinations.
    //
    // stream-json input reads prompts from stdin. `--print` still needs a
    // value: bare `--print` dies (`flag needs an argument`); non-empty
    // `--print TEXT` dies (`reads prompts from stdin, so a prompt given on
    // the command line would be ignored`). Empty `--print=` is the working
    // print-mode flag (F6-SPIKE). Never pass the user text as a positional.
    //
    // Flag order:
    //   --add-dir=<cwd> and --project <id> MUST come before --model and
    //   --conversation: agy's flag parser mis-parses the `=` form when --model
    //   precedes it (verified on 1.0.13: --model X --add-dir=Y breaks).
    //   `--print=` last matches the live stay-open argv.
    //
    // agy has no dedicated image/PDF/audio flag; Gemini/agy resolve `@<path>`
    // mentions against the local fs. Those refs go in the stdin envelope
    // `content`, not argv.
    const args: string[] = [
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
    ];
    if (this._cwd) args.push(`--add-dir=${this._cwd}`);
    if (projectId) args.push('--project', projectId);
    // agy --print defaults to --print-timeout 5m. Coding turns (tools then
    // a long final generation, or async pytest) routinely exceed that and
    // die with "Error: timeout waiting for response" — confirmed on DownTube
    // "Missing thumbnail" (printmode.go: 1497 polls / ~5m). Raise it; keep
    // the flag after --add-dir/--project so agy's parser does not mis-bind.
    args.push('--print-timeout', '30m');
    if (effectiveModel) args.push('--model', effectiveModel);
    // agy 1.1.27 accepts --effort <low|medium|high>. Skip it when the model
    // string passed as --model already encodes the level (slug suffix or
    // parenthetical display), or when the model rejects the flag outright
    // (Claude Thinking rows: "--effort is not supported for model …").
    if (activeEffort && !modelNameBakesEffort(effectiveModel) && !modelRejectsEffort('antigravity', effectiveModel)) {
      args.push('--effort', activeEffort);
    }
    // ── per-turn options (argv-bound; only reachable on a fresh spawn) ──
    const mode = this._options['mode'];
    if (mode === 'plan' || mode === 'accept-edits') args.push('--mode', mode);
    else if (this._interactionMode === 'questions') args.push('--mode', 'accept-edits');
    if (this._options['sandbox'] === true) args.push('--sandbox');
    if (this._options['disableSlashCommands'] === true) args.push('--disable-slash-commands');
    const schema = this._options['jsonSchema'];
    if (typeof schema === 'string' && schema) args.push('--json-schema', schema);

    if (this._resumeId) args.push('--conversation', this._resumeId);
    args.push('--print=');

    const child = this._spawnFn(this._bin, args, { cwd: this._cwd || undefined });
    this._child = child;
    this._exited = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      child.once('error', () => resolve());
    });
    this._subagentTails?.stopAll();
    this._subagentTails = new SubagentTailerSet({
      emit: (ev) => this._emit(ev),
      pollMs: this._subagentPollMs,
      missingMs: this._subagentMissingMs,
    });

    // Emit running status before touching stdio, so the UI shows activity immediately.
    this._emit({ type: 'status', payload: { status: 'running' } });

    if (!child.stdin) {
      this._emit({ type: 'error', payload: { message: 'agy subprocess has no stdin' } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._emitter.emit('end');
      return;
    }

    attachStdinGuard(child.stdin, this._pipe);
    this._attachSessionIo(child);

    const turn = this._armTurn();
    if (!writeUserTurn(child.stdin, this._pipe, text, attachments)) {
      this._emit({ type: 'error', payload: { message: 'agy stdin is closed' } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._settleTurn();
      return;
    }
    await turn;
  }

  private _armTurn(): Promise<void> {
    this._turnInFlight = true;
    this._turnSettled = false;
    this._sawDone = false;
    this._explicitFinish = false;
    this._lastDoneUsage = {};
    return new Promise<void>((resolve) => {
      this._turnResolve = resolve;
    });
  }

  private _settleTurn(): void {
    this._turnInFlight = false;
    if (this._turnSettled) return;
    this._turnSettled = true;
    const resolve = this._turnResolve;
    this._turnResolve = null;
    resolve?.();
  }

  /**
   * After a successful turn `result`: overlay rate limits, settle sendPrompt,
   * then park on getNextSteer (kimi-style — not at the first stdin write).
   * Unrecovered ERROR closes stdin so the child exits and `'end'` can fire.
   */
  private async _completeTurn(): Promise<void> {
    try {
      if (this._sawDone) {
        await this._overlayRateLimits(this._activeModel, this._lastDoneUsage);
      }
    } finally {
      this._settleTurn();
      if (this._sawDone && this._getNextSteer && !this._pipe.stdinClosed) {
        void this._runSteerLoop().catch(() => { /* loop exit is benign */ });
      } else if (!this._sawDone && !this._pipe.stdinClosed && this._child) {
        closeStdin(this._child.stdin, this._pipe);
      }
    }
  }

  /**
   * Hold-open steer loop. Started after the first successful `result`, not at
   * the first stdin write (a mid-turn second line is buffered by agy and only
   * processed after `result` — F6-SPIKE). Park on getNextSteer; on a non-null
   * item write the next user envelope and wait for that turn's result before
   * parking again. Null → close stdin so agy exits 0.
   */
  private async _runSteerLoop(): Promise<void> {
    if (this._steerLoopRunning) return;
    if (!this._getNextSteer) return;
    this._steerLoopRunning = true;
    try {
      while (this._child && !this._pipe.stdinClosed && this._getNextSteer) {
        let next: { text: string; attachments?: Attachment[] } | null;
        try {
          next = await this._getNextSteer();
        } catch {
          break;
        }
        if (!next) {
          closeStdin(this._child?.stdin, this._pipe);
          return;
        }
        if (!this._child || this._pipe.stdinClosed) return;
        this._emit({ type: 'status', payload: { status: 'running' } });
        const turn = this._armTurn();
        if (!writeUserTurn(this._child.stdin, this._pipe, next.text, next.attachments ?? [])) {
          this._settleTurn();
          break;
        }
        await turn;
        if (!this._sawDone) break;
      }
    } finally {
      this._steerLoopRunning = false;
    }
  }

  private _attachSessionIo(child: ChildProcess): void {
    if (this._listenersBound) return;
    this._listenersBound = true;

    // Watch stderr for the conversation-id line and fatal CLI errors. agy logs
    // `Created conversation <uuid>` at startup (server.go:788). When observed,
    // persist locally and re-emit `status: running` so sessionManager picks up
    // the id (its hook reads `adapter.nativeSessionId` on every running event).
    // Fatal lines (invalid model/effort, auth) must surface — otherwise a failed
    // --print exits with empty stdout and the UI shows a silent empty turn.
    if (child.stderr) {
      const stderrRl = createInterface({ input: child.stderr });
      stderrRl.on('line', (line) => {
        if (this._stopped) return;
        const trimmed = line.trim();
        if (/interrupt|abort|cancel|context canceled/i.test(trimmed)) {
          this._sawInterruptStderr = true;
          return;
        }
        const permMsg = detectPermissionBlock(line);
        if (permMsg && !this._permissionBlockEmitted) {
          this._permissionBlockEmitted = true;
          this._emit({ type: 'error', payload: { message: permMsg } });
        }
        const fatal = detectAgyFatalStderr(line);
        if (fatal && !this._fatalStderrEmitted) {
          this._fatalStderrEmitted = true;
          this._emit({ type: 'error', payload: { message: fatal } });
        }
        // Skip when resuming (keep the resume id) or when already captured.
        if (this._resumeId || this._nativeSessionId) return;
        const m = line.match(CREATED_CONVERSATION_RE);
        if (!m) return;
        const captured = safeNativeSessionId(m[1]);
        if (!captured) return;
        this._nativeSessionId = captured;
        this._emit({ type: 'status', payload: { status: 'running' } });
      });
    }

    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => this._onStdoutLine(line));

    child.on('error', (err) => {
      this._subagentTails?.stopAll();
      this._subagentTails = null;
      for (const f of this._reorder.flush()) {
        for (const partial of mapAgyChunk(f)) this._emit(partial);
      }
      this._pipe.stdinClosed = true;
      if (this._stopped) {
        this._settleTurn();
        this._emitter.emit('end');
        return;
      }
      this._emit({ type: 'error', payload: { message: err.message } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._settleTurn();
      this._emitter.emit('end');
    });

    child.on('close', (code) => {
      void this._onChildClose(code);
    });
  }

  private _onStdoutLine(line: string): void {
    if (this._stopped) return;

    const trimmed = line.trim();
    if (trimmed.startsWith('{')) {
      try {
        const frame = JSON.parse(trimmed) as Record<string, unknown>;
        if (typeof frame.event === 'string') {
          const id = agyConversationId(frame);
          if (id && !this._resumeId && !this._nativeSessionId) {
            const captured = safeNativeSessionId(id);
            if (captured) {
              this._nativeSessionId = captured;
              this._emit({ type: 'status', payload: { status: 'running' } });
            }
          }
          const launches = agySubagentLaunches(frame);
          const mapped = enrichAgyMappedFileTools(this._mapper.map(frame), frame, {
            conversationsDir: this._conversationsDir,
          });
          const emitPartial = (partial: typeof mapped[number]): void => {
            if (partial.type === 'status') {
              this._explicitFinish = true;
              const { status, ...rest } = partial.payload as Record<string, unknown>;
              // Hold the mapper's terminal `done`: emitting it here AND again
              // after the probe gives every clean turn TWO status:done events —
              // sessionManager fires recordAutoCheckpoint per done (deduped by
              // eventId only), doubling checkpoints + code snapshots. Carry the
              // WHOLE payload (not a token subset) and emit ONE merged done on
              // the result so no field (cost, context %, future) is lost.
              if (status === 'done') { this._sawDone = true; this._lastDoneUsage = rest; return; }
              if (status === 'error') this._sawDone = false;
            }
            this._emit(partial);
          };
          // Parent invoke_subagent tool_call first, then start tailing so
          // nested events land under the card. agy marks the subagent step
          // DONE at launch — the card stays open and is closed by stopAll()
          // on the result frame, BEFORE the final message is emitted below,
          // so nested events always precede the parent's answer.
          for (const partial of mapped) {
            if (partial.type === 'tool_call') emitPartial(partial);
          }
          if (launches) {
            for (const s of launches.subagents) {
              this._subagentTails?.ensure(s, launches.parentToolUseId);
            }
          }
          if (frame.event === 'result') {
            const occ = this._mapper.getLastTurnOccupancy();
            if (occ > 0) this._lastTurnOccupancy = occ;
            this._subagentTails?.stopAll();
            this._mapper = new AgyStreamMapper();
          }
          if (frame.event === 'result' && this._sawInterruptStderr) {
            const res = (frame.result && typeof frame.result === 'object') ? frame.result as Record<string, unknown> : {};
            if (res.status !== 'SUCCESS') {
              this._explicitFinish = true;
              this._sawDone = true;
              this._emit({ type: 'message', payload: { chunk: '', final: true } });
              this._emit({ type: 'status', payload: { status: 'done', cause: 'operator_interrupt' } });
              this._finishingTurn = this._completeTurn();
              return;
            }
          }
          for (const partial of mapped) {
            if (partial.type !== 'tool_call') emitPartial(partial);
          }
          if (frame.event === 'result') {
            this._finishingTurn = this._completeTurn();
          }
          return;
        }
      } catch {
        // Not JSON — fall through to plain-text mapping.
      }
    }

    const permMsg = detectPermissionBlock(line);
    if (permMsg && !this._permissionBlockEmitted) {
      this._permissionBlockEmitted = true;
      this._emit({ type: 'error', payload: { message: permMsg } });
    }

    const frames = this._reorder.push({ value: line });
    for (const f of frames) {
      for (const partial of mapAgyChunk(f)) {
        this._emit(partial);
      }
    }
  }

  private async _onChildClose(code: number | null): Promise<void> {
    this._pipe.stdinClosed = true;
    this._subagentTails?.stopAll();
    this._subagentTails = null;
    for (const f of this._reorder.flush()) {
      for (const partial of mapAgyChunk(f)) this._emit(partial);
    }

    // Fallback: if stream-json init / stderr scrape didn't yield a
    // conversation id, pick the newest .db file whose mtime is at/after
    // spawnTime. Only do this when not resuming.
    if (!this._nativeSessionId && !this._resumeId) {
      const fallback = await this._findNewestConversationSince(this._spawnTime);
      if (fallback) {
        const captured = safeNativeSessionId(fallback);
        if (captured) {
          this._nativeSessionId = captured;
          this._emit({ type: 'status', payload: { status: 'running' } });
        }
      }
    }

    // Result lines are often parsed on the tick after write()+close(). Await
    // that turn's overlay so we do not emit a second status:done here.
    await Promise.resolve();
    if (this._finishingTurn) {
      await this._finishingTurn;
      this._finishingTurn = null;
    }

    if (!this._turnSettled) {
      const isInterruptCode = code === 130 || code === 143;
      if (typeof code === 'number' && code !== 0 && !this._stopped && !isInterruptCode) {
        if (!this._fatalStderrEmitted) {
          this._emit({
            type: 'error',
            payload: { message: `agy exited with code ${code}` },
          });
        }
        this._emit({ type: 'status', payload: { status: 'error' } });
      } else {
        if (this._stopped || isInterruptCode) {
          this._emit({ type: 'status', payload: { status: 'done', cause: 'operator_interrupt' } });
        } else {
          if (!this._explicitFinish) {
            this._emit({ type: 'message', payload: { chunk: '', final: true } });
            this._sawDone = true;
          }
          if (this._sawDone) await this._overlayRateLimits(this._activeModel, this._lastDoneUsage);
        }
      }
      this._settleTurn();
    }
    this._child = null;
    this._emitter.emit('end');
  }

  /**
   * Repair agy's project-id cache pollution before spawning.
   *
   * agy resolves the active project by looking the workspace path up in
   * ~/.gemini/antigravity-cli/cache/projects.json and, once found, "syncs" its
   * workspace to that project's canonical root directory — IGNORING the process
   * cwd we pass via spawn(). If our cwd was ever written with the SAME project
   * id as one of its ancestor dirs (a known pollution mode, see
   * DEFAULT_PROJECTS_CACHE_PATH), agy resolves cwd to the ancestor and every
   * tool call lands in the wrong directory (e.g. /home/$user instead of the
   * project).
   *
   * Fix: when cwd's cached id is ALSO mapped to an ancestor of cwd, delete the
   * cwd entry so agy re-resolves it from scratch (creating a fresh, correct
   * project id on its next launch). No-op when there is no conflict, when the
   * cache is missing/unreadable, or when cwd is empty. Best-effort: any I/O or
   * parse error is swallowed so a corrupt cache can never abort a handoff.
   */
  private async _repairProjectsCache(cwd: string): Promise<void> {
    if (!cwd) return;
    try {
      const raw = await fs.readFile(this._projectsCachePath, 'utf8');
      const projects = JSON.parse(raw) as Record<string, string>;
      const cwdId = projects[cwd];
      if (!cwdId) return;                         // cwd not cached — nothing to repair
      // Conflict iff some ancestor of cwd shares cwd's project id.
      const polluted = Object.keys(projects).some(
        (other) => other !== cwd && projects[other] === cwdId && isAncestorDir(other, cwd),
      );
      if (!polluted) return;
      delete projects[cwd];
      await fs.writeFile(this._projectsCachePath, JSON.stringify(projects, null, 2));
    } catch {
      // Missing file / invalid JSON / write failure — leave the cache alone.
      // Better to spawn against a possibly-stale cache than to throw and abort
      // the handoff; agy rewrites the file on its next successful launch.
    }
  }

  /**
   * Read the project id agy has cached for `cwd` in projects.json. Returns
   * empty string when the file is missing, invalid, or cwd is not yet cached.
   * Used to pass `--project <id>` so agy doesn't fall back to the
   * `default-cli-project` (scratch) project for tool-cwd resolution.
   *
   * Best-effort: any error returns '' and we just skip the --project flag,
   * leaving agy to resolve against default-cli-project (the buggy historical
   * behaviour). agy will write a fresh projects.json entry on a successful
   * launch against this cwd, so subsequent launches will pick up the id.
   */
  private async _readProjectIdForCwd(cwd: string): Promise<string> {
    if (!cwd) return '';
    try {
      const raw = await fs.readFile(this._projectsCachePath, 'utf8');
      const projects = JSON.parse(raw) as Record<string, string>;
      return projects[cwd] ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Scan the conversations dir for the newest .db file with mtime >= since - TOLERANCE_MS.
   * Returns the conversation id (filename without extension), or null if none.
   *
   * The 2s tolerance absorbs clock skew between Date.now() and filesystem mtimeMs:
   * we have observed the file's mtime land up to ~1ms BEFORE the JS spawn timestamp
   * despite being written after, due to filesystem clock quantisation. The fallback
   * is best-effort anyway (only runs when stderr capture failed), so a slightly-looser
   * window is preferable to flapping on precision.
   */
  private async _findNewestConversationSince(since: number): Promise<string | null> {
    const TOLERANCE_MS = 2000;
    const threshold = since - TOLERANCE_MS;
    try {
      const entries = await fs.readdir(this._conversationsDir);
      const candidates: { id: string; mtime: number }[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.db')) continue;
        const full = path.join(this._conversationsDir, entry);
        try {
          const st = await fs.stat(full);
          if (st.mtimeMs >= threshold) {
            candidates.push({ id: entry.replace(/\.db$/, ''), mtime: st.mtimeMs });
          }
        } catch {
          // ignore stat errors on individual files
        }
      }
      if (candidates.length === 0) return null;
      candidates.sort((a, b) => b.mtime - a.mtime);
      return candidates[0].id;
    } catch {
      return null;
    }
  }

  private async _overlayRateLimits(
    model: string,
    tokens: Record<string, unknown>,
  ): Promise<void> {
    let live: ProbedRateLimits = {};
    try {
      live = await this._probeRateLimits({ model, cwd: this._cwd || undefined });
    } catch {
      // Probe failed — still emit the held terminal done with stored tokens;
      // GET /usage can retry the probe later.
    }
    this._emit({
      type: 'status',
      payload: {
        status: 'done',
        ...tokens,
        ...this.getLiveContextWindowUsage(),
        ...live,
      },
    });
  }

  getLiveContextWindowUsage(): { contextWindowPct?: number; contextWindowSize?: number } {
    const windowSize = contextWindowForAgyModel(this._activeModel);
    if (!windowSize || this._lastTurnOccupancy <= 0) return {};
    const contextWindowPct = computeContextWindowPct(this._lastTurnOccupancy, windowSize);
    return { contextWindowPct, contextWindowSize: windowSize };
  }

  async setPermissionMode(mode: InteractionMode): Promise<void> {
    this._interactionMode = mode;
  }

  /**
   * Presence gate for SessionManager `injectable` (`profile.steer && typeof
   * adapter.steer === 'function'`). The live write is `_runSteerLoop` via
   * `getNextSteer`; this is the same no-op-or-legacy-write contract as
   * claude-code. SessionManager never awaits this on the parked path.
   */
  async steer(text: string, attachments: Attachment[] = []): Promise<void> {
    if (this._pipe.stdinClosed) return;
    const stdin = this._child?.stdin;
    if (!stdin || stdin.destroyed) return;
    this._emit({ type: 'status', payload: { status: 'running' } });
    writeUserTurn(stdin, this._pipe, text, attachments);
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this._subagentTails?.stopAll();
    this._subagentTails = null;
    const child = this._child;
    // Spike: stdin close while idle → exit 0; SIGTERM mid-stream → ERROR
    // `stream input cancelled: context canceled`, exit 1.
    if (this._turnInFlight) {
      this._pipe.stdinClosed = true;
      child?.kill('SIGTERM');
      escalateKill(child, { group: false });
    } else {
      closeStdin(child?.stdin, this._pipe);
    }
    // Bounded await: race child close against a ~2s timer so an immediate respawn
    // never races the dying agy process over the conversation SQLite DB, without unbounded hangs.
    if (child) {
      await Promise.race([
        this._exited,
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    }
    this._emit({ type: 'status', payload: { status: 'idle' } });
    this._child = null;
    this._settleTurn();
    // Defensive: emit 'end' so sessionManager's once('end') cleanup fires
    // immediately. The subprocess close handler may emit again later — the
    // once listener makes the duplicate a no-op.
    this._emitter.emit('end');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return new Promise<ModelDescriptor[]>((resolve, reject) => {
      const child = this._spawnFn(this._bin, ['models'], {});
      const chunks: string[] = [];

      // agy models blocks on stdin when it is an open pipe. Closing it immediately
      // signals EOF and lets the process exit after printing its model list.
      child.stdin?.on('error', () => {}); // async EPIPE must not crash the server
      child.stdin?.end();

      // Safety net: kill if the process still hasn't exited after 15s.
      const hardTimer = setTimeout(() => child.kill('SIGTERM'), 15_000);

      child.stdout?.on('data', (d: Buffer) => chunks.push(d.toString()));

      child.on('error', (err) => {
        clearTimeout(hardTimer);
        reject(err);
      });

      child.on('close', () => {
        clearTimeout(hardTimer);
        const lines = chunks
          .join('')
          .split('\n')
          .map((l) => l.trim())
          // Drop auth/error noise — `agy models` emits "Error: Please Sign in to view
          // available models" (or similar) to stdout when unauthenticated; without this
          // filter the error string becomes a fake model row in the catalogue.
          .filter((l) =>
            l.length > 0 &&
            !/^error\b/i.test(l) &&
            !/please sign in/i.test(l) &&
            !/\bsign[ -]?in\b/i.test(l),
          );

        resolve(lines.map((line) => {
          // agy 1.1.x emits "<slug>\t<display label>" per line, e.g.
          //   gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)
          // The slug is what --model accepts; the display label is what we show
          // in the picker. Earlier agy versions emitted just the display label
          // as the whole line — keep supporting that shape. agy slugs never
          // contain tabs, so splitting on the first tab is unambiguous. If we
          // passed the whole line as `name`, the contaminated id reached --model
          // verbatim and agy rejected it ("model … is not recognized as a known
          // model").
          const tabIdx = line.indexOf('\t');
          const slug = tabIdx >= 0 ? line.slice(0, tabIdx).trim() : line;
          const display = tabIdx >= 0 ? line.slice(tabIdx + 1).trim() : line;
          const desc: ModelDescriptor = {
            name: slug,
            label: `Antigravity · ${display}`,
            provider: 'antigravity',
            // Gemini and Claude models support vision in the agy catalogue.
            // Match on `display` so both the legacy plain-label form and the
            // new slug form classify correctly.
            vision: display.startsWith('Gemini') || display.startsWith('Claude'),
            steer: true,
          };
          // Deliberately NO `contextWindow` on the descriptor. listModels()
          // feeds sessionManager.getTargetContextWindow (handoff compaction),
          // which does `hit?.contextWindow ?? Infinity`; advertising real
          // windows here would silently change WHEN compaction auto-fallback
          // fires — the FW-7 D6 behaviour change that stays deferred. Windows
          // live only in `contextWindowForAgyModel` (usage % via
          // _resolveContextWindow), which never reaches the handoff path.
          return desc;
        }));
      });
    });
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    const directSkills = scanSkillDirs([
      path.join(os.homedir(), '.gemini', 'skills'),
      path.join(os.homedir(), '.gemini', 'config', 'skills'),
      path.join(os.homedir(), '.gemini', 'antigravity', 'skills'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'builtin', 'skills'),
    ]);
    const pluginSkills = scanGeminiPluginSkills(path.join(os.homedir(), '.gemini', 'config', 'plugins'));
    const seen = new Set<string>();
    const out: CommandDescriptor[] = [];
    for (const cmd of [...directSkills, ...pluginSkills]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      out.push(cmd);
    }
    return out;
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const prefix = `/${name}`;
    await this.sendPrompt(args?.trim() ? `${prefix} ${args}` : prefix, [], undefined, undefined, options);
  }

  /**
   * Enumerate native conversations from `~/.gemini/antigravity-cli/conversations/`.
   * Sorted newest-first by mtime. The summary is the conversation id itself —
   * agy's SQLite schema is undocumented, so we don't extract a title.
   */
  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    try {
      const entries = await fs.readdir(this._conversationsDir);
      const out: { id: string; summary: string; createdAt?: number }[] = [];
      for (const entry of entries) {
        if (!entry.endsWith('.db')) continue;
        const full = path.join(this._conversationsDir, entry);
        try {
          const st = await fs.stat(full);
          const id = entry.replace(/\.db$/, '');
          out.push({ id, summary: id, createdAt: st.mtimeMs });
        } catch {
          // ignore stat errors on individual files
        }
      }
      out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return out;
    } catch {
      return [];
    }
  }

  /**
   * Store the conversation id so the next sendPrompt resumes it via --conversation <id>.
   */
  async loadSession(id: string): Promise<void> {
    this._resumeId = safeNativeSessionId(id) ?? '';
    this._nativeSessionId = this._resumeId;
  }

  /**
   * Verify that the native conversation file still exists on disk.
   */
  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId) return false;
    try {
      const file = path.join(this._conversationsDir, `${nativeSessionId}.db`);
      await fs.access(file);
      return true;
    } catch {
      return false;
    }
  }
}
