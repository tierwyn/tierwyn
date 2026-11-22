// apps/server/src/adapters/hermes/index.ts
import { EventEmitter } from 'events';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { spawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import type {
  AgentAdapter, SessionConfig, Attachment, NormalisedEvent, ModelDescriptor, CommandDescriptor,
  EffortLevel, PromptOptions, InteractionMode, ResolvedMcpServer,
} from '@tierwyn/shared';
import { sanitisePromptOptions } from '@tierwyn/shared';
import { acpMcpCaps, toAcpMcpServers } from '../../mcp/inject.js';
import { recordAcpMcpCaps } from '../../mcp/resolve.js';
import { AcpClient } from './acp.js';
import { mapAcpUpdate } from './mapping.js';
import { scanSkillDir } from '../skillScan.js';
import { readHermesModels } from './modelsCache.js';
import { readProfiles } from '../../profiles.js';
import { openAgentSqliteReadonly } from '../agentSqlite.js';
import { safeNativeSessionId } from '../sessionId.js';
import { withImagePathRefs } from '../../imageHelper.js';

type SpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

const ACP_PROTOCOL_VERSION = 1;

/** Hermes ACP expects provider/model (pi-style). Catalogue rows may use
 *  provider:model; some models accept set_model with the colon form but then
 *  emit zero message chunks on prompt — silent failure. */
export function normalizeHermesModelId(model: string): string {
  if (!model.includes('/') && model.includes(':')) {
    const colon = model.indexOf(':');
    return `${model.slice(0, colon)}/${model.slice(colon + 1)}`;
  }
  return model;
}

/** Auto-answer an inbound ACP request. We declare no client fs/terminal
 *  capabilities, so the only request we expect is session/request_permission;
 *  pick an option whose kind contains "allow", else the first option. */
export function autoAllow(method: string, params: Record<string, unknown>, reply: (result: unknown) => void): void {
  if (method === 'session/request_permission') {
    const options = (params.options ?? []) as Array<{ optionId: string; kind?: string }>;
    const allow = options.find((o) => (o.kind ?? '').includes('allow')) ?? options[0];
    reply({ outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } });
  } else {
    reply({});
  }
}

export class HermesAdapter implements AgentAdapter {
  private _emitter = new EventEmitter();
  private _acp: AcpClient | null = null;
  private _sessionId = '';
  private _nativeSessionId = '';
  private _resumeSessionId = '';
  private _model = '';
  private _cwd = '';
  private _seq = 0;
  private _accepting = false; // true only after sendPrompt() fires; suppresses session/load replays
  private _sawMessageChunk = false;
  private _commands: CommandDescriptor[] = [];
  private _usage: Partial<Extract<NormalisedEvent, { type: 'status' }>['payload']> = {};
  private _pendingInteractions = new Map<string, (decision: unknown) => void>();
  private _getNextSteer?: () => Promise<{ text: string; attachments?: Attachment[] } | null>;
  /** Soft-yield flag set by interruptTurn(); sendPrompt treats cancel as done + steer. */
  private _turnInterrupted = false;
  /** Whether the current ACP child was spawned with top-level --yolo. */
  private _appliedYolo = false;

  private readonly _bin: string;
  readonly _spawn: SpawnFn;
  private readonly _spawnFn: SpawnFn;
  private _interactionMode: InteractionMode;
  private readonly _dbPath?: string;
  private readonly _hermesHome: string;

