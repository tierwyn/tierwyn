import { EventEmitter } from 'events';
import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { safeNativeSessionId } from '../sessionId.js';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor,
  EffortLevel, PromptOptions, InteractionMode,
} from '@tierwyn/shared';
import type { ResolvedMcpServer } from '@tierwyn/shared';
import { acpMcpCaps, toAcpMcpServers } from '../../mcp/inject.js';
import { recordAcpMcpCaps } from '../../mcp/resolve.js';
import { sanitisePromptOptions } from '@tierwyn/shared';
import { AcpClient, permissionCancelled, permissionSelected } from './acp.js';
import { contextPctFromUsageUpdate, mapQwenUpdate, usageFromChunkMeta } from './mapping.js';
import { listQwenModels, qwenModelsCachePath } from './models.js';
import { readProfiles } from '../../profiles.js';
import { withImagePathRefs } from '../../imageHelper.js';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;

const ACP_PROTOCOL_VERSION = 1;
const PROBE_TIMEOUT_MS = 20_000;
/** A live turn with no inbound ACP traffic (no reply to session/prompt AND no
 *  notifications) for this long is a stall: the agent process is alive but
 *  never services the turn. Without the watchdog the awaited request pends
 *  forever and the UI spins with no error (same failure mode as kimi's GLM
 *  highspeed variants). */
const PROMPT_STALL_TIMEOUT_MS = 300_000;
/** Last N chars of agent stderr kept for inclusion in error messages. */
const STDERR_TAIL_CHARS = 4_000;

type StalledError = Error & { stalled?: boolean };

const INIT_PARAMS = {
  protocolVersion: ACP_PROTOCOL_VERSION,
  clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
};

export class QwenAdapter implements AgentAdapter {
  private _emitter = new EventEmitter();
  private _acp: AcpClient | null = null;
  private _sessionId = '';
  private _nativeSessionId = '';
  private _resumeSessionId = '';
  private _model = '';
  private _cwd = '';
  private _seq = 0;
  private _accepting = false;
  private _sawMessageChunk = false;
  private _commands: CommandDescriptor[] = [];
  private _usage: Partial<Extract<NormalisedEvent, { type: 'status' }>['payload']> = {};
  private _contextPct: number | undefined;
  private _availableModels: ModelDescriptor[] = [];
  private _pendingInteractions = new Map<string, (decision: unknown) => void>();
  private _getNextSteer?: () => Promise<{ text: string; attachments?: Attachment[] } | null>;
  /** Soft-yield flag set by interruptTurn(); sendPrompt treats cancel as done + steer. */
  private _turnInterrupted = false;
  private _lastAcpTrafficAt = 0;
  private _turnStartedAt = 0;
  private _interactionPending = false;
  private _stderrTail = '';

  private readonly _bin: string;
  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private _interactionMode: InteractionMode;
  private readonly _qwenHome: string;
  private readonly _modelsCachePath: string;
  private readonly _now: () => number;
  private readonly _stallTimeoutMs: number;

