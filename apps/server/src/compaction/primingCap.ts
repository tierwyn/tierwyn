/** Linux MAX_ARG_STRLEN caps one argv string at 128 KiB (131072 bytes), well below
 *  ARG_MAX. Adapters that pass the full prompt as one CLI argument must stay under
 *  it or spawn() throws E2BIG. */
export const MAX_ARGV_PROMPT_BYTES = 120_000;

/** Priming body budget for adapters that take the prompt over stdin/RPC. */
export const MAX_PRIMING_BYTES = 400_000;

/** Adapters whose whole prompt (preamble + priming + user text) is one argv string. */
export const ARGV_PROMPT_ADAPTERS = new Set(['cursor', 'copilot', 'opencode', 'kilocode', 'openclaw']);

// ponytail: fixed 40 KB reserve for preamble + user text. An oversized user message
// still falls through to the adapter's tail cap, which drops the head of the prompt.
export const ARGV_PRIMING_BYTES = 80_000;

const TRUNC_MARKER =
  '[earlier handoff context truncated — prompt exceeded spawn argv size limit]\n';

/** Trim prompt text to fit argv spawn limits, keeping the most recent tail. */
export function capForArgvSpawn(text: string, maxBytes = MAX_ARGV_PROMPT_BYTES): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  const markerBuf = Buffer.from(TRUNC_MARKER, 'utf8');
  const budget = Math.max(0, maxBytes - markerBuf.length);
  let tail = buf.subarray(buf.length - budget).toString('utf8');
  const nl = tail.indexOf('\n');
  if (nl >= 0 && nl < tail.length - 1) tail = tail.slice(nl + 1);
  return TRUNC_MARKER + tail;
}
