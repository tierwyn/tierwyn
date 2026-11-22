import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseKiroUsageText,
  parseKiroContextText,
  probeKiroRateLimits,
  probeKiroContext,
  resetKiroUsageProbeForTests,
  KIRO_USAGE_PROBE_ARGS,
  kiroContextProbeArgs,
} from './probeUsage.js';

/** Live output of `kiro-cli chat --no-interactive "/usage"` (ANSI-stripped). */
const USAGE_FIXTURE = `Estimated Usage | resets on 2026-09-01 | KIRO FREE
Credits (1.40 of 50 covered in plan)
████████████████████████████████████████████████████████████████████████████████ 2%

To manage your plan navigate to https://app.kiro.dev/account/usage

Tip: to see context window usage, run /context
`;

/** Live output of `kiro-cli chat --no-interactive --resume-id <id> "/context"`. */
const CONTEXT_FIXTURE = `Context window: 1.4% used (estimated)
█ Context files 0.6% (estimated)
█ Tools 0.8% (estimated)
█ Kiro responses 0.0% (estimated)
█ Your prompts 0.0% (estimated)
`;

describe('parseKiroUsageText', () => {
  it('parses plan, reset date, credits used/limit, and computed monthly pct', () => {
    const out = parseKiroUsageText(USAGE_FIXTURE);
    expect(out.subscriptionType).toBe('KIRO FREE');
    expect(out.monthlyResetsAt).toBe(Date.parse('2026-09-01'));
    expect(out.creditsUsed).toBe(1.4);
    expect(out.creditsLimit).toBe(50);
    expect(out.monthlyPct).toBeCloseTo((1.4 / 50) * 100);
    expect(out.sevenDayPct).toBeUndefined();
    expect(out.fiveHourPct).toBeUndefined();
  });

  it('strips ANSI before matching', () => {
    const coloured = `\x1b[1mEstimated Usage\x1b[0m | resets on 2026-09-01 | \x1b[32mKIRO FREE\x1b[0m
Credits (1.40 of 50 covered in plan)
`;
    const out = parseKiroUsageText(coloured);
    expect(out.subscriptionType).toBe('KIRO FREE');
    expect(out.creditsUsed).toBe(1.4);
    expect(out.creditsLimit).toBe(50);
  });

  it('ignores add-on (N used) rows and keeps the first covered-in-plan row', () => {
    const raw = `Estimated Usage | resets on 2026-09-01 | KIRO PRO
Credits (10.00 of 1000 covered in plan)
Overage (3.50 used)
Extra (20.00 of 200 covered in plan)
`;
    const out = parseKiroUsageText(raw);
    expect(out.creditsUsed).toBe(10);
    expect(out.creditsLimit).toBe(1000);
    expect(out.monthlyPct).toBeCloseTo(1);
    expect(out.subscriptionType).toBe('KIRO PRO');
  });

  it('clamps monthly pct to 0–100 and skips a zero limit', () => {
    const over = parseKiroUsageText('Credits (120 of 100 covered in plan)\n');
    expect(over.monthlyPct).toBe(100);
    expect(over.creditsUsed).toBe(120);
    expect(over.creditsLimit).toBe(100);

    const zero = parseKiroUsageText('Credits (1.00 of 0 covered in plan)\n');
    expect(zero.creditsUsed).toBe(1);
    expect(zero.creditsLimit).toBe(0);
    expect(zero.monthlyPct).toBeUndefined();
  });

  it('returns {} for empty or unrecognised text without throwing', () => {
    expect(parseKiroUsageText('')).toEqual({});
    expect(parseKiroUsageText('not a usage dump')).toEqual({});
  });
});

describe('parseKiroContextText', () => {
  it('parses overall percent and breakdown rows from the live fixture', () => {
    const out = parseKiroContextText(CONTEXT_FIXTURE);
    expect(out.contextWindowPct).toBeCloseTo(1.4);
    expect(out.contextBreakdown).toEqual({
      filesPct: 0.6,
      toolsPct: 0.8,
      responsesPct: 0,
      promptsPct: 0,
    });
  });

  it('strips ANSI and returns {} for garbage', () => {
    const coloured = '\x1b[36mContext window: 3.2% used (estimated)\x1b[0m\n';
    expect(parseKiroContextText(coloured).contextWindowPct).toBeCloseTo(3.2);
    expect(parseKiroContextText('hello')).toEqual({});
  });
});

