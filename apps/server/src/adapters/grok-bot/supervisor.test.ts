import { EventEmitter } from 'events';
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GrokBotAutoStart, GrokBotLifecycleStatus } from '@tierwyn/shared';
import {
  acquireLaunchLock, BOOT_DELAY_MS, CADENCE_MS, classifyLayout, createGrokBotSupervisor,
  FAILED_CADENCE_MS, FOREIGN_GRACE_MS, LAUNCH_LADDER_MS, MAX_ATTEMPTS, PORT_CONFLICT_GRACE_MS,
  DEFAULT_UNIT, PROBE_STALE_MS, releaseLaunchLock, resolveBin, resolveUnit,
  scanGrokBotProcesses, START_TIMEOUT_MS, supervisorMessage,
  type ProbeResult, type RunResult, type SpawnHandle, type SupervisorDeps,
} from './supervisor.js';

class Clock {
  nowMs = 1_000_000;
  timers: { id: number; fn: () => void; at: number }[] = [];
  nextId = 1;
  now = () => this.nowMs;
  setTimer = (fn: () => void, ms: number) => {
    const h = { id: this.nextId++, fn, at: this.nowMs + ms };
    this.timers.push(h);
    return h;
  };
  clearTimer = (h: unknown) => {
    const id = (h as { id?: number } | null)?.id;
    if (id == null) return;
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  async flush(): Promise<void> {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (let guard = 0; guard < 500; guard++) {
      await this.flush();
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id);
      if (due.length === 0) { this.nowMs = target; await this.flush(); return; }
      const t = due[0]!;
      this.nowMs = t.at;
      this.timers = this.timers.filter((x) => x.id !== t.id);
      t.fn();
    }
    this.nowMs = target;
  }
}

function makeBin(): string {
  const p = join(tmpdir(), `tierwyn-gb-bin-${process.pid}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(p, '#!/bin/sh\n');
  chmodSync(p, 0o700);
  return p;
}

function writeProc(root: string, pid: number, opts: {
  exe?: string; argv0?: string; args?: string[]; cgroup?: string;
}): void {
  const dir = join(root, String(pid));
  mkdirSync(dir, { recursive: true });
  if (opts.exe) {
    try { symlinkSync(opts.exe, join(dir, 'exe')); } catch { /* exists */ }
  }
  const argv = [opts.argv0 ?? 'grok-bot', ...(opts.args ?? [])];
  writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`);
  writeFileSync(join(dir, 'cgroup'), `0::/user.slice/${opts.cgroup ?? 'app.scope'}\n`);
}

type RunKey = string;
function keyOf(cmd: string, argv: string[]): RunKey {
  return `${cmd} ${argv.join(' ')}`;
}

