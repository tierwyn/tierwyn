import { generateKeyPairSync, sign, type KeyObject } from 'crypto';
import { describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  NODE_PROTOCOL,
  authPayload,
  type NodeFrame,
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
  updateRemoteHost,
} from '../repositories/remoteHosts.js';
import { initVaultKey, vaultSet } from '../plugins/vault.js';
import { AGENT_VAULT_ID } from '../secrets/mcpRedact.js';
import { agentEnvVaultKey } from '../secrets/agentEnv.js';
import { memoryPair, RpcPeer, type FrameTransport } from './rpc.js';
import { NodeHub } from './nodeHub.js';
import { NodeRuntime } from './runtime.js';
import { AgentEnvStore } from './agentEnvStore.js';

// End-to-end wiring the review called out as untested (F7): NodeHub →
// agentEnv.sync RPC → NodeRuntime → AgentEnvStore → child-env slice, plus the
// F1 plaintext-origin guard, over an in-memory transport.

const HUB_ORIGIN = 'https://hub.example';
const VAULT_SECRET = 'abcdefghijklmnopqrstuvwxyz012345';
const KEY_V1 = 'sk-zai-value-one-1';
const KEY_V2 = 'sk-zai-value-two-2';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrations);
  return db;
}

function pairWithClose(): { hubT: FrameTransport; nodeT: FrameTransport } {
  const [hubT, nodeT] = memoryPair();
  return { hubT, nodeT };
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
    agents: { hermes: { installed: true, methods: [], allowed: true } },
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

function signAuth(privateKey: KeyObject, nonce: string, hostId: string, hubOrigin: string): string {
  return sign(null, Buffer.from(authPayload(nonce, hostId, hubOrigin)), privateKey).toString('base64url');
}

async function until(pred: () => boolean, msg = 'condition not met'): Promise<void> {
  await vi.waitFor(
    () => {
      if (!pred()) throw new Error(msg);
    },
    { timeout: 5_000 },
  );
}

function boot() {
  const db = freshDb();
  const statuses: RemoteHostView[] = [];
  const hub = new NodeHub({
    db: () => db,
    onStatus: (v) => statuses.push({ ...v }),
    isLiveSession: () => false,
  });
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { db, hub, statuses, publicKey, privateKey };
}

function mkRuntime(store: AgentEnvStore, helloPayload: NodeHello) {
  const runtime = new NodeRuntime({
    create() { throw new Error('no adapters in this test'); },
    has: () => false,
    policy: {
      roots: [],
      allowedAgents: ['hermes', 'claude-code'],
      maxSessions: 8,
      allowSelfUpdate: false,
    },
    agentEnv: store,
    buildHello: async () => helloPayload,
  });
  return runtime;
}

/** Real challenge→auth→hello handshake with a NodeRuntime-backed node peer.
 *  `hubOrigin` must match the origin the host was seeded with — the hub
 *  verifies the signature against the row's stored origin. */
async function connect(
  ctx: ReturnType<typeof boot>,
  hostId: string,
  runtime: NodeRuntime,
  helloPayload: NodeHello,
  hubOrigin: string = HUB_ORIGIN,
) {
  const { hubT, nodeT } = pairWithClose();
  const frames: NodeFrame[] = [];
  const node = new RpcPeer(nodeT, {
    ping: async () => ({ ok: true }),
    ...runtime.handlers(),
  });
  node.on('frame', (f: NodeFrame) => frames.push(f));
  ctx.hub.acceptTransport(hubT);
  await until(() => frames.some((f) => f.t === 'challenge'), 'no challenge');
  const nonce = (frames.find((f) => f.t === 'challenge') as Extract<NodeFrame, { t: 'challenge' }>).nonce;
  node.send({ t: 'auth', hostId, sig: signAuth(ctx.privateKey, nonce, hostId, hubOrigin) });
  node.send({ t: 'hello', hello: helloPayload });
  await until(() => ctx.hub.isConnected(hostId), 'hub did not bind');
  return { node, frames };
}

async function seedEnv(db: Database, key: string, value: string): Promise<void> {
  vaultSet(db, AGENT_VAULT_ID, agentEnvVaultKey('hermes', key), value);
}

describe('agent env end-to-end (hub → node runtime → store)', () => {
  it('delivers, rotates, and clears values through the real agentEnv.sync RPC', async () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey));
    updateRemoteHost(ctx.db, host.id, { allowAgentEnvSecrets: true });
    await seedEnv(ctx.db, 'ZAI_API_KEY', KEY_V1);

    const store = new AgentEnvStore(() => ['hermes', 'claude-code']);
    const runtime = mkRuntime(store, hello({ features: ['agent_env'] }));
    await connect(ctx, host.id, runtime, hello({ features: ['agent_env'] }));

    // Hello-bind triggers the hub push; the value lands in the child-env slice.
    await until(
      () => store.slice('hermes').own.ZAI_API_KEY === KEY_V1,
      'value not delivered after connect',
    );
    expect(store.slice('claude-code').own).toEqual({});
    expect(store.revision).toBeGreaterThan(0);

    // Rotation: same key, new value.
    await seedEnv(ctx.db, 'ZAI_API_KEY', KEY_V2);
    await ctx.hub.syncAgentEnv(host.id);
    await until(
      () => store.slice('hermes').own.ZAI_API_KEY === KEY_V2,
      'rotated value not delivered',
    );
    // Retired value stays in memory for redaction (F3 semantics).
    expect(store.secrets()).toEqual(expect.arrayContaining([KEY_V1, KEY_V2]));

    // Toggle off: the hub pushes an empty snapshot — values stop injecting,
    // managed names are withdrawn, but the node keeps redacting values it
    // already held (F3 semantics: retired values live until node restart).
    updateRemoteHost(ctx.db, host.id, { allowAgentEnvSecrets: false });
    await ctx.hub.syncAgentEnv(host.id);
    expect(store.slice('hermes').own).toEqual({});
    expect(store.slice('hermes').managedNames.size).toBe(0);
    expect(store.secrets()).toEqual(expect.arrayContaining([KEY_V1, KEY_V2]));

    // Re-toggle: values flow again.
    updateRemoteHost(ctx.db, host.id, { allowAgentEnvSecrets: true });
    await ctx.hub.syncAgentEnv(host.id);
    await until(
      () => store.slice('hermes').own.ZAI_API_KEY === KEY_V2,
      'value not re-delivered after re-toggle',
    );

    // Disable-time wipe (F2): explicit clear empties names too; retired
    // values still redact until the node process restarts.
    await ctx.hub.clearAgentEnv(host.id);
    expect(store.slice('hermes').own).toEqual({});
    expect(store.slice('hermes').managedNames.size).toBe(0);
    expect(store.secrets()).toEqual(expect.arrayContaining([KEY_V1, KEY_V2]));
  });

  it('refuses values over a plaintext ws:// link to a non-loopback hub (F1) but still sends names', async () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey), 'trusted', 'http://10.0.0.5:8787');
    updateRemoteHost(ctx.db, host.id, { allowAgentEnvSecrets: true });
    await seedEnv(ctx.db, 'ZAI_API_KEY', KEY_V1);

    const store = new AgentEnvStore(() => ['hermes', 'claude-code']);
    const payload = hello({ features: ['agent_env'] });
    const runtime = mkRuntime(store, payload);
    await connect(ctx, host.id, runtime, payload, 'http://10.0.0.5:8787');

    // The hello-bind push goes out, but only managed names survive the guard.
    await until(
      () => store.slice('hermes').managedNames.has('ZAI_API_KEY'),
      'managed names not delivered',
    );
    expect(store.slice('hermes').own).toEqual({});
    // Give a late/second delivery a chance to (wrongly) arrive.
    await ctx.hub.syncAgentEnv(host.id);
    expect(store.slice('hermes').own).toEqual({});
    expect(store.secrets()).toEqual([]);
  });

  it('delivers values over a loopback http:// hub (F1 loopback carve-out)', async () => {
    initVaultKey({ sessionSecret: VAULT_SECRET });
    const ctx = boot();
    const host = seedHost(ctx.db, spkiB64(ctx.publicKey), 'trusted', 'http://127.0.0.1:8787');
    updateRemoteHost(ctx.db, host.id, { allowAgentEnvSecrets: true });
    await seedEnv(ctx.db, 'ZAI_API_KEY', KEY_V1);

    const store = new AgentEnvStore(() => ['hermes', 'claude-code']);
    const payload = hello({ features: ['agent_env'] });
    const runtime = mkRuntime(store, payload);
    await connect(ctx, host.id, runtime, payload, 'http://127.0.0.1:8787');

    await until(
      () => store.slice('hermes').own.ZAI_API_KEY === KEY_V1,
      'value not delivered over loopback http',
    );
  });
});

function spkiB64(pub: KeyObject): string {
  return pub.export({ type: 'spki', format: 'der' }).toString('base64');
}
