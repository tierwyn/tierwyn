import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, symlinkSync,
  truncateSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import type { AddressInfo } from 'node:net';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { AgentAdapter, AgentsInstallResult, AgentsLoginEvent, Attachment, FilesReadResult, FilesWriteResult, NodeFrame, NodeHello, NormalisedEvent, ResolvedMcpServer, SessionConfig } from '@tierwyn/shared';
import { NODE_FILE_CHUNK_BYTES, NODE_FILE_MAX_BYTES, NODE_PROTOCOL } from '@tierwyn/shared';
import { AGENT_BINARIES, binaryOnPath } from '../discovery.js';

vi.mock('../discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery.js')>();
  return {
    ...actual,
    binaryOnPath: vi.fn((bin: string, exists?: (p: string) => boolean) => actual.binaryOnPath(bin, exists)),
  };
});
import { versionToken } from '../files/writePolicy.js';
import { memoryPair, RpcPeer, type RpcHandler } from './rpc.js';
import { startTunnelListener, type TunnelRequest } from './tunnel.js';
import { defaultSpawnLogin, NodeRuntime, preflightMcp } from './runtime.js';
import { AgentEnvStore } from './agentEnvStore.js';
import type { AdapterFactoryOpts } from '../registry.js';

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  vi.useRealTimers();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function msg(chunk: string, sessionId = 's1'): NormalisedEvent {
  return { type: 'message', sessionId, ts: 1, seq: 1, payload: { chunk } };
}

class FakeAdapter implements AgentAdapter {
  readonly emitter = new EventEmitter();
  readonly calls: unknown[][] = [];
  stopped = false;
  config?: SessionConfig;
  attachments?: Attachment[];
  script: NormalisedEvent[] = [msg('hello')];
  startError?: Error;
  getLiveContextWindowUsage?: () => { contextWindowPct?: number; contextWindowSize?: number };

  async start(config: SessionConfig): Promise<void> {
    this.config = config;
    this.calls.push(['start', config]);
    if (this.startError) throw this.startError;
  }
  async sendPrompt(
    text: string,
    attachments?: Attachment[],
    model?: string,
    effort?: unknown,
    options?: unknown,
  ): Promise<void> {
    this.attachments = attachments;
    this.calls.push(['sendPrompt', text, attachments, model, effort, options]);
    setTimeout(() => {
      for (const ev of this.script) this.emitter.emit('event', ev);
      this.emitter.emit('end');
    }, 0);
  }
  streamEvents(): EventEmitter { return this.emitter; }
  async stop(): Promise<void> { this.stopped = true; this.calls.push(['stop']); }
  async listSessions() { return []; }
  async loadSession() { /* noop */ }
  async listModels() { return []; }
  async oneShot(prompt: string, opts?: unknown) {
    this.calls.push(['oneShot', prompt, opts]);
    return { text: 'ok' };
  }
  async setMcpServersLive(servers: unknown[]) { this.calls.push(['setMcpServersLive', servers]); return true; }
  async mcpStatus() { return [{ name: 'n', status: 'connected' as const, source: 'tierwyn' as const }]; }
}

function harness(opts?: {
  allowedAgents?: string[];
  maxSessions?: number;
  graceMs?: number;
  bufferMax?: { events: number; bytes: number };
  root?: string;
  artifactsRoot?: string;
  adapters?: FakeAdapter[];
  hubHandlers?: Record<string, RpcHandler>;
  buildHello?: () => Promise<NodeHello>;
  runInstall?: (cmd: string) => Promise<AgentsInstallResult>;
  nativeHome?: string;
  repoRoot?: string;
  spawnUpdate?: (argv: string[]) => void;
  spawnLogin?: (argv: string[], agentType: string) => ChildProcess;
  emitLoginEvent?: (ev: AgentsLoginEvent) => void;
  allowSelfUpdate?: boolean;
  now?: () => number;
  agentEnv?: AgentEnvStore;
}) {
  const root = opts?.root ?? tmp('rh-rt-');
  const created: FakeAdapter[] = opts?.adapters ?? [];
  const runtime = new NodeRuntime({
    create(_type: string, _o?: AdapterFactoryOpts) {
      const a = new FakeAdapter();
      created.push(a);
      return a;
    },
    has: (type) => type !== 'missing',
    policy: {
      roots: [root],
      allowedAgents: opts?.allowedAgents ?? ['claude-code', 'codex'],
      maxSessions: opts?.maxSessions ?? 8,
      allowSelfUpdate: opts?.allowSelfUpdate ?? true,
    },
    graceMs: opts?.graceMs ?? 120_000,
    bufferMax: opts?.bufferMax,
    artifactsRoot: opts?.artifactsRoot,
    buildHello: opts?.buildHello,
    runInstall: opts?.runInstall,
    nativeHome: opts?.nativeHome,
    repoRoot: opts?.repoRoot,
    spawnUpdate: opts?.spawnUpdate,
    spawnLogin: opts?.spawnLogin,
    now: opts?.now,
    agentEnv: opts?.agentEnv,
  });
  if (opts?.emitLoginEvent) runtime.setLoginEmitter(opts.emitLoginEvent);
  const [hubT, nodeT] = memoryPair();
  const hub = new RpcPeer(hubT, {
    'steer.next': async () => ({ text: 'hi' }),
    ...opts?.hubHandlers,
  });
  const node = new RpcPeer(nodeT, runtime.handlers());
  runtime.attach(node);
  return { runtime, hub, node, root, created };
}

const baseConfig = (cwd: string, extra?: Record<string, unknown>): SessionConfig => ({
  sessionId: 's1',
  conversationId: 'c1',
  cwd,
  model: 'm',
  ...extra,
});

async function until(pred: () => boolean, msg = 'condition not met'): Promise<void> {
  await vi.waitFor(() => {
    if (!pred()) throw new Error(msg);
  });
}

describe('preflightMcp', () => {
  const stdio = (over: Partial<ResolvedMcpServer> = {}): ResolvedMcpServer => ({
    id: 's', transport: 'stdio', command: 'npx', args: [], env: {}, headers: {},
    secretEnvKeys: [], secretHeaderKeys: [], ...over,
  });

  it('missing binary → command_not_found_on_host; /bin/sh kept; http untouched', () => {
    const { kept, skipped } = preflightMcp([
      stdio({ id: 'gone', command: 'definitely-not-a-bin-xyz' }),
      stdio({ id: 'sh', command: '/bin/sh' }),
      { id: 'web', transport: 'http', args: [], url: 'http://127.0.0.1:1/mcp', env: {}, headers: {}, secretEnvKeys: [], secretHeaderKeys: [] },
    ], [tmp('rh-pf-')]);
    expect(skipped).toEqual([{ id: 'gone', reason: 'command_not_found_on_host' }]);
    expect(kept.map((s) => s.id)).toEqual(['sh', 'web']);
  });

  it('cwd outside roots → cwd_outside_roots', () => {
    const { kept, skipped } = preflightMcp([stdio({ id: 'c', cwd: '/etc' })], [tmp('rh-pf-')]);
    expect(skipped).toEqual([{ id: 'c', reason: 'cwd_outside_roots' }]);
    expect(kept).toEqual([]);
  });
});

