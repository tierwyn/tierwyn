import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import {
  parseAgyUsageJson,
  parseAgyUsageGroups,
  parseAgyInsights,
  probeAgyRateLimits,
  probeAntigravityInsights,
  resetAgyUsageProbeForTests,
  AGY_USAGE_PROBE_ARGS,
} from './probeUsage.js';

const FIXTURE = {
  conversation_id: '',
  status: 'SUCCESS',
  num_turns: 0,
  usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  command: {
    name: 'usage',
    data: {
      groups: [
        {
          name: 'Gemini Models',
          buckets: [
            { window: 'weekly', remaining_fraction: 0.935, reset_time: '2026-01-05T00:00:00Z' },
            { window: '5h', remaining_fraction: 0.786, reset_time: '2026-01-01T01:00:00Z' },
          ],
        },
        {
          // Live agy 1.1.11 name, verified 2026-08-19 — note the lowercase "models".
          name: 'Claude and GPT models',
          buckets: [
            { window: 'weekly', remaining_fraction: 0.5, reset_time: '2026-01-06T00:00:00Z' },
            { window: '5h', remaining_fraction: 0.25, reset_time: '2026-01-01T02:00:00Z' },
          ],
        },
      ],
    },
  },
};

describe('parseAgyUsageJson', () => {
  it('inverts remaining_fraction into used percent for the Gemini group', () => {
    const out = parseAgyUsageJson(FIXTURE, 'gemini-3.6-flash-medium');
    expect(out.fiveHourPct).toBeCloseTo((1 - 0.786) * 100);
    expect(out.sevenDayPct).toBeCloseTo((1 - 0.935) * 100);
    expect(out.fiveHourResetsAt).toBe(Date.parse('2026-01-01T01:00:00Z'));
    expect(out.sevenDayResetsAt).toBe(Date.parse('2026-01-05T00:00:00Z'));
  });

  it('picks the Claude/GPT group for claude and gpt slugs', () => {
    const claude = parseAgyUsageJson(FIXTURE, 'claude-sonnet-4-6');
    expect(claude.fiveHourPct).toBeCloseTo((1 - 0.25) * 100);
    expect(claude.sevenDayPct).toBeCloseTo((1 - 0.5) * 100);
    expect(claude.fiveHourResetsAt).toBe(Date.parse('2026-01-01T02:00:00Z'));

    const gpt = parseAgyUsageJson(FIXTURE, 'gpt-oss-120b-medium');
    expect(gpt.fiveHourPct).toBe(claude.fiveHourPct);
  });

  it('falls back to the Gemini group, else the first group, for unknown slugs', () => {
    const unknown = parseAgyUsageJson(FIXTURE, 'mystery-model');
    expect(unknown.fiveHourPct).toBeCloseTo((1 - 0.786) * 100);

    const noGemini = {
      command: {
        data: {
          groups: [
            {
              name: 'Claude and GPT',
              buckets: [
                { window: '5h', remaining_fraction: 0.1, reset_time: '2026-01-01T03:00:00Z' },
              ],
            },
          ],
        },
      },
    };
    const fallback = parseAgyUsageJson(noGemini, 'mystery-model');
    expect(fallback.fiveHourPct).toBeCloseTo(90);
  });

  it('routes legacy display-label model ids (pre-slug agy) to the right group', () => {
    // Catalogue rows seeded before agy emitted "<slug>\t<label>" hold the label.
    const claude = parseAgyUsageJson(FIXTURE, 'Claude Sonnet 4.6 (Thinking)');
    expect(claude.fiveHourPct).toBeCloseTo((1 - 0.25) * 100);
    const gemini = parseAgyUsageJson(FIXTURE, 'Gemini 3.6 Flash (Medium)');
    expect(gemini.fiveHourPct).toBeCloseTo((1 - 0.786) * 100);
  });

  it('clamps used percent to 0–100', () => {
    const raw = {
      command: {
        data: {
          groups: [{
            name: 'Gemini Models',
            buckets: [
              { window: '5h', remaining_fraction: -0.2, reset_time: '2026-01-01T01:00:00Z' },
              { window: 'weekly', remaining_fraction: 1.5, reset_time: '2026-01-05T00:00:00Z' },
            ],
          }],
        },
      },
    };
    const out = parseAgyUsageJson(raw, 'gemini-flash');
    expect(out.fiveHourPct).toBe(100);
    expect(out.sevenDayPct).toBe(0);
  });

  it('skips malformed reset_time and missing buckets', () => {
    const raw = {
      command: {
        data: {
          groups: [{
            name: 'Gemini Models',
            buckets: [
              { window: '5h', remaining_fraction: 0.5, reset_time: 'not-a-date' },
              { window: 'weekly', remaining_fraction: 0.4 },
            ],
          }],
        },
      },
    };
    const out = parseAgyUsageJson(raw, 'gemini-flash');
    expect(out.fiveHourPct).toBe(50);
    expect(out.fiveHourResetsAt).toBeUndefined();
    expect(out.sevenDayPct).toBeCloseTo(60);
    expect(out.sevenDayResetsAt).toBeUndefined();
  });

  it('returns {} for empty or missing groups without throwing', () => {
    expect(parseAgyUsageJson(null, 'gemini-flash')).toEqual({});
    expect(parseAgyUsageJson({}, 'gemini-flash')).toEqual({});
    expect(parseAgyUsageJson({ command: { data: { groups: [] } } }, 'gemini-flash')).toEqual({});
    expect(parseAgyUsageJson('not json', 'gemini-flash')).toEqual({});
  });
});

