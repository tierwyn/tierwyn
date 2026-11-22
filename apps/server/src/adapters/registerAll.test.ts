import { describe, it, expect, vi } from 'vitest';
import { spawn as nodeSpawn, execFileSync } from 'node:child_process';
import { SandboxError } from '../sandbox/bwrap.js';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerStdioAdapters } from './registerAll.js';
import { PiAdapter } from './pi/index.js';
import type { AgentAdapter } from '@tierwyn/shared';
import type { AdapterFactoryOpts } from '../registry.js';

const STDIO_TYPES = [
  'claude-code',
  'pi',
  'antigravity',
  'opencode',
  'kilocode',
  'cursor',
  'hermes',
  'codex',
  'grok-build',
  'kiro',
  'qwen',
  'openclaw',
  'copilot',
  'kimi',
  'deepseek',
] as const;

describe('registerStdioAdapters', () => {
  it('wires sandbox spawn for every stdio type', () => {
    const factories: Record<string, (opts?: AdapterFactoryOpts) => AgentAdapter> = {};
    const reg = {
      register(
        type: string,
        f: (opts?: AdapterFactoryOpts) => AgentAdapter,
      ) {
        factories[type] = f;
      },
    };
    registerStdioAdapters(reg, () => 'bypass');
    for (const type of STDIO_TYPES) {
      const f = factories[type];
      expect(f).toBeDefined();
      const sandboxed = f({ sandbox: true }) as AgentAdapter & { _spawn: typeof nodeSpawn };
      const plain = f() as AgentAdapter & { _spawn: typeof nodeSpawn };
      expect(sandboxed._spawn).not.toBe(plain._spawn);
      expect(sandboxed._spawn).not.toBe(nodeSpawn);
    }
    // copilot is sandboxable since its profile landed; its sandboxed spawn needs the vault Copilot token.
    const copilot = factories.copilot({ sandbox: true }) as AgentAdapter & { _spawn: typeof nodeSpawn };
    expect(copilot._spawn).not.toBe(nodeSpawn);
  });

  it('injected spawn still runs through adapter env scrub wrapper', () => {
    const prevDb = process.env.TIERWYN_DB;
    process.env.TIERWYN_DB = '/secret/tierwyn.db';
    const seen: NodeJS.ProcessEnv[] = [];
    const inner = vi.fn((_cmd: string, _args: string[], opts: { env?: NodeJS.ProcessEnv }) => {
      seen.push(opts.env ?? {});
      return { pid: 1, stdin: null, stdout: null, stderr: null } as ReturnType<typeof nodeSpawn>;
    });
    const pi = new PiAdapter({ spawn: inner as typeof nodeSpawn }) as AgentAdapter & {
      _spawn: (c: string, a: string[], o: { cwd?: string }) => void;
    };
    pi._spawn('pi', ['--mode', 'rpc'], { cwd: '/tmp' });
    expect(inner).toHaveBeenCalled();
    expect(seen[0]?.TIERWYN_DB).toBeUndefined();
    if (prevDb === undefined) delete process.env.TIERWYN_DB;
    else process.env.TIERWYN_DB = prevDb;
  });

  it('registers every non-grok-bot type with its label', () => {
    const types: string[] = [];
    const labels: Record<string, string> = {};
    const reg = {
      register(
        type: string,
        _f: (opts?: AdapterFactoryOpts) => AgentAdapter,
        label?: string,
      ) {
        types.push(type);
        if (label !== undefined) labels[type] = label;
      },
    };

    registerStdioAdapters(reg, () => 'bypass');

    expect(new Set(types)).toEqual(new Set(STDIO_TYPES));
    expect(types).not.toContain('grok-bot');
    expect(labels['codex']).toBe('Codex');
  });

  it('imports without loading hub db or repositories modules', () => {
    const registerAllPath = fileURLToPath(new URL('./registerAll.ts', import.meta.url));
    const registerHook = fileURLToPath(new URL('./registerAll-resolve-register.mjs', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'rh-resolve-'));
    const log = join(dir, 'urls.txt');
    const script = `
const { registerStdioAdapters } = await import(${JSON.stringify(registerAllPath)});
registerStdioAdapters({
  register(_type, f) { f(); },
}, () => 'bypass');
`;
    try {
      execFileSync(process.execPath, [
        '--import', 'tsx',
        '--import', registerHook,
        '--input-type=module',
        '-e', script,
      ], {
        env: { ...process.env, TIERWYN_DB: '/nonexistent/x.db', TIERWYN_RESOLVE_LOG: log },
        encoding: 'utf8',
        timeout: 60_000,
      });
      // Weak: db/index.ts does not open on import, so this would pass even if
      // registerAll imported db/seed.js. The resolve-hook assertion below is
      // the real probe.
      expect(existsSync('/nonexistent')).toBe(false);
      const urls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      expect(urls.some((u) => /\/src\/(db|repositories)\//.test(u))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('node/main.ts import loads no db or repositories modules', () => {
    const mainPath = fileURLToPath(new URL('../node/main.ts', import.meta.url));
    const registerHook = fileURLToPath(new URL('./registerAll-resolve-register.mjs', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'rh-resolve-main-'));
    const log = join(dir, 'urls.txt');
    const script = `await import(${JSON.stringify(mainPath)});`;
    try {
      execFileSync(process.execPath, [
        '--import', 'tsx',
        '--import', registerHook,
        '--input-type=module',
        '-e', script,
      ], {
        env: { ...process.env, TIERWYN_DB: '/nonexistent/x.db', TIERWYN_RESOLVE_LOG: log },
        encoding: 'utf8',
        timeout: 60_000,
      });
      const urls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      expect(urls.some((u) => /\/src\/(db|repositories)\//.test(u))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolve-hook probe detects a db/seed import', () => {
    const seedPath = fileURLToPath(new URL('../db/seed.ts', import.meta.url));
    const registerHook = fileURLToPath(new URL('./registerAll-resolve-register.mjs', import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), 'rh-resolve-seed-'));
    const log = join(dir, 'urls.txt');
    const script = `await import(${JSON.stringify(seedPath)});`;
    try {
      execFileSync(process.execPath, [
        '--import', 'tsx',
        '--import', registerHook,
        '--input-type=module',
        '-e', script,
      ], {
        env: { ...process.env, TIERWYN_DB: '/nonexistent/x.db', TIERWYN_RESOLVE_LOG: log },
        encoding: 'utf8',
        timeout: 60_000,
      });
      const urls = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
      expect(urls.some((u) => /\/src\/(db|repositories)\//.test(u))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
