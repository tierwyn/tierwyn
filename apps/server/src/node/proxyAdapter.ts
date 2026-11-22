import { EventEmitter } from 'events';
import type { Database } from 'better-sqlite3';
import type {
  AgentAdapter,
  Attachment,
  SandboxPath,
  CommandDescriptor,
  EffortLevel,
  ModelDescriptor,
  NodeFrame,
  NodeHello,
  NormalisedEvent,
  OneShotMode,
  OneShotOpts,
  OneShotResult,
  PromptOptions,
  ResolvedMcpServer,
  SessionConfig,
} from '@tierwyn/shared';
import {
  ADAPTER_CALL_METHODS,
  hostHasFeature,
  OPTIONAL_ADAPTER_METHODS,
  SESSION_CALL_METHODS,
} from '@tierwyn/shared';
import { registry, type AdapterFactoryOpts } from '../registry.js';
import { bridgeServers, recordHostMcpSkips, revokeBridgeKeysForSession } from '../mcp/bridge.js';
import { remoteHostIdFor } from '../repositories/remoteHosts.js';
import { RpcError, type RpcPeer } from './rpc.js';

export function createAdapterFor(
  db: Database,
  agentType: string,
  ref: { conversationId?: string; projectId?: string },
  opts?: AdapterFactoryOpts,
): AgentAdapter {
  const remoteHostId = remoteHostIdFor(db, ref);
  return registry.create(agentType, { ...opts, ...(remoteHostId ? { remoteHostId } : {}) });
}

export interface NodeLink {
  hostId: string;
  hello(): NodeHello | undefined;
  connected(): boolean;
  request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T>;
  subscribe(sid: string, l: (f: Extract<NodeFrame, { sid: string }>) => void): () => void;
  setSteerSource(sid: string, fn: ((signal?: AbortSignal) => Promise<{ text: string; attachments?: Attachment[] } | null>) | undefined): void;
}

type SteerFn = (signal?: AbortSignal) => Promise<{ text: string; attachments?: Attachment[] } | null>;

