import { describe, it, expect } from 'vitest';
import { QUOTA_SHAPE, matchesQuotaShape } from './usageLimits.js';

describe('QUOTA_SHAPE / matchesQuotaShape', () => {
  it('matches provider usage-limit language across adapters', () => {
    for (const text of [
      'You have hit your usage limit.',
      'rate limit exceeded',
      'Hit your session limit',
      'too many requests, slow down',
      'HTTP 529 overloaded',
    ]) {
      expect(matchesQuotaShape(text), text).toBe(true);
      expect(QUOTA_SHAPE.test(text), text).toBe(true);
    }
  });

  it('does not match benign interrupts', () => {
    expect(matchesQuotaShape('Request interrupted by user')).toBe(false);
    expect(matchesQuotaShape('exited with code 130')).toBe(false);
  });
});
