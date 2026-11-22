import { describe, it, expect, vi } from 'vitest';
import {
  PRESET_PROMPTS,
  PROMPT_BODY_MAX,
  PROMPT_VAR_NAME_RE,
  PROMPT_VARS_MAX,
  PROMPT_VAR_LABEL_MAX,
  PROMPT_VAR_DEFAULT_MAX,
  parsePromptVariables,
  resolvePromptVariables,
  substitutePromptVariables,
  validateCustomPrompt,
} from './promptCollection.js';

describe('PRESET_PROMPTS', () => {
  it('has unique ids all prefixed with preset-', () => {
    const ids = PRESET_PROMPTS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(id.startsWith('preset-')).toBe(true);
    }
  });

  it('every preset has non-empty fields and origin preset', () => {
    for (const p of PRESET_PROMPTS) {
      expect(p.name.trim()).not.toBe('');
      expect(p.description.trim()).not.toBe('');
      expect(p.body.trim()).not.toBe('');
      expect(p.origin).toBe('preset');
    }
  });

  it('no preset body starts with /', () => {
    for (const p of PRESET_PROMPTS) {
      expect(p.body.trimStart().startsWith('/')).toBe(false);
    }
  });

  it('every body token is declared and every declared variable appears in the body', () => {
    for (const p of PRESET_PROMPTS) {
      const inBody = parsePromptVariables(p.body).sort();
      const declared = (p.variables ?? []).map((v) => v.name).sort();
      expect({ id: p.id, declared }).toEqual({ id: p.id, declared: inBody });
    }
  });

  it('preset variable metadata respects the name pattern and the limits', () => {
    for (const p of PRESET_PROMPTS) {
      const vars = p.variables ?? [];
      expect(vars.length).toBeLessThanOrEqual(PROMPT_VARS_MAX);
      expect(new Set(vars.map((v) => v.name)).size).toBe(vars.length);
      for (const v of vars) {
        expect(v.name).toMatch(PROMPT_VAR_NAME_RE);
        if (v.label !== undefined) {
          expect(v.label.length).toBeGreaterThan(0);
          expect(v.label.length).toBeLessThanOrEqual(PROMPT_VAR_LABEL_MAX);
        }
        if (v.default !== undefined) {
          expect(new TextEncoder().encode(v.default).length)
            .toBeLessThanOrEqual(PROMPT_VAR_DEFAULT_MAX);
        }
      }
      expect(new TextEncoder().encode(p.body).length).toBeLessThanOrEqual(PROMPT_BODY_MAX);
    }
  });

  it('marks roster role variables on the delegation presets, leaving task/subject as free text', () => {
    const pipeline = PRESET_PROMPTS.find((p) => p.id === 'preset-orchestrate-pipeline');
    expect(pipeline).toBeDefined();
    const pipelineByName = Object.fromEntries((pipeline?.variables ?? []).map((v) => [v.name, v]));
    expect(pipelineByName.task?.source).toBeUndefined();
    expect(pipelineByName.planner?.source).toBe('roster');
    expect(pipelineByName.implementer?.source).toBe('roster');
    expect(pipelineByName.reviewer?.source).toBe('roster');

    const feature = PRESET_PROMPTS.find((p) => p.id === 'preset-orch-add-feature');
    expect(feature).toBeDefined();
    const featureByName = Object.fromEntries((feature?.variables ?? []).map((v) => [v.name, v]));
    expect(featureByName.feature?.source).toBeUndefined();
    expect(featureByName.planner?.source).toBe('roster');
    expect(featureByName.implementer?.source).toBe('roster');
    expect(featureByName.reviewer?.source).toBe('roster');

    const review = PRESET_PROMPTS.find((p) => p.id === 'preset-adversarial-review');
    expect(review).toBeDefined();
    const reviewByName = Object.fromEntries((review?.variables ?? []).map((v) => [v.name, v]));
    expect(reviewByName.subject?.source).toBeUndefined();
    expect(reviewByName.reviewer?.source).toBe('roster');

    const survey = PRESET_PROMPTS.find((p) => p.id === 'preset-roster-survey');
    expect(survey).toBeDefined();
    expect((survey?.variables ?? []).every((v) => v.source === undefined)).toBe(true);

    const spec = PRESET_PROMPTS.find((p) => p.id === 'preset-write-feature-spec');
    expect(spec).toBeDefined();
    const specByName = Object.fromEntries((spec?.variables ?? []).map((v) => [v.name, v]));
    expect(specByName.feature?.source).toBeUndefined();
    expect(specByName.grill?.source).toBeUndefined();
    expect(specByName.grill?.default).toBeUndefined();
    expect(spec?.body).toMatch(/not an implementation plan/i);
  });

  it('substitutes filled values into a preset, leaving no tokens behind', () => {
    const preset = PRESET_PROMPTS.find((p) => p.id === 'preset-dependency-upgrade');
    expect(preset).toBeDefined();
    if (!preset) return;
    const filled = substitutePromptVariables(preset.body, {
      dependency: 'better-sqlite3',
      target_version: '12.0.0',
    });
    expect(filled).toContain('Upgrade better-sqlite3 to 12.0.0.');
    expect(parsePromptVariables(filled)).toEqual([]);
  });
});

