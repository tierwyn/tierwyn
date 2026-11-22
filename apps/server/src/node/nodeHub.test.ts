import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  NODE_PROTOCOL,
  authPayload,
  type NodeFrame,
  type NodeHello,
  type NormalisedEvent,
  type RemoteHostView,
} from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  createPendingHost,
  getRemoteHost,
  redeemEnrollToken,
  setRemoteHostStatus,
} from '../repositories/remoteHosts.js';
import { initVaultKey, vaultSet } from '../plugins/vault.js';
import { AGENT_VAULT_ID } from '../secrets/mcpRedact.js';
import { agentEnvVaultKey } from '../secrets/agentEnv.js';
import { memoryPair, RpcError, RpcPeer, type FrameTransport } from './rpc.js';
import { carryVersions, NodeHub } from './nodeHub.js';
import { RemoteAdapterProxy } from './proxyAdapter.js';
import { seedDefaultSettings } from '../db/seed.js';
import { updateSidecarLlmSettings } from '../repositories/settings.js';

afterEach(() => {
  vi.useRealTimers();
});

const HUB_ORIGIN = 'https://hub.example';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function pairWithClose(): {
  hubT: FrameTransport;
  nodeT: FrameTransport;
  closed: Array<{ code?: number; reason?: string }>;
} {
  const [rawHub, nodeT] = memoryPair();
  const closed: Array<{ code?: number; reason?: string }> = [];
  const hubT: FrameTransport = {
    send: (text) => rawHub.send(text),
    onText: (cb) => rawHub.onText(cb),
    onClose: (cb) => rawHub.onClose(cb),
    close(code, reason) {
      closed.push({ code, reason });
      rawHub.close(code, reason);
    },
  };
  return { hubT, nodeT, closed };
}

function hello(over: Partial<NodeHello> = {}): NodeHello {
  return {
    protocol: NODE_PROTOCOL,
    gitSha: 'abc',
    hostname: 'box',
    os: 'linux',
    arch: 'x64',
    homedir: '/home/n',
    roots: ['/home/n/work'],
    listenPort: 8788,
    agents: {},
    models: {},
    sessions: [],
    ...over,
  };
}

function seedHost(
  db: Database,
  publicKey: string,
  status: 'enrolled' | 'trusted' | 'disabled' = 'trusted',
  hubOrigin = HUB_ORIGIN,
) {
  const pending = createPendingHost(db, 'alpha', 'tok', Date.now() + 60_000, false);
  redeemEnrollToken(db, 'tok', Date.now(), {
    publicKey,
    hubOrigin,
    hello: { hostname: 'box' },
  });
  if (status !== 'enrolled') setRemoteHostStatus(db, pending.id, status);
  return getRemoteHost(db, pending.id)!;
}

