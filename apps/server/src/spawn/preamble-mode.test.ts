import { describe, it, expect } from 'vitest';
import {
  STUB_MAX_AGE_MS,
  MAX_CONSECUTIVE_STUBS,
  makeFingerprint,
  encodeFp,
  decodeFp,
  choosePreambleMode,
} from './preamble-mode.js';

describe('makeFingerprint / encodeFp / decodeFp', () => {
  it('decodeFp(encodeFp(x, t, n)) round-trips', () => {
    const base = makeFingerprint('spawn', { t: 'team', r: [['a', 'b', 'c']] });
    const encoded = encodeFp(base, 1_700_000_000_000, 7);
    expect(decodeFp(encoded)).toEqual({
      base,
      lastFullTs: 1_700_000_000_000,
      stubCount: 7,
    });
  });

  it('decodeFp returns undefined for missing, empty, or malformed fps', () => {
    expect(decodeFp(undefined)).toBeUndefined();
    expect(decodeFp('')).toBeUndefined();
    expect(decodeFp('spawn:abc')).toBeUndefined();
    expect(decodeFp('spawn:abc:123')).toBeUndefined();
  });
});

describe('choosePreambleMode', () => {
  const want = makeFingerprint('spawn', { v: 1 });
  const t0 = 1_000_000;
  const now = t0 + 60_000;

  it('no prev ⇒ full (rows 1, 9, 10)', () => {
    const r = choosePreambleMode({ want, prev: undefined, resumeMode: 'fresh', now });
    expect(r.mode).toBe('full');
    expect(r.nextFp).toBe(encodeFp(want, now, 0));
  });

  it.each(['compacted', 'transcript', 'fresh'] as const)(
    "resumeMode '%s' with matching prev ⇒ full (rows 7, 8)",
    (resumeMode) => {
      const prev = encodeFp(want, t0, 3);
      const r = choosePreambleMode({ want, prev, resumeMode, now });
      expect(r.mode).toBe('full');
      expect(r.nextFp).toBe(encodeFp(want, now, 0));
    },
  );

  it('native + identical base ⇒ stub, same lastFullTs, stubCount+1 (rows 2, 6, 9b)', () => {
    const prev = encodeFp(want, t0, 3);
    const r = choosePreambleMode({ want, prev, resumeMode: 'native', now });
    expect(r.mode).toBe('stub');
    expect(r.nextFp).toBe(encodeFp(want, t0, 4));
  });

  it('native + different hash ⇒ full, count 0, new ts (row 3)', () => {
    const other = makeFingerprint('spawn', { v: 2 });
    const prev = encodeFp(other, t0, 5);
    const r = choosePreambleMode({ want, prev, resumeMode: 'native', now });
    expect(r.mode).toBe('full');
    expect(r.nextFp).toBe(encodeFp(want, now, 0));
  });

  it('native + schedule prev vs spawn want ⇒ full (row 4)', () => {
    const prev = encodeFp(makeFingerprint('schedule', { v: 1 }), t0, 2);
    const r = choosePreambleMode({ want, prev, resumeMode: 'native', now });
    expect(r.mode).toBe('full');
    expect(r.nextFp).toBe(encodeFp(want, now, 0));
  });

  it('native + spawn prev vs schedule want ⇒ full (row 5)', () => {
    const scheduleWant = makeFingerprint('schedule', { v: 1 });
    const prev = encodeFp(want, t0, 2);
    const r = choosePreambleMode({ want: scheduleWant, prev, resumeMode: 'native', now });
    expect(r.mode).toBe('full');
    expect(r.nextFp).toBe(encodeFp(scheduleWant, now, 0));
  });

  it('native + match but last full older than STUB_MAX_AGE_MS ⇒ full (row 12a)', () => {
    const prev = encodeFp(want, t0, 1);
    const r = choosePreambleMode({
      want, prev, resumeMode: 'native', now: t0 + STUB_MAX_AGE_MS + 1,
    });
    expect(r.mode).toBe('full');
    expect(r.nextFp).toBe(encodeFp(want, t0 + STUB_MAX_AGE_MS + 1, 0));
  });

  it('native + match but stubCount >= MAX_CONSECUTIVE_STUBS ⇒ full (row 12b)', () => {
    const prev = encodeFp(want, t0, MAX_CONSECUTIVE_STUBS);
    const r = choosePreambleMode({ want, prev, resumeMode: 'native', now });
    expect(r.mode).toBe('full');
    expect(r.nextFp).toBe(encodeFp(want, now, 0));
  });

  it('native + match with stubCount just under the cap ⇒ stub', () => {
    const prev = encodeFp(want, t0, MAX_CONSECUTIVE_STUBS - 1);
    const r = choosePreambleMode({ want, prev, resumeMode: 'native', now });
    expect(r.mode).toBe('stub');
    expect(r.nextFp).toBe(encodeFp(want, t0, MAX_CONSECUTIVE_STUBS));
  });

  it('malformed / undefined fp ⇒ full', () => {
    expect(choosePreambleMode({ want, prev: 'spawn:deadbeef', resumeMode: 'native', now }).mode).toBe('full');
    expect(choosePreambleMode({ want, prev: undefined, resumeMode: 'native', now }).mode).toBe('full');
  });
});
