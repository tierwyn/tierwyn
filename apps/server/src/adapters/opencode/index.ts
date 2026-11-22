import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import { homedir } from 'os';
import { join } from 'path';
import { exec, spawn as nodeSpawn } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { termChildProcess } from '../../sandbox/bwrap.js';
import { promisify } from 'util';
import type { ChildProcess } from 'child_process';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor,
  EffortLevel, PromptOptions,
} from '@tierwyn/shared';
import { mapOpenCodeEvent, usageFromOpenCodeFrame } from './mapping.js';
import { scanSkillDirs, scanCommandTemplateDir } from '../skillScan.js';
import { capForArgvSpawn } from '../../compaction/primingCap.js';
import { openAgentSqliteReadonly } from '../agentSqlite.js';
import { safeNativeSessionId } from '../sessionId.js';

const execAsync = promisify(exec);

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) => ChildProcess;

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

/**
 * Path to the opencode native SQLite session store.
 * We read sessions via the CLI (`opencode session list`), NOT by querying this DB directly.
 * Isolated here as a single constant so it can be overridden in tests or docs.
 */
export const OPENCODE_DB_PATH = join(homedir(), '.local', 'share', 'opencode', 'opencode.db');

const OPENCODE_VARIANTS = new Set(['minimal', 'low', 'high', 'max']);

/** Append per-turn OpenCode/KiloCode prompt-option flags after `--format json`. */
export function appendOpenCodePromptOptionArgs(args: string[], options?: PromptOptions | null): void {
  if (!options) return;
  const variant = options['variant'];
  if (typeof variant === 'string' && OPENCODE_VARIANTS.has(variant)) {
    args.push('--variant', variant);
  }
  if (options['thinking'] === true) args.push('--thinking');
  if (options['pure'] === true) args.push('--pure');
  const agent = options['agent'];
  if (typeof agent === 'string' && agent.trim()) args.push('--agent', agent);
}

type InnerSpawn = (cmd: string, args: string[], opts: import('child_process').SpawnOptions) => ChildProcess;

function defaultSpawn(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  spawnImpl: InnerSpawn = nodeSpawn,
  agentType = 'opencode',
): ChildProcess {
  // Spawn the child in its own process group (`detached: true` makes the child
  // a pgrp leader via setpgid(0,0) before exec). This is critical: the opencode
  // Go binary contains signal-handling code that can deliver SIGKILL to its own
  // process group on fatal exit. Without detachment, that group is the parent's
  // group too, so the parent (Tierwyn server) dies silently with no catchable
  // signal, no apport core, and no journal entry — exactly the crash signature
  // we have been chasing.
  return spawnImpl(cmd, args, {
    cwd: opts.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: buildChildEnv(opts.env, opts.cwd, agentType),
  });
}

export class OpenCodeAdapter implements AgentAdapter {
  private _emitter = new EventEmitter();
  private _sessionId = '';
  private _nativeSessionId = '';
  private _resumeSessionId = '';
  private _model = '';
  private _cwd = '';
  private _seq = 0;
  private _child: ChildProcess | null = null;
  private _explicitFinish = false;
  private _trustRepoConfig = false;
  private _usage: Partial<Extract<NormalisedEvent, { type: 'status' }>['payload']> = {};

  private readonly _bin: string;
  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private readonly _label: string;
  private readonly _configDir: string;
  private readonly _dbPath: string;
  private readonly _skillDirs: string[];

  constructor(opts: { spawn?: SpawnFn; spawnFn?: SpawnFn; bin?: string; label?: string; configDir?: string; dbPath?: string; skillDirs?: string[]; agentType?: string } = {}) {
    this._bin = opts.bin ?? 'opencode';
    const inner = (opts.spawn ?? opts.spawnFn ?? nodeSpawn) as InnerSpawn;
    this._spawnFn = (c, a, o) => defaultSpawn(c, a, o, inner, opts.agentType);
    this._spawn = this._spawnFn;
    this._label = opts.label ?? 'OpenCode';
    this._configDir = opts.configDir ?? join(homedir(), '.config', 'opencode');
    this._dbPath = opts.dbPath ?? join(homedir(), '.local', 'share', 'opencode', 'opencode.db');
    // Extra skill directories beyond <configDir>/skills. Kilo loads personal
    // skills from ~/.kilo/skills and ~/.agents/skills (agentskills.io), not
    // from the XDG config dir, so kilocode passes both here.
    this._skillDirs = opts.skillDirs ?? [];
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
    this._model = config.model;
    this._cwd = config.cwd ?? '';
    this._resumeSessionId = safeNativeSessionId(config.nativeSessionId) ?? '';
    this._nativeSessionId = '';
    this._seq = 0;
    this._child = null;
    this._explicitFinish = false;
    this._trustRepoConfig = config.trustRepoConfig === true;
    this._usage = {};
  }

