import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  NODE_PROTOCOL,
  authPayload,
  type AgentAdapter,
  type NodeFrame,
  type NodeHello,
  type NormalisedEvent,
  type RemoteHostView,
  type SessionConfig,
} from '@tierwyn/shared';
import { runMigrations } from '../db/migrate.js';
import { migrations } from '../db/migrations/index.js';
import {
  createPendingHost,
  getRemoteHost,
  redeemEnrollToken,
  setRemoteHostStatus,
} from '../repositories/remoteHosts.js';
import { memoryPair, RpcPeer, type FrameTransport } from './rpc.js';
import { NodeHub } from './nodeHub.js';
import { NodeRuntime } from './runtime.js';
import type { AdapterFactoryOpts } from '../registry.js';

afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

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
    agents: { 'claude-code': { installed: true, methods: [] } },
    models: {},
    sessions: [],
    ...over,
  };
}

function seedHost(db: Database, publicKey: string) {
  const pending = createPendingHost(db, 'alpha', 'tok', Date.now() + 60_000);
  redeemEnrollToken(db, 'tok', Date.now(), {
    publicKey,
    hubOrigin: HUB_ORIGIN,
    hello: { hostname: 'box' },
  });
  setRemoteHostStatus(db, pending.id, 'trusted');
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

function msg(chunk: string): NormalisedEvent {
  return { type: 'message', sessionId: 's1', ts: 1, seq: 1, payload: { chunk } };
}

class HoldAdapter implements AgentAdapter {
  readonly emitter = new EventEmitter();
  stopped = false;
  async start(_config: SessionConfig): Promise<void> { /* hold open */ }
  async sendPrompt(): Promise<void> { /* hold open */ }
  streamEvents(): EventEmitter { return this.emitter; }
  async stop(): Promise<void> { this.stopped = true; }
  async listSessions() { return []; }
  async loadSession() { /* noop */ }
  async listModels() { return []; }
}

describe('reconnect resume', () => {
  it('reconnect within grace resumes and delivers missing events in order', async () => {
    const db = freshDb();
    const statuses: RemoteHostView[] = [];
    const hub = new NodeHub({
      db: () => db,
      onStatus: (v) => statuses.push({ ...v }),
      isLiveSession: () => true,
      pingMs: 60_000,
      handshakeMs: 60_000,
      hubGraceMs: 60_000,
    });
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const host = seedHost(db, spkiB64(publicKey));
    const root = tmp('rh-resume-');
    const created: HoldAdapter[] = [];
    const runtime = new NodeRuntime({
      create(_type: string, _o?: AdapterFactoryOpts) {
        const a = new HoldAdapter();
        created.push(a);
        return a;
      },
      has: () => true,
      policy: { roots: [root], allowedAgents: ['claude-code'], maxSessions: 8 },
      graceMs: 120_000,
    });

    const first = pairWithClose();
    const frames1: NodeFrame[] = [];
    const node1 = new RpcPeer(first.nodeT, runtime.handlers());
    node1.on('frame', (f: NodeFrame) => frames1.push(f));
    runtime.attach(node1);
    hub.acceptTransport(first.hubT);
    await until(() => frames1.some((f) => f.t === 'challenge'));
    const nonce1 = (frames1.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node1.send({
      t: 'auth',
      hostId: host.id,
      sig: signAuth(privateKey, nonce1, host.id, HUB_ORIGIN),
    });
    node1.send({ t: 'hello', hello: hello({ roots: [root], sessions: ['s1'] }) });
    await until(() => hub.isConnected(host.id));

    const got: Array<{ t: string; seq?: number }> = [];
    hub.link(host.id).subscribe('s1', (f) => got.push(f));

    await hub.link(host.id).request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
    });
    await hub.link(host.id).request('session.call', {
      sid: 's1',
      method: 'start',
      args: [{ sessionId: 's1', conversationId: 'c1', cwd: root, model: 'm' } satisfies SessionConfig],
    });
    created[0]!.emitter.emit('event', msg('1'));
    created[0]!.emitter.emit('event', msg('2'));
    created[0]!.emitter.emit('event', msg('3'));
    await until(() => got.filter((f) => f.t === 'ev').length === 3, 'did not get 1..3');

    runtime.detach();
    first.hubT.close();
    await until(() => !hub.isConnected(host.id));

    created[0]!.emitter.emit('event', msg('4'));
    created[0]!.emitter.emit('event', msg('5'));

    const second = pairWithClose();
    const frames2: NodeFrame[] = [];
    const node2 = new RpcPeer(second.nodeT, runtime.handlers());
    node2.on('frame', (f: NodeFrame) => frames2.push(f));
    runtime.attach(node2);
    hub.acceptTransport(second.hubT);
    await until(() => frames2.some((f) => f.t === 'challenge'));
    const nonce2 = (frames2.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
    node2.send({
      t: 'auth',
      hostId: host.id,
      sig: signAuth(privateKey, nonce2, host.id, HUB_ORIGIN),
    });
    node2.send({ t: 'hello', hello: hello({ roots: [root], sessions: ['s1'] }) });
    await until(() => hub.isConnected(host.id));

    await until(
      () => got.filter((f) => f.t === 'ev').length === 5,
      `expected 5 ev, got ${got.filter((f) => f.t === 'ev').map((f) => f.seq).join(',')}`,
    );
    expect(got.filter((f) => f.t === 'ev').map((f) => f.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(got.filter((f) => f.t === 'end')).toHaveLength(0);
  });
});
