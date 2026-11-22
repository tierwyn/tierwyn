import { execFile } from 'child_process';
import { buildChildEnv } from '../../childEnv.js';
import type { ProbedRateLimits } from '../claude-code/probeUsage.js';

const TTL_MS = 20_000;
const TIMEOUT_MS = 8_000;
const QUOTA_URL = 'https://api.github.com/copilot_internal/user';

let cache: { at: number; data: ProbedRateLimits } | undefined;
let inflight: Promise<ProbedRateLimits> | undefined;

export function resetCopilotUsageProbeForTests(): void {
  cache = undefined;
  inflight = undefined;
}

interface QuotaSnapshot {
  entitlement?: number;
  remaining?: number;
  unlimited?: boolean;
  has_quota?: boolean;
}

/** Map `GET /copilot_internal/user` onto monthly credits. Premium requests win;
 *  plans with no premium allowance (Free) fall back to the chat quota. */
export function parseCopilotQuota(body: unknown): ProbedRateLimits {
  const b = (body ?? {}) as {
    copilot_plan?: string;
    access_type_sku?: string;
    quota_reset_date_utc?: string;
    quota_reset_date?: string;
    quota_snapshots?: Record<string, QuotaSnapshot>;
  };
  const out: ProbedRateLimits = {};
  const plan = b.access_type_sku?.includes('free') ? 'free' : b.copilot_plan;
  if (plan) out.subscriptionType = plan;
  const resetAt = Date.parse(b.quota_reset_date_utc ?? b.quota_reset_date ?? '');
  if (Number.isFinite(resetAt)) out.monthlyResetsAt = resetAt;

  const snaps = b.quota_snapshots ?? {};
  const q = [snaps.premium_interactions, snaps.chat]
    .find((s) => s && (s.unlimited || (s.entitlement ?? 0) > 0));
  if (!q) return out;
  if (q.unlimited) {
    out.unlimitedCredits = true;
    return out;
  }
  const limit = Number(q.entitlement);
  const used = limit - Number(q.remaining);
  if (Number.isFinite(used) && limit > 0) {
    out.creditsLimit = limit;
    out.creditsUsed = Math.max(0, used); // ponytail: overage shows as 100%, overage_count not surfaced
    out.monthlyPct = Math.min(100, Math.max(0, (used / limit) * 100));
  }
  return out;
}

/** GitHub OAuth token the Copilot CLI also accepts. ponytail: gh only; read the
 *  copilot CLI keyring entry if operators without `gh` need this. */
function ghToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { env: buildChildEnv(undefined, undefined, 'copilot'), timeout: TIMEOUT_MS }, (err, stdout) => {
      const tok = stdout?.trim();
      if (err || !tok) reject(new Error('no GitHub token — run `gh auth login`'));
      else resolve(tok);
    });
  });
}

export async function probeCopilotRateLimits(opts?: {
  force?: boolean;
  getToken?: () => Promise<string>;
  fetchFn?: typeof fetch;
}): Promise<ProbedRateLimits> {
  if (!opts?.force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;
  inflight = (async () => {
    const token = await (opts?.getToken ?? ghToken)();
    const res = await (opts?.fetchFn ?? fetch)(QUOTA_URL, {
      headers: { Authorization: `token ${token}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`copilot quota HTTP ${res.status}`);
    const data = parseCopilotQuota(await res.json());
    cache = { at: Date.now(), data };
    return data;
  })().finally(() => { inflight = undefined; });
  return inflight;
}