function spkiB64(pub: KeyObject): string {
  return pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

function signAuth(privateKey: KeyObject, nonce: string, hostId: string, hubOrigin: string): string {
  return sign(null, Buffer.from(authPayload(nonce, hostId, hubOrigin)), privateKey).toString('base64url');
}

async function until(pred: () => boolean, msg = 'condition not met'): Promise<void> {
  await vi.waitFor(() => {
    if (!pred()) throw new Error(msg);
  });
}

function boot(opts?: {
  isLiveSession?: (sid: string) => boolean;
  pingMs?: number;
  missLimit?: number;
  handshakeMs?: number;
  authMs?: number;
  hubGraceMs?: number;
}) {
  const db = freshDb();
  const statuses: RemoteHostView[] = [];
  const hub = new NodeHub({
    db: () => db,
    onStatus: (v) => statuses.push({ ...v }),
    isLiveSession: opts?.isLiveSession ?? (() => false),
    pingMs: opts?.pingMs,
    missLimit: opts?.missLimit,
    handshakeMs: opts?.handshakeMs,
    authMs: opts?.authMs,
    hubGraceMs: opts?.hubGraceMs,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { db, hub, statuses, publicKey, privateKey };
}

function evChunk(chunk: string): NormalisedEvent {
  return { type: 'message', sessionId: 's1', ts: 1, seq: 1, payload: { chunk } };
}

async function reconnectTrusted(
  ctx: ReturnType<typeof boot>,
  hostId: string,
  over?: { hello?: Partial<NodeHello>; nodeHandlers?: Record<string, (p: unknown) => Promise<unknown>> },
) {
  const { hubT, nodeT, closed } = pairWithClose();
  const frames: NodeFrame[] = [];
  const node = new RpcPeer(nodeT, over?.nodeHandlers ?? { ping: async () => ({ ok: true }) });
  node.on('frame', (f: NodeFrame) => frames.push(f));
  ctx.hub.acceptTransport(hubT);
  await until(() => frames.some((f) => f.t === 'challenge'));
  const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
  node.send({
    t: 'auth',
    hostId,
    sig: signAuth(ctx.privateKey, nonce, hostId, HUB_ORIGIN),
  });
  node.send({ t: 'hello', hello: hello(over?.hello) });
  await until(() => ctx.hub.isConnected(hostId));
  return { node, frames, closed, hubT };
}

/** Resolver-list + FIFO queue modelled on sessionManager.pullNextSteer. */
function pullNextSteerSource() {
  type Item = { text: string };
  const queue: Item[] = [];
  const resolvers: Array<(msg: Item | null) => void> = [];

  function operatorSend(text: string) {
    const item: Item = { text };
    const r = resolvers.shift();
    if (r) r(item);
    else queue.push(item);
  }

  async function getNextSteer(signal?: AbortSignal): Promise<Item | null> {
    const first = queue.shift();
    if (first) return first;
    return new Promise((resolve) => {
      const resolver = (msg: Item | null) => resolve(msg);
      resolvers.push(resolver);
      if (!signal) return;
      const onAbort = () => {
        const i = resolvers.indexOf(resolver);
        if (i !== -1) resolvers.splice(i, 1);
        resolve(null);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  return { queue, resolvers, operatorSend, getNextSteer };
}

async function connectTrusted(
  ctx: ReturnType<typeof boot>,
  over?: { hello?: Partial<NodeHello>; hubOrigin?: string; nodeHandlers?: Record<string, (p: unknown) => Promise<unknown>> },
) {
  const host = seedHost(ctx.db, spkiB64(ctx.publicKey), 'trusted', over?.hubOrigin ?? HUB_ORIGIN);
  const { hubT, nodeT, closed } = pairWithClose();
  const frames: NodeFrame[] = [];
  const node = new RpcPeer(nodeT, over?.nodeHandlers ?? {});
  node.on('frame', (f: NodeFrame) => frames.push(f));
  ctx.hub.acceptTransport(hubT);
  await until(() => frames.some((f) => f.t === 'challenge'));
  const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
  node.send({
    t: 'auth',
    hostId: host.id,
    sig: signAuth(ctx.privateKey, nonce, host.id, over?.hubOrigin ?? HUB_ORIGIN),
  });
  node.send({ t: 'hello', hello: hello(over?.hello) });
  await until(() => ctx.hub.isConnected(host.id));
  return { host, node, frames, closed, hubT };
}

describe('NodeHub', () => {
  it('hello with sidecar gaps warns once and reconnect is quiet', async () => {
    const ctx = boot();
    seedDefaultSettings(ctx.db);
    updateSidecarLlmSettings(ctx.db, {
      commit: { backend: 'agent', adapter: 'pi', model: 'm' },
      describe: { backend: 'direct', enabled: false },
      enhance: { backend: 'direct', enabled: false },
      btw: { backend: 'agent_readonly', adapter: 'pi', model: 'm', enabled: false },
    }, [{ type: 'pi', supportsToolsOff: true, supportsReadOnly: true }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await connectTrusted(ctx, {
      hello: {
        agents: { 'claude-code': { installed: true, methods: ['oneShot'] } },
        models: { 'claude-code': ['m'] },
      },
    });
    const parity = warn.mock.calls.filter((c) => String(c[0]).includes('sidecar parity'));
    expect(parity).toHaveLength(1);
    expect(String(parity[0]![1])).toBeTruthy();
    expect(String(parity[0]![2])).toContain('agent_not_installed');
    warn.mockClear();
    const hostId = ctx.statuses[0]!.id;
    await reconnectTrusted(ctx, hostId, {
      hello: {
        agents: { 'claude-code': { installed: true, methods: ['oneShot'] } },
        models: { 'claude-code': ['m'] },
      },
    });
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('sidecar parity'))).toHaveLength(0);
    warn.mockRestore();
  });

  it('trusted host with valid signature → connected, hello saved', async () => {
    const ctx = boot();
    const { host } = await connectTrusted(ctx, { hello: { hostname: 'node-a', gitSha: 'deadbeef' } });
    expect(ctx.hub.isConnected(host.id)).toBe(true);
    const connected = ctx.statuses.filter((s) => s.state === 'connected');
    expect(connected).toHaveLength(1);
    expect(connected[0]!.id).toBe(host.id);
    const saved = getRemoteHost(ctx.db, host.id)!;
    expect(saved.hello.hostname).toBe('node-a');
    expect(saved.hello.gitSha).toBe('deadbeef');
    expect(saved.hello.version).toBeUndefined();
    expect(ctx.hub.view(saved).state).toBe('connected');
  });

  it('persists hello.version and surfaces it on the view', async () => {
    const ctx = boot();
    const { host } = await connectTrusted(ctx, {
      hello: { hostname: 'node-a', gitSha: 'deadbeef', version: '0.2.0' },
    });
    const saved = getRemoteHost(ctx.db, host.id)!;
    expect(saved.hello.version).toBe('0.2.0');
    expect(ctx.hub.view(saved).hello.version).toBe('0.2.0');
  });

  it('drops hello.version when empty, too long, or not a string', async () => {
    for (const version of ['', 'x'.repeat(33), 12 as unknown as string]) {
      const ctx = boot();
      const { host } = await connectTrusted(ctx, {
        hello: { hostname: 'node-a', gitSha: 'deadbeef', version },
      });
      const saved = getRemoteHost(ctx.db, host.id)!;
      expect(saved.hello.version).toBeUndefined();
      expect(ctx.hub.view(saved).hello.version).toBeUndefined();
    }
  });

  it('wrong key → close 4401', async () => {
    const ctx = boot();
    const { privateKey: otherPriv } = generateKeyPairSync('ed25519');
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const { hubT, nodeT, closed } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node = new RpcPeer(nodeT, {});
    node.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node.send({ t: 'auth', hostId: host.id, sig: signAuth(otherPriv, nonce, host.id, HUB_ORIGIN) });
    await until(() => closed.some((c) => c.code === 4401));
    expect(ctx.hub.isConnected(host.id)).toBe(false);
  });

  it('signature over other hubOrigin → 4401', async () => {
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const { hubT, nodeT, closed } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node = new RpcPeer(nodeT, {});
    node.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node.send({
      t: 'auth',
      hostId: host.id,
      sig: signAuth(ctx.privateKey, nonce, host.id, 'https://other.example'),
    });
    await until(() => closed.some((c) => c.code === 4401));
    expect(ctx.hub.isConnected(host.id)).toBe(false);
  });

  it('untrusted (enrolled) host → 4403', async () => {
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey), 'enrolled');
    const { hubT, nodeT, closed } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node = new RpcPeer(nodeT, {});
    node.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node.send({ t: 'auth', hostId: host.id, sig: signAuth(ctx.privateKey, nonce, host.id, HUB_ORIGIN) });
    await until(() => closed.some((c) => c.code === 4403));
    expect(closed.some((c) => c.reason === 'untrusted')).toBe(true);
    expect(ctx.hub.isConnected(host.id)).toBe(false);
  });

  it('protocol mismatch → 4426 + lastError', async () => {
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const { hubT, nodeT, closed } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node = new RpcPeer(nodeT, {});
    node.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node.send({ t: 'auth', hostId: host.id, sig: signAuth(ctx.privateKey, nonce, host.id, HUB_ORIGIN) });
    node.send({ t: 'hello', hello: hello({ protocol: 0, hostname: 'box' }) });
    await until(() => closed.some((c) => c.code === 4426));
    const view = ctx.hub.view(getRemoteHost(ctx.db, host.id)!);
    expect(view.lastError).toBe('protocol mismatch — run tierwyn update on box');
    expect(ctx.hub.isConnected(host.id)).toBe(false);
  });

  it('no auth within handshakeMs → closed', async () => {
    vi.useFakeTimers();
    const ctx = boot({ handshakeMs: 10_000 });
    const { hubT, nodeT, closed } = pairWithClose();
    const node = new RpcPeer(nodeT, {});
    ctx.hub.acceptTransport(hubT);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed.length).toBeGreaterThan(0);
    node.close();
  });

  it('caps unauthenticated handshakes at MAX_PRE_AUTH and decrements on close', async () => {
    const ctx = boot({ handshakeMs: 60_000, authMs: 60_000 });
    const pending: Array<ReturnType<typeof pairWithClose>> = [];
    for (let i = 0; i < NodeHub.MAX_PRE_AUTH; i++) {
      const p = pairWithClose();
      pending.push(p);
      ctx.hub.acceptTransport(p.hubT);
    }
    expect(ctx.hub.preAuthCount).toBe(NodeHub.MAX_PRE_AUTH);
    const extra = pairWithClose();
    ctx.hub.acceptTransport(extra.hubT);
    expect(extra.closed.some((c) => c.code === 1013)).toBe(true);
    expect(ctx.hub.preAuthCount).toBe(NodeHub.MAX_PRE_AUTH);

    extra.nodeT.close();
    pending[0]!.hubT.close();
    await until(() => ctx.hub.preAuthCount === NodeHub.MAX_PRE_AUTH - 1);
    const next = pairWithClose();
    ctx.hub.acceptTransport(next.hubT);
    expect(ctx.hub.preAuthCount).toBe(NodeHub.MAX_PRE_AUTH);
    for (const p of pending) p.hubT.close();
    next.hubT.close();
  });

  it('auth timeout at 10s closes and decrements preAuth', async () => {
    vi.useFakeTimers();
    const ctx = boot({ authMs: 10_000, handshakeMs: 60_000 });
    const { hubT, nodeT, closed } = pairWithClose();
    ctx.hub.acceptTransport(hubT);
    expect(ctx.hub.preAuthCount).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(closed.length).toBeGreaterThan(0);
    expect(ctx.hub.preAuthCount).toBe(0);
    nodeT.close();
  });

  it('completing auth+hello drops the preAuth slot', async () => {
    const ctx = boot();
    const { host } = await connectTrusted(ctx);
    expect(ctx.hub.isConnected(host.id)).toBe(true);
    expect(ctx.hub.preAuthCount).toBe(0);
  });

  it('3 missed pings → disconnected status emitted once', async () => {
    vi.useFakeTimers();
    const ctx = boot({ pingMs: 20, missLimit: 3, handshakeMs: 60_000 });
    const { host } = await connectTrusted(ctx);
    expect(ctx.statuses.filter((s) => s.state === 'connected')).toHaveLength(1);
    const before = ctx.statuses.filter((s) => s.state === 'disconnected').length;
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    const disconnected = ctx.statuses.filter((s) => s.state === 'disconnected');
    expect(disconnected.length - before).toBe(1);
    expect(ctx.hub.isConnected(host.id)).toBe(false);
  });

  it('second connection replaces first', async () => {
    const ctx = boot();
    const first = await connectTrusted(ctx);
    const { hubT, nodeT, closed: closed2 } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node = new RpcPeer(nodeT, {});
    node.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node.send({
      t: 'auth',
      hostId: first.host.id,
      sig: signAuth(ctx.privateKey, nonce, first.host.id, HUB_ORIGIN),
    });
    node.send({ t: 'hello', hello: hello({ hostname: 'box-2' }) });
    await until(() => first.closed.some((c) => c.code === 4409));
    expect(ctx.hub.isConnected(first.host.id)).toBe(true);
    expect(closed2.some((c) => c.code === 4409)).toBe(false);
    expect(getRemoteHost(ctx.db, first.host.id)!.hello.hostname).toBe('box-2');
  });

  it('in-flight request on replaced peer does not mark the new link down', async () => {
    const ctx = boot();
    const first = await connectTrusted(ctx, {
      nodeHandlers: {
        hang: () => new Promise(() => {}),
        ping: async () => ({ ok: true }),
      },
    });
    const link = ctx.hub.link(first.host.id);
    const hang = link.request('hang');
    void hang.catch(() => {});

    const { hubT, nodeT } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node = new RpcPeer(nodeT, { ping: async () => ({ ok: true }) });
    node.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node.send({
      t: 'auth',
      hostId: first.host.id,
      sig: signAuth(ctx.privateKey, nonce, first.host.id, HUB_ORIGIN),
    });
    node.send({ t: 'hello', hello: hello({ hostname: 'box-2' }) });
    await until(() => first.closed.some((c) => c.code === 4409));

    await expect(hang).rejects.toMatchObject({ code: 'host_disconnected' });
    expect(ctx.hub.isConnected(first.host.id)).toBe(true);
    expect(link.connected()).toBe(true);
    await expect(link.request('ping')).resolves.toEqual({ ok: true });
  });

  it('steer in-flight across replace is aborted and drained on the new peer', async () => {
    const ctx = boot();
    const src = pullNextSteerSource();
    const first = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const link = ctx.hub.link(first.host.id);
    link.setSteerSource('s1', src.getNextSteer);
    const parked = first.node.request('steer.next', { sid: 's1' }, 0);
    void parked.catch(() => {});
    await until(() => src.resolvers.length === 1, 'steer.next did not park');

    const { hubT, nodeT } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node2 = new RpcPeer(nodeT, { ping: async () => ({ ok: true }) });
    node2.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node2.send({
      t: 'auth',
      hostId: first.host.id,
      sig: signAuth(ctx.privateKey, nonce, first.host.id, HUB_ORIGIN),
    });
    node2.send({ t: 'hello', hello: hello({ hostname: 'box-2' }) });
    await until(() => first.closed.some((c) => c.code === 4409));
    await until(() => src.resolvers.length === 0, 'parked pull was not aborted');
    await expect(parked).rejects.toMatchObject({ code: 'disconnected' });

    src.operatorSend('during-replace');
    expect(src.queue.map((q) => q.text)).toEqual(['during-replace']);
    expect(src.resolvers).toHaveLength(0);

    await expect(node2.request('steer.next', { sid: 's1' }, 5_000)).resolves.toEqual({ text: 'during-replace' });
    expect(src.queue).toHaveLength(0);
    expect(ctx.hub.isConnected(first.host.id)).toBe(true);
    expect(link.connected()).toBe(true);
  });

  it('orphan sid in hello.sessions gets session.call stop', async () => {
    const ctx = boot({ isLiveSession: () => false });
    const calls: unknown[] = [];
    await connectTrusted(ctx, {
      hello: { sessions: ['orphan'] },
      nodeHandlers: {
        'session.call': async (p) => {
          calls.push(p);
          return { ok: true };
        },
        ping: async () => ({ ok: true }),
      },
    });
    await until(() => calls.length > 0);
    expect(calls[0]).toEqual({ sid: 'orphan', method: 'stop', args: [] });
  });

  it('http rpc before hello is no_method even after auth', async () => {
    const ctx = boot();
    const calls: unknown[] = [];
    ctx.hub.setHttpHandler(async (hostId, p) => {
      calls.push({ hostId, p });
      return { status: 200, headers: {}, bodyB64: '' };
    });
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const { hubT, nodeT } = pairWithClose();
    const frames: NodeFrame[] = [];
    const node = new RpcPeer(nodeT, {});
    node.on('frame', (f: NodeFrame) => frames.push(f));
    ctx.hub.acceptTransport(hubT);
    await until(() => frames.some((f) => f.t === 'challenge'));
    const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node.send({
      t: 'auth',
      hostId: host.id,
      sig: signAuth(ctx.privateKey, nonce, host.id, HUB_ORIGIN),
    });
    // memoryPair delivers on a microtask; give auth time to set hostId.
    await new Promise((r) => setTimeout(r, 30));
    // Auth accepted hostId, but hello has not run — http must not.
    await expect(node.request('http', {
      method: 'POST',
      path: '/spawn/raw',
      headers: {},
      bodyB64: '',
    })).rejects.toMatchObject({ code: 'no_method' });
    expect(calls).toHaveLength(0);

    node.send({ t: 'hello', hello: hello() });
    await until(() => ctx.hub.isConnected(host.id));
    const ok = await node.request('http', {
      method: 'POST',
      path: '/spawn/raw',
      headers: {},
      bodyB64: '',
    });
    expect(ok).toMatchObject({ status: 200 });
    expect(calls).toHaveLength(1);
  });

  it('link.request rejects host_disconnected when down', async () => {
    const ctx = boot();
    const link = ctx.hub.link('missing-host');
    await expect(link.request('ping')).rejects.toMatchObject({ code: 'host_disconnected' });
    const { host } = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const live = ctx.hub.link(host.id);
    expect(live.connected()).toBe(true);
    ctx.hub.disconnect(host.id, 'revoked');
    await expect(live.request('ping')).rejects.toMatchObject({ code: 'host_disconnected' });
  });

  it('dedupes replayed seq ≤ lastSeq', async () => {
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000 });
    const { host, node } = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const got: Array<{ t: string; seq?: number }> = [];
    ctx.hub.link(host.id).subscribe('s1', (f) => got.push(f));
    node.send({ t: 'ev', sid: 's1', seq: 1, ev: evChunk('a') });
    node.send({ t: 'ev', sid: 's1', seq: 2, ev: evChunk('b') });
    node.send({ t: 'ev', sid: 's1', seq: 2, ev: evChunk('b-dup') });
    node.send({ t: 'ev', sid: 's1', seq: 1, ev: evChunk('a-replay') });
    node.send({ t: 'ev', sid: 's1', seq: 3, ev: evChunk('c') });
    await until(() => got.filter((f) => f.t === 'ev').length >= 3);
    expect(got.filter((f) => f.t === 'ev').map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('hub grace expiry delivers err+end', async () => {
    vi.useFakeTimers();
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000, hubGraceMs: 1_000 });
    const { host, hubT } = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const got: Array<{ t: string; message?: string }> = [];
    ctx.hub.link(host.id).subscribe('s1', (f) => got.push(f));
    hubT.close();
    await until(() => !ctx.hub.isConnected(host.id));
    expect(got.some((f) => f.t === 'end')).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(got.some((f) => f.t === 'err' && f.message === 'host disconnected')).toBe(true);
    expect(got.some((f) => f.t === 'end')).toBe(true);
  });

  it('gap on resume delivers err+end', async () => {
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000 });
    const { host, hubT } = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const got: Array<{ t: string; message?: string }> = [];
    ctx.hub.link(host.id).subscribe('s1', (f) => got.push(f));
    hubT.close();
    await until(() => !ctx.hub.isConnected(host.id));
    await reconnectTrusted(ctx, host.id, {
      nodeHandlers: {
        ping: async () => ({ ok: true }),
        'session.resume': async () => {
          throw new RpcError('gap', 'oldest seq 5 > 1');
        },
      },
    });
    await until(() => got.some((f) => f.t === 'end'), 'gap did not end subscriber');
    expect(got.some((f) => f.t === 'err' && f.message === 'host disconnected — events lost; next turn resumes natively')).toBe(true);
    expect(got.filter((f) => f.t === 'end')).toHaveLength(1);
  });

  it('revoke delivers err+end immediately', async () => {
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000, hubGraceMs: 60_000 });
    const { host } = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const got: Array<{ t: string; message?: string }> = [];
    ctx.hub.link(host.id).subscribe('s1', (f) => got.push(f));
    ctx.hub.disconnect(host.id, 'host revoked');
    expect(got.some((f) => f.t === 'err' && f.message === 'host revoked')).toBe(true);
    expect(got.some((f) => f.t === 'end')).toBe(true);
  });

  it('full down aborts parked steer so operator send stays queued for reconnect next', async () => {
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000 });
    const src = pullNextSteerSource();
    const first = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const link = ctx.hub.link(first.host.id);
    link.setSteerSource('s1', src.getNextSteer);
    const parked = first.node.request('steer.next', { sid: 's1' }, 0);
    void parked.catch(() => {});
    await until(() => src.resolvers.length === 1, 'steer.next did not park');

    first.hubT.close();
    await until(() => !ctx.hub.isConnected(first.host.id));
    await until(() => src.resolvers.length === 0, 'parked pull was not aborted');
    await expect(parked).rejects.toMatchObject({ code: 'disconnected' });

    src.operatorSend('during-grace');
    expect(src.queue.map((q) => q.text)).toEqual(['during-grace']);
    expect(src.resolvers).toHaveLength(0);

    const second = await reconnectTrusted(ctx, first.host.id, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    await expect(second.node.request('steer.next', { sid: 's1' }, 5_000))
      .resolves.toEqual({ text: 'during-grace' });
    expect(src.queue).toHaveLength(0);
  });

  it('session.resume timeout after reconnect emitLost then end', async () => {
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000 });
    const { host, hubT } = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const got: Array<{ t: string; message?: string }> = [];
    ctx.hub.link(host.id).subscribe('s1', (f) => got.push(f));
    hubT.close();
    await until(() => !ctx.hub.isConnected(host.id));
    await reconnectTrusted(ctx, host.id, {
      nodeHandlers: {
        ping: async () => ({ ok: true }),
        'session.resume': async () => {
          throw new RpcError('timeout', 'timeout');
        },
      },
    });
    await until(() => got.some((f) => f.t === 'end'), 'timeout did not end subscriber');
    expect(got.some((f) => f.t === 'err' && f.message === 'host disconnected — events lost; next turn resumes natively')).toBe(true);
    expect(got.filter((f) => f.t === 'end')).toHaveLength(1);
  });

  it('session.resume host_disconnected after reconnect does not emitLost', async () => {
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000, hubGraceMs: 60_000 });
    const { host, hubT } = await connectTrusted(ctx, {
      nodeHandlers: { ping: async () => ({ ok: true }) },
    });
    const got: Array<{ t: string; message?: string }> = [];
    ctx.hub.link(host.id).subscribe('s1', (f) => got.push(f));
    hubT.close();
    await until(() => !ctx.hub.isConnected(host.id));
    await reconnectTrusted(ctx, host.id, {
      nodeHandlers: {
        ping: async () => ({ ok: true }),
        'session.resume': async () => {
          throw new RpcError('host_disconnected', 'host disconnected');
        },
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(got.some((f) => f.t === 'end')).toBe(false);
    expect(got.some((f) => f.t === 'err')).toBe(false);
    expect(ctx.hub.isConnected(host.id)).toBe(true);
  });

  it('stop during grace orphan-stops on reconnect (no resume)', async () => {
    const ctx = boot({ pingMs: 60_000, handshakeMs: 60_000, hubGraceMs: 60_000 });
    const first = await connectTrusted(ctx, {
      nodeHandlers: {
        ping: async () => ({ ok: true }),
        'session.create': async () => ({}),
        'session.call': async () => ({}),
      },
    });
    const proxy = new RemoteAdapterProxy(ctx.hub.link(first.host.id), 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
    });
    await proxy.start({
      sessionId: 's1',
      conversationId: 'c1',
      cwd: '/tmp',
      model: 'm',
    });

    first.hubT.close();
    await until(() => !ctx.hub.isConnected(first.host.id));
    await proxy.stop();

    const resumes: unknown[] = [];
    const secondCalls: unknown[] = [];
    await reconnectTrusted(ctx, first.host.id, {
      hello: { sessions: ['s1'] },
      nodeHandlers: {
        ping: async () => ({ ok: true }),
        'session.call': async (p) => {
          secondCalls.push(p);
          return {};
        },
        'session.resume': async (p) => {
          resumes.push(p);
          return { replayed: 0 };
        },
      },
    });
    await until(() => secondCalls.some((c) => (c as { method?: string }).method === 'stop'), 'orphan stop not sent');
    expect(resumes).toHaveLength(0);
    expect(secondCalls).toEqual([{ sid: 's1', method: 'stop', args: [] }]);
  });

  // P2c: Refresh must re-fetch a FRESH hello over the live link (agent binaries
  // may have been installed / logged in since connect), not replay the
  // connect-time snapshot.
  it('refresh re-fetches hello via node.hello and persists the new payload', async () => {
    const ctx = boot();
    let served = 0;
    const { host } = await connectTrusted(ctx, {
      hello: hello({ gitSha: 'aa1', agents: { codex: { installed: true, methods: [] } } }),
      nodeHandlers: {
        'node.hello': async () => {
          served++;
          return hello({
            gitSha: 'aa2',
            agents: { codex: { installed: true, allowed: true, installable: true, methods: [], loggedIn: true } },
          });
        },
      },
    });
    const refreshed = await ctx.hub.refresh(host.id);
    expect(served).toBe(1);
    expect(refreshed.gitSha).toBe('aa2');
    expect(refreshed.agents.codex?.loggedIn).toBe(true);
    // Persisted to the db and visible on the live link.
    const saved = getRemoteHost(ctx.db, host.id);
    expect(saved?.hello.gitSha).toBe('aa2');
    expect(saved?.hello.agents.codex?.loggedIn).toBe(true);
  });

  // Old node build: no node.hello → no_method. Refresh must degrade to a ping
  // and keep the last known hello instead of failing or wiping state.
  it('refresh falls back to ping and keeps the old hello when the node lacks node.hello', async () => {
    const ctx = boot();
    let pings = 0;
    const { host } = await connectTrusted(ctx, {
      hello: hello({ gitSha: 'old', agents: { codex: { installed: true, methods: [] } } }),
      nodeHandlers: { ping: async () => { pings++; return { ok: true }; } },
    });
    const refreshed = await ctx.hub.refresh(host.id);
    expect(pings).toBe(1);
    expect(refreshed.gitSha).toBe('old');
    expect(getRemoteHost(ctx.db, host.id)?.hello.gitSha).toBe('old');
  });

  // A misbehaving node replying with a foreign protocol must not clobber the
  // last known-good hello in either the db or the live link.
  it('refresh keeps the old hello when the node replies with a foreign protocol', async () => {
    const ctx = boot();
    const { host } = await connectTrusted(ctx, {
      hello: hello({ gitSha: 'old' }),
      nodeHandlers: { 'node.hello': async () => hello({ protocol: 99, gitSha: 'new' }) },
    });
    const refreshed = await ctx.hub.refresh(host.id);
    expect(refreshed.gitSha).toBe('old');
    expect(getRemoteHost(ctx.db, host.id)?.hello.gitSha).toBe('old');
  });
});

