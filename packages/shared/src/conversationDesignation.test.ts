import { describe, it, expect } from 'vitest';
import {
  BUILTIN_DESIGNATIONS,
  MAX_CUSTOM_DESIGNATIONS,
  MAX_DESIGNATION_LENGTH,
  parseDesignationToken,
  parseOptionalDesignation,
  addCustomDesignation,
  removeCustomDesignation,
  designationCatalogue,
  isKnownDesignation,
  resolveSpawnDesignation,
} from './conversationDesignation.js';

describe('parseDesignationToken', () => {
  it('lowercases and accepts a builtin word', () => {
    expect(parseDesignationToken('Planner')).toEqual({ ok: true, token: 'planner' });
  });

  it('accepts a hyphenated word', () => {
    expect(parseDesignationToken('code-review')).toEqual({ ok: true, token: 'code-review' });
  });

  it('rejects spaces', () => {
    const r = parseDesignationToken('code review');
    expect(r.ok).toBe(false);
  });

  it('rejects empty after trim', () => {
    expect(parseDesignationToken('   ').ok).toBe(false);
  });

  it('rejects a leading hyphen or double hyphen', () => {
    expect(parseDesignationToken('-planner').ok).toBe(false);
    expect(parseDesignationToken('code--review').ok).toBe(false);
  });

  it('rejects a token longer than MAX_DESIGNATION_LENGTH', () => {
    expect(parseDesignationToken('a'.repeat(MAX_DESIGNATION_LENGTH + 1)).ok).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(parseDesignationToken(7).ok).toBe(false);
  });
});

describe('parseOptionalDesignation', () => {
  it('treats null, undefined and empty as unset', () => {
    expect(parseOptionalDesignation(null)).toEqual({ ok: true, token: null });
    expect(parseOptionalDesignation(undefined)).toEqual({ ok: true, token: null });
    expect(parseOptionalDesignation('')).toEqual({ ok: true, token: null });
    expect(parseOptionalDesignation('  ')).toEqual({ ok: true, token: null });
  });

  it('parses a present token', () => {
    expect(parseOptionalDesignation('Reviewer')).toEqual({ ok: true, token: 'reviewer' });
  });
});

describe('custom catalogue', () => {
  it('starts from the five builtins', () => {
    expect(BUILTIN_DESIGNATIONS).toEqual([
      'orchestrator', 'planner', 'implementer', 'reviewer', 'research',
    ]);
    expect(designationCatalogue([])).toEqual([...BUILTIN_DESIGNATIONS]);
  });

  it('appends customs after builtins and skips a custom that collides with a builtin', () => {
    const added = addCustomDesignation([], 'Auditor');
    expect(added).toEqual({ ok: true, custom: ['auditor'] });
    expect(designationCatalogue(added.ok ? added.custom : [])).toEqual([
      ...BUILTIN_DESIGNATIONS, 'auditor',
    ]);
    expect(addCustomDesignation(['auditor'], 'planner').ok).toBe(false);
  });

  it(`caps customs at ${MAX_CUSTOM_DESIGNATIONS}`, () => {
    let custom: string[] = [];
    for (let i = 0; i < MAX_CUSTOM_DESIGNATIONS; i++) {
      const r = addCustomDesignation(custom, `extra${i}`);
      expect(r.ok).toBe(true);
      if (r.ok) custom = r.custom;
    }
    expect(addCustomDesignation(custom, 'one-more').ok).toBe(false);
  });

  it('cannot delete a builtin', () => {
    expect(removeCustomDesignation(['auditor'], 'planner').ok).toBe(false);
  });

  it('deletes a custom without rewriting the rest', () => {
    expect(removeCustomDesignation(['auditor', 'notify'], 'auditor'))
      .toEqual({ ok: true, custom: ['notify'] });
  });
});

describe('isKnownDesignation / resolveSpawnDesignation', () => {
  it('knows builtins even with empty customs', () => {
    expect(isKnownDesignation('planner', [])).toBe(true);
    expect(isKnownDesignation('auditor', [])).toBe(false);
    expect(isKnownDesignation('auditor', ['auditor'])).toBe(true);
  });

  it('uses a catalogue pick when requested', () => {
    expect(resolveSpawnDesignation({ requested: 'planner', custom: [] }))
      .toEqual({ ok: true, token: 'planner' });
  });

  it('rejects an unknown requested token', () => {
    expect(resolveSpawnDesignation({ requested: 'auditor', custom: [] }).ok).toBe(false);
  });

  it('falls back to a live role default when spawn omits the field', () => {
    expect(resolveSpawnDesignation({
      roleDefault: 'planner',
      custom: [],
    })).toEqual({ ok: true, token: 'planner' });
  });

  it('ignores a stale role default that left the catalogue', () => {
    expect(resolveSpawnDesignation({
      roleDefault: 'auditor',
      custom: [],
    })).toEqual({ ok: true, token: undefined });
  });

  it('explicit empty requested clears a role default', () => {
    expect(resolveSpawnDesignation({
      requested: '',
      roleDefault: 'planner',
      custom: [],
    })).toEqual({ ok: true, token: undefined });
  });
});
