import { EventEmitter } from 'events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter, ModelDescriptor } from '@tierwyn/shared';
import { OPTIONAL_ADAPTER_METHODS, TIERWYN_VERSION } from '@tierwyn/shared';
import { buildHello, cli, enroll, ensureAgentPath, parseEnroll, parsePackageFetch, runNode, selfCheck } from './main.js';
import { AgentsCliError, NODE_AGENT_TYPES } from './agentsCli.js';
import { probeInstalledVersion } from '../versions.js';
import { AGENT_BINARIES } from '../discovery.js';
import { defaultNodeRoot, type NodeConfig } from './policy.js';

vi.mock('../discovery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../discovery.js')>();
  return {
    ...actual,
    binaryOnPath: vi.fn(() => true),
  };
});

vi.mock('../versions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../versions.js')>();
  return {
    ...actual,
    probeInstalledVersion: vi.fn(async () => undefined),
  };
});

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'rh-node-'));
  dirs.push(d);
  return d;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

class HelloAdapter implements AgentAdapter {
  constructor(
    private readonly models: ModelDescriptor[],
    readonly extra?: Record<string, unknown>,
  ) {
    if (extra) Object.assign(this, extra);
  }
  async start(): Promise<void> {}
  async sendPrompt(): Promise<void> {}
  streamEvents(): EventEmitter { return new EventEmitter(); }
  async stop(): Promise<void> {}
  async listSessions() { return []; }
  async loadSession(): Promise<void> {}
  async listModels() { return this.models; }
}

