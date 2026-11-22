import { describe, expect, it } from 'vitest';
import { shouldShowPendingShimmer } from './pendingShimmer.js';

describe('shouldShowPendingShimmer', () => {
  const runningEmptyLast = {
    isLastTurn: true,
    agentStatus: 'running',
    hasStreamedContent: false,
  };

  it('shows when the last turn is the live session and still empty', () => {
    expect(shouldShowPendingShimmer({
      ...runningEmptyLast,
      turnSessionId: 'live',
      liveSessionId: 'live',
    })).toBe(true);
  });

  it('hides when conversation is running on a different session than the last turn', () => {
    // Ghost subagent_notify last turn + steer into older live session.
    expect(shouldShowPendingShimmer({
      ...runningEmptyLast,
      turnSessionId: 'notify-ghost',
      liveSessionId: 'older-live',
    })).toBe(false);
  });

  it('hides when the last turn already has streamed content', () => {
    expect(shouldShowPendingShimmer({
      isLastTurn: true,
      agentStatus: 'running',
      hasStreamedContent: true,
      turnSessionId: 'live',
      liveSessionId: 'live',
    })).toBe(false);
  });

  it('hides when not last turn', () => {
    expect(shouldShowPendingShimmer({
      isLastTurn: false,
      agentStatus: 'running',
      hasStreamedContent: false,
      turnSessionId: 'live',
      liveSessionId: 'live',
    })).toBe(false);
  });

  it('still shows while liveSessionId is unknown (optimistic send)', () => {
    expect(shouldShowPendingShimmer({
      ...runningEmptyLast,
      turnSessionId: 'new-turn',
      liveSessionId: null,
    })).toBe(true);
  });
});
