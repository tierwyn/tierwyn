import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import type { ProbedRateLimits } from '../claude-code/probeUsage.js';
import { CodexRpc } from './protocol.js';

import type { CodexInsights } from '@tierwyn/shared';

export type { ProbedRateLimits };

/** Throwaway app-server probe: initialize + account/rateLimits/read — no
 *  thread, no turn, zero tokens. */
export const CODEX_USAGE_PROBE_ARGS = ['app-server'] as const;

const TTL_MS = 20_000;
const TIMEOUT_MS = 12_000;

let cache: { at: number; data: ProbedRateLimits } | undefined;
let inflight: Promise<ProbedRateLimits> | undefined;

let codexInsightsCache: { at: number; data: CodexInsights } | undefined;
let codexInsightsInflight: Promise<CodexInsights> | undefined;

export type CodexUsageSpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

export function resetCodexUsageProbeForTests(): void {
  cache = undefined;
  inflight = undefined;
  codexInsightsCache = undefined;
  codexInsightsInflight = undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

/** Finite number, accepting numeric strings (defensive against schema drift). */
function numVal(raw: unknown): number | undefined {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** codex resetsAt is unix SECONDS → ms; skip zero/negative/garbage values. */
function resetsAtMs(raw: unknown): number | undefined {
  const n = numVal(raw);
  return n !== undefined && n > 0 ? n * 1000 : undefined;
}

/**
 * The rateLimits object arrives in two shapes:
 *  - read result:     { rateLimits: { primary, secondary, planType, ... }, rateLimitsByLimitId, ... }
 *  - notification:    the rateLimits object DIRECTLY as params
 * Detect the direct shape (primary/secondary/planType at top level), else
 * unwrap .rateLimits. Never read rateLimitsByLimitId — it duplicates the same
 * windows keyed by limitId.
 */
function extractRateLimits(raw: unknown): Record<string, unknown> | undefined {
  const root = asRecord(raw);
  if (!root) return undefined;
  if (root.primary !== undefined || root.secondary !== undefined || root.planType !== undefined) {
    return root;
  }
  return asRecord(root.rateLimits);
}

/** Map one window (primary or secondary) by duration: codex paid = 5h primary
 *  (300 min) + weekly secondary; free = a single 30-day primary with a null
 *  secondary. <=300 min counts as the five-hour bucket, everything else as the
 *  seven-day bucket (30-day and weekly both render as "long window" usage). */
function mapWindow(raw: unknown, out: ProbedRateLimits): void {
  const win = asRecord(raw);
  if (!win) return;
  const dur = numVal(win.windowDurationMins) ?? Infinity;
  const fiveHour = dur <= 300;
  const pct = numVal(win.usedPercent);
  const resets = resetsAtMs(win.resetsAt);
  if (pct !== undefined) {
    if (fiveHour) out.fiveHourPct = clampPct(pct);
    else out.sevenDayPct = clampPct(pct);
  }
  if (resets !== undefined) {
    if (fiveHour) out.fiveHourResetsAt = resets;
    else out.sevenDayResetsAt = resets;
  }
}

/** Map an `account/rateLimits/read` result onto Claude-style used-percent rate
 *  limits. Defensive: {} for malformed/null payloads, never throws. */
export function parseCodexRateLimitsJson(raw: unknown): ProbedRateLimits {
  const limits = extractRateLimits(raw);
  const root = asRecord(raw);
  if (!limits && !root) return {};
  const out: ProbedRateLimits = {};
  if (limits) {
    mapWindow(limits.primary, out);
    mapWindow(limits.secondary, out);
    if (typeof limits.planType === 'string' && limits.planType.trim()) {
      out.subscriptionType = limits.planType;
    }
    const credits = asRecord(limits.credits);
    if (credits) {
      if (typeof credits.hasCredits === 'boolean') out.hasCredits = credits.hasCredits;
      if (typeof credits.unlimited === 'boolean') out.unlimitedCredits = credits.unlimited;
      const bal = numVal(credits.balance);
      if (bal !== undefined) out.creditsBalance = bal;
    }
    const prim = asRecord(limits.primary);
    const dur = numVal(prim?.windowDurationMins);
    if (dur !== undefined) {
      if (dur >= 28800) out.longWindowLabel = '30d window used';
      else if (dur > 300) out.longWindowLabel = 'weekly window used';
    }
  }
  const resetCredits = asRecord(root?.rateLimitResetCredits ?? limits?.rateLimitResetCredits);
  const resetCount = numVal(resetCredits?.availableCount);
  if (resetCount !== undefined) {
    out.manualResetsAvailable = resetCount;
  }
  return out;
}

export function parseCodexInsights(rawLimits: unknown, rawUsage: unknown): CodexInsights {
  const limits = extractRateLimits(rawLimits);
  const rootLimits = asRecord(rawLimits);
  const usageRoot = asRecord(rawUsage);

  const out: CodexInsights = {
    updatedAt: Date.now(),
  };

  if (typeof limits?.planType === 'string' && limits.planType.trim()) {
    out.subscriptionType = limits.planType;
  }

  const resetCredits = asRecord(rootLimits?.rateLimitResetCredits ?? limits?.rateLimitResetCredits);
  const resetCount = numVal(resetCredits?.availableCount);
  if (resetCount !== undefined) out.manualResetsAvailable = resetCount;

  const credits = asRecord(limits?.credits);
  if (credits) {
    if (typeof credits.hasCredits === 'boolean') out.hasCredits = credits.hasCredits;
    if (typeof credits.unlimited === 'boolean') out.unlimitedCredits = credits.unlimited;
    const bal = numVal(credits.balance);
    if (bal !== undefined) out.creditsBalance = bal;
  }

  const primary = asRecord(limits?.primary);
  if (primary) {
    out.primaryWindow = {
      usedPercent: numVal(primary.usedPercent),
      windowDurationMins: numVal(primary.windowDurationMins),
      resetsAt: resetsAtMs(primary.resetsAt),
    };
  }
  const secondary = asRecord(limits?.secondary);
  if (secondary) {
    out.secondaryWindow = {
      usedPercent: numVal(secondary.usedPercent),
      windowDurationMins: numVal(secondary.windowDurationMins),
      resetsAt: resetsAtMs(secondary.resetsAt),
    };
  }

  const summary = asRecord(usageRoot?.summary);
  if (summary) {
    out.summary = {
      lifetimeTokens: numVal(summary.lifetimeTokens) ?? 0,
      peakDailyTokens: numVal(summary.peakDailyTokens) ?? 0,
      longestRunningTurnSec: numVal(summary.longestRunningTurnSec) ?? 0,
      currentStreakDays: numVal(summary.currentStreakDays) ?? 0,
      longestStreakDays: numVal(summary.longestStreakDays) ?? 0,
    };
  }

  if (Array.isArray(usageRoot?.dailyUsageBuckets)) {
    out.dailyUsageBuckets = (usageRoot.dailyUsageBuckets as Record<string, unknown>[]).map((b) => ({
      startDate: String(b.startDate ?? ''),
      tokens: numVal(b.tokens) ?? 0,
    })).filter((b) => b.startDate);
  }

  return out;
}

/** `account/rateLimits/updated` notification params may be the rateLimits
 *  object directly (not wrapped) — the dual-shape parser handles both. */
export const parseCodexRateLimitsNotification = parseCodexRateLimitsJson;

export async function probeCodexRateLimits(opts?: {
  force?: boolean;
  spawnFn?: CodexUsageSpawnFn;
}): Promise<ProbedRateLimits> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight; // coalesce concurrent callers even on force
  inflight = doProbe(opts).finally(() => { inflight = undefined; });
  return inflight;
}

async function doProbe(opts?: {
  spawnFn?: CodexUsageSpawnFn;
}): Promise<ProbedRateLimits> {
  const spawnFn = opts?.spawnFn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'codex') }));
  let child: ChildProcess;
  try {
    child = spawnFn('codex', [...CODEX_USAGE_PROBE_ARGS], {});
  } catch {
    // Cache the failure too — a missing/logged-out codex must not hammer-spawn.
    cache = { at: Date.now(), data: {} };
    return {};
  }

  child.stdin?.on('error', () => {}); // async EPIPE must not crash the server
  child.stderr?.on('data', () => {}); // swallow — a full stderr pipe would block the child
  child.stderr?.on('error', () => {});
  if (!child.stdin || !child.stdout) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    cache = { at: Date.now(), data: {} };
    return {};
  }

  const rpc = new CodexRpc(child.stdin, child.stdout);
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };

  const data = await new Promise<ProbedRateLimits>((resolve) => {
    let settled = false;
    const finish = (out: ProbedRateLimits) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rpc.drainPending('codex usage probe finished');
      kill();
      resolve(out);
    };
    const timer = setTimeout(() => finish({}), TIMEOUT_MS);
    child.on('error', () => finish({}));
    child.on('close', () => finish({}));

    void (async () => {
      try {
        await rpc.initialize();
        const result = await rpc.send('account/rateLimits/read', {});
        finish(parseCodexRateLimitsJson(result));
      } catch {
        finish({});
      }
    })();
  });

  cache = { at: Date.now(), data };
  return data;
}

