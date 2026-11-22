// OpenRouter usage plugin: per-key credit balances + optional account totals.
// Style-matched to zai-usage/index.js — module-scope TTL, defensive helpers, named pure exports.
const TTL_MS = 20_000;
// ponytail: MAX_KEYS=12 keeps N+1 calls inside the 60/min shared outbound bucket
// (host.ts GLOBAL_OUTBOUND_PER_MIN=60, rejects rather than queues).
// 3 cold refreshes/min × 13 = 39, leaving 21 for other plugins.
// Raising this is one constant plus the arithmetic in the v2 plan §1.3.
const MAX_KEYS = 12;

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

/** Replace every occurrence of `key` in `text` with `[redacted]`. Empty/missing key is a no-op.
 *  Keys shorter than 16 chars are also a no-op so `Work=`-class typos (`timeout=`) cannot
 *  mangle diagnostics (real OpenRouter keys are `sk-or-v1-` + 64 hex, well above the floor). */
function redactKey(text, key) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!key || key.length < 16) return s;
  return s.split(key).join('[redacted]');
}

/**
 * Parse a credential value into an ordered list of { name?, key } entries.
 *
 * Grammar (§1.2):
 *   value  := entry ( "," entry )*
 *   entry  := [ name "=" ] key
 *
 * @param {string} value — raw credential string
 * @returns {Array<{ name?: string, key: string }>}
 */
export function parseKeyList(value) {
  const parts = String(value).split(',');
  const seen = new Set();
  const result = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue; // rule 2: skip empty/whitespace-only fragments

    const eqIdx = trimmed.indexOf('=');
    let name;
    let key;

    if (eqIdx < 0) {
      // No '=' → bare key
      key = trimmed;
    } else if (eqIdx === 0) {
      // Leading '=' (=sk-…) → empty name, rest is the key
      key = trimmed.slice(1).trim();
    } else {
      const namePart = trimmed.slice(0, eqIdx).trim();
      const keyPart = trimmed.slice(eqIdx + 1).trim();
      if (keyPart) {
        // Both non-empty → named entry
        name = namePart;
        key = keyPart;
      } else {
        // Key part empty (Work=) → treat whole entry as bare key
        key = namePart;
      }
    }

    if (!key) continue; // rule 4: drop entries with empty key

    // rule 5: dedupe by key value, keep first occurrence
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = { key };
    if (name) entry.name = name;
    result.push(entry);

    // rule 6: cap at MAX_KEYS
    if (result.length >= MAX_KEYS) break;
  }

  return result;
}

/**
 * Parse GET /api/v1/key response body.
 * Returns { label?, limit?, limitRemaining?, usage?, isFreeTier? }.
 * Throws on empty or structurally invalid responses.
 */
export function parseOpenRouterKeyJson(raw) {
  const root = asRecord(raw);
  if (!root) throw new Error('openrouter key: empty response');
  const data = asRecord(root.data);
  if (!data) throw new Error('openrouter key: missing data');

  const out = {};
  if (typeof data.label === 'string' && data.label) out.label = data.label;
  const limit = numVal(data.limit);
  if (limit !== undefined) out.limit = limit;
  const limitRemaining = numVal(data.limit_remaining);
  if (limitRemaining !== undefined) out.limitRemaining = limitRemaining;
  const usage = numVal(data.usage);
  if (usage !== undefined) out.usage = usage;
  if (typeof data.is_free_tier === 'boolean') out.isFreeTier = data.is_free_tier;
  return out;
}

/**
 * Parse GET /api/v1/credits response body.
 * Returns { totalCredits, totalUsage, remaining }.
 * Throws on empty or structurally invalid responses.
 */
export function parseOpenRouterCreditsJson(raw) {
  const root = asRecord(raw);
  if (!root) throw new Error('openrouter credits: empty response');
  const data = asRecord(root.data);
  if (!data) throw new Error('openrouter credits: missing data');

  const totalCredits = numVal(data.total_credits);
  const totalUsage = numVal(data.total_usage);
  if (totalCredits === undefined || totalUsage === undefined) {
    throw new Error('openrouter credits: missing data');
  }
  return {
    totalCredits,
    totalUsage,
    remaining: totalCredits - totalUsage,
  };
}