describe('validateCustomPrompt', () => {
  it('accepts a valid custom prompt and forces origin custom', () => {
    const result = validateCustomPrompt({
      name: 'My prompt',
      description: 'Does a thing',
      body: 'Do the thing.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.origin).toBe('custom');
    expect(result.prompt.name).toBe('My prompt');
    expect(result.prompt.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(result.prompt.createdAt).toBeTypeOf('number');
    expect(result.prompt.updatedAt).toBeTypeOf('number');
  });

  it('mints a non-UUID id when crypto.randomUUID is unavailable (plain-HTTP preview path)', () => {
    vi.stubGlobal('crypto', {});
    try {
      const result = validateCustomPrompt({ name: 'n', description: 'd', body: 'b' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prompt.id).toMatch(/^prompt-[0-9a-z]+-[0-9a-z]+$/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects empty name', () => {
    const result = validateCustomPrompt({
      name: '   ',
      description: 'desc',
      body: 'body',
    });
    expect(result).toEqual({ ok: false, error: 'name is required' });
  });

  it('rejects over-long body', () => {
    const result = validateCustomPrompt({
      name: 'n',
      description: 'd',
      body: 'x'.repeat(PROMPT_BODY_MAX + 1),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/body must be/);
  });

  it('rejects id starting with preset-', () => {
    const result = validateCustomPrompt({
      id: 'preset-fake',
      name: 'n',
      description: 'd',
      body: 'b',
    });
    expect(result).toEqual({ ok: false, error: 'id cannot start with preset-' });
  });

  it('preserves provided id and createdAt on edit-shaped input', () => {
    const createdAt = 1_700_000_000_000;
    const result = validateCustomPrompt({
      id: 'abc-123',
      name: 'Edited',
      description: 'desc',
      body: 'body',
      createdAt,
      origin: 'preset',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.id).toBe('abc-123');
    expect(result.prompt.createdAt).toBe(createdAt);
    expect(result.prompt.origin).toBe('custom');
  });
});

describe('parsePromptVariables', () => {
  it('returns [] for a body with no braces', () => {
    expect(parsePromptVariables('plain text, no tokens')).toEqual([]);
  });

  it('matches letter-first identifiers and preserves first-appearance order, deduped', () => {
    expect(parsePromptVariables('{{b}} then {{a}} then {{b}} then {{a_1}} {{Z9}}'))
      .toEqual(['b', 'a', 'a_1', 'Z9']);
  });

  it('matches {{a}} {{a_1}} {{Z9}}', () => {
    expect(parsePromptVariables('{{a}} {{a_1}} {{Z9}}')).toEqual(['a', 'a_1', 'Z9']);
  });

  it('ignores spaced, handlebars, dollar, digit-first, hyphen, empty, over-long, and triple-stache', () => {
    const long33 = 'A' + 'b'.repeat(32);
    const body = [
      '{{ spaced }}',
      '{{#if x}}',
      '{{$ref}}',
      '{{9lives}}',
      '{{a-b}}',
      '{{}}',
      `{{${long33}}}`,
      '{{{raw}}}',
    ].join(' ');
    expect(parsePromptVariables(body)).toEqual([]);
  });

  it('accepts a 32-char identifier (the regex ceiling)', () => {
    const max = 'A' + 'b'.repeat(31);
    expect(parsePromptVariables(`use {{${max}}}`)).toEqual([max]);
  });
});

describe('substitutePromptVariables', () => {
  it('replaces every occurrence of a repeated token', () => {
    expect(substitutePromptVariables('{{a}} and {{a}}', { a: 'x' })).toBe('x and x');
  });

  it('replaces an unknown name with empty string', () => {
    expect(substitutePromptVariables('{{a}}{{b}}', { a: 'x' })).toBe('x');
  });

  it('emits a value containing {{other}} literally and does not re-expand (single-pass)', () => {
    expect(substitutePromptVariables('Hello {{name}}', {
      name: 'x{{other}}y',
      other: 'BOOM',
    })).toBe('Hello x{{other}}y');
  });

  it('leaves non-matching brace text byte-identical', () => {
    const body = '{{ spaced }} {{#if x}} {{$ref}} keep';
    expect(substitutePromptVariables(body, { spaced: 'nope', if: 'nope' })).toBe(body);
  });

  it('does not share lastIndex state with parsePromptVariables', () => {
    const body = '{{a}} {{b}} {{a}}';
    expect(parsePromptVariables(body)).toEqual(['a', 'b']);
    expect(substitutePromptVariables(body, { a: '1', b: '2' })).toBe('1 2 1');
    expect(parsePromptVariables(body)).toEqual(['a', 'b']);
  });

  it('treats prototype-named variables ({{constructor}}) as unknown, not as inherited members', () => {
    expect(substitutePromptVariables('A {{constructor}} B', {})).toBe('A  B');
    expect(substitutePromptVariables('A {{toString}} B', {})).toBe('A  B');
    expect(substitutePromptVariables('A {{valueOf}} B', {})).toBe('A  B');
  });
});

describe('resolvePromptVariables', () => {
  it('uses body order over metadata order and enriches by name', () => {
    const resolved = resolvePromptVariables({
      body: 'see {{b}} then {{a}}',
      variables: [
        { name: 'a', label: 'Alpha', default: '1' },
        { name: 'b', label: 'Beta' },
      ],
    });
    expect(resolved).toEqual([
      { name: 'b', label: 'Beta' },
      { name: 'a', label: 'Alpha', default: '1' },
    ]);
  });

  it('excludes orphan metadata', () => {
    const resolved = resolvePromptVariables({
      body: 'only {{keep}}',
      variables: [
        { name: 'keep', label: 'Keep' },
        { name: 'gone', label: 'Gone' },
      ],
    });
    expect(resolved).toEqual([{ name: 'keep', label: 'Keep' }]);
  });

  it('yields name-only descriptors when entry has no variables key', () => {
    expect(resolvePromptVariables({ body: 'hi {{scope}}' })).toEqual([{ name: 'scope' }]);
  });

  it('carries source: roster through onto the returned descriptor', () => {
    expect(resolvePromptVariables({
      body: 'ask {{planner}} to do {{task}}',
      variables: [
        { name: 'planner', label: 'Planner', default: 'Claude Opus 5 Planner', source: 'roster' },
        { name: 'task', label: 'Task' },
      ],
    })).toEqual([
      { name: 'planner', label: 'Planner', default: 'Claude Opus 5 Planner', source: 'roster' },
      { name: 'task', label: 'Task' },
    ]);
  });
});

describe('validateCustomPrompt variables', () => {
  const base = { name: 'n', description: 'd', body: 'Hello {{scope}}' };

  it('accepts a valid variables array', () => {
    const result = validateCustomPrompt({
      ...base,
      variables: [{ name: 'scope', label: 'Scope', default: 'src/' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.variables).toEqual([{ name: 'scope', label: 'Scope', default: 'src/' }]);
  });

  it('rejects a non-array variables field', () => {
    expect(validateCustomPrompt({ ...base, variables: { name: 'scope' } }))
      .toEqual({ ok: false, error: 'variables must be an array' });
  });

  it('rejects more than 16 declared variables', () => {
    const variables = Array.from({ length: PROMPT_VARS_MAX + 1 }, (_, i) => ({ name: `v${i}` }));
    expect(validateCustomPrompt({ ...base, body: 'x', variables }))
      .toEqual({ ok: false, error: 'at most 16 variables' });
  });

  it('rejects a missing name', () => {
    expect(validateCustomPrompt({ ...base, variables: [{}] }))
      .toEqual({ ok: false, error: 'variables[0].name required' });
  });

  it('rejects a name that fails the identifier pattern', () => {
    expect(validateCustomPrompt({ ...base, variables: [{ name: '9lives' }] }))
      .toEqual({ ok: false, error: 'variables[0].name must match ^[A-Za-z][A-Za-z0-9_]{0,31}$' });
  });

  it('rejects a duplicate name', () => {
    expect(validateCustomPrompt({
      ...base,
      variables: [{ name: 'scope' }, { name: 'scope' }],
    })).toEqual({ ok: false, error: 'variables: duplicate name "scope"' });
  });

  it('rejects an over-long label', () => {
    expect(validateCustomPrompt({
      ...base,
      variables: [{ name: 'scope', label: 'x'.repeat(PROMPT_VAR_LABEL_MAX + 1) }],
    })).toEqual({ ok: false, error: 'variables[0].label must be ≤ 60 characters' });
  });

  it('rejects an over-long default', () => {
    expect(validateCustomPrompt({
      ...base,
      variables: [{ name: 'scope', default: 'x'.repeat(PROMPT_VAR_DEFAULT_MAX + 1) }],
    })).toEqual({ ok: false, error: 'variables[0].default must be ≤ 500 bytes' });
  });

  it('drops metadata whose name is absent from the body', () => {
    const result = validateCustomPrompt({
      ...base,
      variables: [
        { name: 'scope', label: 'Scope' },
        { name: 'gone', label: 'Gone' },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.variables).toEqual([{ name: 'scope', label: 'Scope' }]);
  });

  it('strips unknown keys on a variable', () => {
    const result = validateCustomPrompt({
      ...base,
      variables: [{ name: 'scope', label: 'Scope', type: 'select', help: 'nope' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.variables).toEqual([{ name: 'scope', label: 'Scope' }]);
  });

  it('round-trips an entry with no variables key unchanged (backward compat)', () => {
    const result = validateCustomPrompt({
      name: 'My prompt',
      description: 'Does a thing',
      body: 'Do the thing.',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.variables).toBeUndefined();
  });

  it('round-trips source: roster through validateCustomPrompt', () => {
    const result = validateCustomPrompt({
      ...base,
      variables: [{ name: 'scope', label: 'Scope', default: 'src/', source: 'roster' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.variables).toEqual([
      { name: 'scope', label: 'Scope', default: 'src/', source: 'roster' },
    ]);
  });

  it('keeps a source: roster variable that has no label or default', () => {
    const result = validateCustomPrompt({
      ...base,
      variables: [{ name: 'scope', source: 'roster' }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prompt.variables).toEqual([{ name: 'scope', source: 'roster' }]);
  });

  it('drops a non-roster source silently while the rest of the variable survives', () => {
    for (const source of ['select', 1, { kind: 'roster' }, '', 'Roster']) {
      const result = validateCustomPrompt({
        ...base,
        variables: [{ name: 'scope', label: 'Scope', default: 'src/', source }],
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.prompt.variables).toEqual([{ name: 'scope', label: 'Scope', default: 'src/' }]);
    }
  });
});