describe('parseAgyUsageGroups', () => {
  it('returns both quota groups in payload order with 5h + weekly numbers', () => {
    const groups = parseAgyUsageGroups(FIXTURE);
    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('Gemini Models');
    expect(groups[0].id).toBe('gemini-models');
    expect(groups[0].limits.fiveHourPct).toBeCloseTo((1 - 0.786) * 100);
    expect(groups[0].limits.sevenDayPct).toBeCloseTo((1 - 0.935) * 100);
    expect(groups[0].limits.fiveHourResetsAt).toBe(Date.parse('2026-01-01T01:00:00Z'));
    expect(groups[0].limits.sevenDayResetsAt).toBe(Date.parse('2026-01-05T00:00:00Z'));

    expect(groups[1].label).toBe('Claude and GPT models');
    expect(groups[1].id).toBe('claude-and-gpt-models');
    expect(groups[1].limits.fiveHourPct).toBeCloseTo((1 - 0.25) * 100);
    expect(groups[1].limits.sevenDayPct).toBeCloseTo((1 - 0.5) * 100);
    expect(groups[1].limits.fiveHourResetsAt).toBe(Date.parse('2026-01-01T02:00:00Z'));
    expect(groups[1].limits.sevenDayResetsAt).toBe(Date.parse('2026-01-06T00:00:00Z'));
  });

  it('keeps the Claude/GPT group when the live name omits "models"', () => {
    const raw = {
      command: {
        data: {
          groups: [
            FIXTURE.command.data.groups[0],
            { ...FIXTURE.command.data.groups[1], name: 'Claude and GPT' },
          ],
        },
      },
    };
    const groups = parseAgyUsageGroups(raw);
    expect(groups).toHaveLength(2);
    expect(groups[1].label).toBe('Claude and GPT');
    expect(groups[1].id).toBe('claude-and-gpt');
    expect(groups[1].limits.fiveHourPct).toBeCloseTo((1 - 0.25) * 100);
  });

  it('returns [] for garbage or empty payloads without throwing', () => {
    expect(parseAgyUsageGroups(null)).toEqual([]);
    expect(parseAgyUsageGroups({})).toEqual([]);
    expect(parseAgyUsageGroups({ command: { data: { groups: [] } } })).toEqual([]);
    expect(parseAgyUsageGroups('not json')).toEqual([]);
  });
});

function fakeProbeChild(stdout = '') {
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
    if (stdout) out.write(stdout);
    out.end();
    proc.emit('close', 0);
  });
  return proc;
}

describe('probeAgyRateLimits', () => {
  afterEach(() => {
    resetAgyUsageProbeForTests();
  });

  it('spawns agy --print /usage --output-format json and never skip-permissions', async () => {
    let captured: { cmd: string; args: string[]; stdinEnded: boolean } | undefined;
    const child = fakeProbeChild(JSON.stringify(FIXTURE));
    const ended = new Promise<void>((resolve) => {
      child.stdin.on('finish', () => resolve());
    });

    const out = await probeAgyRateLimits({
      model: 'gemini-flash',
      force: true,
      spawnFn: (cmd, args) => {
        captured = { cmd, args, stdinEnded: false };
        return child as never;
      },
    });

    await ended;
    expect(captured?.cmd).toBe('agy');
    expect(captured?.args).toEqual(AGY_USAGE_PROBE_ARGS);
    expect(captured?.args).toEqual(['--print', '/usage', '--output-format', 'json']);
    expect(captured?.args).not.toContain('--dangerously-skip-permissions');
    expect(out.fiveHourPct).toBeCloseTo((1 - 0.786) * 100);
  });

  it('returns {} on spawn failure and caches a successful result for 20s', async () => {
    let spawns = 0;
    const ok = await probeAgyRateLimits({
      model: 'gemini-flash',
      spawnFn: () => {
        spawns += 1;
        return fakeProbeChild(JSON.stringify(FIXTURE)) as never;
      },
    });
    expect(ok.fiveHourPct).toBeCloseTo((1 - 0.786) * 100);

    const cached = await probeAgyRateLimits({
      model: 'gemini-flash',
      spawnFn: () => {
        spawns += 1;
        throw new Error('should not spawn');
      },
    });
    expect(cached.fiveHourPct).toBe(ok.fiveHourPct);
    expect(spawns).toBe(1);

    const failed = await probeAgyRateLimits({
      force: true,
      model: 'gemini-flash',
      spawnFn: () => {
        const proc = fakeProbeChild('not-json');
        queueMicrotask(() => proc.emit('error', new Error('enoent')));
        return proc as never;
      },
    });
    expect(failed).toEqual({});
  });

  it('does not serve one model group from another model cached within the TTL', async () => {
    let spawns = 0;
    const spawnFn = () => {
      spawns += 1;
      return fakeProbeChild(JSON.stringify(FIXTURE)) as never;
    };
    const gemini = await probeAgyRateLimits({ model: 'gemini-3.6-flash-medium', spawnFn });
    const claude = await probeAgyRateLimits({ model: 'claude-sonnet-4-6', spawnFn });

    expect(spawns).toBe(1); // still one spawn — cache is shared
    expect(gemini.fiveHourPct).toBeCloseTo((1 - 0.786) * 100);
    expect(claude.fiveHourPct).toBeCloseTo((1 - 0.25) * 100); // …but not the Gemini bars
  });
});

