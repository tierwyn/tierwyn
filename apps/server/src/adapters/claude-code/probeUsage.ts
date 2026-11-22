import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeExecutableOpt } from './executable.js';

/** Fresh account-level rate-limit state pulled live from the Claude CLI, with
 *  zero model tokens and zero cost. */
export interface ProbedRateLimits {
  fiveHourPct?: number;
  fiveHourResetsAt?: number;
  sevenDayPct?: number;
  sevenDayResetsAt?: number;
  /** Monthly plan window (Kiro credits). Do not reuse sevenDayPct for this. */
  monthlyPct?: number;
  monthlyResetsAt?: number;
  creditsUsed?: number;
  creditsLimit?: number;
  prepaidBalance?: number;
  onDemandUsed?: number;
  onDemandCap?: number;
  extraUsageUsed?: number;
  extraUsageLimit?: number;
  extraUsagePct?: number;
  extraUsageCurrency?: string;
  manualResetsAvailable?: number;
  creditsBalance?: number;
  hasCredits?: boolean;
  unlimitedCredits?: boolean;
  longWindowLabel?: string;
  subscriptionType?: string;
}

import type { ClaudeInsights, ClaudeActivityWindow, ClaudeNamedUsageItem } from '@tierwyn/shared';

// ponytail: 20s cache + single-flight so the panel's open/refresh/turn-complete
// fetches don't each spawn a CLI. Widen the TTL if spawn frequency bites.
const TTL_MS = 20_000;
let cache: { at: number; data: ProbedRateLimits } | undefined;
let inflight: Promise<ProbedRateLimits> | undefined;

let insightsCache: { at: number; data: ClaudeInsights } | undefined;
let insightsInflight: Promise<ClaudeInsights> | undefined;

export function resetClaudeUsageProbeForTests(): void {
  cache = undefined;
  inflight = undefined;
  insightsCache = undefined;
  insightsInflight = undefined;
}

export function parseClaudeInsights(u: unknown): ClaudeInsights {
  const root = u && typeof u === 'object' && !Array.isArray(u) ? (u as Record<string, unknown>) : undefined;
  if (!root) return { updatedAt: Date.now() };

  const out: ClaudeInsights = {
    updatedAt: Date.now(),
  };

  if (typeof root.subscription_type === 'string' && root.subscription_type) {
    out.subscriptionType = root.subscription_type;
  }

  // Parse session stats
  const sess = root.session && typeof root.session === 'object' ? (root.session as Record<string, unknown>) : undefined;
  if (sess) {
    out.sessionStats = {
      totalCostUsd: typeof sess.total_cost_usd === 'number' ? sess.total_cost_usd : undefined,
      totalApiDurationMs: typeof sess.total_api_duration_ms === 'number' ? sess.total_api_duration_ms : undefined,
      totalDurationMs: typeof sess.total_duration_ms === 'number' ? sess.total_duration_ms : undefined,
      totalLinesAdded: typeof sess.total_lines_added === 'number' ? sess.total_lines_added : undefined,
      totalLinesRemoved: typeof sess.total_lines_removed === 'number' ? sess.total_lines_removed : undefined,
    };
  }

  // Parse behaviors (day and week)
  const beh = root.behaviors && typeof root.behaviors === 'object' ? (root.behaviors as Record<string, unknown>) : undefined;
  if (beh) {
    const parseWindow = (win: unknown): ClaudeActivityWindow | undefined => {
      if (!win || typeof win !== 'object') return undefined;
      const w = win as Record<string, unknown>;
      const requestCount = typeof w.request_count === 'number' ? w.request_count : 0;
      const sessionCount = typeof w.session_count === 'number' ? w.session_count : 0;
      const behaviors = Array.isArray(w.behaviors)
        ? (w.behaviors as Record<string, unknown>[]).map((b) => ({
            key: String(b.key ?? ''),
            pct: typeof b.pct === 'number' ? b.pct : 0,
            count: typeof b.count === 'number' ? b.count : 0,
          })).filter((b) => b.key)
        : [];
      const parseNamed = (arr: unknown): ClaudeNamedUsageItem[] =>
        Array.isArray(arr)
          ? (arr as Record<string, unknown>[]).map((item) => ({
              name: String(item.name ?? ''),
              pct: typeof item.pct === 'number' ? item.pct : 0,
            })).filter((item) => item.name)
          : [];

      return {
        requestCount,
        sessionCount,
        behaviors,
        skills: parseNamed(w.skills),
        plugins: parseNamed(w.plugins),
        mcpServers: parseNamed(w.mcp_servers),
      };
    };

    if (beh.day) out.day = parseWindow(beh.day);
    if (beh.week) out.week = parseWindow(beh.week);
  }

  // Parse any extra rate limits list items
  const rl = root.rate_limits && typeof root.rate_limits === 'object' ? (root.rate_limits as Record<string, unknown>) : undefined;
  if (rl && Array.isArray(rl.limits)) {
    out.extraLimits = (rl.limits as Record<string, unknown>[]).map((lim) => {
      const kind = String(lim.kind ?? '');
      const group = String(lim.group ?? '');
      const percent = typeof lim.percent === 'number' ? lim.percent : 0;
      const severity = String(lim.severity ?? 'normal');
      const resetsAtStr = typeof lim.resets_at === 'string' ? lim.resets_at : undefined;
      const resetsAt = resetsAtStr ? Date.parse(resetsAtStr) : undefined;
      return { kind, group, percent, severity, resetsAt: Number.isFinite(resetsAt) ? resetsAt : undefined };
    });
  }

  return out;
}

