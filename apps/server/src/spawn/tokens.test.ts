import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  issueSpawnToken,
  validateSpawnToken,
  validateMessageToken,
  peekSpawnToken,
  touchSpawnToken,
  touchSpawnTokensForSession,
  getLiveTokenForConversation,
  revokeSpawnTokensForSession,
  revokeSpawnTokensForConversation,
  DEFAULT_RESOLVED_PROFILE,
  SCHEDULE_CAPABILITIES,
  CONVERSATION_CAPABILITIES,
  SPAWN_TOKEN_TTL_MS,
  setSpawnTokenTtlMs,
  getSpawnTokenTtlMs,
  type TokenCapability,
} from './tokens.js';

describe('spawn token scope', () => {
  it('rejects schedule-scoped token at validateSpawnToken (no spawn escalation)', () => {
    const t = issueSpawnToken('conv-1', 'sess-1', 'schedule');
    expect(validateSpawnToken(t, 'conv-1')).toBe(false); // ← the security line
  });

  it('accepts spawn-scoped token at validateSpawnToken (unchanged)', () => {
    const t = issueSpawnToken('conv-1', 'sess-1', 'spawn');
    expect(validateSpawnToken(t, 'conv-1')).toBe(true);
  });

  it('string spawn mint is {spawn, schedule, plugin}; string schedule mint is {schedule}', () => {
    const s = issueSpawnToken('conv-1', 'sess-1', 'schedule');
    const p = issueSpawnToken('conv-2', 'sess-2', 'spawn');
    expect(peekSpawnToken(s)?.scope).toEqual(new Set(['schedule']));
    expect(peekSpawnToken(p)?.scope).toEqual(new Set(['spawn', 'schedule', 'plugin']));
  });

  it('{schedule} set fails validateSpawnToken', () => {
    const t = issueSpawnToken('conv-1', 'sess-1', SCHEDULE_CAPABILITIES);
    expect(validateSpawnToken(t, 'conv-1')).toBe(false);
    expect(peekSpawnToken(t)?.scope.has('schedule')).toBe(true);
  });

  it('{plugin} set fails validateSpawnToken (plugin ↛ spawn)', () => {
    const t = issueSpawnToken('conv-1', 'sess-1', new Set<TokenCapability>(['plugin']));
    expect(validateSpawnToken(t, 'conv-1')).toBe(false);
    expect(peekSpawnToken(t)?.scope.has('plugin')).toBe(true);
    expect(peekSpawnToken(t)?.scope.has('spawn')).toBe(false);
  });

  it('CONVERSATION_CAPABILITIES is {schedule, plugin} — plugin yes, spawn/message no', () => {
    expect([...CONVERSATION_CAPABILITIES].sort()).toEqual(['plugin', 'schedule']);
    const t = issueSpawnToken('conv-1', 'sess-1', CONVERSATION_CAPABILITIES);
    expect(validateSpawnToken(t, 'conv-1')).toBe(false); // no spawn escalation
    expect(validateMessageToken(t, 'conv-1')).toBe(false); // no downward/mesh send
    expect(peekSpawnToken(t)?.scope.has('plugin')).toBe(true); // but plugins work
  });

  it('peekSpawnToken returns a copy — mutating it cannot escalate the stored token', () => {
    const t = issueSpawnToken('conv-1', 'sess-1', 'schedule');
    const peeked = peekSpawnToken(t)!;
    (peeked.scope as Set<TokenCapability>).add('spawn');
    expect(validateSpawnToken(t, 'conv-1')).toBe(false);
    expect(peekSpawnToken(t)!.scope.has('spawn')).toBe(false);
  });

  it('does not mint mesh on either historical shorthand', () => {
    const spawn = peekSpawnToken(issueSpawnToken('c1', 's1', 'spawn'))!.scope;
    const schedule = peekSpawnToken(issueSpawnToken('c2', 's2', 'schedule'))!.scope;
    expect(spawn.has('mesh')).toBe(false);
    expect(schedule.has('mesh')).toBe(false);
  });

  it('revokeSpawnTokensForSession revokes both scopes', () => {
    const s = issueSpawnToken('conv-1', 'sess-1', 'schedule');
    const p = issueSpawnToken('conv-2', 'sess-1', 'spawn');
    revokeSpawnTokensForSession('sess-1');
    expect(peekSpawnToken(s)).toBeUndefined();
    expect(peekSpawnToken(p)).toBeUndefined();
  });

  it('slides expiration forward on validateSpawnToken and touchSpawnToken', () => {
    const t = issueSpawnToken('conv-slide', 'sess-slide', 'spawn');
    const before = peekSpawnToken(t)!;
    expect(touchSpawnToken(t)).toBe(true);
    const after = peekSpawnToken(t)!;
    expect(after.expiresAt).toBeGreaterThanOrEqual(before.expiresAt);

    expect(validateSpawnToken(t, 'conv-slide')).toBe(true);
  });

  it('getLiveTokenForConversation returns live token and ignores expired ones', () => {
    const t = issueSpawnToken('conv-live', 'sess-live', 'spawn');
    const live = getLiveTokenForConversation('conv-live');
    expect(live).toBeDefined();
    expect(live?.token).toBe(t);

    expect(getLiveTokenForConversation('nonexistent')).toBeUndefined();
  });
});

