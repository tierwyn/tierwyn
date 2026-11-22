import { describe, expect, it } from 'vitest';
import { terminalAppliesToTrackedSession, sessionEndedApplies } from './liveSession.js';

describe('terminalAppliesToTrackedSession', () => {
  it('applies when the client has no current session', () => {
    expect(terminalAppliesToTrackedSession(null, 's-old')).toBe(true);
  });

  it('applies when the frame has no session id (conversation_updated)', () => {
    expect(terminalAppliesToTrackedSession('s-live', undefined)).toBe(true);
  });

  it('applies when the ended session is the one being tracked', () => {
    expect(terminalAppliesToTrackedSession('s-live', 's-live')).toBe(true);
  });

  it('ignores a late session_ended from a different session', () => {
    expect(terminalAppliesToTrackedSession('s-live', 's-reaped')).toBe(false);
  });
});

describe('sessionEndedApplies', () => {
  it('always applies to non-subscribed background conversations regardless of active tab session', () => {
    expect(sessionEndedApplies('conv-active', 'conv-bg', 's-active', 's-bg')).toBe(true);
  });

  it('checks tracked session for the currently subscribed conversation', () => {
    expect(sessionEndedApplies('conv-active', 'conv-active', 's-active', 's-active')).toBe(true);
    expect(sessionEndedApplies('conv-active', 'conv-active', 's-active', 's-reaped')).toBe(false);
  });

  it('applies when no conversation is subscribed', () => {
    expect(sessionEndedApplies(null, 'conv-any', null, 's-any')).toBe(true);
    expect(sessionEndedApplies(null, 'conv-any', 's-active', 's-any')).toBe(true);
  });
});

