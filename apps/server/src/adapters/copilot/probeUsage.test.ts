import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCopilotQuota, probeCopilotRateLimits, resetCopilotUsageProbeForTests } from './probeUsage.js';

const PRO = {
  copilot_plan: 'individual',
  access_type_sku: 'copilot_pro',
  quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { unlimited: true, entitlement: 0, remaining: 0 },
    premium_interactions: { unlimited: false, entitlement: 300, remaining: 225 },
  },
};

describe('parseCopilotQuota', () => {
  it('maps premium requests to monthly credits', () => {
    expect(parseCopilotQuota(PRO)).toEqual({
      subscriptionType: 'individual',
      monthlyResetsAt: Date.parse('2026-11-01T00:00:00.000Z'),
      creditsLimit: 300,
      creditsUsed: 75,
      monthlyPct: 25,
    });
  });

  it('falls back to chat quota when premium has no allowance (Free)', () => {
    const r = parseCopilotQuota({
      access_type_sku: 'free_limited_copilot',
      copilot_plan: 'individual',
      quota_snapshots: {
        chat: { entitlement: 200, remaining: 199 },
        premium_interactions: { entitlement: 0, remaining: 0 },
      },
    });
    expect(r).toMatchObject({ subscriptionType: 'free', creditsLimit: 200, creditsUsed: 1, monthlyPct: 0.5 });
  });

  it('flags unlimited and survives garbage', () => {
    expect(parseCopilotQuota({ quota_snapshots: { premium_interactions: { unlimited: true } } }))
      .toEqual({ unlimitedCredits: true });
    expect(parseCopilotQuota(null)).toEqual({});
  });
});

describe('probeCopilotRateLimits', () => {
  beforeEach(() => resetCopilotUsageProbeForTests());

  it('caches success and throws on HTTP error', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(PRO))) as unknown as typeof fetch;
    const getToken = async () => 'tok';
    await probeCopilotRateLimits({ fetchFn, getToken });
    const r = await probeCopilotRateLimits({ fetchFn, getToken });
    expect(r.creditsUsed).toBe(75);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const bad = vi.fn(async () => new Response('', { status: 401 })) as unknown as typeof fetch;
    await expect(probeCopilotRateLimits({ force: true, fetchFn: bad, getToken })).rejects.toThrow(/401/);
  });
});