  async sendPrompt(
    text: string,
    attachments?: Attachment[],
    model?: string,
    _effort?: EffortLevel,
    options?: PromptOptions,
  ): Promise<void> {
    const effectiveModel = model ?? this._model;

    // Build args: opencode run --format json [options] [--model <model>] [--session <id>] [-f <file>...] "<text>"
    const args: string[] = ['run', '--format', 'json'];
    appendOpenCodePromptOptionArgs(args, options);
    if (effectiveModel) args.push('--model', effectiveModel);
    if (this._resumeSessionId) args.push('--session', this._resumeSessionId);
    // opencode accepts images via the -f/--file flag. We require a tempPath
    // (always provided by sessionManager for non-empty attachments); if absent
    // we silently skip rather than abort the whole turn.
    for (const att of attachments ?? []) {
      if (att.tempPath) {
        args.push('--file', att.tempPath);
      }
    }
    args.push(capForArgvSpawn(text));

    return this._spawnAndDrainJson(args);
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const effectiveModel = this._model;
    const runArgs: string[] = ['run', '--format', 'json'];
    appendOpenCodePromptOptionArgs(runArgs, options);
    runArgs.push('--command', name);
    if (effectiveModel) runArgs.push('--model', effectiveModel);
    if (this._resumeSessionId) runArgs.push('--session', this._resumeSessionId);
    const trailing = args?.trim();
    if (trailing) runArgs.push(trailing);

    return this._spawnAndDrainJson(runArgs);
  }