function boot(over: Partial<SupervisorDeps> & {
  probeSeq?: ProbeResult[];
  runMap?: Record<string, Partial<RunResult> | ((argv: string[]) => Partial<RunResult>)>;
  policy?: () => GrokBotAutoStart;
  enabled?: () => boolean;
} = {}) {
  const clock = new Clock();
  const procRoot = join(tmpdir(), `tierwyn-gb-proc-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(procRoot, { recursive: true });
  const bin = over.bin ?? makeBin();
  const runCalls: { cmd: string; argv: string[] }[] = [];
  const probes: ProbeResult[] = [];
  const transitions: GrokBotLifecycleStatus[] = [];
  const notifies: GrokBotLifecycleStatus[] = [];
  const spawnCalls: string[][] = [];
  const spawnEnvs: NodeJS.ProcessEnv[] = [];
  const logs: string[] = [];
  let probeSeq = [...(over.probeSeq ?? ['down'])];
  const runMap = over.runMap ?? {};
  const sockets = new Set<string>();

  const deps: SupervisorDeps = {
    isEnabled: over.enabled ?? (() => true),
    policy: over.policy ?? (() => 'keep-running'),
    onTransition: (s) => { transitions.push(s); over.onTransition?.(s); },
    notify: (s) => { notifies.push(s); over.notify?.(s); },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    probe: over.probe ?? (async () => {
      const v = probeSeq.length > 1 ? probeSeq.shift()! : probeSeq[0]!;
      probes.push(v);
      return v;
    }),
    procFs: over.procFs ?? { root: procRoot },
    run: over.run
      ? async (cmd, argv, opts) => {
          runCalls.push({ cmd, argv });
          return over.run!(cmd, argv, opts);
        }
      : async (cmd, argv) => {
          runCalls.push({ cmd, argv });
          const k = keyOf(cmd, argv);
          const hit = runMap[k] ?? runMap[cmd];
          const partial = typeof hit === 'function' ? hit(argv) : hit;
          if (partial?.error) return { code: partial.code ?? null, stdout: partial.stdout ?? '', stderr: partial.stderr ?? '', error: partial.error };
          return { code: partial?.code ?? 0, stdout: partial?.stdout ?? '', stderr: partial?.stderr ?? '' };
        },
    spawnDetached: over.spawnDetached ?? ((_bin, argv, opts) => {
      spawnCalls.push(argv);
      spawnEnvs.push(opts.env);
      return { pid: 4242, on() { return undefined; }, unref() { /* */ } };
    }),
    health: over.health ?? (() => 'unreachable'),
    log: (m) => { logs.push(m); },
    env: over.env ?? { XDG_RUNTIME_DIR: procRoot },
    bin,
    unit: over.unit,
    port: over.port ?? 9333,
    platform: over.platform ?? 'linux',
    exists: over.exists ?? ((p) => sockets.has(p)),
    homedir: over.homedir ?? (() => procRoot),
    hostname: over.hostname ?? (() => 'test-host'),
    isPidAlive: over.isPidAlive,
    killPid: over.killPid,
    ...pickDefined(over, ['db']),
  };

  const sup = createGrokBotSupervisor(deps);
  return {
    sup, clock, bin, procRoot, runCalls, probes, transitions, notifies, spawnCalls, spawnEnvs, logs, sockets,
    setProbe: (seq: ProbeResult[]) => { probeSeq = [...seq]; },
    cleanup: () => { try { rmSync(procRoot, { recursive: true, force: true }); } catch { /* */ } },
  };
}

function pickDefined<T extends object>(obj: T, keys: (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const loaded = {
  'systemctl --user show -p LoadState --value tierwyn-grokbot.service': { stdout: 'loaded\n' },
  'systemctl --user show -p ActiveState --value tierwyn-grokbot.service': { stdout: 'inactive\n' },
  'systemctl --user is-active graphical-session.target': { stdout: 'active\n' },
  'systemctl --user show-environment': { stdout: 'WAYLAND_DISPLAY=wayland-0\nXDG_RUNTIME_DIR=/run/user/1000\n' },
  'systemctl --user start tierwyn-grokbot.service': { code: 0, stdout: '' },
};

const tmps: string[] = [];
afterEach(() => {
  for (const t of tmps) { try { rmSync(t, { recursive: true, force: true }); } catch { /* */ } }
  tmps.length = 0;
});

describe('createGrokBotSupervisor fail-open', () => {
  it('does zero run/probe/fs calls on construct; start() arms 5s and probes nothing synchronously', () => {
    const run = vi.fn(async () => ({ code: 0, stdout: '', stderr: '' }));
    const probe = vi.fn(async () => 'down' as const);
    const { sup, clock } = boot({ run, probe, runMap: {} });
    expect(run).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    sup.start();
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]!.at - clock.nowMs).toBe(BOOT_DELAY_MS);
    expect(probe).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('run throw / reject / spawn error all land in backoff without unhandledRejection', async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown) => { rejections.push(e); };
    process.on('unhandledRejection', onRej);
    try {
      const { sup: a, clock: c1 } = boot({
        run: async () => { throw new Error('sync-throw'); },
        runMap: {},
      });
      const p1 = a.ensureRunning('manual');
      await c1.flush();
      const s1 = await p1;
      expect(s1.state).toBe('backoff');
      expect(s1.lastError).toMatch(/sync-throw/);

      const { sup: b, clock: c2 } = boot({
        run: async () => Promise.reject(new Error('async-reject')),
      });
      const p2 = b.ensureRunning('manual');
      await c2.flush();
      const s2 = await p2;
      expect(s2.state).toBe('backoff');
      expect(s2.lastError).toMatch(/async-reject/);

      const { sup: c, clock: c3 } = boot({
        runMap: {
          'systemctl --user show -p LoadState --value tierwyn-grokbot.service': { stdout: 'not-found\n' },
          'systemctl --user is-active graphical-session.target': { stdout: 'active\n' },
          systemdRun: {},
        },
        run: async (cmd, argv) => {
          if (cmd === 'systemctl' && argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
          if (cmd === 'systemctl' && argv.includes('LoadState')) return { code: 0, stdout: 'not-found\n', stderr: '' };
          if (cmd === 'systemd-run') {
            const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
            return { code: null, stdout: '', stderr: '', error: err };
          }
          return { code: 0, stdout: '', stderr: '' };
        },
        spawnDetached: () => {
          const ee = new EventEmitter();
          return {
            pid: 9,
            on(ev: string, cb: (...args: unknown[]) => void) {
              ee.on(ev, cb);
              if (ev === 'error') process.nextTick(() => ee.emit('error', new Error('spawn boom')));
              return ee;
            },
            unref() { /* */ },
          } satisfies SpawnHandle;
        },
      });
      const p3 = c.ensureRunning('manual');
      await c3.flush();
      const s3 = await p3;
      expect(s3.state).toBe('backoff');
      expect(s3.lastError).toMatch(/spawn boom/);
      await c3.flush();
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRej);
    }
  });
});

describe('single-flight', () => {
  it('three concurrent ensureRunning share one systemctl start', async () => {
    let starts = 0;
    const { sup, clock } = boot({
      probeSeq: ['down', 'ok'],
      run: async (cmd, argv) => {
        if (cmd === 'systemctl' && argv.includes('start')) starts += 1;
        if (cmd === 'systemctl' && argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (cmd === 'systemctl' && argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (cmd === 'systemctl' && argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (cmd === 'systemctl' && argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const a = sup.ensureRunning('on-demand');
    const b = sup.ensureRunning('on-demand');
    const c = sup.ensureRunning('on-demand');
    await clock.advance(START_TIMEOUT_MS + 100);
    const [sa, sb, sc] = await Promise.all([a, b, c]);
    expect(starts).toBe(1);
    expect(sa).toBe(sb);
    expect(sb).toBe(sc);
    expect(sa.state).toBe('running');
  });
});

describe('backoff ladder', () => {
  it('five failing launches schedule 30s, 2min, 10min, 30min, then failed; failed probes 5min and does not launch; ok resets; manual resets; on-demand in backoff does not launch', async () => {
    let starts = 0;
    const { sup, clock } = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (cmd === 'systemctl' && argv.includes('start')) starts += 1;
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('start')) return { code: 1, stdout: '', stderr: 'fail' };
        if (cmd === 'systemd-run') return { code: 1, stdout: '', stderr: 'fail' };
        return { code: 0, stdout: '', stderr: '' };
      },
      spawnDetached: () => { throw new Error('spawn fail'); },
    });
    const delays: number[] = [];
    for (let i = 0; i < 4; i++) {
      const p = sup.ensureRunning('periodic');
      await clock.flush();
      const s = await p;
      expect(s.state).toBe('backoff');
      expect(s.nextAttemptAt).toBe(clock.nowMs + LAUNCH_LADDER_MS[i]!);
      delays.push(LAUNCH_LADDER_MS[i]!);
      await clock.advance(LAUNCH_LADDER_MS[i]!);
    }
    expect(delays).toEqual(LAUNCH_LADDER_MS);
    const last = sup.ensureRunning('periodic');
    await clock.advance(START_TIMEOUT_MS + 50);
    const failed = await last;
    expect(failed.state).toBe('failed');
    expect(failed.attempts).toBe(MAX_ATTEMPTS);
    const startsAtFailed = starts;

    const peek = sup.ensureRunning('periodic');
    await clock.flush();
    expect((await peek).state).toBe('failed');
    expect(starts).toBe(startsAtFailed);

    const { sup: s2, clock: c2, setProbe } = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('start')) return { code: 1, stdout: '', stderr: 'fail' };
        if (cmd === 'systemd-run') return { code: 1, stdout: '', stderr: 'fail' };
        return { code: 0, stdout: '', stderr: '' };
      },
      spawnDetached: () => { throw new Error('spawn fail'); },
    });
    for (let i = 0; i < 5; i++) {
      const p = s2.ensureRunning('periodic');
      await c2.flush();
      await p;
      if (i < 4) await c2.advance(LAUNCH_LADDER_MS[i]!);
    }
    expect(s2.status().state).toBe('failed');
    setProbe(['ok']);
    const recovered = s2.ensureRunning('periodic');
    await c2.flush();
    expect((await recovered).state).toBe('running');
    expect(s2.status().attempts).toBe(0);

    const { sup: s3, clock: c3 } = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('start')) return { code: 1, stdout: '', stderr: 'fail' };
        if (cmd === 'systemd-run') return { code: 1, stdout: '', stderr: 'fail' };
        return { code: 0, stdout: '', stderr: '' };
      },
      spawnDetached: () => { throw new Error('spawn fail'); },
    });
    const first = s3.ensureRunning('periodic');
    await c3.flush();
    expect((await first).state).toBe('backoff');
    const blocked = s3.ensureRunning('on-demand');
    await c3.flush();
    expect((await blocked).state).toBe('backoff');
    const manual = s3.ensureRunning('manual');
    await c3.advance(START_TIMEOUT_MS + 50);
    const afterManual = await manual;
    expect(afterManual.state === 'backoff' || afterManual.state === 'failed' || afterManual.state === 'starting' || afterManual.state === 'stopped').toBe(true);
    expect(s3.status().attempts).toBeLessThan(MAX_ATTEMPTS);
  });
});

describe('not-installed', () => {
  it('missing / no exec / group-writable → not-installed; no attempt, no notify', async () => {
    const { sup, clock, notifies } = boot({ bin: '/tmp/tierwyn-gb-does-not-exist-xyz', runMap: loaded });
    const s = await (async () => { const p = sup.ensureRunning('manual'); await clock.flush(); return p; })();
    expect(s.state).toBe('not-installed');
    expect(s.attempts).toBe(0);
    expect(notifies).toHaveLength(0);

    const noexec = join(tmpdir(), `tierwyn-gb-noexec-${Math.random().toString(16).slice(2)}`);
    writeFileSync(noexec, 'x');
    chmodSync(noexec, 0o600);
    tmps.push(noexec);
    const b = boot({ bin: noexec, runMap: loaded });
    const s2p = b.sup.ensureRunning('manual');
    await b.clock.flush();
    expect((await s2p).state).toBe('not-installed');
    expect(b.notifies).toHaveLength(0);

    const gw = join(tmpdir(), `tierwyn-gb-gw-${Math.random().toString(16).slice(2)}`);
    writeFileSync(gw, 'x');
    chmodSync(gw, 0o770);
    tmps.push(gw);
    const c = boot({ bin: gw, runMap: loaded });
    const s3p = c.sup.ensureRunning('manual');
    await c.clock.flush();
    expect((await s3p).state).toBe('not-installed');
    expect(c.notifies).toHaveLength(0);
  });
});

describe('no-display', () => {
  it('inactive target and no sockets → no-display; one log across three ticks; socket later launches; wayland socket avoids spurious no-display', async () => {
    const { sup, clock, logs, spawnCalls, runCalls } = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 1, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('show-environment')) return { code: 0, stdout: '', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      exists: () => false,
      env: {},
    });
    for (let i = 0; i < 3; i++) {
      const p = sup.ensureRunning('periodic');
      await clock.flush();
      expect((await p).state).toBe('no-display');
    }
    expect(logs.filter((l) => l.includes('no-display')).length).toBe(1);
    expect(spawnCalls).toHaveLength(0);
    expect(runCalls.some((c) => c.argv.includes('start'))).toBe(false);

    const waylandSock = '/run/user/1000/wayland-0';
    const w = boot({
      probeSeq: ['down', 'ok'],
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 1, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('show-environment')) {
          return { code: 0, stdout: 'WAYLAND_DISPLAY=wayland-0\nXDG_RUNTIME_DIR=/run/user/1000\n', stderr: '' };
        }
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      exists: (p) => p === waylandSock,
    });
    const p = w.sup.ensureRunning('periodic');
    await w.clock.advance(START_TIMEOUT_MS + 50);
    expect((await p).state).not.toBe('no-display');
  });
});

describe('launcher errors', () => {
  it('not loaded → systemd-run; ENOENT → spawn; all fail → backoff launcher null', async () => {
    const spawnArgv: string[][] = [];
    const { sup, clock } = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'not-found\n', stderr: '' };
        if (cmd === 'systemd-run') {
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
          return { code: null, stdout: '', stderr: '', error: err };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
      spawnDetached: (_bin, argv) => {
        spawnArgv.push(argv);
        throw new Error('spawn gone');
      },
    });
    const p = sup.ensureRunning('manual');
    await clock.flush();
    const s = await p;
    expect(s.state).toBe('backoff');
    expect(s.launcher).toBeNull();
    expect(s.lastError).toBeTruthy();
  });
});

describe('crash loop', () => {
  it('ActiveState=failed → backoff and next attempt runs reset-failed before start', async () => {
    const argvLog: string[][] = [];
    let n = 0;
    const { sup, clock } = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        argvLog.push(argv);
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'failed\n', stderr: '' };
        if (argv.includes('reset-failed')) return { code: 0, stdout: '', stderr: '' };
        if (argv.includes('start')) {
          n += 1;
          return { code: 1, stdout: '', stderr: 'fail' };
        }
        if (cmd === 'systemd-run') return { code: 1, stdout: '', stderr: 'fail' };
        return { code: 0, stdout: '', stderr: '' };
      },
      spawnDetached: () => { throw new Error('no'); },
    });
    const p1 = sup.ensureRunning('periodic');
    await clock.advance(START_TIMEOUT_MS + 50);
    expect((await p1).state).toBe('backoff');
    await clock.advance(LAUNCH_LADDER_MS[0]!);
    const p2 = sup.ensureRunning('periodic');
    await clock.advance(START_TIMEOUT_MS + 50);
    await p2;
    const flat = argvLog.map((a) => a.join(' '));
    const resetIdx = flat.findIndex((s) => s.includes('reset-failed'));
    const starts = flat.map((s, i) => s.includes('start tierwyn-grokbot') ? i : -1).filter((i) => i >= 0);
    expect(resetIdx).toBeGreaterThanOrEqual(0);
    expect(starts.length).toBeGreaterThanOrEqual(2);
    expect(resetIdx).toBeLessThan(starts[1]!);
  });
});

describe('hang Tierwyn-launched', () => {
  it('process alive, CDP down for 30s → systemctl stop, state backoff', async () => {
    const stops: string[][] = [];
    const h = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('stop')) { stops.push(argv); return { code: 0, stdout: '', stderr: '' }; }
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) {
          writeProc(h.procRoot, 77, { exe: h.bin, argv0: h.bin, cgroup: 'tierwyn-grokbot.service' });
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const p = h.sup.ensureRunning('manual');
    await h.clock.advance(START_TIMEOUT_MS + 100);
    const s = await p;
    expect(s.state).toBe('backoff');
    expect(stops.some((a) => a.includes('stop') && a.includes('tierwyn-grokbot.service'))).toBe(true);
    h.cleanup();
  });
});

describe('running-no-cdp foreign', () => {
  it('pre-existing /proc match, CDP down after 20s grace → running-no-cdp; no launch/stop/kill; notify once', async () => {
    const starts: string[][] = [];
    const stops: string[][] = [];
    const kills: number[] = [];
    const h = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('start')) starts.push(argv);
        if (argv.includes('stop')) stops.push(argv);
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      killPid: (pid) => { kills.push(pid); },
    });
    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const p = h.sup.ensureRunning('periodic');
    await h.clock.advance(20_000 + 100);
    expect((await p).state).toBe('running-no-cdp');
    expect(starts).toHaveLength(0);
    expect(stops).toHaveLength(0);
    expect(kills).toHaveLength(0);
    expect(h.notifies).toHaveLength(1);
    const p2 = h.sup.ensureRunning('periodic');
    await h.clock.advance(20_000 + 100);
    await p2;
    expect(h.notifies).toHaveLength(1);
    h.cleanup();
  });
});

function basenameSafe(p: string): string {
  return p.split('/').pop() ?? p;
}

describe('foreign launcher basename match', () => {
  it('AppImage mount exe + argv0 basename match + cgroup → running, attribution set, zero launches; renderer alone does not count', async () => {
    const bin = makeBin();
    tmps.push(bin);
    const h = boot({
      bin,
      probeSeq: ['ok'],
      run: async () => ({ code: 0, stdout: '', stderr: '' }),
    });
    writeProc(h.procRoot, 101, {
      exe: '/tmp/.mount_x/grok-bot',
      argv0: basenameSafe(bin),
      cgroup: 'app-grok\\x2dbot-1.scope',
    });
    const p = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    const s = await p;
    expect(s.state).toBe('running');
    expect(s.attribution).toContain('app-grok');
    expect(h.runCalls.some((c) => c.argv.includes('start'))).toBe(false);

    const h2 = boot({ bin, probeSeq: ['down'] });
    writeProc(h2.procRoot, 102, {
      exe: bin,
      argv0: bin,
      args: ['--type=renderer'],
      cgroup: 'app.scope',
    });
    const p2 = h2.sup.ensureRunning('periodic');
    await h2.clock.flush();
    expect((await p2).state).not.toBe('running');
    h.cleanup();
    h2.cleanup();
  });
});

describe('unit override', () => {
  it('TIERWYN_GROKBOT_UNIT=my.service → every systemctl argv targets my.service', async () => {
    const seen: string[][] = [];
    const { sup, clock } = boot({
      unit: 'my.service',
      probeSeq: ['down', 'ok'],
      run: async (cmd, argv) => {
        if (cmd === 'systemctl') seen.push(argv);
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const p = sup.ensureRunning('manual');
    await clock.advance(START_TIMEOUT_MS + 50);
    await p;
    const targeted = seen.filter((a) => a.includes('my.service'));
    expect(targeted.length).toBeGreaterThan(0);
    expect(seen.some((a) => a.includes('tierwyn-grokbot.service') && a.includes('start'))).toBe(false);
  });
});

describe('layouts', () => {
  it('AppImage BIN launches; snap/flatpak are report-only not-installed', async () => {
    const img = join(tmpdir(), `GrokBot-${Math.random().toString(16).slice(2)}.AppImage`);
    writeFileSync(img, 'x');
    chmodSync(img, 0o700);
    tmps.push(img);
    const a = boot({
      bin: img,
      probeSeq: ['down', 'ok'],
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'not-found\n', stderr: '' };
        if (cmd === 'systemd-run') return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(classifyLayout(img)).toBe('appimage');
    const p = a.sup.ensureRunning('manual');
    await a.clock.advance(START_TIMEOUT_MS + 50);
    expect((await p).layout).toBe('appimage');
    expect((await p).state).toBe('running');

    const snap = boot({
      bin: '/snap/bin/grok-bot',
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const sp = snap.sup.ensureRunning('manual');
    await snap.clock.flush();
    const ss = await sp;
    expect(ss.state).toBe('not-installed');
    expect(ss.layout).toBe('snap');
    expect(snap.runCalls.some((c) => c.argv.includes('start'))).toBe(false);

    const fp = boot({ bin: '/var/lib/flatpak/app/grok-bot', probeSeq: ['down'] });
    const fpp = fp.sup.ensureRunning('manual');
    await fp.clock.flush();
    expect((await fpp).layout).toBe('flatpak');
    expect((await fpp).state).toBe('not-installed');
  });
});

describe('port-conflict', () => {
  it('/json/version ok but no page target for 20s → port-conflict, no launch', async () => {
    const { sup, clock, runCalls } = boot({
      probeSeq: ['no-target'],
      runMap: loaded,
    });
    const p = sup.ensureRunning('periodic');
    await clock.advance(20_000 + 100);
    const s = await p;
    expect(s.state).toBe('port-conflict');
    expect(s.lastError).toMatch(/9333/);
    expect(s.lastError).toMatch(/TIERWYN_GROKBOT_CDP_PORT/);
    expect(runCalls.some((c) => c.argv.includes('start'))).toBe(false);
  });
});

describe('launch lock', () => {
  it('live pid lock → no launch, waits CDP; dead pid lock removed and taken; lock gone after success and timeout', async () => {
    const dir = join(tmpdir(), `tierwyn-gb-lock-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tmps.push(dir);
    const lockPath = join(dir, 'tierwyn-grokbot.launch.lock');
    writeFileSync(lockPath, String(process.pid));
    const live = boot({
      probeSeq: ['down', 'ok'],
      env: { XDG_RUNTIME_DIR: dir },
      runMap: loaded,
      isPidAlive: (pid) => pid === process.pid,
    });
    const p = live.sup.ensureRunning('manual');
    await live.clock.advance(START_TIMEOUT_MS + 50);
    const s = await p;
    expect(s.state).toBe('running');
    expect(live.runCalls.some((c) => c.argv.includes('start'))).toBe(false);

    writeFileSync(lockPath, '1');
    const dead = boot({
      probeSeq: ['down', 'ok'],
      env: { XDG_RUNTIME_DIR: dir },
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      isPidAlive: () => false,
    });
    const p2 = dead.sup.ensureRunning('manual');
    await dead.clock.advance(START_TIMEOUT_MS + 50);
    expect((await p2).state).toBe('running');
    expect(dead.runCalls.some((c) => c.argv.includes('start'))).toBe(true);
    expect(existsQuiet(lockPath)).toBe(false);

    writeFileSync(lockPath, '1');
    const timeout = boot({
      probeSeq: ['down'],
      env: { XDG_RUNTIME_DIR: dir },
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      isPidAlive: () => false,
    });
    const p3 = timeout.sup.ensureRunning('manual');
    await timeout.clock.advance(START_TIMEOUT_MS + 50);
    await p3;
    expect(existsQuiet(lockPath)).toBe(false);
  });
});