describe('parseAgyInsights', () => {
  const USAGE_RAW = {
    command: {
      name: 'usage',
      data: {
        description: 'Quota is consumed proportionally to the cost of tokens.',
        groups: [
          {
            name: 'Gemini Models',
            description: 'Models within this group: Gemini Flash, Gemini Pro',
            buckets: [
              {
                id: 'gemini-weekly',
                name: 'Weekly Limit Remaining',
                description: 'will refresh in 6 days',
                window: 'weekly',
                remaining_fraction: 0.9,
                reset_time: '2026-01-12T00:00:00Z',
              },
              {
                id: 'gemini-5h',
                name: 'Five Hour Limit Remaining',
                description: 'will refresh in 3 hours',
                window: '5h',
                remaining_fraction: 0.7,
                reset_time: '2026-01-06T06:00:00Z',
              },
            ],
          },
        ],
      },
    },
  };

  const CREDITS_RAW = {
    command: {
      name: 'credits',
      data: {
        remaining_credits: 5,
        upgrade_uri: 'https://antigravity.google/g1-upgrade',
      },
    },
  };

  const SKILLS_RAW = {
    command: {
      name: 'skills',
      data: {
        commands: [
          {
            name: 'science:pymol',
            description: 'Render protein structures',
            path: '/path/to/skill',
            plugin: 'science',
            builtin: false,
            model_invocable: true,
          },
        ],
      },
    },
  };

  const PERMISSIONS_RAW = {
    command: {
      name: 'permissions',
      data: {
        permissions: [
          { scope: 'global', allow: ['command(find)', 'command(grep)'] },
        ],
      },
    },
  };

  it('correctly maps policy description, groups, credits, skills, and permissions', () => {
    const insights = parseAgyInsights(USAGE_RAW, CREDITS_RAW, SKILLS_RAW, PERMISSIONS_RAW);
    expect(insights.policyDescription).toBe('Quota is consumed proportionally to the cost of tokens.');
    expect(insights.remainingCredits).toBe(5);
    expect(insights.upgradeUri).toBe('https://antigravity.google/g1-upgrade');
    expect(insights.groups).toHaveLength(1);
    expect(insights.groups[0].name).toBe('Gemini Models');
    expect(insights.groups[0].description).toBe('Models within this group: Gemini Flash, Gemini Pro');
    expect(insights.groups[0].buckets).toHaveLength(2);
    expect(insights.groups[0].buckets[0].id).toBe('gemini-weekly');
    expect(insights.groups[0].buckets[0].usedPct).toBeCloseTo(10);
    expect(insights.groups[0].buckets[0].description).toBe('will refresh in 6 days');

    expect(insights.skills).toHaveLength(1);
    expect(insights.skills[0].name).toBe('science:pymol');
    expect(insights.skills[0].plugin).toBe('science');

    expect(insights.permissions).toHaveLength(1);
    expect(insights.permissions[0].scope).toBe('global');
    expect(insights.permissions[0].allow).toEqual(['command(find)', 'command(grep)']);
    expect(insights.updatedAt).toBeGreaterThan(0);
  });

  it('keeps https upgrade_uri and drops javascript: and other schemes', () => {
    const js = parseAgyInsights(USAGE_RAW, {
      command: { name: 'credits', data: { remaining_credits: 1, upgrade_uri: 'javascript:alert(1)' } },
    }, SKILLS_RAW, PERMISSIONS_RAW);
    expect(js.upgradeUri).toBeUndefined();
    const http = parseAgyInsights(USAGE_RAW, {
      command: { name: 'credits', data: { remaining_credits: 1, upgrade_uri: 'http://evil.example/x' } },
    }, SKILLS_RAW, PERMISSIONS_RAW);
    expect(http.upgradeUri).toBeUndefined();
    const https = parseAgyInsights(USAGE_RAW, {
      command: { name: 'credits', data: { remaining_credits: 1, upgrade_uri: 'https://one.google.com/upgrade' } },
    }, SKILLS_RAW, PERMISSIONS_RAW);
    expect(https.upgradeUri).toBe('https://one.google.com/upgrade');
  });
});
