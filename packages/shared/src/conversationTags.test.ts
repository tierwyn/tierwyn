import { describe, it, expect } from 'vitest';
import {
  normaliseTags, hasTag, MAX_TAGS, MAX_TAG_LENGTH,
  collectKnownTags, suggestTags, matchesTagQuery,
} from './conversationTags.js';

describe('normaliseTags', () => {
  it('accepts a plain array and trims each tag', () => {
    const r = normaliseTags(['  research ', 'bug']);
    expect(r).toEqual({ ok: true, tags: ['research', 'bug'] });
  });

  it('accepts an empty array (clears tags)', () => {
    expect(normaliseTags([])).toEqual({ ok: true, tags: [] });
  });

  it('drops entries that are empty after trim without erroring', () => {
    const r = normaliseTags(['bug', '   ', '']);
    expect(r).toEqual({ ok: true, tags: ['bug'] });
  });

  it('drops later duplicates case-sensitively, keeping first-seen order', () => {
    const r = normaliseTags(['bug', 'Bug', 'bug', 'research']);
    expect(r).toEqual({ ok: true, tags: ['bug', 'Bug', 'research'] });
  });

  it('accepts free text with spaces, punctuation and unicode', () => {
    const r = normaliseTags(['needs review', 'v2.1', 'café ☕']);
    expect(r).toEqual({ ok: true, tags: ['needs review', 'v2.1', 'café ☕'] });
  });

  it('accepts exactly MAX_TAGS tags', () => {
    const tags = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
    expect(normaliseTags(tags)).toEqual({ ok: true, tags });
  });

  it('accepts a tag of exactly MAX_TAG_LENGTH characters', () => {
    const tag = 'x'.repeat(MAX_TAG_LENGTH);
    expect(normaliseTags([tag])).toEqual({ ok: true, tags: [tag] });
  });

  it('rejects a non-array', () => {
    expect(normaliseTags('bug').ok).toBe(false);
    expect(normaliseTags(null).ok).toBe(false);
    expect(normaliseTags({ 0: 'bug' }).ok).toBe(false);
  });

  it('rejects a non-string element', () => {
    const r = normaliseTags(['bug', 7]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/array of strings/);
  });

  it('rejects an over-long tag after trim', () => {
    const r = normaliseTags(['x'.repeat(MAX_TAG_LENGTH + 1)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/32/);
  });

  it('rejects more than MAX_TAGS tags', () => {
    const r = normaliseTags(Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/10/);
  });

  it('counts duplicates and blanks before the cap, not after', () => {
    // 11 raw entries but only 10 distinct non-blank ones — must pass.
    const r = normaliseTags([...Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`), 't0', '  ']);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.tags).toHaveLength(MAX_TAGS);
  });

  it('rejects a tag containing a newline or a NUL', () => {
    expect(normaliseTags(['a\nb']).ok).toBe(false);
    expect(normaliseTags(['a\u0000b']).ok).toBe(false);
    expect(normaliseTags(['a\u007fb']).ok).toBe(false);
  });
});

describe('hasTag', () => {
  it('returns true for every conversation when no tag is active', () => {
    expect(hasTag({ tags: [] }, null)).toBe(true);
    expect(hasTag({}, null)).toBe(true);
  });

  it('matches only conversations carrying the tag', () => {
    expect(hasTag({ tags: ['bug', 'research'] }, 'bug')).toBe(true);
    expect(hasTag({ tags: ['research'] }, 'bug')).toBe(false);
  });

  it('treats a missing tags field as untagged', () => {
    expect(hasTag({}, 'bug')).toBe(false);
    expect(hasTag({ tags: undefined }, 'bug')).toBe(false);
  });

  it('is case-sensitive, matching the dedup rule', () => {
    expect(hasTag({ tags: ['Bug'] }, 'bug')).toBe(false);
  });

  it('filters a mixed list spanning two projects to only tagged ids', () => {
    const projectA = [
      { id: 'a1', tags: ['bug'] },
      { id: 'a2', tags: ['research'] },
    ];
    const projectB = [
      { id: 'b1', tags: [] },
      { id: 'b2', tags: ['research', 'bug'] },
    ];
    const ids = [...projectA, ...projectB].filter((c) => hasTag(c, 'bug')).map((c) => c.id);
    expect(ids).toEqual(['a1', 'b2']);
  });
});

describe('collectKnownTags', () => {
  it('uniques and sorts across conversations', () => {
    expect(collectKnownTags([
      { tags: ['bug', 'research'] },
      { tags: ['bug'] },
      { tags: ['alpha'] },
      {},
    ])).toEqual(['alpha', 'bug', 'research']);
  });
});

describe('suggestTags', () => {
  const known = ['bug', 'research', 'refactor'];
  it('lists unused known tags when the draft is empty', () => {
    expect(suggestTags(known, '', ['bug'])).toEqual(['research', 'refactor']);
  });
  it('filters case-insensitively and excludes applied tags', () => {
    expect(suggestTags(known, 're', ['research'])).toEqual(['refactor']);
  });
  it('caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(suggestTags(many, '', [], 3)).toHaveLength(3);
  });
});

describe('matchesTagQuery', () => {
  it('matches everything when the query is empty', () => {
    expect(matchesTagQuery({ tags: [] }, null)).toBe(true);
    expect(matchesTagQuery({ tags: ['bug'] }, '  ')).toBe(true);
  });
  it('is a case-insensitive substring of any tag', () => {
    expect(matchesTagQuery({ tags: ['research'] }, 'Re')).toBe(true);
    expect(matchesTagQuery({ tags: ['research'] }, 'bug')).toBe(false);
  });
});