describe('enroll', () => {
  const noExec = () => ({ status: 0, stdout: '' });
  it('enroll writes 0600 key and node.json', async () => {
    const dir = tmp();
    chmodSync(dir, 0o755);
    let posted: { url: string; body: Record<string, unknown> } | undefined;
    const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
      posted = { url: String(url), body: JSON.parse(String(init?.body)) };
      return {
        ok: true,
        status: 200,
        json: async () => ({ hostId: 'host-1' }),
      } as Response;
    });
    const log: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { log.push(a.map(String).join(' ')); };
    try {
      await enroll({ hub: 'https://hub.example/', token: 'tok-abc', dir }, fetchFn, noExec);
    } finally {
      console.log = orig;
    }
    expect(posted?.url).toBe('https://hub.example/node/enroll');
    expect(posted?.body.token).toBe('tok-abc');
    expect(posted?.body.hubOrigin).toBe('https://hub.example');
    expect(posted?.body.publicKey).toEqual(expect.any(String));
    expect((posted?.body.hello as { hostname?: string }).hostname).toEqual(expect.any(String));
    const keyStat = statSync(join(dir, 'key'));
    expect(keyStat.mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, 'node.json')).mode & 0o777).toBe(0o600);
    const cfg = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8')) as NodeConfig;
    expect(cfg.hubUrl).toBe('https://hub.example/');
    expect(cfg.hostId).toBe('host-1');
    const root = defaultNodeRoot();
    expect(cfg.roots).toEqual([root]);
    expect(existsSync(root)).toBe(true);
    expect(statSync(root).isDirectory()).toBe(true);
    expect(cfg.allowedAgents).toEqual([]);
    expect(cfg.listenPort).toBeGreaterThanOrEqual(8788); // 8788 unless something holds it (a hub on this machine)
    expect(cfg.maxSessions).toBe(8);
    expect(log.some((l) => l.includes('Enrolled as host-1') && l.includes(dir))).toBe(true);
  });

  it('enroll preserves existing roots', async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'node.json'), JSON.stringify({
      hubUrl: 'https://old.example',
      hostId: 'old',
      roots: ['/keep/this'],
      allowedAgents: ['hermes'],
      listenPort: 1,
      maxSessions: 1,
      artifactsMaxAgeDays: 7,
      allowSelfUpdate: false,
      custom: 'x',
    }));
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hostId: 'host-2' }),
    } as Response));
    await enroll({ hub: 'https://hub.example', token: 't', dir }, fetchFn, noExec);
    const cfg = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8'));
    expect(cfg.roots).toEqual(['/keep/this']);
    expect(existsSync('/keep/this')).toBe(false); // custom roots are never auto-created
    expect(cfg.allowedAgents).toEqual(['hermes']);
    expect(cfg.hostId).toBe('host-2');
    expect(cfg.hubUrl).toBe('https://hub.example');
    expect(cfg).toMatchObject({ listenPort: 1, maxSessions: 1, artifactsMaxAgeDays: 7, allowSelfUpdate: false, custom: 'x' });
  });

  it('enroll --allow-http persists allowHttpPackage', async () => {
    const dir = tmp();
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hostId: 'host-http' }),
    } as Response));
    await enroll({ hub: 'https://hub.example', token: 't', dir, allowHttp: true }, fetchFn, noExec);
    const cfg = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8'));
    expect(cfg.allowHttpPackage).toBe(true);
  });

  it('re-enroll without the flag keeps a prior true', async () => {
    const dir = tmp();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'node.json'), JSON.stringify({
      hubUrl: 'https://old.example',
      hostId: 'old',
      roots: ['/keep'],
      allowedAgents: [],
      allowHttpPackage: true,
    }));
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ hostId: 'host-3' }),
    } as Response));
    await enroll({ hub: 'https://hub.example', token: 't', dir }, fetchFn, noExec);
    const cfg = JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8'));
    expect(cfg.allowHttpPackage).toBe(true);
  });

  const okFetch = () => vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ hostId: 'h9' }) } as Response));
  const capture = async (fn: () => Promise<void>): Promise<string[]> => {
    const log: string[] = [];
    const orig = console.log;
    console.log = (...a: unknown[]) => { log.push(a.map(String).join(' ')); };
    try { await fn(); } finally { console.log = orig; }
    return log;
  };
  const cfgOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'node.json'), 'utf8'));

  it('--agents sets sorted list and logs it', async () => {
    const dir = tmp();
    const log = await capture(() => enroll({ hub: 'https://h.x', token: 't', dir, agents: ['codex', 'claude-code'] }, okFetch(), noExec));
    expect(cfgOf(dir).allowedAgents).toEqual(['claude-code', 'codex']);
    expect(log.some((l) => l.includes('Allowed agents: claude-code, codex') && l.includes('clicks Trust'))).toBe(true);
  });

  it('--all-agents writes every node type', async () => {
    const dir = tmp();
    await capture(() => enroll({ hub: 'https://h.x', token: 't', dir, allAgents: true }, okFetch(), noExec));
    expect(cfgOf(dir).allowedAgents).toEqual([...NODE_AGENT_TYPES]);
  });

  it('re-enroll: flag replaces list, no flag keeps it', async () => {
    const dir = tmp();
    writeFileSync(join(dir, 'node.json'), JSON.stringify({ allowedAgents: ['hermes'], listenPort: 1, custom: 'x' }));
    await capture(() => enroll({ hub: 'https://h.x', token: 't', dir }, okFetch(), noExec));
    expect(cfgOf(dir)).toMatchObject({ allowedAgents: ['hermes'], listenPort: 1, custom: 'x' });
    await capture(() => enroll({ hub: 'https://h.x', token: 't', dir, agents: ['codex'] }, okFetch(), noExec));
    expect(cfgOf(dir)).toMatchObject({ allowedAgents: ['codex'], listenPort: 1, custom: 'x' });
  });

  it('trusted enroll starts tierwyn-node.service', async () => {
    const dir = tmp();
    const exec = vi.fn(() => ({ status: 0, stdout: '' }));
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ hostId: 'h-t', trusted: true }),
    } as Response));
    const log = await capture(() => enroll({ hub: 'https://h.x', token: 't', dir, agents: ['codex'] }, fetchFn, exec));
    expect(exec).toHaveBeenCalledWith('systemctl', ['--user', 'enable', 'tierwyn-node.service']);
    // restart, not --now: a re-enroll must drop the running daemon's stale hostId/key.
    expect(exec).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'tierwyn-node.service']);
    expect(cfgOf(dir).hostId).toBe('h-t');
    expect(log.some((l) => l.includes('Trusted by hub') && l.includes('tierwyn-node.service'))).toBe(true);
  });

  it('trusted enroll with failed systemctl still writes node.json', async () => {
    const dir = tmp();
    const exec = vi.fn(() => ({ status: 1, stdout: 'fail' }));
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ hostId: 'h-fail', trusted: true }),
    } as Response));
    const err: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
    try {
      await capture(() => enroll({ hub: 'https://h.x', token: 't', dir }, fetchFn, exec));
    } finally {
      console.error = origErr;
    }
    expect(cfgOf(dir).hostId).toBe('h-fail');
    expect(err.some((l) => l.includes('tierwyn node start'))).toBe(true);
  });

  it('untrusted enroll still starts the unit so Trust connects without a restart', async () => {
    const dir = tmp();
    const exec = vi.fn(() => ({ status: 0, stdout: '' }));
    const fetchFn = vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ hostId: 'h-u', trusted: false }),
    } as Response));
    const log = await capture(() => enroll({ hub: 'https://h.x', token: 't', dir }, fetchFn, exec));
    expect(exec).toHaveBeenCalledWith('systemctl', ['--user', 'restart', 'tierwyn-node.service']);
    expect(log.some((l) => l.includes('clicks Trust') && /Fingerprint: +SHA256:[A-Za-z0-9+/]{43}\n/.test(l))).toBe(true);
  });

  it('bad / grok-bot agents reject before fetch and key write', async () => {
    for (const bad of ['bogus', 'grok-bot']) {
      const dir = tmp();
      const f = okFetch();
      const err = await enroll({ hub: 'https://h.x', token: 't', dir, agents: [bad] }, f, noExec).catch((e) => e);
      expect(err).toBeInstanceOf(AgentsCliError);
      expect((err as AgentsCliError).code).toBe(2);
      expect(f).not.toHaveBeenCalled();
      expect(existsSync(join(dir, 'key'))).toBe(false);
    }
  });
});

