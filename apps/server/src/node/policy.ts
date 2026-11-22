import { chmodSync, closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { homedir } from 'os';
import { delimiter, isAbsolute, join, relative, sep } from 'path';
import type { NodeSandboxPathsAllow, NodeSandboxPolicy } from '@tierwyn/shared';
import { BRAND, configDir } from '../config/brand.js';
import { envPrefFrom } from '../config/env.js';
import { RpcError } from './rpc.js';

export interface NodeConfig {
  hubUrl: string;
  hostId: string;
  roots: string[];
  allowedAgents: string[];
  listenPort: number;
  maxSessions: number;
  keyPath: string;
  /** Artifact age sweep window in days; 0 disables the sweep. */
  artifactsMaxAgeDays: number;
  /** When false, `node.selfUpdate` refuses with `disabled`. Default true. */
  allowSelfUpdate: boolean;
  /** Persist `--allow-http` so hub-triggered package updates honour it. Default false. */
  allowHttpPackage?: boolean;
  sandbox: NodeSandboxPolicy;
  sandboxPaths?: { allow: NodeSandboxPathsAllow };
}

/** `TIERWYN_NODE_DIR ?? configDir()/node`. */
export function nodeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return envPrefFrom(env, 'NODE_DIR') || join(configDir(env), 'node');
}

export function defaultNodeRoot(home: string = homedir()): string {
  return join(home, BRAND);
}

export function loadNodeConfig(dir?: string): NodeConfig {
  const d = dir ?? nodeConfigDir();
  const raw = JSON.parse(readFileSync(join(d, 'node.json'), 'utf8')) as Partial<NodeConfig>;
  return {
    hubUrl: String(raw.hubUrl ?? ''),
    hostId: String(raw.hostId ?? ''),
    roots: Array.isArray(raw.roots) ? raw.roots.map(String) : [],
    allowedAgents: Array.isArray(raw.allowedAgents) ? raw.allowedAgents.map(String) : [],
    listenPort: typeof raw.listenPort === 'number' ? raw.listenPort : 8788,
    maxSessions: typeof raw.maxSessions === 'number' ? raw.maxSessions : 8,
    keyPath: raw.keyPath ?? join(d, 'key'),
    artifactsMaxAgeDays: typeof raw.artifactsMaxAgeDays === 'number' ? raw.artifactsMaxAgeDays : 90,
    allowSelfUpdate: raw.allowSelfUpdate !== false,
    allowHttpPackage: raw.allowHttpPackage === true,
    sandbox: parseNodeSandboxPolicy(raw.sandbox),
    sandboxPaths: parseSandboxPathsAllow(raw.sandboxPaths),
  };
}

function parseNodeSandboxPolicy(v: unknown): NodeSandboxPolicy {
  if (v === undefined || v === null) return 'allow';
  if (v === 'off' || v === 'allow' || v === 'require') return v;
  throw new Error('node.json: sandbox must be off|allow|require');
}

function parseSandboxPathsAllow(v: unknown): { allow: NodeSandboxPathsAllow } {
  if (v === undefined || v === null) return { allow: 'ro' };
  if (typeof v !== 'object' || Array.isArray(v)) {
    throw new Error('node.json: sandboxPaths must be an object');
  }
  const allow = (v as { allow?: unknown }).allow;
  if (allow === undefined || allow === null) return { allow: 'ro' };
  if (allow === 'none' || allow === 'ro' || allow === 'rw') return { allow };
  throw new Error('node.json: sandboxPaths.allow must be none|ro|rw');
}

export function applyNodeSandboxPolicy(
  want: boolean,
  policy: NodeSandboxPolicy,
  available: boolean,
): boolean {
  const on = want || policy === 'require';
  if (!on) return false;
  if (want && policy === 'off') throw new RpcError('sandbox_disabled_on_node', 'sandbox_disabled_on_node');
  if (!available) throw new RpcError('sandbox_unavailable', 'sandbox_unavailable');
  return true;
}

export function pathUnderRoots(p: string, roots: string[]): string | null {
  let real: string;
  try {
    real = realpathSync(p);
  } catch {
    return null;
  }
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      continue;
    }
    const rel = relative(realRoot, real);
    // `relative()` prefixes outside-root results with `..` — but a directory
    // legitimately named `..foo` inside the root also starts with '..', so
    // test the separator boundary, not just the prefix.
    if (rel === '' || (!isAbsolute(rel) && !(rel === '..' || rel.startsWith(`..${sep}`)))) return real;
  }
  return null;
}

/** Atomic 0600 write of `<dir>/node.json` (tmp + fsync + rename in the same dir). */
export function writeNodeConfigFile(dir: string, obj: Record<string, unknown>): void {
  const tmp = join(dir, `.node.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'wx', 0o600);
    writeFileSync(fd, JSON.stringify(obj, null, 2) + '\n');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tmp, 0o600);
    renameSync(tmp, join(dir, 'node.json'));
  } catch (err) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ }
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

/** Ensure common user-level agent CLI bin directories (`~/.local/bin`,
 *  `~/.npm-global/bin`, `~/.opencode/bin`, `~/.grok/bin`, `~/.kiro/bin`,
 *  `~/.kimi-code/bin`, `~/.bun/bin`, and `~/.local/lib/node-v*\/bin`) are
 *  present on `env.PATH` even when `tierwyn-node.service` runs with a minimal
 *  or stale `node.env`. */
export function ensureAgentPath(env: NodeJS.ProcessEnv = process.env, home: string = homedir(), append = false): void {
  const dirs = [
    join(home, '.local', 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.opencode', 'bin'),
    join(home, '.grok', 'bin'),
    join(home, '.kiro', 'bin'),
    join(home, '.kimi-code', 'bin'),
    join(home, '.bun', 'bin'),
  ];
  try {
    const libDir = join(home, '.local', 'lib');
    if (existsSync(libDir)) {
      for (const name of readdirSync(libDir)) {
        if (name.startsWith('node-v')) {
          const bin = join(libDir, name, 'bin');
          if (existsSync(bin)) dirs.push(bin);
        }
      }
    }
  } catch { /* ignore */ }
  const current = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const seen = new Set(current);
  const prepend: string[] = [];
  for (const d of dirs) {
    if (!seen.has(d)) {
      seen.add(d);
      prepend.push(d);
    }
  }
  if (prepend.length > 0) {
    env.PATH = (append ? [...current, ...prepend] : [...prepend, ...current]).join(delimiter);
  }
}