describe('NodeHub probeLoginStatus', () => {
  it('overlays loggedIn from agents.loginStatus onto the live hello', async () => {
    const ctx = boot();
    const { host } = await connectTrusted(ctx, {
      hello: hello({
        features: ['agents.loginStatus'],
        agents: { codex: { installed: true, methods: [], loggedIn: true } },
      }),
      nodeHandlers: {
        'agents.loginStatus': async () => ({ loggedIn: { codex: false } }),
      },
    });
    await ctx.hub.probeLoginStatus(host.id);
    expect(ctx.hub.view(getRemoteHost(ctx.db, host.id)!).hello.agents?.codex?.loggedIn).toBe(false);
    expect(getRemoteHost(ctx.db, host.id)?.hello.agents.codex?.loggedIn).toBe(false);
  });

  it('a refresh landing during the RPC is not overwritten by the pre-await hello', async () => {
    const ctx = boot();
    let release!: (v: unknown) => void;
    const { host } = await connectTrusted(ctx, {
      hello: hello({
        features: ['agents.loginStatus'],
        agents: { codex: { installed: true, methods: [], loggedIn: true, version: '1.0.0' } },
      }),
      nodeHandlers: {
        'agents.loginStatus': () => new Promise((r) => { release = r; }),
        'node.hello': async () => hello({
          features: ['agents.loginStatus'],
          agents: { codex: { installed: true, methods: [], loggedIn: true, version: '2.0.0' } },
        }),
      },
    });
    const probing = ctx.hub.probeLoginStatus(host.id);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await ctx.hub.refresh(host.id);
    release({ loggedIn: { codex: false } });
    await probing;
    const agent = getRemoteHost(ctx.db, host.id)?.hello.agents.codex;
    expect(agent?.version).toBe('2.0.0');
    expect(agent?.loggedIn).toBe(false);
  });

  it('no-ops on old nodes without the feature (does not RPC)', async () => {
    const ctx = boot();
    let calls = 0;
    const { host } = await connectTrusted(ctx, {
      hello: hello({
        features: ['agents.login'],
        agents: { codex: { installed: true, methods: [], loggedIn: true } },
      }),
      nodeHandlers: {
        'agents.loginStatus': async () => { calls++; return { loggedIn: { codex: false } }; },
      },
    });
    await ctx.hub.probeLoginStatus(host.id);
    expect(calls).toBe(0);
    expect(ctx.hub.view(getRemoteHost(ctx.db, host.id)!).hello.agents?.codex?.loggedIn).toBe(true);
  });

  it('no_method from a node that advertised the feature keeps hello-time status', async () => {
    const ctx = boot();
    const { host } = await connectTrusted(ctx, {
      hello: hello({
        features: ['agents.loginStatus'],
        agents: { codex: { installed: true, methods: [], loggedIn: true } },
      }),
      nodeHandlers: {
        'agents.loginStatus': async () => { throw new RpcError('no_method', 'agents.loginStatus'); },
      },
    });
    await ctx.hub.probeLoginStatus(host.id);
    expect(ctx.hub.view(getRemoteHost(ctx.db, host.id)!).hello.agents?.codex?.loggedIn).toBe(true);
  });
});

