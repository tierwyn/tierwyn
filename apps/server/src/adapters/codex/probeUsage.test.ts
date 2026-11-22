import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseCodexRateLimitsJson,
  parseCodexRateLimitsNotification,
  parseCodexInsights,
  probeCodexRateLimits,
  resetCodexUsageProbeForTests,
  CODEX_USAGE_PROBE_ARGS,
} from './probeUsage.js';

// Verified against codex-cli 0.142.5 free plan: single 30-day primary window,
// null secondary, resetsAt in unix SECONDS.
const FREE_PLAN = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 1, windowDurationMins: 43200, resetsAt: 1789938395 },
    secondary: null,
    credits: { hasCredits: false, unlimited: false, balance: null },
    planType: 'free',
  },
  rateLimitsByLimitId: {
    codex: {
      limitId: 'codex',
      primary: { usedPercent: 1, windowDurationMins: 43200, resetsAt: 1789938395 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: null },
      planType: 'free',
    },
  },
  rateLimitResetCredits: { availableCount: 0 },
};

// Expected paid shape: 5h primary + weekly secondary.
const PAID_PLAN = {
  rateLimits: {
    limitId: 'codex',
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1789938395 },
    secondary: { usedPercent: 63, windowDurationMins: 10080, resetsAt: 1790500000 },
    credits: { hasCredits: false, unlimited: true, balance: null },
    planType: 'pro',
  },
};

describe('parseCodexRateLimitsJson', () => {
  it('maps a free-plan 30-day primary window to the seven-day bucket and seconds to ms', () => {
    const out = parseCodexRateLimitsJson(FREE_PLAN);
    expect(out.sevenDayPct).toBe(1);
    expect(out.sevenDayResetsAt).toBe(1789938395 * 1000);
    expect(out.subscriptionType).toBe('free');
    expect(out.fiveHourPct).toBeUndefined();
    expect(out.fiveHourResetsAt).toBeUndefined();
    expect(out.manualResetsAvailable).toBe(0);
    expect(out.hasCredits).toBe(false);
    expect(out.longWindowLabel).toBe('30d window used');
  });

  it('maps a paid plan: 5h primary + weekly secondary land in both buckets', () => {
    const out = parseCodexRateLimitsJson(PAID_PLAN);
    expect(out.fiveHourPct).toBe(42);
    expect(out.fiveHourResetsAt).toBe(1789938395 * 1000);
    expect(out.sevenDayPct).toBe(63);
    expect(out.sevenDayResetsAt).toBe(1790500000 * 1000);
    expect(out.subscriptionType).toBe('pro');
    expect(out.unlimitedCredits).toBe(true);
  });

  it('clamps percent to 0–100 and skips invalid resetsAt', () => {
    const high = parseCodexRateLimitsJson({
      rateLimits: {
        primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: 'not-a-number' },
        planType: 'team',
      },
    });
    expect(high.fiveHourPct).toBe(100);
    expect(high.fiveHourResetsAt).toBeUndefined();

    const low = parseCodexRateLimitsJson({
      rateLimits: {
        primary: { usedPercent: -4, windowDurationMins: 43200, resetsAt: 0 },
      },
    });
    expect(low.sevenDayPct).toBe(0);
    expect(low.sevenDayResetsAt).toBeUndefined();
  });

  it('accepts string numerics and ignores rateLimitsByLimitId', () => {
    const out = parseCodexRateLimitsJson({
      rateLimits: {
        primary: { usedPercent: '12', windowDurationMins: '43200', resetsAt: '1789938395' },
        planType: 'free',
      },
      rateLimitsByLimitId: {
        other: { primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1 }, planType: 'bogus' },
      },
    });
    expect(out.sevenDayPct).toBe(12);
    expect(out.sevenDayResetsAt).toBe(1789938395 * 1000);
    expect(out.subscriptionType).toBe('free');
    expect(out.fiveHourPct).toBeUndefined();
  });

  it('accepts the direct notification shape (rateLimits object unwrapped)', () => {
    const direct = parseCodexRateLimitsNotification(FREE_PLAN.rateLimits);
    expect(direct.sevenDayPct).toBe(1);
    expect(direct.subscriptionType).toBe('free');
  });

  it('returns {} for null/malformed payloads without throwing', () => {
    expect(parseCodexRateLimitsJson(null)).toEqual({});
    expect(parseCodexRateLimitsJson({})).toEqual({});
    expect(parseCodexRateLimitsJson({ rateLimits: null })).toEqual({});
    expect(parseCodexRateLimitsJson('not json')).toEqual({});
    expect(parseCodexRateLimitsJson({ rateLimits: { primary: 'nope' } })).toEqual({});
  });
});

