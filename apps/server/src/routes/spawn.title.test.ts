import { describe, it, expect } from 'vitest';
import { spawnChildTitle } from './spawn.js';

describe('spawnChildTitle', () => {
  it('is the role only — no prompt first line', () => {
    expect(spawnChildTitle('Implementer')).toBe('↳ Implementer');
  });

  it('passes a 200-char role through unmodified (no truncation)', () => {
    const role = 'R'.repeat(200);
    expect(spawnChildTitle(role)).toBe(`↳ ${role}`);
  });
});
