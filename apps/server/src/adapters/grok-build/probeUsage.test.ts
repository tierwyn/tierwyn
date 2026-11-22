import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseGrokBillingJson,
  probeGrokRateLimits,
  resetGrokUsageProbeForTests,
  GROK_USAGE_PROBE_ARGS,
} from './probeUsage.js';

const WEEKLY = {
  config: {
    creditUsagePercent: 24.0,
    currentPeriod: {
      type: 'USAGE_PERIOD_TYPE_WEEKLY',
      start: '2026-08-20T20:28:50.940238+00:00',
      end: '2026-08-27T20:28:50.940238+00:00',
    },
    isUnifiedBillingUser: true,
    prepaidBalance: { val: 0 },
    onDemandCap: { val: 0 },
    onDemandUsed: { val: 0 },
    billingPeriodStart: '2026-08-20T20:28:50.940238+00:00',
    billingPeriodEnd: '2026-08-27T20:28:50.940238+00:00',
  },
  subscription_tier: 'SuperGrok',
};

describe('parseGrokBillingJson', () => {
  it('reads creditUsagePercent as a 0–100 used percent (does not multiply by 100) and extracts monetary values', () => {
    const out = parseGrokBillingJson(WEEKLY);
    expect(out.sevenDayPct).toBe(24);
    expect(out.sevenDayResetsAt).toBe(Date.parse('2026-08-27T20:28:50.940238+00:00'));
    expect(out.subscriptionType).toBe('SuperGrok');
    expect(out.prepaidBalance).toBe(0);
    expect(out.onDemandCap).toBe(0);
    expect(out.onDemandUsed).toBe(0);
    expect(out.fiveHourPct).toBeUndefined();
  });

  it('treats a weekly currentPeriod with omitted percent as 0% used', () => {
    const out = parseGrokBillingJson({
      config: {
        currentPeriod: {
          type: 'USAGE_PERIOD_TYPE_WEEKLY',
          start: '2026-08-20T20:28:50Z',
          end: '2026-08-27T20:28:50Z',
        },
        isUnifiedBillingUser: true,
      },
    });
    expect(out.sevenDayPct).toBe(0);
    expect(out.sevenDayResetsAt).toBe(Date.parse('2026-08-27T20:28:50Z'));
  });

  it('falls back to used/monthlyLimit percent on the legacy billing shape', () => {
    const out = parseGrokBillingJson({
      config: {
        monthlyLimit: { val: 2000 },
        used: { val: 500 },
        billingPeriodEnd: '2026-09-01T00:00:00Z',
      },
      subscriptionTier: 'SuperGrok',
    });
    expect(out.sevenDayPct).toBe(25);
    expect(out.sevenDayResetsAt).toBe(Date.parse('2026-09-01T00:00:00Z'));
    expect(out.subscriptionType).toBe('SuperGrok');
  });

  it('clamps percent to 0–100 and skips bad reset timestamps', () => {
    const high = parseGrokBillingJson({
      config: { creditUsagePercent: 140, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', end: 'nope' } },
    });
    expect(high.sevenDayPct).toBe(100);
    expect(high.sevenDayResetsAt).toBeUndefined();

    const low = parseGrokBillingJson({
      config: { creditUsagePercent: -4, billingPeriodEnd: '2026-08-27T00:00:00Z' },
    });
    expect(low.sevenDayPct).toBe(0);
    expect(low.sevenDayResetsAt).toBe(Date.parse('2026-08-27T00:00:00Z'));
  });

  it('converts monetary values from cents to US dollars', () => {
    const out = parseGrokBillingJson({
      config: {
        creditUsagePercent: 10,
        prepaidBalance: { val: 485 },
        onDemandUsed: { val: 150 },
        onDemandCap: { val: 2000 },
      },
    });
    expect(out.prepaidBalance).toBe(4.85);
    expect(out.onDemandUsed).toBe(1.5);
    expect(out.onDemandCap).toBe(20);
  });

  it('converts plain-number monetary values from cents to US dollars', () => {
    const out = parseGrokBillingJson({ config: { creditUsagePercent: 10, prepaidBalance: 485 } });
    expect(out.prepaidBalance).toBe(4.85);
  });

  it('returns {} for empty or malformed payloads without throwing', () => {
    expect(parseGrokBillingJson(null)).toEqual({});
    expect(parseGrokBillingJson({})).toEqual({});
    expect(parseGrokBillingJson({ config: null })).toEqual({});
    expect(parseGrokBillingJson('not json')).toEqual({});
  });
});

function fakeGrokBillingChild(result: unknown, opts?: { methodNotFound?: boolean }) {
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
        stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        }) + '\n');
      } else if (msg.method === '_x.ai/billing') {
        if (opts?.methodNotFound) {
          stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32601, message: 'Method not found' },
          }) + '\n');
        } else {
          stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        }
      } else {
        stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: 'Method not found' },
        }) + '\n');
      }
    }
  });

  return proc;
}

describe('probeGrokRateLimits', () => {
  afterEach(() => {
    resetGrokUsageProbeForTests();
  });

  it('spawns grok agent --no-leader stdio and calls _x.ai/billing (not x.ai/billing)', async () => {
    let captured: { cmd: string; args: string[] } | undefined;
    const child = fakeGrokBillingChild(WEEKLY);

    const out = await probeGrokRateLimits({
      force: true,
      spawnFn: (cmd, args) => {
        captured = { cmd, args };
        return child as never;
      },
    });

    expect(captured?.cmd).toBe('grok');
    expect(captured?.args).toEqual(GROK_USAGE_PROBE_ARGS);
    expect(captured?.args).toEqual(['agent', '--no-leader', 'stdio']);
    expect(child.methods).toContain('initialize');
    expect(child.methods).toContain('_x.ai/billing');
    expect(child.methods).not.toContain('x.ai/billing');
    expect(child.methods).not.toContain('session/new');
    expect(out.sevenDayPct).toBe(24);
    expect(out.subscriptionType).toBe('SuperGrok');
    expect(child.killedSignal).toBeDefined();
  });

  it('returns {} on spawn failure and caches a successful result for 20s', async () => {
    let spawns = 0;
    const ok = await probeGrokRateLimits({
      spawnFn: () => {
        spawns += 1;
        return fakeGrokBillingChild(WEEKLY) as never;
      },
    });
    expect(ok.sevenDayPct).toBe(24);

    const cached = await probeGrokRateLimits({
      spawnFn: () => {
        spawns += 1;
        throw new Error('should not spawn');
      },
    });
    expect(cached.sevenDayPct).toBe(ok.sevenDayPct);
    expect(spawns).toBe(1);

    const failed = await probeGrokRateLimits({
      force: true,
      spawnFn: () => {
        throw new Error('enoent');
      },
    });
    expect(failed).toEqual({});
  });

  it('returns {} when _x.ai/billing is method-not-found', async () => {
    const out = await probeGrokRateLimits({
      force: true,
      spawnFn: () => fakeGrokBillingChild(WEEKLY, { methodNotFound: true }) as never,
    });
    expect(out).toEqual({});
  });
});
