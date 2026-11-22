/**
 * Grok Bot lifecycle supervisor. Ensures the desktop app is running when the
 * operator wants it, without blocking Tierwyn boot (fail-open).
 *
 * Construction is pure. start() only arms an unref'd timer. Every public async
 * body is try/caught into state. Never kills an instance Tierwyn did not launch.
 */
import { execFile, spawn, type ChildProcess } from 'child_process';
import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, readlinkSync,
  statSync, unlinkSync, writeSync,
} from 'fs';
import { basename, isAbsolute, join } from 'path';
import { homedir as osHomedir, hostname as osHostname, tmpdir } from 'os';
import type { Database } from 'better-sqlite3';
import type {
  GrokBotAutoStart, GrokBotInstallLayout, GrokBotLauncher,
  GrokBotLifecycleState, GrokBotLifecycleStatus,
} from '@tierwyn/shared';
import { envPrefFrom } from '../../config/env.js';
import { AGENT_BINARIES } from '../../discovery.js';
import { getAgent } from '../../repositories/models.js';
import { buildChildEnv } from '../../childEnv.js';
import { cdpPort, type Health } from './app.js';
import { discoverPageTarget } from './cdp.js';

export const BOOT_DELAY_MS = 5_000;
export const START_TIMEOUT_MS = 30_000;
export const POLL_INTERVAL_MS = 1_000;
export const PORT_CONFLICT_GRACE_MS = 20_000;
export const FOREIGN_GRACE_MS = 20_000;
export const CADENCE_MS = 60_000;
export const FAILED_CADENCE_MS = 5 * 60_000;
export const PROBE_STALE_MS = 8_000;
export const LAUNCH_LADDER_MS = [30_000, 120_000, 600_000, 1_800_000];
export const MAX_ATTEMPTS = 5;
export const ADHOC_UNIT = 'tierwyn-grokbot-adhoc';
export const LOCK_NAME = 'tierwyn-grokbot.launch.lock';
export const DEFAULT_UNIT = 'tierwyn-grokbot.service';

const DISPLAY_KEYS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'] as const;
const HINT = AGENT_BINARIES['grok-bot']?.hint ?? 'Install Grok Bot desktop';

export type EnsureReason = 'periodic' | 'on-demand' | 'prompt' | 'manual';

export type ProbeResult = 'ok' | 'no-target' | 'down';

export type RunResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

export type SpawnHandle = {
  pid?: number;
  on(event: string, cb: (...args: unknown[]) => void): unknown;
  unref(): void;
  kill?(signal?: NodeJS.Signals): boolean;
};

export type ProcFs = { root: string };

export type ScannedProc = {
  pid: number;
  exe: string;
  argv0: string;
  cmdline: string;
  cgroup: string;
  isMain: boolean;
};

