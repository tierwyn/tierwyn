import { describe, it, expect } from 'vitest';
import { formatElapsedMs, formatHms } from './elapsed.js';

describe('formatElapsedMs', () => {
  it('floors sub-second values to 0s', () => {
    expect(formatElapsedMs(0)).toBe('0s');
    expect(formatElapsedMs(999)).toBe('0s');
  });

  it('formats whole seconds under a minute', () => {
    expect(formatElapsedMs(12_000)).toBe('12s');
  });

  it('formats minutes and seconds', () => {
    expect(formatElapsedMs(74_000)).toBe('1m 14s');
  });

  it('formats hours with zero-padded minutes and no seconds', () => {
    expect(formatElapsedMs(3_724_000)).toBe('1h 02m');
  });

  it('guards non-finite and negative values as 0s', () => {
    expect(formatElapsedMs(Number.NaN)).toBe('0s');
    expect(formatElapsedMs(Number.POSITIVE_INFINITY)).toBe('0s');
    expect(formatElapsedMs(-1)).toBe('0s');
  });

  it('hits the minute and hour boundaries', () => {
    expect(formatElapsedMs(60_000)).toBe('1m 0s');
    expect(formatElapsedMs(3_600_000)).toBe('1h 00m');
  });
});

describe('formatHms', () => {
  it('floors sub-second values to 0:00:00', () => {
    expect(formatHms(0)).toBe('0:00:00');
    expect(formatHms(999)).toBe('0:00:00');
  });

  it('formats whole seconds under a minute', () => {
    expect(formatHms(59_000)).toBe('0:00:59');
    expect(formatHms(59_999)).toBe('0:00:59');
  });

  it('hits the 59s → 60s boundary', () => {
    expect(formatHms(60_000)).toBe('0:01:00');
  });

  it('formats just under an hour', () => {
    expect(formatHms(3_599_000)).toBe('0:59:59');
    expect(formatHms(3_599_999)).toBe('0:59:59');
  });

  it('hits the 59m59s → 1h boundary', () => {
    expect(formatHms(3_600_000)).toBe('1:00:00');
  });

  it('formats mixed hours, minutes and seconds', () => {
    expect(formatHms(4_927_000)).toBe('1:22:07');
  });

  it('keeps two-digit hours unpadded', () => {
    expect(formatHms(47_100_000)).toBe('13:05:00');
  });

  it('guards non-finite and negative values as 0:00:00', () => {
    expect(formatHms(-5000)).toBe('0:00:00');
    expect(formatHms(Number.NaN)).toBe('0:00:00');
    expect(formatHms(Number.POSITIVE_INFINITY)).toBe('0:00:00');
  });
});
