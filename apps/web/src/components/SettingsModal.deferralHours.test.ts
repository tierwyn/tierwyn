import { describe, it, expect } from 'vitest';
import { decideDeferralHours } from './SettingsModal.js';

// TurnInfoModal.test.ts-style guards: some imported component modules expect a
// document at module scope.
if (typeof globalThis.document === 'undefined') {
  (globalThis as any).document = {
    body: {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

/**
 * [S3-5] "Max deferral (hours)" in SettingsModal used to save per keystroke, so
 * clearing the field computed Number('') * 3_600_000 = 0 and silently disabled
 * deferral. The input now defers to decideDeferralHours on blur: empty text
 * keeps the previously persisted value (saveCompaction is never called) and
 * surfaces a hint, while valid numbers — including partials like "12" typed on
 * the way to "120" — still save.
 */
describe('SettingsModal max deferral hours [S3-5]', () => {
  it('[S3-5] empty hours input never persists 0', () => {
    for (const cleared of ['', ' ', '\t']) {
      const decision = decideDeferralHours(cleared);
      expect(decision.kind).toBe('keep');
      expect(decision).not.toHaveProperty('ms');
      if (decision.kind === 'keep') expect(decision.error).toBeTruthy();
    }
  });

  it('treats non-finite and out-of-range text as keep-with-hint, never a save', () => {
    for (const bad of ['-', 'e', 'abc', '-1', '169', '1e3']) {
      const decision = decideDeferralHours(bad);
      expect(decision.kind).toBe('keep');
      expect(decision).not.toHaveProperty('ms');
    }
  });

  it('null draft (not editing) is a no-op on blur', () => {
    expect(decideDeferralHours(null)).toEqual({ kind: 'idle' });
  });

  it('valid numbers, including partials and explicit zero, still save on blur', () => {
    expect(decideDeferralHours('12')).toEqual({ kind: 'save', ms: 12 * 3_600_000 });
    expect(decideDeferralHours(' 8 ')).toEqual({ kind: 'save', ms: 8 * 3_600_000 });
    expect(decideDeferralHours('0')).toEqual({ kind: 'save', ms: 0 });
    expect(decideDeferralHours('168')).toEqual({ kind: 'save', ms: 168 * 3_600_000 });
  });
});
