import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, Attachment, NodeAgentInfo, NodeHello, NormalisedEvent, SessionConfig } from '@tierwyn/shared';
import { memoryPair, RpcError, RpcPeer } from './rpc.js';
import { NodeRuntime } from './runtime.js';
import { linkFromPeer, RemoteAdapterProxy } from './proxyAdapter.js';
import { BRIDGE_HEADER, lookupBridgeKey } from '../mcp/bridge.js';
import type { AdapterFactoryOpts } from '../registry.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rh-proxy-'));
  dirs.push(d);
  return d;
}

function msg(chunk: string): NormalisedEvent {
  return { type: 'message', sessionId: 's1', ts: 1, seq: 1, payload: { chunk } };
}

class FakeAdapter implements AgentAdapter {
  readonly emitter = new EventEmitter();
  stopped = false;
  config?: SessionConfig;
  attachments?: Attachment[];
  script: NormalisedEvent[] = [msg('hello')];
  async start(config: SessionConfig) { this.config = config; }
  async sendPrompt(_text: string, attachments?: Attachment[]) {
    this.attachments = attachments;
    setTimeout(() => {
      for (const ev of this.script) this.emitter.emit('event', ev);
      this.emitter.emit('end');
    }, 0);
  }
  streamEvents() { return this.emitter; }
  async stop() { this.stopped = true; }
  async listSessions() { return []; }
  async loadSession() { /* noop */ }
  async listModels() { return [{ name: 'm', label: 'M' }]; }
  async steer(_text: string, _a?: Attachment[]) { /* listed in hello for one test */ }
  async runCommand(_name: string, _args?: string) { /* listed in hello for trim test */ }
  async setMcpServersLive(_servers: never[]) { return true; }
  async mcpStatus() {
    return [{ name: 'n', status: 'connected' as const, source: 'tierwyn' as const }];
  }
}

function helloFor(root: string, methods: string[], extra?: Partial<NodeAgentInfo>, helloExtra?: Partial<NodeHello>): NodeHello {
  return {
    protocol: 1,
    gitSha: 'dead',
    hostname: 'box',
    os: 'linux',
    arch: 'x64',
    homedir: '/home/n',
    roots: [root],
    listenPort: 8788,
    agents: { 'claude-code': { installed: true, methods, ...extra } },
    models: {},
    sessions: [],
    ...helloExtra,
  };
}

async function until(pred: () => boolean, msg = 'waiting'): Promise<void> {
  await vi.waitFor(() => { if (!pred()) throw new Error(msg); });
}

function collectEvents(adapter: AgentAdapter): NormalisedEvent[] {
  const out: NormalisedEvent[] = [];
  adapter.streamEvents().on('event', (e: NormalisedEvent) => out.push(e));
  return out;
}

function setup(methods: string[] = ['steer']) {
  const root = tmp();
  const created: FakeAdapter[] = [];
  const runtime = new NodeRuntime({
    create() {
      const a = new FakeAdapter();
      created.push(a);
      return a;
    },
    has: () => true,
    policy: { roots: [root], allowedAgents: ['claude-code'], maxSessions: 8 },
  });
  const [hubT, nodeT] = memoryPair();
  const nodePeer = new RpcPeer(nodeT, runtime.handlers());
  runtime.attach(nodePeer);
  const hubPeer = new RpcPeer(hubT, {});
  const link = linkFromPeer('host-1', hubPeer, helloFor(root, methods));
  const proxy = new RemoteAdapterProxy(link, 'claude-code', {
    interactionMode: 'bypass',
    allowMcpSecrets: true,
  });
  return { root, created, proxy, link, hubPeer };
}

const cfg = (cwd: string, extra?: Partial<SessionConfig>): SessionConfig => ({
  sessionId: 's1',
  conversationId: 'c1',
  cwd,
  model: 'm',
  ...extra,
});

const bridgeServer = () => ({
  id: 'hub-one',
  transport: 'http' as const,
  args: [] as string[],
  url: 'https://hub.internal/mcp',
  env: {},
  headers: { Authorization: 'Bearer sk-1' },
  secretEnvKeys: [] as string[],
  secretHeaderKeys: ['Authorization'],
  placement: 'hub' as const,
});

