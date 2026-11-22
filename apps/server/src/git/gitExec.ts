import { execFile, execFileSync } from 'child_process';
import { existsSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { promisify } from 'util';
import { buildChildEnv, isAlwaysScrubbed } from '../childEnv.js';
import { envPref } from '../config/env.js';

const execFileAsync = promisify(execFile);
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

/**
 * Command-line -c beats every config file (system/global/local/worktree/include).
 * Do not set command-valued keys to empty (`diff.external=`) — git treats that as
 * "run this program" and fails with `cannot run : No such file or directory`.
 * Those are dropped via GIT_ENV_DROP + GIT_CONFIG_NOSYSTEM/GLOBAL=/dev/null, and
 * repo-local copies are refused by assertSafeRepoConfig.
 */
export const GIT_SAFE_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.editor=true',
  'sequence.editor=true',
  'core.pager=cat',
  'protocol.ext.allow=never',
  'protocol.file.allow=user',
  'commit.gpgSign=false',
];

const GIT_ENV_DROP = new Set([
  'GIT_EXTERNAL_DIFF', 'GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_ASKPASS',
  'GIT_EXEC_PATH', 'GIT_PROXY_COMMAND', 'GIT_DIR', 'GIT_WORK_TREE',
  'GIT_COMMON_DIR', 'GIT_PAGER', 'GIT_EDITOR', 'SSH_ASKPASS',
]);

export type GitProfile =
  | 'background'
  | 'operator';

export interface GitRunOpts {
  profile?: GitProfile;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  skipConfigScan?: boolean;
}

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly status: number | null,
    readonly stdout: string = '',
  ) {
    super(stderr.trim() || stdout.trim() || `git ${args.join(' ')} failed`);
    this.name = 'GitCommandError';
  }
}

export class GitUnsafeConfigError extends GitCommandError {
  constructor(
    readonly key: string,
    readonly file: string,
    args: readonly string[] = ['status'],
  ) {
    super(
      [...args],
      `refusing to run git: repo config sets ${key} (possible sandbox escape); remove it or run git yourself`,
      null,
    );
    this.name = 'GitUnsafeConfigError';
  }
}

export function gitArgv(args: readonly string[], profile: GitProfile): string[] {
  const cfg = profile === 'operator'
    ? GIT_SAFE_CONFIG.filter((c) => !c.startsWith('commit.gpgSign='))
    : GIT_SAFE_CONFIG;
  const hooks = envPref('GIT_RUN_HOOKS') === '1' && profile === 'operator';
  return [
    ...cfg.filter((c) => !(hooks && c.startsWith('core.hooksPath='))).flatMap((c) => ['-c', c]),
    ...args,
  ];
}

export function gitEnv(profile: GitProfile, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = buildChildEnv();
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_CONFIG') || GIT_ENV_DROP.has(k)) delete env[k];
  }
  const out: NodeJS.ProcessEnv = extra ? { ...env, ...extra } : { ...env };
  for (const key of Object.keys(out)) {
    if (isAlwaysScrubbed(key)) delete out[key];
    if (key.startsWith('GIT_CONFIG') || GIT_ENV_DROP.has(key)) delete out[key];
  }
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_CONFIG_NOSYSTEM = '1';
  if (profile === 'background') {
    out.GIT_CONFIG_GLOBAL = '/dev/null';
    out.GIT_AUTHOR_NAME = out.GIT_COMMITTER_NAME = 'Tierwyn';
    out.GIT_AUTHOR_EMAIL = out.GIT_COMMITTER_EMAIL = 'tierwyn@localhost';
  }
  if (extra?.GIT_INDEX_FILE) out.GIT_INDEX_FILE = extra.GIT_INDEX_FILE;
  return out;
}

const OPERATOR_CMDS = new Set([
  'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'tag', 'remote',
]);

export function profileFor(args: readonly string[]): GitProfile {
  return OPERATOR_CMDS.has(args[0] ?? '') ? 'operator' : 'background';
}

function wrapExecError(args: readonly string[], e: unknown): GitCommandError {
  if (e instanceof GitCommandError) return e;
  const err = e as {
    stderr?: string | Buffer; stdout?: string | Buffer;
    status?: number | null; message?: string; killed?: boolean; code?: string | number;
  };
  let stderr = typeof err.stderr === 'string'
    ? err.stderr
    : Buffer.isBuffer(err.stderr) ? err.stderr.toString('utf8') : (err.message ?? '');
  if (err.killed || err.code === 'ETIMEDOUT') stderr = 'git timed out';
  const stdout = typeof err.stdout === 'string'
    ? err.stdout
    : Buffer.isBuffer(err.stdout) ? err.stdout.toString('utf8') : '';
  const status = typeof err.code === 'number' ? err.code : (err.status ?? null);
  return new GitCommandError([...args], stderr, status, stdout);
}

function runSync(cwd: string, args: readonly string[], opts: GitRunOpts): string {
  const profile = opts.profile ?? 'background';
  try {
    return execFileSync('git', gitArgv(args, profile), {
      cwd,
      env: gitEnv(profile, opts.env),
      input: opts.input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      // ponytail: 60s cap so a hung git (e.g. `add -A` over a huge untracked dir) cannot block the event loop forever; async snapshotting if 60s ever matters.
      timeout: opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
    });
  } catch (e) {
    throw wrapExecError(args, e);
  }
}

async function runAsync(cwd: string, args: readonly string[], opts: GitRunOpts): Promise<string> {
  const profile = opts.profile ?? 'background';
  try {
    const { stdout } = await execFileAsync('git', gitArgv(args, profile), {
      cwd,
      env: gitEnv(profile, opts.env),
      timeout: opts.timeoutMs,
      maxBuffer: opts.maxBuffer ?? 10 * 1024 * 1024,
      encoding: 'utf8',
    });
    return stdout;
  } catch (e) {
    throw wrapExecError(args, e);
  }
}