function existsQuiet(p: string): boolean {
  try { lstatSync(p); return true; } catch { return false; }
}

describe('env kill', () => {
  it('TIERWYN_GROKBOT_AUTOSTART=0 never launches; probe still sets running/stopped; envLocks.autostart', async () => {
    const a = boot({
      env: { TIERWYN_GROKBOT_AUTOSTART: '0', XDG_RUNTIME_DIR: tmpdir() },
      probeSeq: ['ok'],
    });
    const p = a.sup.ensureRunning('manual');
    await a.clock.flush();
    const s = await p;
    expect(s.state).toBe('running');
    expect(s.envLocks.autostart).toBe(true);
    expect(a.runCalls.some((c) => c.argv.includes('start'))).toBe(false);

    const b = boot({
      env: { TIERWYN_GROKBOT_AUTOSTART: '0' },
      probeSeq: ['down'],
    });
    const p2 = b.sup.ensureRunning('manual');
    await b.clock.flush();
    expect((await p2).state).toBe('stopped');
    expect((await p2).envLocks.autostart).toBe(true);
    expect(b.runCalls.some((c) => c.argv.includes('start'))).toBe(false);
  });
});

describe('unsupported', () => {
  it('platform darwin → unsupported, no /proc probe', async () => {
    const { sup, clock, procRoot, probes, runCalls } = boot({ platform: 'darwin', probeSeq: ['down'] });
    const p = sup.ensureRunning('periodic');
    await clock.flush();
    expect((await p).state).toBe('unsupported');
    expect(probes).toHaveLength(0);
    expect(runCalls).toHaveLength(0);
    expect(scanGrokBotProcesses('/opt/Grok Bot/grok-bot', { root: procRoot })).toEqual([]);
  });
});

