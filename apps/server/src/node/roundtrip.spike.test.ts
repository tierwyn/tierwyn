import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, NodeHello, NormalisedEvent, SessionConfig } from '@tierwyn/shared';
import { registerStdioAdapters } from '../adapters/registerAll.js';
import { memoryPair, RpcPeer } from './rpc.js';
import { NodeRuntime } from './runtime.js';
import { linkFromPeer, RemoteAdapterProxy } from './proxyAdapter.js';
import type { AdapterFactoryOpts } from '../registry.js';
import { envPref } from '../config/env.js';

const run = envPref('SPIKE_REAL_AGENTS') === '1';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function gitDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'rh-spike-'));
  dirs.push(d);
  execFileSync('git', ['init'], { cwd: d });
  execFileSync('git', ['config', 'user.email', 'spike@test'], { cwd: d });
  execFileSync('git', ['config', 'user.name', 'spike'], { cwd: d });
  writeFileSync(join(d, 'README.md'), 'spike\n');
  execFileSync('git', ['add', 'README.md'], { cwd: d });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: d });
  mkdirSync(join(d, '.tierwyn'), { recursive: true });
  return d;
}

function collect(adapter: AgentAdapter): Promise<NormalisedEvent[]> {
  return new Promise((resolve, reject) => {
    const events: NormalisedEvent[] = [];
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve(events);
    };
    const em = adapter.streamEvents();
    em.on('event', (e: NormalisedEvent) => {
      events.push(e);
      if (e.type === 'status' && e.payload.status === 'done') done();
    });
    em.on('error', reject);
    em.on('end', done);
    setTimeout(() => reject(new Error('spike timeout')), 120_000);
  });
}

function typesIgnoringStatus(events: NormalisedEvent[]): string[] {
  return events.map((e) => e.type).filter((t) => t !== 'status');
}

function hasPong(events: NormalisedEvent[]): boolean {
  const text = events.filter((e) => e.type === 'message').map((e) => e.payload.chunk).join('');
  return /pong/i.test(text);
}

describe.skipIf(!run)('P0.2 real-agent round-trip spike', () => {
  it.each(['claude-code', 'codex'] as const)('%s proxy events match direct (ignore status)', async (agentType) => {
    const registry = new Map<string, (opts?: AdapterFactoryOpts) => AgentAdapter>();
    registerStdioAdapters({
      register(type, f) { registry.set(type, f); },
    }, () => 'bypass');
    const cwd = gitDir();
    const create = (type: string, opts?: AdapterFactoryOpts) => {
      const f = registry.get(type);
      if (!f) throw new Error(`no adapter ${type}`);
      return f(opts);
    };
    const runtime = new NodeRuntime({
      create,
      has: (t) => registry.has(t),
      policy: { roots: [cwd], allowedAgents: [agentType], maxSessions: 2 },
    });
    const [hubT, nodeT] = memoryPair();
    const nodePeer = new RpcPeer(nodeT, runtime.handlers(), { timeoutMs: 120_000 });
    runtime.attach(nodePeer);
    const hubPeer = new RpcPeer(hubT, {}, { timeoutMs: 120_000 });
    const hello: NodeHello = {
      protocol: 1,
      gitSha: 'spike',
      hostname: 'spike',
      os: 'linux',
      arch: 'x64',
      homedir: tmpdir(),
      roots: [cwd],
      listenPort: 8788,
      agents: { [agentType]: { installed: true, methods: [] } },
      models: {},
      sessions: [],
    };
    const proxy = new RemoteAdapterProxy(linkFromPeer('spike', hubPeer, hello), agentType, {
      interactionMode: 'bypass',
      allowMcpSecrets: true,
    });

    const config: SessionConfig = {
      sessionId: `spike-${agentType}-direct`,
      conversationId: 'spike',
      cwd,
      model: agentType === 'codex' ? 'gpt-5.5' : 'claude-haiku-4-5',
    };
    const prompt = 'Reply with exactly: pong';

    const direct = create(agentType, { interactionMode: 'bypass' });
    const directP = collect(direct);
    await direct.start({ ...config, sessionId: `spike-${agentType}-direct` });
    await direct.sendPrompt(prompt);
    const directEvents = await directP;
    await direct.stop();

    const proxyConfig = { ...config, sessionId: `spike-${agentType}-proxy` };
    const proxyP = collect(proxy);
    await proxy.start(proxyConfig);
    await proxy.sendPrompt(prompt);
    const proxyEvents = await proxyP;
    await proxy.stop();

    const summarize = (events: NormalisedEvent[]) => events.map((e) => {
      if (e.type === 'message') return `message:${e.payload.chunk.slice(0, 80)}`;
      if (e.type === 'error') return `error:${JSON.stringify(e.payload).slice(0, 80)}`;
      return e.type;
    });
    if (!hasPong(directEvents) || !hasPong(proxyEvents)) {
      // eslint-disable-next-line no-console
      console.log('SPIKE direct', summarize(directEvents));
      // eslint-disable-next-line no-console
      console.log('SPIKE proxy', summarize(proxyEvents));
    }
    expect(typesIgnoringStatus(proxyEvents)).toEqual(typesIgnoringStatus(directEvents));
    const directText = directEvents.filter((e) => e.type === 'message').map((e) => e.payload.chunk).join('');
    if (directText.length > 0) {
      expect(hasPong(directEvents)).toBe(true);
      expect(hasPong(proxyEvents)).toBe(true);
    }
  }, 180_000);
});
