import { describe, it, expect } from 'vitest';
import type { SubtreeTimeSummary } from '@tierwyn/shared';
import { runningDescendantCount, shouldRefetchOnActiveChange } from './useSubtreeTime.js';

describe('runningDescendantCount', () => {
  it('returns 0 for null summary or summary without nodes', () => {
    const active = new Set(['c1', 'c2']);
    expect(runningDescendantCount(null, active)).toBe(0);
    expect(runningDescendantCount({} as unknown as SubtreeTimeSummary, active)).toBe(0);
  });

  it('ignores root node (depth 0) even if active', () => {
    const summary: SubtreeTimeSummary = {
      rootConversationId: 'root',
      selfMs: 100,
      descendantsMs: 0,
      totalMs: 100,
      descendantCount: 0,
      truncated: false,
      omittedCount: 0,
      computedAt: 1000,
      nodes: [
        {
          conversationId: 'root',
          parentConversationId: null,
          title: 'Root',
          depth: 0,
          workedMs: 100,
          turns: 1,
          lastEventTs: 1000,
        },
      ],
    };
    const active = new Set(['root']);
    expect(runningDescendantCount(summary, active)).toBe(0);
  });

  it('counts only descendants (depth > 0) present in active set', () => {
    const summary: SubtreeTimeSummary = {
      rootConversationId: 'root',
      selfMs: 100,
      descendantsMs: 200,
      totalMs: 300,
      descendantCount: 3,
      truncated: false,
      omittedCount: 0,
      computedAt: 1000,
      nodes: [
        {
          conversationId: 'root',
          parentConversationId: null,
          title: 'Root',
          depth: 0,
          workedMs: 100,
          turns: 1,
          lastEventTs: 1000,
        },
        {
          conversationId: 'child-1',
          parentConversationId: 'root',
          title: 'Child 1',
          depth: 1,
          workedMs: 50,
          turns: 1,
          lastEventTs: 1000,
        },
        {
          conversationId: 'child-2',
          parentConversationId: 'root',
          title: 'Child 2',
          depth: 1,
          workedMs: 50,
          turns: 1,
          lastEventTs: 1000,
        },
        {
          conversationId: 'grandchild-1',
          parentConversationId: 'child-1',
          title: 'Grandchild 1',
          depth: 2,
          workedMs: 100,
          turns: 1,
          lastEventTs: 1000,
        },
      ],
    };

    expect(runningDescendantCount(summary, new Set(['child-1']))).toBe(1);
    expect(runningDescendantCount(summary, new Set(['child-1', 'grandchild-1']))).toBe(2);
    expect(runningDescendantCount(summary, new Set(['root', 'child-2']))).toBe(1);
    expect(runningDescendantCount(summary, new Set(['unknown']))).toBe(0);
  });
});

describe('shouldRefetchOnActiveChange', () => {
  it('returns true when nextRunning < prevRunning (child ended)', () => {
    expect(shouldRefetchOnActiveChange(2, 1)).toBe(true);
    expect(shouldRefetchOnActiveChange(1, 0)).toBe(true);
  });

  it('returns false when nextRunning >= prevRunning', () => {
    expect(shouldRefetchOnActiveChange(1, 1)).toBe(false);
    expect(shouldRefetchOnActiveChange(0, 1)).toBe(false);
    expect(shouldRefetchOnActiveChange(1, 2)).toBe(false);
    expect(shouldRefetchOnActiveChange(0, 0)).toBe(false);
  });
});