/**
 * Masked-label demotion: OpenRouter auto-labels unnamed keys with a prefix
 * like "SK-OR-V1-EEC…E6B" — that is not a name and leaks key material.
 * Returns the label if it is a genuine operator-chosen name, undefined otherwise.
 */
function pickLabel(label) {
  return (typeof label === 'string' && label && !/^sk-or-/i.test(label)) ? label : undefined;
}

/**
 * Operator name wins, after every known entry key is stripped and `sk-or-` names are demoted.
 * A present-but-demoted operator name falls back to Key N (does not yield to the API label).
 * No operator name → API label (also demoted) → Key N.
 */
function resolveDisplayName(entry, n, knownKeys, apiLabel) {
  const rawName = typeof entry.name === 'string' ? entry.name : '';
  if (rawName) {
    let name = rawName;
    for (const k of knownKeys) name = redactKey(name, k);
    return pickLabel(name) || `Key ${n}`;
  }
  return pickLabel(apiLabel) || `Key ${n}`;
}

/**
 * Build the usage result from per-key entries + optional account data.
 *
 * @param {Array<{name?: string, raw?: object, error?: string}>} entries — in parsed-list order
 * @param {object|undefined} accountRaw — /credits body, or undefined when 403/unavailable
 * @param {number} nowMs — Date.now()
 * @returns {object} The full usage.get result
 */
export function buildOpenRouterUsage(entries, accountRaw, nowMs) {
  const groups = [];
  let plan;
  let firstError;
  let anyOk = false;

  // Try to parse account data (best effort)
  let account;
  if (accountRaw !== undefined) {
    try {
      account = parseOpenRouterCreditsJson(accountRaw);
    } catch (_) {
      // Account parsing failure is never fatal
    }
  }

  // Account group goes first when available — prepaid balance only (historic usage omitted)
  if (account) {
    const acctGroup = {
      id: 'account',
      label: 'Account',
      prepaidBalance: account.remaining,
    };
    groups.push(acctGroup);
  }

  // Per-key groups
  const knownKeys = entries
    .map((e) => e.key)
    .filter((k) => typeof k === 'string' && k);
  let keyIdx = 0;
  for (const entry of entries) {
    keyIdx++;
    const n = keyIdx;
    const groupId = `key-${n}`;

    if (entry.error) {
      // Capture RAW firstError before label-time redaction so the throw-walk redacts once.
      if (!firstError) firstError = entry.error;
      const errText = redactKey(entry.error, entry.key);
      const displayName = resolveDisplayName(entry, n, knownKeys);
      groups.push({ id: groupId, label: `${displayName} — ${errText}` });
      continue;
    }

    let parsed;
    try {
      parsed = parseOpenRouterKeyJson(entry.raw);
    } catch (e) {
      if (!firstError) firstError = e.message;
      const errText = redactKey(e.message, entry.key);
      const displayName = resolveDisplayName(entry, n, knownKeys);
      groups.push({ id: groupId, label: `${displayName} — ${errText}` });
      continue;
    }

    anyOk = true;

    // Determine plan from first healthy key
    if (plan === undefined && parsed.isFreeTier !== undefined) {
      plan = parsed.isFreeTier ? 'free tier' : 'paid';
    }

    const displayName = resolveDisplayName(entry, n, knownKeys, parsed.label);
    const limit = parsed.limit;

    if (limit !== undefined && Number.isFinite(limit)) {
      // Capped key
      const limitRemaining = parsed.limitRemaining;
      let creditsUsed;
      if (limitRemaining !== undefined && Number.isFinite(limitRemaining)) {
        creditsUsed = Math.max(0, limit - limitRemaining);
      } else if (parsed.usage !== undefined) {
        creditsUsed = Math.max(0, parsed.usage);
      }

      const group = { id: groupId, label: displayName };
      if (creditsUsed !== undefined) group.creditsUsed = creditsUsed;
      group.creditsLimit = limit;
      if (limit > 0 && creditsUsed !== undefined) {
        group.monthlyPct = clampPct(100 * creditsUsed / limit);
      }
      group.monthlyWindowLabel = 'key credits used';
      // Key limit remaining is not prepaid balance — "credits N of LIMIT" already shows it.
      groups.push(group);
    } else {
      // Uncapped key
      const group = { id: groupId, label: `${displayName} — no spend cap` };
      if (account) {
        group.prepaidBalance = account.remaining;
      }
      groups.push(group);
    }
  }

  // If every entry errored, throw so the card shows a real error
  if (!anyOk && !account) {
    let msg = firstError || 'openrouter: all keys failed';
    for (const failed of entries) {
      msg = redactKey(msg, failed.key);
    }
    throw new Error(msg);
  }

  // Build result with top-level mirror
  const out = { fetchedAt: nowMs, groups };
  if (plan !== undefined) out.plan = plan;

  // Top-level mirror: account group first, else first key group with data
  const mirror = account
    ? groups.find(g => g.id === 'account')
    : groups.find(g => g.creditsUsed !== undefined || g.creditsLimit !== undefined || g.prepaidBalance !== undefined);
  if (mirror) {
    if (mirror.creditsUsed !== undefined) out.creditsUsed = mirror.creditsUsed;
    if (mirror.creditsLimit !== undefined) out.creditsLimit = mirror.creditsLimit;
    if (mirror.monthlyPct !== undefined) out.monthlyPct = mirror.monthlyPct;
    if (mirror.monthlyWindowLabel !== undefined) out.monthlyWindowLabel = mirror.monthlyWindowLabel;
    if (mirror.prepaidBalance !== undefined) out.prepaidBalance = mirror.prepaidBalance;
  }

  return out;
}

