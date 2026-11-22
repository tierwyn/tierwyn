// Kilo usage plugin: prepaid credit balance per API key.
// Style-matched to openrouter-usage/index.js — module-scope TTL, defensive helpers, named pure exports.
const TTL_MS = 20_000;
const ERROR_TTL_MS = 10_000;
// ponytail: MAX_KEYS=12 keeps the worst case (12 unnamed keys = 24 calls) inside the
// 60/min shared outbound bucket — host.ts GLOBAL_OUTBOUND_PER_MIN rejects, it does not queue.
// Raising this is one constant plus the arithmetic table in the plan §3.2.
const MAX_KEYS = 12;

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

/** Finite number, accepting numeric strings (defensive against schema drift). */
function numVal(raw) {
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

function looksLikeSecret(s) {
  return /^(kilo[-_]|sk-|eyJ)/i.test(s) || (s.length >= 32 && !/\s/.test(s));
}

function pickName(candidate) {
  return (typeof candidate === 'string' && candidate && !looksLikeSecret(candidate))
    ? candidate
    : undefined;
}

/**
 * Operator name wins, after every known entry key is stripped and secret-shaped
 * names are demoted. A present-but-demoted operator name falls back to Key N
 * (does not yield to the API name). No operator name → API name (also demoted,
 * and collision-demoted against already-emitted labels) → Key N.
 */
function resolveDisplayName(entry, n, knownKeys, apiName, usedLabels) {
  const rawName = typeof entry.name === 'string' ? entry.name : '';
  if (rawName) {
    let name = rawName;
    for (const k of knownKeys) name = redactKey(name, k);
    return pickName(name) || `Key ${n}`;
  }
  let api = typeof apiName === 'string' ? apiName : '';
  if (api) {
    for (const k of knownKeys) api = redactKey(api, k);
    const picked = pickName(api);
    if (picked && !usedLabels.has(picked)) return picked;
  }
  return `Key ${n}`;
}

/** Replace every occurrence of `key` in `text` with `[redacted]`. Empty/missing key is a no-op.
 *  Keys shorter than 16 chars are also a no-op so `Work=`-class typos (`timeout=`) cannot
 *  mangle diagnostics (real Kilo bearer tokens are far longer). */
export function redactKey(text, key) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text);
  if (!key || key.length < 16) return s;
  return s.split(key).join('[redacted]');
}

/**
 * Parse a credential value into an ordered list of { name?, key } entries.
 *
 * Grammar:
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
    if (!trimmed) continue; // skip empty/whitespace-only fragments

    const eqIdx = trimmed.indexOf('=');
    let name;
    let key;

    if (eqIdx < 0) {
      // No '=' → bare key
      key = trimmed;
    } else if (eqIdx === 0) {
      // Leading '=' (=kilo-…) → empty name, rest is the key
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

    if (!key) continue; // drop entries with empty key

    // dedupe by key value, keep first occurrence
    if (seen.has(key)) continue;
    seen.add(key);

    const entry = { key };
    if (name) entry.name = name;
    result.push(entry);

    if (result.length >= MAX_KEYS) break;
  }

  return result;
}

/**
 * Parse GET /api/profile/balance response body.
 * Returns { balance, depleted? }. Throws on empty or unusable payloads.
 * `balance` is US dollars. A field whose name unambiguously says micro is / 1e6.
 * No magnitude heuristic — a large dollar balance must stay large.
 */
export function parseKiloBalanceJson(raw) {
  const root = asRecord(raw);
  if (!root) throw new Error('kilo balance: empty response');
  const body = asRecord(root.data) ?? root;

  let balance = numVal(body.balance);
  if (balance === undefined) balance = numVal(body.credits);
  if (balance === undefined) balance = numVal(body.creditBalance);
  if (balance === undefined) {
    const micro = numVal(body.balanceMicroDollars ?? body.balance_micro_dollars ?? body.microDollars);
    if (micro !== undefined) balance = micro / 1e6;
  }
  if (balance === undefined) throw new Error('kilo balance: missing balance');

  const depletedFlag = body.isDepleted ?? body.is_depleted;
  const out = { balance };
  if (typeof depletedFlag === 'boolean') out.depleted = depletedFlag;
  return out;
}

/**
 * Parse GET /api/profile response body. Best-effort: never throws.
 * Returns { name?, email? }. Any unusable shape yields {}.
 */
export function parseKiloProfileJson(raw) {
  const root = asRecord(raw);
  if (!root) return {};
  const user = asRecord(root.user);
  if (!user) return {};
  const out = {};
  if (typeof user.name === 'string' && user.name) out.name = user.name;
  if (typeof user.email === 'string' && user.email) out.email = user.email;
  return out;
}

/**
 * Build the usage result from per-key entries. No account group — Kilo has no
 * account-wide endpoint analogous to OpenRouter's /api/v1/credits.
 *
 * @param {Array<{name?: string, key?: string, raw?: unknown, profile?: unknown, error?: string}>} entries
 * @param {number} nowMs — Date.now(); passed in so tests are deterministic
 * @param {{ forAgent?: boolean }} [opts] — agent callers never get profile name/email as labels
 * @returns {object} The full usage.get result
 */