describe('NodeRuntime', () => {
  it('preflight drops unfound stdio commands and reports mcpSkipped', async () => {
    const { hub, created, root } = harness();
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    const r = await hub.request('session.call', {
      sid: 's1', method: 'start',
      args: [baseConfig(root, {
        mcpServers: [{
          id: 'gone', transport: 'stdio', command: 'definitely-not-a-bin-xyz', args: [],
          env: {}, headers: {}, secretEnvKeys: [], secretHeaderKeys: [],
        }],
      })],
    }) as { mcpSkipped?: Array<{ id: string; reason: string }> };
    expect(r?.mcpSkipped?.[0]).toMatchObject({ id: 'gone', reason: 'command_not_found_on_host' });
    expect(created[0]!.config!.mcpServers ?? []).toHaveLength(0);
  });

  it('refuses agent not in allowedAgents', async () => {
    const { hub } = harness();
    await expect(hub.request('session.create', { sid: 's1', agentType: 'pi' }))
      .rejects.toMatchObject({ code: 'agent_not_allowed' });
  });

  it('refuses grok-bot', async () => {
    const { hub } = harness({ allowedAgents: ['grok-bot', 'claude-code'] });
    await expect(hub.request('session.create', { sid: 's1', agentType: 'grok-bot' }))
      .rejects.toMatchObject({ code: 'agent_not_allowed' });
  });

  it('refuses cwd outside roots', async () => {
    const { hub } = harness();
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await expect(hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig('/etc')],
    })).rejects.toMatchObject({ code: 'cwd_outside_roots' });
  });

  it('max_sessions enforced', async () => {
    const { hub } = harness({ maxSessions: 1 });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await expect(hub.request('session.create', { sid: 's2', agentType: 'claude-code' }))
      .rejects.toMatchObject({ code: 'max_sessions' });
  });

  it('streams ev with seq 1..n then end', async () => {
    const { hub, created, root } = harness();
    const frames: unknown[] = [];
    hub.on('frame', (f) => frames.push(f));
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    created[0]!.script = [msg('a'), msg('b')];
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    await hub.request('session.call', { sid: 's1', method: 'sendPrompt', args: ['go'] });
    await until(() => frames.some((f) => (f as { t: string }).t === 'end'));
    const typed = frames as Array<{ t: string; seq?: number }>;
    const evs = typed.filter((f) => f.t === 'ev' || f.t === 'end');
    expect(evs.map((f) => f.seq)).toEqual([1, 2, 3]);
    expect(evs.map((f) => f.t)).toEqual(['ev', 'ev', 'end']);
  });

  it('getNextSteer pulls via steer.next', async () => {
    const { hub, created, root } = harness();
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig(root, { hasSteerSource: true })],
    });
    const got = await created[0]!.config!.getNextSteer!();
    expect(got).toEqual({ text: 'hi' });
  });

  it('steer.next still delivers after 120s idle (no RPC timeout)', async () => {
    vi.useFakeTimers();
    let resolveSteer!: (v: { text: string }) => void;
    const { created, root, hub } = harness({
      hubHandlers: {
        'steer.next': () => new Promise<{ text: string }>((r) => { resolveSteer = r; }),
      },
    });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig(root, { hasSteerSource: true })],
    });
    const pending = created[0]!.config!.getNextSteer!();
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(settled).toBe(false);
    resolveSteer({ text: 'late' });
    await expect(pending).resolves.toEqual({ text: 'late' });
  });

  it('releases sessions on end so create can exceed maxSessions', async () => {
    const { hub, runtime, created, root } = harness({ maxSessions: 8 });
    for (let i = 0; i < 9; i++) {
      const sid = `s${i}`;
      await hub.request('session.create', { sid, agentType: 'claude-code' });
      await hub.request('session.call', {
        sid,
        method: 'start',
        args: [baseConfig(root)],
      });
      created[i]!.emitter.emit('end');
      await until(() => runtime.sessionIds().length === 0, `${sid} still live`);
    }
    expect(runtime.sessionIds()).toEqual([]);
  });

  it('releases the session when start throws', async () => {
    const { hub, runtime, created, root } = harness({ maxSessions: 1 });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    created[0]!.startError = new Error('start failed');
    await expect(hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig(root)],
    })).rejects.toMatchObject({ message: 'start failed' });
    await until(() => runtime.sessionIds().length === 0, 'session leaked after start throw');
    await hub.request('session.create', { sid: 's2', agentType: 'claude-code' });
    expect(runtime.sessionIds()).toEqual(['s2']);
  });

  it('releases the session after stop', async () => {
    const { hub, runtime, root } = harness({ maxSessions: 1 });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    await hub.request('session.call', { sid: 's1', method: 'stop', args: [] });
    expect(runtime.sessionIds()).toEqual([]);
    await hub.request('session.create', { sid: 's2', agentType: 'claude-code' });
    expect(runtime.sessionIds()).toEqual(['s2']);
  });

  it('redacts mcp secret values from outbound frames', async () => {
    const { hub, created, root } = harness();
    const frames: Array<{ t: string; ev?: NormalisedEvent }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    const secret = 's3cret-value';
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    created[0]!.script = [msg(`leak ${secret} end`)];
    await hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig(root, {
        mcpServers: [{
          id: 'fire',
          transport: 'stdio',
          args: [],
          env: { TOKEN: secret },
          headers: {},
          secretEnvKeys: ['TOKEN'],
          secretHeaderKeys: [],
        }],
      })],
    });
    await hub.request('session.call', { sid: 's1', method: 'sendPrompt', args: ['go'] });
    await until(() => frames.some((f) => f.t === 'end'));
    const encoded = JSON.stringify(frames);
    expect(encoded).not.toContain(secret);
    expect(encoded).toContain('[REDACTED]');
  });

  it('bridge key survives the tunnel frame redaction (C1); other frame strings stay redacted', async () => {
    const secret = 'tierwyn-bridge-key-0123456789abcdef';
    const captured: TunnelRequest[] = [];
    const { hub, node, root } = harness({
      hubHandlers: {
        http: async (p) => {
          captured.push(p as TunnelRequest);
          return {
            status: 200,
            headers: { 'content-type': 'application/json' },
            bodyB64: Buffer.from('{"jsonrpc":"2.0","id":1}').toString('base64'),
          };
        },
      },
    });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig(root, {
        mcpServers: [{
          id: 'web',
          transport: 'http',
          args: [],
          url: 'http://127.0.0.1:8788/agent/mcp/web',
          env: {},
          headers: { 'x-tierwyn-mcp-key': secret, 'x-tierwyn-mcp-key': secret },
          secretEnvKeys: [],
          secretHeaderKeys: ['x-tierwyn-mcp-key', 'x-tierwyn-mcp-key'],
        }],
      })],
    });
    const server = await startTunnelListener({ port: 0, peer: () => node });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/agent/mcp/web`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tierwyn-mcp-key': secret, 'x-tierwyn-mcp-key': secret, 'x-probe': secret },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { probe: secret } }),
      });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect(captured).toHaveLength(1);
      // The one place the key is meant to cross: intact.
      expect(captured[0]!.headers['x-tierwyn-mcp-key']).toBe(secret);
      // Every other copy of the secret in the frame is still redacted.
      expect(captured[0]!.headers['x-probe']).toBe('[REDACTED]');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('bridge key survives the streaming http.head redaction', async () => {
    const secret = 'tierwyn-bridge-key-0123456789abcdef';
    let seenHead: Record<string, string> | undefined;
    const { hub, node, root } = harness();
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig(root, {
        mcpServers: [{
          id: 'web',
          transport: 'http',
          args: [],
          url: 'http://127.0.0.1:8788/agent/mcp/web',
          env: {},
          headers: { 'x-tierwyn-mcp-key': secret, 'x-tierwyn-mcp-key': secret },
          secretEnvKeys: [],
          secretHeaderKeys: ['x-tierwyn-mcp-key', 'x-tierwyn-mcp-key'],
        }],
      })],
    });
    hub.on('frame', (f) => {
      const fr = f as NodeFrame;
      if (fr.t === 'http.head' && fr.method !== undefined) {
        seenHead = fr.headers;
        hub.send({ t: 'http.head', rid: fr.rid, status: 200, headers: { 'content-type': 'application/json' } });
        hub.send({ t: 'http.end', rid: fr.rid });
      }
    });
    const server = await startTunnelListener({ port: 0, peer: () => node, canStream: () => true });
    try {
      const port = (server.address() as AddressInfo).port;
      const res = await fetch(`http://127.0.0.1:${port}/agent/mcp/web`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-tierwyn-mcp-key': secret, 'x-tierwyn-mcp-key': secret, 'x-probe': secret },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { probe: secret } }),
      });
      expect(res.status).toBe(200);
      await res.arrayBuffer();
      expect(seenHead?.['x-tierwyn-mcp-key']).toBe(secret);
      expect(seenHead?.['x-probe']).toBe('[REDACTED]');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('materialises attachments without tempPath', async () => {
    const { hub, created, root } = harness();
    const frames: Array<{ t: string }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    await hub.request('session.call', {
      sid: 's1',
      method: 'sendPrompt',
      args: ['go', [{ mediaType: 'text/plain', base64: Buffer.from('hi').toString('base64') }]],
    });
    await until(() => Boolean(created[0]!.attachments?.[0]?.tempPath), 'tempPath');
    const path = created[0]!.attachments![0]!.tempPath!;
    expect(existsSync(path)).toBe(true);
    await until(() => frames.some((f) => f.t === 'end'));
    await until(() => !existsSync(path), 'temp unlinked');
  });

  it('resume replays seq > lastSeq', async () => {
    const { hub, created, root } = harness();
    const frames: Array<{ t: string; seq?: number }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    created[0]!.script = [msg('a'), msg('b')];
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    await hub.request('session.call', { sid: 's1', method: 'sendPrompt', args: ['go'] });
    await until(() => frames.some((f) => f.t === 'end'));
    frames.length = 0;
    const r = await hub.request<{ replayed: number }>('session.resume', { sid: 's1', lastSeq: 1 });
    expect(r.replayed).toBe(2);
    await until(() => frames.length >= 2);
    expect(frames.map((f) => f.seq)).toEqual([2, 3]);
  });

  it('resume reports gap when buffer trimmed', async () => {
    const { hub, created, root } = harness({ bufferMax: { events: 2, bytes: 8 * 1024 * 1024 } });
    const frames: Array<{ t: string }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    created[0]!.script = [msg('1'), msg('2'), msg('3'), msg('4'), msg('5')];
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    await hub.request('session.call', { sid: 's1', method: 'sendPrompt', args: ['go'] });
    await until(() => frames.some((f) => f.t === 'end'));
    await expect(hub.request('session.resume', { sid: 's1', lastSeq: 0 }))
      .rejects.toMatchObject({ code: 'gap' });
  });

  it('grace expiry stops adapter', async () => {
    vi.useFakeTimers();
    const { hub, runtime, created, root } = harness({ graceMs: 1000 });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    runtime.detach();
    await vi.advanceTimersByTimeAsync(1000);
    expect(created[0]!.stopped).toBe(true);
  });

  it('session.resume clears attach grace', async () => {
    vi.useFakeTimers();
    const { hub, runtime, created, root, node } = harness({ graceMs: 1000 });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    runtime.detach();
    runtime.attach(node);
    await hub.request('session.resume', { sid: 's1', lastSeq: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(created[0]!.stopped).toBe(false);
    expect(runtime.sessionIds()).toEqual(['s1']);
  });

  it('resume of tombstone keeps its drop timer', async () => {
    vi.useFakeTimers();
    const { hub, runtime, created, root, node } = harness({ graceMs: 10_000 });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    runtime.detach();
    created[0]!.emitter.emit('end');
    runtime.attach(node);
    await hub.request('session.resume', { sid: 's1', lastSeq: 0 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect((runtime as unknown as { tombstones: Map<string, unknown> }).tombstones.size).toBe(0);
  });

  it('attach without resume re-arms grace and drops the session', async () => {
    vi.useFakeTimers();
    const { hub, runtime, created, root, node } = harness({ graceMs: 1000, maxSessions: 1 });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    runtime.detach();
    runtime.attach(node);
    expect(runtime.sessionIds()).toEqual(['s1']);
    await vi.advanceTimersByTimeAsync(1000);
    expect(runtime.sessionIds()).toEqual([]);
    expect(created[0]!.stopped).toBe(true);
  });

  it('adapter.call rejects method not in list', async () => {
    const { hub } = harness();
    await expect(hub.request('adapter.call', { agentType: 'claude-code', method: 'start', args: [] }))
      .rejects.toMatchObject({ code: 'no_method' });
  });

  it('adapter.call oneShot rejects cwd outside roots and never invokes the adapter', async () => {
    const { hub, created } = harness();
    await expect(hub.request('adapter.call', {
      agentType: 'claude-code', method: 'oneShot', args: ['p', { cwd: '/etc' }],
    })).rejects.toMatchObject({ code: 'path_outside_roots' });
    expect(created[0]!.calls.some((c) => c[0] === 'oneShot')).toBe(false);
  });

  it('adapter.call oneShot rewrites cwd to the realpath inside roots', async () => {
    const { hub, created, root } = harness();
    const sub = join(root, 'proj');
    mkdirSync(sub);
    const link = join(root, 'link-to-proj');
    symlinkSync(sub, link);
    await hub.request('adapter.call', {
      agentType: 'claude-code', method: 'oneShot', args: ['p', { cwd: link, timeoutSecs: 30 }],
    });
    expect(created[0]!.calls).toContainEqual(['oneShot', 'p', { cwd: realpathSync(sub), timeoutSecs: 30 }]);
  });

  it('adapter.call oneShot with no cwd passes through', async () => {
    const { hub, created } = harness();
    await hub.request('adapter.call', {
      agentType: 'claude-code', method: 'oneShot', args: ['p', { timeoutSecs: 30 }],
    });
    expect(created[0]!.calls).toContainEqual(['oneShot', 'p', { timeoutSecs: 30 }]);
  });

  it('fs.mkdir creates a leaf under roots and refuses outside roots', async () => {
    const { hub, root } = harness();
    const leaf = join(root, 'sub-dir');
    const res = await hub.request('fs.mkdir', { path: leaf }) as { path: string; created: boolean };
    expect(res).toEqual({ path: realpathSync(leaf), created: true });
    expect(existsSync(leaf)).toBe(true);

    await expect(hub.request('fs.mkdir', { path: '/tmp/outside-mkdir' }))
      .rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('fs.move moves a directory under roots and refuses outside roots', async () => {
    const { hub, root } = harness();
    const from = join(root, 'move-src');
    mkdirSync(from);
    writeFileSync(join(from, 'data.txt'), 'hello');
    const to = join(root, 'move-dst');

    const res = await hub.request('fs.move', { from, to }) as { path: string; moved: boolean };
    expect(res).toEqual({ path: realpathSync(to), moved: true });
    expect(existsSync(join(to, 'data.txt'))).toBe(true);
    expect(existsSync(from)).toBe(false);

    const outside = tmpdir();
    const outsideSrc = join(outside, 'outside-src-' + Date.now());
    mkdirSync(outsideSrc);
    try {
      await expect(hub.request('fs.move', { from: outsideSrc, to }))
        .rejects.toMatchObject({ code: 'path_outside_roots' });
    } finally {
      try { rmSync(outsideSrc, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('redacts a secret introduced via setMcpServersLive in a later ev', async () => {
    const { hub, created, root } = harness();
    const frames: Array<{ t: string; ev?: NormalisedEvent }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    const secret = 'live-secret-value';
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    await hub.request('session.call', {
      sid: 's1',
      method: 'setMcpServersLive',
      args: [[{
        id: 'fire',
        transport: 'stdio',
        args: [],
        env: { TOKEN: secret },
        headers: {},
        secretEnvKeys: ['TOKEN'],
        secretHeaderKeys: [],
      }]],
    });
    created[0]!.script = [msg(`leak ${secret} end`)];
    await hub.request('session.call', { sid: 's1', method: 'sendPrompt', args: ['go'] });
    await until(() => frames.some((f) => f.t === 'end'));
    const encoded = JSON.stringify(frames);
    expect(encoded).not.toContain(secret);
    expect(encoded).toContain('[REDACTED]');
  });

  it('redacts a secret in a thrown start error on the res frame', async () => {
    const { hub, created, root } = harness();
    const secret = 'start-err-secret';
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    created[0]!.startError = new Error(`spawn failed ${secret}`);
    try {
      await hub.request('session.call', {
        sid: 's1',
        method: 'start',
        args: [baseConfig(root, {
          mcpServers: [{
            id: 'fire',
            transport: 'stdio',
            args: [],
            env: { TOKEN: secret },
            headers: {},
            secretEnvKeys: ['TOKEN'],
            secretHeaderKeys: [],
          }],
        })],
      });
      expect.unreachable('should throw');
    } catch (e) {
      const err = e as { message: string };
      expect(err.message).toContain('[REDACTED]');
      expect(err.message).not.toContain(secret);
    }
  });

  it('steer.next materialises hub tempPath onto a node-local file', async () => {
    const { hub, created, root } = harness({
      hubHandlers: {
        'steer.next': async () => ({
          text: 'hi',
          attachments: [{
            mediaType: 'text/plain',
            base64: Buffer.from('x').toString('base64'),
            tempPath: '/hub/only',
          }],
        }),
      },
    });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', {
      sid: 's1',
      method: 'start',
      args: [baseConfig(root, { hasSteerSource: true })],
    });
    const got = await created[0]!.config!.getNextSteer!();
    const path = got?.attachments?.[0]?.tempPath;
    expect(path).toBeDefined();
    expect(path).not.toBe('/hub/only');
    expect(existsSync(path!)).toBe(true);
  });

  it('attach pauses live send; resume replays then unpauses without duplicates', async () => {
    const { hub, runtime, created, root, node } = harness();
    const frames: Array<{ t: string; seq?: number }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    runtime.detach();
    created[0]!.emitter.emit('event', msg('a'));
    created[0]!.emitter.emit('event', msg('b'));
    frames.length = 0;
    runtime.attach(node);
    created[0]!.emitter.emit('event', msg('c'));
    expect(frames.filter((f) => f.t === 'ev')).toEqual([]);
    const r = await hub.request<{ replayed: number }>('session.resume', { sid: 's1', lastSeq: 0 });
    await until(() => frames.filter((f) => f.t === 'ev').length === 3);
    expect(r.replayed).toBe(3);
    expect(frames.filter((f) => f.t === 'ev').map((f) => f.seq)).toEqual([1, 2, 3]);
  });

  it('maps top-level null positional args to undefined', async () => {
    const { hub, created, root } = harness();
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    const frames: Array<{ t: string }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    await hub.request('session.call', {
      sid: 's1',
      method: 'sendPrompt',
      args: ['go', null, null, null, null],
    });
    await until(() => frames.some((f) => f.t === 'end'));
    const call = created[0]!.calls.find((c) => c[0] === 'sendPrompt') as unknown[];
    expect(call[2]).toBeUndefined();
    expect(call[3]).toBeUndefined();
    expect(call[4]).toBeUndefined();
    expect(call[5]).toBeUndefined();
  });
});

describe('NodeRuntime files.*', () => {
  it('files.list lists the root, hides .git, marks openable', async () => {
    const { hub, root } = harness();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'a.md'), 'x');
    const res = await hub.request<{ status: number; body: {
      path: string;
      entries: Array<{ name: string; kind: string; openable?: boolean }>;
    } }>('files.list', { root });
    expect(res.status).toBe(200);
    expect(res.body.path).toBe('');
    const names = res.body.entries.map((e) => e.name);
    expect(names).not.toContain('.git');
    expect(names).toContain('a.md');
    expect(res.body.entries.find((e) => e.name === 'a.md')?.openable).toBe(true);
  });

  it('files.list refuses roots outside policy roots', async () => {
    const { hub } = harness();
    await expect(hub.request('files.list', { root: '/etc' }))
      .rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('files.list returns 404 when an advertised root is missing', async () => {
    const missing = join(tmp('rh-missing-'), 'nope'); // parent exists; leaf does not
    const runtime = new NodeRuntime({
      create: () => new FakeAdapter(),
      has: () => true,
      policy: { roots: [missing], allowedAgents: ['claude-code'], maxSessions: 8 },
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    const node = new RpcPeer(nodeT, runtime.handlers());
    runtime.attach(node);
    const res = await hub.request<{ status: number; body: { error: string } }>(
      'files.list', { root: missing },
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('root not found');
  });

  it('files.list forwards 403 for ../ escapes', async () => {
    const { hub, root } = harness();
    const res = await hub.request<{ status: number; body: { error: string } }>(
      'files.list', { root, path: '../' },
    );
    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('error');
  });

  it('files.read metadata only', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, 'a.md'), 'hello');
    const res = await hub.request<FilesReadResult>('files.read', { root, path: 'a.md' });
    expect(res.path).toBe(realpathSync(join(root, 'a.md')));
    expect(res.size).toBe(5);
    expect(typeof res.mtimeMs).toBe('number');
    expect(res.data).toBe('');
  });

  it('files.read chunk', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, 'a.md'), 'hello');
    const res = await hub.request<FilesReadResult>('files.read', {
      root, path: 'a.md', offset: 1, length: 3,
    });
    expect(Buffer.from(res.data, 'base64').toString('utf8')).toBe('ell');
  });

  it('files.read absolute path inside roots', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, 'a.md'), 'hello');
    const res = await hub.request<FilesReadResult>('files.read', {
      root, path: join(root, 'a.md'), offset: 0, length: 5,
    });
    expect(Buffer.from(res.data, 'base64').toString('utf8')).toBe('hello');
  });

  it('files.read symlink pointing outside roots', async () => {
    const { hub, root } = harness();
    symlinkSync('/etc/hostname', join(root, 'evil.txt'));
    await expect(hub.request('files.read', { root, path: 'evil.txt' }))
      .rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('files.read ../ traversal to an existing sibling', async () => {
    const { hub, root } = harness();
    const sib = tmp('rh-rt-');
    writeFileSync(join(sib, 'x.md'), 'x');
    await expect(hub.request('files.read', {
      root, path: join('..', basename(sib), 'x.md'),
    })).rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('files.read secret and non-openable rejections', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, '.env'), 'SECRET=1');
    writeFileSync(join(root, 'blob.bin'), 'x');
    await expect(hub.request('files.read', { root, path: '.env' }))
      .rejects.toMatchObject({ code: 'path_not_allowed' });
    await expect(hub.request('files.read', { root, path: 'blob.bin' }))
      .rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it('files.read symlink to a secret inside the root', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, '.env'), 'SECRET=1');
    symlinkSync(join(root, '.env'), join(root, 'notes.md'));
    await expect(hub.request('files.read', { root, path: 'notes.md' }))
      .rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it('files.read artifact shards skip the extension gate but not secrets', async () => {
    const artifactsRoot = tmp('rh-art-');
    const { hub, root } = harness({ artifactsRoot });
    const bytes = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    mkdirSync(join(artifactsRoot, 'c1'), { recursive: true });
    writeFileSync(join(artifactsRoot, 'c1', 'out.bin'), bytes);
    writeFileSync(join(artifactsRoot, 'c1', '.env'), 'SECRET=1');
    const res = await hub.request<FilesReadResult>('files.read', {
      root, path: join(artifactsRoot, 'c1', 'out.bin'), offset: 0, length: 4,
    });
    expect(Buffer.from(res.data, 'base64').equals(bytes)).toBe(true);
    await expect(hub.request('files.read', {
      root, path: join(artifactsRoot, 'c1', '.env'),
    })).rejects.toMatchObject({ code: 'path_not_allowed' });
  });

  it('files.read directory → not_found', async () => {
    const { hub, root } = harness();
    const res = hub.request('files.read', { root, path: '.', offset: 0, length: 10 });
    await expect(res).rejects.toMatchObject({ code: 'not_found' });
  });

  it('files.read FIFO → not_found, open does not block', async () => {
    const { hub, root } = harness();
    try {
      execFileSync('mkfifo', [join(root, 'pipe.fifo')]);
    } catch {
      return; // platform without mkfifo
    }
    await expect(hub.request('files.read', { root, path: 'pipe.fifo', offset: 0, length: 10 }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('files.read chunk cap and bad offset', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, 'a.md'), 'hello');
    await expect(hub.request('files.read', {
      root, path: 'a.md', offset: 0, length: NODE_FILE_CHUNK_BYTES + 1,
    })).rejects.toMatchObject({ code: 'bad_path' });
    await expect(hub.request('files.read', {
      root, path: 'a.md', offset: 6, length: 1,
    })).rejects.toMatchObject({ code: 'bad_path' });
  });

  it('files.read zero-byte file: no data calls', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, 'empty.md'), '');
    const meta = await hub.request<FilesReadResult>('files.read', { root, path: 'empty.md' });
    expect(meta.size).toBe(0);
    expect(meta.data).toBe('');
    const sliced = await hub.request<FilesReadResult>('files.read', {
      root, path: 'empty.md', offset: 0, length: 10,
    });
    expect(sliced.data).toBe('');
  });

  it('files.read too_large', async () => {
    const { hub, root } = harness();
    const big = join(root, 'big.md');
    writeFileSync(big, 'x');
    truncateSync(big, NODE_FILE_MAX_BYTES + 1);
    await expect(hub.request('files.read', { root, path: 'big.md' }))
      .rejects.toMatchObject({ code: 'too_large' });
  });

  it('files.write saves and returns the new version token', async () => {
    const { hub, root } = harness();
    const p = join(root, 'a.md');
    writeFileSync(p, 'v1');
    const before = versionToken(statSync(p));
    const res = await hub.request<FilesWriteResult>('files.write', {
      root, path: 'a.md', content: 'v2\n', version: before,
    });
    expect(res).toMatchObject({ ok: true });
    if (res.ok) {
      expect(res.path).toBe(realpathSync(p));
      expect(res.version).toBe(versionToken(statSync(p)));
      expect(res.version).not.toBe(before);
    }
    expect(readFileSync(p, 'utf8')).toBe('v2\n');
  });

  it('files.write conflict on stale version leaves the file untouched', async () => {
    const { hub, root } = harness();
    const p = join(root, 'a.md');
    writeFileSync(p, 'v1');
    const res = await hub.request<FilesWriteResult>('files.write', {
      root, path: 'a.md', content: 'v2\n', version: '1-1',
    });
    expect(res).toMatchObject({ ok: false, code: 'conflict', currentVersion: versionToken(statSync(p)) });
    expect(readFileSync(p, 'utf8')).toBe('v1');
  });

  it('files.write refuses .git paths, dotfiles, and secret paths', async () => {
    const { hub, root } = harness();
    const v = versionToken(statSync(root));
    await expect(hub.request('files.write', { root, path: '.git/config', content: 'x', version: v }))
      .rejects.toMatchObject({ code: 'not_allowed' });
    await expect(hub.request('files.write', { root, path: '.env', content: 'x', version: v }))
      .rejects.toMatchObject({ code: 'not_allowed' });
    writeFileSync(join(root, 'secrets.md'), 'x');
    await expect(hub.request('files.write', { root, path: 'secrets.md', content: 'x', version: v }))
      .rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('files.write refuses non-openable extensions', async () => {
    const { hub, root } = harness();
    writeFileSync(join(root, 'blob.bin'), 'x');
    const v = versionToken(statSync(join(root, 'blob.bin')));
    await expect(hub.request('files.write', { root, path: 'blob.bin', content: 'x', version: v }))
      .rejects.toMatchObject({ code: 'not_allowed' });
  });

  it('files.write refuses a symlink pointing outside the roots', async () => {
    const { hub, root } = harness();
    const outside = tmp('rh-write-outside-');
    const target = join(outside, 'victim.md');
    writeFileSync(target, 'victim');
    symlinkSync(target, join(root, 'evil.md'));
    const v = versionToken(statSync(target));
    await expect(hub.request('files.write', { root, path: 'evil.md', content: 'x', version: v }))
      .rejects.toMatchObject({ code: 'not_allowed' });
    expect(readFileSync(target, 'utf8')).toBe('victim');
  });

  it('files.write preserves the file mode', async () => {
    const { hub, root } = harness();
    const p = join(root, 'script.md');
    writeFileSync(p, 'v1');
    chmodSync(p, 0o640);
    const v = versionToken(statSync(p));
    await hub.request('files.write', { root, path: 'script.md', content: 'v2', version: v });
    expect(statSync(p).mode & 0o777).toBe(0o640);
  });

  it('files.write missing file → not_found', async () => {
    const { hub, root } = harness();
    await expect(hub.request('files.write', { root, path: 'nope.md', content: 'x', version: '1-1' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('NodeRuntime git.call', () => {
  it('git.call is wired through handlers()', async () => {
    const { runtime, root } = harness();
    execFileSync('git', ['init', '-b', 'main'], { cwd: root });
    const r = await runtime.handlers()['git.call']({ method: 'headRef', cwd: root });
    expect(r).toMatchObject({ ok: true });
  });
});

describe('NodeRuntime artifact.*', () => {
  it('artifact.write final returns a path under artifactsRoot and artifact.read returns the bytes', async () => {
    const artRoot = tmp('rh-art-');
    const { hub } = harness({ artifactsRoot: artRoot });
    const bytes = Buffer.from('artifact payload');
    const r = await hub.request<{ path: string }>('artifact.write', {
      conversationId: 'conv1',
      name: 'out.bin',
      uploadId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000',
      offset: 0,
      b64: bytes.toString('base64'),
      final: true,
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(r.path.startsWith(realpathSync(artRoot))).toBe(true);
    const back = await hub.request<{ data: string; size: number; sha256?: string }>('artifact.read', {
      conversationId: 'conv1',
      path: r.path,
      offset: 0,
    });
    expect(Buffer.from(back.data, 'base64').equals(bytes)).toBe(true);
    expect(back.size).toBe(bytes.length);
    expect(back.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
  });

  it('artifact.* without artifactsRoot → no_method', async () => {
    const { hub } = harness();
    await expect(hub.request('artifact.read', { conversationId: 'conv1', path: 'x' }))
      .rejects.toMatchObject({ code: 'no_method' });
  });
});

describe('node.hello', () => {
  const helloFixture = (over: Partial<NodeHello> = {}): NodeHello => ({
    protocol: NODE_PROTOCOL,
    gitSha: 'sha1',
    hostname: 'node-x',
    os: 'linux',
    arch: 'x64',
    homedir: '/home/n',
    roots: [],
    listenPort: 8788,
    agents: { 'claude-code': { installed: true, methods: [] } },
    models: {},
    sessions: [],
    ...over,
  });

  it('returns the built hello with live session ids injected', async () => {
    const { hub, runtime } = harness({ buildHello: async () => helloFixture() });
    const before = await hub.request<NodeHello>('node.hello');
    expect(before.sessions).toEqual([]);
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    const after = await hub.request<NodeHello>('node.hello');
    expect(after.sessions).toEqual(runtime.sessionIds());
    expect(after.sessions).toContain('s1');
  });

  it('no_method when buildHello is not wired (old runtime build)', async () => {
    const { hub } = harness();
    await expect(hub.request('node.hello')).rejects.toMatchObject({ code: 'no_method' });
  });
});

describe('agents.loginStatus', () => {
  it('returns a loggedIn map keyed by probed agent types', async () => {
    const { hub } = harness();
    const r = await hub.request<{ loggedIn: Record<string, boolean | undefined> }>('agents.loginStatus');
    expect(r.loggedIn).toEqual(expect.objectContaining({
      codex: expect.anything(),
      'claude-code': expect.anything(),
    }));
  });
});

describe('agents.install', () => {
  it('off-list agent → agent_not_allowed without running anything', async () => {
    const runInstall = vi.fn(async () => ({ code: 0, tail: '' }));
    const { hub } = harness({ allowedAgents: ['claude-code'], runInstall });
    await expect(hub.request('agents.install', { agentType: 'pi' }))
      .rejects.toMatchObject({ code: 'agent_not_allowed' });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('allowed but no install command → not_installable', async () => {
    const runInstall = vi.fn(async () => ({ code: 0, tail: '' }));
    const { hub } = harness({ allowedAgents: ['claude-code', 'custom-x'], runInstall });
    await expect(hub.request('agents.install', { agentType: 'custom-x' }))
      .rejects.toMatchObject({ code: 'not_installable' });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('live session of that type → agent_busy', async () => {
    const runInstall = vi.fn(async () => ({ code: 0, tail: '' }));
    const { hub } = harness({ runInstall });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await expect(hub.request('agents.install', { agentType: 'claude-code' }))
      .rejects.toMatchObject({ code: 'agent_busy' });
    expect(runInstall).not.toHaveBeenCalled();
  });

  it('concurrent install of the same type → busy', async () => {
    let release!: (r: AgentsInstallResult) => void;
    const gate = new Promise<AgentsInstallResult>((res) => { release = res; });
    const runInstall = vi.fn(() => gate);
    const { hub } = harness({ runInstall });
    const first = hub.request('agents.install', { agentType: 'claude-code' });
    await until(() => runInstall.mock.calls.length === 1);
    await expect(hub.request('agents.install', { agentType: 'claude-code' }))
      .rejects.toMatchObject({ code: 'busy' });
    release({ code: 0, tail: 'ok' });
    await expect(first).resolves.toMatchObject({ code: 0, tail: 'ok' });
  });

  it('happy path runs the fixed install command for the type', async () => {
    const runInstall = vi.fn(async () => ({ code: 0, tail: 'installed' }));
    const { hub } = harness({ runInstall });
    await expect(hub.request('agents.install', { agentType: 'claude-code' }))
      .resolves.toMatchObject({ code: 0, tail: 'installed' });
    expect(runInstall).toHaveBeenCalledWith(AGENT_BINARIES['claude-code']!.install);
  });

  it('forwards prereqs to runInstall when the agent defines them (kiro -> unzip)', async () => {
    const runInstall = vi.fn(async () => ({ code: 0, tail: 'installed' }));
    const { hub } = harness({
      runInstall,
      allowedAgents: ['kiro'],
    });
    await expect(hub.request('agents.install', { agentType: 'kiro' }))
      .resolves.toMatchObject({ code: 0, tail: 'installed' });
    expect(runInstall).toHaveBeenCalledWith(AGENT_BINARIES['kiro']!.install, { prereqs: ['unzip'] });
  });
});

describe('mcp.native.read/write', () => {
  const row = {
    id: 'mesh',
    transport: 'stdio' as const,
    command: 'meshd',
    args: ['-y'],
    env: [{ key: 'TOK', secret: false, value: 'plain-v' }],
    headers: [],
    enabled: true,
  };
  const noSecrets = { env: {}, headers: {} };

  it('read returns the node-side native view with secrets masked', async () => {
    const home = tmp('rh-native-home-');
    writeFileSync(join(home, '.claude.json'), JSON.stringify({
      mcpServers: { tok: { command: 'tokd', env: { API_TOKEN: 'sk-super-secret' } } },
    }));
    const { hub } = harness({ nativeHome: home });
    const view = await hub.request<{ entries: Array<{ name: string }> }>('mcp.native.read', { agentType: 'claude-code' });
    expect(view.entries.some((e) => e.name === 'tok')).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk-super-secret');
  });

  it('read with a root outside policy roots → path_outside_roots', async () => {
    const { hub } = harness();
    await expect(hub.request('mcp.native.read', { agentType: 'claude-code', root: '/etc' }))
      .rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('install (user scope) merges the entry into the node-side config', async () => {
    const home = tmp('rh-native-home-');
    const { hub } = harness({ nativeHome: home });
    const res = await hub.request<{ entry: { name: string } }>('mcp.native.write', {
      op: 'install', agentType: 'claude-code', scope: 'user', row, secretValues: noSecrets,
    });
    expect(res.entry.name).toBe('mesh');
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; env: Record<string, string> }>;
    };
    expect(cfg.mcpServers.mesh.command).toBe('meshd');
    expect(cfg.mcpServers.mesh.env.TOK).toBe('plain-v');
  });

  it('install with copySecrets writes the values the hub resolved (non-placeholder agent)', async () => {
    const home = tmp('rh-native-home-');
    const { hub } = harness({ nativeHome: home });
    await hub.request('mcp.native.write', {
      op: 'install', agentType: 'cursor', scope: 'user', copySecrets: true,
      row: { ...row, env: [{ key: 'PROBE_SECRET', secret: true, value: undefined }] },
      secretValues: { env: { PROBE_SECRET: 'sk-live-value' }, headers: {} },
    });
    const cfg = JSON.parse(readFileSync(join(home, '.cursor', 'mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(cfg.mcpServers.mesh.env.PROBE_SECRET).toBe('sk-live-value');
  });

  it('placeholder agents always write ${VAR}, never the secret value', async () => {
    const home = tmp('rh-native-home-');
    const { hub } = harness({ nativeHome: home });
    await hub.request('mcp.native.write', {
      op: 'install', agentType: 'claude-code', scope: 'user',
      row: { ...row, env: [{ key: 'PROBE_SECRET', secret: true, value: undefined }] },
      secretValues: { env: { PROBE_SECRET: 'sk-live-value' }, headers: {} },
    });
    const cfg = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, { env: Record<string, string> }>;
    };
    expect(cfg.mcpServers.mesh.env.PROBE_SECRET).toBe('${PROBE_SECRET}');
    expect(JSON.stringify(cfg)).not.toContain('sk-live-value');
  });

  it('install (project scope) writes under the policy-checked root', async () => {
    const root = tmp('rh-native-root-');
    const { hub } = harness({ root });
    await hub.request('mcp.native.write', {
      op: 'install', agentType: 'claude-code', scope: 'project', root, row, secretValues: noSecrets,
    });
    const cfg = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(cfg.mcpServers.mesh.command).toBe('meshd');
  });

  it('write with a project root outside policy roots → path_outside_roots', async () => {
    const { hub } = harness();
    await expect(hub.request('mcp.native.write', {
      op: 'install', agentType: 'claude-code', scope: 'project', root: '/etc', row, secretValues: noSecrets,
    })).rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('bad op / missing name → bad_request; node-side 404 → native_404', async () => {
    const { hub } = harness();
    await expect(hub.request('mcp.native.write', { op: 'rebalance', agentType: 'claude-code', scope: 'user' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(hub.request('mcp.native.write', { op: 'install', agentType: 'claude-code', scope: 'user' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await expect(hub.request('mcp.native.write', { op: 'remove', agentType: 'claude-code', scope: 'user', name: 'nope' }))
      .rejects.toMatchObject({ code: 'native_404' });
  });
});

describe('node.selfUpdate', () => {
  function gitCheckout(): string {
    const dir = tmp('rh-selfupdate-');
    mkdirSync(join(dir, '.git'));
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'install.sh'), '#!/bin/sh\n');
    return dir;
  }

  function packageRoot(): string {
    const dir = tmp('rh-selfupdate-pkg-');
    writeFileSync(join(dir, 'BUILD_ID'), 'f8b9ce65-1a2b3c4d');
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts', 'install.sh'), '#!/bin/sh\n');
    return dir;
  }

  const helloFixture = (over: Partial<NodeHello> = {}): NodeHello => ({
    protocol: NODE_PROTOCOL,
    gitSha: 'abc1234deadbeef',
    hostname: 'node-x',
    os: 'linux',
    arch: 'x64',
    homedir: '/home/n',
    roots: [],
    listenPort: 8788,
    agents: {},
    models: {},
    sessions: [],
    ...over,
  });

  it('selfUpdate spawns systemd-run with fixed argv', async () => {
    const repoRoot = gitCheckout();
    const spawned: string[][] = [];
    const now = 1_700_000_000_000;
    const { hub } = harness({
      repoRoot,
      now: () => now,
      spawnUpdate: (argv) => { spawned.push(argv); },
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).resolves.toEqual({
      started: true,
      fromSha: 'abc1234deadbeef',
    });
    expect(spawned).toEqual([[
      'systemd-run', '--user', '--collect', '--quiet',
      `--unit=tierwyn-node-update-${now}`,
      `--setenv=PATH=${process.env.PATH ?? ''}`,
      `--setenv=HOME=${process.env.HOME ?? ''}`,
      '--', 'bash', join(repoRoot, 'scripts/install.sh'), 'node', 'update',
    ]]);
  });

  it('selfUpdate refuses with live sessions', async () => {
    const spawnUpdate = vi.fn();
    const { hub } = harness({
      repoRoot: gitCheckout(),
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await expect(hub.request('node.selfUpdate')).rejects.toMatchObject({ code: 'sessions_live' });
    expect(spawnUpdate).not.toHaveBeenCalled();
  });

  it('selfUpdate refuses non-git checkout', async () => {
    const spawnUpdate = vi.fn();
    const { hub } = harness({
      repoRoot: tmp('rh-nogit-'),
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).rejects.toMatchObject({ code: 'not_git_checkout' });
    expect(spawnUpdate).not.toHaveBeenCalled();
  });

  it('selfUpdate accepts a BUILD_ID root with no .git', async () => {
    const repoRoot = packageRoot();
    const spawned: string[][] = [];
    const { hub } = harness({
      repoRoot,
      spawnUpdate: (argv) => { spawned.push(argv); },
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).resolves.toMatchObject({ started: true });
    expect(spawned[0]?.slice(-4)).toEqual(['bash', join(repoRoot, 'scripts/install.sh'), 'node', 'update']);
  });

  it('selfUpdate refuses when neither exists', async () => {
    const spawnUpdate = vi.fn();
    const { hub } = harness({
      repoRoot: tmp('rh-neither-'),
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).rejects.toMatchObject({ code: 'not_git_checkout' });
    expect(spawnUpdate).not.toHaveBeenCalled();
  });

  it('allowSelfUpdate false refuses a package root with disabled', async () => {
    const spawnUpdate = vi.fn();
    const { hub } = harness({
      repoRoot: packageRoot(),
      allowSelfUpdate: false,
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).rejects.toMatchObject({ code: 'disabled' });
    expect(spawnUpdate).not.toHaveBeenCalled();
  });

  it('selfUpdate disabled by allowSelfUpdate=false', async () => {
    const spawnUpdate = vi.fn();
    const { hub } = harness({
      repoRoot: gitCheckout(),
      allowSelfUpdate: false,
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).rejects.toMatchObject({ code: 'disabled' });
    expect(spawnUpdate).not.toHaveBeenCalled();
  });

  it('second call while running → busy', async () => {
    const spawnUpdate = vi.fn();
    const { hub } = harness({
      repoRoot: gitCheckout(),
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).resolves.toMatchObject({ started: true });
    await expect(hub.request('node.selfUpdate')).rejects.toMatchObject({ code: 'busy' });
    expect(spawnUpdate).toHaveBeenCalledTimes(1);
  });

  it('updating flag times out after 15 min', async () => {
    let now = 1_700_000_000_000;
    const spawnUpdate = vi.fn();
    const { hub } = harness({
      repoRoot: gitCheckout(),
      now: () => now,
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).resolves.toMatchObject({ started: true });
    await expect(hub.request('node.selfUpdate')).rejects.toMatchObject({ code: 'busy' });
    now += 15 * 60_000 + 1;
    await expect(hub.request('node.selfUpdate')).resolves.toMatchObject({ started: true });
    expect(spawnUpdate).toHaveBeenCalledTimes(2);
  });

  it('spawn failure clears updating so a later call is not busy', async () => {
    const spawnUpdate = vi.fn(() => { throw new Error('spawn failed'); });
    const { hub } = harness({
      repoRoot: gitCheckout(),
      spawnUpdate,
      buildHello: async () => helloFixture(),
    });
    await expect(hub.request('node.selfUpdate')).rejects.toThrow('spawn failed');
    await expect(hub.request('node.selfUpdate')).rejects.toThrow('spawn failed');
    expect(spawnUpdate).toHaveBeenCalledTimes(2);
  });
});

describe('NodeRuntime sandbox policy', () => {
  it('session.create rejects sandbox when node policy is off', async () => {
    const root = tmp('rh-sb-');
    const runtime = new NodeRuntime({
      create: () => new FakeAdapter(),
      has: () => true,
      policy: { roots: [root], allowedAgents: ['claude-code'], maxSessions: 8, sandbox: 'off' },
      sandboxAvailable: () => true,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await expect(hub.request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
      factoryOpts: { sandbox: true },
    })).rejects.toMatchObject({ code: 'sandbox_disabled_on_node' });
  });

  it('session.create forces sandbox when node policy is require', async () => {
    const captured: AdapterFactoryOpts[] = [];
    const root = tmp('rh-sb-req-');
    const runtime = new NodeRuntime({
      create(_type, o) {
        captured.push(o ?? {});
        return new FakeAdapter();
      },
      has: () => true,
      policy: { roots: [root], allowedAgents: ['claude-code'], maxSessions: 8, sandbox: 'require' },
      sandboxAvailable: () => true,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await hub.request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
      factoryOpts: { sandbox: false },
    });
    expect(captured[0]?.sandbox).toBe(true);
  });

  it('session.create rejects unsupported agent when sandbox is requested', async () => {
    const root = tmp('rh-sb2-');
    const runtime = new NodeRuntime({
      create: () => new FakeAdapter(),
      has: () => true,
      policy: { roots: [root], allowedAgents: ['no-such-agent'], maxSessions: 8, sandbox: 'allow' },
      sandboxAvailable: () => true,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await expect(hub.request('session.create', {
      sid: 's1',
      agentType: 'no-such-agent',
      factoryOpts: { sandbox: true },
    })).rejects.toMatchObject({ code: 'sandbox_unsupported_agent' });
  });

  it('session.create rejects rw custom paths when sandboxPaths.allow is ro', async () => {
    const captured: AdapterFactoryOpts[] = [];
    const root = tmp('rh-sp-ro-');
    mkdirSync(join(root, 'models'));
    const runtime = new NodeRuntime({
      create(_type, o) {
        captured.push(o ?? {});
        return new FakeAdapter();
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
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await expect(hub.request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [{ path: join(root, 'models'), mode: 'rw' }],
      },
    })).rejects.toMatchObject({ code: 'sandbox_path_denied' });
    expect(captured).toEqual([]);
  });

  it('session.create rejects rw custom paths outside node.json roots', async () => {
    const root = tmp('rh-sp-roots-');
    const outside = tmp('rh-sp-out-');
    mkdirSync(join(outside, 'cache'));
    const runtime = new NodeRuntime({
      create: () => new FakeAdapter(),
      has: () => true,
      policy: {
        roots: [root],
        allowedAgents: ['claude-code'],
        maxSessions: 8,
        sandbox: 'allow',
        sandboxPaths: { allow: 'rw' },
      },
      sandboxAvailable: () => true,
      nativeHome: root,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await expect(hub.request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [{ path: join(outside, 'cache'), mode: 'rw' }],
      },
    })).rejects.toMatchObject({ code: 'sandbox_path_denied' });
  });

  it('session.create rejects custom paths when sandboxPaths.allow is none', async () => {
    const root = tmp('rh-sp-none-');
    mkdirSync(join(root, 'models'));
    const runtime = new NodeRuntime({
      create: () => new FakeAdapter(),
      has: () => true,
      policy: {
        roots: [root],
        allowedAgents: ['claude-code'],
        maxSessions: 8,
        sandbox: 'allow',
        sandboxPaths: { allow: 'none' },
      },
      sandboxAvailable: () => true,
      nativeHome: root,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await expect(hub.request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [{ path: join(root, 'models'), mode: 'ro' }],
      },
    })).rejects.toMatchObject({ code: 'sandbox_paths_disabled_on_node' });
  });

  it('session.create re-validates hard-deny and passes surviving paths to the factory', async () => {
    const captured: AdapterFactoryOpts[] = [];
    const root = tmp('rh-sp-ok-');
    const models = join(root, 'models');
    mkdirSync(models);
    const runtime = new NodeRuntime({
      create(_type, o) {
        captured.push(o ?? {});
        return new FakeAdapter();
      },
      has: () => true,
      policy: {
        roots: [root],
        allowedAgents: ['claude-code'],
        maxSessions: 8,
        sandbox: 'allow',
        sandboxPaths: { allow: 'rw' },
      },
      sandboxAvailable: () => true,
      nativeHome: root,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await hub.request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [
          { path: models, mode: 'ro' },
          { path: join(root, '.ssh'), mode: 'ro' },
        ],
      },
    });
    expect(captured[0]?.sandbox).toBe(true);
    expect(captured[0]?.sandboxPaths).toEqual([{ path: models, mode: 'ro' }]);
  });

  it('session.create injects policy roots and node hard-deny into factory opts, ignoring hub values (F1/F2)', async () => {
    const captured: AdapterFactoryOpts[] = [];
    const root = tmp('rh-sp-inj-');
    const nodeDir = tmp('rh-node-dir-');
    const keyDir = tmp('rh-key-dir-');
    const keyPath = join(keyDir, 'key');
    writeFileSync(keyPath, 'x');
    const artifactsRoot = tmp('rh-art-deny-');
    mkdirSync(join(root, 'models'));
    const runtime = new NodeRuntime({
      create(_type, o) {
        captured.push(o ?? {});
        return new FakeAdapter();
      },
      has: () => true,
      policy: {
        roots: [root],
        allowedAgents: ['claude-code'],
        maxSessions: 8,
        sandbox: 'allow',
        sandboxPaths: { allow: 'rw' },
        keyPath,
      },
      nodeDir,
      artifactsRoot,
      sandboxAvailable: () => true,
      nativeHome: root,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await hub.request('session.create', {
      sid: 's1',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [{ path: join(root, 'models'), mode: 'ro' }],
        sandboxRoots: ['/evil'],
        sandboxDeny: ['/evil-deny'],
      },
    });
    expect(captured[0]?.sandboxRoots).toEqual([root]);
    expect(captured[0]?.sandboxDeny).toEqual(expect.arrayContaining([nodeDir, keyPath, keyDir, artifactsRoot]));
    expect(captured[0]?.sandboxDeny).not.toContain('/evil');
    expect(captured[0]?.sandboxDeny).not.toContain('/evil-deny');
  });

  it('session.create rejects required custom paths covering nodeDir, keyPath, or artifactsRoot (F2)', async () => {
    const root = tmp('rh-sp-sec-');
    const nodeDir = tmp('rh-nodedir-sec-');
    const keyDir = tmp('rh-keydir-sec-');
    const keyPath = join(keyDir, 'key');
    writeFileSync(keyPath, 'x');
    const artifactsRoot = tmp('rh-art-sec-');
    mkdirSync(join(artifactsRoot, 'c1'), { recursive: true });
    const runtime = new NodeRuntime({
      create: () => new FakeAdapter(),
      has: () => true,
      policy: {
        roots: [root, keyDir, artifactsRoot, nodeDir],
        allowedAgents: ['claude-code'],
        maxSessions: 8,
        sandbox: 'allow',
        sandboxPaths: { allow: 'rw' },
        keyPath,
      },
      nodeDir,
      artifactsRoot,
      sandboxAvailable: () => true,
      nativeHome: root,
    });
    const [hubT, nodeT] = memoryPair();
    const hub = new RpcPeer(hubT, {});
    runtime.attach(new RpcPeer(nodeT, runtime.handlers()));
    await expect(hub.request('session.create', {
      sid: 's-key',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [{ path: keyPath, mode: 'ro', optional: false }],
      },
    })).rejects.toMatchObject({ code: 'sandbox_path_denied' });
    await expect(hub.request('session.create', {
      sid: 's-dir',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [{ path: nodeDir, mode: 'ro', optional: false }],
      },
    })).rejects.toMatchObject({ code: 'sandbox_path_denied' });
    await expect(hub.request('session.create', {
      sid: 's-art',
      agentType: 'claude-code',
      factoryOpts: {
        sandbox: true,
        sandboxPaths: [{ path: join(artifactsRoot, 'c1'), mode: 'ro', optional: false }],
      },
    })).rejects.toMatchObject({ code: 'sandbox_path_denied' });
  });
});

describe('NodeRuntime schedule.packFiles', () => {
  it('write under a policy root creates the files', async () => {
    const { hub, root } = harness();
    const proj = join(root, 'proj');
    mkdirSync(proj);
    const r = await hub.request('schedule.packFiles', {
      op: 'write',
      root: proj,
      jobSlug: 'wave-1',
      files: [
        { kind: 'prompt', body: 'do it' },
        { kind: 'progress', body: 'p' },
      ],
    }) as { ok: true; written: string[] };
    expect(r.ok).toBe(true);
    expect(r.written.sort()).toEqual([
      '.tierwyn/schedule/wave-1-progress.md',
      '.tierwyn/schedule/wave-1-prompt.md',
    ].sort());
    expect(readFileSync(join(proj, '.tierwyn/schedule/wave-1-prompt.md'), 'utf8')).toBe('do it');
  });

  it('second write without overwrite → conflict', async () => {
    const { hub, root } = harness();
    const proj = join(root, 'proj');
    mkdirSync(proj);
    await hub.request('schedule.packFiles', {
      op: 'write', root: proj, jobSlug: 'wave-1',
      files: [{ kind: 'prompt', body: 'a' }],
    });
    const r = await hub.request('schedule.packFiles', {
      op: 'write', root: proj, jobSlug: 'wave-1',
      files: [{ kind: 'prompt', body: 'b' }],
    }) as { ok: false; code: string; conflicts: string[] };
    expect(r).toMatchObject({ ok: false, code: 'conflict' });
    expect(r.conflicts).toContain('.tierwyn/schedule/wave-1-prompt.md');
  });

  it('root outside policy roots → path_outside_roots', async () => {
    const { hub } = harness();
    await expect(hub.request('schedule.packFiles', {
      op: 'write',
      root: '/tmp/outside-tierwyn-pack',
      jobSlug: 'wave-1',
      files: [{ kind: 'prompt', body: 'x' }],
    })).rejects.toMatchObject({ code: 'path_outside_roots' });
  });

  it('bad slug → bad_path', async () => {
    const { hub, root } = harness();
    const proj = join(root, 'proj');
    mkdirSync(proj);
    await expect(hub.request('schedule.packFiles', {
      op: 'write',
      root: proj,
      jobSlug: '../escape',
      files: [{ kind: 'prompt', body: 'x' }],
    })).rejects.toMatchObject({ code: 'bad_path' });
  });

  it('unlink removes written files', async () => {
    const { hub, root } = harness();
    const proj = join(root, 'proj');
    mkdirSync(proj);
    await hub.request('schedule.packFiles', {
      op: 'write', root: proj, jobSlug: 'wave-1',
      files: [
        { kind: 'prompt', body: 'a' },
        { kind: 'roster', body: 'r' },
      ],
    });
    const r = await hub.request('schedule.packFiles', {
      op: 'unlink', root: proj, jobSlug: 'wave-1',
      files: [
        { kind: 'prompt', body: '' },
        { kind: 'roster', body: '' },
      ],
    }) as { ok: true; written: string[] };
    expect(r).toEqual({ ok: true, written: [] });
    expect(existsSync(join(proj, '.tierwyn/schedule/wave-1-prompt.md'))).toBe(false);
    expect(existsSync(join(proj, '.tierwyn/schedule/wave-1-roster.md'))).toBe(false);
  });
});

describe('agentEnv.sync', () => {
  it('agentEnv.sync redacts values from outgoing frames', async () => {
    const store = new AgentEnvStore(() => ['claude-code', 'codex']);
    const { hub, node } = harness({ agentEnv: store });
    const frames: unknown[] = [];
    hub.on('frame', (f) => frames.push(f));
    const secret = 'vault-secret-value-1';
    const leak = () => node.send({ t: 'ev', sid: 'x', seq: 1, ev: msg('leak ' + secret) });
    const check = async () => {
      // memoryPair delivers on a microtask — wait for the frame to land.
      await until(() => frames.length > 0, 'ev frame not delivered');
      const encoded = JSON.stringify(frames);
      expect(encoded).not.toContain(secret);
      expect(encoded).toContain('[REDACTED]');
      frames.length = 0;
    };
    await hub.request('agentEnv.sync', { vars: { 'claude-code': { K: secret } }, managedNames: ['K'] });
    leak();
    await check();
    // Rotation to empty: the retired value must stay redacted.
    await hub.request('agentEnv.sync', { vars: {}, managedNames: [] });
    leak();
    await check();
    // Same value re-synced: still redacted (held for life).
    await hub.request('agentEnv.sync', { vars: { 'claude-code': { K: secret } }, managedNames: ['K'] });
    leak();
    await check();
  });

  it('an MCP secret that prefixes an agent-env value leaves no suffix behind', async () => {
    // F11 ordering: every redaction pass must see the combined, longest-first
    // set. If sendOut redacted with per-session MCP secrets only, the prefix
    // would mangle the longer vault value and its suffix would leak past
    // peer.redact.
    const store = new AgentEnvStore(() => ['claude-code']);
    const { hub, created, root } = harness({ agentEnv: store });
    const frames: Array<{ t: string; ev?: NormalisedEvent }> = [];
    hub.on('frame', (f) => frames.push(f as never));
    const prefix = 'abcd1234';
    const long = `${prefix}-SUFFIX-STAYS-SECRET`;
    await hub.request('agentEnv.sync', { vars: { 'claude-code': { LONG: long } }, managedNames: ['LONG'] });
    await hub.request('session.create', { sid: 's1', agentType: 'claude-code' });
    await hub.request('session.call', { sid: 's1', method: 'start', args: [baseConfig(root)] });
    await hub.request('session.call', {
      sid: 's1',
      method: 'setMcpServersLive',
      args: [[{
        id: 'fire',
        transport: 'stdio',
        args: [],
        env: { TOKEN: prefix },
        headers: {},
        secretEnvKeys: ['TOKEN'],
        secretHeaderKeys: [],
      }]],
    });
    created[0]!.script = [msg(`leak ${long} plus bare ${prefix} end`)];
    await hub.request('session.call', { sid: 's1', method: 'sendPrompt', args: ['go'] });
    await until(() => frames.some((f) => f.t === 'end'));
    const encoded = JSON.stringify(frames);
    expect(encoded).not.toContain('SUFFIX-STAYS-SECRET');
    expect(encoded).not.toContain(long);
    expect(encoded).not.toContain(prefix);
    expect(encoded).toContain('[REDACTED]');
  });

  it('agentEnv.sync result carries no values', async () => {
    const store = new AgentEnvStore(() => ['claude-code']);
    const { hub } = harness({ agentEnv: store });
    await expect(hub.request('agentEnv.sync', {
      vars: { 'claude-code': { KEY: 'value-12345' } },
      managedNames: ['KEY'],
    })).resolves.toEqual({ ok: true, changed: true });
  });

  it('agentEnv.sync without a store answers no_method', async () => {
    const { hub } = harness();
    await expect(hub.request('agentEnv.sync', { vars: {} })).rejects.toMatchObject({ code: 'no_method' });
  });
});

function fakeLoginChild(): {
  child: ChildProcess;
  writeStdout(s: string): void;
  writeStderr(s: string): void;
  exit(code: number): void;
  killed: () => boolean;
  stdinChunks: string[];
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const stdinChunks: string[] = [];
  stdin.on('data', (c: Buffer | string) => {
    stdinChunks.push(typeof c === 'string' ? c : c.toString('utf8'));
  });
  const ee = new EventEmitter();
  let killed = false;
  const child = Object.assign(ee, {
    stdout,
    stderr,
    stdin,
    pid: 4242,
    get killed() { return killed; },
    kill(_sig?: NodeJS.Signals | number) {
      killed = true;
      queueMicrotask(() => ee.emit('close', null, 'SIGTERM'));
      return true;
    },
  }) as unknown as ChildProcess;
  return {
    child,
    writeStdout(s: string) { stdout.write(s); },
    writeStderr(s: string) { stderr.write(s); },
    exit(code: number) { queueMicrotask(() => ee.emit('close', code)); },
    killed: () => killed,
    stdinChunks,
  };
}

describe('agents.login', () => {
  beforeEach(() => {
    vi.mocked(binaryOnPath).mockReturnValue(true);
  });

  it('start with agentType pi → not_supported', async () => {
    const { hub } = harness();
    await expect(hub.request('agents.login', { agentType: 'pi', op: 'start' }))
      .rejects.toMatchObject({ code: 'not_supported' });
  });

  it('copilot start spawns login --device-code', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const { hub } = harness({ spawnLogin, allowedAgents: ['copilot'] });
    const started = await hub.request('agents.login', { agentType: 'copilot', op: 'start' });
    expect(started).toEqual({ started: true });
    expect(spawnLogin).toHaveBeenCalledWith(['login', '--device-code'], 'copilot');
    await hub.request('agents.login', { agentType: 'copilot', op: 'cancel' });
  });

  it('cancel SIGTERMs the login process group', async () => {
    const fake = fakeLoginChild();
    const seen: Array<[unknown, unknown]> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, sig) => {
      seen.push([pid, sig]);
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      const { hub } = harness({ spawnLogin: () => fake.child, allowedAgents: ['copilot'] });
      await hub.request('agents.login', { agentType: 'copilot', op: 'start' });
      await hub.request('agents.login', { agentType: 'copilot', op: 'cancel' });
      expect(seen).toContainEqual([-4242, 'SIGTERM']);
      expect(fake.killed()).toBe(true);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('grok-build start spawns login --device-auth', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const { hub } = harness({ spawnLogin, allowedAgents: ['grok-build'] });
    await hub.request('agents.login', { agentType: 'grok-build', op: 'start' });
    expect(spawnLogin).toHaveBeenCalledWith(['login', '--device-auth'], 'grok-build');
    await hub.request('agents.login', { agentType: 'grok-build', op: 'cancel' });
  });

  it('cursor start spawns login', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      const { hub } = harness({ spawnLogin, allowedAgents: ['cursor'] });
      await hub.request('agents.login', { agentType: 'cursor', op: 'start' });
      expect(spawnLogin).toHaveBeenCalledWith(['login'], 'cursor');
      await hub.request('agents.login', { agentType: 'cursor', op: 'cancel' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('cursor stdout URL emits authorize with no userCode', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const challenge = 'A'.repeat(43);
    const uuid = '00000000-0000-4000-8000-000000000000';
    const url = `https://cursor.com/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true`;
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
      allowedAgents: ['cursor'],
    });
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      const err = new Error('ESRCH') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    try {
      await hub.request('agents.login', { agentType: 'cursor', op: 'start' });
      fake.writeStdout(`Starting login process...\nOpen a browser and navigate to this link: ${url}\n`);
      await until(() => events.some((e) => e.phase === 'authorize'));
      expect(events.filter((e) => e.phase === 'authorize')).toHaveLength(1);
      expect(events[0]).toEqual({ agentType: 'cursor', phase: 'authorize', url });
      expect(events[0]).not.toHaveProperty('userCode');
      await hub.request('agents.login', { agentType: 'cursor', op: 'cancel' });
    } finally {
      killSpy.mockRestore();
    }
  });

  it('copilot stderr+stdout device blob emits one device event', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
      allowedAgents: ['copilot'],
    });
    await hub.request('agents.login', { agentType: 'copilot', op: 'start' });
    fake.writeStderr('To authenticate, visit https://github.com/login/device and enter code XXXX-XXXX\n');
    await until(() => events.some((e) => e.phase === 'device'));
    expect(events.filter((e) => e.phase === 'device')).toHaveLength(1);
    expect(events[0]).toMatchObject({
      agentType: 'copilot',
      phase: 'device',
      url: 'https://github.com/login/device',
      userCode: 'XXXX-XXXX',
    });
    await hub.request('agents.login', { agentType: 'copilot', op: 'cancel' });
  });

  it('copilot oauth authorize abort kills the child', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
      allowedAgents: ['copilot'],
    });
    await hub.request('agents.login', { agentType: 'copilot', op: 'start' });
    fake.writeStderr('https://github.com/login/oauth/authorize?client_id=x\n');
    await until(() => events.some((e) => e.phase === 'error'));
    expect(fake.killed()).toBe(true);
    expect(events.find((e) => e.phase === 'error')?.message).toMatch(/device-code/);
    expect(JSON.stringify(events)).not.toContain('XXXX-XXXX');
  });

  it('submit is rejected for copilot', async () => {
    const fake = fakeLoginChild();
    const { hub } = harness({ spawnLogin: () => fake.child, allowedAgents: ['copilot'] });
    await hub.request('agents.login', { agentType: 'copilot', op: 'start' });
    await expect(hub.request('agents.login', { agentType: 'copilot', op: 'submit', code: 'XXXX-XXXX' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    await hub.request('agents.login', { agentType: 'copilot', op: 'cancel' });
  });

  it('start spawns login --device-auth and returns started before exit', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const { hub } = harness({ spawnLogin });
    const started = await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    expect(started).toEqual({ started: true });
    expect(spawnLogin).toHaveBeenCalledWith(['login', '--device-auth'], 'codex');
    expect(fake.killed()).toBe(false);
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });
  });

  it('stderr device blob emits one device event', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    fake.writeStderr('https://auth.openai.com/codex/device\nTAEF-M7I6R\n');
    await until(() => events.some((e) => e.phase === 'device'));
    const device = events.filter((e) => e.phase === 'device');
    expect(device).toHaveLength(1);
    expect(device[0]).toMatchObject({
      agentType: 'codex',
      phase: 'device',
      url: 'https://auth.openai.com/codex/device',
      userCode: 'TAEF-M7I6R',
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });
  });

  it('second start while running does not spawn again and re-emits the device event', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    fake.writeStderr('https://auth.openai.com/codex/device\nTAEF-M7I6R\n');
    await until(() => events.some((e) => e.phase === 'device'));
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    const device = events.filter((e) => e.phase === 'device');
    expect(device).toHaveLength(2);
    expect(device[1]).toMatchObject({ userCode: 'TAEF-M7I6R', url: 'https://auth.openai.com/codex/device' });
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });
  });

  it('exit(1) after a device event emits error not done', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    fake.writeStderr('https://auth.openai.com/codex/device\nTAEF-M7I6R\n');
    await until(() => events.some((e) => e.phase === 'device'));
    fake.exit(1);
    await until(() => events.some((e) => e.phase === 'error' || e.phase === 'done'));
    expect(events.some((e) => e.phase === 'error')).toBe(true);
    expect(events.some((e) => e.phase === 'done')).toBe(false);
  });

  it('exit(0) emits done', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    fake.exit(0);
    await until(() => events.some((e) => e.phase === 'done'));
    expect(events.filter((e) => e.phase === 'done')).toEqual([
      { agentType: 'codex', phase: 'done' },
    ]);
  });

  it('cancel kills the child and a later start may spawn again', async () => {
    const fakes: ReturnType<typeof fakeLoginChild>[] = [];
    const spawnLogin = vi.fn(() => {
      const fake = fakeLoginChild();
      fakes.push(fake);
      return fake.child;
    });
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    await expect(hub.request('agents.login', { agentType: 'codex', op: 'cancel' }))
      .resolves.toEqual({ cancelled: true });
    expect(fakes[0]!.killed()).toBe(true);
    await until(() => events.some((e) => e.phase === 'error' && e.message === 'cancelled'));
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    expect(spawnLogin).toHaveBeenCalledTimes(2);
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });
  });

  it('two overlapping starts call spawnLogin once', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const { hub } = harness({ spawnLogin });
    const a = hub.request('agents.login', { agentType: 'codex', op: 'start' });
    const b = hub.request('agents.login', { agentType: 'codex', op: 'start' });
    await expect(a).resolves.toEqual({ started: true });
    await expect(b).resolves.toEqual({ started: true });
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });
  });

  it('start does not call buildHello', async () => {
    const fake = fakeLoginChild();
    const buildHello = vi.fn(async () => {
      throw new Error('buildHello must not be called');
    });
    const { hub } = harness({ spawnLogin: () => fake.child, buildHello });
    await expect(hub.request('agents.login', { agentType: 'codex', op: 'start' }))
      .resolves.toEqual({ started: true });
    expect(buildHello).not.toHaveBeenCalled();
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });
  });

  it('missing binary → not_installed and does not spawn', async () => {
    vi.mocked(binaryOnPath).mockReturnValue(false);
    const spawnLogin = vi.fn(() => fakeLoginChild().child);
    const { hub } = harness({ spawnLogin });
    await expect(hub.request('agents.login', { agentType: 'codex', op: 'start' }))
      .rejects.toMatchObject({ code: 'not_installed' });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it('op other than start or cancel → bad_request', async () => {
    const spawnLogin = vi.fn(() => fakeLoginChild().child);
    const { hub } = harness({ spawnLogin });
    await expect(hub.request('agents.login', { agentType: 'codex', op: 'install' }))
      .rejects.toMatchObject({ code: 'bad_request' });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it('ANSI stderr device blob still emits a device event', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    fake.writeStderr([
      '1. Open this link in your browser and sign in to your account',
      `   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m`,
      '',
      '2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m',
      `   \x1b[94mTAEF-M7I6R\x1b[0m`,
    ].join('\n'));
    await until(() => events.some((e) => e.phase === 'device'));
    expect(events.filter((e) => e.phase === 'device')).toHaveLength(1);
    expect(events[0]).toMatchObject({
      url: 'https://auth.openai.com/codex/device',
      userCode: 'TAEF-M7I6R',
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });
  });

  it('error tail is the last non-empty line with ANSI stripped', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    fake.writeStderr('\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\x1b[31mPermission denied\x1b[0m\n');
    fake.exit(1);
    await until(() => events.some((e) => e.phase === 'error' || e.phase === 'done'));
    expect(events.find((e) => e.phase === 'error')?.message).toBe('Permission denied');
  });

  const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=c&response_type=code'
    + '&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=x'
    + '&code_challenge=abc&code_challenge_method=S256&state=st';

  it('start spawns the fixed argv', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const { hub } = harness({ spawnLogin });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    expect(spawnLogin).toHaveBeenCalledWith(['auth', 'login', '--claudeai'], 'claude-code');
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('emits authorize once, only after the URL line ends', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fake.writeStderr(`visit: ${CLAUDE_URL.slice(0, 40)}`);
    expect(events).toEqual([]);
    fake.writeStderr(`${CLAUDE_URL.slice(40)}\n`);
    await until(() => events.some((e) => e.phase === 'authorize'));
    expect(events.filter((e) => e.phase === 'authorize')).toHaveLength(1);
    expect(events[0]).toMatchObject({ agentType: 'claude-code', phase: 'authorize', url: CLAUDE_URL });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('submit writes one line to stdin', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fake.writeStderr(`visit: ${CLAUDE_URL}\n`);
    await until(() => events.some((e) => e.phase === 'authorize'));
    await expect(hub.request('agents.login', { agentType: 'claude-code', op: 'submit', code: 'abc#st' }))
      .resolves.toEqual({ submitted: true });
    expect(fake.stdinChunks.join('')).toBe('abc#st\n');
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('submit rejects a malformed code without writing', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fake.writeStderr(`visit: ${CLAUDE_URL}\n`);
    await until(() => events.some((e) => e.phase === 'authorize'));
    for (const bad of ['a b#c', 'a#b\nc#d']) {
      const err = await hub.request('agents.login', { agentType: 'claude-code', op: 'submit', code: bad }).catch((e: unknown) => e) as { code: string; message: string };
      expect(err.code).toBe('bad_request');
      expect(JSON.stringify(err)).not.toContain(bad);
    }
    expect(fake.stdinChunks).toEqual([]);
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('submit with no running login → no_login', async () => {
    const { hub } = harness();
    await expect(hub.request('agents.login', { agentType: 'claude-code', op: 'submit', code: 'abc#st' }))
      .rejects.toMatchObject({ code: 'no_login' });
  });

  it('submit before the URL is known → no_login', async () => {
    const fake = fakeLoginChild();
    const { hub } = harness({ spawnLogin: () => fake.child });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    await expect(hub.request('agents.login', { agentType: 'claude-code', op: 'submit', code: 'abc#st' }))
      .rejects.toMatchObject({ code: 'no_login' });
    expect(fake.stdinChunks).toEqual([]);
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('submit for codex → bad_request', async () => {
    const { hub } = harness();
    await expect(hub.request('agents.login', { agentType: 'codex', op: 'submit', code: 'abc#st' }))
      .rejects.toMatchObject({ code: 'bad_request' });
  });

  it('stdin error after exit does not throw', async () => {
    const fakes: ReturnType<typeof fakeLoginChild>[] = [];
    const spawnLogin = vi.fn(() => {
      const fake = fakeLoginChild();
      fakes.push(fake);
      return fake.child;
    });
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fakes[0]!.exit(0);
    await until(() => events.some((e) => e.phase === 'done'));
    expect(() => fakes[0]!.child.stdin!.emit('error', new Error('EPIPE'))).not.toThrow();
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    expect(spawnLogin).toHaveBeenCalledTimes(2);
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('exit 0 → done', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fake.exit(0);
    await until(() => events.some((e) => e.phase === 'done'));
    expect(events.filter((e) => e.phase === 'done')).toEqual([
      { agentType: 'claude-code', phase: 'done' },
    ]);
  });

  it('exit 1 → error with the Login failed line', async () => {
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fake.writeStderr('Paste code here if prompted > Login failed: nope\n');
    fake.exit(1);
    await until(() => events.some((e) => e.phase === 'error' || e.phase === 'done'));
    expect(events.find((e) => e.phase === 'error')?.message).toBe('Login failed: nope');
  });

  it('no URL within 30 s → error mentioning updating Claude Code', async () => {
    vi.useFakeTimers();
    const fake = fakeLoginChild();
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin: () => fake.child,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(events.find((e) => e.phase === 'error')?.message).toMatch(/update Claude Code/);
  });

  it('login_busy across agents', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'codex', op: 'start' });
    fake.writeStderr('https://auth.openai.com/codex/device\nTAEF-M7I6R\n');
    await until(() => events.some((e) => e.phase === 'device'));
    await expect(hub.request('agents.login', { agentType: 'claude-code', op: 'start' }))
      .rejects.toMatchObject({ code: 'login_busy' });
    expect(events.filter((e) => e.phase === 'device')).toHaveLength(1);
    await hub.request('agents.login', { agentType: 'codex', op: 'cancel' });

    const fake2 = fakeLoginChild();
    spawnLogin.mockImplementation(() => fake2.child);
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fake2.writeStderr(`visit: ${CLAUDE_URL}\n`);
    await until(() => events.some((e) => e.phase === 'authorize'));
    await expect(hub.request('agents.login', { agentType: 'codex', op: 'start' }))
      .rejects.toMatchObject({ code: 'login_busy' });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('start again for the same agent re-emits the authorize event', async () => {
    const fake = fakeLoginChild();
    const spawnLogin = vi.fn(() => fake.child);
    const events: AgentsLoginEvent[] = [];
    const { hub } = harness({
      spawnLogin,
      emitLoginEvent: (ev) => { events.push(ev); },
    });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    fake.writeStderr(`visit: ${CLAUDE_URL}\n`);
    await until(() => events.some((e) => e.phase === 'authorize'));
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    expect(spawnLogin).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.phase === 'authorize')).toHaveLength(2);
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('cancel for the other agent leaves the running login alone', async () => {
    const fake = fakeLoginChild();
    const { hub } = harness({ spawnLogin: () => fake.child });
    await hub.request('agents.login', { agentType: 'claude-code', op: 'start' });
    await expect(hub.request('agents.login', { agentType: 'codex', op: 'cancel' }))
      .resolves.toEqual({ cancelled: true });
    expect(fake.killed()).toBe(false);
    await hub.request('agents.login', { agentType: 'claude-code', op: 'cancel' });
  });

  it('not_installed when binaryOnPath is false', async () => {
    vi.mocked(binaryOnPath).mockReturnValue(false);
    const spawnLogin = vi.fn(() => fakeLoginChild().child);
    const { hub } = harness({ spawnLogin });
    await expect(hub.request('agents.login', { agentType: 'claude-code', op: 'start' }))
      .rejects.toMatchObject({ code: 'not_installed' });
    expect(spawnLogin).not.toHaveBeenCalled();
  });

  it('agent_not_allowed when not in policy', async () => {
    const spawnLogin = vi.fn(() => fakeLoginChild().child);
    const { hub } = harness({ spawnLogin, allowedAgents: ['codex'] });
    await expect(hub.request('agents.login', { agentType: 'claude-code', op: 'start' }))
      .rejects.toMatchObject({ code: 'agent_not_allowed' });
    expect(spawnLogin).not.toHaveBeenCalled();
  });
});

describe('defaultSpawnLogin', () => {
  it('spawns a detached process group with spec env and ignored stdin', () => {
    const dir = tmp('login-bin-');
    const stub = join(dir, 'copilot');
    writeFileSync(stub, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    let child: ChildProcess | undefined;
    try {
      child = defaultSpawnLogin(['login', '--device-code'], 'copilot');
      expect(child.pid).toBeGreaterThan(0);
      expect(child.stdin).toBeNull();
      expect(child.stdout).not.toBeNull();
      expect(child.stderr).not.toBeNull();
      const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim());
      expect(pgid).toBe(child.pid);
      const env = readFileSync(`/proc/${child.pid}/environ`);
      const text = env.toString('utf8');
      expect(text).toContain('BROWSER=true');
      expect(text).toContain('COPILOT_AUTO_UPDATE=false');
    } finally {
      process.env.PATH = prev;
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  });

  it('cursor login sets NO_OPEN_BROWSER and BROWSER', async () => {
    const dir = tmp('login-bin-');
    const stub = join(dir, 'cursor-agent');
    writeFileSync(stub, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    const prev = process.env.PATH;
    process.env.PATH = `${dir}:${prev}`;
    let child: ChildProcess | undefined;
    try {
      child = defaultSpawnLogin(['login'], 'cursor');
      expect(child.stdin).toBeNull();
      const pid = child.pid;
      // environ reads '' until the child has exec'd; under full-suite load that lags the spawn.
      await vi.waitFor(() => {
        const env = readFileSync(`/proc/${pid}/environ`).toString('utf8');
        expect(env).toContain('NO_OPEN_BROWSER=1');
        expect(env).toContain('BROWSER=true');
      }, { timeout: 5000, interval: 20 });
    } finally {
      process.env.PATH = prev;
      if (child?.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
      }
    }
  });
});
