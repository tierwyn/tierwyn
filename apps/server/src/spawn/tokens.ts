import { randomUUID } from 'crypto';
import {
  BUILTIN_CAPABILITY_PROFILES,
  DEFAULT_CAPABILITY_PROFILE_ID,
  type ResolvedCapabilityProfile,
} from '@tierwyn/shared';

// In-memory, ephemeral spawn tokens. Replaces the static SPAWN_TOKEN env secret:
// a fresh token is issued to each spawn-capable agent session and dies when that
// session ends (revokeForSession) or after a TTL backstop, whichever comes first.
// Never written to disk, so it can't leak via .env/backups and can't be replayed
// after the run. ponytail: a plain Map is the whole store — single process, no
// persistence needed (tokens are meant to die on restart anyway). Upgrade path:
// if the server ever runs multi-process, move this to the shared DB/Redis.
// Idle backstop, not a lifetime: slides on session events, on every wake-up
// (user or bridged steer) and while a wait:true spawn is blocked. An expired
// token is reissued with session-start capability rules on the next wake.
export const SPAWN_TOKEN_TTL_MS = 30 * 60_000;
let ttlMs = SPAWN_TOKEN_TTL_MS;
export function setSpawnTokenTtlMs(ms: number): void { ttlMs = ms; }
export function getSpawnTokenTtlMs(): number { return ttlMs; }

/** Independent capabilities on a live token. `'mesh'` is minted onto the
 *  session's existing set iff meshMessaging !== 'off' at session start.
 *  `'tasks'` is minted iff `globalTasksAllowed(settings, isRoot)` at mint time.
 *  Historical string `'spawn'` maps to SPAWN_CAPABILITIES; `'schedule'` maps
 *  to SCHEDULE_CAPABILITIES. */
export type TokenCapability = 'spawn' | 'schedule' | 'plugin' | 'mesh' | 'tasks' | 'memory';

/** Preserves today's `'spawn'` mint: spawn ⊃ {plugin, schedule}. */
export const SPAWN_CAPABILITIES: ReadonlySet<TokenCapability> = new Set(['spawn', 'schedule', 'plugin']);
/** Preserves today's `'schedule'` mint (legacy string mapping; schedule-only
 *  conversations now mint CONVERSATION_CAPABILITIES). */
export const SCHEDULE_CAPABILITIES: ReadonlySet<TokenCapability> = new Set(['schedule']);
/** Every non-spawn / schedule-only conversation: schedule + plugin. Grants
 *  `plugin` so single-agent conversations can invoke enabled Tierwyn plugins;
 *  still no spawn rights. */
export const CONVERSATION_CAPABILITIES: ReadonlySet<TokenCapability> = new Set(['schedule', 'plugin']);

interface Entry {
  conversationId: string;
  sessionId: string;
  expiresAt: number;
  scope: Set<TokenCapability>;
  /** Capability-profile grant snapshotted at mint time — the conversation's
   *  profile changing later never widens a live token (re-issue to narrow). */
  capProfile: ResolvedCapabilityProfile;
}

const tokens = new Map<string, Entry>();

/** The resolved default profile ('all'): full plugin surface + usage. Call
 *  sites that don't pass a profile mint exactly what they minted before
 *  profiles existed. */
export const DEFAULT_RESOLVED_PROFILE: ResolvedCapabilityProfile = (() => {
  const found = BUILTIN_CAPABILITY_PROFILES.find((p) => p.id === DEFAULT_CAPABILITY_PROFILE_ID)!;
  return { id: found.id, plugins: found.plugins, usage: found.usage };
})();

/** Defensive copy so callers can never mutate the store's grant through a
 *  returned reference (mirrors the `scope` copy discipline). */
function copyResolvedProfile(p: ResolvedCapabilityProfile): ResolvedCapabilityProfile {
  return { id: p.id, plugins: p.plugins === '*' ? '*' : [...p.plugins], usage: p.usage, memory: p.memory };
}

