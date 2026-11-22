import { describe, it, expect } from 'vitest';
import { mediaErrorMessage } from './mediaErrorMessage.js';

describe('mediaErrorMessage', () => {
  it('maps MediaError codes to actionable messages', () => {
    expect(mediaErrorMessage(1)).toMatch(/aborted/i);
    expect(mediaErrorMessage(2)).toMatch(/network/i);
    expect(mediaErrorMessage(3)).toMatch(/decode/i);
    expect(mediaErrorMessage(4)).toMatch(/format/i);
  });

  it('falls back to a generic message for unknown or missing codes', () => {
    expect(mediaErrorMessage(undefined)).toMatch(/couldn'?t( be)? play/i);
    expect(mediaErrorMessage(0)).toMatch(/couldn'?t( be)? play/i);
    expect(mediaErrorMessage(99)).toMatch(/couldn'?t( be)? play/i);
  });
});
