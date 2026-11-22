import { createPublicKey, randomBytes, verify } from 'crypto';
import { appendFileSync, closeSync, openSync } from 'fs';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import type { Database } from 'better-sqlite3';
import { WebSocketServer } from 'ws';
import { envPref } from '../config/env.js';
import {
  NODE_MAX_FRAME_BYTES,
  NODE_PROTOCOL,
  authPayload,
  hostHasFeature,
  type AgentEnvSyncParams,
  type Attachment,
  type NodeFrame,
  type NodeHello,
  type RemoteHostView,
  type AgentsLoginEvent,
  type AgentsLoginStatusResult,
} from '@tierwyn/shared';
import {
  getRemoteHost,
  saveHello,
  sanitizeHelloVersion,
  type RemoteHostRow,
} from '../repositories/remoteHosts.js';
import { loadAllAgentEnv } from '../secrets/agentEnv.js';
import { disconnectedHostView } from '../routes/remoteHosts.js';
import { sidecarHostAdvisories } from '../sidecar.js';
import {
  RpcError,
  RpcPeer,
  wsTransport,
  type FrameTransport,
} from './rpc.js';
import type { NodeLink } from './proxyAdapter.js';
import type { TunnelRequest, TunnelResponse } from './tunnel.js';
import { HubStreamRouter, type HubStreamReplay } from './tunnelStream.js';

export interface NodeHubDeps {
  db: () => Database;
  onStatus: (v: RemoteHostView) => void;
  onLoginEvent?: (hostId: string, ev: AgentsLoginEvent) => void;
  isLiveSession: (sid: string) => boolean;
  now?: () => number;
  pingMs?: number;
  missLimit?: number;
  handshakeMs?: number;
  /** Auth-phase deadline before hello. Default 10_000. Independent of handshakeMs. */
  authMs?: number;
  /** Hub-side wait after disconnect before err+end. Default 150_000 (node grace + 30s). */
  hubGraceMs?: number;
}

type SteerFn = (signal?: AbortSignal) => Promise<{ text: string; attachments?: Attachment[] } | null>;
type SidFrame = Extract<NodeFrame, { sid: string }>;

interface Conn {
  peer: RpcPeer;
  pingTimer?: ReturnType<typeof setTimeout>;
  misses: number;
}

class HubLink implements NodeLink {
  currentHello: NodeHello | undefined;
  peer: RpcPeer | undefined;
  /** Wall time of the last successful hello bind (reconnect), not refresh. */
  boundAt = 0;
  private up = false;
  private readonly listeners = new Map<string, Set<(f: SidFrame) => void>>();
  private readonly steers = new Map<string, SteerFn>();
  private readonly lastSeqs = new Map<string, number>();
  private closedWait: Promise<void> = Promise.resolve();
  private resolveClosed: () => void = () => {};

  constructor(
    readonly hostId: string,
    private readonly onLoginEvent?: (ev: AgentsLoginEvent) => void,
  ) {}

  hasSubscriber(sid: string): boolean {
    return (this.listeners.get(sid)?.size ?? 0) > 0;
  }

  subscribedSids(): string[] {
    return [...this.listeners.keys()];
  }

  lastSeq(sid: string): number {
    return this.lastSeqs.get(sid) ?? 0;
  }

  bind(peer: RpcPeer, hello: NodeHello, at = Date.now()): void {
    if (this.up) this.markDown(this.peer);
    this.peer = peer;
    this.currentHello = hello;
    this.boundAt = at;
    this.up = true;
    this.closedWait = new Promise((resolve) => { this.resolveClosed = resolve; });
    peer.setHandler('steer.next', (p) => this.handleSteer(p));
    peer.setHandler('agents.loginEvent', async (p) => {
      this.onLoginEvent?.(p as AgentsLoginEvent);
      return { ok: true };
    });
    peer.on('frame', (f: NodeFrame) => this.routeFrame(f));
  }

  markDown(peer?: RpcPeer): void {
    if (peer && peer !== this.peer) return;
    this.up = false;
    this.peer = undefined;
    this.resolveClosed();
  }

