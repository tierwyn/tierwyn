import { randomUUID } from 'crypto';

// In-memory, ephemeral run tokens for schedule step API auth. Issued per tick run,
// revoked when the run finishes or after a TTL backstop — same lifecycle model as
// spawn tokens (see spawn/tokens.ts).
// Idle backstop, not a lifetime: slides on each successful validateRunToken
// (every schedule step API call). An unused token dies at 30 min.
export const DEFAULT_RUN_TOKEN_TTL_MS = 30 * 60_000;
let ttlMs = DEFAULT_RUN_TOKEN_TTL_MS;
export function setScheduleRunTokenTtlMs(ms: number): void { ttlMs = ms; }
export function getScheduleRunTokenTtlMs(): number { return ttlMs; }

interface Entry {
  jobId: string;
  runId: string;
  conversationId: string;
  expiresAt: number;
}

const tokens = new Map<string, Entry>();

export function issueRunToken(opts: {
  jobId: string;
  runId: string;
  conversationId: string;
}): string {
  const token = randomUUID();
  tokens.set(token, { ...opts, expiresAt: Date.now() + ttlMs });
  return token;
}

export function validateRunToken(
  token: string | undefined,
  jobId: string,
):
  | { ok: true; jobId: string; runId: string; conversationId: string }
  | { ok: false } {
  if (!token) return { ok: false };
  const entry = tokens.get(token);
  if (!entry) return { ok: false };
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token);
    return { ok: false };
  }
  if (entry.jobId !== jobId) return { ok: false };
  entry.expiresAt = Date.now() + ttlMs;
  return {
    ok: true,
    jobId: entry.jobId,
    runId: entry.runId,
    conversationId: entry.conversationId,
  };
}

export function redactRunTokens(text: string): string {
  let out = text;
  for (const token of tokens.keys()) out = out.split(token).join('[REDACTED]');
  return out;
}

export function revokeRunToken(token: string): void {
  tokens.delete(token);
}

/** Update the conversationId bound to a live token in place, keeping the same
 *  token string. Used when the child conversation is created after the token
 *  was already rendered into the tick prompt — issuing a fresh string would
 *  orphan the value the agent has in hand. No-op if the token is unknown. */
export function rebindRunToken(token: string, conversationId: string): void {
  const entry = tokens.get(token);
  if (entry) entry.conversationId = conversationId;
}

export function revokeRunTokensForRun(runId: string): void {
  for (const [token, entry] of tokens) {
    if (entry.runId === runId) tokens.delete(token);
  }
}