  constructor(opts: { spawn?: SpawnFn; spawnFn?: SpawnFn; bin?: string; interactionMode?: 'bypass' | 'questions' | 'prompt'; dbPath?: string; hermesHome?: string } = {}) {
    this._bin = opts.bin ?? 'hermes';
    const inner = opts.spawn ?? opts.spawnFn ?? spawn;
    this._spawn = (c, a, o) => inner(c, a, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'hermes') });
    this._spawnFn = this._spawn;
    this._interactionMode = opts.interactionMode ?? 'bypass';
    this._dbPath = opts.dbPath;
    this._hermesHome = opts.hermesHome ?? join(homedir(), '.hermes');
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

  /** Registry MCP for the main session. */
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
    this._commands = [];
    this._pendingInteractions.clear();
    this._getNextSteer = config.getNextSteer;
    await this._connectAcp(false);
  }

  private async _connectAcp(yolo: boolean, resumeOverride?: string): Promise<void> {
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
    this._appliedYolo = yolo;

    acp.on('notification', ({ method, params }: { method: string; params: Record<string, unknown> }) => {
      if (method !== 'session/update') return;
      const update = (params.update ?? {}) as Record<string, unknown>;
      const variant = update.sessionUpdate as string | undefined;

      if (variant === 'available_commands_update') {
        const cmds = (update.availableCommands ?? []) as Array<{ name?: string; description?: string }>;
        this._commands = cmds
          .filter((c) => c.name)
          .map((c) => ({ name: String(c.name), label: String(c.name), description: c.description ?? '', sourceDetail: 'builtin' as const }));
        return;
      }
      if (variant === 'cost') {
        const cost = (update.cost ?? {}) as Record<string, unknown>;
        if (typeof cost.totalCostUsd === 'number') this._usage.costUsd = cost.totalCostUsd;
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
      prefixArgs: yolo ? ['--yolo'] : [],
      args: ['--accept-hooks'],
    });

    const init = await acp.request<{ agentCapabilities?: { loadSession?: boolean } }>('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });

    const cwd = this._cwd || process.cwd();
    const canLoad = Boolean(init.agentCapabilities?.loadSession);
    const resume = resumeOverride ?? this._resumeSessionId;
    // Registry MCP: literal values over stdin (not argv). http/sse only where advertised.
    const mcpCaps = acpMcpCaps(init);
    recordAcpMcpCaps('hermes', mcpCaps);
    const mcpServers = toAcpMcpServers(this._mcpServers, mcpCaps);
    if (resume && canLoad) {
      await acp.request('session/load', { sessionId: resume, cwd, mcpServers });
      this._nativeSessionId = resume;
    } else {
      const created = await acp.request<{ sessionId: string }>('session/new', { cwd, mcpServers });
      this._nativeSessionId = safeNativeSessionId(created.sessionId) ?? '';
    }
    // session/load restores history but leaves the model unset; without
    // set_model the next session/prompt can resolve immediately with zero
    // message chunks (looks like Hermes is ignoring the operator).
    // Fresh session/new also needs this so the catalogue model is selected.
    if (this._model && this._nativeSessionId) {
      await acp.request('session/set_model', {
        sessionId: this._nativeSessionId,
        modelId: normalizeHermesModelId(this._model),
      });
    }
  }

  private async _ensureYolo(options?: PromptOptions): Promise<void> {
    const next = sanitisePromptOptions('hermes', options)?.yolo === true;
    if (next === this._appliedYolo) return;
    const old = this._acp;
    old?.removeAllListeners();
    old?.kill();
    this._acp = null;
    await this._connectAcp(next, this._nativeSessionId || this._resumeSessionId);
  }

  async sendPrompt(text: string, attachments?: Attachment[], _model?: string, _effort?: EffortLevel, options?: PromptOptions): Promise<void> {
    await this._ensureYolo(options);
    const acp = this._acp;
    if (!acp) throw new Error('HermesAdapter.sendPrompt called before start()');

    // Open the gate before session/prompt so all notifications from this turn
    // are captured. session/load replays (during start()) are suppressed because
    // _accepting is false until here.
    this._accepting = true;
    this._turnInterrupted = false;
    // status:running fires here, after nativeSessionId is set in start(), so
    // sessionManager persists the native id (sessionManager.ts:139-140).
    this._emit({ type: 'status', payload: { status: 'running' } });

    let errored = false;
    let interrupted = false;
    try {
      await acp.request('session/prompt', {
        sessionId: this._nativeSessionId,
        prompt: [{ type: 'text', text: withImagePathRefs(text, attachments) }],
      });
      if (this._turnInterrupted) interrupted = true;
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
            message: `Hermes returned no output (model: ${this._model || 'unset'}). `
              + 'Check the profile model id uses provider/model form (e.g. zai/glm-5.2).',
          },
        });
        this._emit({ type: 'status', payload: { status: 'error' } });
      } else {
        this._emit({ type: 'message', payload: { chunk: '', final: true } });
        this._emit({ type: 'status', payload: { status: 'done', ...this._usage } });
      }
    }

    // After the turn completes, enter the steer polling loop — same shape as
    // the pi adapter's _steerLoop. SessionManager.pullNextSteer parks a
    // Promise resolver that only fires when the operator queues a steer via
    // steerSession; a null return means stop() was called (resolver resolved
    // with null) — then we exit the loop. The loop MUST be long-running: a
    // single poll would never see steers queued after the first await, and
    // SessionManager would report 'queued' but nothing would drain it.
    //
    // Do NOT emit 'end' here. SessionManager treats 'end' as session-complete
    // (tears down the SessionRecord, drops steerResolvers, follow-up dispatch).
    // The adapter stays alive between turns so queued steers can be delivered
    // through this loop. 'end' fires from stop() (or the ACP error handler)
    // — that's the true session-complete signal. Mirrors claude-code + pi.
    // Soft-interrupt also enters the loop so queued sourced steers drain.
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
          this._emit({ type: 'error', payload: { message: 'Hermes returned no output on steer follow-up.' } });
          this._emit({ type: 'status', payload: { status: 'error' } });
          break;
        }
        this._emit({ type: 'message', payload: { chunk: '', final: true } });
        this._emit({ type: 'status', payload: { status: 'done', ...this._usage } });
      } catch (err) {
        this._emit({ type: 'error', payload: { message: err instanceof Error ? err.message : String(err) } });
        this._emit({ type: 'status', payload: { status: 'error' } });
        break;
      }
    }
    this._emitter.emit('end');
  }

  async steer(text: string, attachments?: Attachment[]): Promise<void> {
    const acp = this._acp;
    if (!acp) throw new Error('HermesAdapter.steer called before start()');
    // Hermes responds immediately with a synthetic end_turn ack and queues
    // the text as a follow-up turn in the same native session.
    await acp.request('session/prompt', {
      sessionId: this._nativeSessionId,
      prompt: [{ type: 'text', text: withImagePathRefs(text, attachments) }],
    });
  }

  /** Soft-end the live prompt (session/cancel) without killing the ACP process.
   *  Lets SessionManager yield mid-turn when a sourced notify is queued. */
  interruptTurn(): void {
    if (!this._acp || !this._nativeSessionId) return;
    this._turnInterrupted = true;
    this._acp.notify('session/cancel', { sessionId: this._nativeSessionId });
  }

  private _onAcpPermissionRequest(params: Record<string, unknown>, reply: (decision: unknown) => void): void {
    // questions has no AskUserQuestion here — every ACP permission is a tool gate, so auto-allow like bypass
    if (this._interactionMode === 'bypass' || this._interactionMode === 'questions') {
      autoAllow('session/request_permission', params, reply);
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
    const optionId = response.selection[0] ?? '';
    this._emit({
      type: 'interaction_resolved',
      payload: { requestId, selection: response.selection, text: response.text, resolution: 'answered' },
    });
    this._emit({ type: 'status', payload: { status: 'running' } });
    reply({ outcome: { outcome: 'selected', optionId } });
  }

  async stop(): Promise<void> {
    try {
      for (const [requestId, reply] of this._pendingInteractions) {
        this._emit({ type: 'interaction_resolved', payload: { requestId, selection: [], resolution: 'auto' } });
        reply({ outcome: { outcome: 'cancelled' } });
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
    const cached = readHermesModels(this._hermesHome);
    if (cached.length > 0) return cached;
    return readProfiles()
      .filter((p) => p.agentType === 'hermes')
      .map((p) => ({
        name: p.model,
        label: p.label,
        provider: p.provider,
        vision: p.vision,
        steer: p.steer,
      }));
  }

  async listCommands(): Promise<CommandDescriptor[]> {
    // Prefer commands learned live from ACP; fall back to scanning user skills.
    if (this._commands.length > 0) return this._commands;
    return scanSkillDir(join(this._hermesHome, 'skills'));
  }

  async runCommand(name: string, args?: string, options?: PromptOptions): Promise<void> {
    const prefix = `/${name}`;
    await this.sendPrompt(args?.trim() ? `${prefix} ${args}` : prefix, undefined, undefined, undefined, options);
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    const dbPath = this._dbPath ?? join(homedir(), '.hermes', 'state.db');
    let db: ReturnType<typeof openAgentSqliteReadonly>;
    try {
      db = openAgentSqliteReadonly(dbPath);
    } catch {
      return [];
    }
    try {
      const rows = db
        .prepare("SELECT id, title, started_at FROM sessions WHERE source = 'acp' ORDER BY started_at DESC LIMIT 200")
        .all() as { id: string; title: string | null; started_at: number | null }[];
      return rows.map((r) => ({
        id: r.id,
        summary: r.title || r.id,
        createdAt: r.started_at ? Math.round(r.started_at * 1000) : undefined,
      }));
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  async loadSession(id: string): Promise<void> {
    this._resumeSessionId = safeNativeSessionId(id) ?? '';
  }

  async isNativeSessionAvailable(nativeSessionId: string): Promise<boolean> {
    if (!nativeSessionId) return false;
    const dbPath = this._dbPath ?? join(homedir(), '.hermes', 'state.db');
    let db: ReturnType<typeof openAgentSqliteReadonly>;
    try {
      db = openAgentSqliteReadonly(dbPath);
    } catch {
      return false;
    }
    try {
      const row = db
        .prepare("SELECT 1 FROM sessions WHERE id = ? AND source = 'acp'")
        .get(nativeSessionId);
      return !!row;
    } catch {
      return false;
    } finally {
      db.close();
    }
  }

  get nativeSessionId(): string { return this._nativeSessionId; }
}
