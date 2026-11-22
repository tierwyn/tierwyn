import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@tierwyn/shared';
import { pickerEffortLevels } from './effortLevels.js';

function profile(over: Partial<AgentProfile>): AgentProfile {
  return {
    id: 'x', agentType: 'claude-code', model: 'sonnet', label: 'Claude Code · Sonnet',
    description: '', vision: false, steer: true, enabled: true, ...over,
  };
}

describe('pickerEffortLevels', () => {
  it('returns nothing without a profile', () => {
    expect(pickerEffortLevels(undefined)).toEqual([]);
  });

  it('returns the adapter levels for an effort-capable profile', () => {
    expect(pickerEffortLevels(profile({})).length).toBeGreaterThan(0);
  });

  it('returns nothing for an adapter with no effort knob', () => {
    expect(pickerEffortLevels(profile({ agentType: 'grok-bot' }))).toEqual([]);
  });

  it('hides the picker when the model name already bakes the level in', () => {
    expect(pickerEffortLevels(profile({
      agentType: 'antigravity', model: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)',
    }))).toEqual([]);
  });
});