export function buildKiloUsage(entries, nowMs, opts) {
  const forAgent = Boolean(opts && opts.forAgent);
  const groups = [];
  let firstError;
  let anyOk = false;

  const knownKeys = entries
    .map((e) => e.key)
    .filter((k) => typeof k === 'string' && k);
  const usedLabels = new Set();

  let n = 0;
  for (const entry of entries) {
    n++;
    const groupId = `key-${n}`;
    const profile = forAgent ? {} : parseKiloProfileJson(entry.profile);
    const apiName = profile.name || profile.email;

    if (entry.error) {
      // Capture RAW firstError before label-time redaction so the throw-walk redacts once.
      if (!firstError) firstError = entry.error;
      const displayName = resolveDisplayName(entry, n, knownKeys, apiName, usedLabels);
      usedLabels.add(displayName);
      let errText = entry.error;
      for (const k of knownKeys) errText = redactKey(errText, k);
      groups.push({ id: groupId, label: `${displayName} — ${errText}` });
      continue;
    }

    let parsed;
    try {
      parsed = parseKiloBalanceJson(entry.raw);
    } catch (e) {
      if (!firstError) firstError = e.message;
      const displayName = resolveDisplayName(entry, n, knownKeys, apiName, usedLabels);
      usedLabels.add(displayName);
      let errText = e.message;
      for (const k of knownKeys) errText = redactKey(errText, k);
      groups.push({ id: groupId, label: `${displayName} — ${errText}` });
      continue;
    }

    anyOk = true;
    const displayName = resolveDisplayName(entry, n, knownKeys, apiName, usedLabels);
    usedLabels.add(displayName);
    const group = { id: groupId, label: displayName, prepaidBalance: parsed.balance };
    if (parsed.depleted !== undefined) group.hasCredits = !parsed.depleted;
    groups.push(group);
  }

  if (!anyOk) {
    let msg = firstError || 'kilo: all keys failed';
    for (const k of knownKeys) msg = redactKey(msg, k);
    throw new Error(msg);
  }

  const out = { fetchedAt: nowMs, groups };
  // Healthy keys are prepaid API keys — same paid badge OpenRouter shows for non-free-tier.
  out.plan = 'paid';
  // Mirror, do not sum — balances on distinct Kilo accounts are not fungible.
  const mirror = groups.find((g) => g.prepaidBalance !== undefined);
  if (mirror) {
    out.prepaidBalance = mirror.prepaidBalance;
    if (mirror.hasCredits !== undefined) out.hasCredits = mirror.hasCredits;
  }
  return out;
}

export { asRecord, numVal };

export default {
  activate(ctx) {
    let cache; // { at: number, forAgent: boolean, data?: object, error?: Error }

    async function fetchUsage(opts = {}) {
      const forAgent = opts.forAgent === true;
      if (cache && cache.forAgent === forAgent) {
        const ttl = cache.error ? ERROR_TTL_MS : TTL_MS;
        if (Date.now() - cache.at < ttl) {
          if (cache.error) throw cache.error;
          return cache.data;
        }
      }

      const raw = ctx.credentials.get('KILO_API_KEY');
      const keys = raw ? parseKeyList(raw) : [];
      if (keys.length === 0) {
        throw Object.assign(
          new Error('Kilo key not configured — set KILO_API_KEY (single key or comma-separated list) in Settings → Plugins or the env file'),
          { code: 'credential_missing' },
        );
      }

      try {
        const settings = ctx.settings.get();
        const base = String(settings.baseUrl ?? 'https://api.kilo.ai').replace(/\/+$/, '');

        const entries = await Promise.all(keys.map(async ({ name, key }) => {
          const auth = { Authorization: `Bearer ${key}` };
          // Balance is required; profile is best-effort and only fetched for unnamed keys
          // (the only case whose label can use it) — see plan §3.2 for the call budget.
          const balanceP = ctx.http.fetch(`${base}/api/profile/balance`, {
            headers: auth,
            signal: AbortSignal.timeout(6_000),
          });
          const profileP = (name || forAgent) ? undefined : ctx.http.fetch(`${base}/api/profile`, {
            headers: auth,
            signal: AbortSignal.timeout(6_000),
          }).then((r) => (r.ok ? r.json() : undefined), () => undefined);

          try {
            const res = await balanceP;
            if (!res.ok) {
              await profileP;
              return { name, key, error: `HTTP ${res.status}` };
            }
            return { name, key, raw: await res.json(), profile: await profileP };
          } catch (e) {
            await profileP; // settle it; it already swallows its own errors
            return { name, key, error: redactKey(e.message, key) };
          }
        }));

        const out = buildKiloUsage(entries, Date.now(), { forAgent });
        cache = { at: Date.now(), forAgent, data: out };
        return out;
      } catch (e) {
        // Negative cache so a fully-failing key set cannot fan-out on every invoke
        // and exhaust host.ts GLOBAL_OUTBOUND_PER_MIN (rejects, does not queue).
        cache = { at: Date.now(), forAgent, error: e };
        throw e;
      }
    }

    ctx.capability('usage.get', async (_input, caller) => fetchUsage({ forAgent: caller.kind === 'agent' }));
  },
};