describe('parseEnroll', () => {
  const base = ['--hub', 'h', '--token', 't'];
  const code = (a: string[]) => { try { parseEnroll(a); } catch (e) { return (e as AgentsCliError).code; } };
  it('collects agent flags', () => {
    expect(parseEnroll([...base, '--agents', 'b,a', '--agents=c']).agents).toEqual(['a', 'b', 'c']);
    expect(parseEnroll([...base, '--all-agents']).allAgents).toBe(true);
    expect(parseEnroll([...base, '--allow-http']).allowHttp).toBe(true);
  });
  it('usage errors', () => {
    expect(code([...base, '--all-agents', '--agents', 'a'])).toBe(2);
    expect(code([...base, '--agents', ''])).toBe(2);
    expect(code(['--hub', 'h'])).toBe(2);
    expect(code([...base, '--agent', 'codex'])).toBe(2);
    expect(code([...base, '--all-agent'])).toBe(2);
    expect(code([...base, '--dir'])).toBe(2);
  });
});

describe('buildHello', () => {
  it('buildHello lists only allowedAgents as installed and includes methods', async () => {
    const adapters = new Map<string, HelloAdapter>([
      ['codex', new HelloAdapter([{ name: 'm1', id: 'm1' }], { steer: async () => {} })],
      ['pi', new HelloAdapter([{ name: 'should-not-list', id: 'x' }], { steer: async () => {} })],
      ['claude-code', new HelloAdapter([], {
        listModels: async () => { throw new Error('probe failed'); },
      })],
    ]);
    const reg = {
      create: (type: string) => {
        const a = adapters.get(type);
        if (!a) throw new Error(type);
        return a;
      },
      has: (type: string) => adapters.has(type),
      registeredTypes: () => new Set(adapters.keys()),
    };
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: 'h',
      roots: ['/work'],
      allowedAgents: ['codex', 'claude-code'],
      listenPort: 9090,
      maxSessions: 8,
      keyPath: '/tmp/k',
    };
    const hello = await buildHello(config, reg);
    expect(hello.protocol).toBe(1);
    expect(hello.listenPort).toBe(9090);
    expect(hello.roots).toEqual(['/work']);
    expect(hello.agents.codex?.installed).toBe(true);
    expect(hello.agents.pi?.installed).toBe(false);
    expect(hello.agents['claude-code']?.installed).toBe(true);
    expect(hello.agents.codex?.methods).toContain('steer');
    expect(OPTIONAL_ADAPTER_METHODS.filter((m) => m === 'steer')).toHaveLength(1);
    expect(hello.models.codex).toEqual(['m1']);
    expect(hello.models.pi).toBeUndefined();
    expect(hello.models['claude-code']).toEqual([]);
    // P2c: allowed/installable/loggedIn advisory flags.
    expect(hello.agents.codex?.allowed).toBe(true);
    expect(hello.agents['claude-code']?.allowed).toBe(true);
    expect(hello.agents.pi?.allowed).toBe(false);
    expect(hello.agents.codex?.installable).toEqual(expect.any(Boolean));
    // loggedIn only on installed types; value depends on the runner's real home.
    expect(hello.agents.codex).toHaveProperty('loggedIn');
    expect(hello.agents.pi).not.toHaveProperty('loggedIn');
  });

  it('buildHello includes release semver as version', async () => {
    const reg = {
      create: (type: string) => { throw new Error(type); },
      has: () => false,
      registeredTypes: () => new Set<string>(),
    };
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: 'h',
      roots: ['/work'],
      allowedAgents: [],
      listenPort: 9090,
      maxSessions: 8,
      keyPath: '/tmp/k',
    };
    const hello = await buildHello(config, reg);
    expect(hello.version).toBe(TIERWYN_VERSION);
  });

  it('buildHello advertises the streaming tunnel feature', async () => {
    const adapters = new Map<string, HelloAdapter>();
    const reg = {
      create: (type: string) => { throw new Error(type); },
      has: (type: string) => adapters.has(type),
      registeredTypes: () => new Set(adapters.keys()),
    };
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: 'h',
      roots: ['/work'],
      allowedAgents: [],
      listenPort: 9090,
      maxSessions: 8,
      keyPath: '/tmp/k',
      artifactsMaxAgeDays: 90,
      sandbox: 'allow',
    };
    const hello = await buildHello(config, reg);
    expect(hello.features).toEqual([
      'tunnel.stream',
      'mcp.native',
      'files.write',
      'artifacts.sweep',
      'git.worktree',
      'git.shadow',
      'node.selfUpdate',
      'agents.version',
      'fs.mkdir',
      'fs.move',
      'trust_repo_config',
      'sandbox',
      'sandbox_paths',
      'schedule.packFiles',
      'agent_env',
      'agents.login',
      'agents.login.claude',
      'agents.login.copilot',
      'agents.login.grok',
      'agents.login.cursor',
      'agents.loginStatus',
    ]);
    expect(hello.features).toContain('agents.login');
    expect(hello.features).toContain('agents.login.claude');
    expect(hello.sandbox).toEqual({ policy: 'allow', available: false });
    expect(hello.sandboxPaths).toEqual({ allow: 'ro' });
  });

  it('buildHello advertises sandboxPaths.allow from node.json', async () => {
    const adapters = new Map<string, HelloAdapter>();
    const reg = {
      create: (type: string) => { throw new Error(type); },
      has: (type: string) => adapters.has(type),
      registeredTypes: () => new Set(adapters.keys()),
    };
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: 'h',
      roots: ['/work'],
      allowedAgents: [],
      listenPort: 9090,
      maxSessions: 8,
      keyPath: '/tmp/k',
      artifactsMaxAgeDays: 90,
      sandbox: 'allow',
      sandboxPaths: { allow: 'none' },
    };
    const hello = await buildHello(config, reg);
    expect(hello.features).toContain('sandbox_paths');
    expect(hello.sandboxPaths).toEqual({ allow: 'none' });
  });

  it('hello carries oneShotModes only when the adapter declares them', async () => {
    const adapters = new Map<string, HelloAdapter>([
      ['codex', new HelloAdapter([{ name: 'm1', label: 'm1' }], { oneShotModes: ['none', 'read_only'] })],
      ['pi', new HelloAdapter([{ name: 'p1', label: 'p1' }])],
    ]);
    const reg = {
      create: (type: string) => {
        const a = adapters.get(type);
        if (!a) throw new Error(type);
        return a;
      },
      has: (type: string) => adapters.has(type),
      registeredTypes: () => new Set(adapters.keys()),
    };
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: 'h',
      roots: ['/work'],
      allowedAgents: ['codex', 'pi'],
      listenPort: 9090,
      maxSessions: 8,
      keyPath: '/tmp/k',
    };
    const hello = await buildHello(config, reg);
    expect(hello.agents.codex?.oneShotModes).toEqual(['none', 'read_only']);
    expect(hello.agents.pi?.oneShotModes).toBeUndefined();
  });

  it('buildHello reports installed versions when the probe resolves', async () => {
    vi.mocked(probeInstalledVersion).mockImplementation(async (bin: string) =>
      bin === AGENT_BINARIES.codex.bin ? '9.9.9' : undefined);
    const adapters = new Map<string, HelloAdapter>([
      ['codex', new HelloAdapter([])],
      ['pi', new HelloAdapter([])],
    ]);
    const reg = {
      create: (type: string) => {
        const a = adapters.get(type);
        if (!a) throw new Error(type);
        return a;
      },
      has: (type: string) => adapters.has(type),
      registeredTypes: () => new Set(adapters.keys()),
    };
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: 'h',
      roots: ['/work'],
      allowedAgents: ['codex'],
      listenPort: 9090,
      maxSessions: 8,
      keyPath: '/tmp/k',
    };
    const hello = await buildHello(config, reg);
    expect(hello.agents.codex?.version).toBe('9.9.9');
    // Not installed (disallowed) → no probe, no version.
    expect(hello.agents.pi?.installed).toBe(false);
    expect(hello.agents.pi).not.toHaveProperty('version');
    expect(probeInstalledVersion).toHaveBeenCalledWith(AGENT_BINARIES.codex.bin);
    expect(probeInstalledVersion).not.toHaveBeenCalledWith(AGENT_BINARIES.pi.bin);
  });

  it('buildHello ships without a version when a probe hangs past the deadline', async () => {
    let lateResolve: ((v: string | undefined) => void) | undefined;
    vi.mocked(probeInstalledVersion).mockImplementation(
      () => new Promise<string | undefined>((resolve) => { lateResolve = resolve; }),
    );
    const adapters = new Map<string, HelloAdapter>([['codex', new HelloAdapter([])]]);
    const reg = {
      create: (type: string) => {
        const a = adapters.get(type);
        if (!a) throw new Error(type);
        return a;
      },
      has: (type: string) => adapters.has(type),
      registeredTypes: () => new Set(adapters.keys()),
    };
    const config: NodeConfig = {
      hubUrl: 'https://hub.example',
      hostId: 'h',
      roots: ['/work'],
      allowedAgents: ['codex'],
      listenPort: 9090,
      maxSessions: 8,
      keyPath: '/tmp/k',
    };
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown) => { rejections.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const hello = await buildHello(config, reg, undefined, 25);
      expect(hello.agents.codex?.installed).toBe(true);
      expect(hello.agents.codex?.version).toBeUndefined();
      // The probe resolves after the deadline: no unhandled rejection, and the
      // shipped hello must not be mutated by the late write.
      lateResolve?.('9.9.9');
      await new Promise((r) => setTimeout(r, 30));
      expect(hello.agents.codex?.version).toBeUndefined();
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('runNode', () => {
  it('run exits 2 when not enrolled', async () => {
    const dir = tmp();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(runNode(dir)).rejects.toThrow(/exit 2/);
    expect(exit).toHaveBeenCalledWith(2);
  });
});

describe('package-fetch CLI', () => {
  it('parsePackageFetch accepts --allow-http', () => {
    expect(parsePackageFetch(['--out', 'x.tgz', '--allow-http'])).toEqual({ out: 'x.tgz', allowHttp: true });
  });

  it('not enrolled → exit 2', async () => {
    const dir = tmp();
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as typeof process.exit);
    await expect(cli(['package-fetch', '--out', join(dir, 'x.tgz'), '--dir', dir])).rejects.toThrow(/exit 2/);
    expect(exit).toHaveBeenCalledWith(2);
  });
});

describe('self-check', () => {
  it('self-check reports profile count > 0', () => {
    const result = selfCheck();
    expect(result.profiles).toBeGreaterThan(0);
    expect(result.sqlite).toBe(true);
    expect(result.buildId).toEqual(expect.any(String));
    expect(result.source === 'git' || result.source === 'package').toBe(true);
  });

  it('self-check exits non-zero when profiles can\'t be read', () => {
    expect(() => selfCheck({ readProfiles: () => { throw new Error('profiles missing'); } }))
      .toThrow(/profiles missing/);
  });

  it('self-check throws when profile list is empty', () => {
    expect(() => selfCheck({ readProfiles: () => [] })).toThrow(/profile/i);
  });
});

describe('ensureAgentPath', () => {
  it('prepends missing user-level agent bin directories and node-v* bin dirs without duplicating existing entries', () => {
    const home = tmp();
    const nodeBin = join(home, '.local', 'lib', 'node-v24.22.1-linux-x64', 'bin');
    mkdirSync(nodeBin, { recursive: true });
    const env: NodeJS.ProcessEnv = { PATH: `${join(home, '.local', 'bin')}:/usr/bin` };
    ensureAgentPath(env, home);
    const parts = (env.PATH ?? '').split(':');
    expect(parts).toContain(join(home, '.opencode', 'bin'));
    expect(parts).toContain(join(home, '.npm-global', 'bin'));
    expect(parts).toContain(join(home, '.kiro', 'bin'));
    expect(parts).toContain(nodeBin);
    expect(parts.filter((p) => p === join(home, '.local', 'bin'))).toHaveLength(1);
    expect(parts.at(-1)).toBe('/usr/bin');
  });

  it('append mode (hub boot) keeps the operator PATH first', () => {
    const home = tmp();
    const env: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    ensureAgentPath(env, home, true);
    const parts = (env.PATH ?? '').split(':');
    expect(parts[0]).toBe('/usr/bin');
    expect(parts).toContain(join(home, '.local', 'bin'));
  });
});
