/**
 * Token-usage math shared across adapters and the usage route.
 * Pure functions only — no I/O — so they're trivially unit-testable.
 */

import type { ConversationUsage } from './domain.js';

/** Tokens occupying the context window for a SINGLE request =
 *  uncached input + cache-read + cache-creation. Output tokens are excluded:
 *  they are produced by the model, not loaded into the next request's window. */
export function contextWindowOccupancy(u: {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}): number {
  return (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheCreationTokens ?? 0);
}

/** Context-window fill percentage (0-100, rounded, clamped) for the most recent
 *  request. Returns undefined when the window size is unknown/non-positive or the
 *  occupancy is not a finite non-negative number, so callers never show a
 *  fabricated value. */
export function computeContextWindowPct(
  occupancy: number,
  contextWindowSize: number | undefined,
): number | undefined {
  if (!contextWindowSize || contextWindowSize <= 0) return undefined;
  if (!Number.isFinite(occupancy) || occupancy < 0) return undefined;
  return Math.min(100, Math.round((occupancy / contextWindowSize) * 100));
}

/** Look up a model's context-window size from a list of descriptors
 *  (e.g. an adapter's listModels() output). Undefined when unknown. */
export function windowSizeForModel(
  models: { name: string; contextWindow?: number }[],
  modelName: string,
): number | undefined {
  return models.find((m) => m.name === modelName)?.contextWindow;
}

/** Fallback context-window sizes for models absent from agent-profiles.json —
 *  e.g. user-created catalogue rows or newly released CLI model ids. */
export function defaultContextWindowForModel(modelName: string): number | undefined {
  const m = modelName.toLowerCase();
  // 1M-class Anthropic frontier models (opus, fable, …).
  if (/(^|[-/])((claude-)?opus|(claude-)?fable)/.test(m)) return 1_000_000;
  // 200k-class Anthropic workhorse models.
  if (/(^|[-/])((claude-)?sonnet|(claude-)?haiku)/.test(m)) return 200_000;
  // Z.AI GLM 5.2 / 5.3 family — 1M window.
  if (/(^|[-/])glm-5\.(2|3)/.test(m)) return 1_000_000;
  return undefined;
}

/** Resolve a model's context-window size: listModels hit, then naming fallback. */
export function resolveContextWindowSize(
  models: { name: string; contextWindow?: number }[],
  modelName: string,
): number | undefined {
  return windowSizeForModel(models, modelName) ?? defaultContextWindowForModel(modelName);
}

/** Account-quota fields that a mid-turn token poll may omit (Cursor plugin
 *  overlay is not persisted on the session row). Keep the last known value
 *  so the Usage panel does not unmount the reset/allowance rows. */
const STICKY_ALLOWANCE_KEYS = [
  'fiveHourPct',
  'fiveHourResetsAt',
  'sevenDayPct',
  'sevenDayResetsAt',
  'monthlyPct',
  'monthlyResetsAt',
  'creditsUsed',
  'creditsLimit',
  'prepaidBalance',
  'onDemandUsed',
  'onDemandCap',
  'extraUsageUsed',
  'extraUsageLimit',
  'extraUsagePct',
  'extraUsageCurrency',
  'manualResetsAvailable',
  'creditsBalance',
  'hasCredits',
  'unlimitedCredits',
  'longWindowLabel',
  'monthlyWindowLabel',
  'subscriptionType',
  'providerSubscriptionType',
  'usageSource',
  'usageProvider',
  'rateLimitsUpdatedAt',
] as const satisfies ReadonlyArray<keyof ConversationUsage>;

/** Merge a freshly fetched usage payload with the last one shown. Token and
 *  cost counts always come from `next`; allowance/reset timestamps are kept
 *  from `prev` when the new payload omitted them (plugin miss, cache race). */
export function coalesceConversationUsage(
  prev: ConversationUsage | null | undefined,
  next: ConversationUsage,
): ConversationUsage {
  if (!prev) return next;
  if (prev.agentType && next.agentType && prev.agentType !== next.agentType) return next;

  const out: ConversationUsage = { ...next };
  for (const key of STICKY_ALLOWANCE_KEYS) {
    if (out[key] === undefined && prev[key] !== undefined) {
      // Do not copy an agent subscriptionType if it was merely the old provider plan
      if (
        key === 'subscriptionType' &&
        (
          (out.providerSubscriptionType && String(prev.subscriptionType).toLowerCase() === out.providerSubscriptionType.toLowerCase()) ||
          (prev.usageProvider && prev.subscriptionType === prev.providerSubscriptionType)
        )
      ) {
        continue;
      }
      (out as unknown as Record<string, unknown>)[key] = prev[key];
    }
  }
  // Sanity check: if an agent subscription accidentally matches the provider subscription, drop the agent one
  if (
    out.subscriptionType &&
    out.providerSubscriptionType &&
    out.subscriptionType.toLowerCase() === out.providerSubscriptionType.toLowerCase()
  ) {
    delete out.subscriptionType;
  }
  if (out.supportsRateLimits !== true && prev.supportsRateLimits === true) {
    out.supportsRateLimits = true;
  }
  return out;
}