export function linkFromPeer(hostId: string, peer: RpcPeer, hello: NodeHello): NodeLink {
  let up = true;
  const steers = new Map<string, SteerFn>();
  const subscribed = new Set<string>();
  const listeners = new Set<(f: NodeFrame) => void>();
  const closed = new Promise<void>((resolve) => {
    peer.on('close', () => {
      up = false;
      for (const sid of subscribed) {
        const end: Extract<NodeFrame, { t: 'end' }> = { t: 'end', sid, seq: 0 };
        for (const cb of listeners) cb(end);
      }
      steers.clear();
      resolve();
    });
  });
  peer.setHandler('steer.next', async (p) => {
    const { sid } = p as { sid: string };
    const fn = steers.get(sid);
    if (!fn) return null;
    const work = fn();
    const raced = await Promise.race([
      work.then((r) => ({ kind: 'ok' as const, r })),
      closed.then(() => ({ kind: 'closed' as const })),
    ]);
    if (raced.kind === 'closed') return null;
    if (!up) return null;
    return stripSteer(raced.r);
  });
  peer.on('frame', (f: NodeFrame) => {
    for (const cb of listeners) cb(f);
  });
  return {
    hostId,
    hello: () => hello,
    connected: () => up,
    async request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T> {
      if (!up) throw new RpcError('host_disconnected', 'host disconnected');
      try {
        return await peer.request<T>(m, p, timeoutMs);
      } catch (e) {
        if (e instanceof RpcError && e.code === 'disconnected') {
          up = false;
          throw new RpcError('host_disconnected', e.message);
        }
        throw e;
      }
    },
    subscribe(sid, l) {
      subscribed.add(sid);
      const cb = (f: NodeFrame) => {
        if ('sid' in f && f.sid === sid) l(f);
      };
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
    setSteerSource(sid, fn) {
      if (fn) steers.set(sid, fn);
      else steers.delete(sid);
    },
  };
}

function stripTempPath(attachments?: Attachment[]): Attachment[] | undefined {
  if (!attachments) return attachments;
  return attachments.map(({ tempPath: _t, ...rest }) => rest);
}

function stripSteer(
  r: { text: string; attachments?: Attachment[] } | null,
): { text: string; attachments?: Attachment[] } | null {
  if (!r) return null;
  if (!r.attachments) return r;
  return { ...r, attachments: stripTempPath(r.attachments) };
}

function trimTrailingUndefined(args: unknown[]): unknown[] {
  let end = args.length;
  while (end > 0 && args[end - 1] === undefined) end--;
  return args.slice(0, end);
}

export class RemoteAdapterProxy implements AgentAdapter {
  private readonly emitter = new EventEmitter();
  private sid = '';
  private conversationId = '';
  private unsub?: () => void;
  private lastCtx: { contextWindowPct?: number; contextWindowSize?: number } | undefined;
  private _nativeSessionId?: string;
  steer?: (text: string, attachments?: Attachment[]) => Promise<void>;
  interruptTurn?: () => void;
  getLiveContextWindowUsage?: () => { contextWindowPct?: number; contextWindowSize?: number };
  listCommands?: () => Promise<CommandDescriptor[]>;
  isNativeSessionAvailable?: (nativeSessionId: string) => Promise<boolean>;
  rewindNativeSession?: (nativeSessionId: string, toTurn: number) => Promise<string>;
  exciseNativeTurn?: (nativeSessionId: string, turnToRemove: number) => Promise<string>;
  deleteNativeSession?: (nativeSessionId: string) => Promise<void>;
  runCommand?: (name: string, args?: string, options?: PromptOptions) => Promise<void>;
  mcpStatus?: () => Promise<never>;
  mcpControl?: (name: string, action: never) => Promise<void>;
  stopHelper?: (taskId: string) => Promise<void>;
  respondToInteraction?: (
    requestId: string,
    response: { selection: string[]; text?: string; answers?: { selection: string[]; text?: string }[] },
  ) => void;
  setPermissionMode?: (mode: 'bypass' | 'questions' | 'prompt') => Promise<void>;
  setModelLive?: (model: string) => Promise<void>;
  setMcpServersLive?: (servers: never[]) => Promise<boolean>;
  oneShot?: (prompt: string, opts?: OneShotOpts) => Promise<OneShotResult>;
  readonly oneShotModes?: readonly OneShotMode[];

  constructor(
    private readonly link: NodeLink,
    private readonly agentType: string,
    private readonly opts: { interactionMode: 'bypass' | 'questions' | 'prompt'; allowMcpSecrets: boolean; sandbox?: boolean; sandboxPaths?: SandboxPath[]; prepareEnv?: () => Promise<void> },
  ) {
    if (agentType === 'grok-bot') throw new RpcError('agent_not_allowed', 'grok-bot');
    this.oneShotModes = (link.hello()?.agents[agentType] as { oneShotModes?: OneShotMode[] } | undefined)?.oneShotModes;
    const methods = new Set(link.hello()?.agents[agentType]?.methods ?? []);
    for (const name of OPTIONAL_ADAPTER_METHODS) {
      if (name === 'estimateTokenCount' || name === 'oneShotModes') continue;
      if (!methods.has(name)) continue;
      this.defineOptional(name);
    }
  }

  private defineOptional(name: string): void {
    if (name === 'interruptTurn') {
      this.interruptTurn = () => {
        void this.link.request('session.interrupt', { sid: this.sid })
          .catch((e) => { console.warn('interruptTurn', e); });
      };
      return;
    }
    if (name === 'respondToInteraction') {
      this.respondToInteraction = (requestId, response) => {
        void this.sessionCall('respondToInteraction', [requestId, response])
          .catch((e) => { console.warn('respondToInteraction', e); });
      };
      return;
    }
    if (name === 'getLiveContextWindowUsage') {
      this.getLiveContextWindowUsage = () => this.lastCtx ?? {};
      return;
    }
    if (name === 'steer') {
      this.steer = async (text, attachments) => {
        await this.sessionCall('steer', [text, stripTempPath(attachments)]);
      };
      return;
    }
    if (name === 'setMcpServersLive') {
      this.setMcpServersLive = async (servers) => {
        const bridged = this.bridgeMcpServers(servers as unknown as ResolvedMcpServer[] | undefined);
        const filtered = this.filterMcpServers(bridged);
        return await this.sessionCall('setMcpServersLive', [filtered]) as boolean;
      };
      return;
    }
    if (name === 'isNativeSessionAvailable') {
      // Offline host → not resumable; a rejection here crashed async Express routes.
      this.isNativeSessionAvailable = async (nativeSessionId) => {
        try {
          return await this.adapterCall(name, [nativeSessionId]) as boolean;
        } catch (e) {
          if (e instanceof RpcError && e.code === 'host_disconnected') return false;
          throw e;
        }
      };
      return;
    }
    if (name === 'runCommand') {
      this.runCommand = async (...args) => { await this.turnCall('runCommand', args); };
      return;
    }
    if (name === 'oneShot') {
      this.oneShot = async (prompt, opts) => {
        const timeoutSecs = opts?.timeoutSecs ?? (opts?.mode === 'read_only' ? 120 : 60);
        return await this.adapterCall('oneShot', [prompt, opts], (timeoutSecs + 15) * 1000) as OneShotResult;
      };
      return;
    }
    if ((SESSION_CALL_METHODS as readonly string[]).includes(name)) {
      (this as unknown as Record<string, unknown>)[name] = async (...args: unknown[]) => {
        return await this.sessionCall(name, args);
      };
      return;
    }
    if ((ADAPTER_CALL_METHODS as readonly string[]).includes(name)) {
      (this as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => this.adapterCall(name, args);
    }
  }

  /** Hub-placed servers are rewritten to the node's tunnel listener with a per-session key. */
  private bridgeMcpServers(servers?: ResolvedMcpServer[]): ResolvedMcpServer[] | undefined {
    if (!servers || !servers.some((s) => s.placement === 'hub')) {
      revokeBridgeKeysForSession(this.sid);
      return servers;
    }
    return bridgeServers(servers, {
      conversationId: this.conversationId,
      sessionId: this.sid,
      hostId: this.link.hostId,
      listenPort: this.link.hello()?.listenPort ?? 0,
    });
  }

  private filterMcpServers(servers?: ResolvedMcpServer[]): ResolvedMcpServer[] | undefined {
    if (!servers || this.opts.allowMcpSecrets) return servers;
    // Hub-placed servers carry only the tunnel bridge key — no operator secret leaves the hub.
    const kept = servers.filter(
      (s) => s.placement === 'hub' ||
        ((s.secretEnvKeys?.length ?? 0) === 0 && (s.secretHeaderKeys?.length ?? 0) === 0),
    );
    const dropped = servers.filter((s) => !kept.includes(s)).map((s) => s.id);
    if (dropped.length) {
      console.warn(`Remote host: dropping MCP servers with secrets: ${dropped.join(', ')}`);
    }
    return kept;
  }

  private sessionCall(method: string, args: unknown[], timeoutMs?: number): Promise<unknown> {
    return this.link.request('session.call', {
      sid: this.sid,
      method,
      args: trimTrailingUndefined(args),
    }, timeoutMs);
  }

  /**
   * sendPrompt / runCommand run for the whole adapter lifetime (claude-code
   * holds open on its steer stream), so they park with no RPC timer. A drop
   * mid-turn is swallowed: hub grace / session.resume drive err+end frames.
   */
  private async turnCall(method: string, args: unknown[]): Promise<void> {
    try {
      await this.sessionCall(method, args, 0);
    } catch (e) {
      if (e instanceof RpcError && e.code === 'host_disconnected') return;
      throw e;
    }
  }

  private adapterCall(method: string, args: unknown[], timeoutMs?: number): Promise<unknown> {
    return this.link.request('adapter.call', {
      agentType: this.agentType,
      method,
      args: trimTrailingUndefined(args),
    }, timeoutMs);
  }

  async start(config: SessionConfig): Promise<void> {
    this.sid = config.sessionId;
    this.conversationId = config.conversationId;
    this._nativeSessionId = config.nativeSessionId ?? this._nativeSessionId;
    if (this.opts.sandbox && !hostHasFeature(this.link.hello(), 'sandbox')) {
      throw new RpcError('node_update_required', 'node_update_required');
    }
    if (this.opts.sandboxPaths?.length && !hostHasFeature(this.link.hello(), 'sandbox_paths')) {
      throw new RpcError('node_update_required', 'node_update_required');
    }
    this.unsub?.();
    this.unsub = this.link.subscribe(this.sid, (f) => this.onFrame(f));
    try {
      // Push per-agent vault env before the node spawns any child for this session.
      await this.opts.prepareEnv?.();
      await this.link.request('session.create', {
        sid: this.sid,
        agentType: this.agentType,
        factoryOpts: {
          interactionMode: this.opts.interactionMode,
          sandbox: this.opts.sandbox === true,
          ...(this.opts.sandboxPaths?.length ? { sandboxPaths: this.opts.sandboxPaths } : {}),
        },
      });
    } catch (err) {
      this.unsub?.();
      this.unsub = undefined;
      throw err;
    }
    const { getNextSteer, mcpServers, ...rest } = config;
    const servers = this.filterMcpServers(this.bridgeMcpServers(mcpServers));
    const wire = {
      ...rest,
      mcpServers: servers,
      hasSteerSource: !!getNextSteer,
    };
    this.link.setSteerSource(this.sid, getNextSteer);
    try {
      const r = await this.sessionCall('start', [wire]);
      // Node-side stdio preflight skips (binary/cwd) — surfaced to the operator via /mcp.
      recordHostMcpSkips(
        config.conversationId,
        (r as { mcpSkipped?: Array<{ id: string; reason: 'command_not_found_on_host' | 'cwd_outside_roots' }> } | undefined)
          ?.mcpSkipped ?? [],
      );
    } catch (err) {
      revokeBridgeKeysForSession(this.sid);
      this.link.setSteerSource(this.sid, undefined);
      this.unsub?.();
      this.unsub = undefined;
      throw err;
    }
  }

  async sendPrompt(
    text: string,
    attachments?: Attachment[],
    model?: string,
    effort?: EffortLevel,
    options?: PromptOptions,
  ): Promise<void> {
    const args: unknown[] = [text];
    if (attachments !== undefined || model !== undefined || effort !== undefined || options !== undefined) {
      args.push(stripTempPath(attachments), model, effort, options);
    }
    await this.turnCall('sendPrompt', args);
  }

  streamEvents(): EventEmitter {
    return this.emitter;
  }

  async stop(): Promise<void> {
    revokeBridgeKeysForSession(this.sid);
    try {
      await this.sessionCall('stop', []);
    } catch (e) {
      if (e instanceof RpcError && (e.code === 'host_disconnected' || e.code === 'unknown_session')) {
        this.emitter.emit('end');
        this.unsub?.();
        this.unsub = undefined;
        return;
      }
      throw e;
    } finally {
      this.link.setSteerSource(this.sid, undefined);
    }
  }

  async listSessions(): Promise<{ id: string; summary: string; createdAt?: number }[]> {
    return await this.sessionCall('listSessions', []) as { id: string; summary: string; createdAt?: number }[];
  }

  async loadSession(id: string): Promise<void> {
    await this.sessionCall('loadSession', [id]);
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.link.connected()) return [];
    try {
      return await this.adapterCall('listModels', []) as ModelDescriptor[];
    } catch (e) {
      if (e instanceof RpcError && e.code === 'host_disconnected') return [];
      throw e;
    }
  }

  private onFrame(f: Extract<NodeFrame, { sid: string }>): void {
    if (f.t === 'ev') this.emitter.emit('event', f.ev);
    else if (f.t === 'err') this.emitter.emit('error', new Error(f.message));
    else if (f.t === 'end') {
      revokeBridgeKeysForSession(this.sid);
      this.emitter.emit('end');
      this.link.setSteerSource(this.sid, undefined);
      this.unsub?.();
      this.unsub = undefined;
    } else if (f.t === 'ctx') {
      if (f.contextWindowPct !== undefined || f.contextWindowSize !== undefined) {
        this.lastCtx = { contextWindowPct: f.contextWindowPct, contextWindowSize: f.contextWindowSize };
      }
      if (f.nativeSessionId) {
        this._nativeSessionId = f.nativeSessionId;
      }
    }
  }

  get nativeSessionId(): string | undefined {
    return this._nativeSessionId;
  }
}
