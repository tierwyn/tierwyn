import { compileFindMatcher, type FindOptions } from './transcriptFind.js';

export const FIND_HIGHLIGHT_ALL = 'transcript-find';
export const FIND_HIGHLIGHT_CURRENT = 'transcript-find-current';

export function supportsCssHighlights(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { CSS?: { highlights?: unknown } }).CSS?.highlights === 'object' &&
    typeof (globalThis as { Highlight?: unknown }).Highlight === 'function'
  );
}

export interface TextSegment {
  node: unknown;
  start: number;
  end: number;
}

export function mapSpanToNodes(
  segments: readonly TextSegment[],
  start: number,
  end: number,
): { startNode: unknown; startOffset: number; endNode: unknown; endOffset: number } | null {
  if (start >= end || segments.length === 0) return null;
  const startSeg = segmentAt(segments, start);
  const endSeg = segmentAt(segments, end - 1);
  if (!startSeg || !endSeg) return null;
  return {
    startNode: startSeg.node,
    startOffset: start - startSeg.start,
    endNode: endSeg.node,
    endOffset: end - endSeg.start,
  };
}

function segmentAt(segments: readonly TextSegment[], offset: number): TextSegment | null {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const s = segments[mid]!;
    if (offset < s.start) hi = mid - 1;
    else if (offset >= s.end) lo = mid + 1;
    else return s;
  }
  return null;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'SVG']);
const SKIP_CLASS = ['katex', 'katex-display', 'math', 'mermaid', 'abc-rendered', 'stream-cursor'];

export function shouldSkipHighlightTag(tagName: string): boolean {
  return SKIP_TAGS.has(tagName.toUpperCase());
}

export function isActiveFindCard(
  cardKey: string,
  active: { cardKey: string; matchIndexInCard: number } | null,
): active is { cardKey: string; matchIndexInCard: number } {
  return cardKey === active?.cardKey;
}

function skipFromRoot(node: Node, root: Node): boolean {
  let n: Node | null = node.parentNode;
  while (n && n !== root) {
    if (n instanceof Element) {
      if (shouldSkipHighlightTag(n.tagName)) return true;
      for (const c of SKIP_CLASS) {
        if (n.classList.contains(c)) return true;
      }
    }
    n = n.parentNode;
  }
  return false;
}

export function collectTextRuns(root: Element): { segments: TextSegment[]; fullText: string } {
  const segments: TextSegment[] = [];
  let offset = 0;
  if (typeof document === 'undefined' || typeof (document as Document).createTreeWalker !== 'function') {
    return { segments, fullText: '' };
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (skipFromRoot(node, root)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const text = n.nodeValue ?? '';
    if (!text) continue;
    segments.push({ node: n, start: offset, end: offset + text.length });
    offset += text.length;
  }
  return { segments, fullText: segments.map((s) => (s.node as Text).nodeValue ?? '').join('') };
}

export function findRangesInText(
  fullText: string,
  query: string,
  opts?: FindOptions,
): Array<{ start: number; end: number }> {
  return compileFindMatcher(query, opts).ranges(fullText);
}

function rangesForCard(cardEl: HTMLElement, query: string, opts?: FindOptions): Range[] {
  if (typeof document === 'undefined' || typeof document.createRange !== 'function') return [];
  const { segments, fullText } = collectTextRuns(cardEl);
  const out: Range[] = [];
  for (const span of findRangesInText(fullText, query, opts)) {
    const mapped = mapSpanToNodes(segments, span.start, span.end);
    if (!mapped) continue;
    try {
      const range = document.createRange();
      range.setStart(mapped.startNode as Node, mapped.startOffset);
      range.setEnd(mapped.endNode as Node, mapped.endOffset);
      out.push(range);
    } catch {
      /* detached / invalid offset — skip */
    }
  }
  return out;
}

export function applyTranscriptHighlights(
  paneEl: HTMLElement,
  query: string,
  active: { cardKey: string; matchIndexInCard: number } | null,
  opts?: FindOptions,
): { activeRange: Range | null; activeCardEl: HTMLElement | null } {
  if (!supportsCssHighlights()) return { activeRange: null, activeCardEl: null };
  const api = (globalThis as unknown as {
    CSS: { highlights: { set(k: string, v: unknown): void; delete(k: string): void } };
    Highlight: new (...ranges: Range[]) => unknown;
  });
  if (!query.trim()) {
    api.CSS.highlights.delete(FIND_HIGHLIGHT_ALL);
    api.CSS.highlights.delete(FIND_HIGHLIGHT_CURRENT);
    return { activeRange: null, activeCardEl: null };
  }
  const otherRanges: Range[] = [];
  const activeRanges: Range[] = [];
  let activeRange: Range | null = null;
  let activeCardEl: HTMLElement | null = null;
  const cards = paneEl.querySelectorAll<HTMLElement>('[data-find-card]');
  for (const card of cards) {
    const cardKey = card.getAttribute('data-find-card') ?? '';
    const cardRanges = rangesForCard(card, query, opts);
    if (isActiveFindCard(cardKey, active)) {
      activeCardEl = card;
      if (cardRanges.length > 0) {
        const idx = Math.min(Math.max(0, active.matchIndexInCard), cardRanges.length - 1);
        activeRange = cardRanges[idx] ?? null;
        for (let i = 0; i < cardRanges.length; i++) {
          if (i === idx) activeRanges.push(cardRanges[i]!);
          else otherRanges.push(cardRanges[i]!);
        }
      }
    } else {
      otherRanges.push(...cardRanges);
    }
  }
  api.CSS.highlights.set(FIND_HIGHLIGHT_ALL, new api.Highlight(...otherRanges));
  api.CSS.highlights.set(FIND_HIGHLIGHT_CURRENT, new api.Highlight(...activeRanges));
  return { activeRange, activeCardEl };
}

export function clearTranscriptHighlights(): void {
  if (!supportsCssHighlights()) return;
  const h = (globalThis as unknown as { CSS: { highlights: { delete(k: string): void } } }).CSS.highlights;
  h.delete(FIND_HIGHLIGHT_ALL);
  h.delete(FIND_HIGHLIGHT_CURRENT);
}

export function scrollRangeIntoPane(
  paneEl: HTMLElement,
  range: Range | null,
  fallbackCardEl: HTMLElement | null,
): void {
  if (range) {
    const rangeRect = range.getBoundingClientRect();
    if (rangeRect.width > 0 || rangeRect.height > 0) {
      const paneRect = paneEl.getBoundingClientRect();
      const targetTop = paneEl.scrollTop + (rangeRect.top - paneRect.top) - paneRect.height / 2 + rangeRect.height / 2;
      paneEl.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      return;
    }
  }
  if (fallbackCardEl) {
    fallbackCardEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    fallbackCardEl.classList.add('transcript-flash');
    setTimeout(() => fallbackCardEl.classList.remove('transcript-flash'), 1500);
  }
}
