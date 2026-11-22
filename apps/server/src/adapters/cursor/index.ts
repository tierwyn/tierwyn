// apps/server/src/adapters/cursor/index.ts
import { EventEmitter } from 'events';
import { createInterface } from 'readline';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, isAbsolute } from 'path';
import { spawn as nodeSpawn } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { escalateKill } from '../escalateKill.js';
import type { ChildProcess } from 'child_process';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor,
  OneShotOpts, OneShotResult, OneShotMode, EffortLevel, PromptOptions,
} from '@tierwyn/shared';
import { mapCursorEvent, createCursorStreamState, textFromContent } from './mapping.js';
import { scanSkillDirs } from '../skillScan.js';
import { capForArgvSpawn } from '../../compaction/primingCap.js';
import { withImagePathRefs } from '../../imageHelper.js';
import { safeNativeSessionId } from '../sessionId.js';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

export const CURSOR_DISALLOWED_TOOLS = new Set([
  'writeToolCall', 'editToolCall', 'createToolCall', 'deleteToolCall',
  'terminalToolCall', 'bashToolCall', 'executeCommandToolCall',
]);

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
 * Fatal `cursor-agent` stderr lines worth surfacing as a NormalisedEvent error.
 * Kept separate from detectPermissionBlock so approval stalls and hard failures
 * stay distinguishable. Deliberately narrow — stderr also carries progress
 * chatter that must never reach the transcript.
 */
export function detectCursorFatalStderr(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  // `\w*Error:` not just `Error:` — cursor-agent aborts a turn with
  // `RetriableError: [resource_exhausted] Error` (and other *Error: prefixes)
  // after exhausting backend retries, exiting with no `result` frame. Verified
  // against a live capture (CLI 2026.08.11-e8db854).
  if (/^\w*Error:\s+/i.test(trimmed)) return trimmed;
  if (/not (logged in|authenticated)|please (log|sign) in|auth(entication)? (has )?(expired|failed)/i.test(trimmed)) return trimmed;
  // Narrow fatal-quota language only — the broad shared QUOTA_SHAPE (which
  // matches benign words like "credit") would let harmless chatter latch
  // _fatalStderrEmitted and swallow the real fatal line. [S2-3]
  if (/rate limit|too many requests|quota exceeded|usage limit/i.test(trimmed)) return trimmed;
  if (/hit your session limit/i.test(trimmed)) return trimmed;
  return null;
}

type InnerSpawn = (cmd: string, args: string[], opts: import('child_process').SpawnOptions) => ChildProcess;

function defaultSpawn(cmd: string, args: string[], opts: { cwd?: string }, spawnImpl: InnerSpawn = nodeSpawn): ChildProcess {
  return spawnImpl(cmd, args, { cwd: opts.cwd, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'cursor') });
}

/** Parse `cursor-agent models` output: lines shaped `name - Human Label`.
 *  The "Available models" header has no " - " separator and is skipped. */
export function parseCursorModels(stdout: string): ModelDescriptor[] {
  const out: ModelDescriptor[] = [];
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    const m = /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const label = m[2].trim();
    const lower = name.toLowerCase();
    const vision =
      lower.includes('claude') || lower.includes('gpt') ||
      lower.includes('gemini') || lower.includes('composer');
    out.push({ name, label: `Cursor · ${label}`, provider: 'cursor', vision, steer: false });
  }
  return out;
}

/**
 * Cursor's on-disk workspace slug: absolute cwd, leading/trailing `/` stripped,
 * remaining `/` replaced by `-`. Verified against ~/.cursor/projects
 * (`/home/u/Projects/Tierwyn` -> `home-u-Projects-Tierwyn`, `/tmp` -> `tmp`).
 */
export function cursorWorkspaceSlug(cwd: string): string {
  return cwd.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\//g, '-');
}

/** `<projectsRoot>/<slug>/agent-transcripts/<id>/<id>.jsonl` */
export function cursorTranscriptPath(projectsRoot: string, cwd: string, id: string): string {
  return join(projectsRoot, cursorWorkspaceSlug(cwd), 'agent-transcripts', id, `${id}.jsonl`);
}

/** Append per-turn prompt option flags to a cursor-agent argv slice. */
export function appendCursorPromptOptionArgs(args: string[], options?: PromptOptions | null): void {
  if (!options) return;
  const mode = options['mode'];
  if (mode === 'plan' || mode === 'ask') args.push('--mode', mode);
  const sandbox = options['sandbox'];
  if (sandbox === 'enabled' || sandbox === 'disabled') args.push('--sandbox', sandbox);
  if (options['autoReview'] === true) args.push('--auto-review');
}

export class CursorAdapter implements AgentAdapter {
  readonly oneShotModes: readonly OneShotMode[] = ['none', 'read_only'];
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

