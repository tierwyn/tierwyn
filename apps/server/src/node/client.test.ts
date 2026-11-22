import { generateKeyPairSync, type KeyObject } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  NODE_PROTOCOL,
  type AgentsLoginEvent,
  type NodeHello,
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
import { startNodeClient } from './client.js';
import { NodeHub } from './nodeHub.js';
import { memoryPair, RpcPeer, type FrameTransport } from './rpc.js';
import type { NodeRuntime } from './runtime.js';
import type { NodeConfig } from './policy.js';

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

function spkiB64(pub: KeyObject): string {
  return pub.export({ type: 'spki', format: 'der' }).toString('base64');
}

function seedHost(db: Database, publicKey: string, hubOrigin = HUB_ORIGIN) {
  const pending = createPendingHost(db, 'alpha', 'tok', Date.now() + 60_000);
  redeemEnrollToken(db, 'tok', Date.now(), {
    publicKey,
    hubOrigin,
    hello: { hostname: 'box' },
  });
  setRemoteHostStatus(db, pending.id, 'trusted');
  return getRemoteHost(db, pending.id)!;
}

function boot() {
  const db = freshDb();
  const statuses: RemoteHostView[] = [];
  const hub = new NodeHub({
    db: () => db,
    onStatus: (v) => statuses.push({ ...v }),
    isLiveSession: () => false,
    handshakeMs: 60_000,
    pingMs: 60_000,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { db, hub, statuses, publicKey, privateKey };
}

function stubRuntime() {
  const attach = vi.fn();
  const detach = vi.fn();
  let emit: ((ev: AgentsLoginEvent) => void) | undefined;
  const setLoginEmitter = vi.fn((fn: (ev: AgentsLoginEvent) => void) => { emit = fn; });
  const runtime = {
    attach,
    detach,
    sessionIds: () => [],
    handlers: () => ({ ping: async () => ({ ok: true }) }),
    setLoginEmitter,
  } as unknown as NodeRuntime;
  return {
    runtime,
    attach,
    detach,
    setLoginEmitter,
    fireLogin: (ev: AgentsLoginEvent) => emit?.(ev),
  };
}

async function until(pred: () => boolean, msg = 'condition not met'): Promise<void> {
  await vi.waitFor(() => {
    if (!pred()) throw new Error(msg);
  });
}

describe('startNodeClient', () => {
  it('connects, authenticates, hello received', async () => {
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const urls: string[] = [];
    const { hubT, nodeT } = pairWithClose();
    const { runtime, attach } = stubRuntime();
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: host.id,
      roots: ['/home/n/work'],
      allowedAgents: [],
      listenPort: 8788,
      maxSessions: 8,
      keyPath: '/tmp/key',
    };
    const client = startNodeClient({
      config,
      privateKey: ctx.privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello({ hostname: 'node-a', gitSha: 'deadbeef' }),
      runtime,
      connect: (url) => {
        urls.push(url);
        ctx.hub.acceptTransport(hubT);
        return nodeT;
      },
    });
    try {
      await until(() => ctx.hub.isConnected(host.id));
      expect(urls).toEqual(['wss://hub.example/ws/node']);
      expect(attach).toHaveBeenCalledTimes(1);
      const saved = getRemoteHost(ctx.db, host.id)!;
      expect(saved.hello.hostname).toBe('node-a');
      expect(saved.hello.gitSha).toBe('deadbeef');
      expect(client.peer()).toBeDefined();
    } finally {
      client.stop();
    }
  });

  it('features() reflects the hub.features probe; old hubs leave it empty', async () => {
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: host.id,
      roots: [],
      allowedAgents: [],
      listenPort: 8788,
      maxSessions: 8,
      keyPath: '/tmp/key',
    };
    // Old hub: answers the handshake but has no hub.features handler → no_method.
    // req frames never reach RpcPeer's 'frame' event, so observe via the transport.
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    const probeSeen = new Promise<void>((resolve) => {
      hubT.onText((t) => {
        if (t.includes('hub.features')) resolve();
      });
    });
    const { runtime } = stubRuntime();
    hub.send({ t: 'challenge', nonce: 'n0' });
    const client = startNodeClient({
      config,
      privateKey: ctx.privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello(),
      runtime,
      connect: () => nodeT,
    });
    try {
      await until(() => client.peer() !== undefined);
      await probeSeen;
      // Let the no_method reply round-trip and settle the probe.
      await new Promise((r) => setTimeout(r, 25));
      expect(client.features().has('tunnel.stream')).toBe(false);
      expect(client.features().size).toBe(0);
    } finally {
      client.stop();
    }

    // New hub: answers hub.features with its capability list.
    const [hubT2, nodeT2] = memoryPair();
    const hub2 = new RpcPeer(hubT2, {
      'hub.features': async () => ({ features: ['tunnel.stream'] }),
    });
    hub2.send({ t: 'challenge', nonce: 'n0' });
    const client2 = startNodeClient({
      config,
      privateKey: ctx.privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello(),
      runtime,
      connect: () => nodeT2,
    });
    try {
      await until(() => client2.features().has('tunnel.stream'), 'features probe failed');
      expect(client2.peer()).toBeDefined();
    } finally {
      client2.stop();
    }
  });

  it('reconnects after close with backoff', async () => {
    vi.useFakeTimers();
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const urls: string[] = [];
    const { runtime } = stubRuntime();
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: host.id,
      roots: [],
      allowedAgents: [],
      listenPort: 8788,
      maxSessions: 8,
      keyPath: '/tmp/key',
    };
    const client = startNodeClient({
      config,
      privateKey: ctx.privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello(),
      runtime,
      backoffMs: (attempt) => Math.min(30_000, 1000 * 2 ** attempt),
      connect: (url) => {
        urls.push(url);
        const { hubT, nodeT } = pairWithClose();
        ctx.hub.acceptTransport(hubT);
        return nodeT;
      },
    });
    try {
      await until(() => ctx.hub.isConnected(host.id));
      expect(urls).toHaveLength(1);
      ctx.hub.disconnect(host.id, 'test');
      await until(() => !ctx.hub.isConnected(host.id));
      expect(urls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(urls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => urls.length === 2);
      await until(() => ctx.hub.isConnected(host.id));
    } finally {
      client.stop();
    }
  });

  it('detach called on close, attach on reconnect', async () => {
    vi.useFakeTimers();
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const { runtime, attach, detach } = stubRuntime();
    const config: NodeConfig = {
      hubUrl: 'http://hub.example',
      hostId: host.id,
      roots: [],
      allowedAgents: [],
      listenPort: 8788,
      maxSessions: 8,
      keyPath: '/tmp/key',
    };
    const urls: string[] = [];
    const client = startNodeClient({
      config,
      privateKey: ctx.privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello(),
      runtime,
      backoffMs: () => 50,
      connect: (url) => {
        urls.push(url);
        const { hubT, nodeT } = pairWithClose();
        ctx.hub.acceptTransport(hubT);
        return nodeT;
      },
    });
    try {
      await until(() => attach.mock.calls.length === 1);
      expect(urls[0]).toBe('ws://hub.example/ws/node');
      ctx.hub.disconnect(host.id, 'drop');
      await until(() => detach.mock.calls.length === 1);
      await vi.advanceTimersByTimeAsync(50);
      await until(() => attach.mock.calls.length === 2);
      expect(detach.mock.calls.length).toBeGreaterThanOrEqual(1);
    } finally {
      client.stop();
    }
  });

  it('close 4401 reconnects at the 30s cap', async () => {
    vi.useFakeTimers();
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const urls: string[] = [];
    const { runtime } = stubRuntime();
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: host.id,
      roots: [],
      allowedAgents: [],
      listenPort: 8788,
      maxSessions: 8,
      keyPath: '/tmp/key',
    };
    let first = true;
    const client = startNodeClient({
      config,
      privateKey: ctx.privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello(),
      runtime,
      backoffMs: (attempt) => Math.min(30_000, 1000 * 2 ** attempt),
      connect: (url) => {
        urls.push(url);
        const { hubT, nodeT } = pairWithClose();
        if (first) {
          first = false;
          const wrapped: FrameTransport = {
            send: (text) => nodeT.send(text),
            onText: (cb) => nodeT.onText(cb),
            onClose: (cb) => nodeT.onClose(() => cb(4401, 'unauthorized')),
            close: (code, reason) => nodeT.close(code, reason),
          };
          ctx.hub.acceptTransport(hubT);
          return wrapped;
        }
        ctx.hub.acceptTransport(hubT);
        return nodeT;
      },
    });
    try {
      await until(() => ctx.hub.isConnected(host.id));
      ctx.hub.disconnect(host.id, 'bad key');
      await until(() => !ctx.hub.isConnected(host.id));
      await vi.advanceTimersByTimeAsync(29_999);
      expect(urls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => urls.length === 2);
    } finally {
      client.stop();
    }
  });

  it('close 4403 untrusted retries at 10s so Trust lands without a restart', async () => {
    vi.useFakeTimers();
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    const urls: string[] = [];
    const { runtime } = stubRuntime();
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: host.id,
      roots: [],
      allowedAgents: [],
      listenPort: 8788,
      maxSessions: 8,
      keyPath: '/tmp/key',
    };
    let first = true;
    const client = startNodeClient({
      config,
      privateKey: ctx.privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello(),
      runtime,
      backoffMs: (attempt) => Math.min(30_000, 1000 * 2 ** attempt),
      connect: (url) => {
        urls.push(url);
        const { hubT, nodeT } = pairWithClose();
        if (first) {
          first = false;
          const wrapped: FrameTransport = {
            send: (text) => nodeT.send(text),
            onText: (cb) => nodeT.onText(cb),
            onClose: (cb) => nodeT.onClose(() => cb(4403, 'untrusted')),
            close: (code, reason) => nodeT.close(code, reason),
          };
          ctx.hub.acceptTransport(hubT);
          return wrapped;
        }
        ctx.hub.acceptTransport(hubT);
        return nodeT;
      },
    });
    try {
      await until(() => ctx.hub.isConnected(host.id));
      ctx.hub.disconnect(host.id, 'untrusted');
      await until(() => !ctx.hub.isConnected(host.id));
      await vi.advanceTimersByTimeAsync(9_999);
      expect(urls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await until(() => urls.length === 2);
    } finally {
      client.stop();
    }
  });

  it('setLoginEmitter forwards agents.loginEvent to the hub', async () => {
    const db = freshDb();
    const events: AgentsLoginEvent[] = [];
    const hub = new NodeHub({
      db: () => db,
      onStatus: () => {},
      onLoginEvent: (_id, ev) => { events.push(ev); },
      isLiveSession: () => false,
      handshakeMs: 60_000,
      pingMs: 60_000,
    });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const host = seedHost(db, spkiB64(publicKey));
    const { hubT, nodeT } = pairWithClose();
    const { runtime, setLoginEmitter, fireLogin } = stubRuntime();
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: host.id,
      roots: ['/home/n/work'],
      allowedAgents: [],
      listenPort: 8788,
      maxSessions: 8,
      keyPath: '/tmp/key',
    };
    const client = startNodeClient({
      config,
      privateKey,
      hubOrigin: HUB_ORIGIN,
      buildHello: async () => hello(),
      runtime,
      connect: () => {
        hub.acceptTransport(hubT);
        return nodeT;
      },
    });
    try {
      await until(() => hub.isConnected(host.id));
      expect(setLoginEmitter).toHaveBeenCalled();
      const ev: AgentsLoginEvent = {
        agentType: 'codex',
        phase: 'device',
        url: 'https://auth.openai.com/codex/device',
        userCode: 'TAEF-M7I6R',
      };
      fireLogin(ev);
      await until(() => events.length === 1, 'agents.loginEvent was not forwarded');
      expect(events[0]).toEqual(ev);
    } finally {
      client.stop();
    }
  });
});