describe('parseCodexInsights', () => {
  it('parses summary lifetime tokens, streaks, and daily buckets', () => {
    const usage = {
      summary: {
        lifetimeTokens: 4992748,
        peakDailyTokens: 3098714,
        longestRunningTurnSec: 170,
        currentStreakDays: 1,
        longestStreakDays: 2,
      },
      dailyUsageBuckets: [
        { startDate: '2026-07-07', tokens: 212663 },
        { startDate: '2026-07-08', tokens: 3098714 },
      ],
    };

    const out = parseCodexInsights(FREE_PLAN, usage);
    expect(out.subscriptionType).toBe('free');
    expect(out.manualResetsAvailable).toBe(0);
    expect(out.hasCredits).toBe(false);
    expect(out.summary?.lifetimeTokens).toBe(4992748);
    expect(out.summary?.peakDailyTokens).toBe(3098714);
    expect(out.summary?.currentStreakDays).toBe(1);
    expect(out.summary?.longestStreakDays).toBe(2);
    expect(out.dailyUsageBuckets?.length).toBe(2);
    expect(out.primaryWindow?.windowDurationMins).toBe(43200);
    expect(out.updatedAt).toEqual(expect.any(Number));
  });

  it('handles null/empty gracefully', () => {
    const out = parseCodexInsights(null, null);
    expect(out.updatedAt).toEqual(expect.any(Number));
    expect(out.summary).toBeUndefined();
  });
});

function fakeCodexRateLimitsChild(result: unknown, opts?: { methodNotFound?: boolean }) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => void;
    killedSignal?: string;
    methods: string[];
  };
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.methods = [];
  proc.kill = (signal?: string) => {
    proc.killedSignal = signal;
    proc.emit('close', 0);
  };

  stdin.on('data', (d: Buffer) => {
    for (const line of d.toString().split('\n').filter(Boolean)) {
      const msg = JSON.parse(line) as { id?: number; method?: string };
      if (msg.id === undefined) continue;
      proc.methods.push(String(msg.method));
      if (msg.method === 'initialize') {
        // app-server omits jsonrpc in responses — CodexRpc tolerates that.
        stdout.write(JSON.stringify({
          id: msg.id,
          result: { userAgent: 'test', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'linux' },
        }) + '\n');
      } else if (msg.method === 'account/rateLimits/read') {
        if (opts?.methodNotFound) {
          stdout.write(JSON.stringify({
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          }) + '\n');
        } else {
          stdout.write(JSON.stringify({ id: msg.id, result }) + '\n');
        }
      } else {
        stdout.write(JSON.stringify({
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        }) + '\n');
      }
    }
  });

  return proc;
}

describe('probeCodexRateLimits', () => {
  afterEach(() => {
    resetCodexUsageProbeForTests();
  });

  it('spawns codex app-server, calls initialize + account/rateLimits/read, no thread/turn', async () => {
    let captured: { cmd: string; args: string[] } | undefined;
    const child = fakeCodexRateLimitsChild(FREE_PLAN);

    const out = await probeCodexRateLimits({
      force: true,
      spawnFn: (cmd, args) => {
        captured = { cmd, args };
        return child as never;
      },
    });

    expect(captured?.cmd).toBe('codex');
    expect(captured?.args).toEqual(CODEX_USAGE_PROBE_ARGS);
    expect(captured?.args).toEqual(['app-server']);
    expect(child.methods).toContain('initialize');
    expect(child.methods).toContain('account/rateLimits/read');
    expect(child.methods).not.toContain('thread/start');
    expect(child.methods).not.toContain('turn/start');
    expect(out.sevenDayPct).toBe(1);
    expect(out.sevenDayResetsAt).toBe(1789938395 * 1000);
    expect(out.subscriptionType).toBe('free');
    expect(child.killedSignal).toBe('SIGTERM');
  });

  it('caches a successful result for 20s; force bypasses', async () => {
    let spawns = 0;
    const ok = await probeCodexRateLimits({
      spawnFn: () => {
        spawns += 1;
        return fakeCodexRateLimitsChild(PAID_PLAN) as never;
      },
    });
    expect(ok.fiveHourPct).toBe(42);
    expect(ok.sevenDayPct).toBe(63);

    const cached = await probeCodexRateLimits({
      spawnFn: () => {
        spawns += 1;
        throw new Error('should not spawn');
      },
    });
    expect(cached.fiveHourPct).toBe(ok.fiveHourPct);
    expect(cached.sevenDayPct).toBe(ok.sevenDayPct);
    expect(spawns).toBe(1);

    // force bypasses the cache → spawns again
    const fresh = await probeCodexRateLimits({
      force: true,
      spawnFn: () => {
        spawns += 1;
        return fakeCodexRateLimitsChild(PAID_PLAN) as never;
      },
    });
    expect(fresh.fiveHourPct).toBe(42);
    expect(spawns).toBe(2);
  });

  it('returns {} on spawn failure', async () => {
    const failed = await probeCodexRateLimits({
      force: true,
      spawnFn: () => {
        throw new Error('enoent');
      },
    });
    expect(failed).toEqual({});
  });

  it('returns {} when account/rateLimits/read is method-not-found', async () => {
    const out = await probeCodexRateLimits({
      force: true,
      spawnFn: () => fakeCodexRateLimitsChild(FREE_PLAN, { methodNotFound: true }) as never,
    });
    expect(out).toEqual({});
  });

  it('returns {} when the read result is malformed', async () => {
    const out = await probeCodexRateLimits({
      force: true,
      spawnFn: () => fakeCodexRateLimitsChild({ nonsense: true }) as never,
    });
    expect(out).toEqual({});
  });
});
