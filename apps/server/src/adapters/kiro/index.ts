import { EventEmitter } from 'events';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import { safeNativeSessionId } from '../sessionId.js';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor,
  EffortLevel, PromptOptions, InteractionMode,
} from '@tierwyn/shared';
import type { ResolvedMcpServer } from '@tierwyn/shared';
import { acpMcpCaps, toAcpMcpServers } from '../../mcp/inject.js';
import { recordAcpMcpCaps } from '../../mcp/resolve.js';
import { clampEffort, sanitisePromptOptions } from '@tierwyn/shared';
import { AcpClient, permissionCancelled, permissionSelected } from './acp.js';
import { mapAcpUpdate, mapKiroVendor } from './mapping.js';
import { listKiroModels } from './models.js';
import { readProfiles } from '../../profiles.js';
import { withImagePathRefs } from '../../imageHelper.js';
import { dbPathFromEnv } from '../../config/env.js';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string; detached?: boolean }) => ChildProcess;
type ExecFileFn = (
  bin: string,
  args: readonly string[],
  opts?: { timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

const execFileDefault = promisify(execFile) as ExecFileFn;
const ACP_PROTOCOL_VERSION = 1;

function kiroModelsCachePath(): string {
  const dbPath = dbPathFromEnv();
  return join(dirname(dbPath), 'kiro-models.json');
}

/** Merge command lists from the two delivery paths (`session/update`
 *  `available_commands_update` and `_kiro.dev/commands/available`):
 *  union by name, later payload wins on conflict, stable order. */
function mergeCommands(
  existing: CommandDescriptor[],
  incoming: CommandDescriptor[],
): CommandDescriptor[] {
  const byName = new Map(existing.map((c) => [c.name, c]));
  for (const c of incoming) byName.set(c.name, c);
  return [...byName.values()];
}

export class KiroAdapter implements AgentAdapter {
  private _emitter = new EventEmitter();
  private _acp: AcpClient | null = null;
  private _sessionId = '';
  private _nativeSessionId = '';
  private _resumeSessionId = '';
  private _model = '';
  private _cwd = '';
  private _seq = 0;
  private _effort?: EffortLevel;
  /** Effort argv the current ACP child was spawned with. */
  private _appliedEffort?: EffortLevel;
  /** Cached from SessionConfig.options so _ensureEffort reconnects keep --trust-all-tools. */
  private _trustAllTools = false;
  private _accepting = false;
  private _sawMessageChunk = false;
  private _commands: CommandDescriptor[] = [];
  private _usage: Partial<Extract<NormalisedEvent, { type: 'status' }>['payload']> = {};
  private _contextPct: number | undefined;
  private _pendingInteractions = new Map<string, (decision: unknown) => void>();
  private _getNextSteer?: () => Promise<{ text: string; attachments?: Attachment[] } | null>;
  /** Soft-yield flag set by interruptTurn(); sendPrompt treats cancel as done + steer. */
  private _turnInterrupted = false;

  private readonly _bin: string;
  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private readonly _execFileFn: ExecFileFn;
  private _interactionMode: InteractionMode;
  private readonly _kiroHome: string;

  constructor(opts: {
    bin?: string;
    spawn?: SpawnFn;
    spawnFn?: SpawnFn;
    execFileFn?: ExecFileFn;
    interactionMode?: 'bypass' | 'questions' | 'prompt';
    kiroHome?: string;
  } = {}) {
    this._bin = opts.bin ?? 'kiro-cli';
    const inner = opts.spawn ?? opts.spawnFn ?? spawn;
    this._spawn = (c, a, o) => inner(c, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'kiro'), detached: true });
    this._spawnFn = this._spawn;
    this._execFileFn = opts.execFileFn ?? execFileDefault;
    this._interactionMode = opts.interactionMode ?? 'bypass';
    this._kiroHome = opts.kiroHome ?? join(homedir(), '.kiro');
  }

  async setPermissionMode(mode: InteractionMode): Promise<void> {
    this._interactionMode = mode;
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
    this._pendingInteractions.clear();
    this._getNextSteer = config.getNextSteer;
    this._effort = clampEffort('kiro', config.effort);
    this._trustAllTools = config.options?.['trustAllTools'] === true;
    await this._connectAcp(this._effort);
  }

  private async _connectAcp(effort: EffortLevel | undefined, resumeOverride?: string): Promise<void> {
    const acp = new AcpClient({
      spawnFn: this._spawnFn, bin: this._bin,
      onRequest: (method, params, reply) => {
        if (method === 'session/request_permission') {
          this._onAcpPermissionRequest(params, reply);
        } else {
          reply({});
        }
      },
    });
    this._acp = acp;
    this._appliedEffort = effort;

    acp.on('notification', ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      if (method.startsWith('_kiro.dev/')) {
        const vendor = mapKiroVendor(method, params);
        if (vendor.commands) this._commands = mergeCommands(this._commands, vendor.commands);
        if (vendor.contextPct !== undefined) this._contextPct = vendor.contextPct;
        if (vendor.status?.type === 'status' && typeof vendor.status.payload.costUsd === 'number') {
          this._usage.costUsd = vendor.status.payload.costUsd;
        }
        return;
      }
      if (method !== 'session/update') return;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const variant = update.sessionUpdate as string | undefined;

      if (variant === 'available_commands_update') {
        const cmds = (update.availableCommands ?? []) as Array<{ name?: string; description?: string }>;
        const mapped = cmds
          .filter((c) => c.name)
          .map((c) => {
            const name = String(c.name).replace(/^\//, '');
            return { name, label: name, description: c.description ?? '', sourceDetail: 'builtin' as const };
          });
        this._commands = mergeCommands(this._commands, mapped);
        return;
      }
      if (this._accepting) {
        for (const partial of mapAcpUpdate(update)) {
          if (partial.type === 'message' && partial.payload.chunk) this._sawMessageChunk = true;
          this._emit(partial);
        }
      }
    });

    acp.on('error', (err: Error) => {
      this._emit({ type: 'error', payload: { message: err.message } });
      this._emit({ type: 'status', payload: { status: 'error' } });
      this._emitter.emit('end');
    });

    acp.start({
      cwd: this._cwd || undefined,
      args: [
        ...(effort ? ['--effort', effort] : []),
        ...(this._trustAllTools ? ['--trust-all-tools'] : []),
      ],
    });

    const init = await acp.request<{ agentCapabilities?: { loadSession?: boolean } }>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    // No `initialized` notification — kiro replies Method not found.

    const cwd = this._cwd || process.cwd();
    const canLoad = Boolean(init.agentCapabilities?.loadSession);
    // Registry MCP: literal values over stdin (not argv). http/sse only where advertised (V6).
    const mcpCaps = acpMcpCaps(init);
    recordAcpMcpCaps('kiro', mcpCaps);
    const mcpServers = toAcpMcpServers(this._mcpServers, mcpCaps);
    const resume = resumeOverride ?? this._resumeSessionId;
    if (resume && canLoad) {
      // kiro-cli deserialises mcpServers as Vec<McpServer>, NOT a map. A map ({} or
      // {name:{...}}) kills the ACP connection with a parse error. Always [].
      await acp.request('session/load', { sessionId: resume, cwd, mcpServers });
      this._nativeSessionId = resume;
    } else {
      // kiro-cli deserialises mcpServers as Vec<McpServer>, NOT a map. A map ({} or
      // {name:{...}}) kills the ACP connection with a parse error. Always [].
      const created = await acp.request<{ sessionId: string }>('session/new', { cwd, mcpServers });
      this._nativeSessionId = safeNativeSessionId(created.sessionId) ?? '';
    }
    // session/load leaves the model unset; without set_model the next prompt
    // can resolve with zero chunks. `auto` is a real kiro model id, not a sentinel.
    if (this._model && this._nativeSessionId) {
      await acp.request('session/set_model', {
        sessionId: this._nativeSessionId,
        modelId: this._model,
      });
    }
  }

  private _turnEffort(options?: PromptOptions): EffortLevel | undefined {
    const raw = sanitisePromptOptions('kiro', options)?.effort;
    if (typeof raw === 'string') return clampEffort('kiro', raw as EffortLevel);
    return this._effort;
  }

  private async _ensureEffort(options?: PromptOptions): Promise<void> {
    const next = this._turnEffort(options);
    if (next === this._appliedEffort) return;
    const old = this._acp;
    old?.removeAllListeners();
    old?.kill();
    this._acp = null;
    await this._connectAcp(next, this._nativeSessionId || this._resumeSessionId);
  }

  async sendPrompt(text: string, attachments?: Attachment[], _model?: string, _effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    await this._ensureEffort(options);
    const acp = this._acp;
    if (!acp) throw new Error('KiroAdapter.sendPrompt called before start()');

    this._accepting = true;
    this._turnInterrupted = false;
    this._sawMessageChunk = false;
    // status:running fires here, after nativeSessionId is set in start(), so
    // sessionManager persists the native id (sessionManager.ts:139-140).
    this._emit({ type: 'status', payload: { status: 'running' } });

    let errored = false;
    let interrupted = false;
    try {
      const result = await acp.request<{ stopReason?: string }>('session/prompt', {
        sessionId: this._nativeSessionId,
        prompt: [{ type: 'text', text: withImagePathRefs(text, attachments) }],
      });
      const reason = (result?.stopReason ?? '').toLowerCase();
      if (this._turnInterrupted || reason === 'cancelled') interrupted = true;
    } catch (err) {
      if (this._turnInterrupted) {
        interrupted = true;
      } else {
        errored = true;
        this._emit({ type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
        this._emit({ type: 'status', payload: { status: 'error' } });
      }
    } finally {
      this._turnInterrupted = false;
    }

    if (!errored) {
      if (!interrupted && !this._sawMessageChunk) {
        errored = true;
        this._emit({
          type: 'error',
          payload: {
            message: `Kiro returned no output (model: ${this._model || 'unset'}). `
              + 'Check the model id against `kiro-cli chat --list-models`.',
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
        this._sawMessageChunk = false;
        this._emit({ type: 'status', payload: { status: 'running' } });
        await acp.request('session/prompt', {
          sessionId: this._nativeSessionId,
          prompt: [{ type: 'text', text: withImagePathRefs(next.text, next.attachments) }],
        });
        if (!this._sawMessageChunk) {
          this._emit({ type: 'error', payload: { message: 'Kiro returned no output on steer follow-up.' } });
          this._emit({ type: 'status', payload: { status: 'error' } });
          break;
        }
        this._emit({ type: 'message', payload: { chunk: '', final: true } });
        this._emit({ type: 'status', payload: this._donePayload() });
      } catch (err) {
        this._emit({ type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
        this._emit({ type: 'status', payload: { status: 'error' } });
        break;
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
    // params._meta.trustOptions (path/command scoping) is richer than hermes;
    // read and ignored for MVP — surfacing it needs a UI change, not an adapter change.
    void (params._meta as { trustOptions?: unknown } | undefined)?.trustOptions;

    // questions has no AskUserQuestion here — every ACP permission is a tool gate, so auto-allow like bypass
    if (this._interactionMode === 'bypass' || this._interactionMode === 'questions') {
      const options = (params.options ?? []) as Array<{ optionId: string; kind?: string }>;
      const allow = options.find((o) => (o.kind ?? '').includes('allow')) ?? options[0];
      reply(allow ? permissionSelected(allow.optionId) : permissionCancelled());
      return;
    }
    const requestId = randomUUID();
    const options = (params.options ?? []) as Array<{ optionId: string; kind?: string; label?: string }>;
    this._pendingInteractions.set(requestId, reply);
    this._emit({
      type: 'interaction_request',
      payload: {
        requestId,
        kind: 'permission',
        prompt: String(params.description ?? 'The agent is requesting permission'),
        choices: options.map((o) => ({ id: o.optionId, label: o.label ?? o.kind ?? o.optionId })),
        allowFreeText: false,
      },
    });
    this._emit({ type: 'status', payload: { status: 'waiting' } });
  }

  respondToInteraction(requestId: string, response: { selection: string[]; text?: string }): void {
    const reply = this._pendingInteractions.get(requestId);
    if (!reply) return;
    this._pendingInteractions.delete(requestId);
    this._emit({
      type: 'interaction_resolved',
      payload: { requestId, selection: response.selection, text: response.text, resolution: 'answered' },
    });
    this._emit({ type: 'status', payload: { status: 'running' } });
    reply(permissionSelected(response.selection[0] ?? ''));
  }

  async stop(): Promise<void> {
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
    const models = await listKiroModels({
      bin: this._bin,
      cachePath: kiroModelsCachePath(),
      execFileFn: this._execFileFn,
    });
    if (models.length > 0) return models;
    return readProfiles()
      .filter((p) => p.agentType === 'kiro')
      .map((p) => ({
        name: p.model,
        label: p.label,
        provider: p.provider,
        vision: p.vision,
        steer: p.steer,
        contextWindow: p.contextWindow,
      }));
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    return this._commands;
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const prefix = `/${name}`;
    await this.sendPrompt(args?.trim() ? `${prefix} ${args}` : prefix, undefined, undefined, undefined, options);
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    try {
      const { stdout } = await this._execFileFn(
        this._bin, ['chat', '--list-sessions', '--format', 'json'],
        { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 },
      );
      const raw = JSON.parse(typeof stdout === 'string' ? stdout : String(stdout)) as unknown;
      const envelopes = Array.isArray(raw) ? raw : [];
      const out: { id: string; summary: string; createdAt?: number }[] = [];
      for (const env of envelopes) {
        if (!env || typeof env !== 'object') continue;
        const sessions = (env as { sessions?: unknown }).sessions;
        if (!Array.isArray(sessions)) continue;
        for (const s of sessions) {
          if (!s || typeof s !== 'object') continue;
          const rec = s as Record<string, unknown>;
          if (typeof rec.sessionId !== 'string' || !rec.sessionId) continue;
          const createdAt = Date.parse(String(rec.updatedAt ?? ''));
          out.push({
            id: rec.sessionId,
            summary: typeof rec.title === 'string' && rec.title ? rec.title : '(untitled)',
            ...(Number.isFinite(createdAt) ? { createdAt } : {}),
          });
        }
      }
      return out;
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
      return existsSync(join(this._kiroHome, 'sessions', 'cli', `${nativeSessionId}.json`));
    } catch {
      return false;
    }
  }

  getLiveContextWindowUsage(): { contextWindowPct?: number } {
    return this._contextPct !== undefined ? { contextWindowPct: this._contextPct } : {};
  }

  get nativeSessionId(): string { return this._nativeSessionId || this._resumeSessionId; }
}
