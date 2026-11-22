import { describe, it, expect } from 'vitest';
import {
  shouldKickContextEnhance, type PendingContextEnhance,
  cycleSlowChoice, enabledSlowChoices, initialSlowChoice, parseSlowEnhanceChoice,
  serialiseSlowEnhanceChoice, slowEnhanceToggleOpts,
} from './dictationEnhance.js';

const pending: PendingContextEnhance = { conversationId: 'c1', baselineText: 'hello' };

describe('shouldKickContextEnhance', () => {
  it('returns true on transcribing→idle with armed pending and changed text', () => {
    expect(shouldKickContextEnhance({
      pending,
      prev: 'transcribing',
      next: 'idle',
      conversationId: 'c1',
      text: 'hello world',
    })).toBe(true);
  });

  it('returns false when pending is null', () => {
    expect(shouldKickContextEnhance({
      pending: null,
      prev: 'transcribing',
      next: 'idle',
      conversationId: 'c1',
      text: 'hello world',
    })).toBe(false);
  });

  it('returns false when pending conversation does not match (browsed away)', () => {
    expect(shouldKickContextEnhance({
      pending,
      prev: 'transcribing',
      next: 'idle',
      conversationId: 'c2',
      text: 'hello world',
    })).toBe(false);
  });

  it('returns true on idle→idle when pending and text changed (missed freeze frame)', () => {
    // Local upload still shows the processing strip; remoteProcessing can stay
    // idle if the transcribing freeze never landed. The settle must still kick.
    expect(shouldKickContextEnhance({
      pending,
      prev: 'idle',
      next: 'idle',
      conversationId: 'c1',
      text: 'hello world',
    })).toBe(true);
  });

  it('returns false on enhancing→idle', () => {
    expect(shouldKickContextEnhance({
      pending,
      prev: 'enhancing',
      next: 'idle',
      conversationId: 'c1',
      text: 'hello world',
    })).toBe(false);
  });

  it('returns false when settled text is unchanged from baseline (silent clip)', () => {
    expect(shouldKickContextEnhance({
      pending,
      prev: 'transcribing',
      next: 'idle',
      conversationId: 'c1',
      text: 'hello',
    })).toBe(false);
  });

  it('returns false when settled text is empty (auto-sent / cleared draft)', () => {
    expect(shouldKickContextEnhance({
      pending,
      prev: 'transcribing',
      next: 'idle',
      conversationId: 'c1',
      text: '',
    })).toBe(false);
  });
});

describe('Slow enhance choice (tri-state tierwyn.voice.slowEnhanceContext)', () => {
  it('parses legacy boolean and new project values', () => {
    expect(parseSlowEnhanceChoice(null)).toBe('cleanup');
    expect(parseSlowEnhanceChoice('false')).toBe('cleanup');
    expect(parseSlowEnhanceChoice('junk')).toBe('cleanup');
    expect(parseSlowEnhanceChoice('true')).toBe('context');
    expect(parseSlowEnhanceChoice('project')).toBe('project');
  });

  it('serialises back to the same key values', () => {
    for (const c of ['cleanup', 'context', 'project'] as const) {
      expect(parseSlowEnhanceChoice(serialiseSlowEnhanceChoice(c))).toBe(c);
    }
    expect(serialiseSlowEnhanceChoice('context')).toBe('true');
    expect(serialiseSlowEnhanceChoice('cleanup')).toBe('false');
  });

  it('maps a choice to exactly one transcribe flag', () => {
    expect(slowEnhanceToggleOpts('cleanup')).toEqual({ skipCleanup: false });
    expect(slowEnhanceToggleOpts('context')).toEqual({ skipCleanup: true, enhanceContext: true });
    expect(slowEnhanceToggleOpts('project')).toEqual({ skipCleanup: true, enhanceProject: true });
  });

  it('lists enabled choices in order; cleanup always present', () => {
    expect(enabledSlowChoices({ contextAvailable: true, projectAvailable: true })).toEqual(['project', 'context', 'cleanup']);
    expect(enabledSlowChoices({ contextAvailable: true, projectAvailable: false })).toEqual(['context', 'cleanup']);
    expect(enabledSlowChoices({ contextAvailable: false, projectAvailable: false })).toEqual(['cleanup']);
  });

  it('initial choice falls back to cleanup when the remembered row is disabled', () => {
    expect(initialSlowChoice('project', ['project', 'context', 'cleanup'])).toBe('project');
    expect(initialSlowChoice('project', ['context', 'cleanup'])).toBe('cleanup');
  });

  it('cycles through enabled choices and wraps both ways', () => {
    const all = ['project', 'context', 'cleanup'] as const;
    expect(cycleSlowChoice('project', 1, [...all])).toBe('context');
    expect(cycleSlowChoice('cleanup', 1, [...all])).toBe('project');
    expect(cycleSlowChoice('project', -1, [...all])).toBe('cleanup');
    expect(cycleSlowChoice('project', 1, ['project', 'cleanup'])).toBe('cleanup');
    expect(cycleSlowChoice('cleanup', 1, ['cleanup'])).toBe('cleanup');
  });
});