  private readonly _bin: string;
  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private readonly _cursorHome: string;
  private readonly _customSpawn: boolean;

  constructor(opts: { spawn?: SpawnFn; spawnFn?: SpawnFn; bin?: string; cursorHome?: string; cwd?: string } = {}) {
    this._bin = opts.bin ?? 'cursor-agent';
    this._customSpawn = Boolean(opts.spawn ?? opts.spawnFn);
    const inner = (opts.spawn ?? opts.spawnFn ?? nodeSpawn) as InnerSpawn;
    this._spawnFn = (c, a, o) => defaultSpawn(c, a, o, inner);
    this._spawn = this._spawnFn;
    // ponytail: cursorHome/cwd opts exist only for test isolation; production
    // uses ~/.cursor and the cwd handed to start().
    this._cursorHome = opts.cursorHome ?? join(homedir(), '.cursor');
    this._cwd = opts.cwd ?? '';
  }

  streamEvents(): EventEmitter { return this._emitter; }

  private _emit(event: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    this._emitter.emit('event', {
      ...event, sessionId: this._sessionId, seq: ++this._seq, ts: Date.now(),
    } as NormalisedEvent);
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
  }

  async sendPrompt(
    text: string,
    attachments?: Attachment[],
    model?: string,
    _effort?: EffortLevel,
    options?: PromptOptions,
  ): Promise<void> {
    if (!this._trustRepoConfig) {
      this._emit({
        type: 'error',
        payload: {
          message:
            'Cursor requires repository trust because it runs with --trust and --approve-mcps. Enable "Trust repository configuration" in Project Settings to use Cursor.',
        },
      });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._emitter.emit('end');
      return;
    }
    const effectiveModel = model ?? this._model;
    const safeText = capForArgvSpawn(withImagePathRefs(text, attachments));
    const args: string[] = [
      '-p', '--output-format', 'stream-json', '--force', '--stream-partial-output',
      // Cursor is bypass-only in Tierwyn: an unanswered workspace-trust or MCP
      // approval prompt is a hang. --auto-review and --sandbox are opt-in via
      // per-message prompt options (may stall when approvals are needed).
      '--trust', '--approve-mcps',
    ];
    appendCursorPromptOptionArgs(args, options);
    if (effectiveModel) args.push('--model', effectiveModel);
    if (this._resumeSessionId) args.push('--resume', this._resumeSessionId);
    // Native attachment flag (hidden, repeatable). The @<tempPath> suffix from
    // withImagePathRefs and --add-dir stay as a fallback for older CLIs and for
    // models that only notice the @ mention.
    for (const a of attachments ?? []) {
      if (a.tempPath) args.push('--image', a.tempPath);
    }
    const extraDirs = [...new Set(
      (attachments ?? []).map(a => a.tempPath && dirname(a.tempPath)).filter((d): d is string => Boolean(d)),
    )];
    for (const dir of extraDirs) args.push('--add-dir', dir);
    args.push(safeText);
    return this._spawnAndDrainJson(args);
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const prefix = `/${name}`;
    await this.sendPrompt(
      args?.trim() ? `${prefix} ${args}` : prefix,
      undefined,
      undefined,
      undefined,
      options,
    );
  }