function resolveScope(
  scope: ReadonlySet<TokenCapability> | 'spawn' | 'schedule',
): Set<TokenCapability> {
  if (scope === 'spawn') return new Set(SPAWN_CAPABILITIES);
  if (scope === 'schedule') return new Set(SCHEDULE_CAPABILITIES);
  return new Set(scope);
}

/** Issue a fresh token bound to a session. Returned token goes into the agent's
 *  preamble; it's the only place the value ever exists. Default scope is the
 *  historical `'spawn'` mint (`{spawn, schedule, plugin}`) so existing call
 *  sites keep minting full-capability tokens. `capProfile` is the conversation's
 *  resolved plugin/usage grant baked in at mint time (default: the `'all'`
 *  profile, i.e. today's unrestricted behaviour). */
export function issueSpawnToken(
  conversationId: string,
  sessionId: string,
  scope: ReadonlySet<TokenCapability> | 'spawn' | 'schedule' = 'spawn',
  capProfile: ResolvedCapabilityProfile = DEFAULT_RESOLVED_PROFILE,
): string {
  const token = randomUUID();
  tokens.set(token, {
    conversationId,
    sessionId,
    expiresAt: Date.now() + ttlMs,
    scope: resolveScope(scope),
    capProfile: copyResolvedProfile(capProfile),
  });
  return token;
}

/** True iff the token is live, unexpired, spawn-capable, and bound to the conversation
 *  it's spawning under. Scope check stops a schedule-only token from escalating to
 *  /spawn*; conversation check stops a token leaked from conv A spawning in conv B. */
/** Authorize POST /spawn/:id/message: spawn-scoped (downward T0) OR mesh-scoped
 *  (lateral). Schedule-only tokens without mesh still fail. */
export function validateMessageToken(token: string | undefined, senderConversationId: string): boolean {
  const entry = peekSpawnToken(token);
  if (!entry) return false;
  if (entry.conversationId !== senderConversationId) return false;
  if (!entry.scope.has('spawn') && !entry.scope.has('mesh')) return false;
  touchSpawnToken(token);
  return true;
}

export function validateSpawnToken(token: string | undefined, parentConversationId: string): boolean {
  if (!token) return false;
  const entry = tokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { tokens.delete(token); return false; }
  // Escalation-direction guard: tokens without 'spawn' must NEVER authorize /spawn*.
  if (!entry.scope.has('spawn')) return false;
  if (entry.conversationId !== parentConversationId) return false;
  entry.expiresAt = Date.now() + ttlMs;
  return true;
}

/** Slide the expiration window on active usage / user interaction. */
export function touchSpawnToken(token: string | undefined): boolean {
  if (!token) return false;
  const entry = tokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token);
    return false;
  }
  entry.expiresAt = Date.now() + ttlMs;
  return true;
}

/** Returns the newest unexpired token bound to a conversation, if any. */
export function getLiveTokenForConversation(conversationId: string): {
  token: string;
  expiresAt: number;
  scope: ReadonlySet<TokenCapability>;
  capProfile: ResolvedCapabilityProfile;
} | undefined {
  let latestToken: string | undefined;
  let latestEntry: Entry | undefined;
  for (const [token, entry] of tokens.entries()) {
    if (entry.conversationId === conversationId) {
      if (Date.now() > entry.expiresAt) {
        tokens.delete(token);
      } else if (!latestEntry || entry.expiresAt > latestEntry.expiresAt) {
        latestToken = token;
        latestEntry = entry;
      }
    }
  }
  if (!latestToken || !latestEntry) return undefined;
  return {
    token: latestToken,
    expiresAt: latestEntry.expiresAt,
    scope: new Set(latestEntry.scope),
    capProfile: copyResolvedProfile(latestEntry.capProfile),
  };
}

/** Look up a live token without a conversation-binding or scope-kind check. Used by
 *  schedule-create and the schedule step API (both accept spawn AND schedule scopes —
 *  the asymmetry is intentional: schedule ↛ spawn, but spawn may still schedule).
 *  Callers do their own `scope.has(...)`. Expired tokens are purged and treated as
 *  missing. Returned `scope` is a copy so callers cannot mutate the store. */
