import { describe, it, expect } from 'vitest';
import { formatMemoryId, parseMemoryId, MEMORY_LIMITS } from './memory.js';

describe('formatMemoryId / parseMemoryId', () => {
  it('round-trips positive integers', () => {
    expect(formatMemoryId(1)).toBe('m_1');
    expect(formatMemoryId(41)).toBe('m_41');
    expect(parseMemoryId('m_1')).toBe(1);
    expect(parseMemoryId('m_41')).toBe(41);
  });

  it('parseMemoryId rejects m_0, m_01, m_1x, 1', () => {
    expect(parseMemoryId('m_0')).toBeNull();
    expect(parseMemoryId('m_01')).toBeNull();
    expect(parseMemoryId('m_1x')).toBeNull();
    expect(parseMemoryId('1')).toBeNull();
    expect(parseMemoryId('m_')).toBeNull();
    expect(parseMemoryId('M_1')).toBeNull();
  });
});

describe('MEMORY_LIMITS', () => {
  it('locks the spec caps', () => {
    expect(MEMORY_LIMITS).toEqual({
      text: 500,
      ruleReason: 200,
      savesPerHour: 20,
      pendingSuggestionsPerProject: 5,
    });
  });
});
