import { describe, it, expect } from 'vitest';
import { BUILTIN_TAG_CATALOGUE } from '@tierwyn/shared';
import { enabledBuiltins, disabledFromEnabled } from './TagCatalogueSettings.js';

const ALL_TAGS: string[] = BUILTIN_TAG_CATALOGUE.map((b) => b.tag);

describe('enabledBuiltins / disabledFromEnabled', () => {
  it('round-trips through BUILTIN_TAG_CATALOGUE in built-in order', () => {
    const disabled = ['bug', 'ui', 'personal'];
    const enabled = enabledBuiltins(BUILTIN_TAG_CATALOGUE, disabled);
    expect(enabled).not.toContain('bug');
    expect(enabled).not.toContain('ui');
    expect(enabled).not.toContain('personal');
    expect(enabled[0]).toBe('feature');
    expect(enabled).toEqual(ALL_TAGS.filter((t) => !disabled.includes(t)));
    expect(disabledFromEnabled(BUILTIN_TAG_CATALOGUE, enabled)).toEqual(disabled);
  });

  it('never emits a non-built-in, even if enabled contains junk', () => {
    const disabled = disabledFromEnabled(BUILTIN_TAG_CATALOGUE, ['bug', 'not-a-tag', 'ui']);
    expect(disabled).not.toContain('not-a-tag');
    expect(disabled.every((t) => ALL_TAGS.includes(t))).toBe(true);
    expect(disabled).not.toContain('bug');
    expect(disabled).not.toContain('ui');
  });

  it('all enabled → [] and none enabled → every built-in', () => {
    expect(disabledFromEnabled(BUILTIN_TAG_CATALOGUE, ALL_TAGS)).toEqual([]);
    expect(enabledBuiltins(BUILTIN_TAG_CATALOGUE, [])).toEqual(ALL_TAGS);
    expect(disabledFromEnabled(BUILTIN_TAG_CATALOGUE, [])).toEqual(ALL_TAGS);
    expect(enabledBuiltins(BUILTIN_TAG_CATALOGUE, ALL_TAGS)).toEqual([]);
  });
});