describe('stop()', () => {
  it('clears the timer; in-flight check after stop arms nothing', async () => {
    const { sup, clock } = boot({ probeSeq: ['ok'] });
    sup.start();
    expect(clock.timers.length).toBe(1);
    const p = sup.ensureRunning('periodic');
    sup.stop();
    await clock.flush();
    await p;
    const after = clock.timers.length;
    await clock.advance(60_000);
    expect(clock.timers.length).toBe(after);
  });
});

describe('stale SingletonLock (P4)', () => {
  it('stale lock names the path and is not deleted; other host ignored', async () => {
    const home = join(tmpdir(), `tierwyn-gb-home-${Math.random().toString(16).slice(2)}`);
    const lockDir = join(home, '.config', 'Grok Bot');
    mkdirSync(lockDir, { recursive: true });
    tmps.push(home);
    const lockFile = join(lockDir, 'SingletonLock');
    symlinkSync('testhost-999999', lockFile);
    const h = boot({
      probeSeq: ['down'],
      homedir: () => home,
      hostname: () => 'testhost',
      isPidAlive: () => false,
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) return { code: 1, stdout: '', stderr: 'fail' };
        if (cmd === 'systemd-run') return { code: 1, stdout: '', stderr: 'fail' };
        return { code: 0, stdout: '', stderr: '' };
      },
      spawnDetached: () => { throw new Error('no'); },
    });
    const p = h.sup.ensureRunning('manual');
    await h.clock.advance(START_TIMEOUT_MS + 50);
    const s = await p;
    expect(s.lastError).toContain(lockFile);
    expect(existsQuiet(lockFile)).toBe(true);

    const other = boot({
      probeSeq: ['down'],
      homedir: () => home,
      hostname: () => 'other-host',
      isPidAlive: () => false,
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) return { code: 1, stdout: '', stderr: 'fail' };
        if (cmd === 'systemd-run') return { code: 1, stdout: '', stderr: 'fail' };
        return { code: 0, stdout: '', stderr: '' };
      },
      spawnDetached: () => { throw new Error('no'); },
    });
    const p2 = other.sup.ensureRunning('manual');
    await other.clock.advance(START_TIMEOUT_MS + 50);
    const s2 = await p2;
    expect(s2.lastError ?? '').not.toContain(lockFile);
  });
});

