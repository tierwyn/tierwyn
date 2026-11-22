import { spawn as nodeSpawn, type ChildProcess } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import type { ProbedRateLimits } from '../claude-code/probeUsage.js';
import { GrokRpc } from './protocol.js';

export type { ProbedRateLimits };

/** Throwaway ACP probe: initialize + `_x.ai/billing`, no session, no prompt. */
export const GROK_USAGE_PROBE_ARGS = ['agent', '--no-leader', 'stdio'] as const;

const TTL_MS = 20_000;
const TIMEOUT_MS = 12_000;

let cache: { at: number; data: ProbedRateLimits } | undefined;
let inflight: Promise<ProbedRateLimits> | undefined;

export type GrokUsageSpawnFn = (cmd: string, args: string[], opts: { cwd?: string }) => ChildProcess;

export function resetGrokUsageProbeForTests(): void {
  cache = undefined;
  inflight = undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function clampPct(n: number): number {
  return Math.min(100, Math.max(0, n));
}

function usdFromCents(raw: unknown): number | undefined {
  const cents = typeof raw === 'number' && Number.isFinite(raw)
    ? raw
    : (() => { const rec = asRecord(raw); return typeof rec?.val === 'number' && Number.isFinite(rec.val) ? rec.val : undefined; })();
  return cents === undefined ? undefined : cents / 100;
}

function resetMs(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : undefined;
}

function pickTier(root: Record<string, unknown>, config: Record<string, unknown>): string | undefined {
  for (const v of [root.subscription_tier, root.subscriptionTier, config.subscriptionTier]) {
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Map a `_x.ai/billing` result (or REST credits JSON) onto Claude-style used-percent rate limits. */
export function parseGrokBillingJson(raw: unknown): ProbedRateLimits {
  const root = asRecord(raw);
  const config = asRecord(root?.config);
  if (!root || !config) return {};

  const out: ProbedRateLimits = {};
  const period = asRecord(config.currentPeriod);
  const periodType = typeof period?.type === 'string' ? period.type : '';
  const hasWeeklyPeriod = periodType.includes('WEEKLY');

  if (typeof config.creditUsagePercent === 'number' && Number.isFinite(config.creditUsagePercent)) {
    out.sevenDayPct = clampPct(config.creditUsagePercent);
  } else if (period && hasWeeklyPeriod) {
    // proto3 JSON omits 0 — a weekly period with no percent is 0% used.
    out.sevenDayPct = 0;
  } else {
    const used = usdFromCents(config.used);
    const limit = usdFromCents(config.monthlyLimit);
    if (used !== undefined && limit !== undefined && limit > 0) {
      out.sevenDayPct = clampPct((used / limit) * 100);
    }
  }

  const end = period?.end ?? config.billingPeriodEnd;
  const at = resetMs(end);
  if (at !== undefined) out.sevenDayResetsAt = at;

  const prepaid = usdFromCents(config.prepaidBalance);
  if (prepaid !== undefined) out.prepaidBalance = prepaid;

  const onDemandUsed = usdFromCents(config.onDemandUsed);
  if (onDemandUsed !== undefined) out.onDemandUsed = onDemandUsed;

  const onDemandCap = usdFromCents(config.onDemandCap) ?? usdFromCents(config.onDemandLimit);
  if (onDemandCap !== undefined) out.onDemandCap = onDemandCap;

  const tier = pickTier(root, config);
  if (tier) out.subscriptionType = tier;
  return out;
}

export async function probeGrokRateLimits(opts?: {
  cwd?: string;
  force?: boolean;
  spawnFn?: GrokUsageSpawnFn;
}): Promise<ProbedRateLimits> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = doProbe(opts).finally(() => { inflight = undefined; });
  return inflight;
}

async function doProbe(opts?: {
  cwd?: string;
  spawnFn?: GrokUsageSpawnFn;
}): Promise<ProbedRateLimits> {
  const spawnFn = opts?.spawnFn ?? ((cmd, args, o) => nodeSpawn(cmd, args, { ...o, stdio: ['pipe', 'pipe', 'pipe'], env: buildChildEnv(undefined, undefined, 'grok-build') }));
  let child: ChildProcess;
  try {
    child = spawnFn('grok', [...GROK_USAGE_PROBE_ARGS], { cwd: opts?.cwd });
  } catch {
    cache = { at: Date.now(), data: {} };
    return {};
  }

  child.stdin?.on('error', () => {});
  if (!child.stdin || !child.stdout) {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
    cache = { at: Date.now(), data: {} };
    return {};
  }

  const rpc = new GrokRpc(child.stdin, child.stdout);
  const kill = () => {
    try { child.kill('SIGTERM'); } catch { /* already gone */ }
  };

  const data = await new Promise<ProbedRateLimits>((resolve) => {
    let settled = false;
    const finish = (out: ProbedRateLimits) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rpc.drainPending('grok usage probe finished');
      kill();
      resolve(out);
    };
    const timer = setTimeout(() => finish({}), TIMEOUT_MS);
    child.on('error', () => finish({}));
    child.on('close', () => finish({}));

    void (async () => {
      try {
        await rpc.initialize();
        const result = await rpc.send<unknown>('_x.ai/billing', {});
        finish(parseGrokBillingJson(result));
      } catch {
        finish({});
      }
    })();
  });

  cache = { at: Date.now(), data };
  return data;
}