export type SupervisorDeps = {
  db?: Database;
  bin?: string;
  unit?: string;
  port?: number;
  env?: NodeJS.ProcessEnv;
  isEnabled: () => boolean;
  policy: () => GrokBotAutoStart;
  onTransition: (s: GrokBotLifecycleStatus) => void;
  notify: (s: GrokBotLifecycleStatus) => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  probe?: (port: number) => Promise<ProbeResult>;
  procFs?: ProcFs;
  run?: (cmd: string, argv: string[], opts: { timeoutMs: number }) => Promise<RunResult>;
  spawnDetached?: (bin: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => SpawnHandle;
  health: () => Health;
  log?: (msg: string) => void;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  hostname?: () => string;
  exists?: (path: string) => boolean;
  isPidAlive?: (pid: number) => boolean;
  killPid?: (pid: number, signal?: NodeJS.Signals) => void;
};

export interface GrokBotSupervisor {
  start(): void;
  stop(): void;
  status(): GrokBotLifecycleStatus;
  ensureRunning(reason: EnsureReason): Promise<GrokBotLifecycleStatus>;
  kick(): void;
  refresh(): void;
  probeIfStale(): Promise<GrokBotLifecycleStatus>;
}

export function grokBotEnabled(db: Database): boolean {
  return getAgent(db, 'grok-bot')?.enabled === true;
}

export function resolveBin(env: NodeJS.ProcessEnv = process.env): string {
  return envPrefFrom(env, 'GROKBOT_BIN')?.trim() || AGENT_BINARIES['grok-bot']?.bin || '/opt/Grok Bot/grok-bot';
}

/** Env override, else the default unit. */
export function resolveUnit(env: NodeJS.ProcessEnv = process.env): string {
  return envPrefFrom(env, 'GROKBOT_UNIT')?.trim() || DEFAULT_UNIT;
}

export function autostartEnvAllowsLaunch(env: NodeJS.ProcessEnv = process.env): boolean {
  return envPrefFrom(env, 'GROKBOT_AUTOSTART') !== '0';
}

export function classifyLayout(bin: string): GrokBotInstallLayout {
  const lower = bin.replace(/\\/g, '/');
  if (lower.startsWith('/snap/') || lower.includes('/snap/')) return 'snap';
  if (lower.includes('/flatpak/')) return 'flatpak';
  if (/\.AppImage$/i.test(bin)) return 'appimage';
  return 'native';
}

export function validateBin(bin: string): { ok: true } | { ok: false; error: string } {
  if (!bin || !isAbsolute(bin)) return { ok: false, error: `BIN must be an absolute path (${HINT})` };
  try {
    const st = statSync(bin);
    if (!st.isFile()) return { ok: false, error: `BIN is not a regular file (${HINT})` };
    const mode = st.mode;
    if ((mode & 0o111) === 0) return { ok: false, error: `BIN is not executable (${HINT})` };
    if ((mode & 0o022) !== 0) return { ok: false, error: `BIN is group- or world-writable (${HINT})` };
    return { ok: true };
  } catch {
    return { ok: false, error: `BIN missing (${HINT})` };
  }
}

export function scanGrokBotProcesses(bin: string, procFs: ProcFs): ScannedProc[] {
  const out: ScannedProc[] = [];
  let names: string[] = [];
  try { names = readdirSync(procFs.root); } catch { return out; }
  const wantExe = (() => { try { return readlinkSync(bin); } catch { return bin; } })();
  const wantBase = basename(bin);
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    const dir = join(procFs.root, name);
    let exe = '';
    let cmdline = '';
    let cgroup = '';
    try { exe = readlinkSync(join(dir, 'exe')); } catch { /* vanish */ }
    try { cmdline = readFileSync(join(dir, 'cmdline'), 'utf8'); } catch { continue; }
    try {
      const raw = readFileSync(join(dir, 'cgroup'), 'utf8').trim();
      const lines = raw.split('\n');
      cgroup = (lines[lines.length - 1] ?? '').replace(/^[^:]*:[^:]*:/, '');
    } catch { /* optional */ }
    const parts = cmdline.split('\0').filter(Boolean);
    const argv0 = parts[0] ?? '';
    const isMain = !parts.some((p) => p === '--type=' || p.startsWith('--type='));
    const exeMatch = exe === bin || exe === wantExe;
    const baseMatch = basename(argv0) === wantBase;
    if (!exeMatch && !baseMatch) continue;
    out.push({ pid, exe, argv0, cmdline, cgroup, isMain });
  }
  return out;
}

export function acquireLaunchLock(
  lockPath: string,
  isPidAlive: (pid: number) => boolean,
): { held: 'ours' | 'theirs'; fd?: number } {
  try {
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    return { held: 'ours', fd };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw err;
    let pid = 0;
    try { pid = Number(readFileSync(lockPath, 'utf8').trim()); } catch { pid = 0; }
    if (pid > 0 && isPidAlive(pid)) return { held: 'theirs' };
    try { unlinkSync(lockPath); } catch { /* race */ }
    const fd = openSync(lockPath, 'wx');
    writeSync(fd, String(process.pid));
    return { held: 'ours', fd };
  }
}

export function releaseLaunchLock(lockPath: string, fd?: number): void {
  try { if (fd != null) closeSync(fd); } catch { /* already closed */ }
  try { unlinkSync(lockPath); } catch { /* gone */ }
}

export function readStaleSingletonLock(opts: {
  homedir: string;
  hostname: string;
  bin: string;
  isPidAlive: (pid: number) => boolean;
  readlink?: (p: string) => string;
}): { path: string; host: string; pid: number; stale: boolean } | null {
  const lockPath = join(opts.homedir, '.config', 'Grok Bot', 'SingletonLock');
  const readlink = opts.readlink ?? ((p: string) => readlinkSync(p));
  let target: string;
  try { target = readlink(lockPath); } catch { return null; }
  const m = target.match(/^(.+)-(\d+)$/);
  if (!m) return null;
  const host = m[1]!;
  const pid = Number(m[2]);
  if (host !== opts.hostname) return { path: lockPath, host, pid, stale: false };
  const alive = opts.isPidAlive(pid);
  if (!alive) return { path: lockPath, host, pid, stale: true };
  let exe = '';
  try { exe = readlinkSync(`/proc/${pid}/exe`); } catch { return { path: lockPath, host, pid, stale: true }; }
  if (exe !== opts.bin) return { path: lockPath, host, pid, stale: true };
  return { path: lockPath, host, pid, stale: false };
}

