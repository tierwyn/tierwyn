import { describe, it, expect } from 'vitest';
import { kokoroVoiceLabel, normalizeKokoroVoices } from './kokoroVoices.js';

describe('normalizeKokoroVoices', () => {
  it('parses { voices: [{ id, name }] }', () => {
    const v = normalizeKokoroVoices({
      voices: [
        { id: 'am_adam', name: 'am_adam' },
        { id: 'af_heart', name: 'af_heart' },
      ],
    });
    expect(v.map((x) => x.id)).toEqual(['af_heart', 'am_adam']);
  });

  it('parses bare string arrays', () => {
    const v = normalizeKokoroVoices(['bf_emma', 'af_bella']);
    expect(v.map((x) => x.id)).toEqual(['af_bella', 'bf_emma']);
  });

  it('returns empty for garbage', () => {
    expect(normalizeKokoroVoices(null)).toEqual([]);
    expect(normalizeKokoroVoices({})).toEqual([]);
  });
});

describe('kokoroVoiceLabel', () => {
  it('annotates known prefixes', () => {
    expect(kokoroVoiceLabel('af_heart')).toContain('American');
    expect(kokoroVoiceLabel('bm_george')).toContain('British');
  });

  it('falls back to id', () => {
    expect(kokoroVoiceLabel('xx_unknown')).toBe('xx_unknown');
  });
});
