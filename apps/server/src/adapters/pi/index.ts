import { EventEmitter } from 'events';
import { existsSync, readdirSync, promises as fsp } from 'fs';
import { join, isAbsolute } from 'path';
import { homedir } from 'os';
import { spawn } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import type { ChildProcess } from 'child_process';
import type { AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor, EffortLevel, OneShotOpts, OneShotResult, OneShotMode, PromptOptions } from '@tierwyn/shared';
import { PiRpc } from './rpc.js';
import { mapPiEvent } from './mapping.js';
import { scanSkillDirs } from '../skillScan.js';
import { safePersistedNativeSessionId } from '../sessionId.js';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

/** Parse a token-count string emitted by `pi --list-models` (e.g. "200K", "262.1K", "1M").
 *  Uses decimal multipliers (×1000 / ×1_000_000) to match pi's own formatter. */
function parseTokenCount(s: string): number {
  const m = /^([\d.]+)([KM]?)$/.exec(s.trim());
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mult = m[2] === 'K' ? 1_000 : m[2] === 'M' ? 1_000_000 : 1;
  return Math.round(n * mult);
}

/**
 * Parse the whitespace-aligned table emitted by `pi --list-models`:
 *   provider  model                   context  max-out  thinking  images
 *   lmstudio  google/gemma-4-12b      262.1K   16.4K    no        no
 *   zai       glm-5.2                 200K     131.1K   yes       no
 * Rows are split on 2+ space runs. `name` is encoded `provider/model` so the
 * existing `splitModel()` below can decode it into `--provider` / `--model` args.
 */
function parsePiModelsTable(stdout: string): ModelDescriptor[] {
  const lines = stdout.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  // Drop header line (defensive — match by column name, not position).
  if (/^provider\s+model\s+context/i.test(lines[0])) lines.shift();

  const out: ModelDescriptor[] = [];
  for (const line of lines) {
    const cols = line.trim().split(/\s{2,}/);
    if (cols.length < 6) continue;
    const [provider, model, ctxStr, _maxOut, thinking, images] = cols;
    out.push({
      name: `${provider}/${model}`,
      label: `Pi · ${model}`,
      provider,
      vision: images.toLowerCase() === 'yes',
      steer: true,
      contextWindow: parseTokenCount(ctxStr),
    });
  }
  return out;
}

/** Split a stored model name of form "provider/modelId" into its parts. */
function splitModel(model: string): { provider?: string; modelId: string } {
  const i = model.indexOf('/');
  if (i === -1) return { modelId: model };
  return { provider: model.slice(0, i), modelId: model.slice(i + 1) };
}

const PI_THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/** Append per-spawn Pi prompt-option flags after --model. */
export function appendPiPromptOptionArgs(args: string[], options?: PromptOptions | null): void {
  if (!options) return;
  const thinking = options['thinking'];
  if (typeof thinking === 'string' && PI_THINKING.has(thinking)) {
    args.push('--thinking', thinking);
  }
  const toolsProfile = options['toolsProfile'];
  if (toolsProfile === 'readOnly') args.push('--tools', 'read,grep,find,ls');
  else if (toolsProfile === 'none') args.push('--no-tools');
}

function piOptionsFingerprint(options?: PromptOptions | null): string {
  const args: string[] = [];
  appendPiPromptOptionArgs(args, options);
  return args.join('\0');
}

export class PiAdapter implements AgentAdapter {
  readonly oneShotModes: readonly OneShotMode[] = ['none', 'read_only'];
  private _emitter = new EventEmitter();
  private _rpc: PiRpc | null = null;
  private _readyPromise: Promise<void> | null = null;
  private _getNextSteer?: () => Promise<{ text: string; attachments?: Attachment[] } | null>;
  private _sessionId = '';
  private _nativeSessionId = '';
  private _resumeSessionPath = '';
  private _seq = 0;
  private _model = '';
  private _sessionDir: string;
  private _cwd = '';
  private _endResolve: (() => void) | null = null;
  /** Set to true when agent_end arrives before sendPrompt registers _endResolve. */
  private _agentEnded = false;
  private _readyError: Error | null = null;
  /** True once any error event has fired during the current sendPrompt turn. */
  private _turnErrored = false;
  /** Error messages already emitted in the current turn — pi auto-retries failed
   *  turns up to 3 times (exponential backoff), so without dedupe the UI would
   *  see N copies of the same "429 ..." message per turn. */
  private _emittedErrorMessages = new Set<string>();
  private _openInteractions = new Set<string>();
  /** Fingerprint of argv option flags the current RPC was spawned with. */
  private _spawnedOptionsFp = '';
  private _steerLoopStarted = false;
  readonly _spawn: SpawnFn;

