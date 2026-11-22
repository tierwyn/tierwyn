import { describe, it, expect } from 'vitest';
import { applyRecovery } from './statusRecovery.js';

describe('applyRecovery', () => {
  it('marks a conversation recovered on non-error activity', () => {
    expect(applyRecovery(new Set(), 'c1', 'running').has('c1')).toBe(true);
    expect(applyRecovery(new Set(), 'c1', 'done').has('c1')).toBe(true);
    expect(applyRecovery(new Set(), 'c1', 'idle').has('c1')).toBe(true);
    expect(applyRecovery(new Set(), 'c1', 'waiting').has('c1')).toBe(true);
    expect(applyRecovery(new Set(), 'c1', 'activity').has('c1')).toBe(true);
  });

  it('a new error un-recovers the conversation so red can return', () => {
    const recovered = applyRecovery(new Set(), 'c1', 'done');
    expect(applyRecovery(recovered, 'c1', 'error').has('c1')).toBe(false);
  });

  it('returns the same set instance when nothing changes (render stability)', () => {
    const recovered = applyRecovery(new Set(), 'c1', 'running');
    expect(applyRecovery(recovered, 'c1', 'running')).toBe(recovered);
    const empty: ReadonlySet<string> = new Set();
    expect(applyRecovery(empty, 'c1', 'error')).toBe(empty);
  });

  it('tracks conversations independently', () => {
    let s = applyRecovery(new Set(), 'c1', 'done');
    s = applyRecovery(s, 'c2', 'error');
    expect(s.has('c1')).toBe(true);
    expect(s.has('c2')).toBe(false);
  });
});