describe('touchSpawnTokensForSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('slides every live token of that session, leaves other sessions alone, and deletes expired ones', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    vi.setSystemTime(t0);

    const expired = issueSpawnToken('conv-a', 'sess-a', 'schedule');
    vi.setSystemTime(t0 + SPAWN_TOKEN_TTL_MS + 60_000);
    const keep = issueSpawnToken('conv-a', 'sess-a', 'spawn');
    const other = issueSpawnToken('conv-b', 'sess-b', 'spawn');
    const keepBefore = peekSpawnToken(keep)!.expiresAt;
    const otherBefore = peekSpawnToken(other)!.expiresAt;
    vi.advanceTimersByTime(1_000);

    touchSpawnTokensForSession('sess-a');

    expect(peekSpawnToken(expired)).toBeUndefined();
    const keepAfter = peekSpawnToken(keep)!;
    expect(keepAfter.expiresAt).toBeGreaterThan(keepBefore);
    expect(keepAfter.expiresAt).toBe(Date.now() + SPAWN_TOKEN_TTL_MS);
    expect(peekSpawnToken(other)!.expiresAt).toBe(otherBefore);
  });
});

describe('capability profile on tokens', () => {
  const minimal = { id: 'minimal', plugins: [] as string[], usage: false };

  it('defaults to the all profile when omitted', () => {
    expect(DEFAULT_RESOLVED_PROFILE).toEqual({ id: 'all', plugins: '*', usage: true });
    const t = issueSpawnToken('conv-default', 'sess-default');
    expect(peekSpawnToken(t)!.capProfile).toEqual({ id: 'all', plugins: '*', usage: true });
  });

  it('bakes the mint-time profile in and hands out defensive copies', () => {
    const t = issueSpawnToken('conv-cp', 'sess-cp', 'spawn', minimal);
    const first = peekSpawnToken(t)!.capProfile!;
    expect(first).toEqual(minimal);
    // Mutating the returned snapshot must not corrupt the stored entry.
    first.plugins.push('gemini-image');
    first.usage = true;
    expect(peekSpawnToken(t)!.capProfile).toEqual(minimal);
    expect(getLiveTokenForConversation('conv-cp')!.capProfile).toEqual(minimal);
  });

  it('revokeSpawnTokensForConversation kills only that conversation\u2019s tokens', () => {
    const a = issueSpawnToken('conv-ra', 'sess-ra', 'spawn', minimal);
    const b = issueSpawnToken('conv-rb', 'sess-rb', 'spawn', minimal);
    revokeSpawnTokensForConversation('conv-ra');
    expect(peekSpawnToken(a)).toBeUndefined();
    expect(peekSpawnToken(b)).toBeDefined();
    expect(peekSpawnToken(b)!.capProfile).toEqual(minimal);
  });
});

describe('configurable spawn token TTL', () => {
  afterEach(() => {
    setSpawnTokenTtlMs(SPAWN_TOKEN_TTL_MS);
  });

  it('changes the expiry of a newly issued spawn token', () => {
    const t0 = Date.now();
    setSpawnTokenTtlMs(10 * 60_000);
    expect(getSpawnTokenTtlMs()).toBe(10 * 60_000);

    const token = issueSpawnToken('conv-ttl', 'sess-ttl');
    const entry = peekSpawnToken(token);
    expect(entry).toBeDefined();
    expect(entry!.expiresAt).toBeGreaterThanOrEqual(t0 + 10 * 60_000);
    expect(entry!.expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60_000);
  });
});
