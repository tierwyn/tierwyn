import { describe, it, expect } from 'vitest';
import { safeNativeSessionId, validateSessionId, safePersistedNativeSessionId } from './sessionId.js';

describe('safeNativeSessionId', () => {
  it('accepts UUID, ses_abc, grok-sess-1', () => {
    expect(safeNativeSessionId('550e8400-e29b-41d4-a716-446655440000')).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(safeNativeSessionId('ses_abc')).toBe('ses_abc');
    expect(safeNativeSessionId('grok-sess-1')).toBe('grok-sess-1');
  });

  it('rejects paths, flags, empty, and overlong ids', () => {
    expect(safeNativeSessionId('/proc/self/environ')).toBeUndefined();
    expect(safeNativeSessionId('--help')).toBeUndefined();
    expect(safeNativeSessionId('../x')).toBeUndefined();
    expect(safeNativeSessionId('a/b')).toBeUndefined();
    expect(safeNativeSessionId('')).toBeUndefined();
    expect(safeNativeSessionId('x'.repeat(201))).toBeUndefined();
    expect(safeNativeSessionId(1)).toBeUndefined();
  });

  it('validateSessionId returns null for rejects', () => {
    expect(validateSessionId('chat_old')).toBe('chat_old');
    expect(validateSessionId('/proc/self/environ')).toBeNull();
  });
});

describe('safePersistedNativeSessionId', () => {
  it('allows a Pi session file under home and rejects /proc', () => {
    expect(safePersistedNativeSessionId('/home/u/.pi/sessions/abc.json')).toBe('/home/u/.pi/sessions/abc.json');
    expect(safePersistedNativeSessionId('/proc/self/environ')).toBeUndefined();
    expect(safePersistedNativeSessionId('/etc/tierwyn/prod.env')).toBeUndefined();
  });
});