  private _spawnAndDrainJson(args: string[]): Promise<void> {
    this._emit({ type: 'status', payload: { status: 'running' } });
    this._explicitFinish = false;

    const child = this._spawnFn(this._bin, args, { cwd: this._cwd || undefined });
    this._child = child;
    child.stdin?.on('error', () => {}); // async EPIPE must not crash the server
    if (child.stdin) child.stdin.end();

    // Shared across stdout and stderr: the same approval/fatal message often
    // appears on both, and the transcript must show it once.
    let _permissionBlockEmitted = false;
    let _fatalStderrEmitted = false;
    const notePermissionBlock = (line: string): void => {
      if (_permissionBlockEmitted) return;
      const permMsg = detectPermissionBlock(line);
      if (!permMsg) return;
      _permissionBlockEmitted = true;
      this._emit({ type: 'error', payload: { message: permMsg } });
    };

    // cursor-agent reports auth expiry, rate/session limits and invalid models on
    // stderr and exits non-zero with no terminal `result` frame. Without this the
    // UI shows a silent empty turn. Only classified lines are forwarded — stderr
    // also carries indexing/progress chatter.
    let stderrRl: ReturnType<typeof createInterface> | null = null;
    if (child.stderr) {
      stderrRl = createInterface({ input: child.stderr });
      stderrRl.on('line', (line) => {
        notePermissionBlock(line);
        if (_fatalStderrEmitted) return;
        const fatal = detectCursorFatalStderr(line);
        if (!fatal) return;
        _fatalStderrEmitted = true;
        this._emit({ type: 'error', payload: { message: fatal } });
      });
    }

    const streamState = createCursorStreamState();
    const rl = createInterface({ input: child.stdout! });
    rl.on('line', (line) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(line) as Record<string, unknown>;
      } catch {
        notePermissionBlock(line);
        return;
      }

      const sid = safeNativeSessionId(frame.session_id);
      if (sid && !this._nativeSessionId) {
        this._nativeSessionId = sid;
        this._resumeSessionId = sid;
        // Re-emit running so sessionManager persists the captured native id.
        this._emit({ type: 'status', payload: { status: 'running' } });
      }

      for (const partial of mapCursorEvent(frame, streamState)) {
        // ponytail: cursor surfaces backend quota errors ("hit your session limit")
        // as message chunks. Pass the text through (user sees what happened) but
        // drop the captured native id so the next sendPrompt starts a fresh chat
        // instead of re-resuming the poisoned one.
        if (partial.type === 'message' && 'chunk' in partial.payload &&
            typeof partial.payload.chunk === 'string' &&
            /hit your session limit/i.test(partial.payload.chunk)) {
          this._nativeSessionId = '';
          this._resumeSessionId = '';
        }
        this._emit(partial);
        if (partial.type === 'status') this._explicitFinish = true;
      }
    });

    return new Promise<void>((resolve) => {
      child.on('error', (err) => {
        this._emit({ type: 'error', payload: { message: err.message } });
        this._emit({ type: 'status', payload: { status: 'error' } });
        this._emitter.emit('end');
        resolve();
      });
      child.on('close', () => {
        rl.close();
        stderrRl?.close();
        if (!this._explicitFinish) {
          this._emit({ type: 'message', payload: { chunk: '', final: true } });
          this._emit({ type: 'status', payload: { status: 'done' } });
        }
        this._emitter.emit('end');
        this._child = null;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const child = this._child;
    try {
      child?.kill('SIGTERM');
      escalateKill(child, { group: false });
      this._emit({ type: 'status', payload: { status: 'idle' } });
    } finally {
      this._child = null;
    }
    this._emitter.emit('end');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    return new Promise<ModelDescriptor[]>((resolve) => {
      const child = this._spawnFn(this._bin, ['models'], {});
      const chunks: Buffer[] = [];
      child.stdin?.on('error', () => {}); // async EPIPE must not crash the server
      child.stdin?.end();
      const hardTimer = setTimeout(() => child.kill('SIGTERM'), 15_000);
      child.stdout?.on('data', (d: Buffer) => chunks.push(d));
      child.on('error', () => { clearTimeout(hardTimer); resolve([]); });
      child.on('close', () => {
        clearTimeout(hardTimer);
        resolve(parseCursorModels(Buffer.concat(chunks).toString('utf-8')));
      });
    });
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    // Mirrors cursor-agent's own skill discovery. First root wins on name
    // collisions. Project-relative roots need a cwd — listCommands() is also
    // called on a bare adapter from registry.create(), which never gets one.
    const dirs = [
      join(this._cursorHome, 'skills-cursor'),
      join(this._cursorHome, 'skills'),
    ];
    if (this._cwd) {
      dirs.push(
        join(this._cwd, '.cursor', 'skills'),
        join(this._cwd, '.claude', 'skills'),
        join(this._cwd, '.agents', 'skills'),
        join(this._cwd, '.codex', 'skills'),
      );
    }
    return scanSkillDirs(dirs);
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    return [];
  }

  async loadSession(id: string): Promise<void> {
    this._resumeSessionId = safeNativeSessionId(id) ?? '';
  }

  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId) return false;
    const projectsRoot = join(this._cursorHome, 'projects');
    const transcriptIn = (slugDir: string): boolean =>
      existsSync(join(slugDir, 'agent-transcripts', nativeSessionId, `${nativeSessionId}.jsonl`));

    // ponytail: 3 x 100ms retry mirrors the codex adapter — /active-agent can ask
    // mid-turn, a beat before cursor-agent has flushed the transcript file.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this._cwd && existsSync(cursorTranscriptPath(projectsRoot, this._cwd, nativeSessionId))) return true;
      // Bare adapter from registry.create() has no cwd: scan the project slugs.
      // ponytail: flat readdir over ~tens of dirs; add an index if it ever bites.
      if (!this._cwd) {
        try {
          for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
            if (entry.isDirectory() && transcriptIn(join(projectsRoot, entry.name))) return true;
          }
        } catch {
          // missing/unreadable projects root — treat as not available
        }
      }
      if (attempt < 2) await new Promise((r) => setTimeout(r, 100));
    }
    return false;
  }

  get nativeSessionId(): string { return this._nativeSessionId; }

  async oneShot(prompt: string, opts: OneShotOpts = {}): Promise<OneShotResult> {
    const mode: OneShotMode = opts.mode ?? 'none';
    if (opts.allowTools === true) {
      throw new Error('cursor oneShot refuses allowTools=true');
    }
    const modes: readonly OneShotMode[] = (this as AgentAdapter).oneShotModes ?? ['none'];
    if (!modes.includes(mode)) {
      throw new Error(`cursor oneShot does not support mode ${mode}`);
    }
    const cwd = opts.cwd?.trim();
    if (mode === 'read_only' && (!cwd || !isAbsolute(cwd))) {
      throw new Error('cursor oneShot read_only requires an absolute cwd');
    }
    if (mode === 'read_only' && !opts.trustRepoConfig) {
      throw new Error('cursor oneShot requires repository trust (trustRepoConfig: true)');
    }
    const secs = opts.timeoutSecs ?? (mode === 'read_only' ? 120 : 60);
    const promptText = opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt;
    const args: string[] = [
      '-p', '--output-format', 'stream-json', '--mode', 'ask',
    ];
    if (mode === 'read_only') {
      args.push('--trust', '--force');
    }
    if (opts.model) args.push('--model', opts.model);
    args.push(promptText);

    const spawnOpts = { cwd: mode === 'read_only' ? cwd : undefined };
    const child = this._customSpawn
      ? this._spawnFn(this._bin, args, spawnOpts)
      : nodeSpawn(this._bin, args, {
          cwd: spawnOpts.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: buildChildEnv(opts.env as NodeJS.ProcessEnv | undefined, undefined, 'cursor'),
        });

    return new Promise<OneShotResult>((resolve, reject) => {
      const errLines: string[] = [];
      let resultText = '';
      let assistantText = '';
      let resultError: string | undefined;
      let toolInvoked = false;
      let disallowedTool: string | null = null;
      let lastFrame: unknown;
      let settled = false;
      let killFollowup: ReturnType<typeof setTimeout> | undefined;

      child.stdin?.on('error', () => {});
      child.stdin?.end();

      const rl = child.stdout ? createInterface({ input: child.stdout }) : null;
      rl?.on('line', (line) => {
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(line) as Record<string, unknown>; } catch { return; }
        lastFrame = frame;
        if (frame.type === 'tool_call') {
          const toolCall = (frame.tool_call ?? {}) as Record<string, unknown>;
          const toolName = Object.keys(toolCall)[0] ?? 'tool';
          if (mode === 'none') {
            toolInvoked = true;
          } else if (mode === 'read_only') {
            if (CURSOR_DISALLOWED_TOOLS.has(toolName)) {
              disallowedTool = toolName;
            }
          }
        }
        if (frame.type === 'assistant') {
          const message = frame.message as { content?: unknown } | undefined;
          assistantText += textFromContent(message?.content);
        }
        if (frame.type === 'result') {
          if (frame.is_error) {
            resultError = (typeof frame.result === 'string' && frame.result.trim())
              ? frame.result
              : 'cursor oneShot error';
          } else if (typeof frame.result === 'string' && frame.result.trim()) {
            resultText = frame.result.trim();
          }
        }
      });

      const stderrRl = child.stderr ? createInterface({ input: child.stderr }) : null;
      stderrRl?.on('line', (line) => { errLines.push(line); });

      const finish = (error: Error | null, result?: OneShotResult, keepKill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (!keepKill && killFollowup) clearTimeout(killFollowup);
        rl?.close();
        stderrRl?.close();
        if (error) reject(error);
        else resolve(result!);
      };

      const hardTimer = setTimeout(() => {
        child.kill('SIGTERM');
        killFollowup = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new Error(`cursor oneShot timed out after ${secs}s`));
        }, 2000);
        finish(new Error(`cursor oneShot timed out after ${secs}s`), undefined, true);
      }, secs * 1000);

      child.on('error', (e) => finish(e));
      child.on('close', (code) => {
        if (toolInvoked) {
          finish(new Error('cursor oneShot invoked a tool'));
          return;
        }
        if (disallowedTool) {
          finish(new Error(`cursor oneShot invoked disallowed tool "${disallowedTool}"`));
          return;
        }
        if (resultError) {
          finish(new Error(resultError));
          return;
        }
        if (code && code !== 0) {
          const classified = errLines.map(detectCursorFatalStderr).find((m): m is string => Boolean(m));
          finish(new Error(classified || `cursor oneShot exited with code ${code}`));
          return;
        }
        const text = (resultText || assistantText).trim();
        if (!text) {
          finish(new Error('cursor oneShot returned empty text'));
          return;
        }
        finish(null, { text, raw: lastFrame });
      });
    });
  }
}