export function parseClaudeUsagePayload(u: unknown): ProbedRateLimits {
  const root = u && typeof u === 'object' && !Array.isArray(u) ? (u as Record<string, unknown>) : undefined;
  if (!root) return {};
  const out: ProbedRateLimits = {};
  if (typeof root.subscription_type === 'string' && root.subscription_type) {
    out.subscriptionType = root.subscription_type;
  }
  const rl = root.rate_limits && typeof root.rate_limits === 'object' && !Array.isArray(root.rate_limits)
    ? (root.rate_limits as Record<string, unknown>)
    : undefined;
  if (root.rate_limits_available && rl) {
    const fh = rl.five_hour as { utilization?: number; resets_at?: string } | undefined;
    const sd = rl.seven_day as { utilization?: number; resets_at?: string } | undefined;
    if (fh?.utilization != null && Number.isFinite(fh.utilization)) out.fiveHourPct = fh.utilization;
    if (fh?.resets_at) {
      const ms = Date.parse(fh.resets_at);
      if (Number.isFinite(ms)) out.fiveHourResetsAt = ms;
    }
    if (sd?.utilization != null && Number.isFinite(sd.utilization)) out.sevenDayPct = sd.utilization;
    if (sd?.resets_at) {
      const ms = Date.parse(sd.resets_at);
      if (Number.isFinite(ms)) out.sevenDayResetsAt = ms;
    }

    const eu = rl.extra_usage as {
      is_enabled?: boolean;
      monthly_limit?: number;
      used_credits?: number;
      utilization?: number;
      currency?: string;
      decimal_places?: number;
    } | undefined;
    const spend = rl.spend as {
      enabled?: boolean;
      used?: { amount_minor?: number; currency?: string; exponent?: number };
      limit?: { amount_minor?: number; currency?: string; exponent?: number };
      percent?: number;
    } | undefined;

    if (eu?.is_enabled || spend?.enabled) {
      const decimals = eu?.decimal_places ?? spend?.used?.exponent ?? 2;
      const scale = Math.pow(10, decimals);
      const used = (eu?.used_credits != null)
        ? eu.used_credits / scale
        : (spend?.used?.amount_minor != null)
          ? spend.used.amount_minor / scale
          : undefined;
      const limit = (eu?.monthly_limit != null)
        ? eu.monthly_limit / scale
        : (spend?.limit?.amount_minor != null)
          ? spend.limit.amount_minor / scale
          : undefined;
      if (used != null && Number.isFinite(used)) out.extraUsageUsed = used;
      if (limit != null && Number.isFinite(limit)) out.extraUsageLimit = limit;
      if (eu?.utilization != null && Number.isFinite(eu.utilization)) {
        out.extraUsagePct = Math.min(100, Math.max(0, eu.utilization));
      } else if (spend?.percent != null && Number.isFinite(spend.percent)) {
        out.extraUsagePct = Math.min(100, Math.max(0, spend.percent));
      } else if (used != null && limit != null && limit > 0) {
        out.extraUsagePct = Math.min(100, Math.max(0, (used / limit) * 100));
      }
      const currency = eu?.currency ?? spend?.used?.currency;
      if (currency) out.extraUsageCurrency = currency;
    }
  }
  return out;
}

/** Spin up a throwaway SDK query and read the `/usage` control request — the
 *  same data the TUI statusline shows, but on demand and always fresh. The
 *  prompt stream never yields a real turn, so no model tokens are spent; we
 *  abort as soon as the usage snapshot is back (~700ms).
 *
 *  This is the freshest source for an IDLE conversation. During an active turn
 *  the adapter's in-band `_refreshRateLimitsFromSdk()` already covers it, so
 *  callers should only probe when no session is running for the conversation. */
export async function probeClaudeRateLimits(opts?: { cwd?: string; force?: boolean }): Promise<ProbedRateLimits> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight; // coalesce concurrent callers even on force
  inflight = doProbe(opts).finally(() => { inflight = undefined; });
  return inflight;
}

async function doProbe(opts?: { cwd?: string }): Promise<ProbedRateLimits> {
  const ac = new AbortController();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  async function* neverPrompt() { await gate; } // hold input open; never send a turn
  const q = query({
    prompt: neverPrompt() as never,
    options: { cwd: opts?.cwd || undefined, abortController: ac, ...claudeExecutableOpt() },
  });
  // Drain messages so the transport pumps the initialize handshake.
  void (async () => { try { for await (const _ of q) { void _; } } catch { /* aborted */ } })();
  try {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('usage probe timeout')), 8000));
    const u = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(), timeout]);
    const out = parseClaudeUsagePayload(u);
    cache = { at: Date.now(), data: out };
    return out;
  } finally {
    release();
    ac.abort();
  }
}

/** Probe extended Claude Code activity, behavior metrics and insights on-demand. */
export async function probeClaudeInsights(opts?: { cwd?: string; force?: boolean }): Promise<ClaudeInsights> {
  if (!opts?.force && insightsCache && Date.now() - insightsCache.at < TTL_MS) return insightsCache.data;
  if (insightsInflight) return insightsInflight;
  insightsInflight = doProbeInsights(opts).finally(() => { insightsInflight = undefined; });
  return insightsInflight;
}

async function doProbeInsights(opts?: { cwd?: string }): Promise<ClaudeInsights> {
  const ac = new AbortController();
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  async function* neverPrompt() { await gate; }
  const q = query({
    prompt: neverPrompt() as never,
    options: { cwd: opts?.cwd || undefined, abortController: ac, ...claudeExecutableOpt() },
  });
  void (async () => { try { for await (const _ of q) { void _; } } catch { /* aborted */ } })();
  try {
    const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error('insights probe timeout')), 8000));
    const u = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(), timeout]);
    const out = parseClaudeInsights(u);
    insightsCache = { at: Date.now(), data: out };
    return out;
  } finally {
    release();
    ac.abort();
  }
}
