import { describe, expect, it } from 'vitest';
import { AbcPianoKeyboard } from './AbcPianoKeyboard.js';

describe('AbcPianoKeyboard', () => {
  it('exports component function', () => {
    expect(typeof AbcPianoKeyboard).toBe('function');
  });
});
