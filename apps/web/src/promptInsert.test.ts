import { describe, it, expect } from 'vitest';
import { composeInsert } from './promptInsert.js';

describe('composeInsert', () => {
  it('returns the body verbatim when the draft is empty', () => {
    expect(composeInsert('', 'Review this diff.')).toBe('Review this diff.');
  });

  it('joins a non-empty draft and body with a blank line', () => {
    expect(composeInsert('hello', 'world')).toBe('hello\n\nworld');
  });

  it('collapses trailing whitespace/newlines on the draft to one blank line', () => {
    expect(composeInsert('hello  \n\n', 'world')).toBe('hello\n\nworld');
    expect(composeInsert('hello\n', 'world')).toBe('hello\n\nworld');
    expect(composeInsert('hello\t  ', 'world')).toBe('hello\n\nworld');
  });

  it('treats a whitespace-only draft as empty', () => {
    expect(composeInsert('   \n\t', 'body')).toBe('body');
  });
});