const EXEC_KEY_RE = new RegExp([
  String.raw`^(filter|diff|merge)\.[^.]+(\.[^.]+)*\.(clean|smudge|process|textconv|command|driver)$`,
  String.raw`^diff\.external$`,
  String.raw`^submodule\..*\.update$`,
  // ponytail: omit core.worktree (path) and extensions.worktreeconfig (we scan config.worktree).
  String.raw`^core\.(fsmonitor|hookspath|sshcommand|gitproxy|askpass|editor|pager|alternaterefscommand)$`,
  String.raw`^(include|includeif)\.`,
  String.raw`^credential\.`, String.raw`^gpg\.`, String.raw`^sequence\.editor$`,
  String.raw`^uploadpack\.packobjectshook$`, String.raw`^remote\.[^.]+\.(uploadpack|receivepack|vcs)$`,
].join('|'), 'i');

const ALLOWED_EXEC_VALUES: ReadonlyMap<string, string> = new Map([
  ['filter.lfs.clean', 'git-lfs clean -- %f'],
  ['filter.lfs.smudge', 'git-lfs smudge -- %f'],
  ['filter.lfs.process', 'git-lfs filter-process'],
  ['filter.lfs.required', 'true'],
]);

type ScanVerdict = { ok: true } | { ok: false; key: string; file: string };
const scanCache = new Map<string, ScanVerdict>();
const SCAN_CACHE_MAX = 256;
const warnedUnsafe = new Set<string>();

function cacheKey(
  file: string,
  st: { dev: bigint; ino: bigint; ctimeMs: bigint; size: bigint; mtimeMs: bigint },
): string {
  return `${file}\0${st.dev}:${st.ino}:${st.ctimeMs}:${st.size}:${st.mtimeMs}`;
}

function isStandardHooksPath(value: string, cwd: string, gitDir: string, commonDir: string): boolean {
  const resolved = resolve(cwd, value);
  return resolved === resolve(gitDir, 'hooks') || resolved === resolve(commonDir, 'hooks');
}

function scanConfigFile(file: string, cwd: string, gitDir: string, commonDir: string): ScanVerdict {
  let st: { dev: bigint; ino: bigint; ctimeMs: bigint; size: bigint; mtimeMs: bigint; isFile(): boolean };
  try {
    st = statSync(file, { bigint: true });
  } catch {
    throw new GitUnsafeConfigError('(unreadable)', file);
  }
  if (!st.isFile()) {
    throw new GitUnsafeConfigError('(not a regular file)', file);
  }
  const key = cacheKey(file, st);
  const hit = scanCache.get(key);
  if (hit) return hit;

  let listed: string;
  try {
    listed = runSync(process.cwd(), ['config', '--file', file, '--no-includes', '--null', '--list'], {
      profile: 'background',
      skipConfigScan: true,
      timeoutMs: 5000,
    });
  } catch {
    throw new GitUnsafeConfigError('(unreadable)', file);
  }

  let verdict: ScanVerdict = { ok: true };
  for (const entry of listed.split('\0')) {
    if (!entry) continue;
    const nl = entry.indexOf('\n');
    const cfgKey = (nl === -1 ? entry : entry.slice(0, nl)).trim();
    const value = nl === -1 ? '' : entry.slice(nl + 1);
    if (!cfgKey || !EXEC_KEY_RE.test(cfgKey)) continue;
    if (ALLOWED_EXEC_VALUES.get(cfgKey.toLowerCase()) === value) continue;
    if (cfgKey.toLowerCase() === 'core.hookspath' && isStandardHooksPath(value, cwd, gitDir, commonDir)) continue;
    verdict = { ok: false, key: cfgKey, file };
    break;
  }
  if (scanCache.size >= SCAN_CACHE_MAX) {
    const first = scanCache.keys().next().value;
    if (first !== undefined) scanCache.delete(first);
  }
  scanCache.set(key, verdict);
  return verdict;
}

export function assertSafeRepoConfig(cwd: string): void {
  let gitDir: string;
  let commonDir: string;
  try {
    const out = runSync(cwd, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir'], {
      profile: 'background',
      skipConfigScan: true,
      timeoutMs: 5000,
    }).trim();
    const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    gitDir = lines[0]!;
    commonDir = lines[1] ?? gitDir;
  } catch {
    return;
  }

  const files = new Set<string>();
  files.add(join(commonDir, 'config'));
  files.add(join(gitDir, 'config.worktree'));
  files.add(join(commonDir, 'config.worktree'));
  for (const file of files) {
    if (!existsSync(file)) continue;
    const verdict = scanConfigFile(file, cwd, gitDir, commonDir);
    if (verdict.ok) continue;
    const warnKey = `${verdict.file}:${verdict.key}`;
    if (!warnedUnsafe.has(warnKey)) {
      warnedUnsafe.add(warnKey);
      console.warn('[git] unsafe repo config', verdict.key, verdict.file);
    }
    throw new GitUnsafeConfigError(verdict.key, verdict.file);
  }
}

export function gitSync(cwd: string, args: readonly string[], opts: GitRunOpts = {}): string {
  if (!opts.skipConfigScan) assertSafeRepoConfig(cwd);
  return runSync(cwd, args, opts);
}

export async function gitAsync(cwd: string, args: readonly string[], opts: GitRunOpts = {}): Promise<string> {
  if (!opts.skipConfigScan) assertSafeRepoConfig(cwd);
  return runAsync(cwd, args, opts);
}

export const gitExecSafe = gitSync;
export const gitExecSafeAsync = gitAsync;
export const scanLocalConfigForExec = assertSafeRepoConfig;