  hello(): NodeHello | undefined { return this.currentHello; }
  /** Update the in-memory hello without touching connect bookkeeping (used by Refresh). */
  setHello(h: NodeHello): void { this.currentHello = h; }
  connected(): boolean { return this.up && !!this.peer; }

  async request<T = unknown>(m: string, p?: unknown, timeoutMs?: number): Promise<T> {
    const peer = this.peer;
    if (!this.up || !peer) throw new RpcError('host_disconnected', 'host disconnected');
    try {
      return await peer.request<T>(m, p, timeoutMs);
    } catch (e) {
      if (e instanceof RpcError && e.code === 'disconnected') {
        this.markDown(peer);
        throw new RpcError('host_disconnected', e.message);
      }
      throw e;
    }
  }

  subscribe(sid: string, l: (f: SidFrame) => void): () => void {
    let set = this.listeners.get(sid);
    if (!set) {
      set = new Set();
      this.listeners.set(sid, set);
    }
    set.add(l);
    return () => {
      set!.delete(l);
      if (set!.size === 0) this.listeners.delete(sid);
    };
  }

  setSteerSource(sid: string, fn: SteerFn | undefined): void {
    if (fn) this.steers.set(sid, fn);
    else this.steers.delete(sid);
  }

  emitRevoked(): void {
    for (const sid of this.subscribedSids()) {
      this.deliver(sid, { t: 'err', message: 'host revoked' });
      this.deliver(sid, { t: 'end' });
    }
  }

  emitDisconnected(sid: string): void {
    this.deliver(sid, { t: 'err', message: 'host disconnected' });
    this.deliver(sid, { t: 'end' });
  }

  emitLost(sid: string): void {
    this.deliver(sid, {
      t: 'err',
      message: 'host disconnected — events lost; next turn resumes natively',
    });
    this.deliver(sid, { t: 'end' });
  }

  private deliver(sid: string, kind: { t: 'err'; message: string } | { t: 'end' }): void {
    const seq = this.lastSeq(sid) + 1;
    this.lastSeqs.set(sid, seq);
    const f: SidFrame = kind.t === 'err'
      ? { t: 'err', sid, seq, message: kind.message }
      : { t: 'end', sid, seq };
    const set = this.listeners.get(sid);
    if (!set) return;
    for (const cb of set) cb(f);
  }

  private routeFrame(f: NodeFrame): void {
    if (!('sid' in f)) return;
    if ('seq' in f) {
      const last = this.lastSeq(f.sid);
      if (f.seq <= last) return;
      this.lastSeqs.set(f.sid, f.seq);
    }
    const set = this.listeners.get(f.sid);
    if (!set) return;
    for (const cb of set) cb(f);
  }

  private async handleSteer(p: unknown): Promise<unknown> {
    const { sid } = p as { sid: string };
    const fn = this.steers.get(sid);
    if (!fn) return null;
    const ac = new AbortController();
    const work = fn(ac.signal);
    const raced = await Promise.race([
      work.then((r) => ({ kind: 'ok' as const, r })),
      this.closedWait.then(() => ({ kind: 'closed' as const })),
    ]);
    if (raced.kind === 'closed') {
      ac.abort();
      return null;
    }
    return raced.r;
  }
}

