import { describe, it, expect } from 'vitest';
import {
  mapSpanToNodes,
  supportsCssHighlights,
  shouldSkipHighlightTag,
  isActiveFindCard,
  findRangesInText,
  type TextSegment,
} from './domHighlight.js';

describe('mapSpanToNodes', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const c = { id: 'c' };
  const segments: TextSegment[] = [
    { node: a, start: 0, end: 4 },   // "func"
    { node: b, start: 4, end: 8 },   // "tion"
    { node: c, start: 8, end: 11 },  // " foo"
  ];

  it('maps a single-node span', () => {
    expect(mapSpanToNodes(segments, 0, 4)).toEqual({
      startNode: a, startOffset: 0, endNode: a, endOffset: 4,
    });
  });

  it('maps a match that crosses syntax-highlight spans', () => {
    // "function" = a+b
    expect(mapSpanToNodes(segments, 0, 8)).toEqual({
      startNode: a, startOffset: 0, endNode: b, endOffset: 4,
    });
  });

  it('maps a span starting mid-node and ending in a later node', () => {
    expect(mapSpanToNodes(segments, 2, 10)).toEqual({
      startNode: a, startOffset: 2, endNode: c, endOffset: 2,
    });
  });

  it('maps adjacent non-overlapping spans independently', () => {
    const first = mapSpanToNodes(segments, 0, 4);
    const second = mapSpanToNodes(segments, 4, 8);
    expect(first?.endNode).toBe(a);
    expect(second?.startNode).toBe(b);
    expect(second?.startOffset).toBe(0);
  });

  it('returns null for an empty span or empty segments', () => {
    expect(mapSpanToNodes(segments, 2, 2)).toBeNull();
    expect(mapSpanToNodes([], 0, 4)).toBeNull();
    expect(mapSpanToNodes(segments, 20, 24)).toBeNull();
  });
});

describe('supportsCssHighlights', () => {
  it('is false in the node Vitest environment', () => {
    expect(supportsCssHighlights()).toBe(false);
  });
});

describe('shouldSkipHighlightTag', () => {
  it('skips script, style, and svg regardless of tagName case', () => {
    expect(shouldSkipHighlightTag('SCRIPT')).toBe(true);
    expect(shouldSkipHighlightTag('STYLE')).toBe(true);
    expect(shouldSkipHighlightTag('SVG')).toBe(true);
    expect(shouldSkipHighlightTag('svg')).toBe(true);
    expect(shouldSkipHighlightTag('Svg')).toBe(true);
    expect(shouldSkipHighlightTag('DIV')).toBe(false);
    expect(shouldSkipHighlightTag('div')).toBe(false);
  });
});

describe('isActiveFindCard', () => {
  it('marks the matching card active even when it has 0 DOM ranges', () => {
    expect(isActiveFindCard('turn-1:prompt', { cardKey: 'turn-1:prompt', matchIndexInCard: 0 })).toBe(true);
    expect(isActiveFindCard('turn-1:prompt', { cardKey: 'turn-2:g0', matchIndexInCard: 0 })).toBe(false);
    expect(isActiveFindCard('turn-1:prompt', null)).toBe(false);
  });
});

describe('findRangesInText', () => {
  it('returns multi-word ranges in document order', () => {
    expect(findRangesInText('the Marmalade parser', 'parser marmalade', { mode: 'words' }))
      .toEqual([{ start: 4, end: 13 }, { start: 14, end: 20 }]);
  });

  it('returns regex ranges via the shared matcher', () => {
    expect(findRangesInText('a1 b22', '\\d+', { mode: 'regex' }))
      .toEqual([{ start: 1, end: 2 }, { start: 4, end: 6 }]);
  });

  it('skips zero-length regex matches without looping', () => {
    expect(findRangesInText('hello', '^', { mode: 'regex' })).toEqual([]);
    expect(findRangesInText('aaa', 'a*', { mode: 'regex' })).toEqual([{ start: 0, end: 3 }]);
  });

  it('returns nothing for invalid regex', () => {
    expect(findRangesInText('hello', '[', { mode: 'regex' })).toEqual([]);
  });
});
