import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'child_process';
import { gitSync } from '../git/gitExec.js';
import { existsSync, readdirSync, readFileSync, statSync, realpathSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import type { SandboxPath } from '@tierwyn/shared';
import type { SandboxProfile } from './profiles.js';
import { hasSandboxProfile, SANDBOX_PROFILES } from './profiles.js';
import { checkCustomPath } from './customPaths.js';
import { dbPathFromEnv } from '../config/env.js';
import { escalateKill } from '../adapters/escalateKill.js';

export type SpawnLike = typeof spawn;

export type SandboxErrorCode =
  | 'sandbox_unavailable'
  | 'sandbox_unsupported_agent'
  | 'sandbox_no_cwd'
  | 'sandbox_path_missing'
  | 'sandbox_path_denied';

export class SandboxError extends Error {
  name = 'SandboxError';
  constructor(
    public code: SandboxErrorCode,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export interface BwrapInput {
  cmd: string;
  args: string[];
  cwd: string;
  home: string;
  profile: SandboxProfile;
  gitCommonDir?: string;
  gitDir?: string;
  tierwynRoot: string;
  exists: (p: string) => boolean;
  /** Absolute dirs/files never visible inside. Defaults to defaultDenyPaths(home). */
  deny?: string[];
  /** Absolute dirs whose regular files may be bound from argv even though they are under `deny`. */
  argvAllow?: string[];
  /** Injectable for tests: is p a regular file? */
  isFile?: (p: string) => boolean;
  /** Extra absolute ro binds (e.g. binary dir under home). */
  extraRo?: string[];
  /** Host ∪ project custom binds. Deny masks must run after these. */
  customPaths?: SandboxPath[];
  /** Node.json roots; rw custom paths must sit strictly inside one of these. */
  roots?: string[];
  /** Extra hard-deny trees merged into the deny list (node dir, key, storage). */
  extraDeny?: string[];
  /** Current agent type — used to skip that agent's own profile dirs in hard-deny. */
  agentType?: string;
  /** Injectable for tests: list directory entries under tierwynRoot for `.env*` deny. */
  listDir?: (dir: string) => string[];
  /** Injectable for tests (default realpathSync; on throw, skip the arg). */
  realpath?: (p: string) => string;
}

export const HOME_DENY: readonly string[] = [
  '.config/tierwyn',
  '.ssh',
  '.git-credentials',
  '.gnupg',
];

export const HOME_TOOLCHAINS: readonly string[] = [
  '.nvm',
  '.local/bin',
  '.local/lib',
  '.npm-global',
  '.bun',
  '.volta',
  '.cargo/bin',
  '.deno',
  'go/bin',
  '.pyenv',
  '.local/share/pnpm',
  '.opencode/bin',
];

/** Host trees never auto-bound from argv, even when they resolve to a regular file. */
export const ARGV_NEVER_BIND = ['/proc', '/sys', '/dev', '/run', '/etc', '/boot', '/root', '/var/lib', '/var/run'] as const;

const SYSTEM_RO = [
  '/usr',
  '/etc',
  '/bin',
  '/sbin',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/opt',
  '/sys',
  '/run/systemd/resolve',
] as const;

let bwrapProbeCache: boolean | undefined;

function hubDataDir(): string | undefined {
  const dbPath = dbPathFromEnv();
  if (dbPath === ':memory:') return undefined;
  return resolve(dirname(dbPath));
}

/** Hub operator secrets outside $HOME (masked under the `/etc` bind). */
export const SYSTEM_DENY: readonly string[] = ['/etc/tierwyn'];

export function defaultDenyPaths(home: string): string[] {
  const out: string[] = [];
  for (const rel of HOME_DENY) {
    out.push(resolve(home, rel));
  }
  const data = hubDataDir();
  if (data) out.push(data);
  for (const p of SYSTEM_DENY) out.push(p);
  return out;
}

/** `.env*` under the repo root except `.env.example` (masked under the tierwynRoot bind). */
export function tierwynEnvDenyPaths(
  tierwynRoot: string,
  exists: (p: string) => boolean,
  listEntries: (dir: string) => string[] = (d) => {
    try {
      return readdirSync(d);
    } catch {
      return [];
    }
  },
): string[] {
  if (!exists(tierwynRoot)) return [];
  return listEntries(tierwynRoot)
    .filter((name) => name.startsWith('.env') && name !== '.env.example')
    .map((name) => resolve(tierwynRoot, name))
    .filter((p) => exists(p));
}

function mergeDeny(
  home: string,
  tierwynRoot: string,
  exists: (p: string) => boolean,
  override?: string[],
  listDir?: (dir: string) => string[],
  extraDeny?: string[],
): string[] {
  const base = override ?? defaultDenyPaths(home);
  const extra = [
    ...SYSTEM_DENY,
    ...tierwynEnvDenyPaths(tierwynRoot, exists, listDir),
    ...(extraDeny ?? []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...base, ...extra]) {
    const abs = normAbs(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

function defaultArgvAllow(home: string): string[] {
  const data = hubDataDir();
  if (!data) return [];
  return [join(data, 'attachments')];
}

function normAbs(p: string): string {
  return resolve(p);
}

function dedupeCustomPaths(paths: readonly SandboxPath[]): SandboxPath[] {
  const by = new Map<string, SandboxPath>();
  for (const p of paths) {
    const abs = normAbs(p.path);
    const existing = by.get(abs);
    if (!existing) {
      by.set(abs, { path: abs, mode: p.mode, ...(p.optional !== undefined ? { optional: p.optional } : {}) });
      continue;
    }
    const mode: 'ro' | 'rw' = existing.mode === 'rw' && p.mode === 'rw' ? 'rw' : 'ro';
    const optional = existing.optional === false || p.optional === false
      ? false
      : (existing.optional ?? p.optional);
    by.set(abs, { path: abs, mode, ...(optional !== undefined ? { optional } : {}) });
  }
  return [...by.values()];
}

function pathEqualOrInside(inner: string, outer: string): boolean {
  const i = normAbs(inner);
  const o = normAbs(outer);
  return i === o || i.startsWith(o + '/');
}

function strictlyInside(inner: string, outer: string): boolean {
  const i = normAbs(inner);
  const o = normAbs(outer);
  return i !== o && i.startsWith(o + '/');
}

function validateProfileRel(p: string): void {
  if (!p || p.startsWith('/') || p.includes('..')) {
    throw new Error(`sandbox profile path denied: ${p}`);
  }
  for (const deny of HOME_DENY) {
    if (p === deny || p.startsWith(deny + '/') || deny.startsWith(p + '/')) {
      throw new Error(`sandbox profile path denied: ${p}`);
    }
  }
}

function profileAbsPaths(home: string, profile: SandboxProfile): string[] {
  const rels = [...profile.rw, ...(profile.ro ?? [])];
  return rels.map((r) => resolve(home, r));
}

function defaultIsFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function pushRo(argv: string[], bound: string[], p: string): void {
  if (!p) return;
  const abs = normAbs(p);
  argv.push('--ro-bind', abs, abs);
  bound.push(abs);
}

function pushRw(argv: string[], bound: string[], p: string): void {
  if (!p) return;
  const abs = normAbs(p);
  argv.push('--bind', abs, abs);
  bound.push(abs);
}

function pushTmpfs(argv: string[], bound: string[], p: string): void {
  const abs = normAbs(p);
  argv.push('--tmpfs', abs);
  bound.push(abs);
}

export function buildBwrapArgv(i: BwrapInput): string[] {
  const home = normAbs(i.home);
  const cwd = normAbs(i.cwd);
  const tierwynRoot = normAbs(i.tierwynRoot);
  const exists = i.exists;
  const isFile = i.isFile ?? defaultIsFile;
  const deny = mergeDeny(home, tierwynRoot, exists, i.deny, i.listDir, i.extraDeny);
  const argvAllow = i.argvAllow ?? defaultArgvAllow(home);
  const realpath = i.realpath ?? ((p: string) => realpathSync(p));
  const sanitiseGitDir = (raw?: string): string | undefined => {
    if (!raw) return undefined;
    let dir = normAbs(raw);
    try {
      dir = normAbs(realpath(dir));
    } catch {
      return undefined;
    }
    if (
      pathEqualOrInside(home, dir)
      || dir === '/'
      || deny.some((d) => pathEqualOrInside(dir, d))
    ) {
      return undefined;
    }
    return dir;
  };
  let gitCommonDir = sanitiseGitDir(i.gitCommonDir);
  let gitDir = sanitiseGitDir(i.gitDir);

  for (const rel of [...i.profile.rw, ...(i.profile.ro ?? [])]) {
    validateProfileRel(rel);
  }

  if (pathEqualOrInside(home, cwd)) {
    throw new SandboxError('sandbox_no_cwd', 'cwd must not be home or an ancestor of home');
  }

  for (const d of deny) {
    if (pathEqualOrInside(cwd, d)) {
      throw new SandboxError('sandbox_no_cwd', 'cwd is inside a denied path');
    }
  }

  const argv: string[] = [];
  const boundSources: string[] = [];

  argv.push('--die-with-parent', '--unshare-pid', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp');

  for (const d of SYSTEM_RO) {
    if (exists(d)) pushRo(argv, boundSources, d);
  }

  pushTmpfs(argv, boundSources, home);

  for (const rel of HOME_TOOLCHAINS) {
    const p = join(home, rel);
    if (exists(p)) pushRo(argv, boundSources, p);
  }
  const gitconfig = join(home, '.gitconfig');
  if (exists(gitconfig)) pushRo(argv, boundSources, gitconfig);

  for (const rel of i.profile.ro ?? []) {
    const p = join(home, rel);
    if (exists(p)) pushRo(argv, boundSources, p);
  }

  if (exists(tierwynRoot)) pushRo(argv, boundSources, tierwynRoot);

  for (const p of i.extraRo ?? []) {
    if (exists(p)) pushRo(argv, boundSources, p);
  }

  const profAbs = profileAbsPaths(home, i.profile);

  const allowedHomeFile = (abs: string): boolean => {
    if (!pathEqualOrInside(abs, home)) return true;
    if (pathEqualOrInside(abs, tierwynRoot)) return true;
    if (pathEqualOrInside(abs, cwd)) return true;
    if (gitCommonDir && pathEqualOrInside(abs, gitCommonDir)) return true;
    for (const allow of argvAllow) {
      if (pathEqualOrInside(abs, allow)) return true;
    }
    for (const pp of profAbs) {
      if (pathEqualOrInside(abs, pp)) return true;
    }
    return false;
  };

  const inDenyUnlessArgvAllow = (abs: string): boolean => {
    for (const d of deny) {
      if (!pathEqualOrInside(abs, d)) continue;
      for (const allow of argvAllow) {
        if (pathEqualOrInside(abs, allow)) return false;
      }
      return true;
    }
    return false;
  };

  const rwHomePaths = ['.npm', '.cache', ...i.profile.rw];
  for (const rel of rwHomePaths) {
    const p = join(home, rel);
    if (exists(p)) pushRw(argv, boundSources, p);
  }

  pushRw(argv, boundSources, cwd);

  if (
    gitCommonDir
    && !pathEqualOrInside(gitCommonDir, cwd)
    && exists(gitCommonDir)
  ) {
    pushRw(argv, boundSources, gitCommonDir);
  }

  const customCtx = {
    home,
    cwd,
    repoRoot: tierwynRoot,
    agentType: i.agentType ?? '',
    dataDir: hubDataDir(),
    realpath,
    ...(i.roots?.length ? { roots: i.roots } : {}),
    ...(i.extraDeny?.length ? { extraDeny: i.extraDeny } : {}),
  };
  const customList = dedupeCustomPaths(i.customPaths ?? [])
    .sort((a, b) => a.path.length - b.path.length);
  for (const p of customList) {
    const checked = checkCustomPath(p, customCtx);
    if (!checked.ok) {
      if (p.optional === false) {
        throw new SandboxError('sandbox_path_denied', p.path);
      }
      continue;
    }
    let real = p.path;
    try {
      real = normAbs(realpath(p.path));
    } catch {
      real = p.path;
    }
    const present = exists(p.path) || exists(real);
    if (!present) {
      if (p.optional === false) {
        throw new SandboxError('sandbox_path_missing', p.path);
      }
      continue;
    }
    if (p.mode === 'rw') pushRw(argv, boundSources, p.path);
    else pushRo(argv, boundSources, p.path);
  }

  // HIGH-1 defence-in-depth: agent may edit tracked files but not git's exec surface.
  // Self-bind cwd/.git so it is a mount point: `mv .git .gitold` then fails with EBUSY.
  const gitCtl = (dir: string) => [
    join(dir, 'config'), join(dir, 'hooks'), join(dir, 'info'),
    join(dir, 'config.worktree'), join(dir, 'commondir'),
  ];
  const ctlRoots = new Set<string>();
  const dotGit = join(cwd, '.git');
  if (exists(dotGit) && !isFile(dotGit)) {
    argv.push('--bind', dotGit, dotGit);
    ctlRoots.add(dotGit);
  }
  if (gitCommonDir) ctlRoots.add(gitCommonDir);
  if (gitDir) ctlRoots.add(gitDir);
  for (const root of ctlRoots) {
    for (const p of gitCtl(root)) {
      if (exists(p)) {
        argv.push('--ro-bind', p, p);
        continue;
      }
      if (basename(p) === 'hooks') {
        argv.push('--tmpfs', p, '--remount-ro', p);
      }
    }
  }
  if (exists(dotGit) && isFile(dotGit)) argv.push('--ro-bind', dotGit, dotGit);

  for (const d of deny) {
    if (!exists(d)) continue;
    let masked = false;
    for (const src of boundSources) {
      if (strictlyInside(d, src)) {
        masked = true;
        break;
      }
    }
    if (!masked) continue;
    if (isFile(d)) {
      argv.push('--ro-bind', '/dev/null', d);
    } else {
      argv.push('--tmpfs', d);
    }
  }

  // ponytail: --flag=/path argv forms are not handled in Phase A.
  for (const a of i.args) {
    if (!a.startsWith('/')) continue;
    const lexical = normAbs(a);
    let real: string;
    try {
      real = normAbs(realpath(lexical));
    } catch {
      continue;
    }
    if (!exists(lexical) && !exists(real)) continue;
    if (!isFile(lexical) && !isFile(real)) continue;
    if (ARGV_NEVER_BIND.some((d) => pathEqualOrInside(lexical, d) || pathEqualOrInside(real, d))) continue;
    if (pathEqualOrInside(lexical, cwd) || pathEqualOrInside(real, cwd)) continue;
    if (inDenyUnlessArgvAllow(lexical) || inDenyUnlessArgvAllow(real)) continue;
    if (!allowedHomeFile(lexical) || !allowedHomeFile(real)) continue;
    argv.push('--ro-bind', real, lexical);
    boundSources.push(real);
  }

  argv.push('--chdir', cwd, '--', i.cmd, ...i.args);
  return argv;
}

export function bwrapAvailable(): boolean {
  if (bwrapProbeCache !== undefined) return bwrapProbeCache;
  const r = spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-pid', 'true'], {
    stdio: 'ignore',
    timeout: 5000,
  });
  bwrapProbeCache = !r.error && r.status === 0;
  return bwrapProbeCache;
}

export function _resetBwrapProbeForTests(): void {
  bwrapProbeCache = undefined;
}

function resolveOnPath(cmd: string): string | undefined {
  // Packaged nodes hand the SDK an absolute claude path; join(dir, '/abs') never exists.
  if (cmd.includes('/')) return existsSync(cmd) ? cmd : undefined;
  const pathEnv = process.env.PATH ?? '';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function binaryExtraRo(cmd: string, home: string): string[] {
  const out: string[] = [];
  const bin = resolveOnPath(cmd);
  if (!bin) return out;
  const binDir = dirname(bin);
  try {
    const real = realpathSync(bin);
    const realDir = dirname(real);
    if (pathEqualOrInside(realDir, home)) out.push(realDir);
  } catch { /* ignore */ }
  if (pathEqualOrInside(binDir, home)) out.push(binDir);
  return [...new Set(out.map(normAbs))];
}

function normalizeSpawnCwd(cwd: SpawnOptions['cwd']): string | undefined {
  if (cwd == null) return undefined;
  if (typeof cwd === 'string') return resolve(cwd);
  if (cwd instanceof URL) return resolve(fileURLToPath(cwd));
  return resolve(String(cwd));
}

/** Merge `PWD=<cwd>` into spawn opts so unsandboxed children match bwrap `--chdir`. */
export function applySpawnPwd(opts?: SpawnOptions): SpawnOptions | undefined {
  if (!opts) return opts;
  const cwd = normalizeSpawnCwd(opts.cwd);
  if (!cwd) return opts;
  return {
    ...opts,
    env: { ...(opts.env ?? process.env), PWD: cwd },
  };
}

/** Wrap any spawn impl so `opts.cwd` always becomes `env.PWD`. */
export function withPwdSpawn(inner: SpawnLike): SpawnLike {
  return ((cmd, a?, o?) => {
    const args = Array.isArray(a) ? a : [];
    const raw = (Array.isArray(a) ? o : a) as SpawnOptions | undefined;
    const opts = applySpawnPwd(raw) ?? raw ?? {};
    return inner(cmd, args, opts);
  }) as SpawnLike;
}

export type SandboxTreeDeps = {
  childrenOf?: (pid: number) => number[];
  isBwrap?: (pid: number) => boolean;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
};

function defaultChildrenOf(pid: number): number[] {
  try {
    const raw = readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
    if (!raw) return [];
    return raw.split(/\s+/).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function defaultIsBwrap(pid: number): boolean {
  try {
    const cmd = readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    return cmd === 'bwrap';
  } catch {
    return false;
  }
}

function collectDescendants(root: number, childrenOf: (pid: number) => number[]): number[] {
  const out: number[] = [];
  const seen = new Set<number>([root]);
  const stack = [...childrenOf(root)];
  while (stack.length) {
    const pid = stack.pop()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push(pid);
    stack.push(...childrenOf(pid));
  }
  return out;
}

/**
 * Signal non-bwrap descendants first so the CLI can handle SIGTERM and flush
 * state before outer bwrap's `--die-with-parent` would SIGKILL it.
 * Falls back to process-group kill when no CLI descendant is visible.
 */
export function signalSandboxTree(
  rootPid: number,
  signal: NodeJS.Signals,
  deps: SandboxTreeDeps = {},
): void {
  const childrenOf = deps.childrenOf ?? defaultChildrenOf;
  const isBwrap = deps.isBwrap ?? defaultIsBwrap;
  const kill = deps.kill ?? ((pid, sig) => { process.kill(pid, sig); });

  const descendants = collectDescendants(rootPid, childrenOf);
  const targets = descendants.filter((pid) => !isBwrap(pid));
  if (targets.length === 0) {
    kill(-rootPid, signal);
    return;
  }
  for (const pid of targets) {
    try { kill(pid, signal); } catch { /* ESRCH */ }
  }
}

/**
 * Graceful stop for a sandboxed (bwrap) child: SIGTERM the inner CLI first,
 * then arm group escalation so a hung tree is still reaped.
 */
export function termSandboxChild(
  child: ChildProcess | null | undefined,
  deps: SandboxTreeDeps = {},
): void {
  if (!child?.pid) {
    try { child?.kill('SIGTERM'); } catch { /* gone */ }
    return;
  }
  try {
    signalSandboxTree(child.pid, 'SIGTERM', deps);
  } catch {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {
      try { child.kill('SIGTERM'); } catch { /* gone */ }
    }
  }
  escalateKill(child, { group: true });
}

/**
 * Adapter stop helper: when the leader is bwrap, signal the inner CLI first;
 * otherwise keep the historic process-group / direct kill behaviour.
 */
export function termChildProcess(
  child: ChildProcess | null | undefined,
  opts: { group?: boolean } = {},
): void {
  if (!child) return;
  const pid = child.pid;
  if (pid && defaultIsBwrap(pid)) {
    termSandboxChild(child);
    return;
  }
  try {
    if (opts.group && pid) {
      try { process.kill(-pid, 'SIGTERM'); }
      catch { child.kill('SIGTERM'); }
    } else {
      child.kill('SIGTERM');
    }
  } catch { /* already gone */ }
}

function wrapSandboxChild(child: ChildProcess): ChildProcess {
  const origKill = child.kill.bind(child);
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (typeof signal === 'number' && signal !== 0) {
      return origKill(signal);
    }
    const sig = (typeof signal === 'string' ? signal : 'SIGTERM') as NodeJS.Signals;
    if (sig === 'SIGKILL') return origKill(sig);
    termSandboxChild(child);
    return true;
  }) as ChildProcess['kill'];
  return child;
}

export type SandboxSpawnExtras = {
  customPaths?: SandboxPath[];
  roots?: string[];
  extraDeny?: string[];
};

export function sandboxSpawnFor(agent: string | undefined, extras?: SandboxSpawnExtras): SpawnLike {
  if (agent === undefined) return spawn;

  return ((cmd, a?, o?) => {
    const args = Array.isArray(a) ? a : [];
    const rawOpts = (Array.isArray(a) ? o : a) as SpawnOptions | undefined;

    if (!hasSandboxProfile(agent)) {
      throw new SandboxError('sandbox_unsupported_agent');
    }
    if (!rawOpts?.cwd) {
      throw new SandboxError('sandbox_no_cwd');
    }
    const cwd = normalizeSpawnCwd(rawOpts.cwd);
    if (!cwd) {
      throw new SandboxError('sandbox_no_cwd');
    }
    if (!bwrapAvailable()) {
      throw new SandboxError('sandbox_unavailable');
    }

    let gitCommonDir: string | undefined;
    let gitDir: string | undefined;
    try {
      const raw = gitSync(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
        skipConfigScan: true,
      }).trim();
      try {
        gitCommonDir = realpathSync(raw);
      } catch {
        gitCommonDir = raw;
      }
    } catch {
      gitCommonDir = undefined;
    }
    try {
      const raw = gitSync(cwd, ['rev-parse', '--path-format=absolute', '--git-dir'], {
        skipConfigScan: true,
      }).trim();
      try {
        gitDir = realpathSync(raw);
      } catch {
        gitDir = raw;
      }
    } catch {
      gitDir = undefined;
    }

    const home = os.homedir();
    const tierwynRoot = resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../..',
    );
    const profile = SANDBOX_PROFILES[agent];
    const extraRo = binaryExtraRo(cmd, home);

    const bwrapArgv = buildBwrapArgv({
      cmd,
      args,
      cwd,
      home,
      profile,
      gitCommonDir,
      gitDir,
      tierwynRoot,
      exists: existsSync,
      extraRo,
      customPaths: extras?.customPaths,
      agentType: agent,
      roots: extras?.roots,
      extraDeny: extras?.extraDeny,
    });

    const opts = applySpawnPwd(rawOpts) ?? rawOpts;
    return wrapSandboxChild(spawn('bwrap', bwrapArgv, opts));
  }) as SpawnLike;
}