export class NodeHub {
  private readonly pingMs: number;
  private readonly missLimit: number;
  private readonly handshakeMs: number;
  private readonly authMs: number;
  private preAuth = 0;
  static readonly MAX_PRE_AUTH = 32;
  private readonly hubGraceMs: number;
  private readonly now: () => number;
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: NODE_MAX_FRAME_BYTES });
  private readonly connections = new Map<string, Conn>();
  private readonly links = new Map<string, HubLink>();
  private readonly lastErrors = new Map<string, string>();
  private readonly lastEmitted = new Map<string, { state: RemoteHostView['state']; lastError?: string }>();
  private readonly lastParityJson = new Map<string, string>();
  private readonly graceTimers = new Map<string, Map<string, ReturnType<typeof setTimeout>>>();
  private httpHandler?: (hostId: string, p: TunnelRequest) => Promise<TunnelResponse>;
  private streamHandler?: HubStreamReplay;

  constructor(private readonly deps: NodeHubDeps) {
    this.pingMs = deps.pingMs ?? 20_000;
    this.missLimit = deps.missLimit ?? 3;
    this.handshakeMs = deps.handshakeMs ?? 30_000;
    this.authMs = deps.authMs ?? 10_000;
    this.hubGraceMs = deps.hubGraceMs ?? 150_000;
    this.now = deps.now ?? Date.now;
  }

  /** Unauthenticated handshake slots currently held. Tests + diagnostics. */
  get preAuthCount(): number { return this.preAuth; }

  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Global only — TLS reverse proxy collapses peers onto one IP, so a per-IP
    // cap would not distinguish nodes. Nodes retry with backoff on 503.
    if (this.preAuth >= NodeHub.MAX_PRE_AUTH) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 5\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.acceptTransport(wsTransport(ws));
    });
  }

  acceptTransport(t: FrameTransport): void {
    if (this.preAuth >= NodeHub.MAX_PRE_AUTH) {
      t.close(1013, 'busy');
      return;
    }
    this.preAuth += 1;
    let released = false;
    const releasePreAuth = () => {
      if (released) return;
      released = true;
      this.preAuth = Math.max(0, this.preAuth - 1);
    };

    const transport = loggedTransport(t);
    let hostId: string | undefined;
    let phase: 'auth' | 'hello' | 'up' = 'auth';
    let router: HubStreamRouter | undefined;
    const nonce = randomBytes(32).toString('base64url');
    const peer = new RpcPeer(transport, {
      http: async (p) => {
        if (phase !== 'up' || !hostId || !this.httpHandler) throw new RpcError('no_method', 'http');
        return this.httpHandler(hostId, p as TunnelRequest);
      },
      // Nodes probe this after handshake; old nodes never call it (P2 compatible).
      'hub.features': async () => ({ features: ['tunnel.stream'] }),
    });
    const authTimer = setTimeout(() => {
      peer.close(4408, 'auth timeout');
    }, this.authMs);
    const handshakeTimer = setTimeout(() => {
      peer.close(4408, 'handshake timeout');
    }, this.handshakeMs);

    peer.on('frame', (f: NodeFrame) => {
      if (phase === 'auth' && f.t === 'auth') {
        const id = this.onAuth(peer, nonce, f);
        if (!id) return;
        clearTimeout(authTimer);
        hostId = id;
        phase = 'hello';
        return;
      }
      if (phase === 'hello' && f.t === 'hello') {
        if (!hostId) return;
        if (this.onHello(peer, hostId, f, handshakeTimer)) {
          phase = 'up';
          releasePreAuth();
          if (this.streamHandler) router = new HubStreamRouter(hostId, peer, this.streamHandler);
        }
      }
      if (router && (f.t === 'http.head' || f.t === 'http.chunk' || f.t === 'http.end' || f.t === 'http.credit')) {
        router.onFrame(f);
      }
    });
    peer.on('close', () => {
      clearTimeout(authTimer);
      clearTimeout(handshakeTimer);
      releasePreAuth();
      router?.closeAll();
    });
    peer.send({ t: 'challenge', nonce });
  }

  link(hostId: string): NodeLink {
    return this.ensureLink(hostId);
  }

  /**
   * Whether `origin` is safe to carry secrets: any TLS origin, or an http://
   * origin aimed at loopback (dev hubs). `http://` elsewhere maps to a
   * plaintext `ws://` link on the node, so values never travel there.
   */
  private static secureHubOrigin(origin: string): boolean {
    let u: URL;
    try { u = new URL(origin); } catch { return false; }
    if (u.protocol !== 'http:') return true;
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '::1' || h === '[::1]' || /^127(\.\d+){3}$/.test(h);
  }

  /** Vault values filtered to the agents this node allows (values only for
   *  `allowed === true` agents; names always travel so the node can scrub). */
  private envForHost(
    all: { vars: Record<string, Record<string, string>>; managedNames: Set<string> },
    hello: NodeHello,
  ): AgentEnvSyncParams {
    const vars: Record<string, Record<string, string>> = {};
    const allowed = new Set(
      Object.entries(hello.agents ?? {}).filter(([, a]) => a.allowed === true).map(([t]) => t),
    );
    for (const [agentType, values] of Object.entries(all.vars)) {
      if (!allowed.has(agentType)) continue;
      vars[agentType] = values;
    }
    return { vars, managedNames: [...all.managedNames] };
  }

  /** Push per-agent vault env to a connected node (or clear a previous push).
   *  A `changed` answer means the node re-helloed (feature list may have grown).
   *  `opts.clear` pushes an empty payload regardless of the row — used when a
   *  host is disabled or deleted and must not receive a fresh delivery. */
  async syncAgentEnv(hostId: string, opts?: { clear?: boolean }): Promise<void> {
    const link = this.links.get(hostId);
    const hello = link?.hello();
    if (!link?.connected() || !hello || !hostHasFeature(hello, 'agent_env')) return;
    let params: AgentEnvSyncParams;
    if (opts?.clear) {
      params = { vars: {}, managedNames: [] };
    } else {
      const row = getRemoteHost(this.deps.db(), hostId); // re-read: the toggle may have just changed
      if (!row) return;
      if (!row.allowAgentEnvSecrets) {
        params = { vars: {}, managedNames: [] };
      } else if (!NodeHub.secureHubOrigin(row.hubOrigin ?? '')) {
        // http:// non-loopback hub → the node link is plaintext ws:// (F1):
        // deliver managed names only so scrubbing still applies, never values.
        console.warn('[hub] refusing to send agent env secrets over plaintext ws:// to non-loopback host %s', hostId);
        params = { vars: {}, managedNames: [...loadAllAgentEnv(this.deps.db()).managedNames] };
      } else {
        params = this.envForHost(loadAllAgentEnv(this.deps.db()), hello);
      }
    }
    const res = await link.request<{ ok: true; changed: boolean }>('agentEnv.sync', params, 10_000);
    // No refresh on clear: the host is being disabled/deleted, the link is on
    // its way out, and a node.hello round-trip would only delay that.
    if (!res?.changed || opts?.clear) return;
    void this.refreshAfterEnvSync(hostId);
  }

  /** Best-effort wipe of a node's in-memory env store (host disabled/deleted). */
  clearAgentEnv(hostId: string): Promise<void> {
    return this.syncAgentEnv(hostId, { clear: true });
  }

  /** The node re-helloed after an env change. One retry rides out a dropped
   *  link or a lost first response so freshly unlocked models do not wait for
   *  the next reconnect. */
  private async refreshAfterEnvSync(hostId: string): Promise<void> {
    try {
      await this.refresh(hostId);
    } catch (first) {
      try {
        await this.refresh(hostId);
      } catch (e) {
        console.warn('[hub] %s: refresh after agent env sync failed: %s (first attempt: %s)', hostId,
          e instanceof Error ? e.message : String(e),
          first instanceof Error ? first.message : String(first));
        return;
      }
    }
    const fresh = getRemoteHost(this.deps.db(), hostId);
    if (fresh) this.deps.onStatus(this.view(fresh));
  }

  /** Fan out to every known link; disconnected / featureless hosts no-op. */
  async syncAllAgentEnv(): Promise<void> {
    await Promise.all(
      [...this.links.keys()].map((id) =>
        this.syncAgentEnv(id).catch((e) => {
          console.warn('[hub] %s: agent env sync failed: %s', id, e instanceof Error ? e.message : String(e));
        }),
      ),
    );
  }

  view(row: RemoteHostRow): RemoteHostView {
    const base = disconnectedHostView(row);
    if (this.isConnected(row.id)) {
      return {
        ...base,
        state: 'connected',
        hello: this.ensureLink(row.id).hello() ?? row.hello,
      };
    }
    const lastError = this.lastErrors.get(row.id);
    return lastError ? { ...base, lastError } : base;
  }

  isConnected(hostId: string): boolean {
    return this.connections.has(hostId);
  }

  /** Time of the last hello bind while the host is still connected. Refresh does not bump this. */
  connectedAt(hostId: string): number | undefined {
    const link = this.links.get(hostId);
    if (!link?.connected()) return undefined;
    return link.boundAt || undefined;
  }

  disconnect(hostId: string, _reason: string): void {
    this.ensureLink(hostId).emitRevoked();
    this.dropConnection(hostId, false);
  }

  async refresh(hostId: string, opts?: { reprobed?: string }): Promise<NodeHello> {
    const link = this.links.get(hostId);
    const known = link?.hello();
    if (!link?.connected() || !known) throw new Error('not connected');
    try {
      const hello = sanitizeHelloVersion(
        carryVersions(await link.request<NodeHello>('node.hello', undefined, 60_000), known, opts?.reprobed),
      );
      if (hello.protocol !== NODE_PROTOCOL) {
        console.warn(`[hub] ${hostId}: refresh got protocol ${hello.protocol}, keeping last known hello`);
      } else {
        saveHello(this.deps.db(), hostId, hello, this.now());
        link.setHello(hello);
        const row = getRemoteHost(this.deps.db(), hostId);
        if (row) this.logSidecarParity(row);
        return hello;
      }
    } catch (err) {
      // Old node build: no node.hello → degrade to a liveness ping, keep the
      // connect-time hello. Anything else (timeout, disconnect) is a real error.
      if (!(err instanceof RpcError) || err.code !== 'no_method') throw err;
      await link.request('ping');
    }
    const row = getRemoteHost(this.deps.db(), hostId);
    if (row) this.logSidecarParity(row);
    return link.hello()!;
  }

  /** Cheap fs-only login re-probe. Old nodes (no feature / no_method) keep hello-time status. */
  async probeLoginStatus(hostId: string): Promise<void> {
    const link = this.links.get(hostId);
    const known = link?.hello();
    if (!link?.connected() || !known || !hostHasFeature(known, 'agents.loginStatus')) return;
    try {
      const r = await link.request<AgentsLoginStatusResult>('agents.loginStatus', undefined, 5_000);
      const loggedIn = r && typeof r === 'object' ? r.loggedIn : undefined;
      if (!loggedIn || typeof loggedIn !== 'object') return;
      // Re-read: a refresh or reconnect during the await must not be overwritten.
      const hello = link.hello();
      if (!hello) return;
      const agents = { ...hello.agents };
      let changed = false;
      for (const [type, info] of Object.entries(agents)) {
        const next = loggedIn[type];
        if (typeof next !== 'boolean' || info.loggedIn === next) continue;
        agents[type] = { ...info, loggedIn: next };
        changed = true;
      }
      if (!changed) return;
      const patched = { ...hello, agents };
      saveHello(this.deps.db(), hostId, patched, this.now());
      link.setHello(patched);
    } catch (err) {
      if (err instanceof RpcError && err.code === 'no_method') return;
    }
  }

  setHttpHandler(fn: (hostId: string, p: TunnelRequest) => Promise<TunnelResponse>): void {
    this.httpHandler = fn;
  }

  /** Wire the streaming-tunnel loopback replay; unset → http.* frames are ignored. */
  setStreamHandler(fn: HubStreamReplay): void {
    this.streamHandler = fn;
  }

  private ensureLink(hostId: string): HubLink {
    let link = this.links.get(hostId);
    if (!link) {
      link = new HubLink(hostId, (ev) => this.deps.onLoginEvent?.(hostId, ev));
      this.links.set(hostId, link);
    }
    return link;
  }

  private onAuth(peer: RpcPeer, nonce: string, f: Extract<NodeFrame, { t: 'auth' }>): string | undefined {
    const row = getRemoteHost(this.deps.db(), f.hostId);
    if (!row) {
      peer.close(4403, 'unknown');
      return undefined;
    }
    if (row.status === 'disabled') {
      peer.close(4403, 'disabled');
      return undefined;
    }
    if (row.status !== 'trusted') {
      peer.close(4403, 'untrusted');
      return undefined;
    }
    if (!row.publicKey || !row.hubOrigin || !verifyAuth(nonce, f.hostId, row.hubOrigin, row.publicKey, f.sig)) {
      peer.close(4401, 'unauthorized');
      return undefined;
    }
    return f.hostId;
  }

  private onHello(
    peer: RpcPeer,
    hostId: string,
    f: Extract<NodeFrame, { t: 'hello' }>,
    handshakeTimer: ReturnType<typeof setTimeout>,
  ): boolean {
    const hello = sanitizeHelloVersion(f.hello as NodeHello);
    if (hello.protocol !== NODE_PROTOCOL) {
      const hostname = typeof hello.hostname === 'string' && hello.hostname ? hello.hostname : 'unknown';
      const lastError = `protocol mismatch — run tierwyn update on ${hostname}`;
      this.lastErrors.set(hostId, lastError);
      clearTimeout(handshakeTimer);
      peer.close(4426, 'protocol mismatch');
      const row = getRemoteHost(this.deps.db(), hostId);
      if (row) this.emitStatus(row);
      return false;
    }
    clearTimeout(handshakeTimer);
    this.lastErrors.delete(hostId);
    saveHello(this.deps.db(), hostId, hello, this.now());
    const row = getRemoteHost(this.deps.db(), hostId);
    if (!row) {
      peer.close(4403, 'unknown');
      return false;
    }
    const prev = this.connections.get(hostId);
    const wasConnected = !!prev;
    const link = this.ensureLink(hostId);
    this.connections.set(hostId, { peer, misses: 0 });
    link.bind(peer, hello, this.now());
    peer.on('close', () => {
      const cur = this.connections.get(hostId);
      if (cur?.peer !== peer) return;
      this.dropConnection(hostId);
    });
    if (prev && prev.peer !== peer) {
      this.stopPing(prev);
      prev.peer.close(4409, 'replaced');
    }
    this.startPing(hostId, peer);
    if (!wasConnected) this.emitStatus(row);
    this.cancelHubGrace(hostId);
    this.resumeSubscribed(hostId);
    this.reconcile(hostId, hello);
    this.logSidecarParity(row);
    void this.syncAgentEnv(hostId).catch((e) => {
      console.warn('[hub] %s: agent env sync failed: %s', hostId, e instanceof Error ? e.message : String(e));
    });
    return true;
  }

  private reconcile(hostId: string, hello: NodeHello): void {
    const link = this.ensureLink(hostId);
    for (const sid of hello.sessions ?? []) {
      if (link.hasSubscriber(sid) || this.deps.isLiveSession(sid)) continue;
      void link.request('session.call', { sid, method: 'stop', args: [] }).catch(() => {});
    }
  }

  private startPing(hostId: string, peer: RpcPeer): void {
    const tick = async () => {
      const conn = this.connections.get(hostId);
      if (!conn || conn.peer !== peer) return;
      try {
        await peer.request('ping', undefined, this.pingMs);
        conn.misses = 0;
      } catch {
        if (this.connections.get(hostId)?.peer !== peer) return;
        conn.misses++;
        if (conn.misses >= this.missLimit) {
          this.dropConnection(hostId);
          return;
        }
      }
      if (this.connections.get(hostId)?.peer !== peer) return;
      conn.pingTimer = setTimeout(tick, this.pingMs);
    };
    const conn = this.connections.get(hostId);
    if (conn) conn.pingTimer = setTimeout(tick, this.pingMs);
  }

  private stopPing(conn: Conn): void {
    if (conn.pingTimer) clearTimeout(conn.pingTimer);
    conn.pingTimer = undefined;
  }

  private dropConnection(hostId: string, grace = true): void {
    const conn = this.connections.get(hostId);
    if (!conn) return;
    this.connections.delete(hostId);
    this.stopPing(conn);
    const link = this.ensureLink(hostId);
    link.markDown();
    if (grace) this.armHubGrace(hostId);
    else this.cancelHubGrace(hostId);
    conn.peer.close();
    const row = getRemoteHost(this.deps.db(), hostId);
    if (row) this.emitStatus(row);
  }

  private cancelHubGrace(hostId: string): void {
    const timers = this.graceTimers.get(hostId);
    if (!timers) return;
    for (const t of timers.values()) clearTimeout(t);
    this.graceTimers.delete(hostId);
  }

  private armHubGrace(hostId: string): void {
    this.cancelHubGrace(hostId);
    const link = this.ensureLink(hostId);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    for (const sid of link.subscribedSids()) {
      timers.set(sid, setTimeout(() => {
        link.emitDisconnected(sid);
      }, this.hubGraceMs));
    }
    if (timers.size) this.graceTimers.set(hostId, timers);
  }

  private resumeSubscribed(hostId: string): void {
    const link = this.ensureLink(hostId);
    for (const sid of link.subscribedSids()) {
      const lastSeq = link.lastSeq(sid);
      void link.request('session.resume', { sid, lastSeq }).catch((e) => {
        if (e instanceof RpcError && e.code === 'host_disconnected') return;
        link.emitLost(sid);
      });
    }
  }

  private logSidecarParity(row: RemoteHostRow): void {
    const advisories = sidecarHostAdvisories(this.deps.db(), this.view(row));
    if (!advisories.length) {
      this.lastParityJson.delete(row.id);
      return;
    }
    const json = JSON.stringify(advisories);
    if (this.lastParityJson.get(row.id) === json) return;
    this.lastParityJson.set(row.id, json);
    console.warn('[remote-host %s] sidecar parity: %s', row.id, json);
  }

  private emitStatus(row: RemoteHostRow): void {
    const view = this.view(row);
    const prev = this.lastEmitted.get(row.id);
    if (prev && prev.state === view.state && prev.lastError === view.lastError) return;
    this.lastEmitted.set(row.id, { state: view.state, lastError: view.lastError });
    this.deps.onStatus(view);
  }
}