export { asRecord, clampPct, numVal };

export default {
  activate(ctx) {
    let cache;

    async function fetchUsage() {
      if (cache && Date.now() - cache.at < TTL_MS) return cache.data;

      const raw = ctx.credentials.get('OPENROUTER_API_KEY');
      const keys = raw ? parseKeyList(raw) : [];
      if (keys.length === 0) {
        throw Object.assign(
          new Error(
            'OpenRouter key not configured — set OPENROUTER_API_KEY (single key or comma-separated list) in Settings → Plugins or the env file',
          ),
          { code: 'credential_missing' },
        );
      }

      const settings = ctx.settings.get();
      const base = String(settings.baseUrl ?? 'https://openrouter.ai').replace(/\/+$/, '');

      // Per-key /api/v1/key plus one best-effort /api/v1/credits (which uses keys[0]),
      // all in parallel. Worst case per refresh is ~12s — a 404 on /api/v1/key serialises
      // the legacy-alias retry behind its own 6s signal — against the 15s host budget.
      // ponytail: MAX_KEYS=12 keeps N+1 calls inside the 60/min shared outbound bucket.
      const keyPromises = keys.map(async ({ name, key }) => {
        try {
          let res = await ctx.http.fetch(`${base}/api/v1/key`, {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(6_000),
          });
          // 404 fallback to legacy path
          if (res.status === 404) {
            res = await ctx.http.fetch(`${base}/api/v1/auth/key`, {
              headers: { Authorization: `Bearer ${key}` },
              signal: AbortSignal.timeout(6_000),
            });
          }
          if (!res.ok) return { name, key, error: `HTTP ${res.status}` };
          return { name, key, raw: await res.json() };
        } catch (e) {
          return { name, key, error: redactKey(e.message, key) };
        }
      });

      // Account totals — best effort, once, with first key only
      const creditsPromise = (async () => {
        try {
          const res = await ctx.http.fetch(`${base}/api/v1/credits`, {
            headers: { Authorization: `Bearer ${keys[0].key}` },
            signal: AbortSignal.timeout(6_000),
          });
          if (res.ok) return await res.json();
          // 401/403 or any non-2xx → undefined, silently
        } catch (_) {
          // DNS/timeout/abort → silently omit account group
        }
        return undefined;
      })();

      const [entries, accountRaw] = await Promise.all([
        Promise.all(keyPromises),
        creditsPromise,
      ]);

      const out = buildOpenRouterUsage(entries, accountRaw, Date.now());
      cache = { at: Date.now(), data: out };
      return out;
    }

    ctx.capability('usage.get', async () => fetchUsage());
  },
};
