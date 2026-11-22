import { describe, it, expect } from 'vitest';
import type { Root, Element, Text, ElementContent, RootContent } from 'hast';
import {
  splitAroundMatches,
  highlightHastTree,
  rehypeHighlightMatches,
} from './highlightMatches.js';

function textsOf(parts: { text: string; match: boolean }[]): string[] {
  return parts.filter((p) => p.match).map((p) => p.text);
}

describe('splitAroundMatches', () => {
  it('is case-insensitive', () => {
    const parts = splitAroundMatches('Hello HELLO hello', 'HeLLo');
    expect(textsOf(parts)).toEqual(['Hello', 'HELLO', 'hello']);
    expect(parts.filter((p) => p.match)).toHaveLength(3);
  });

  it('finds multiple hits in one string', () => {
    const parts = splitAroundMatches('foo bar foo', 'foo');
    expect(textsOf(parts)).toEqual(['foo', 'foo']);
    expect(parts.map((p) => p.text).join('')).toBe('foo bar foo');
  });

  it('returns identity for an empty or whitespace query', () => {
    expect(splitAroundMatches('keep me', '')).toEqual([{ text: 'keep me', match: false }]);
    expect(splitAroundMatches('keep me', '   ')).toEqual([{ text: 'keep me', match: false }]);
  });

  it('treats regex metacharacters in the query as literals', () => {
    expect(textsOf(splitAroundMatches('foo.bar', 'foo.bar'))).toEqual(['foo.bar']);
    expect(textsOf(splitAroundMatches('fooXbar', 'foo.bar'))).toEqual([]);
    expect(textsOf(splitAroundMatches('a+b a+b a-b', 'a+b'))).toEqual(['a+b', 'a+b']);
    expect(textsOf(splitAroundMatches('(hi)', '(hi)'))).toEqual(['(hi)']);
  });

  it('keeps adjacent hits and takes the leftmost of overlapping hits', () => {
    // Adjacent: two non-overlapping "aa" in "aaaa".
    expect(textsOf(splitAroundMatches('aaaa', 'aa'))).toEqual(['aa', 'aa']);
    // Overlapping: "aaa" vs "aa" — leftmost only, leftover "a".
    expect(splitAroundMatches('aaa', 'aa')).toEqual([
      { text: 'aa', match: true },
      { text: 'a', match: false },
    ]);
  });

  it('does not wrap when there is no match', () => {
    expect(splitAroundMatches('nothing here', 'zzz')).toEqual([
      { text: 'nothing here', match: false },
    ]);
  });

  it('highlights every term in words mode', () => {
    const parts = splitAroundMatches('the Marmalade parser', 'parser marmalade', { mode: 'words' });
    expect(textsOf(parts).map((t) => t.toLowerCase())).toEqual(['marmalade', 'parser']);
  });

  it('applies regex in the HAST fallback', () => {
    expect(textsOf(splitAroundMatches('foo123 bar', '\\d+', { mode: 'regex' }))).toEqual(['123']);
  });

  it('does not throw on invalid regex', () => {
    expect(() => splitAroundMatches('abc', '[', { mode: 'regex' })).not.toThrow();
    expect(splitAroundMatches('abc', '[', { mode: 'regex' })).toEqual([{ text: 'abc', match: false }]);
  });
});

function text(value: string): Text {
  return { type: 'text', value };
}

function el(tagName: string, children: ElementContent[], className?: string | string[]): Element {
  return {
    type: 'element',
    tagName,
    properties: className ? { className } : {},
    children,
  };
}

function tree(children: ElementContent[]): Root {
  return { type: 'root', children };
}

function collectMarks(node: Root | RootContent, out: Element[] = []): Element[] {
  if (node.type === 'element') {
    if (node.tagName === 'mark') out.push(node);
    for (const c of node.children) collectMarks(c, out);
  } else if (node.type === 'root') {
    for (const c of node.children) collectMarks(c, out);
  }
  return out;
}

function classNames(node: Element): string[] {
  const c = node.properties?.className;
  if (!c) return [];
  return Array.isArray(c) ? c.map(String) : String(c).split(/\s+/);
}

describe('highlightHastTree', () => {
  it('wraps prose text and skips code, pre, katex, mermaid, abc', () => {
    const root = tree([
      el('p', [text('Hello world')]),
      el('pre', [el('code', [text('Hello code')])]),
      el('code', [text('Hello inline')]),
      el('span', [text('Hello math')], 'katex'),
      el('code', [text('Hello diagram')], 'language-mermaid'),
      el('code', [text('Hello score')], 'language-abc'),
    ]);
    highlightHastTree(root, 'Hello', false);
    const marks = collectMarks(root);
    expect(marks).toHaveLength(1);
    expect((marks[0].children[0] as Text).value).toBe('Hello');
    expect(classNames(marks[0])).toEqual(['transcript-mark']);
  });

  it('adds transcript-mark--current when active', () => {
    const root = tree([el('p', [text('hit')])]);
    highlightHastTree(root, 'hit', true);
    const marks = collectMarks(root);
    expect(classNames(marks[0])).toEqual(['transcript-mark', 'transcript-mark--current']);
  });

  it('is a no-op for an empty query', () => {
    const root = tree([el('p', [text('Hello')])]);
    highlightHastTree(root, '  ', false);
    expect(collectMarks(root)).toHaveLength(0);
    expect((root.children[0] as Element).children[0]).toEqual(text('Hello'));
  });

  it('marks only the activeOccurrenceIdx match as current', () => {
    const root = tree([el('p', [text('hit hit hit')])]);
    highlightHastTree(root, 'hit', true, 1);
    const marks = collectMarks(root);
    expect(marks).toHaveLength(3);
    expect(classNames(marks[0]!)).toEqual(['transcript-mark']);
    expect(classNames(marks[1]!)).toEqual(['transcript-mark', 'transcript-mark--current']);
    expect(marks[1]!.properties?.dataFindActive).toBe('true');
    expect(marks[0]!.properties?.dataFindActive).toBeUndefined();
    expect(classNames(marks[2]!)).toEqual(['transcript-mark']);
  });

  it('paints multi-word and regex matches in the HAST fallback', () => {
    const words = tree([el('p', [text('the Marmalade parser')])]);
    highlightHastTree(words, 'parser marmalade', false, undefined, { mode: 'words' });
    expect(collectMarks(words).map((m) => (m.children[0] as Text).value.toLowerCase()))
      .toEqual(['marmalade', 'parser']);

    const regex = tree([el('p', [text('foo123 bar')])]);
    highlightHastTree(regex, '\\d+', false, undefined, { mode: 'regex' });
    expect(collectMarks(regex).map((m) => (m.children[0] as Text).value)).toEqual(['123']);
  });
});

describe('rehypeHighlightMatches', () => {
  it('returns a plugin that paints matches', () => {
    const root = tree([el('p', [text('marmalade')])]);
    rehypeHighlightMatches('Marmalade', false)()(root);
    expect(collectMarks(root)).toHaveLength(1);
  });
});
