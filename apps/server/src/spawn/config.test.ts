import { describe, it, expect } from 'vitest';
import { parseAgentSelfTimersMode } from './config.js';

describe('parseAgentSelfTimersMode', () => {
  it('defaults to level0', () => {
    expect(parseAgentSelfTimersMode(undefined)).toBe('level0');
    expect(parseAgentSelfTimersMode('')).toBe('level0');
  });
  it('accepts the three values case-insensitively', () => {
    expect(parseAgentSelfTimersMode('ALL')).toBe('all');
    expect(parseAgentSelfTimersMode(' off ')).toBe('off');
    expect(parseAgentSelfTimersMode('level0')).toBe('level0');
  });
  it('falls back to level0 on garbage (never widens to all)', () => {
    expect(parseAgentSelfTimersMode('yes')).toBe('level0');
    expect(parseAgentSelfTimersMode('1')).toBe('level0');
  });
});
