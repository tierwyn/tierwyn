import { describe, it, expect } from 'vitest';
import {
  BUILTIN_TAG_CATALOGUE, MAX_CUSTOM_CATALOGUE_TAGS, MAX_TAG_HINT_LENGTH, TAG_CATALOGUE_DEFAULTS,
  enabledTagCatalogue, mergeAutoTags, parseTagCatalogue, pickAutoTags,
} from './conversationTagCatalogue.js';
import { MAX_TAGS } from './conversationTags.js';

const cat = (n: number) => Array.from({ length: n }, (_, i) => ({ tag: `tag${i}`, hint: `hint ${i}` }));
const noul = (n: number) => ({ type: 'noul', noul: n });

describe('built-in catalogue', () => {
  it('has 24 unique lowercase tags, all valid under the tag rules', () => {
    const tags = BUILTIN_TAG_CATALOGUE.map((b) => b.tag);
    expect(tags).toHaveLength(24);
    expect(new Set(tags).size).toBe(24);
    for (const b of BUILTIN_TAG_CATALOGUE) {
      expect(b.tag).toBe(b.tag.toLowerCase());
      expect(b.hint.length).toBeLessThanOrEqual(MAX_TAG_HINT_LENGTH);
    }
  });
});

describe('enabledTagCatalogue', () => {
  it('returns all built-ins by default, minus disabled, then customs', () => {
    expect(enabledTagCatalogue(TAG_CATALOGUE_DEFAULTS)).toHaveLength(24);
    const out = enabledTagCatalogue({ custom: [{ tag: 'mine', hint: 'h' }], disabledBuiltins: ['bug'] });
    expect(out.map((c) => c.tag)).not.toContain('bug');
    expect(out).toHaveLength(24);
    expect(out[out.length - 1]).toEqual({ tag: 'mine', hint: 'h' });
  });
});

describe('pickAutoTags', () => {
  it('keeps the top 3 by probability of five answers >= threshold', () => {
    const c = cat(6);
    const picked = pickAutoTags(c, {
      t0: noul(0.71), t1: noul(0.95), t2: noul(0.8), t3: noul(0.9), t4: noul(0.72), t5: noul(0.1),
    }, 0.7, 3);
    expect(picked).toEqual(['tag1', 'tag3', 'tag2']);
  });

  it('threshold is inclusive: 0.7 in, 0.69 out; nothing above -> empty', () => {
    const c = cat(2);
    expect(pickAutoTags(c, { t0: noul(0.7), t1: noul(0.69) }, 0.7, 3)).toEqual(['tag0']);
    expect(pickAutoTags(c, { t0: noul(0.5), t1: noul(0.1) }, 0.7, 3)).toEqual([]);
  });

  it('ties break by catalogue order', () => {
    expect(pickAutoTags(cat(3), { t2: noul(0.9), t0: noul(0.9), t1: noul(0.9) }, 0.7, 2)).toEqual(['tag0', 'tag1']);
  });

  it('ignores unknown, out-of-range, malformed keys and non-noul answers', () => {
    const c = cat(2);
    expect(pickAutoTags(c, {
      t99: noul(1), evil: noul(1), tx: noul(1), t: noul(1), '0': noul(1),
      t1: { type: 'choice' },
    }, 0.7, 3)).toEqual([]);
  });

  it('non-canonical alias keys (t01, t001, t00) never apply or crowd out real tags', () => {
    const c = cat(4);
    expect(pickAutoTags(c, {
      t0: noul(0.05), t1: noul(0.9), t01: noul(0.95), t001: noul(0.95), t2: noul(0.8), t00: noul(7),
    }, 0.7, 3)).toEqual(['tag1', 'tag2']);
  });

  it('exactly 4 answers over threshold -> only the top 3 applied', () => {
    expect(pickAutoTags(cat(4), { t0: noul(0.9), t1: noul(0.8), t2: noul(0.75), t3: noul(0.7) }, 0.7, 3))
      .toEqual(['tag0', 'tag1', 'tag2']);
  });
});

describe('mergeAutoTags', () => {
  it('appends picks after the operator tags', () => {
    expect(mergeAutoTags(['mine'], ['a', 'b'])).toEqual(['mine', 'a', 'b']);
  });
  it('caps at MAX_TAGS keeping operator tags intact', () => {
    const existing = Array.from({ length: 9 }, (_, i) => `op${i}`);
    const out = mergeAutoTags(existing, ['a', 'b', 'c']);
    expect(out).toHaveLength(MAX_TAGS);
    expect(out.slice(0, 9)).toEqual(existing);
    expect(out[9]).toBe('a');
  });
  it('dedupes case-insensitively', () => {
    expect(mergeAutoTags(['Bug'], ['bug', 'ui'])).toEqual(['Bug', 'ui']);
  });
});

