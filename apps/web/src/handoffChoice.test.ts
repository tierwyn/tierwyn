import { describe, it, expect } from 'vitest';
import { handoffChoiceOptions, stagedHandoffSkip } from './handoffChoice.js';

const same = { fromAgent: 'claude-code', toAgent: 'claude-code', nativeAvailable: true, handoffMode: 'prompt' as const };

describe('handoffChoiceOptions', () => {
  it('same resumable agent offers all four', () => {
    expect(handoffChoiceOptions(same)).toEqual({ continue: true, fresh: true, summary: true, transcript: true });
    expect(handoffChoiceOptions({ ...same, fromAgent: 'antigravity', toAgent: 'antigravity' }).continue).toBe(true);
    expect(handoffChoiceOptions({ ...same, fromAgent: 'cursor', toAgent: 'cursor' }).continue).toBe(true);
    expect(handoffChoiceOptions({ ...same, fromAgent: 'opencode', toAgent: 'opencode' }).continue).toBe(true);
    expect(handoffChoiceOptions({ ...same, fromAgent: 'pi', toAgent: 'pi' }).continue).toBe(true);
    expect(handoffChoiceOptions({ ...same, fromAgent: 'copilot', toAgent: 'copilot' }).continue).toBe(true);
  });
  it('cross-agent has no continue', () => {
    expect(handoffChoiceOptions({ ...same, toAgent: 'codex' })).toEqual({ continue: false, fresh: true, summary: true, transcript: true });
  });
  it('no native session -> no continue', () => {
    expect(handoffChoiceOptions({ ...same, nativeAvailable: false }).continue).toBe(false);
  });
  it('adapter outside MODEL_SWITCH_RESUME_ADAPTERS -> no continue', () => {
    expect(handoffChoiceOptions({ ...same, fromAgent: 'deepseek', toAgent: 'deepseek' }).continue).toBe(false);
  });
  it('fixed handoffMode narrows summary/transcript', () => {
    expect(handoffChoiceOptions({ ...same, handoffMode: 'summary' })).toMatchObject({ summary: true, transcript: false });
    expect(handoffChoiceOptions({ ...same, handoffMode: 'transcript' })).toMatchObject({ summary: false, transcript: true });
  });
  it('fork never continues and ignores handoffMode', () => {
    expect(handoffChoiceOptions({ ...same, handoffMode: 'summary', fork: true })).toEqual({
      continue: false, fresh: true, summary: true, transcript: true,
    });
  });
});

describe('stagedHandoffSkip', () => {
  it('null staged -> null', () => {
    const opts = handoffChoiceOptions(same);
    expect(stagedHandoffSkip(null, opts)).toBeNull();
    expect(stagedHandoffSkip(undefined, opts)).toBeNull();
  });
  it('fresh always skips', () => {
    const opts = handoffChoiceOptions({ ...same, handoffMode: 'transcript' });
    expect(stagedHandoffSkip('fresh', opts)).toBe('fresh');
  });
  it('summary skips under prompt/summary/fork', () => {
    expect(stagedHandoffSkip('summary', handoffChoiceOptions({ ...same, handoffMode: 'prompt' }))).toBe('summary');
    expect(stagedHandoffSkip('summary', handoffChoiceOptions({ ...same, handoffMode: 'summary' }))).toBe('summary');
    expect(stagedHandoffSkip('summary', handoffChoiceOptions({ ...same, handoffMode: 'transcript', fork: true }))).toBe('summary');
  });
  it('summary + handoffMode:transcript non-fork -> null', () => {
    const opts = handoffChoiceOptions({ ...same, handoffMode: 'transcript', fork: false });
    expect(stagedHandoffSkip('summary', opts)).toBeNull();
  });
});