export function supervisorMessage(status: GrokBotLifecycleStatus, port: number = cdpPort()): string {
  const err = status.lastError ? `: ${status.lastError}` : '';
  switch (status.state) {
    case 'failed':
      return `Grok Bot failed to start after ${MAX_ATTEMPTS} attempts${err} — Retry in Settings → Grok Bot`;
    case 'running-no-cdp':
      return status.lastError
        ?? `Grok Bot is running without remote debugging. Add \`--remote-debugging-port=${port}\` to \`~/.config/grok-bot/electron-flags.conf\` and restart it.`;
    case 'port-conflict':
      return status.lastError ?? 'Something else is answering on the Grok Bot CDP port.';
    case 'not-installed':
      return status.lastError ?? HINT;
    case 'no-display':
      return 'No graphical session — log in to the desktop';
    case 'disabled':
      return 'Grok Bot is disabled — enable in Settings → Grok Bot';
    case 'unsupported':
      return 'Grok Bot auto-start is only supported on Linux';
    case 'backoff':
    case 'starting':
      return `Starting Grok Bot${err}`;
    default:
      return status.lastError ?? `Grok Bot is ${status.state}`;
  }
}

function defaultProbe(port: number): Promise<ProbeResult> {
  const base = `http://127.0.0.1:${port}`;
  return (async () => {
    try {
      const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return 'down';
    } catch {
      return 'down';
    }
    try {
      await discoverPageTarget(port);
      return 'ok';
    } catch {
      return 'no-target';
    }
  })();
}

function defaultRun(cmd: string, argv: string[], opts: { timeoutMs: number }): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(cmd, argv, { timeout: opts.timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      const err = error as (NodeJS.ErrnoException & { status?: number }) | null;
      resolve({
        code: err ? (typeof err.status === 'number' ? err.status : err.code === 'ENOENT' ? null : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(stderr ?? ''),
        error: err ?? undefined,
      });
    });
  });
}

function defaultSpawn(bin: string, argv: string[], opts: { env: NodeJS.ProcessEnv }): SpawnHandle {
  return spawn(bin, argv, { detached: true, stdio: 'ignore', env: opts.env }) as ChildProcess as SpawnHandle;
}

function defaultIsPidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function parseShowEnvironment(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split('\n')) {
    const i = line.indexOf('=');
    if (i <= 0) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function x11SocketPath(display: string): string | null {
  const m = display.match(/^:(\d+)/);
  return m ? `/tmp/.X11-unix/X${m[1]}` : null;
}

export function createGrokBotSupervisor(deps: SupervisorDeps): GrokBotSupervisor {
  return new Supervisor(deps);
}

class Supervisor implements GrokBotSupervisor {
  private readonly deps: SupervisorDeps & {
    now: () => number;
    setTimer: (fn: () => void, ms: number) => unknown;
    clearTimer: (h: unknown) => void;
    probe: (port: number) => Promise<ProbeResult>;
    procFs: ProcFs;
    run: (cmd: string, argv: string[], opts: { timeoutMs: number }) => Promise<RunResult>;
    spawnDetached: (bin: string, argv: string[], opts: { env: NodeJS.ProcessEnv }) => SpawnHandle;
  };
  private readonly env: NodeJS.ProcessEnv;
  private readonly bin: string;
  private readonly unit: string;
  private readonly port: number;
  private readonly procFs: ProcFs;
  private readonly log: (msg: string) => void;
  private readonly exists: (p: string) => boolean;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly killPid: (pid: number, signal?: NodeJS.Signals) => void;

  private state: GrokBotLifecycleState = 'stopped';
  private enabled = true;
  private autoStart: GrokBotAutoStart = 'keep-running';
  private launcher: GrokBotLauncher | null = null;
  private attribution: string | null = null;
  private layout: GrokBotInstallLayout = 'native';
  private attempts = 0;
  private nextAttemptAt: number | null = null;
  private lastError: string | null = null;
  private lastErrorAt: number | null = null;
  private lastLaunchError: string | null = null;
  private since: number;
  private lastEnabled: boolean;
  private lastPolicy: GrokBotAutoStart;
  private notifiedEpisode = false;
  private weLaunched = false;
  private trackedPid: number | null = null;
  private stopped = true;
  private shuttingDown = false;
  private wantDisabled = false;
  private timer: unknown = null;
  private inflight: Promise<GrokBotLifecycleStatus> | null = null;
  private inflightCanLaunch = false;
  private probeCache: { at: number; status: GrokBotLifecycleStatus } | null = null;
  private portConflictSeenAt: number | null = null;
  private procSeenAt: number | null = null;

  constructor(deps: SupervisorDeps) {
    this.deps = {
      ...deps,
      now: deps.now ?? Date.now,
      setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
      probe: deps.probe ?? defaultProbe,
      procFs: deps.procFs ?? { root: '/proc' },
      run: deps.run ?? defaultRun,
      spawnDetached: deps.spawnDetached ?? defaultSpawn,
    };
    this.env = deps.env ?? process.env;
    this.bin = deps.bin ?? resolveBin(this.env);
    this.unit = deps.unit ?? resolveUnit(this.env);
    this.port = deps.port ?? cdpPort(this.env);
    this.procFs = this.deps.procFs;
    this.log = deps.log ?? ((msg) => console.log(msg));
    this.exists = deps.exists ?? existsSync;
    this.isPidAlive = deps.isPidAlive ?? defaultIsPidAlive;
    this.killPid = deps.killPid ?? ((pid, signal) => { try { process.kill(pid, signal); } catch { /* gone */ } });
    this.since = this.deps.now();
    this.layout = classifyLayout(this.bin);
    this.enabled = deps.isEnabled();
    this.autoStart = deps.policy();
    this.lastEnabled = this.enabled;
    this.lastPolicy = this.autoStart;
  }

  status(): GrokBotLifecycleStatus {
    return {
      state: this.state,
      enabled: this.enabled,
      autoStart: this.autoStart,
      envLocks: {
        autostart: !autostartEnvAllowsLaunch(this.env),
        watch: envPrefFrom(this.env, 'GROKBOT_WATCH') === '0',
      },
      launcher: this.launcher,
      attribution: this.attribution,
      layout: this.layout,
      attempts: this.attempts,
      nextAttemptAt: this.nextAttemptAt,
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
      since: this.since,
    };
  }

  start(): void {
    this.stopped = false;
    this.shuttingDown = false;
    this.arm(BOOT_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    this.shuttingDown = true;
    this.disarm();
  }

  kick(): void {
    if (this.stopped) return;
    void this.ensureRunning('periodic');
  }

  refresh(): void {
    const enabled = this.deps.isEnabled();
    const policy = this.deps.policy();
    this.enabled = enabled;
    this.autoStart = policy;
    const changed = enabled !== this.lastEnabled || policy !== this.lastPolicy;
    this.lastEnabled = enabled;
    this.lastPolicy = policy;
    if (!changed) return;
    this.attempts = 0;
    this.nextAttemptAt = null;
    if (!enabled) {
      this.wantDisabled = true;
      this.disarm();
      this.setState('disabled');
      return;
    }
    this.wantDisabled = false;
    if (this.state === 'failed' || this.state === 'disabled') {
      this.setState('stopped');
    }
    if (!this.stopped) this.arm(CADENCE_MS);
    void this.ensureRunning('periodic');
  }

  probeIfStale(): Promise<GrokBotLifecycleStatus> {
    const now = this.deps.now();
    if (this.probeCache && now - this.probeCache.at < PROBE_STALE_MS) {
      return Promise.resolve(this.probeCache.status);
    }
    return this.runCheck('periodic', true).then((status) => {
      this.probeCache = { at: this.deps.now(), status };
      return status;
    });
  }

  ensureRunning(reason: EnsureReason): Promise<GrokBotLifecycleStatus> {
    return this.runCheck(reason, false);
  }

  private runCheck(reason: EnsureReason, probeOnly: boolean): Promise<GrokBotLifecycleStatus> {
    const canLaunch = !probeOnly;
    if (this.inflight) {
      if (probeOnly) return Promise.resolve(this.status());
      if (canLaunch && !this.inflightCanLaunch) {
        const queued = this.inflight.then(() => this.check(reason, false));
        this.inflightCanLaunch = true;
        this.inflight = queued;
        void queued.finally(() => {
          if (this.inflight === queued) this.inflight = null;
        });
        return queued;
      }
      return this.inflight;
    }
    const p = this.check(reason, probeOnly);
    this.inflightCanLaunch = canLaunch;
    this.inflight = p;
    void p.finally(() => {
      if (this.inflight === p) this.inflight = null;
    });
    return p;
  }

  private arm(ms: number): void {
    this.disarm();
    if (this.stopped) return;
    const h = this.deps.setTimer(() => { void this.onTimer(); }, ms);
    if (h && typeof (h as { unref?: () => void }).unref === 'function') {
      (h as { unref: () => void }).unref();
    }
    this.timer = h;
  }

  private disarm(): void {
    if (this.timer != null) this.deps.clearTimer(this.timer);
    this.timer = null;
  }

  private async onTimer(): Promise<void> {
    if (this.stopped) return;
    if (this.deps.health() === 'ok' && this.state === 'running') {
      this.arm(CADENCE_MS);
      return;
    }
    await this.ensureRunning('periodic');
    if (this.stopped) return;
    const next = this.state === 'failed' ? FAILED_CADENCE_MS : CADENCE_MS;
    this.arm(next);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const h = this.deps.setTimer(() => resolve(), ms);
      if (h && typeof (h as { unref?: () => void }).unref === 'function') {
        (h as { unref: () => void }).unref();
      }
    });
  }

  private setState(next: GrokBotLifecycleState, patch?: Partial<Pick<Supervisor, never>> & {
    lastError?: string | null;
    launcher?: GrokBotLauncher | null;
    attribution?: string | null;
  }, notify = true): void {
    const prev = this.state;
    if (patch?.lastError !== undefined) {
      this.lastError = patch.lastError;
      this.lastErrorAt = patch.lastError ? this.deps.now() : this.lastErrorAt;
    }
    if (patch?.launcher !== undefined) this.launcher = patch.launcher;
    if (patch?.attribution !== undefined) this.attribution = patch.attribution;
    const shouldNotify = notify && (next === 'failed' || next === 'running-no-cdp') && !this.notifiedEpisode;
    if (next === prev) {
      if (shouldNotify) {
        this.notifiedEpisode = true;
        try { this.deps.notify(this.status()); } catch { /* fail-open */ }
      }
      return;
    }
    this.state = next;
    this.probeCache = null;
    this.since = this.deps.now();
    this.log(`[grok-bot supervisor] ${prev} → ${next}${this.lastError ? `: ${this.lastError}` : ''}`);
    const snap = this.status();
    try { this.deps.onTransition(snap); } catch { /* fail-open */ }
    if (shouldNotify) {
      this.notifiedEpisode = true;
      try { this.deps.notify(snap); } catch { /* fail-open */ }
    }
    if (next === 'running') this.notifiedEpisode = false;
  }

  private envKill(): boolean {
    return !autostartEnvAllowsLaunch(this.env);
  }

  private canLaunch(reason: EnsureReason): boolean {
    if (this.wantDisabled || !this.deps.isEnabled()) return false;
    if (this.envKill()) return false;
    const policy = this.deps.policy();
    if (reason === 'manual') return true;
    if (reason === 'periodic') return policy === 'keep-running';
    if (reason === 'on-demand' || reason === 'prompt') return policy === 'on-demand' || policy === 'keep-running';
    return false;
  }

  /** Attempt/clock latch for every non-manual reason. On-demand/prompt also
   *  stay blocked while state is failed/backoff even after nextAttemptAt;
   *  only manual skips the window, and keep-running periodic retries after it. */
  private backoffBlocks(reason: EnsureReason): boolean {
    if (reason === 'manual') return false;
    if (this.attempts >= MAX_ATTEMPTS) return true;
    if (this.nextAttemptAt != null && this.deps.now() < this.nextAttemptAt) return true;
    if (this.state === 'failed') return true;
    if (this.state === 'backoff' && (reason === 'on-demand' || reason === 'prompt')) return true;
    return false;
  }

  private launchLatchEngaged(): boolean {
    return this.attempts >= MAX_ATTEMPTS
      || (this.nextAttemptAt != null && this.deps.now() < this.nextAttemptAt);
  }

  private enterBackoff(error: string): void {
    this.attempts += 1;
    this.weLaunched = false;
    this.trackedPid = null;
    this.lastLaunchError = error;
    if (this.attempts >= MAX_ATTEMPTS) {
      this.nextAttemptAt = this.deps.now() + FAILED_CADENCE_MS;
      this.setState('failed', { lastError: error, launcher: this.launcher });
      return;
    }
    const delay = LAUNCH_LADDER_MS[Math.min(this.attempts - 1, LAUNCH_LADDER_MS.length - 1)]!;
    this.nextAttemptAt = this.deps.now() + delay;
    this.setState('backoff', { lastError: error });
  }

  private lockPath(): string {
    const dir = this.env.XDG_RUNTIME_DIR || tmpdir();
    return join(dir, LOCK_NAME);
  }

  private childDisplayEnvFrom(sess: Record<string, string>): NodeJS.ProcessEnv {
    const extra: NodeJS.ProcessEnv = {};
    for (const k of DISPLAY_KEYS) {
      const v = sess[k] || this.env[k];
      if (v) extra[k] = v;
    }
    const scrubbed = buildChildEnv();
    extra.PATH = this.env.PATH || scrubbed.PATH;
    extra.HOME = this.env.HOME || scrubbed.HOME;
    return extra;
  }

  private async childDisplayEnv(): Promise<NodeJS.ProcessEnv> {
    let sess: Record<string, string> = {};
    try { sess = await this.sessionEnv(); } catch { /* fail-open */ }
    return this.childDisplayEnvFrom(sess);
  }

  private async sessionEnv(): Promise<Record<string, string>> {
    const r = await this.deps.run('systemctl', ['--user', 'show-environment'], { timeoutMs: 3000 });
    return parseShowEnvironment(r.stdout);
  }

  private hasDisplaySocket(env: Record<string, string>): boolean {
    const wayland = env.WAYLAND_DISPLAY || this.env.WAYLAND_DISPLAY;
    const xdg = env.XDG_RUNTIME_DIR || this.env.XDG_RUNTIME_DIR;
    if (wayland && xdg && this.exists(join(xdg, wayland))) return true;
    const display = env.DISPLAY || this.env.DISPLAY;
    if (display) {
      const sock = x11SocketPath(display);
      if (sock && this.exists(sock)) return true;
    }
    return false;
  }

  private async hasGraphicalSession(): Promise<boolean> {
    const active = await this.deps.run('systemctl', ['--user', 'is-active', 'graphical-session.target'], { timeoutMs: 3000 });
    if (active.stdout.trim() === 'active') return true;
    const sess = await this.sessionEnv();
    return this.hasDisplaySocket(sess);
  }

  private mainProc(): ScannedProc | undefined {
    return scanGrokBotProcesses(this.bin, this.procFs).find((p) => p.isMain);
  }

  private async waitProbe(ms: number): Promise<ProbeResult | 'aborted'> {
    const deadline = this.deps.now() + ms;
    let last: ProbeResult = 'down';
    while (this.deps.now() < deadline) {
      if (this.shuttingDown || this.wantDisabled) return 'aborted';
      last = await this.deps.probe(this.port);
      if (last === 'ok') return last;
      if (this.shuttingDown || this.wantDisabled) return 'aborted';
      await this.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - this.deps.now())));
    }
    if (this.shuttingDown || this.wantDisabled) return 'aborted';
    return last;
  }

  private async stopTierwynLaunched(): Promise<void> {
    if (this.launcher === 'systemd-unit') {
      await this.deps.run('systemctl', ['--user', 'stop', this.unit], { timeoutMs: 5000 });
    } else if (this.launcher === 'systemd-run') {
      await this.deps.run('systemctl', ['--user', 'stop', ADHOC_UNIT], { timeoutMs: 5000 });
    } else if (this.trackedPid != null) {
      this.killPid(this.trackedPid, 'SIGTERM');
    }
    this.weLaunched = false;
    this.trackedPid = null;
  }

  private async check(reason: EnsureReason, probeOnly: boolean): Promise<GrokBotLifecycleStatus> {
    try {
      return await this.checkInner(reason, probeOnly);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.enterBackoff(msg);
      return this.status();
    }
  }

  private async checkInner(reason: EnsureReason, probeOnly: boolean): Promise<GrokBotLifecycleStatus> {
    this.enabled = this.deps.isEnabled();
    this.autoStart = this.deps.policy();
    this.layout = classifyLayout(this.bin);

    const platform = this.deps.platform ?? process.platform;
    if (platform !== 'linux') {
      this.setState('unsupported');
      return this.status();
    }
    if (this.wantDisabled || !this.enabled) {
      this.setState('disabled');
      return this.status();
    }

    if (reason === 'manual') {
      this.attempts = 0;
      this.nextAttemptAt = null;
      if (this.state === 'failed' || this.state === 'backoff') this.setState('stopped');
    }

    // Launchable ensure leaving `stopped`: mark `starting` before the first
    // await (CDP probe) so fire-and-forget callers (`bindEnsureGrokBot`) can
    // read an in-progress status without awaiting the launch. Only from
    // `stopped` — sticky diagnostics (no-display, failed, …) must not flap
    // through starting on every tick. Probe / lock below upgrade to running
    // or a terminal state; later setState('starting') at the lock is a no-op.
    if (
      !probeOnly
      && this.state === 'stopped'
      && this.canLaunch(reason)
      && !this.backoffBlocks(reason)
    ) {
      this.setState('starting', { lastError: null });
    }

    // Step 2: CDP probe
    let probed = await this.deps.probe(this.port);
    if (probed === 'ok') {
      this.clearForeignSeen();
      this.attempts = 0;
      this.nextAttemptAt = null;
      this.weLaunched = false;
      const proc = this.mainProc();
      this.setState('running', {
        lastError: null,
        attribution: proc?.cgroup ?? this.attribution,
      });
      return this.status();
    }
    if (probeOnly && this.isStickyDiagnostic()) return this.status();
    if (probed === 'no-target') {
      if (!probeOnly) {
        const waited = await this.waitProbe(PORT_CONFLICT_GRACE_MS);
        if (waited === 'aborted') return this.status();
        probed = waited;
      }
      if (probed === 'ok') {
        this.clearForeignSeen();
        this.attempts = 0;
        this.nextAttemptAt = null;
        this.setState('running', { lastError: null });
        return this.status();
      }
      if (probeOnly && this.withinPortConflictGrace()) return this.status();
      this.procSeenAt = null;
      this.setState('port-conflict', {
        lastError: `Port ${this.port} answered but is not a Grok Bot page target. Set TIERWYN_GROKBOT_CDP_PORT.`,
      }, !probeOnly);
      return this.status();
    }

    // Step 3: process scan
    this.portConflictSeenAt = null;
    const main = this.mainProc();
    if (main) {
      this.attribution = main.cgroup;
      if (probeOnly) {
        if (this.withinProcGrace()) return this.status();
        this.setState('running-no-cdp', {
          lastError: `Grok Bot is running without remote debugging. Add \`--remote-debugging-port=${this.port}\` to \`~/.config/grok-bot/electron-flags.conf\` and restart it.`,
          attribution: main.cgroup,
          launcher: null,
        }, false);
        return this.status();
      }
      const after = await this.waitProbe(this.weLaunched ? START_TIMEOUT_MS : FOREIGN_GRACE_MS);
      if (after === 'aborted') return this.status();
      if (after === 'ok') {
        this.clearForeignSeen();
        this.attempts = 0;
        this.nextAttemptAt = null;
        this.setState('running', { lastError: null, attribution: main.cgroup });
        return this.status();
      }
      if (this.weLaunched) {
        await this.stopTierwynLaunched();
        this.enterBackoff('Grok Bot launched but CDP never opened');
        return this.status();
      }
      this.setState('running-no-cdp', {
        lastError: `Grok Bot is running without remote debugging. Add \`--remote-debugging-port=${this.port}\` to \`~/.config/grok-bot/electron-flags.conf\` and restart it.`,
        attribution: main.cgroup,
        launcher: null,
      });
      return this.status();
    }

    if (probeOnly || this.envKill()) {
      this.clearForeignSeen();
      this.setState('stopped');
      return this.status();
    }

    if (!this.canLaunch(reason) || this.backoffBlocks(reason)) {
      if (this.state === 'failed' || this.state === 'backoff') return this.status();
      const giveUp = this.lastLaunchError ?? 'all launchers failed';
      if (this.attempts >= MAX_ATTEMPTS) {
        this.setState('failed', { lastError: giveUp });
        return this.status();
      }
      if (this.nextAttemptAt != null && this.deps.now() < this.nextAttemptAt) {
        this.setState('backoff', { lastError: giveUp });
        return this.status();
      }
      this.setState('stopped');
      return this.status();
    }

    // Layout report-only
    if (this.layout === 'snap' || this.layout === 'flatpak') {
      this.setState('not-installed', {
        lastError: `detected ${this.layout}; launch unsupported — set TIERWYN_GROKBOT_BIN`,
      });
      return this.status();
    }

    const valid = validateBin(this.bin);
    if (!valid.ok) {
      this.layout = existsSync(this.bin) ? this.layout : 'missing';
      this.setState('not-installed', { lastError: valid.error });
      return this.status();
    }

    if (!(await this.hasGraphicalSession())) {
      this.setState('no-display');
      return this.status();
    }

    // Launch lock
    const lockPath = this.lockPath();
    let lock: { held: 'ours' | 'theirs'; fd?: number };
    try {
      lock = acquireLaunchLock(lockPath, this.isPidAlive);
    } catch (err) {
      this.enterBackoff(err instanceof Error ? err.message : String(err));
      return this.status();
    }
    if (lock.held === 'theirs') {
      this.setState('starting');
      const waited = await this.waitProbe(START_TIMEOUT_MS);
      if (waited === 'aborted') return this.status();
      if (waited === 'ok') {
        this.attempts = 0;
        this.setState('running', { lastError: null });
      } else {
        this.setState('stopped', { lastError: 'Another Tierwyn instance is launching Grok Bot' });
      }
      return this.status();
    }

    this.setState('starting', { lastError: null });
    try {
      if (!this.canLaunch(reason) || this.shuttingDown || this.wantDisabled) {
        if (this.wantDisabled) this.setState('disabled');
        return this.status();
      }
      const launched = await this.launchChain();
      if (!launched) {
        this.enterBackoff(this.withHint(this.lastError ?? 'all launchers failed'));
        return this.status();
      }
      const waited = await this.waitProbe(START_TIMEOUT_MS);
      if (waited === 'aborted') return this.status();
      if (waited === 'ok') {
        this.attempts = 0;
        this.nextAttemptAt = null;
        const proc = this.mainProc();
        this.setState('running', { lastError: null, attribution: proc?.cgroup ?? this.attribution });
        return this.status();
      }
      const still = this.mainProc();
      if (still) {
        await this.stopTierwynLaunched();
        this.enterBackoff(
          this.withHint(
            `Grok Bot did not open CDP on port ${this.port} within ${START_TIMEOUT_MS / 1000}s. Check TIERWYN_GROKBOT_CDP_PORT.`,
          ),
        );
        return this.status();
      }
      this.enterBackoff(this.withHint(this.lastError ?? 'Grok Bot exited during start'));
      return this.status();
    } finally {
      releaseLaunchLock(lockPath, lock.fd);
    }
  }

  private isStickyDiagnostic(): boolean {
    if (this.state === 'backoff' || this.state === 'failed'
      || this.state === 'no-display' || this.state === 'not-installed') return true;
    return this.launchLatchEngaged()
      && (this.state === 'running-no-cdp' || this.state === 'port-conflict');
  }

  private clearForeignSeen(): void {
    this.portConflictSeenAt = null;
    this.procSeenAt = null;
  }

  private withinPortConflictGrace(): boolean {
    if (this.portConflictSeenAt == null) this.portConflictSeenAt = this.deps.now();
    return this.deps.now() - this.portConflictSeenAt < FOREIGN_GRACE_MS;
  }

  private withinProcGrace(): boolean {
    if (this.procSeenAt == null) this.procSeenAt = this.deps.now();
    return this.deps.now() - this.procSeenAt < FOREIGN_GRACE_MS;
  }

  private withHint(msg: string): string {
    const info = readStaleSingletonLock({
      homedir: (this.deps.homedir ?? osHomedir)(),
      hostname: (this.deps.hostname ?? osHostname)(),
      bin: this.bin,
      isPidAlive: this.isPidAlive,
    });
    if (info?.stale) return `${msg}; Stale SingletonLock at ${info.path} (host ${info.host} pid ${info.pid})`;
    return msg;
  }

  private async launchChain(): Promise<boolean> {
    this.launcher = null;
    const load = await this.deps.run(
      'systemctl',
      ['--user', 'show', '-p', 'LoadState', '--value', this.unit],
      { timeoutMs: 3000 },
    );
    if (load.stdout.trim() === 'loaded') {
      const active = await this.deps.run(
        'systemctl',
        ['--user', 'show', '-p', 'ActiveState', '--value', this.unit],
        { timeoutMs: 3000 },
      );
      if (active.stdout.trim() === 'failed') {
        await this.deps.run('systemctl', ['--user', 'reset-failed', this.unit], { timeoutMs: 3000 });
      }
      const start = await this.deps.run('systemctl', ['--user', 'start', this.unit], { timeoutMs: 8000 });
      if (start.code === 0 && !start.error) {
        this.launcher = 'systemd-unit';
        this.weLaunched = true;
        return true;
      }
      this.lastError = start.stderr.trim() || start.error?.message || `systemctl start ${this.unit} failed`;
    }

    const adhoc = await this.deps.run(
      'systemd-run',
      ['--user', `--unit=${ADHOC_UNIT}`, '--collect', '--', this.bin, `--remote-debugging-port=${this.port}`],
      { timeoutMs: 8000 },
    );
    if (adhoc.error?.code === 'ENOENT') {
      return this.spawnFallback();
    }
    if (adhoc.code === 0 && !adhoc.error) {
      this.launcher = 'systemd-run';
      this.weLaunched = true;
      return true;
    }
    this.lastError = adhoc.stderr.trim() || adhoc.error?.message || 'systemd-run failed';
    return this.spawnFallback();
  }

  private async spawnFallback(): Promise<boolean> {
    try {
      let spawnFailed: string | null = null;
      const child = this.deps.spawnDetached(
        this.bin,
        [`--remote-debugging-port=${this.port}`],
        { env: await this.childDisplayEnv() },
      );
      const settled = new Promise<void>((resolve) => {
        const done = () => resolve();
        child.on('error', (err: unknown) => {
          spawnFailed = err instanceof Error ? err.message : String(err);
          this.lastError = spawnFailed;
          this.lastErrorAt = this.deps.now();
          done();
        });
        child.on('spawn', () => done());
        setImmediate(done);
      });
      child.unref();
      await settled;
      if (spawnFailed) {
        this.launcher = null;
        this.weLaunched = false;
        this.trackedPid = null;
        return false;
      }
      this.launcher = 'spawn';
      this.weLaunched = true;
      this.trackedPid = typeof child.pid === 'number' ? child.pid : null;
      return true;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.launcher = null;
      return false;
    }
  }
}
