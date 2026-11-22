import { describe, it, expect } from 'vitest';
import {
  liveAgentStatusFromSession,
  liveAgentStatusForSession,
  hasOtherInFlightSession,
  resolveSteerTargetSessionId,
} from './liveStatus.js';

describe('liveAgentStatusFromSession', () => {
  it('returns running when lastStatus is absent', () => {
    expect(liveAgentStatusFromSession(undefined)).toBe('running');
  });

  it('returns running and waiting as-is', () => {
    expect(liveAgentStatusFromSession('running')).toBe('running');
    expect(liveAgentStatusFromSession('waiting')).toBe('waiting');
  });

  it('returns error for in-flight error', () => {
    expect(liveAgentStatusFromSession('error')).toBe('error');
  });

  it('returns undefined for parked terminal states', () => {
    expect(liveAgentStatusFromSession('done')).toBeUndefined();
    expect(liveAgentStatusFromSession('idle')).toBeUndefined();
  });
});

describe('liveAgentStatusForSession', () => {
  it('returns undefined when no session', () => {
    expect(liveAgentStatusForSession(undefined)).toBeUndefined();
  });
});

describe('hasOtherInFlightSession', () => {
  const sessions = [
    { id: 'a', conversationId: 'c1', lastStatus: 'running' as const },
    { id: 'b', conversationId: 'c1', lastStatus: 'done' as const },
    { id: 'c', conversationId: 'c2', lastStatus: 'running' as const },
  ];

  it('is true when another non-terminal session shares the conversation', () => {
    expect(hasOtherInFlightSession(sessions, 'c1', 'b')).toBe(true);
  });

  it('is false when the only other session is parked', () => {
    expect(hasOtherInFlightSession(sessions, 'c1', 'a')).toBe(false);
  });

  it('is false for a different conversation', () => {
    expect(hasOtherInFlightSession(sessions, 'c2', 'c')).toBe(false);
  });
});

describe('resolveSteerTargetSessionId', () => {
  const live = { id: 's-live' };
  const getSession = (id: string) => (id === 's-live' ? live : undefined);
  const inFlight = (cid: string) => (cid === 'c1' ? live : undefined);

  it('keeps a valid requested session id', () => {
    expect(resolveSteerTargetSessionId('s-live', 'c1', getSession, inFlight)).toBe('s-live');
  });

  it('falls back to the in-flight session when the requested id is missing', () => {
    expect(resolveSteerTargetSessionId('', 'c1', getSession, inFlight)).toBe('s-live');
    expect(resolveSteerTargetSessionId('s-stale', 'c1', getSession, inFlight)).toBe('s-live');
  });

  it('returns the requested id when nothing is in flight', () => {
    expect(resolveSteerTargetSessionId('s-gone', 'c-other', getSession, inFlight)).toBe('s-gone');
  });
});
