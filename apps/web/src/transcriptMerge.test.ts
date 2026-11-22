import { describe, it, expect } from 'vitest';
import type { NormalisedEvent } from '@tierwyn/shared';
import { mergeTranscriptWithLive } from './transcriptMerge.js';

function ev(id: string | undefined, ts: number, text = ''): NormalisedEvent {
  return {
    type: 'message',
    id,
    ts,
    seq: 0,
    sessionId: 's',
    payload: { text },
  } as unknown as NormalisedEvent;
}

describe('mergeTranscriptWithLive', () => {
  it('merges page [a1,b2] + live [b2,c3] into [a,b,c]', () => {
    const page = [ev('a', 1), ev('b', 2)];
    const live = [ev('b', 2), ev('c', 3)];
    const merged = mergeTranscriptWithLive(page, live);
    expect(merged.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('returns the same page reference when live is empty', () => {
    const page = [ev('a', 1), ev('b', 2)];
    const merged = mergeTranscriptWithLive(page, []);
    expect(merged).toBe(page);
  });

  it('keeps all live events when page is empty', () => {
    const live = [ev('x', 5), ev('y', 6)];
    const merged = mergeTranscriptWithLive([], live);
    expect(merged.map((e) => e.id)).toEqual(['x', 'y']);
  });

  it('keeps id-less live events with ts >= lastTs and drops those with ts < lastTs', () => {
    const page = [ev('a', 10)];
    const oldErr = ev(undefined, 5, 'old');
    const newErr = ev(undefined, 15, 'new');
    const merged = mergeTranscriptWithLive(page, [oldErr, newErr]);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toBe(newErr);
  });

  it('drops id-bearing live events not in page with ts < lastTs', () => {
    const page = [ev('a', 10), ev('b', 20)];
    const deleted = ev('old-deleted', 15);
    const merged = mergeTranscriptWithLive(page, [deleted]);
    expect(merged).toBe(page);
  });

  it('keeps same-ts different-id live events appended after page', () => {
    const page = [ev('a', 10)];
    const sameTs = ev('b', 10);
    const merged = mergeTranscriptWithLive(page, [sameTs]);
    expect(merged.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('prefers the page copy on duplicate id', () => {
    const pageEvent = ev('b', 20, 'from-page');
    const liveEvent = ev('b', 20, 'from-live');
    const merged = mergeTranscriptWithLive([ev('a', 10), pageEvent], [liveEvent, ev('c', 30)]);
    expect(merged[1]).toBe(pageEvent);
  });

  it('preserves arrival order of live survivors even with equal timestamps', () => {
    const page = [ev('a', 10)];
    const live = [ev('c', 20), ev('b', 20), ev('d', 20)];
    const merged = mergeTranscriptWithLive(page, live);
    expect(merged.map((e) => e.id)).toEqual(['a', 'c', 'b', 'd']);
  });
});
