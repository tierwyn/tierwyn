import { describe, it, expect } from 'vitest';
import {
  formatIsoLocalInTimezone,
  parseIsoLocalInTimezone,
  isValidTimezone,
} from './timezone.js';

describe('formatIsoLocalInTimezone', () => {
  it('formats in Europe/London (GMT, winter)', () => {
    // 2026-01-15 09:00 London = 09:00 UTC (GMT)
    const ms = Date.UTC(2026, 0, 15, 9, 0);
    expect(formatIsoLocalInTimezone(ms, 'Europe/London')).toBe('2026-01-15T09:00');
  });

  it('formats in America/New_York (EST, winter)', () => {
    // 2026-01-15 14:00 UTC = 09:00 EST
    const ms = Date.UTC(2026, 0, 15, 14, 0);
    expect(formatIsoLocalInTimezone(ms, 'America/New_York')).toBe('2026-01-15T09:00');
  });
});

describe('parseIsoLocalInTimezone', () => {
  it('round-trips with formatIsoLocalInTimezone', () => {
    const value = '2026-07-25T09:00';
    const ms = parseIsoLocalInTimezone(value, 'Europe/London');
    expect(Number.isFinite(ms)).toBe(true);
    expect(formatIsoLocalInTimezone(ms, 'Europe/London')).toBe(value);
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA zones', () => {
    expect(isValidTimezone('Europe/London')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidTimezone('Not/A/Zone')).toBe(false);
    expect(isValidTimezone('')).toBe(false);
  });
});