function fakeProbeChild(opts: { stderr?: string; stdout?: string; error?: Error } = {}) {
  const stdin = new PassThrough();
  const out = new PassThrough();
  const err = new PassThrough();
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: (signal?: string) => void;
    killedSignal?: string;
  };
  proc.stdin = stdin;
  proc.stdout = out;
  proc.stderr = err;
  proc.kill = (signal?: string) => {
    proc.killedSignal = signal;
    proc.emit('close', 1);
  };
  queueMicrotask(() => {
    if (opts.error) {
      proc.emit('error', opts.error);
      return;
    }
    if (opts.stdout) out.write(opts.stdout);
    if (opts.stderr) err.write(opts.stderr);
    out.end();
    err.end();
    proc.emit('close', 0);
  });
  return proc;
}

describe('probeKiroRateLimits', () => {
  afterEach(() => {
    resetKiroUsageProbeForTests();
  });

  it('spawns kiro-cli chat --no-interactive /usage and reads stdout (newer CLIs print there)', async () => {
    let captured: { cmd: string; args: string[]; stdinEnded: boolean } | undefined;
    const child = fakeProbeChild({ stdout: USAGE_FIXTURE });
    const ended = new Promise<void>((resolve) => {
      child.stdin.on('finish', () => resolve());
    });

    const out = await probeKiroRateLimits({
      force: true,
      spawnFn: (cmd, args) => {
        captured = { cmd, args, stdinEnded: false };
        return child as never;
      },
    });

    await ended;
    expect(captured?.cmd).toBe('kiro-cli');
    expect(captured?.args).toEqual([...KIRO_USAGE_PROBE_ARGS]);
    expect(captured?.args).toEqual(['chat', '--no-interactive', '/usage']);
    expect(out.subscriptionType).toBe('KIRO FREE');
    expect(out.creditsUsed).toBe(1.4);
    expect(out.creditsLimit).toBe(50);
    expect(out.monthlyPct).toBeCloseTo(2.8);
    expect(out.monthlyResetsAt).toBe(Date.parse('2026-09-01'));
  });

  it('returns {} on spawn failure and caches a successful result for 20s', async () => {
    let spawns = 0;
    const ok = await probeKiroRateLimits({
      spawnFn: () => {
        spawns += 1;
        return fakeProbeChild({ stderr: USAGE_FIXTURE }) as never;
      },
    });
    expect(ok.creditsUsed).toBe(1.4);

    const cached = await probeKiroRateLimits({
      spawnFn: () => {
        spawns += 1;
        throw new Error('should not spawn');
      },
    });
    expect(cached.creditsUsed).toBe(ok.creditsUsed);
    expect(spawns).toBe(1);

    const failed = await probeKiroRateLimits({
      force: true,
      spawnFn: () => {
        throw new Error('enoent');
      },
    });
    expect(failed).toEqual({});
  });
});

describe('probeKiroContext', () => {
  afterEach(() => {
    resetKiroUsageProbeForTests();
  });

  it('spawns --resume-id /context and caches per resumeId', async () => {
    let captured: { cmd: string; args: string[] } | undefined;
    let spawns = 0;
    const spawnFn = (cmd: string, args: string[]) => {
      spawns += 1;
      captured = { cmd, args };
      return fakeProbeChild({ stderr: CONTEXT_FIXTURE }) as never;
    };

    const out = await probeKiroContext({ resumeId: 'sess-1', spawnFn });
    expect(captured?.cmd).toBe('kiro-cli');
    expect(captured?.args).toEqual(kiroContextProbeArgs('sess-1'));
    expect(out.contextWindowPct).toBeCloseTo(1.4);
    expect(out.contextBreakdown?.filesPct).toBeCloseTo(0.6);

    const cached = await probeKiroContext({
      resumeId: 'sess-1',
      spawnFn: () => {
        throw new Error('should not spawn');
      },
    });
    expect(cached.contextWindowPct).toBe(out.contextWindowPct);
    expect(spawns).toBe(1);

    await probeKiroContext({ resumeId: 'sess-2', spawnFn });
    expect(spawns).toBe(2);
  });

  it('returns {} when resumeId is empty or spawn fails', async () => {
    expect(await probeKiroContext({ resumeId: '', spawnFn: () => { throw new Error('no'); } })).toEqual({});
    const failed = await probeKiroContext({
      resumeId: 'x',
      force: true,
      spawnFn: () => { throw new Error('enoent'); },
    });
    expect(failed).toEqual({});
  });
});