  private _spawnAndDrainJson(args: string[]): Promise<void> {
    this._emit({ type: 'status', payload: { status: 'running' } });
    this._explicitFinish = false;
    this._usage = {};

    const extraEnv: NodeJS.ProcessEnv = {};
    if (!this._trustRepoConfig) {
      extraEnv.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
      extraEnv.KILO_DISABLE_PROJECT_CONFIG = '1';
    }
    const child = this._spawnFn(this._bin, args, { cwd: this._cwd || undefined, env: extraEnv });
    this._child = child;

    // Write stdin end immediately — opencode reads prompt from args, not stdin
    if (child.stdin) {
      child.stdin.on('error', () => {}); // async EPIPE must not crash the server
      child.stdin.end();
    }

    // Capture stderr into a bounded tail. Still drains the pipe (so the 64 KB
    // buffer cannot fill and block the child), but keeps the tail for the
    // failure path in the close handler instead of discarding it.
    const STDERR_TAIL_LIMIT = 8 * 1024;
    let stderrTail = '';
    let framesSeen = 0;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_LIMIT);
    });

    const rl = createInterface({ input: child.stdout! });

    let _permissionBlockEmitted = false;
    rl.on('line', (line) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        const permMsg = detectPermissionBlock(line);
        if (permMsg && !_permissionBlockEmitted) {
          _permissionBlockEmitted = true;
          this._emit({ type: 'error', payload: { message: permMsg } });
        }
        return; // ignore non-JSON lines (banner text, etc.)
      }
      framesSeen++;

      // Capture native session id from any frame that carries it
      const sid = safeNativeSessionId(frame.sessionID);
      if (sid && !this._nativeSessionId) {
        this._nativeSessionId = sid;
      }

      // Accumulate usage tokens across steps
      const usageFields = usageFromOpenCodeFrame(frame);
      if (usageFields.inputTokens !== undefined) {
        this._usage.inputTokens = (this._usage.inputTokens ?? 0) + usageFields.inputTokens;
      }
      if (usageFields.outputTokens !== undefined) {
        this._usage.outputTokens = (this._usage.outputTokens ?? 0) + usageFields.outputTokens;
      }
      if (usageFields.cacheReadTokens !== undefined) {
        this._usage.cacheReadTokens = (this._usage.cacheReadTokens ?? 0) + usageFields.cacheReadTokens;
      }
      if (usageFields.cacheCreationTokens !== undefined) {
        this._usage.cacheCreationTokens = (this._usage.cacheCreationTokens ?? 0) + usageFields.cacheCreationTokens;
      }
      if (usageFields.costUsd !== undefined) {
        this._usage.costUsd = (this._usage.costUsd ?? 0) + usageFields.costUsd;
      }

      const partials = mapOpenCodeEvent(frame);
      for (const partial of partials) {
        // Track whether mapper produced an explicit done/finish status
        if (
          partial.type === 'status' &&
          (partial as { type: 'status'; payload: { status: string } }).payload.status === 'done'
        ) {
          this._explicitFinish = true;
          this._emit({
            ...partial,
            payload: {
              ...partial.payload,
              ...this._usage,
            },
          });
        } else {
          this._emit(partial);
        }
      }
    });

    return new Promise<void>((resolve) => {
      child.on('error', (err) => {
        this._emit({ type: 'error', payload: { message: err.message } });
        this._emit({ type: 'status', payload: { status: 'error' } });
        this._emitter.emit('end');
        resolve();
      });

      child.on('close', (code) => {
        rl.close();
        // Fail loudly when the binary died without producing a single JSON
        // frame: surface the captured stderr tail instead of the historical
        // fake empty done. Signal kills (code === null, e.g. stop()/
        // interrupt) keep the legacy fallback path.
        const failedWithoutFrames = typeof code === 'number' && code !== 0 && framesSeen === 0;
        if (failedWithoutFrames) {
          const tail = stderrTail.trim();
          const message = `${this._label} exited with code ${code} without producing any output`
            + (tail ? `; stderr tail:\n${tail}` : '; no stderr output was captured.');
          this._emit({ type: 'error', payload: { message } });
          this._emit({ type: 'status', payload: { status: 'error' } });
        } else if (!this._explicitFinish) {
          // Emit a final message marker and done status if the binary did not
          // produce an explicit finish event (most common path today).
          this._emit({ type: 'message', payload: { chunk: '', final: true } });
          this._emit({ type: 'status', payload: { status: 'done', ...this._usage } });
        }
        this._emitter.emit('end');
        this._child = null;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    try {
      // Sandboxed: signal the inner CLI before bwrap so session state can flush.
      // Unsandboxed: process-group SIGTERM (detached leader).
      termChildProcess(this._child, { group: true });
      this._emit({ type: 'status', payload: { status: 'idle' } });
    } finally {
      this._child = null;
    }
    // Defensive: emit 'end' so sessionManager's once('end') cleanup fires
    // immediately. The subprocess close handler may emit again later — the
    // once listener makes the duplicate a no-op.
    this._emitter.emit('end');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    let stdout: string;
    try {
      const result = await execAsync(`${this._bin} models`);
      stdout = result.stdout;
    } catch {
      return [];
    }

    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((line) => {
        const slashIdx = line.indexOf('/');
        const provider = slashIdx !== -1 ? line.slice(0, slashIdx) : line;
        const lowerLine = line.toLowerCase();
        const vision = lowerLine.includes('claude') || lowerLine.includes('gpt') || lowerLine.includes('gemini');
        return {
          name: line,
          label: `${this._label} · ${line}`,
          provider,
          vision,
          steer: false,
        } satisfies ModelDescriptor;
      });
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    const configRoot = this._configDir;
    // Deduped across dirs, first occurrence wins: config-dir skills first,
    // then any adapter-specific skillDirs (kilo: ~/.kilo/skills, ~/.agents/skills).
    const skills = scanSkillDirs([join(configRoot, 'skills'), ...this._skillDirs.map((d) => join(d))]);
    const templates = scanCommandTemplateDir(join(configRoot, 'command'));
    const seen = new Set<string>();
    const out: CommandDescriptor[] = [];
    for (const cmd of [...skills, ...templates]) {
      if (seen.has(cmd.name)) continue;
      seen.add(cmd.name);
      out.push(cmd);
    }
    return out;
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    // ponytail: read directly from the native SQLite store. The CLI filters by
    // cwd (both opencode and kilo), hiding Tierwyn-spawned sessions and breaking
    // isNativeSessionAvailable + the resume badge. DB query bypasses the filter
    // uniformly across both binaries (no flag divergence).
    let db: ReturnType<typeof openAgentSqliteReadonly>;
    try {
      db = openAgentSqliteReadonly(this._dbPath);
    } catch {
      return [];
    }
    try {
      const rows = db
        .prepare('SELECT id, title, time_created FROM session ORDER BY time_created DESC LIMIT 200')
        .all() as { id: string; title: string | null; time_created: number | null }[];
      return rows.map((r) => ({
        id: r.id,
        summary: r.title ?? '',
        createdAt: r.time_created ?? undefined,
      }));
    } finally {
      db.close();
    }
  }

  async loadSession(id: string): Promise<void> {
    this._resumeSessionId = safeNativeSessionId(id) ?? '';
  }

  /**
   * Best-effort: returns true if the given session id appears in `opencode session list` output.
   * This spawns a subprocess on every call, so callers should avoid hot-path usage.
   */
  async isNativeSessionAvailable(id: string): Promise<boolean> {
    if (!id) return false;
    try {
      const sessions = await this.listSessions();
      return sessions.some((s) => s.id === id);
    } catch {
      return false;
    }
  }

  /** Read-only access to the native session id captured during the last sendPrompt. */
  get nativeSessionId(): string {
    return this._nativeSessionId;
  }
}
