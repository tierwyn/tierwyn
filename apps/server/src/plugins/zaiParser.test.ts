import { describe, it, expect } from 'vitest';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const pluginPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../plugin-src/zai-usage/index.js');
const plugin = await import(pluginPath) as { parseZaiQuotaJson: (raw: unknown) => {
  fiveHourPct?: number;
  fiveHourResetsAt?: number;
  sevenDayPct?: number;
  sevenDayResetsAt?: number;
  subscriptionType?: string;
} };

const LITE_QUOTA = {
  code: 200,
  msg: 'Operation successful',
  data: {
    limits: [
      {
        type: 'TIME_LIMIT',
        unit: 5,
        number: 1,
        usage: 100,
        currentValue: 0,
        remaining: 100,
        percentage: 0,
        nextResetTime: 1787744388998,
      },
      {
        type: 'TOKENS_LIMIT',
        unit: 3,
        number: 5,
        percentage: 13,
        nextResetTime: 1787354538732,
      },
    ],
    level: 'lite',
  },
  success: true,
};

const PRO_QUOTA = {
  code: 200,
  data: {
    limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 42, nextResetTime: 1787354538732 },
      { type: 'TOKENS_LIMIT', unit: 6, percentage: 63, nextResetTime: 1787900000000 },
    ],
    level: 'pro',
  },
  success: true,
};

describe('parseZaiQuotaJson (zai-usage plugin)', () => {
  it('matches on the live lite fixture', () => {
    expect(plugin.parseZaiQuotaJson(LITE_QUOTA)).toEqual({
      fiveHourPct: 13,
      fiveHourResetsAt: 1787354538732,
      subscriptionType: 'lite',
    });
  });

  it('matches on the pro fixture', () => {
    expect(plugin.parseZaiQuotaJson(PRO_QUOTA)).toEqual({
      fiveHourPct: 42,
      fiveHourResetsAt: 1787354538732,
      sevenDayPct: 63,
      sevenDayResetsAt: 1787900000000,
      subscriptionType: 'pro',
    });
  });

  it('matches clamp / skip-zero-reset behaviour', () => {
    const raw = {
      code: 200,
      data: {
        limits: [
          { unit: 3, percentage: 140, nextResetTime: 0 },
          { unit: 6, percentage: -5, nextResetTime: -1 },
        ],
        level: 'max',
      },
    };
    expect(plugin.parseZaiQuotaJson(raw)).toEqual({
      fiveHourPct: 100,
      sevenDayPct: 0,
      subscriptionType: 'max',
    });
  });

  it('matches throws', () => {
    expect(() => plugin.parseZaiQuotaJson({ code: 1001, msg: 'token invalid', success: false })).toThrow('z.ai quota: token invalid (code 1001)');
    expect(() => plugin.parseZaiQuotaJson(null)).toThrow('z.ai quota: empty response');
    expect(() => plugin.parseZaiQuotaJson({ code: 200 })).toThrow('z.ai quota: missing data');
    expect(() => plugin.parseZaiQuotaJson({ code: 200, data: null })).toThrow('z.ai quota: missing data');
  });
});