  constructor(opts: {
    bin?: string;
    spawn?: SpawnFn;
    spawnFn?: SpawnFn;
    interactionMode?: 'bypass' | 'questions' | 'prompt';
    qwenHome?: string;
    /** Injected so tests never touch data/qwen-models.json. */
    modelsCachePath?: string;
    now?: () => number;
    /** Idle-traffic bound for the turn stall watchdog (tests shrink it). */
    stallTimeoutMs?: number;
  } = {}) {
    this._bin = opts.bin ?? 'qwen';
    const inner = opts.spawn ?? opts.spawnFn ?? spawn;
    this._spawn = (c, a, o) => inner(c, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'qwen'), detached: true });
    this._spawnFn = this._spawn;
    this._interactionMode = opts.interactionMode ?? 'bypass';
    this._qwenHome = opts.qwenHome ?? join(homedir(), '.qwen');
    this._modelsCachePath = opts.modelsCachePath ?? qwenModelsCachePath();
    this._now = opts.now ?? Date.now;
    this._stallTimeoutMs = opts.stallTimeoutMs ?? PROMPT_STALL_TIMEOUT_MS;
  }

  streamEvents(): EventEmitter { return this._emitter; }

  private _emit(event: Omit<NormalisedEvent, 'sessionId' | 'seq' | 'ts'>): void {
    this._emitter.emit('event', {
      ...event, sessionId: this._sessionId, seq: ++this._seq, ts: Date.now(),
    } as NormalisedEvent);
  }

  private _donePayload(): Extract<NormalisedEvent, { type: 'status' }>['payload'] {
    return {
      status: 'done',
      ...this._usage,
      ...(this._contextPct !== undefined ? { contextWindowPct: this._contextPct } : {}),
    };
  }

  private _newAcp(): AcpClient {
    return new AcpClient({
      spawnFn: this._spawnFn, bin: this._bin,
      onRequest: (method, params, reply) => {
        if (method === 'session/request_permission') {
          this._onAcpPermissionRequest(params, reply);
        } else {
          reply({});
        }
      },
    });
  }

  /** Registry MCP for the main session (one-shot paths keep `mcpServers: []`). */
  private _mcpServers: ResolvedMcpServer[] = [];

  async start(config: SessionConfig): Promise<void> {
    this._mcpServers = config.textOnly ? [] : (config.mcpServers ?? []);
    this._sessionId = config.sessionId;
    this._model = config.model;
    this._cwd = config.cwd ?? '';
    this._resumeSessionId = safeNativeSessionId(config.nativeSessionId) ?? '';
    this._nativeSessionId = '';
    this._seq = 0;
    this._accepting = false;
    this._sawMessageChunk = false;
    this._usage = {};
    this._contextPct = undefined;
    this._commands = [];
    this._availableModels = [];
    this._pendingInteractions.clear();
    this._getNextSteer = config.getNextSteer;
    this._lastAcpTrafficAt = Date.now();
    this._turnStartedAt = 0;
    this._interactionPending = false;
    this._stderrTail = '';

    const acp = this._newAcp();
    this._acp = acp;

    acp.on('notification', ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      // Any inbound frame (reply or notification) proves the agent is alive.
      this._lastAcpTrafficAt = Date.now();
      if (method !== 'session/update') return;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const variant = update.sessionUpdate as string | undefined;

      if (variant === 'available_commands_update') {
        this._commands = this._mapCommands(update.availableCommands);
        return;
      }
      if (variant === 'usage_update') {
        const pct = contextPctFromUsageUpdate(update);
        if (pct !== undefined) this._contextPct = pct;
        return;
      }
      // Usage/context always update, even when the event gate is closed.
      // sendPrompt resets both so a session/load replay cannot leak into turn 1.
      const usage = usageFromChunkMeta(update);
      if (usage) this._usage = { ...this._usage, ...usage };
      if (this._accepting) {
        for (const partial of mapQwenUpdate(update)) {
          if (partial.type === 'message' && partial.payload.chunk) this._sawMessageChunk = true;
          this._emit(partial);
        }
      }
    });

    acp.on('error', (err: Error) => {
      this._accepting = false;
      this._emit({ type: 'error', payload: { message: err.message } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._emitter.emit('end');
    });

    acp.on('stderr', (chunk: string) => {
      this._stderrTail = (this._stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });

    acp.start({
      cwd: this._cwd || undefined,
      args: config.options?.['sandbox'] === true ? ['-s'] : [],
    });

    const init = await acp.request<{ agentCapabilities?: { loadSession?: boolean } }>('initialize', INIT_PARAMS);

    const cwd = this._cwd || process.cwd();
    const canLoad = Boolean(init.agentCapabilities?.loadSession);
    // Registry MCP: literal values over stdin (not argv). http/sse only where advertised (V6).
    const mcpCaps = acpMcpCaps(init);
    recordAcpMcpCaps('qwen', mcpCaps);
    const mcpServers = toAcpMcpServers(this._mcpServers, mcpCaps);
    if (this._resumeSessionId && canLoad) {
      await acp.request('session/load', { sessionId: this._resumeSessionId, cwd, mcpServers });
      this._nativeSessionId = this._resumeSessionId;
    } else {
      const created = await acp.request<{
        sessionId: string;
        models?: { availableModels?: unknown };
      }>('session/new', { cwd, mcpServers });
      this._nativeSessionId = safeNativeSessionId(created.sessionId) ?? '';
      this._availableModels = this._mapAvailableModels(created.models?.availableModels);
    }

    if (this._model && this._nativeSessionId) {
      try {
        await acp.request('session/set_model', {
          sessionId: this._nativeSessionId,
          modelId: this._model,
        });
      } catch { /* rejected set_model must not abort the session */ }
    }
    if (this._nativeSessionId) {
      try {
        await acp.request('session/set_mode', {
          sessionId: this._nativeSessionId,
          modeId: this._interactionMode === 'prompt' ? 'default' : 'yolo',
        });
      } catch { /* future qwen without set_mode degrades to its default */ }
    }
  }

  async setPermissionMode(mode: InteractionMode): Promise<void> {
    this._interactionMode = mode;
    if (this._acp && this._nativeSessionId) {
      try {
        await this._acp.request('session/set_mode', {
          sessionId: this._nativeSessionId,
          modeId: mode === 'prompt' ? 'default' : 'yolo',
        });
      } catch { /* degrade to default */ }
    }
  }

  async sendPrompt(text: string, attachments?: Attachment[], _model?: string, _effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    const acp = this._acp;
    if (!acp) throw new Error('QwenAdapter.sendPrompt called before start()');

    this._accepting = true;
    this._turnInterrupted = false;
    this._sawMessageChunk = false;
    this._usage = {};
    this._contextPct = undefined;
    // status:running fires here, after nativeSessionId is set in start(), so
    // sessionManager persists the native id (sessionManager.ts:139-140).
    this._emit({ type: 'status', payload: { status: 'running' } });

    const turnModeId = this._permissionModeId(options);
    if (turnModeId && this._nativeSessionId) {
      try {
        await acp.request('session/set_mode', {
          sessionId: this._nativeSessionId,
          modeId: turnModeId,
        });
      } catch { /* future qwen without set_mode degrades to its default */ }
    }

    let errored = false;
    let interrupted = false;
    this._turnStartedAt = Date.now();
    const stall = this._stallGuard();
    try {
      const result = await Promise.race([
        acp.request<{ stopReason?: string }>('session/prompt', {
          sessionId: this._nativeSessionId,
          prompt: [{ type: 'text', text: withImagePathRefs(text, attachments) }],
        }),
        stall.promise,
      ]);
      const reason = (result?.stopReason ?? '').toLowerCase();
      if (this._turnInterrupted || reason === 'cancelled') interrupted = true;
    } catch (err) {
      if ((err as StalledError)?.stalled) {
        // Watchdog fired: the agent never answered; ask it to unwind before the
        // session is torn down.
        acp.notify('session/cancel', { sessionId: this._nativeSessionId });
      }
      if (this._turnInterrupted) {
        interrupted = true;
      } else {
        errored = true;
        this._emit({ type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
        this._emit({ type: 'status', payload: { status: 'error' } });
      }
    } finally {
      stall.dispose();
      this._turnInterrupted = false;
      this._accepting = false;
    }

    if (!errored) {
      if (!interrupted && !this._sawMessageChunk) {
        errored = true;
        this._emit({
          type: 'error',
          payload: {
            message: `Qwen returned no output (model: ${this._model || 'unset'}). `
              + 'Check the model id against the qwen provider config (~/.qwen/settings.json).',
          },
        });
        this._emit({ type: 'status', payload: { status: 'error' } });
      } else {
        this._emit({ type: 'message', payload: { chunk: '', final: true } });
        this._emit({ type: 'status', payload: this._donePayload() });
      }
    }

    if (this._getNextSteer && !errored) {
      void this._runSteerLoop().catch(() => { /* swallow — loop exit is benign */ });
    } else {
      this._emitter.emit('end');
    }
  }

  private async _runSteerLoop(): Promise<void> {
    while (this._acp && this._getNextSteer) {
      let next: { text: string; attachments?: Attachment[] } | null;
      try {
        next = await this._getNextSteer();
      } catch {
        break;
      }
      if (!next) break;
      const acp = this._acp;
      if (!acp) break;
      try {
        this._accepting = true;
        this._sawMessageChunk = false;
        this._usage = {};
        this._contextPct = undefined;
        this._emit({ type: 'status', payload: { status: 'running' } });
        this._turnStartedAt = Date.now();
        const stall = this._stallGuard();
        try {
          await Promise.race([
            acp.request('session/prompt', {
              sessionId: this._nativeSessionId,
              prompt: [{ type: 'text', text: withImagePathRefs(next.text, next.attachments) }],
            }),
            stall.promise,
          ]);
        } catch (err) {
          if ((err as StalledError)?.stalled) {
            acp.notify('session/cancel', { sessionId: this._nativeSessionId });
          }
          throw err;
        } finally {
          stall.dispose();
        }
        if (!this._sawMessageChunk) {
          this._emit({ type: 'error', payload: { message: 'Qwen returned no output on steer follow-up.' } });
          this._emit({ type: 'status', payload: { status: 'error' } });
          break;
        }
        this._emit({ type: 'message', payload: { chunk: '', final: true } });
        this._emit({ type: 'status', payload: this._donePayload() });
      } catch (err) {
        this._emit({ type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
        this._emit({ type: 'status', payload: { status: 'error' } });
        break;
      } finally {
        this._accepting = false;
      }
    }
    this._emitter.emit('end');
  }

  /** Soft-end the live prompt (session/cancel) without killing the ACP process.
   *  Lets SessionManager yield mid-turn when a sourced notify is queued. */
  interruptTurn(): void {
    if (!this._acp || !this._nativeSessionId) return;
    this._turnInterrupted = true;
    this._acp.notify('session/cancel', { sessionId: this._nativeSessionId });
  }

  private _onAcpPermissionRequest(params: Record<string, unknown>, reply: (decision: unknown) => void): void {
    if (this._interactionMode === 'bypass' || this._interactionMode === 'questions') {
      const options = (params.options ?? []) as Array<{ optionId: string; kind?: string }>;
      // Prefer an allow-* kind; if none, take the first optionId so the ACP
      // request is always answered (an unanswered permission hangs the turn).
      const allow = options.find((o) => (o.kind ?? '').includes('allow')) ?? options[0];
      reply(allow ? permissionSelected(allow.optionId) : permissionCancelled());
      return;
    }
    const requestId = randomUUID();
    const options = (params.options ?? []) as Array<{ optionId: string; kind?: string; label?: string; name?: string }>;
    const toolCall = params.toolCall as { title?: string } | undefined;
    this._pendingInteractions.set(requestId, reply);
    // The turn is legitimately parked on human input — the stall watchdog must
    // not fire while the operator is deciding.
    this._interactionPending = true;
    this._emit({
      type: 'interaction_request',
      payload: {
        requestId,
        kind: 'permission',
        prompt: String(params.description ?? toolCall?.title ?? 'The agent is requesting permission'),
        choices: options.map((o) => ({ id: o.optionId, label: o.name ?? o.label ?? o.kind ?? o.optionId })),
        allowFreeText: false,
      },
    });
    this._emit({ type: 'status', payload: { status: 'waiting' } });
  }

  respondToInteraction(requestId: string, response: { selection: string[]; text?: string }): void {
    const reply = this._pendingInteractions.get(requestId);
    if (!reply) return;
    this._pendingInteractions.delete(requestId);
    if (this._pendingInteractions.size === 0) this._interactionPending = false;
    this._lastAcpTrafficAt = Date.now();
    this._emit({
      type: 'interaction_resolved',
      payload: { requestId, selection: response.selection, text: response.text, resolution: 'answered' },
    });
    this._emit({ type: 'status', payload: { status: 'running' } });
    reply(permissionSelected(response.selection[0] ?? ''));
  }

  async stop(): Promise<void> {
    this._accepting = false;
    this._interactionPending = false;
    try {
      for (const [requestId, reply] of this._pendingInteractions) {
        this._emit({ type: 'interaction_resolved', payload: { requestId, selection: [], resolution: 'auto' } });
        reply(permissionCancelled());
      }
      this._pendingInteractions.clear();
      this._acp?.notify('session/cancel', { sessionId: this._nativeSessionId });
      this._emit({ type: 'status', payload: { status: 'idle' } });
    } finally {
      this._acp?.kill();
      this._acp = null;
    }
    this._emitter.emit('end');
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this._availableModels.length > 0) return this._availableModels;
    const models = await listQwenModels({
      cachePath: this._modelsCachePath,
      probe: () => this._probeModels(),
      now: this._now,
    });
    if (models.length > 0) {
      this._availableModels = models;
      return models;
    }
    return this._seedModels();
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    return this._commands;
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const prefix = `/${name}`;
    await this.sendPrompt(args?.trim() ? `${prefix} ${args}` : prefix, undefined, undefined, undefined, options);
  }

  /** Map staged permissionMode to an ACP modeId. Neutral `default` skips set_mode. */
  private _permissionModeId(options?: PromptOptions): 'default' | 'yolo' | undefined {
    const mode = sanitisePromptOptions('qwen', options)?.permissionMode;
    if (mode === 'yolo') return 'yolo';
    if (mode === 'default-strict') return 'default';
    return undefined;
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    try {
      return await this._probeSessions();
    } catch {
      return [];
    }
  }

  async loadSession(id: string): Promise<void> {
    this._resumeSessionId = safeNativeSessionId(id) ?? '';
  }

  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId) return false;
    try {
      const projects = join(this._qwenHome, 'projects');
      if (!existsSync(projects)) return false;
      for (const ent of readdirSync(projects, { withFileTypes: true })) {
        if (!ent.isDirectory()) continue;
        if (existsSync(join(projects, ent.name, 'chats', `${nativeSessionId}.jsonl`))) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  getLiveContextWindowUsage(): { contextWindowPct?: number } {
    return this._contextPct !== undefined ? { contextWindowPct: this._contextPct } : {};
  }

  get nativeSessionId(): string { return this._nativeSessionId || this._resumeSessionId; }

  private _seedModels(): ModelDescriptor[] {
    return readProfiles()
      .filter((p) => p.agentType === 'qwen')
      .map((p) => ({
        name: p.model,
        label: p.label,
        provider: p.provider,
        vision: p.vision,
        steer: p.steer,
        contextWindow: p.contextWindow,
      }));
  }

  private _mapAvailableModels(raw: unknown): ModelDescriptor[] {
    if (!Array.isArray(raw)) return [];
    const out: ModelDescriptor[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const modelId = typeof rec.modelId === 'string' ? rec.modelId : '';
      if (!modelId) continue;
      const name = modelId.replace(/\(.*\)$/, '') || modelId;
      const meta = rec._meta as Record<string, unknown> | undefined;
      const contextLimit = meta && typeof meta.contextLimit === 'number' ? meta.contextLimit : undefined;
      out.push({
        name,
        label: `Qwen Code · ${name}`,
        provider: 'z.ai',
        vision: false,
        steer: true,
        contextWindow: contextLimit,
      });
    }
    return out;
  }

  private _mapCommands(raw: unknown): CommandDescriptor[] {
    if (!Array.isArray(raw)) return [];
    const out: CommandDescriptor[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const rec = entry as Record<string, unknown>;
      const rawName = typeof rec.name === 'string' ? rec.name : '';
      const name = rawName.replace(/^\//, '');
      if (!name) continue;
      const meta = rec._meta as { supportedModes?: unknown } | undefined;
      const modes = meta?.supportedModes;
      if (Array.isArray(modes) && modes.length > 0 && !modes.includes('acp')) continue;
      out.push({
        name,
        label: name,
        description: typeof rec.description === 'string' ? rec.description : '',
        sourceDetail: 'builtin',
      });
    }
    return out;
  }

  /** Arms the stall watchdog for one awaited session/prompt request. Rejects
   *  with a StalledError once no inbound ACP traffic has arrived for
   *  _stallTimeoutMs — the only turn failure mode that otherwise hangs the UI
   *  forever, since AcpClient.request stays pending while the child lives and
   *  failAll only fires on spawn-error/exit. Paused while an operator
   *  permission is pending (the turn is parked on human input, not dead). */
  private _stallGuard(): { promise: Promise<never>; dispose(): void } {
    let timer: ReturnType<typeof setInterval> | undefined;
    const promise = new Promise<never>((_, reject) => {
      timer = setInterval(() => {
        if (this._interactionPending) return;
        const idleMs = Date.now() - Math.max(this._lastAcpTrafficAt, this._turnStartedAt);
        if (idleMs < this._stallTimeoutMs) return;
        const err: StalledError = new Error(this._stallMessage(idleMs)) as StalledError;
        err.stalled = true;
        reject(err);
      }, Math.max(25, Math.floor(this._stallTimeoutMs / 4)));
    });
    return { promise, dispose: () => { if (timer) clearInterval(timer); } };
  }

  private _stallMessage(idleMs: number): string {
    const stderr = this._stderrTail.trim();
    const mins = Math.max(1, Math.round(idleMs / 60_000));
    const model = this._model || 'default';
    return `Qwen turn stalled: the agent process is alive but sent nothing for ${mins} min `
      + `while running model "${model}" (no reply to session/prompt, no progress updates). `
      + `Check the model id against the qwen provider config (~/.qwen/settings.json) and retry.`
      + (stderr ? `\nAgent stderr (tail):\n${stderr}` : '');
  }

  private async _withThrowawayAcp<T>(fn: (acp: AcpClient) => Promise<T>): Promise<T> {
    const acp = new AcpClient({
      spawnFn: this._spawnFn,
      bin: this._bin,
      onRequest: (_method, _params, reply) => reply({}),
    });
    // AcpClient emits 'error' on child spawn failure (ENOENT/EACCES). Node
    // throws uncaught if that event has zero listeners, which would kill the
    // API server. failAll already rejects the awaiting probe; this only
    // swallows the out-of-band emit.
    acp.on('error', (err: Error) => {
      console.error(`[qwen-probe] ${err.message}`);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      acp.start({ cwd: this._cwd || undefined, args: [] });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('qwen ACP probe timed out')), PROBE_TIMEOUT_MS);
      });
      return await Promise.race([fn(acp), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      acp.kill();
    }
  }

  private async _probeModels(): Promise<ModelDescriptor[]> {
    return this._withThrowawayAcp(async (acp) => {
      await acp.request('initialize', INIT_PARAMS);
      const created = await acp.request<{ models?: { availableModels?: unknown } }>(
        'session/new',
        { cwd: this._cwd || process.cwd(), mcpServers: [] },
      );
      return this._mapAvailableModels(created.models?.availableModels);
    });
  }

  private async _probeSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    return this._withThrowawayAcp(async (acp) => {
      await acp.request('initialize', INIT_PARAMS);
      const result = await acp.request<{ sessions?: unknown }>(
        'session/list',
        { cwd: this._cwd || process.cwd() },
      );
      const sessions = Array.isArray(result.sessions) ? result.sessions : [];
      const out: { id: string; summary: string; createdAt?: number }[] = [];
      for (const s of sessions) {
        if (!s || typeof s !== 'object') continue;
        const rec = s as Record<string, unknown>;
        if (typeof rec.sessionId !== 'string' || !rec.sessionId) continue;
        const meta = rec._meta as { preview?: unknown } | undefined;
        const preview = typeof meta?.preview === 'string' ? meta.preview : '';
        const title = typeof rec.title === 'string' ? rec.title : '';
        const createdAt = Date.parse(String(rec.updatedAt ?? ''));
        out.push({
          id: rec.sessionId,
          summary: title || preview || '(untitled)',
          ...(Number.isFinite(createdAt) ? { createdAt } : {}),
        });
      }
      return out;
    });
  }
}
