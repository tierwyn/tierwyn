import { describe, it, expect } from 'vitest';
import type { NormalisedEvent } from '@tierwyn/shared';
import { buildConversationInfo, formatCachedTokens } from './conversationInfo.js';

function ev(partial: Record<string, unknown> & { type: NormalisedEvent['type'] }): NormalisedEvent {
  return {
    id: partial.id ?? `ev-${partial.seq ?? partial.ts ?? 0}`,
    sessionId: partial.sessionId ?? 's1',
    seq: partial.seq ?? 1,
    ts: partial.ts ?? 1_000,
    ...partial,
  } as unknown as NormalisedEvent;
}

describe('buildConversationInfo', () => {
  it('aggregates tools and files across multiple turns', () => {
    const events: NormalisedEvent[] = [
      ev({ type: 'prompt', id: 'p1', seq: 1, ts: 1_000, payload: { text: 'first prompt' } }),
      ev({
        type: 'tool_call',
        id: 'tc1',
        seq: 2,
        ts: 1_100,
        payload: { name: 'Bash', toolUseId: 'tu1', input: { command: 'ls' } },
      }),
      ev({
        type: 'file_change',
        id: 'fc1',
        seq: 3,
        ts: 1_200,
        payload: { path: '/a.ts', kind: 'modified', additions: 2, deletions: 1, toolUseId: 'tu1' },
      }),
      ev({ type: 'prompt', id: 'p2', seq: 4, ts: 5_000, payload: { text: 'second prompt' } }),
      ev({
        type: 'tool_call',
        id: 'tc2',
        seq: 5,
        ts: 5_100,
        payload: { name: 'Read', toolUseId: 'tu2', input: { path: '/b.ts' } },
      }),
      ev({
        type: 'status',
        id: 'st1',
        seq: 6,
        ts: 5_200,
        payload: { status: 'done', inputTokens: 100, outputTokens: 50, costUsd: 0.01 },
      }),
    ];

    const info = buildConversationInfo(events);

    expect(info.turnSummaries).toHaveLength(2);
    expect(info.totalToolCalls).toBe(2);
    expect(info.fileRows).toHaveLength(1);
    expect(info.uniqueFilePaths).toEqual(['/a.ts']);
    expect(info.totalInputTokens).toBe(100);
    expect(info.totalOutputTokens).toBe(50);
    expect(info.totalCostUsd).toBeCloseTo(0.01);
    expect(info.totalElapsedMs).toBe(400);
    expect(info.totalCacheReadTokens).toBeNull();
    expect(info.totalCacheCreationTokens).toBeNull();
  });

  it('agy 1.5 edit_file (Path/Target/Replacement) yields a diff row with line counts', () => {
    const info = buildConversationInfo([
      ev({ type: 'prompt', id: 'p1', seq: 1, payload: { text: 'edit' } }),
      ev({
        type: 'tool_call', id: 'tc1', seq: 2,
        payload: { name: 'edit_file', toolUseId: 'agy:c:1', input: { Path: '/a.md', Target: 'a\nb', Replacement: 'a\nB\nC' } },
      }),
      ev({ type: 'file_change', id: 'fc1', seq: 3, payload: { path: '/a.md', kind: 'modified', toolUseId: 'agy:c:1' } }),
    ]);
    expect(info.totalFileChanges).toBe(1);
    expect(info.fileRows[0].diffPair).toEqual({ before: 'a\nb', after: 'a\nB\nC' });
    expect(info.totalAdditions).toBe(2);
    expect(info.totalDeletions).toBe(1);
  });

  it('aggregates cache read and cache creation tokens across status events when present', () => {
    const events: NormalisedEvent[] = [
      ev({ type: 'prompt', id: 'p1', seq: 1, ts: 1_000, payload: { text: 'turn 1' } }),
      ev({
        type: 'status',
        id: 'st1',
        seq: 2,
        ts: 1_200,
        payload: {
          status: 'done',
          inputTokens: 500,
          outputTokens: 100,
          cacheReadTokens: 1_200,
          cacheCreationTokens: 300,
        },
      }),
      ev({ type: 'prompt', id: 'p2', seq: 3, ts: 2_000, payload: { text: 'turn 2' } }),
      ev({
        type: 'status',
        id: 'st2',
        seq: 4,
        ts: 2_200,
        payload: {
          status: 'done',
          inputTokens: 600,
          outputTokens: 150,
          cacheReadTokens: 800,
        },
      }),
    ];

    const info = buildConversationInfo(events);
    expect(info.totalInputTokens).toBe(1_100);
    expect(info.totalOutputTokens).toBe(250);
    expect(info.totalCacheReadTokens).toBe(2_000);
    expect(info.totalCacheCreationTokens).toBe(300);
  });

  it('marks the last turn active when conversation is running', () => {
    const events: NormalisedEvent[] = [
      ev({ type: 'prompt', id: 'p1', seq: 1, ts: 1_000, payload: { text: 'go' } }),
      ev({ type: 'status', id: 'st1', seq: 2, ts: 1_100, payload: { status: 'running' } }),
    ];

    const info = buildConversationInfo(events, { isConversationActive: true, liveNow: 4_000 });

    expect(info.activeTurnIndex).toBe(0);
    expect(info.turnSummaries[0]?.isActive).toBe(true);
    expect(info.totalElapsedMs).toBe(3_000);
  });
});

describe('formatCachedTokens', () => {
  it('returns null when neither cache read nor creation tokens are present', () => {
    expect(formatCachedTokens(undefined, undefined)).toBeNull();
    expect(formatCachedTokens(null, null)).toBeNull();
  });

  it('formats cache read only', () => {
    expect(formatCachedTokens(1500, undefined)).toBe('Cache read: 1,500');
    expect(formatCachedTokens(0, null)).toBe('Cache read: 0');
  });

  it('formats cache write only', () => {
    expect(formatCachedTokens(undefined, 500)).toBe('Cache write: 500');
    expect(formatCachedTokens(null, 1200)).toBe('Cache write: 1,200');
  });

  it('formats both cache read and cache write', () => {
    expect(formatCachedTokens(1500, 300)).toBe('Cache read: 1,500 · write: 300');
    expect(formatCachedTokens(0, 500)).toBe('Cache read: 0 · write: 500');
  });
});
