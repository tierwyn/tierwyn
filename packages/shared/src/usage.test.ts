import { describe, it, expect } from 'vitest';
import type { ConversationUsage } from './domain.js';
import { coalesceConversationUsage } from './usage.js';

function usage(partial: Partial<ConversationUsage> = {}): ConversationUsage {
  return {
    inputTokens: 10,
    totalInputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    uncachedInputTokens: 10,
    cachedRatio: 0,
    costUsd: 0,
    isCached: false,
    sessionCount: 1,
    agentType: 'cursor',
    supportsRateLimits: true,
    ...partial,
  };
}

describe('coalesceConversationUsage', () => {
  it('keeps the previous monthly reset when a live poll omits it', () => {
    const prev = usage({
      monthlyPct: 10.9,
      monthlyResetsAt: Date.parse('2026-09-18T00:00:00Z'),
      monthlyWindowLabel: 'Cursor Grok and Composer used',
      subscriptionType: 'Pro',
    });
    const next = usage({
      outputTokens: 123_300,
      tokensEstimated: true,
      monthlyPct: 10.9,
      monthlyWindowLabel: 'Cursor Grok and Composer used',
      supportsRateLimits: true,
    });

    const merged = coalesceConversationUsage(prev, next);

    expect(merged.outputTokens).toBe(123_300);
    expect(merged.monthlyPct).toBe(10.9);
    expect(merged.monthlyResetsAt).toBe(prev.monthlyResetsAt);
    expect(merged.subscriptionType).toBe('Pro');
  });

  it('keeps the whole allowance overlay when a poll has no quota at all', () => {
    const prev = usage({
      monthlyPct: 10.9,
      monthlyResetsAt: Date.parse('2026-09-18T00:00:00Z'),
      monthlyWindowLabel: 'Cursor Grok and Composer used',
      rateLimitsUpdatedAt: 1_000,
      supportsRateLimits: true,
    });
    const next = usage({
      outputTokens: 50_000,
      tokensEstimated: true,
      supportsRateLimits: false,
    });

    const merged = coalesceConversationUsage(prev, next);

    expect(merged.outputTokens).toBe(50_000);
    expect(merged.monthlyPct).toBe(10.9);
    expect(merged.monthlyResetsAt).toBe(prev.monthlyResetsAt);
    expect(merged.monthlyWindowLabel).toBe('Cursor Grok and Composer used');
    expect(merged.supportsRateLimits).toBe(true);
    expect(merged.rateLimitsUpdatedAt).toBe(1_000);
  });

  it('takes a newly reported reset date instead of the sticky one', () => {
    const prev = usage({ monthlyResetsAt: 1 });
    const next = usage({ monthlyResetsAt: 2, monthlyPct: 11 });
    expect(coalesceConversationUsage(prev, next).monthlyResetsAt).toBe(2);
  });

  it('drops sticky allowance when the conversation switches agent', () => {
    const prev = usage({
      agentType: 'cursor',
      monthlyResetsAt: 1,
      monthlyPct: 10,
    });
    const next = usage({
      agentType: 'claude-code',
      fiveHourPct: 4,
      supportsRateLimits: true,
    });
    const merged = coalesceConversationUsage(prev, next);
    expect(merged.monthlyResetsAt).toBeUndefined();
    expect(merged.fiveHourPct).toBe(4);
  });

  it('returns next when there is nothing to coalesce', () => {
    const next = usage({ outputTokens: 9 });
    expect(coalesceConversationUsage(null, next)).toBe(next);
  });

  it('preserves providerSubscriptionType and separates it from agent subscriptionType', () => {
    const prev = usage({
      agentType: 'hermes',
      usageSource: 'Hermes',
      usageProvider: 'Z.AI',
      providerSubscriptionType: 'lite',
    });
    const next = usage({
      agentType: 'hermes',
      outputTokens: 500,
      tokensEstimated: true,
    });

    const merged = coalesceConversationUsage(prev, next);
    expect(merged.usageProvider).toBe('Z.AI');
    expect(merged.providerSubscriptionType).toBe('lite');
    expect(merged.subscriptionType).toBeUndefined();
  });

  it('does not copy sticky subscriptionType if it was merely the provider plan', () => {
    const prev = usage({
      agentType: 'hermes',
      usageProvider: 'Z.AI',
      subscriptionType: 'lite',
      providerSubscriptionType: 'lite',
    });
    const next = usage({
      agentType: 'hermes',
      outputTokens: 500,
      providerSubscriptionType: 'lite',
    });

    const merged = coalesceConversationUsage(prev, next);
    expect(merged.providerSubscriptionType).toBe('lite');
    expect(merged.subscriptionType).toBeUndefined();
  });

  it('keeps distinct agent subscription and provider subscription simultaneously', () => {
    const prev = usage({
      agentType: 'claude-code',
      subscriptionType: 'pro',
      usageProvider: 'Custom Gateway',
      providerSubscriptionType: 'tier-2',
    });
    const next = usage({
      agentType: 'claude-code',
      outputTokens: 1000,
    });

    const merged = coalesceConversationUsage(prev, next);
    expect(merged.subscriptionType).toBe('pro');
    expect(merged.providerSubscriptionType).toBe('tier-2');
  });
});