export async function probeCodexInsights(opts?: {
  force?: boolean;
  spawnFn?: CodexUsageSpawnFn;
}): Promise<CodexInsights> {
  if (!opts?.force && codexInsightsCache && Date.now() - codexInsightsCache.at < TTL_MS) return codexInsightsCache.data;
  if (codexInsightsInflight) return codexInsightsInflight;
  codexInsightsInflight = doProbeInsights(opts).finally(() => { codexInsightsInflight = undefined; });
  return codexInsightsInflight;
}

async function doProbeInsights(opts?: { spawnFn?: CodexUsageSpawnFn }): Promise<CodexInsights> {
  const spawnFn = opts?.spawnFn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'codex') }));
  let child: ChildProcess;
  try {
    child = spawnFn('codex', [...CODEX_USAGE_PROBE_ARGS], {});
  } catch {
    codexInsightsCache = { at: Date.now(), data: { updatedAt: Date.now() } };
    return { updatedAt: Date.now() };
  }

  child.stdin?.on('error', () => {});
  child.stderr?.on('data', () => {});
  child.stderr?.on('error', () => {});
  if (!child.stdin || !child.stdout) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    codexInsightsCache = { at: Date.now(), data: { updatedAt: Date.now() } };
    return { updatedAt: Date.now() };
  }

  const rpc = new CodexRpc(child.stdin, child.stdout);
  let killed = false;
  const kill = () => {
    if (killed) return;
    killed = true;
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };

  const data = await new Promise<CodexInsights>((resolve) => {
    let settled = false;
    const finish = (out: CodexInsights) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rpc.drainPending('codex insights probe finished');
      kill();
      resolve(out);
    };
    const timer = setTimeout(() => finish({ updatedAt: Date.now() }), TIMEOUT_MS);
    child.on('error', () => finish({ updatedAt: Date.now() }));
    child.on('close', () => finish({ updatedAt: Date.now() }));

    void (async () => {
      try {
        await rpc.initialize();
        const limitsRes = await rpc.send('account/rateLimits/read', {}).catch(() => null);
        const usageRes = await rpc.send('account/usage/read', {}).catch(() => null);
        finish(parseCodexInsights(limitsRes, usageRes));
      } catch {
        finish({ updatedAt: Date.now() });
      }
    })();
  });

  codexInsightsCache = { at: Date.now(), data };
  return data;
}
