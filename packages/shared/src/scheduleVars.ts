/**
 * Per-job fire-time knobs. Interpolated as {{vars.<key>}} on every tick.
 *
 * Shared so the agent parser, operator routes, and the edit-modal pre-check
 * cannot drift. String values only — this is a trust boundary an agent writes to.
 */

export const VAR_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;
export const VAR_MAX_KEYS = 32;
export const VAR_VALUE_MAX_BYTES = 2048;
export const VARS_MAX_BYTES = 8192;

export type ParseScheduleVariablesResult =
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; error: string };

function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Validate an untrusted `variables` value.
 *
 * `null` / `undefined` → clear/absent (`value: undefined`). Never throws.
 * `{}` after validation also normalises to `undefined` so "no variables" has
 * one representation.
 */
export function parseScheduleVariables(input: unknown): ParseScheduleVariablesResult {
  if (input === null || input === undefined) {
    return { ok: true, value: undefined };
  }
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, error: 'variables must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length > VAR_MAX_KEYS) {
    return { ok: false, error: `variables: at most ${VAR_MAX_KEYS} keys` };
  }
  const out: Record<string, string> = Object.create(null);
  for (const k of keys) {
    if (!VAR_KEY_RE.test(k)) {
      return {
        ok: false,
        error: `variables: invalid key "${k}" (letters, digits, _ ; must not start with a digit; ≤ 64 chars)`,
      };
    }
    const v = obj[k];
    if (typeof v !== 'string') {
      return { ok: false, error: `variables.${k} must be a string` };
    }
    if (utf8ByteLength(v) > VAR_VALUE_MAX_BYTES) {
      return { ok: false, error: `variables.${k} exceeds ${VAR_VALUE_MAX_BYTES} bytes` };
    }
    out[k] = v;
  }
  if (utf8ByteLength(JSON.stringify(out)) > VARS_MAX_BYTES) {
    return { ok: false, error: `variables too large (max ${VARS_MAX_BYTES} bytes)` };
  }
  if (keys.length === 0) return { ok: true, value: undefined };
  return { ok: true, value: out };
}