describe('parseTagCatalogue', () => {
  const parse = (custom: unknown, disabledBuiltins: unknown = []) => parseTagCatalogue({ custom, disabledBuiltins });

  it('rejects non-objects and missing arrays', () => {
    for (const bad of [null, undefined, 'x', 5, [], { custom: [] }, { disabledBuiltins: [] }]) {
      expect(parseTagCatalogue(bad).ok).toBe(false);
    }
  });
  it('rejects a tag over 32 chars, control chars, or an empty tag', () => {
    expect(parse([{ tag: 'x'.repeat(32), hint: 'h' }]).ok).toBe(true);
    expect(parse([{ tag: 'x'.repeat(33), hint: 'h' }]).ok).toBe(false);
    expect(parse([{ tag: 'a\nb', hint: 'h' }]).ok).toBe(false);
    expect(parse([{ tag: '   ', hint: 'h' }]).ok).toBe(false);
    expect(parse([{ tag: 5, hint: 'h' }]).ok).toBe(false);
  });
  it('trims the tag and hint', () => {
    const r = parse([{ tag: '  mine  ', hint: '  why  ' }]);
    expect(r).toEqual({ ok: true, catalogue: { custom: [{ tag: 'mine', hint: 'why' }], disabledBuiltins: [] } });
  });
  it('rejects an empty, missing, over-long or control-char hint', () => {
    expect(parse([{ tag: 'a', hint: '  ' }]).ok).toBe(false);
    expect(parse([{ tag: 'a' }]).ok).toBe(false);
    expect(parse([{ tag: 'a', hint: 'x'.repeat(MAX_TAG_HINT_LENGTH + 1) }]).ok).toBe(false);
    expect(parse([{ tag: 'a', hint: 'x'.repeat(MAX_TAG_HINT_LENGTH) }]).ok).toBe(true);
    expect(parse([{ tag: 'a', hint: 'a\u0000b' }]).ok).toBe(false);
  });
  it('rejects a built-in (case-insensitive) and a case-insensitive duplicate', () => {
    expect(parse([{ tag: 'Bug', hint: 'h' }]).ok).toBe(false);
    expect(parse([{ tag: 'Mine', hint: 'h' }, { tag: 'mine', hint: 'h' }]).ok).toBe(false);
  });
  it('rejects more than the custom cap', () => {
    expect(parse(cat(MAX_CUSTOM_CATALOGUE_TAGS)).ok).toBe(true);
    expect(parse(cat(MAX_CUSTOM_CATALOGUE_TAGS + 1)).ok).toBe(false);
  });
  it('rejects an unknown disabledBuiltins entry; dedupes valid ones', () => {
    expect(parse([], ['nope']).ok).toBe(false);
    expect(parse([{ tag: 'mine', hint: 'h' }], ['mine']).ok).toBe(false);
    expect(parse([], [5]).ok).toBe(false);
    expect(parse([], ['bug', 'bug'])).toEqual({ ok: true, catalogue: { custom: [], disabledBuiltins: ['bug'] } });
  });
  it('lenient read drops stale disabledBuiltins and built-in-colliding customs, keeps the rest; strict rejects', () => {
    const doc = {
      custom: [{ tag: 'mine', hint: 'h' }, { tag: 'BUG', hint: 'h' }],
      disabledBuiltins: ['gone', 'ui', 'ui'],
    };
    expect(parseTagCatalogue(doc).ok).toBe(false);
    expect(parseTagCatalogue(doc, { lenient: true })).toEqual({
      ok: true, catalogue: { custom: [{ tag: 'mine', hint: 'h' }], disabledBuiltins: ['ui'] },
    });
    expect(parseTagCatalogue({ custom: 'x', disabledBuiltins: [] }, { lenient: true }).ok).toBe(false);
  });
  it('round-trips a valid document', () => {
    const doc = { custom: [{ tag: 'mine', hint: 'h' }], disabledBuiltins: ['bug', 'ui'] };
    expect(parseTagCatalogue(doc)).toEqual({ ok: true, catalogue: doc });
  });
});