const startCallFrom = (spy: unknown[]) => spy.find((s) => (s as { m: string }).m === 'session.call'
  && (s as { p: { method: string } }).p?.method === 'start') as {
    p: { args: [{ mcpServers: Array<{ id: string; url?: string; headers?: Record<string, string> }> }] };
  };

describe('RemoteAdapterProxy', () => {
  it('defines steer only when hello lists it', () => {
    const withSteer = setup(['steer']);
    expect(typeof withSteer.proxy.steer).toBe('function');
    const without = setup([]);
    expect(without.proxy.steer).toBeUndefined();
  });

  it('populates oneShotModes from hello and omits them when absent', () => {
    const withModes = setup(['oneShot']);
    const root = withModes.root;
    const hello = helloFor(root, ['oneShot'], { oneShotModes: ['none', 'read_only'] });
    const link = linkFromPeer('host-1', withModes.hubPeer, hello);
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
    });
    expect(proxy.oneShotModes).toEqual(['none', 'read_only']);
    const without = setup([]);
    expect(without.proxy.oneShotModes).toBeUndefined();
  });

  it('oneShot RPC timeout is timeoutSecs plus 15s', async () => {
    const { proxy, hubPeer } = setup(['oneShot']);
    const orig = hubPeer.request.bind(hubPeer);
    const spy: Array<{ m: string; p: unknown; t?: number }> = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p, t });
      if (m === 'adapter.call') return { text: 'ok' };
      return orig(m, p, t);
    }) as typeof hubPeer.request;
    await proxy.oneShot!('p', { timeoutSecs: 120 });
    expect(spy).toContainEqual({
      m: 'adapter.call',
      p: { agentType: 'claude-code', method: 'oneShot', args: ['p', { timeoutSecs: 120 }] },
      t: 135_000,
    });
    // Mode read_only defaults to 120s floor when timeoutSecs is omitted (M1)
    await proxy.oneShot!('p', { mode: 'read_only' });
    expect(spy).toContainEqual({
      m: 'adapter.call',
      p: { agentType: 'claude-code', method: 'oneShot', args: ['p', { mode: 'read_only' }] },
      t: 135_000,
    });
  });

  it('start→sendPrompt streams identical events to direct FakeAdapter', async () => {
    const script = [msg('a'), msg('b')];
    const direct = new FakeAdapter();
    direct.script = script;
    const directEvents = collectEvents(direct);
    await direct.start(cfg('/tmp'));
    await direct.sendPrompt('go');
    await until(() => directEvents.length === 2);

    const { proxy, created, root } = setup();
    const proxyEvents = collectEvents(proxy);
    await proxy.start(cfg(root));
    created[0]!.script = script;
    await proxy.sendPrompt('go');
    await until(() => proxyEvents.length === 2);
    expect(proxyEvents).toEqual(directEvents);
  });

  it('strips getNextSteer and tempPath from wire', async () => {
    const { proxy, root, hubPeer } = setup(['steer']);
    const orig = hubPeer.request.bind(hubPeer);
    const spy: unknown[] = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p });
      return orig(m, p, t);
    }) as typeof hubPeer.request;

    await proxy.start(cfg(root, { getNextSteer: async () => ({ text: 'x' }) }));
    await proxy.sendPrompt('hi', [{ mediaType: 'text/plain', base64: 'aGVsbG8=', tempPath: '/tmp/keep-me' }]);
    const startCall = spy.find((s) => (s as { m: string }).m === 'session.call'
      && (s as { p: { method: string } }).p?.method === 'start') as { p: { args: [Record<string, unknown>] } };
    expect(startCall.p.args[0].getNextSteer).toBeUndefined();
    expect(startCall.p.args[0].hasSteerSource).toBe(true);
    const promptCall = spy.find((s) => (s as { m: string }).m === 'session.call'
      && (s as { p: { method: string } }).p?.method === 'sendPrompt') as { p: { args: [string, Attachment[]] } };
    expect(promptCall.p.args[1][0]!.tempPath).toBeUndefined();
  });

  it('drops secret MCP servers when allowMcpSecrets=false', async () => {
    const { root, created, hubPeer } = setup();
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, []));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: false,
    });
    const orig = hubPeer.request.bind(hubPeer);
    const spy: unknown[] = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p });
      return orig(m, p, t);
    }) as typeof hubPeer.request;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await proxy.start(cfg(root, {
      mcpServers: [
        {
          id: 'secret-one',
          transport: 'stdio',
          args: [],
          env: { KEY: 'val' },
          headers: {},
          secretEnvKeys: ['KEY'],
          secretHeaderKeys: [],
        },
        {
          id: 'safe',
          transport: 'stdio',
          args: [],
          env: {},
          headers: {},
          secretEnvKeys: [],
          secretHeaderKeys: [],
        },
      ],
    }));
    const startCall = spy.find((s) => (s as { m: string }).m === 'session.call'
      && (s as { p: { method: string } }).p?.method === 'start') as { p: { args: [{ mcpServers: Array<{ id: string }> }] } };
    expect(startCall.p.args[0].mcpServers.map((s) => s.id)).toEqual(['safe']);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('secret-one'))).toBe(true);
    warn.mockRestore();
    expect(created.length).toBeGreaterThan(0);
  });

  it('refuses grok-bot', () => {
    const { link } = setup();
    expect(() => new RemoteAdapterProxy(link, 'grok-bot', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
    })).toThrow(RpcError);
    try {
      new RemoteAdapterProxy(link, 'grok-bot', { interactionMode: 'bypass', allowMcpSecrets: true });
    } catch (e) {
      expect((e as RpcError).code).toBe('agent_not_allowed');
    }
  });

  it('listModels resolves [] when link disconnected', async () => {
    const { proxy, hubPeer } = setup();
    hubPeer.close();
    await expect(proxy.listModels()).resolves.toEqual([]);
  });

  it('stop() reaches FakeAdapter.stop', async () => {
    const { proxy, created, root } = setup();
    await proxy.start(cfg(root));
    await proxy.stop();
    expect(created[0]!.stopped).toBe(true);
  });

  it('setMcpServersLive and mcpStatus return the node results', async () => {
    const { proxy, root } = setup(['setMcpServersLive', 'mcpStatus']);
    await proxy.start(cfg(root));
    await expect(proxy.setMcpServersLive!([])).resolves.toBe(true);
    await expect(proxy.mcpStatus!()).resolves.toEqual([
      { name: 'n', status: 'connected', source: 'tierwyn' },
    ]);
  });

  it('drops secret MCP servers on setMcpServersLive when allowMcpSecrets=false', async () => {
    const { root, hubPeer } = setup(['setMcpServersLive']);
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, ['setMcpServersLive']));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: false,
    });
    await proxy.start(cfg(root));
    const orig = hubPeer.request.bind(hubPeer);
    const spy: unknown[] = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p });
      return orig(m, p, t);
    }) as typeof hubPeer.request;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await proxy.setMcpServersLive!([
      {
        id: 'secret-one',
        transport: 'stdio',
        args: [],
        env: { KEY: 'val' },
        headers: {},
        secretEnvKeys: ['KEY'],
        secretHeaderKeys: [],
      } as never,
      {
        id: 'safe',
        transport: 'stdio',
        args: [],
        env: {},
        headers: {},
        secretEnvKeys: [],
        secretHeaderKeys: [],
      } as never,
    ]);
    warn.mockRestore();
    const liveCall = spy.find((s) => (s as { m: string }).m === 'session.call'
      && (s as { p: { method: string } }).p?.method === 'setMcpServersLive') as {
        p: { args: [Array<{ id: string }>] };
      };
    expect(liveCall.p.args[0].map((s) => s.id)).toEqual(['safe']);
  });

  it('bridges hub-placed servers past allowMcpSecrets=false; agent secrets still dropped', async () => {
    const { root, created, hubPeer } = setup();
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, []));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: false,
    });
    const orig = hubPeer.request.bind(hubPeer);
    const spy: unknown[] = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p });
      return orig(m, p, t);
    }) as typeof hubPeer.request;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await proxy.start(cfg(root, {
      mcpServers: [
        bridgeServer(),
        {
          id: 'agent-secret',
          transport: 'stdio',
          args: [],
          env: { KEY: 'val' },
          headers: {},
          secretEnvKeys: ['KEY'],
          secretHeaderKeys: [],
        },
      ],
    }));
    warn.mockRestore();
    const servers = startCallFrom(spy).p.args[0].mcpServers;
    expect(servers.map((s) => s.id)).toEqual(['hub-one']);
    expect(servers[0]!.url).toBe('http://127.0.0.1:8788/agent/mcp/hub-one');
    expect(servers[0]!.headers![BRIDGE_HEADER]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(servers)).not.toContain('hub.internal');
    expect(JSON.stringify(servers)).not.toContain('Bearer sk-1');
    expect(created.length).toBeGreaterThan(0);
  });

  it('end frame revokes the bridge key for the session', async () => {
    const { proxy, created, root, hubPeer } = setup();
    const orig = hubPeer.request.bind(hubPeer);
    const spy: unknown[] = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p });
      return orig(m, p, t);
    }) as typeof hubPeer.request;
    await proxy.start(cfg(root, { mcpServers: [bridgeServer()] }));
    const key = startCallFrom(spy).p.args[0].mcpServers[0]!.headers![BRIDGE_HEADER];
    expect(lookupBridgeKey(key)).toBeDefined();
    created[0]!.emitter.emit('end');
    await until(() => lookupBridgeKey(key) === undefined, 'bridge key not revoked on end');
  });

  it('setSteerSource is registered before session.call start', async () => {
    const { proxy, root, link } = setup();
    const order: string[] = [];
    const origSet = link.setSteerSource.bind(link);
    link.setSteerSource = (sid, fn) => {
      order.push('steer');
      origSet(sid, fn);
    };
    const origReq = link.request.bind(link);
    link.request = async (m, p, t) => {
      if (m === 'session.call' && (p as { method?: string } | undefined)?.method === 'start') {
        order.push('start');
      }
      return origReq(m, p, t);
    };
    await proxy.start(cfg(root, { getNextSteer: async () => ({ text: 'x' }) }));
    expect(order.indexOf('steer')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('start')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('steer')).toBeLessThan(order.indexOf('start'));
  });

  it('clears the steer source on end', async () => {
    const { proxy, created, root, link } = setup();
    const calls: Array<unknown> = [];
    const origSet = link.setSteerSource.bind(link);
    link.setSteerSource = (sid, fn) => {
      calls.push(fn);
      origSet(sid, fn);
    };
    await proxy.start(cfg(root, { getNextSteer: async () => ({ text: 'x' }) }));
    const events: NormalisedEvent[] = [];
    proxy.streamEvents().on('event', (e: NormalisedEvent) => events.push(e));
    proxy.streamEvents().on('end', () => { /* */ });
    created[0]!.script = [msg('a')];
    await proxy.sendPrompt('go');
    await until(() => events.length >= 1);
    await until(() => calls.some((c) => c === undefined), 'steer source not cleared');
  });

  it('unsubscribes if session.create fails', async () => {
    const { proxy, root, link } = setup();
    let unsub = 0;
    const origSub = link.subscribe.bind(link);
    link.subscribe = (sid, l) => {
      const u = origSub(sid, l);
      return () => { unsub += 1; u(); };
    };
    const origReq = link.request.bind(link);
    link.request = async (m, p, t) => {
      if (m === 'session.create') throw new RpcError('max_sessions', 'max');
      return origReq(m, p, t);
    };
    await expect(proxy.start(cfg(root))).rejects.toMatchObject({ code: 'max_sessions' });
    expect(unsub).toBe(1);
  });

  it('trims trailing undefined session-call args', async () => {
    const { proxy, root, hubPeer } = setup(['runCommand']);
    await proxy.start(cfg(root));
    const orig = hubPeer.request.bind(hubPeer);
    const spy: unknown[] = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p });
      return orig(m, p, t);
    }) as typeof hubPeer.request;
    await proxy.runCommand!('foo', undefined);
    const call = spy.find((s) => (s as { m: string }).m === 'session.call'
      && (s as { p: { method: string } }).p?.method === 'runCommand') as { p: { args: unknown[] } };
    expect(call.p.args).toEqual(['foo']);
  });

  it('interruptTurn and respondToInteraction do not unhandledReject when the link is down', async () => {
    const { proxy, hubPeer, link } = setup(['interruptTurn', 'respondToInteraction']);
    hubPeer.close();
    await until(() => !link.connected(), 'link still up');
    const rejections: unknown[] = [];
    const onUR = (reason: unknown) => { rejections.push(reason); };
    process.once('unhandledRejection', onUR);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      proxy.interruptTurn!();
      proxy.respondToInteraction!('r1', { selection: ['allow'] });
      await new Promise<void>((r) => setImmediate(r));
      await new Promise<void>((r) => setImmediate(r));
      expect(rejections).toEqual([]);
    } finally {
      warn.mockRestore();
      process.off('unhandledRejection', onUR);
    }
  });

  it('peer close emits end so leftover is not the only sink', async () => {
    const root = tmp();
    const [hubT, nodeT] = memoryPair();
    const hubPeer = new RpcPeer(hubT, {});
    const nodePeer = new RpcPeer(nodeT, {});
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, []));
    const got: Array<{ t: string; sid?: string }> = [];
    link.subscribe('s1', (f) => got.push(f));
    let resolveSteer!: (v: { text: string }) => void;
    const steerWork = new Promise<{ text: string }>((r) => { resolveSteer = r; });
    let calls = 0;
    link.setSteerSource('s1', async () => {
      calls += 1;
      if (calls === 1) return steerWork;
      return { text: 'redispatched' };
    });
    const parked = nodePeer.request('steer.next', { sid: 's1' }, 0);
    void parked.catch(() => {});
    await until(() => calls === 1, 'steer.next did not start');
    hubPeer.close();
    await until(() => got.some((f) => f.t === 'end' && f.sid === 's1'), 'no end on close');
    resolveSteer({ text: 'late' });
    await steerWork;
    await Promise.resolve();
    await expect(parked).rejects.toMatchObject({ code: 'disconnected' });
  });
  it('sendPrompt/runCommand park past the RPC default timeout (hold-open turn)', async () => {
    const root = tmp();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const a = new FakeAdapter();
    a.sendPrompt = async () => { await held; };
    a.runCommand = async () => { await held; };
    const runtime = new NodeRuntime({
      create: () => a,
      has: () => true,
      policy: { roots: [root], allowedAgents: ['claude-code'], maxSessions: 8 },
    });
    const [hubT, nodeT] = memoryPair();
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    const hubPeer = new RpcPeer(hubT, {}, { timeoutMs: 20 });
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, ['runCommand']));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', { interactionMode: 'bypass', allowMcpSecrets: true });
    await proxy.start(cfg(root));
    let done = 0;
    const sp = proxy.sendPrompt('go').then(() => { done += 1; });
    const rc = proxy.runCommand!('x').then(() => { done += 1; });
    await new Promise((r) => setTimeout(r, 60));
    expect(done).toBe(0);
    release();
    await Promise.all([sp, rc]);
    expect(done).toBe(2);
  });

  it('sendPrompt swallows host_disconnected (grace drives end)', async () => {
    const { proxy, root, hubPeer, created } = setup();
    await proxy.start(cfg(root));
    created[0]!.sendPrompt = () => new Promise<void>(() => {});
    const sp = proxy.sendPrompt('go');
    await new Promise((r) => setTimeout(r, 5));
    hubPeer.close();
    await expect(sp).resolves.toBeUndefined();
  });

  it('propagates nativeSessionId from node ctx frame and initial config', async () => {
    const root = tmp();
    const a = new FakeAdapter();
    const runtime = new NodeRuntime({
      create: () => a,
      has: () => true,
      policy: { roots: [root], allowedAgents: ['claude-code'], maxSessions: 8 },
    });
    const [hubT, nodeT] = memoryPair();
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    const hubPeer = new RpcPeer(hubT, {});
    const link = linkFromPeer('host-1', hubPeer, helloFor(root));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', { interactionMode: 'bypass', allowMcpSecrets: true });

    // When starting with nativeSessionId (resume turn)
    await proxy.start({ ...cfg(root), nativeSessionId: 'initial-native-id' });
    expect(proxy.nativeSessionId).toBe('initial-native-id');

    // When node emits an event and runtime observes adapter.nativeSessionId
    (a as unknown as { nativeSessionId: string }).nativeSessionId = 'updated-native-id';
    a.emitter.emit('event', { type: 'message', sessionId: 's1', ts: 1, seq: 1, payload: { chunk: 'hi' } });
    await until(() => proxy.nativeSessionId === 'updated-native-id', 'nativeSessionId did not propagate');
    expect(proxy.nativeSessionId).toBe('updated-native-id');
  });

  it('start requires node sandbox feature when sandbox is on', async () => {
    const { root, hubPeer } = setup();
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, ['steer']));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
      sandbox: true,
    });
    await expect(proxy.start(cfg(root))).rejects.toMatchObject({ code: 'node_update_required' });
  });

  it('start requires sandbox_paths when custom paths are set', async () => {
    const { root, hubPeer } = setup();
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, ['steer'], undefined, { features: ['sandbox'] }));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
      sandbox: true,
      sandboxPaths: [{ path: join(root, 'models'), mode: 'ro' }],
    });
    await expect(proxy.start(cfg(root))).rejects.toMatchObject({ code: 'node_update_required' });
  });

  it('start forwards sandboxPaths in session.create when the node advertises sandbox_paths', async () => {
    const root = tmp();
    const models = join(root, 'models');
    mkdirSync(models);
    const created: FakeAdapter[] = [];
    const runtime = new NodeRuntime({
      create(_type, o) {
        const a = new FakeAdapter();
        (a as FakeAdapter & { factoryOpts?: AdapterFactoryOpts }).factoryOpts = o;
        created.push(a);
        return a;
      },
      has: () => true,
      policy: {
        roots: [root],
        allowedAgents: ['claude-code'],
        maxSessions: 8,
        sandbox: 'allow',
        sandboxPaths: { allow: 'ro' },
      },
      sandboxAvailable: () => true,
      nativeHome: root,
    });
    const [hubT, nodeT] = memoryPair();
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    const hubPeer = new RpcPeer(hubT, {});
    const orig = hubPeer.request.bind(hubPeer);
    const spy: Array<{ m: string; p: unknown }> = [];
    hubPeer.request = (async (m: string, p?: unknown, t?: number) => {
      spy.push({ m, p });
      return orig(m, p, t);
    }) as typeof hubPeer.request;
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, ['steer'], undefined, {
      features: ['sandbox', 'sandbox_paths'],
      sandboxPaths: { allow: 'ro' },
    }));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
      sandbox: true,
      sandboxPaths: [{ path: models, mode: 'ro' }],
    });
    await proxy.start(cfg(root));
    const create = spy.find((s) => s.m === 'session.create') as { p: { factoryOpts: AdapterFactoryOpts } };
    expect(create.p.factoryOpts.sandboxPaths).toEqual([{ path: models, mode: 'ro' }]);
  });

  it('start without custom paths does not require sandbox_paths', async () => {
    const { root, hubPeer } = setup();
    const link = linkFromPeer('host-1', hubPeer, helloFor(root, ['steer'], undefined, { features: ['sandbox'] }));
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
      sandbox: true,
    });
    await expect(proxy.start(cfg(root))).resolves.toBeUndefined();
  });

  // agent env: the hub pushes vault values before the node spawns any child.
  it('runs prepareEnv before session.create', async () => {
    const { root, link } = setup();
    const order: string[] = [];
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
      prepareEnv: async () => { order.push('prepareEnv'); },
    });
    const origReq = link.request.bind(link);
    link.request = async (m, p, t) => {
      if (m === 'session.create') order.push('create');
      return origReq(m, p, t);
    };
    await proxy.start(cfg(root));
    expect(order).toEqual(['prepareEnv', 'create']);
  });

  it('a rejecting prepareEnv fails start without session.create or lingering subscriber', async () => {
    const { root, link } = setup();
    const proxy = new RemoteAdapterProxy(link, 'claude-code', {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
      prepareEnv: async () => { throw new Error('no vault'); },
    });
    let unsub = 0;
    const origSub = link.subscribe.bind(link);
    link.subscribe = (sid, l) => {
      const u = origSub(sid, l);
      return () => { unsub += 1; u(); };
    };
    const creates: unknown[] = [];
    const origReq = link.request.bind(link);
    link.request = async (m, p, t) => {
      if (m === 'session.create') creates.push(p);
      return origReq(m, p, t);
    };
    await expect(proxy.start(cfg(root))).rejects.toThrow('no vault');
    expect(creates).toEqual([]);
    expect(unsub).toBe(1);
  });
});
