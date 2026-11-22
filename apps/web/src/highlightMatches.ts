import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, ElementContent, Text } from 'hast';
import { compileFindMatcher, type FindOptions } from './transcriptFind.js';

/**
 * FW-12 Phase 1: paint find matches inside rendered markdown text nodes
 * using the shared `compileFindMatcher` (substring / words / regex).
 *
 * Fenced-code / inline-code / mermaid / abc / KaTeX are skipped (not painted)
 * even though `findOccurrences` still counts those cards from the
 * plain-text source (`payload.chunk` / prompt text). Do not try to merge
 * highlight.js token spans here.
 */

export interface MatchPart {
  text: string;
  match: boolean;
}

/**
 * Split `text` around matcher ranges for `query`.
 * Empty/whitespace query → identity (single non-match part).
 * Matches are non-overlapping, left-to-right (adjacent hits are kept;
 * overlapping hits keep the leftmost).
 */
export function splitAroundMatches(text: string, query: string, opts?: FindOptions): MatchPart[] {
  const q = query.trim();
  if (!q) return [{ text, match: false }];
  const ranges = compileFindMatcher(query, opts).ranges(text);
  if (ranges.length === 0) return [{ text, match: false }];
  const out: MatchPart[] = [];
  let last = 0;
  for (const r of ranges) {
    if (r.start < last) continue;
    if (r.start > last) out.push({ text: text.slice(last, r.start), match: false });
    out.push({ text: text.slice(r.start, r.end), match: true });
    last = r.end;
  }
  if (last < text.length) out.push({ text: text.slice(last), match: false });
  return out.length === 0 ? [{ text, match: false }] : out;
}

function classList(node: Element): string[] {
  const c = node.properties?.className;
  if (!c) return [];
  return Array.isArray(c) ? c.map(String) : String(c).split(/\s+/);
}

function shouldSkipElement(node: Element): boolean {
  const tag = node.tagName;
  if (tag === 'code' || tag === 'pre' || tag === 'script' || tag === 'style') return true;
  return classList(node).some((c) =>
    c === 'katex' ||
    c === 'katex-display' ||
    c === 'math' ||
    c === 'math-inline' ||
    c === 'math-display' ||
    c.startsWith('language-mermaid') ||
    c.startsWith('language-abc'),
  );
}

function markNode(value: string, active: boolean, findActive: boolean): Element {
  const className = active
    ? ['transcript-mark', 'transcript-mark--current']
    : ['transcript-mark'];
  return {
    type: 'element',
    tagName: 'mark',
    properties: {
      className,
      ...(findActive ? { dataFindActive: 'true' } : {}),
    },
    children: [{ type: 'text', value }],
  };
}

function wrapText(
  value: string,
  query: string,
  isCurrent: (n: number) => boolean,
  nextIndex: () => number,
  opts?: FindOptions,
): ElementContent[] {
  const parts = splitAroundMatches(value, query, opts);
  if (parts.length === 1 && !parts[0]!.match) {
    return [{ type: 'text', value }];
  }
  return parts.map((p) => {
    if (!p.match) return { type: 'text', value: p.text };
    const n = nextIndex();
    const on = isCurrent(n);
    return markNode(p.text, on, on);
  });
}

/**
 * Mutate a HAST tree in place: wrap matching text nodes in `<mark>`.
 * Exported so the rehype plugin and the node-only tests share one path.
 */
export function highlightHastTree(
  tree: Root,
  query: string,
  active: boolean,
  activeOccurrenceIdx?: number,
  opts?: FindOptions,
): Root {
  if (!query.trim()) return tree;
  let counter = 0;
  const nextIndex = () => counter++;
  const isCurrent = (n: number) =>
    typeof activeOccurrenceIdx === 'number' && activeOccurrenceIdx >= 0
      ? n === activeOccurrenceIdx
      : active;

  visit(tree, (node, index, parent) => {
    if (node.type === 'element' && shouldSkipElement(node as Element)) return SKIP;
    if (node.type !== 'text' || parent == null || typeof index !== 'number') return;
    const elParent = parent as Element;
    if (elParent.type === 'element' && elParent.tagName === 'mark') return SKIP;

    const text = (node as Text).value;
    const next = wrapText(text, query, isCurrent, nextIndex, opts);
    if (next.length === 1 && next[0]!.type === 'text' && (next[0] as Text).value === text) return;
    elParent.children.splice(index, 1, ...next);
    return index + next.length;
  });
  return tree;
}

/**
 * Rehype plugin factory. Empty/whitespace query is a no-op transformer
 * (MarkdownBody also omits the plugin entirely in that case).
 */
export function rehypeHighlightMatches(
  query: string,
  active: boolean,
  activeOccurrenceIdx?: number,
  opts?: FindOptions,
) {
  return () => (tree: Root) => {
    highlightHastTree(tree, query, active, activeOccurrenceIdx, opts);
  };
}
