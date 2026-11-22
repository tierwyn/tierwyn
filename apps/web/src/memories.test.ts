import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import type { NormalisedEvent } from '@tierwyn/shared';
import {
  memoryBadgeCount,
  recalledChipLabel,
  MEMORY_FLAG_LABELS,
  splitTurnRecall,
  hasStreamedTurnContent,
  isRecallChipEvent,
  shouldShowMemoriesLoading,
  shouldRunFocusFetch,
  isMemoryNotFound,
} from './memories.js';
import { shouldShowPendingShimmer } from './pendingShimmer.js';

function makeEvent(partial: Partial<NormalisedEvent>): NormalisedEvent {
  return {
    id: 'ev-1',
    type: 'message',
    sessionId: 's-1',
    ts: 1000,
    payload: { chunk: '' },
    ...partial,
  } as NormalisedEvent;
}

describe('memoryBadgeCount', () => {
  it('sums pendingSuggestions and flagged', () => {
    expect(memoryBadgeCount({ pendingSuggestions: 0, flagged: 0 })).toBe(0);
    expect(memoryBadgeCount({ pendingSuggestions: 3, flagged: 2 })).toBe(5);
    expect(memoryBadgeCount({ pendingSuggestions: 4, flagged: 0 })).toBe(4);
    expect(memoryBadgeCount({ pendingSuggestions: 0, flagged: 7 })).toBe(7);
  });
});

describe('recalledChipLabel', () => {
  it('formats singular and plural correctly', () => {
    expect(recalledChipLabel(['m_1'])).toBe('Recalled 1 memory: m_1');
    expect(recalledChipLabel(['m_41', 'm_17'])).toBe('Recalled 2 memories: m_41, m_17');
    expect(recalledChipLabel(['m_1', 'm_2', 'm_3'])).toBe('Recalled 3 memories: m_1, m_2, m_3');
  });

  it('handles empty gracefully', () => {
    expect(recalledChipLabel([])).toBe('Recalled 0 memories: ');
  });
});

describe('MEMORY_FLAG_LABELS', () => {
  it('maps every category to its display label', () => {
    expect(MEMORY_FLAG_LABELS.addressed_to_agents).toBe('Addressed to agents');
    expect(MEMORY_FLAG_LABELS.task_chatter).toBe('Task chatter');
    expect(MEMORY_FLAG_LABELS.secret_like).toBe('Secret-like');
    expect(MEMORY_FLAG_LABELS.irrelevant_recall).toBe('Irrelevant recall');
  });
});

describe('splitTurnRecall', () => {
  const chipEvent = makeEvent({
    id: 'chip-1',
    type: 'message',
    sender: 'system',
    payload: { chunk: '', recalledMemories: ['m_41', 'm_17'] },
  });

  const msgEvent = makeEvent({
    id: 'msg-1',
    type: 'message',
    sender: 'agent',
    payload: { chunk: 'Hello there' },
  });

  const statusEvent = makeEvent({
    id: 'stat-1',
    type: 'status',
    payload: { status: 'running' },
  });

  it('extracts chip that appears first before agent output', () => {
    const events = [chipEvent, statusEvent, msgEvent];
    const res = splitTurnRecall(events);
    expect(res.recalled).toEqual(['m_41', 'm_17']);
    expect(res.hoistedItem).toBe(chipEvent);
  });

  it('extracts chip when status event precedes it before agent output', () => {
    const events = [statusEvent, chipEvent, msgEvent];
    const res = splitTurnRecall(events);
    expect(res.recalled).toEqual(['m_41', 'm_17']);
    expect(res.hoistedItem).toBe(chipEvent);
  });

  it('does not hoist chip when it appears after agent output (e.g. steer)', () => {
    const events = [msgEvent, chipEvent];
    const res = splitTurnRecall(events);
    expect(res.recalled).toBeUndefined();
    expect(res.hoistedItem).toBeUndefined();
  });

  it('returns undefined when no chip exists', () => {
    const events = [statusEvent, msgEvent];
    const res = splitTurnRecall(events);
    expect(res.recalled).toBeUndefined();
    expect(res.hoistedItem).toBeUndefined();
  });

  it('handles wrapped MergedItem shapes', () => {
    const items = [
      { event: chipEvent },
      { event: msgEvent },
    ];
    const res = splitTurnRecall(items);
    expect(res.recalled).toEqual(['m_41', 'm_17']);
    expect(res.hoistedItem).toEqual({ event: chipEvent });
  });

  it('identifies hoistedItem and ensures each chip renders exactly once across hoisted and inline', () => {
    const steerChip = makeEvent({
      id: 'chip-2',
      type: 'message',
      sender: 'system',
      payload: { chunk: '', recalledMemories: ['m_99'] },
    });
    // Turn events: hoisted chip, initial assistant output, mid-turn steer chip
    const events = [chipEvent, msgEvent, steerChip];
    const { recalled, hoistedItem } = splitTurnRecall(events);

    expect(recalled).toEqual(['m_41', 'm_17']);
    expect(hoistedItem).toBe(chipEvent);

    // Simulated event rendering loop (matching OutputPane.tsx: if m === hoistedItem return null)
    const inlineRenderedChips: string[][] = [];
    for (const m of events) {
      if (isRecallChipEvent(m)) {
        if (m === hoistedItem) {
          // Hoisted chip skipped inline!
          continue;
        }
        inlineRenderedChips.push((m.payload as { recalledMemories?: string[] }).recalledMemories!);
      }
    }

    // Hoisted chip renders once above the prompt card:
    const allRendered = [recalled, ...inlineRenderedChips];
    expect(allRendered).toEqual([
      ['m_41', 'm_17'], // hoisted
      ['m_99'],          // mid-turn steer rendered inline
    ]);
  });
});