export function peekSpawnToken(
  token: string | undefined,
): { conversationId: string; sessionId: string; scope: ReadonlySet<TokenCapability>; capProfile: ResolvedCapabilityProfile; expiresAt: number } | undefined {
  if (!token) return undefined;
  const entry = tokens.get(token);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    tokens.delete(token);
    return undefined;
  }
  return {
    conversationId: entry.conversationId,
    sessionId: entry.sessionId,
    scope: new Set(entry.scope),
    capProfile: copyResolvedProfile(entry.capProfile),
    expiresAt: entry.expiresAt,
  };
}

/** Scrub any currently-live token value out of text before it's persisted, so a
 *  token never lands in the events table / REST transcript while it's still valid. */
export function redactSpawnTokens(text: string): string {
  let out = text;
  for (const token of tokens.keys()) out = out.split(token).join('[REDACTED]');
  return out;
}

/** Revoke on session end — the primary, prompt lifecycle path. */
export function revokeSpawnTokensForSession(sessionId: string): void {
  for (const [token, entry] of tokens) {
    if (entry.sessionId === sessionId) tokens.delete(token);
  }
}

/** Revoke every live token bound to a conversation. Used when a conversation's
 *  capability profile is narrowed on PATCH: parked sessions' tokens carry the
 *  old grant, so they must die before a fresh token is issued against the new
 *  profile (a live token is never widened, and narrowing must not wait for TTL). */
export function revokeSpawnTokensForConversation(conversationId: string): void {
  for (const [token, entry] of tokens) {
    if (entry.conversationId === conversationId) tokens.delete(token);
  }
}

/** Slide every live token bound to this session. Expired ones are dropped, never revived. */
export function touchSpawnTokensForSession(sessionId: string): void {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.sessionId !== sessionId) continue;
    if (now > entry.expiresAt) tokens.delete(token);
    else entry.expiresAt = now + ttlMs;
  }
}
// ponytail: O(live tokens) per adapter event — map is ~#live sessions; index by
// sessionId if that ever grows.

// ponytail: tiny self-check — the security-relevant branches (expiry, scope, revoke).
export function _demo(): void {
  const tok = issueSpawnToken('conv-1', 'sess-1');
  console.assert(validateSpawnToken(tok, 'conv-1'), 'valid token + matching conv should pass');
  console.assert(!validateSpawnToken(tok, 'conv-2'), 'wrong conversation must fail (scope)');
  console.assert(!validateSpawnToken('nope', 'conv-1'), 'unknown token must fail');
  revokeSpawnTokensForSession('sess-1');
  console.assert(!validateSpawnToken(tok, 'conv-1'), 'revoked token must fail');
  const exp = issueSpawnToken('conv-3', 'sess-3');
  tokens.get(exp)!.expiresAt = Date.now() - 1;
  console.assert(!validateSpawnToken(exp, 'conv-3'), 'expired token must fail');
  const sched = issueSpawnToken('conv-s', 'sess-s', SCHEDULE_CAPABILITIES);
  console.assert(!validateSpawnToken(sched, 'conv-s'), '{schedule} token must fail validateSpawnToken');
  console.assert(peekSpawnToken(sched)?.scope.has('schedule') === true, '{schedule} peek must report schedule');
  console.assert(peekSpawnToken(sched)?.scope.has('spawn') === false, '{schedule} peek must not report spawn');
  console.assert(peekSpawnToken(sched)?.capProfile.id === 'all', 'default mint must bake the all profile');
  const min = issueSpawnToken('conv-m', 'sess-m', 'schedule', { id: 'minimal', plugins: [], usage: false });
  console.assert(peekSpawnToken(min)?.capProfile.plugins?.length === 0, 'minted profile must round-trip');
  revokeSpawnTokensForConversation('conv-m');
  console.assert(peekSpawnToken(min) === undefined, 'revokeSpawnTokensForConversation must kill the token');
  console.assert(peekSpawnToken(sched) !== undefined, 'conversation revoke must not touch other conversations');
  revokeSpawnTokensForSession('sess-s');
  console.log('tokens._demo ok');
}