function verifyAuth(
  nonce: string,
  hostId: string,
  hubOrigin: string,
  publicKeyB64: string,
  sig: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'),
      format: 'der',
      type: 'spki',
    });
    return verify(
      null,
      Buffer.from(authPayload(nonce, hostId, hubOrigin)),
      key,
      Buffer.from(sig, 'base64url'),
    );
  } catch {
    return false;
  }
}

function omitNodeFrameLog(text: string): boolean {
  return text.includes('"m":"agentEnv.sync"')
    || text.includes('"m":"agents.loginEvent"')
    || text.includes('"m":"agents.login"');
}

function loggedTransport(inner: FrameTransport): FrameTransport {
  const path = envPref('NODE_FRAME_LOG');
  if (!path) return inner;
  try {
    const fd = openSync(path, 'wx', 0o600);
    closeSync(fd);
  } catch { /* exists */ }
  return {
    send(text) {
      // ponytail: agentEnv.sync frames carry vault values — never persist them
      // (MCP secret frames remain the known, accepted gap in this log).
      // Device-login events carry the one-time user code; same omit.
      if (!omitNodeFrameLog(text)) {
        try { appendFileSync(path, `out ${text}\n`); } catch { /* ignore */ }
      }
      inner.send(text);
    },
    onText(cb) {
      inner.onText((t) => {
        if (!omitNodeFrameLog(t)) {
          try { appendFileSync(path, `in ${t}\n`); } catch { /* ignore */ }
        }
        cb(t);
      });
    },
    onClose: (cb) => inner.onClose(cb),
    close: (code, reason) => inner.close(code, reason),
  };
}

/** The node's `--version` probes race a 15 s deadline (~15 CLIs in parallel),
 *  so slow starters (kilocode, cursor, kimi) intermittently ship no version —
 *  which the web renders as Reinstall ▸. Keep the last known version for an
 *  agent that is still installed, except the one just (re)installed. */
export function carryVersions(next: NodeHello, prev: NodeHello, reprobed?: string): NodeHello {
  if (!next.agents || !prev.agents) return next;
  let agents: NodeHello['agents'] | undefined;
  for (const [type, info] of Object.entries(next.agents)) {
    const old = prev.agents[type]?.version;
    if (type === reprobed || !info.installed || info.version !== undefined || old === undefined) continue;
    agents ??= { ...next.agents };
    agents[type] = { ...info, version: old };
  }
  return agents ? { ...next, agents } : next;
}