describe('NodeHub agent env sync', () => {
  const SECRET32 = 'abcdefghijklmnopqrstuvwxyz012345';
  const AGENT_HELLO = {
    features: ['agent_env' as const],
    agents: { codex: { installed: true, allowed: true, methods: [] } },
  };

  function setToggle(db: Database, hostId: string, on: 0 | 1): void {
    db.prepare('UPDATE remote_hosts SET allow_agent_env_secrets = ? WHERE id = ?').run(on, hostId);
  }

  function syncRecorder(syncs: unknown[], changed = false) {
    return async (p: unknown) => {
      syncs.push(p);
      return { ok: true, changed };
    };
  }

  it('pushes vault values on connect when the toggle is on', async () => {
    initVaultKey({ sessionSecret: SECRET32 });
    const ctx = boot();
    vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-node-secret-1');
    const syncs: unknown[] = [];
    const { host } = await connectTrusted(ctx, {
      hello: AGENT_HELLO,
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    await until(() => syncs.length === 1, 'first sync not delivered');
    expect(syncs[0]).toEqual({ vars: {}, managedNames: [] });

    setToggle(ctx.db, host.id, 1);
    await reconnectTrusted(ctx, host.id, {
      hello: AGENT_HELLO,
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    await until(() => syncs.length === 2, 'second sync not delivered');
    expect(syncs[1]).toEqual({
      vars: { codex: { OPENAI_API_KEY: 'sk-node-secret-1' } },
      managedNames: ['OPENAI_API_KEY'],
    });
  });

  it('sends no values for agents the hello does not allow but keeps their names', async () => {
    initVaultKey({ sessionSecret: SECRET32 });
    const ctx = boot();
    vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-node-secret-2');
    vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('cursor', 'CURSOR_API_KEY'), 'sk-node-secret-3');
    const syncs: unknown[] = [];
    const { host } = await connectTrusted(ctx, {
      hello: AGENT_HELLO,
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    setToggle(ctx.db, host.id, 1);
    await reconnectTrusted(ctx, host.id, {
      hello: {
        features: ['agent_env' as const],
        agents: {
          codex: { installed: true, allowed: true, methods: [] },
          cursor: { installed: true, allowed: false, methods: [] },
        },
      },
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    await until(() => syncs.length === 2, 'sync after toggle not delivered');
    expect(syncs[1]).toEqual({
      vars: { codex: { OPENAI_API_KEY: 'sk-node-secret-2' } },
      managedNames: ['OPENAI_API_KEY', 'CURSOR_API_KEY'],
    });
  });

  it('sends empty vars and names when the toggle is off', async () => {
    initVaultKey({ sessionSecret: SECRET32 });
    const ctx = boot();
    vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-node-secret-4');
    const syncs: unknown[] = [];
    const { host } = await connectTrusted(ctx, {
      hello: AGENT_HELLO,
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    await until(() => syncs.length === 1, 'sync not delivered');
    expect(syncs[0]).toEqual({ vars: {}, managedNames: [] });
    // Flip on then off again: the next sync must still clear, not deliver.
    setToggle(ctx.db, host.id, 1);
    setToggle(ctx.db, host.id, 0);
    await reconnectTrusted(ctx, host.id, {
      hello: AGENT_HELLO,
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    await until(() => syncs.length === 2, 'sync after reconnect not delivered');
    expect(syncs[1]).toEqual({ vars: {}, managedNames: [] });
  });

  it('skips the sync entirely for nodes without the agent_env feature', async () => {
    initVaultKey({ sessionSecret: SECRET32 });
    const ctx = boot();
    vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-node-secret-5');
    const syncs: unknown[] = [];
    const { host } = await connectTrusted(ctx, {
      hello: { agents: { codex: { installed: true, allowed: true, methods: [] } } },
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    setToggle(ctx.db, host.id, 1);
    await reconnectTrusted(ctx, host.id, {
      hello: { agents: { codex: { installed: true, allowed: true, methods: [] } } },
      nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(syncs).toEqual([]);
    expect(ctx.hub.isConnected(host.id)).toBe(true);
  });

  it('refreshes hello and pushes status only when the node reports changed', async () => {
    initVaultKey({ sessionSecret: SECRET32 });
    const ctx = boot();
    vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-node-secret-6');
    let helloServes = 0;
    const freshHello = () => hello({ ...AGENT_HELLO, gitSha: 'aa2' });
    const { host } = await connectTrusted(ctx, {
      hello: { ...AGENT_HELLO, gitSha: 'aa1' },
      nodeHandlers: {
        'agentEnv.sync': syncRecorder([], false),
        'node.hello': async () => { helloServes++; return freshHello(); },
        ping: async () => ({ ok: true }),
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(helloServes).toBe(0);
    const statusesAfterConnect = ctx.statuses.length;

    setToggle(ctx.db, host.id, 1);
    await reconnectTrusted(ctx, host.id, {
      hello: { ...AGENT_HELLO, gitSha: 'aa1' },
      nodeHandlers: {
        'agentEnv.sync': syncRecorder([], true),
        'node.hello': async () => { helloServes++; return freshHello(); },
        ping: async () => ({ ok: true }),
      },
    });
    await until(() => helloServes >= 1, 'node.hello not served after changed sync');
    await until(() => ctx.statuses.length > statusesAfterConnect, 'no status pushed after changed sync');
    const last = ctx.statuses[ctx.statuses.length - 1]!;
    expect(last.hello.gitSha).toBe('aa2');
    expect(getRemoteHost(ctx.db, host.id)?.hello.gitSha).toBe('aa2');
  });

  it('a failed sync does not drop the connection and logs without values', async () => {
    initVaultKey({ sessionSecret: SECRET32 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = boot();
    vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-node-secret-9');
    const { host } = await connectTrusted(ctx, {
      hello: AGENT_HELLO,
      nodeHandlers: {
        'agentEnv.sync': async () => { throw new Error('node exploded'); },
        ping: async () => ({ ok: true }),
      },
    });
    setToggle(ctx.db, host.id, 1);
    await reconnectTrusted(ctx, host.id, {
      hello: AGENT_HELLO,
      nodeHandlers: {
        'agentEnv.sync': async () => { throw new Error('node exploded'); },
        ping: async () => ({ ok: true }),
      },
    });
    await until(
      () => warn.mock.calls.some((c) => c.map(String).join(' ').includes('node exploded')),
      'sync failure was not logged',
    );
    expect(ctx.hub.isConnected(host.id)).toBe(true);
    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('sk-node-secret-9');
    warn.mockRestore();
  });

  it('frame log omits agentEnv.sync payloads entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-frame-log-'));
    const logPath = join(dir, 'frames.log');
    process.env.TIERWYN_NODE_FRAME_LOG = logPath;
    try {
      initVaultKey({ sessionSecret: SECRET32 });
      const ctx = boot();
      vaultSet(ctx.db, AGENT_VAULT_ID, agentEnvVaultKey('codex', 'OPENAI_API_KEY'), 'sk-frame-secret-7');
      const syncs: unknown[] = [];
      const { host } = await connectTrusted(ctx, {
        hello: AGENT_HELLO,
        nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
      });
      setToggle(ctx.db, host.id, 1);
      await reconnectTrusted(ctx, host.id, {
        hello: AGENT_HELLO,
        nodeHandlers: { 'agentEnv.sync': syncRecorder(syncs), ping: async () => ({ ok: true }) },
      });
      await until(() => syncs.length === 2, 'sync not delivered');
      const log = readFileSync(logPath, 'utf-8');
      expect(log).not.toContain('sk-frame-secret-7');
      expect(log).not.toContain('agentEnv.sync');
    } finally {
      delete process.env.TIERWYN_NODE_FRAME_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frame log omits agents.loginEvent payloads entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-frame-log-login-'));
    const logPath = join(dir, 'frames.log');
    process.env.TIERWYN_NODE_FRAME_LOG = logPath;
    try {
      const ctx = boot();
      const { node } = await connectTrusted(ctx, {
        nodeHandlers: { ping: async () => ({ ok: true }) },
      });
      await node.request('agents.loginEvent', {
        agentType: 'codex',
        phase: 'device',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'TAEF-M7I6R',
      }).catch(() => { /* handler may be missing until wired */ });
      const log = readFileSync(logPath, 'utf-8');
      expect(log).not.toContain('TAEF-M7I6R');
      expect(log).not.toContain('agents.loginEvent');
    } finally {
      delete process.env.TIERWYN_NODE_FRAME_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('frame log omits agents.login submit frames entirely', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tierwyn-frame-log-login-submit-'));
    const logPath = join(dir, 'frames.log');
    process.env.TIERWYN_NODE_FRAME_LOG = logPath;
    try {
      const ctx = boot();
      const { host } = await connectTrusted(ctx, {
        nodeHandlers: {
          ping: async () => ({ ok: true }),
          'agents.login': async () => ({ submitted: true }),
        },
      });
      await ctx.hub.link(host.id).request('agents.login', {
        agentType: 'claude-code',
        op: 'submit',
        code: 'abc#st',
      });
      const log = readFileSync(logPath, 'utf-8');
      expect(log).not.toContain('abc#st');
      expect(log).not.toContain('agents.login');
    } finally {
      delete process.env.TIERWYN_NODE_FRAME_LOG;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('carryVersions', () => {
  const a = (version?: string, installed = true) => ({ installed, allowed: true, methods: [], ...(version ? { version } : {}) });
  const h = (agents: Record<string, ReturnType<typeof a>>) => ({ agents } as unknown as NodeHello);

  it('keeps a known version when a refresh probe timed out, not for the reprobed or uninstalled agent', () => {
    const prev = h({ kimi: a('2.3.3'), cursor: a('2026.10.22-27dcf5f'), pi: a('1.0.0'), qwen: a('0.1.0') });
    const next = h({ kimi: a(), cursor: a(), pi: a(), qwen: a(undefined, false) });
    const out = carryVersions(next, prev, 'pi').agents!;
    expect(out.kimi.version).toBe('2.3.3');
    expect(out.cursor.version).toBe('2026.10.22-27dcf5f');
    expect(out.pi.version).toBeUndefined();
    expect(out.qwen.version).toBeUndefined();
  });

  it('a fresh version wins', () => {
    expect(carryVersions(h({ kimi: a('2.4.0') }), h({ kimi: a('2.3.3') })).agents!.kimi.version).toBe('2.4.0');
  });
});