describe('hasStreamedTurnContent and pending shimmer (F2)', () => {
  const chipEvent = makeEvent({
    id: 'chip-1',
    type: 'message',
    sender: 'system',
    payload: { chunk: '', recalledMemories: ['m_41'] },
  });
  const statusEvent = makeEvent({
    id: 'status-1',
    type: 'status',
    payload: { status: 'running' },
  });
  const msgEvent = makeEvent({
    id: 'msg-1',
    type: 'message',
    sender: 'agent',
    payload: { chunk: 'Hello' },
  });

  it('excludes recall chip events from hasStreamedTurnContent', () => {
    expect(hasStreamedTurnContent([])).toBe(false);
    expect(hasStreamedTurnContent([chipEvent])).toBe(false);
    expect(hasStreamedTurnContent([statusEvent, chipEvent])).toBe(false);
    expect(hasStreamedTurnContent([chipEvent, msgEvent])).toBe(true);
  });

  it('keeps pending shimmer active on recalled turns until first token arrives', () => {
    // Turn just started: recall chip persisted before first assistant token
    const eventsBeforeToken = [chipEvent, statusEvent];
    const shimmerBeforeToken = shouldShowPendingShimmer({
      isLastTurn: true,
      agentStatus: 'running',
      hasStreamedContent: hasStreamedTurnContent(eventsBeforeToken),
    });
    expect(shimmerBeforeToken).toBe(true);

    // Assistant streams first token
    const eventsAfterToken = [chipEvent, statusEvent, msgEvent];
    const shimmerAfterToken = shouldShowPendingShimmer({
      isLastTurn: true,
      agentStatus: 'running',
      hasStreamedContent: hasStreamedTurnContent(eventsAfterToken),
    });
    expect(shimmerAfterToken).toBe(false);
  });
});

describe('shouldShowMemoriesLoading (N1)', () => {
  it('does not show loading when focusMemory is set even if list fetch aborted leaving loading=true and itemCount=0', () => {
    expect(
      shouldShowMemoriesLoading({
        focusMemory: { id: 'm_1' },
        loading: true,
        itemCount: 0,
        focusLoading: false,
      }),
    ).toBe(false);
  });

  it('shows loading when focusMemory is null and list loading with 0 items', () => {
    expect(
      shouldShowMemoriesLoading({
        focusMemory: null,
        loading: true,
        itemCount: 0,
        focusLoading: false,
      }),
    ).toBe(true);
  });

  it('shows loading when focusMemory is null and focus fetch is loading', () => {
    expect(
      shouldShowMemoriesLoading({
        focusMemory: null,
        loading: false,
        itemCount: 0,
        focusLoading: true,
      }),
    ).toBe(true);
  });

  it('does not show loading when focusMemory is null and items are already loaded', () => {
    expect(
      shouldShowMemoriesLoading({
        focusMemory: null,
        loading: false,
        itemCount: 3,
        focusLoading: false,
      }),
    ).toBe(false);
  });
});

describe('shouldRunFocusFetch (N2)', () => {
  it('returns false when focusId is not provided', () => {
    expect(shouldRunFocusFetch(null, null)).toBe(false);
    expect(shouldRunFocusFetch(undefined, null)).toBe(false);
  });

  it('returns false when focusId matches dismissedFocusId (operator left focus)', () => {
    expect(shouldRunFocusFetch('m_1', 'm_1')).toBe(false);
  });

  it('returns true when focusId has not been dismissed', () => {
    expect(shouldRunFocusFetch('m_1', null)).toBe(true);
    expect(shouldRunFocusFetch('m_2', 'm_1')).toBe(true);
  });
});

describe('isMemoryNotFound (N3)', () => {
  it('identifies strict 404 status on error object', () => {
    expect(isMemoryNotFound({ status: 404 })).toBe(true);
  });

  it('rejects 503 error even if message contains /memories/m_404', () => {
    const err = new Error('GET /memories/m_404 -> 503') as Error & { status?: number };
    err.status = 503;
    expect(isMemoryNotFound(err)).toBe(false);
  });

  it('rejects generic errors without status 404', () => {
    expect(isMemoryNotFound(new Error('Resource not found'))).toBe(false);
    expect(isMemoryNotFound({ status: 500 })).toBe(false);
    expect(isMemoryNotFound(null)).toBe(false);
  });
});

describe('MemoriesModal dropdown standardization', () => {
  const modalSrc = readFileSync(new URL('./components/MemoriesModal.tsx', import.meta.url), 'utf8');

  it('uses shared SelectDropdown instead of bare select for project filtering', () => {
    expect(modalSrc).toMatch(/from ['"]\.\/SelectDropdown\.js['"]/);
    expect(modalSrc).toContain('<SelectDropdown');
    expect(modalSrc).not.toMatch(/<select[\s>]/);
  });

  it('enables searchable prop on the project SelectDropdown', () => {
    expect(modalSrc).toMatch(/<SelectDropdown[\s\S]*?searchable/);
  });
});
