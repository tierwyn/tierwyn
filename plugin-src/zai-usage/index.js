// Z.ai usage plugin: lets agents query their account quota without ever seeing ZAI_API_KEY.
// parseZaiQuotaJson + helpers are ported from the former OpenAI-compatible quota probe.
const TTL_MS = 20_000;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function clampPct(n) {
  return Math.min(100, Math.max(0, n));
}

/** Finite number, accepting numeric strings (defensive against schema drift). */
function numVal(raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/**
 * Map a quota/limit response body onto Claude-style used-percent rate
 * limits. Throws on non-200 envelope codes (auth, param, server errors).
 */
export function parseZaiQuotaJson(raw) {
  const root = asRecord(raw);
  if (!root) throw new Error('z.ai quota: empty response');
  const code = numVal(root.code);
  if (code !== 200) {
    const msg = typeof root.msg === 'string' && root.msg ? root.msg : 'unknown error';
    throw new Error(`z.ai quota: ${msg} (code ${code ?? '?'})`);
  }
  const data = asRecord(root.data);
  if (!data) throw new Error('z.ai quota: missing data');

  const out = {};
  for (const entry of Array.isArray(data.limits) ? data.limits : []) {
    const limit = asRecord(entry);
    if (!limit) continue;
    const unit = numVal(limit.unit);
    const pct = numVal(limit.percentage);
    const resets = numVal(limit.nextResetTime);
    if (unit === 3) {
      if (pct !== undefined) out.fiveHourPct = clampPct(pct);
      if (resets !== undefined && resets > 0) out.fiveHourResetsAt = resets;
    } else if (unit === 6) {
      if (pct !== undefined) out.sevenDayPct = clampPct(pct);
      if (resets !== undefined && resets > 0) out.sevenDayResetsAt = resets;
    }
    // unit 5 (monthly tool/web time) has no panel bucket — skipped.
  }

  const level = typeof data.level === 'string' ? data.level.trim() : '';
  if (level) out.subscriptionType = level;
  return out;
}

export { asRecord, clampPct, numVal };

export default {
  activate(ctx) {
    let cache;

    async function fetchQuota() {
      if (cache && Date.now() - cache.at < TTL_MS) return cache.data;
      const key = ctx.credentials.get('ZAI_API_KEY');
      if (!key) {
        throw Object.assign(
          new Error('Z.ai key not configured — set a dedicated ZAI_API_KEY in the env file and restart'),
          { code: 'credential_missing' },
        );
      }
      const settings = ctx.settings.get();
      const base = String(settings.baseUrl ?? 'https://api.z.ai').replace(/\/+$/, '');
      const res = await ctx.http.fetch(`${base}/api/monitor/usage/quota/limit`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(12_000),
      });
      if (!res.ok) throw new Error(`z.ai quota: HTTP ${res.status}`);
      const body = await res.json();
      const parsed = parseZaiQuotaJson(body);
      const out = { fetchedAt: Date.now() };
      if (parsed.fiveHourPct !== undefined) out.fiveHourPct = parsed.fiveHourPct;
      if (parsed.fiveHourResetsAt !== undefined) out.fiveHourResetsAt = parsed.fiveHourResetsAt;
      if (parsed.sevenDayPct !== undefined) out.sevenDayPct = parsed.sevenDayPct;
      if (parsed.sevenDayResetsAt !== undefined) out.sevenDayResetsAt = parsed.sevenDayResetsAt;
      if (parsed.subscriptionType) out.plan = parsed.subscriptionType;
      cache = { at: Date.now(), data: out };
      return out;
    }

    ctx.capability('usage.get', async () => fetchQuota());
  },
};
