import { describe, it, expect } from 'vitest';
import { estimateTokens } from './tokenizer.js';

describe('estimateTokens', () => {
  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });
  it('encodes short ASCII correctly with cl100k_base', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    // 4000 repeated 'a' chars: cl100k_base compresses runs, well below chars/4 value of 1000
    const n = estimateTokens('a'.repeat(4000));
    expect(n).toBeGreaterThanOrEqual(400);
    expect(n).toBeLessThan(800); // not the old chars/4 value of 1000
  });
});

describe('estimateTokens (cl100k_base default)', () => {
  it('counts real tokens, not just chars/4, for normal prose', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    const n = estimateTokens(text);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(text.length); // tokens < chars
  });

  it('uses an injected estimator when provided', () => {
    const n = estimateTokens('whatever', (t) => t.length * 2);
    expect(n).toBe(16);
  });

  it('returns 0 for empty input', () => {
    expect(estimateTokens('')).toBe(0);
  });
});