  constructor(private opts: { spawn?: SpawnFn; spawnFn?: SpawnFn; bin?: string; sessionDir?: string } = {}) {
    const inner = opts.spawn ?? opts.spawnFn ?? spawn;
    const defaultSpawn: SpawnFn = (c, a, o) => inner(c, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'pi') });
    this._spawn = defaultSpawn;
    this.opts = { ...opts, spawnFn: defaultSpawn };
    this._sessionDir = opts.sessionDir ?? join(homedir(), '.pi', 'agent', 'sessions');
  }

  streamEvents(): EventEmitter { return this._emitter; }

  private _emit(event: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    this._emitter.emit('event', { ...event, sessionId: this._sessionId, seq: ++this._seq, ts: Date.now() } as NormalisedEvent);
  }

  private _baseSpawnArgs(): string[] {
    const { provider, modelId } = splitModel(this._model);
    const args = ['--session-dir', this._sessionDir];
    if (provider) args.push('--provider', provider);
    if (modelId) args.push('--model', modelId);
    return args;
  }

  /** Spawn (or respawn) Pi RPC. Does not await ready — callers write the ready frame in tests first. */
  private _beginRpc(options?: PromptOptions | null): void {
    const args = this._baseSpawnArgs();
    appendPiPromptOptionArgs(args, options);
    this._spawnedOptionsFp = piOptionsFingerprint(options);

    const rpc = new PiRpc({ spawnFn: this.opts.spawnFn, bin: this.opts.bin });
    this._rpc = rpc;

    rpc.on('event', (frame: Record<string, unknown>) => this._onPiEvent(frame));
    rpc.on('error', (err: Error) => {
      this._emit({ type: 'error', payload: { message: err.message } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._endResolve?.();
      this._emitter.emit('end');
    });
    rpc.on('exit', () => { this._endResolve?.(); });

    rpc.start({ cwd: this._cwd || undefined, args });

    // Store the ready promise so sendPrompt can await it after the test writes the ready frame.
    // We do NOT await here so start() returns immediately and the caller can trigger side effects
    // (e.g. writing the ready frame in tests) before the promise chain proceeds.
    this._readyPromise = rpc.ready().then(async () => {
      const resume = this._nativeSessionId || this._resumeSessionPath;
      if (resume && existsSync(resume)) {
        await rpc.request({ type: 'switch_session', sessionPath: resume });
      }
      const state = await rpc.request({ type: 'get_state' });
      this._nativeSessionId = safePersistedNativeSessionId(state.data?.sessionFile) ?? '';
      if (!this._steerLoopStarted) {
        this._steerLoopStarted = true;
        void this._steerLoop();
      }
    }).catch((err: Error) => { this._readyError = err; });
  }

  async start(config: SessionConfig): Promise<void> {
    this._sessionId = config.sessionId;
    this._model = config.model;
    this._cwd = config.cwd ?? '';
    this._resumeSessionPath = safePersistedNativeSessionId(config.nativeSessionId) ?? '';
    this._seq = 0;
    this._agentEnded = false;
    this._endResolve = null;
    this._readyError = null;
    this._nativeSessionId = '';
    this._steerLoopStarted = false;
    this._getNextSteer = config.getNextSteer;
    this._beginRpc();
  }

  private async _steerLoop(): Promise<void> {
    while (this._rpc && this._getNextSteer) {
      try {
        const next = await this._getNextSteer();
        if (!next) break;
        const images = (next.attachments ?? [])
          .filter((a) => a.base64)
          .map((a) => ({ type: 'image' as const, data: a.base64, mimeType: a.mediaType }));
        // Mid-run inject: pi delivers 'steer' prompts after the current assistant
        // turn's tool calls, before the next LLM call — no end-of-run wait. When
        // idle, streamingBehavior is ignored (starts a normal turn), so post-turn
        // queue drains are unaffected.
        await this._rpc.request({ type: 'prompt', message: next.text, images, streamingBehavior: 'steer' });
      } catch {
        // RPC might have been closed, break the loop
        break;
      }
    }
  }

  private _onPiEvent(frame: Record<string, unknown>): void {
    for (const partial of mapPiEvent(frame)) {
      // Dedupe error events within a single sendPrompt turn. Pi retries failed
      // turns up to 3 times with exponential backoff — each retry re-emits the
      // same error frame, so without this guard the UI would show stacked
      // duplicates. The first occurrence also flips the spinner to error state
      // immediately (don't wait for the backoff to elapse before signalling).
      if (partial.type === 'error') {
        const msg = String((partial.payload as { message?: string } | undefined)?.message ?? '');
        if (msg && this._emittedErrorMessages.has(msg)) continue;
        if (msg) this._emittedErrorMessages.add(msg);
        if (!this._turnErrored) {
          this._emit({ type: 'status', payload: { status: 'error' } });
        }
        this._turnErrored = true;
      } else if (
        partial.type === 'status' &&
        (partial.payload as { status?: string }).status === 'error'
      ) {
        // Legacy mapping (message_update k=error) emits its own status:error
        // pass-through. The wrapper owns status:error now — suppress duplicates
        // so a turn produces at most one status:error event. First-sight falls
        // through to the emit below and flips _turnErrored.
        if (this._turnErrored) continue;
        this._turnErrored = true;
      }
      if (partial.type === 'interaction_request') {
        this._openInteractions.add((partial.payload as { requestId: string }).requestId);
      }
      this._emit(partial);
    }
    if (frame.type === 'agent_end') {
      if (this._endResolve) {
        this._endResolve();
      } else {
        // agent_end arrived before sendPrompt registered _endResolve — record it so
        // sendPrompt can resolve the end-promise immediately when it does register.
        this._agentEnded = true;
      }
    }
  }

  async sendPrompt(text: string, attachments: Attachment[] = [], model?: string, _effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    if (!this._rpc) throw new Error('PiAdapter.sendPrompt called before start()');

    // Wait for ready + get_state (and optional switch_session) to complete before sending.
    if (this._readyPromise) {
      await this._readyPromise;
      this._readyPromise = null;
    }
    if (this._readyError) throw this._readyError;

    // Argv flags bind at RPC spawn. Respawn when this turn's options differ.
    const fp = piOptionsFingerprint(options);
    if (fp !== this._spawnedOptionsFp) {
      const old = this._rpc;
      old.removeAllListeners();
      old.kill();
      this._rpc = null;
      this._readyError = null;
      this._beginRpc(options);
      if (this._readyPromise) {
        await this._readyPromise;
        this._readyPromise = null;
      }
      if (this._readyError) throw this._readyError;
    }

    const rpc = this._rpc;
    if (!rpc) throw new Error('PiAdapter.sendPrompt called before start()');

    // Reset per-turn error tracking. _turnErrored gates the terminal status emit
    // (see end of function); _emittedErrorMessages dedupes retry-driven duplicates.
    this._turnErrored = false;
    this._emittedErrorMessages.clear();

    if (model && model !== this._model) {
      const { provider, modelId } = splitModel(model);
      await rpc.request({ type: 'set_model', provider, modelId });
      this._model = model;
    }

    // NOTE: only base64-carrying attachments are forwarded to Pi today; tempPath-only attachments are not yet read from disk (verify against live Pi in manual testing).
    const images = attachments
      .filter((a) => a.base64)
      .map((a) => ({ type: 'image', data: a.base64, mimeType: a.mediaType }));

    const endPromise = new Promise<void>((resolve) => {
      this._endResolve = resolve;
      // If agent_end already fired (arrived before sendPrompt registered this resolve),
      // resolve immediately rather than waiting indefinitely.
      if (this._agentEnded) resolve();
    });
    this._agentEnded = false;
    await rpc.request({ type: 'prompt', message: text, images, streamingBehavior: 'followUp' }); // stream message_update events, then await agent_end
    await endPromise;

    let usage: Partial<NonNullable<Extract<NormalisedEvent, { type: 'status' }>['payload']>> = {};
    try {
      const stats = await rpc.request({ type: 'get_session_stats' });
      const t = stats.data?.tokens as Record<string, number> | undefined;
      const ctx = stats.data?.contextUsage as { percent?: number } | undefined;
      usage = {
        inputTokens: t?.input, outputTokens: t?.output,
        cacheReadTokens: t?.cacheRead, cacheCreationTokens: t?.cacheWrite,
        costUsd: stats.data?.cost as number | undefined,
        contextWindowPct: ctx?.percent !== undefined ? Math.round(ctx.percent) : undefined,
      };
    } catch { /* stats best-effort */ }

    // Skip the terminal status:done when an error event already fired during
    // the turn — _onPiEvent emitted status:error immediately on the first
    // error, and emitting done now would flip the spinner back to "ok" and
    // hide the failure. Also avoid overwriting status:error with status:done
    // when usage stats arrive after the error (they're typically zero anyway
    // for upstream 4xx/5xx failures).
    if (!this._turnErrored) {
      this._emit({ type: 'status', payload: { status: 'done', ...usage } });
    }
    this._emitter.emit('end');
  }

  async steer(text: string, attachments: Attachment[] = []): Promise<void> {
    const rpc = this._rpc;
    if (!rpc) throw new Error('PiAdapter.steer called before start()');
    const images = attachments
      .filter((a) => a.base64)
      .map((a) => ({ type: 'image' as const, data: a.base64, mimeType: a.mediaType }));
    // Mid-run inject (see _steerLoop): 'steer' lands after the current turn's
    // tool calls when streaming; ignored when idle.
    await rpc.request({ type: 'prompt', message: text, images, streamingBehavior: 'steer' });
  }

  /** Soft-end the live prompt without tearing down the RPC session.
   *  Used by Interrupt & Send / sourced-notify idle interrupt. Must NOT emit
   *  EventEmitter 'end' or kill the process (see AgentAdapter.interruptTurn). */
  interruptTurn(): void {
    this._rpc?.notify({ type: 'abort' });
  }

  respondToInteraction(requestId: string, response: { selection: string[]; text?: string }): void {
    if (!this._rpc) return;
    const decision = response.selection.includes('allow') || response.selection.includes('allow_always')
      ? 'allow' : 'deny';
    this._rpc.notify({ type: 'permission_response', id: requestId, decision });
    this._openInteractions.delete(requestId);
    this._emit({
      type: 'interaction_resolved',
      payload: { requestId, selection: response.selection, text: response.text, resolution: 'answered' },
    });
  }

  async stop(): Promise<void> {
    try {
      for (const requestId of this._openInteractions) {
        this._rpc?.notify({ type: 'permission_response', id: requestId, decision: 'deny' });
        this._emit({ type: 'interaction_resolved', payload: { requestId, selection: ['deny'], resolution: 'auto' } });
      }
      this._openInteractions.clear();
      this._rpc?.notify({ type: 'abort' }); // programmatic stdin interrupt
      this._emit({ type: 'status', payload: { status: 'idle' } });
    } finally {
      this._endResolve?.();
      this._rpc?.kill();
      this._rpc = null;
    }
    // Defensive: emit 'end' so sessionManager's once('end') cleanup fires
    // immediately. If the rpc's close handler later emits again, the once
    // listener makes it a no-op.
    this._emitter.emit('end');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const spawnFn = this.opts.spawnFn ?? ((c, a, o) => spawn(c, a, { ...o, env: buildChildEnv(undefined, undefined, 'pi') }));
    const bin = this.opts.bin ?? 'pi';
    return new Promise<ModelDescriptor[]>((resolve, reject) => {
      const child = spawnFn(bin, ['--list-models'], {});
      const chunks: Buffer[] = [];

      // `pi --list-models` blocks on an open stdin pipe; close it immediately to
      // signal EOF so the process exits after printing the table.
      child.stdin?.end();

      const hardTimer = setTimeout(() => child.kill('SIGTERM'), 15_000);

      child.stdout?.on('data', (d: Buffer) => chunks.push(d));

      child.on('error', (err) => {
        clearTimeout(hardTimer);
        reject(err);
      });

      child.on('close', (code) => {
        clearTimeout(hardTimer);
        if (code && code !== 0) {
          reject(new Error(`pi --list-models exited with code ${code}`));
          return;
        }
        resolve(parsePiModelsTable(Buffer.concat(chunks).toString('utf-8')));
      });
    });
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    const home = homedir();
    return scanSkillDirs([
      join(home, '.pi', 'agent', 'skills'),
      join(home, '.agents', 'skills'),
    ]);
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const prefix = `/skill:${name}`;
    await this.sendPrompt(args?.trim() ? `${prefix} ${args}` : prefix, [], undefined, undefined, options);
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    if (!existsSync(this._sessionDir)) return [];
    return readdirSync(this._sessionDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ id: join(this._sessionDir, f), summary: f.replace(/\.jsonl$/, '') }));
  }

  async loadSession(id: string): Promise<void> { this._resumeSessionPath = safePersistedNativeSessionId(id) ?? ''; }

  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    const sid = safePersistedNativeSessionId(nativeSessionId);
    return !!sid && existsSync(sid);
  }

  async deleteNativeSession(nativeSessionId: string): Promise<void> {
    // For pi, native_session_id IS the absolute .jsonl path (see isNativeSessionAvailable).
    const sid = safePersistedNativeSessionId(nativeSessionId);
    if (!sid) return;
    try {
      await fsp.unlink(sid);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') throw err;
    }
  }

  get nativeSessionId(): string { return this._nativeSessionId; }

  async oneShot(prompt: string, opts: OneShotOpts = {}): Promise<OneShotResult> {
    const mode: OneShotMode = opts.mode ?? 'none';
    if (opts.allowTools === true) {
      throw new Error('pi oneShot refuses allowTools=true');
    }
    const modes: readonly OneShotMode[] = (this as AgentAdapter).oneShotModes ?? ['none'];
    if (!modes.includes(mode)) {
      throw new Error(`pi oneShot does not support mode ${mode}`);
    }
    const cwd = opts.cwd?.trim();
    if (mode === 'read_only' && (!cwd || !isAbsolute(cwd))) {
      throw new Error('pi oneShot read_only requires an absolute cwd');
    }
    const secs = opts.timeoutSecs ?? (mode === 'read_only' ? 120 : 60);
    const spawnFn = this.opts.spawnFn ?? ((c, a, o) => spawn(c, a, {
      ...o,
      env: buildChildEnv(opts.env as NodeJS.ProcessEnv | undefined, undefined, 'pi'),
    }));
    const bin = this.opts.bin ?? 'pi';
    // Skip startup discovery of extensions, skills, themes, prompt templates,
    // and context files. Sidecar one-shots are plain text completions; loading
    // those (e.g. via extension discovery) can stall with no output and blow
    // the one-shot timeout. Network/offline is a separate knob (`--offline` /
    // PI_OFFLINE=1); pi has no dedicated MCP switch.
    const args = [
      '-p', prompt,
      ...(mode === 'read_only' ? ['--tools', 'read,grep,find,ls'] : ['--no-tools']),
      '--no-session',
      '--no-extensions', '--no-skills', '--no-themes',
      '--no-prompt-templates', '--no-context-files',
    ];
    if (opts.systemPrompt) args.push('--system-prompt', opts.systemPrompt);
    if (opts.model) {
      const { provider, modelId } = splitModel(opts.model);
      if (provider) args.push('--provider', provider);
      args.push('--model', modelId);
    }

    return new Promise<OneShotResult>((resolve, reject) => {
      const child = spawnFn(bin, args, cwd ? { cwd } : {});
      const out: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let settled = false;
      let killFollowup: ReturnType<typeof setTimeout> | undefined;

      child.stdin?.end();
      child.stdout?.on('data', (d: Buffer) => out.push(d));
      child.stderr?.on('data', (d: Buffer) => errChunks.push(d));

      const finish = (error: Error | null, result?: OneShotResult, keepKill = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        if (!keepKill && killFollowup) clearTimeout(killFollowup);
        if (error) reject(error);
        else resolve(result!);
      };

      const hardTimer = setTimeout(() => {
        child.kill('SIGTERM');
        killFollowup = setTimeout(() => {
          child.kill('SIGKILL');
          finish(new Error(`pi oneShot timed out after ${secs}s`));
        }, 2000);
        finish(new Error(`pi oneShot timed out after ${secs}s`), undefined, true);
      }, secs * 1000);

      child.on('error', (e) => finish(e));
      child.on('close', (code) => {
        if (code && code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
          finish(new Error(stderr || `pi oneShot exited with code ${code}`));
          return;
        }
        const text = Buffer.concat(out).toString('utf-8').trim();
        if (!text) {
          finish(new Error('pi oneShot returned empty text'));
          return;
        }
        finish(null, { text });
      });
    });
  }
}