describe('helpers', () => {
  it('resolveBin reads TIERWYN_GROKBOT_BIN', () => {
    expect(resolveBin({ TIERWYN_GROKBOT_BIN: '/opt/custom/grok-bot' })).toBe('/opt/custom/grok-bot');
  });

  it('resolveUnit prefers TIERWYN_GROKBOT_UNIT, else the default unit', () => {
    expect(resolveUnit({ TIERWYN_GROKBOT_UNIT: 'custom.service' })).toBe('custom.service');
    expect(resolveUnit({})).toBe(DEFAULT_UNIT);
  });

  it('acquireLaunchLock retries a dead pid', () => {
    const dir = join(tmpdir(), `tierwyn-gb-lk-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    tmps.push(dir);
    const path = join(dir, 'lock');
    writeFileSync(path, '1');
    const got = acquireLaunchLock(path, () => false);
    expect(got.held).toBe('ours');
    releaseLaunchLock(path, got.fd);
    expect(existsQuiet(path)).toBe(false);
  });
});

function failLaunchRun() {
  return async (cmd: string, argv: string[]): Promise<RunResult> => {
    if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
    if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
    if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
    if (argv.includes('start')) return { code: 1, stdout: '', stderr: 'fail' };
    if (cmd === 'systemd-run') return { code: 1, stdout: '', stderr: 'fail' };
    if (argv.includes('show-environment')) {
      return { code: 0, stdout: 'WAYLAND_DISPLAY=wayland-1\nDISPLAY=:0\nXDG_RUNTIME_DIR=/run/user/1000\n', stderr: '' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

function okLaunchRun(onStart?: () => void) {
  return async (cmd: string, argv: string[]): Promise<RunResult> => {
    if (argv.includes('stop')) return { code: 0, stdout: '', stderr: '' };
    if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
    if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
    if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
    if (argv.includes('start')) {
      onStart?.();
      return { code: 0, stdout: '', stderr: '' };
    }
    if (argv.includes('show-environment')) {
      return { code: 0, stdout: 'WAYLAND_DISPLAY=wayland-1\nDISPLAY=:0\nXDG_RUNTIME_DIR=/run/user/1000\n', stderr: '' };
    }
    if (cmd === 'systemd-run') {
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
      return { code: null, stdout: '', stderr: '', error: err };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
}

async function driveToFailed(sup: ReturnType<typeof boot>['sup'], clock: Clock): Promise<void> {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const p = sup.ensureRunning('periodic');
    await clock.flush();
    await p;
    if (i < MAX_ATTEMPTS - 1) await clock.advance(LAUNCH_LADDER_MS[i]!);
  }
}

describe('review M1 probe must not clear sticky states', () => {
  it('GET/probeIfStale from failed (5 attempts) does not relaunch on the next periodic', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    await driveToFailed(h.sup, h.clock);
    expect(h.sup.status().state).toBe('failed');
    expect(h.sup.status().attempts).toBe(MAX_ATTEMPTS);
    const startsAtFailed = h.runCalls.filter((c) => c.argv.includes('start')).length;

    const afterProbe = await h.sup.probeIfStale();
    expect(afterProbe.state).toBe('failed');
    expect(afterProbe.attempts).toBe(MAX_ATTEMPTS);

    const peek = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    expect((await peek).state).toBe('failed');
    expect(h.runCalls.filter((c) => c.argv.includes('start')).length).toBe(startsAtFailed);
    h.cleanup();
  });

  it('probeIfStale from backoff does not skip the ladder', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    const first = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    expect((await first).state).toBe('backoff');
    const starts = h.runCalls.filter((c) => c.argv.includes('start')).length;
    await h.sup.probeIfStale();
    expect(h.sup.status().state).toBe('backoff');
    const peek = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    await peek;
    expect(h.runCalls.filter((c) => c.argv.includes('start')).length).toBe(starts);
    h.cleanup();
  });
});

describe('review M2 disable→enable re-arms the periodic timer', () => {
  it('start → disable → enable → advancing fake time fires ensure-running', async () => {
    let enabled = true;
    const h = boot({
      enabled: () => enabled,
      probeSeq: ['ok'],
      run: okLaunchRun(),
    });
    h.sup.start();
    expect(h.clock.timers.length).toBe(1);
    enabled = false;
    h.sup.refresh();
    expect(h.sup.status().state).toBe('disabled');
    expect(h.clock.timers.length).toBe(0);

    enabled = true;
    h.sup.refresh();
    expect(h.sup.status().state).not.toBe('disabled');
    expect(h.clock.timers.length).toBeGreaterThan(0);
    const probesAfterEnable = h.probes.length;
    await h.clock.advance(CADENCE_MS + 50);
    expect(h.probes.length).toBeGreaterThan(probesAfterEnable);
    h.cleanup();
  });
});

describe('review M3 in-flight launch vs stop/disable', () => {
  it('stop() during launch does not systemctl-stop the just-launched app', async () => {
    const stops: string[][] = [];
    const h = boot({
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('stop')) { stops.push(argv); return { code: 0, stdout: '', stderr: '' }; }
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) {
          writeProc(h.procRoot, 77, { exe: h.bin, argv0: h.bin, cgroup: 'tierwyn-grokbot.service' });
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    h.sup.start();
    const p = h.sup.ensureRunning('manual');
    await h.clock.advance(2_000);
    h.sup.stop();
    await h.clock.advance(START_TIMEOUT_MS);
    await p;
    expect(stops).toHaveLength(0);
    expect(h.sup.status().state).not.toBe('backoff');
    expect(h.sup.status().state).not.toBe('failed');
    h.cleanup();
  });

  it('disable during launch does not stop the app and leaves state disabled', async () => {
    let enabled = true;
    const stops: string[][] = [];
    const h = boot({
      enabled: () => enabled,
      probeSeq: ['down'],
      run: async (cmd, argv) => {
        if (argv.includes('stop')) { stops.push(argv); return { code: 0, stdout: '', stderr: '' }; }
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) {
          writeProc(h.procRoot, 78, { exe: h.bin, argv0: h.bin, cgroup: 'tierwyn-grokbot.service' });
          return { code: 0, stdout: '', stderr: '' };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    h.sup.start();
    const p = h.sup.ensureRunning('manual');
    await h.clock.advance(2_000);
    enabled = false;
    h.sup.refresh();
    await h.clock.advance(START_TIMEOUT_MS);
    const s = await p;
    expect(s.state).toBe('disabled');
    expect(h.sup.status().state).toBe('disabled');
    expect(stops).toHaveLength(0);
    h.cleanup();
  });
});

describe('review m1 prompt does not join a probe-only flight', () => {
  it('on-demand prompt during an in-flight status probe still launches', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let n = 0;
    let starts = 0;
    const h = boot({
      policy: () => 'on-demand',
      probe: async () => {
        n += 1;
        if (n === 1) { await gate; return 'down' as const; }
        if (starts > 0) return 'ok' as const;
        return 'down' as const;
      },
      run: async (cmd, argv) => {
        if (argv.includes('start')) starts += 1;
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const probeP = h.sup.probeIfStale();
    const promptP = h.sup.ensureRunning('prompt');
    release();
    await h.clock.advance(START_TIMEOUT_MS + 100);
    expect((await promptP).state).toBe('running');
    expect(starts).toBeGreaterThan(0);
    await probeP;
    h.cleanup();
  });
});

describe('review m3 spawn env is display-only from the session', () => {
  it('last-resort spawn env is the display allow-list plus PATH/HOME, session first', async () => {
    const h = boot({
      probeSeq: ['down'],
      env: { DISPLAY: ':99', SESSION_SECRET: 's3cret', PATH: '/opt/bin', HOME: '/home/op', XDG_RUNTIME_DIR: '/tmp' },
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'not-found\n', stderr: '' };
        if (argv.includes('show-environment')) {
          return { code: 0, stdout: 'DISPLAY=:0\nWAYLAND_DISPLAY=wayland-1\nXDG_RUNTIME_DIR=/run/user/1000\n', stderr: '' };
        }
        if (cmd === 'systemd-run') {
          const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException;
          return { code: null, stdout: '', stderr: '', error: err };
        }
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const p = h.sup.ensureRunning('manual');
    await h.clock.flush();
    await new Promise<void>((r) => setImmediate(r));
    expect(h.spawnEnvs.length).toBeGreaterThan(0);
    const env = h.spawnEnvs[0]!;
    expect(env.DISPLAY).toBe(':0');
    expect(env.WAYLAND_DISPLAY).toBe('wayland-1');
    expect(env.XDG_RUNTIME_DIR).toBe('/run/user/1000');
    expect(env.SESSION_SECRET).toBeUndefined();
    expect(env.PATH).toBe('/opt/bin');
    expect(env.HOME).toBe('/home/op');
    const allowed = new Set(['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'PATH', 'HOME']);
    for (const k of Object.keys(env)) expect(allowed.has(k)).toBe(true);
    await h.clock.advance(START_TIMEOUT_MS + 50);
    await p;
    h.cleanup();
  });
});

describe('review m4 stale-lock hint is once per attempt on the timeout path', () => {
  it('appends the hint to the timeout error once and does not duplicate on retry', async () => {
    const home = join(tmpdir(), `tierwyn-gb-home-${Math.random().toString(16).slice(2)}`);
    const lockDir = join(home, '.config', 'Grok Bot');
    mkdirSync(lockDir, { recursive: true });
    tmps.push(home);
    const lockFile = join(lockDir, 'SingletonLock');
    symlinkSync('testhost-999999', lockFile);
    const h = boot({
      probeSeq: ['down'],
      homedir: () => home,
      hostname: () => 'testhost',
      isPidAlive: () => false,
      run: async (cmd, argv) => {
        if (argv.includes('is-active')) return { code: 0, stdout: 'active\n', stderr: '' };
        if (argv.includes('LoadState')) return { code: 0, stdout: 'loaded\n', stderr: '' };
        if (argv.includes('ActiveState')) return { code: 0, stdout: 'inactive\n', stderr: '' };
        if (argv.includes('start')) {
          writeProc(h.procRoot, 91, { exe: h.bin, argv0: h.bin, cgroup: 'tierwyn-grokbot.service' });
          return { code: 0, stdout: '', stderr: '' };
        }
        if (argv.includes('stop')) return { code: 0, stdout: '', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const p = h.sup.ensureRunning('manual');
    await h.clock.advance(START_TIMEOUT_MS + 100);
    const s = await p;
    expect(s.lastError).toContain(lockFile);
    expect(s.lastError).toMatch(/did not open CDP/);
    expect(s.lastError!.split('Stale SingletonLock').length - 1).toBe(1);
    h.cleanup();
  });
});

describe('review n3/n4 kick-before-start and first refresh', () => {
  it('kick() before start() does not launch', async () => {
    const h = boot({ probeSeq: ['down', 'ok'], run: okLaunchRun() });
    h.sup.kick();
    await h.clock.advance(BOOT_DELAY_MS + 50);
    expect(h.runCalls.some((c) => c.argv.includes('start'))).toBe(false);
    h.cleanup();
  });

  it('first refresh with unchanged enabled/policy does not reset the failure count', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    const p = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    await p;
    expect(h.sup.status().attempts).toBe(1);
    h.sup.refresh();
    expect(h.sup.status().attempts).toBe(1);
    expect(h.sup.status().state).toBe('backoff');
    h.cleanup();
  });
});

describe('review m8 probeIfStale is TTL-cached', () => {
  it('a second GET within 8s does not issue another CDP probe', async () => {
    const h = boot({ probeSeq: ['ok'] });
    await h.sup.probeIfStale();
    const n = h.probes.length;
    expect(n).toBeGreaterThan(0);
    await h.sup.probeIfStale();
    expect(h.probes.length).toBe(n);
    await h.clock.advance(8_000);
    await h.sup.probeIfStale();
    expect(h.probes.length).toBeGreaterThan(n);
    h.cleanup();
  });
});

describe('review N1 probe-only must not launder failed via a foreign proc', () => {
  it('H2: failed + probeOnly with CDP-less foreign proc stays failed; next periodic does not launch', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    await driveToFailed(h.sup, h.clock);
    expect(h.sup.status().state).toBe('failed');
    expect(h.sup.status().attempts).toBe(MAX_ATTEMPTS);
    const startsAtFailed = h.runCalls.filter((c) => c.argv.includes('start')).length;

    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const afterProbe = await h.sup.probeIfStale();
    expect(afterProbe.state).toBe('failed');
    expect(afterProbe.attempts).toBe(MAX_ATTEMPTS);

    rmSync(join(h.procRoot, '88'), { recursive: true, force: true });
    const peek = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    expect((await peek).state).toBe('failed');
    expect(h.runCalls.filter((c) => c.argv.includes('start')).length).toBe(startsAtFailed);
    h.cleanup();
  });
});

describe('review B1 launch latch survives relabel off failed/backoff', () => {
  it('periodic foreign proc: failed 5 → relabel → proc gone → no launch, attempts stay 5', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    await driveToFailed(h.sup, h.clock);
    const startsAtFailed = h.runCalls.filter((c) => c.argv.includes('start')).length;

    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const relabel = h.sup.ensureRunning('periodic');
    await h.clock.advance(FOREIGN_GRACE_MS + 100);
    expect((await relabel).state).toBe('running-no-cdp');
    expect(h.sup.status().attempts).toBe(MAX_ATTEMPTS);

    rmSync(join(h.procRoot, '88'), { recursive: true, force: true });
    const peek = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    const after = await peek;
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(h.runCalls.filter((c) => c.argv.includes('start')).length).toBe(startsAtFailed);
    h.cleanup();
  });

  it('in-window backoff: relabel then proc gone does not launch before nextAttemptAt', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    const first = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    expect((await first).state).toBe('backoff');
    expect(h.sup.status().attempts).toBe(1);
    const nextAttemptAt = h.sup.status().nextAttemptAt!;
    const starts = h.runCalls.filter((c) => c.argv.includes('start')).length;

    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const relabel = h.sup.ensureRunning('periodic');
    await h.clock.advance(FOREIGN_GRACE_MS + 100);
    expect((await relabel).state).toBe('running-no-cdp');

    rmSync(join(h.procRoot, '88'), { recursive: true, force: true });
    expect(h.clock.now()).toBeLessThan(nextAttemptAt);
    const peek = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    await peek;
    expect(h.clock.now()).toBeLessThan(nextAttemptAt);
    expect(h.runCalls.filter((c) => c.argv.includes('start')).length).toBe(starts);
    expect(h.sup.status().attempts).toBe(1);
    h.cleanup();
  });

  it('port conflict: failed 5 → port-conflict → down probe → no launch', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    await driveToFailed(h.sup, h.clock);
    const startsAtFailed = h.runCalls.filter((c) => c.argv.includes('start')).length;

    h.setProbe(['no-target']);
    const relabel = h.sup.ensureRunning('periodic');
    await h.clock.advance(PORT_CONFLICT_GRACE_MS + 100);
    expect((await relabel).state).toBe('port-conflict');
    expect(h.sup.status().attempts).toBe(MAX_ATTEMPTS);

    h.setProbe(['down']);
    const peek = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    const after = await peek;
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(h.runCalls.filter((c) => c.argv.includes('start')).length).toBe(startsAtFailed);
    h.cleanup();
  });

  it('on-demand and prompt stay blocked after failed relabels to running-no-cdp', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    await driveToFailed(h.sup, h.clock);
    const startsAtFailed = h.runCalls.filter((c) => c.argv.includes('start')).length;

    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const relabel = h.sup.ensureRunning('periodic');
    await h.clock.advance(FOREIGN_GRACE_MS + 100);
    expect((await relabel).state).toBe('running-no-cdp');
    rmSync(join(h.procRoot, '88'), { recursive: true, force: true });

    for (const reason of ['on-demand', 'prompt'] as const) {
      const p = h.sup.ensureRunning(reason);
      await h.clock.flush();
      await p;
      expect(h.runCalls.filter((c) => c.argv.includes('start')).length).toBe(startsAtFailed);
      expect(h.sup.status().attempts).toBe(MAX_ATTEMPTS);
    }
    h.cleanup();
  });
});

describe('review S1 probe-only must not demote a latched diagnostic', () => {
  it('latched running-no-cdp: three probe reads after proc gone never write stopped; periodic restores once', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    await driveToFailed(h.sup, h.clock);
    const giveUp = h.sup.status().lastError;
    expect(giveUp).toBeTruthy();

    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const relabel = h.sup.ensureRunning('periodic');
    await h.clock.advance(FOREIGN_GRACE_MS + 100);
    expect((await relabel).state).toBe('running-no-cdp');
    expect(h.sup.status().lastError).toMatch(/running without remote debugging/);

    rmSync(join(h.procRoot, '88'), { recursive: true, force: true });
    const transitionsAtRelabel = h.transitions.length;

    for (let i = 0; i < 3; i++) {
      await h.clock.advance(PROBE_STALE_MS);
      const probe = await h.sup.probeIfStale();
      expect(probe.state).not.toBe('stopped');
      expect(probe.attempts).toBe(MAX_ATTEMPTS);
    }
    expect(h.transitions.length).toBe(transitionsAtRelabel);
    expect(h.sup.status().state).toBe('running-no-cdp');

    const restore = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    const after = await restore;
    expect(after.state).toBe('failed');
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(h.transitions.length).toBe(transitionsAtRelabel + 1);
    expect(after.lastError).toBe(giveUp);
    expect(after.lastError ?? '').not.toMatch(/running without remote debugging/);
    h.cleanup();
  });

  it('latched port-conflict restore replaces the port-taken lastError with the give-up message', async () => {
    const h = boot({ probeSeq: ['down'], run: failLaunchRun(), spawnDetached: () => { throw new Error('no'); } });
    await driveToFailed(h.sup, h.clock);
    const giveUp = h.sup.status().lastError;
    expect(giveUp).toBeTruthy();

    h.setProbe(['no-target']);
    const relabel = h.sup.ensureRunning('periodic');
    await h.clock.advance(PORT_CONFLICT_GRACE_MS + 100);
    expect((await relabel).state).toBe('port-conflict');
    expect(h.sup.status().lastError).toMatch(/Port 9333 answered/);

    h.setProbe(['down']);
    const restore = h.sup.ensureRunning('periodic');
    await h.clock.flush();
    const after = await restore;
    expect(after.state).toBe('failed');
    expect(after.attempts).toBe(MAX_ATTEMPTS);
    expect(after.lastError).toBe(giveUp);
    expect(after.lastError ?? '').not.toMatch(/Port 9333 answered/);
    expect(after.lastError ?? '').not.toMatch(/not a Grok Bot page target/);
    h.cleanup();
  });
});

describe('review N3 probe-only must not notify during foreign CDP grace', () => {
  it('probe-only during FOREIGN_GRACE_MS does not classify running-no-cdp and does not notify', async () => {
    const h = boot({ probeSeq: ['down'] });
    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const s = await h.sup.probeIfStale();
    expect(s.state).not.toBe('running-no-cdp');
    expect(s.state).not.toBe('port-conflict');
    expect(h.notifies).toHaveLength(0);
    h.cleanup();
  });

  it('probe-only after FOREIGN_GRACE_MS classifies running-no-cdp but still does not notify', async () => {
    const h = boot({ probeSeq: ['down'] });
    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    await h.sup.probeIfStale();
    await h.clock.advance(FOREIGN_GRACE_MS);
    const s = await h.sup.probeIfStale();
    expect(s.state).toBe('running-no-cdp');
    expect(h.notifies).toHaveLength(0);
    h.cleanup();
  });

  it('periodic-path running-no-cdp still notifies', async () => {
    const h = boot({ probeSeq: ['down'] });
    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const p = h.sup.ensureRunning('periodic');
    await h.clock.advance(FOREIGN_GRACE_MS + 100);
    expect((await p).state).toBe('running-no-cdp');
    expect(h.notifies).toHaveLength(1);
    h.cleanup();
  });

  it('U3: a prior no-target stamp does not skip grace for a just-appeared proc', async () => {
    const h = boot({ probeSeq: ['no-target'] });
    const first = await h.sup.probeIfStale();
    expect(first.state).not.toBe('running-no-cdp');
    expect(first.state).not.toBe('port-conflict');
    await h.clock.advance(FOREIGN_GRACE_MS);
    h.setProbe(['down']);
    writeProc(h.procRoot, 88, { exe: h.bin, argv0: basenameSafe(h.bin), cgroup: 'app-grok.scope' });
    const s = await h.sup.probeIfStale();
    expect(s.state).not.toBe('running-no-cdp');
    expect(h.notifies).toHaveLength(0);
    await h.clock.advance(FOREIGN_GRACE_MS);
    const classified = await h.sup.probeIfStale();
    expect(classified.state).toBe('running-no-cdp');
    expect(h.notifies).toHaveLength(0);
    h.cleanup();
  });
});

describe('review N4 GET does not join an in-flight launch', () => {
  it('probeIfStale during launch returns current status without waiting for START_TIMEOUT', async () => {
    const h = boot({ probeSeq: ['down'], run: okLaunchRun() });
    const launch = h.sup.ensureRunning('manual');
    await h.clock.flush();
    expect(h.sup.status().state).toBe('starting');
    let resolved = false;
    const p = h.sup.probeIfStale().then((s) => { resolved = true; return s; });
    await h.clock.flush();
    expect(resolved).toBe(true);
    expect((await p).state).toBe('starting');
    await h.clock.advance(START_TIMEOUT_MS + 100);
    await launch;
    h.cleanup();
  });
});

describe('schedule bindEnsureGrokBot kick+status', () => {
  it('launchable on-demand marks starting synchronously before probe awaits', async () => {
    const h = boot({
      probeSeq: ['down'],
      run: okLaunchRun(),
      policy: () => 'on-demand',
    });
    expect(h.sup.status().state).toBe('stopped');
    const launch = h.sup.ensureRunning('on-demand');
    // Same turn as the kick: schedule pre-check reads this without awaiting.
    expect(h.sup.status().state).toBe('starting');
    await h.clock.advance(START_TIMEOUT_MS + 100);
    await launch;
    h.cleanup();
  });

  it('disabled ensure does not mark starting', async () => {
    const h = boot({
      probeSeq: ['down'],
      enabled: () => false,
      policy: () => 'on-demand',
    });
    const launch = h.sup.ensureRunning('on-demand');
    expect(h.sup.status().state).toBe('disabled');
    await launch;
    h.cleanup();
  });
});

describe('review N8 supervisorMessage uses the configured port', () => {
  it('running-no-cdp fallback interpolates the given port, not 9333', () => {
    const status: GrokBotLifecycleStatus = {
      state: 'running-no-cdp',
      enabled: true,
      autoStart: 'keep-running',
      envLocks: { autostart: false, watch: false },
      launcher: null,
      attribution: null,
      layout: 'native',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastErrorAt: null,
      since: 1,
    };
    const msg = supervisorMessage(status, 9444);
    expect(msg).toContain('9444');
    expect(msg).not.toContain('9333');
  });
});
