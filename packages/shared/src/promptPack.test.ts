import { describe, it, expect } from 'vitest';
import { PRESET_PROMPTS, PROMPT_NAME_MAX } from './promptCollection.js';
import {
  PROMPT_PACK_KIND,
  PROMPT_PACK_DOC_MAX_BYTES,
  PROMPT_PACK_MAX_PROMPTS,
  buildPromptPack,
  validatePromptPack,
} from './promptPack.js';

function validEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'My prompt',
    description: 'Does a thing',
    body: 'Do the thing.',
    origin: 'custom',
    ...overrides,
  };
}

function validPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: PROMPT_PACK_KIND,
    version: 1,
    prompts: [validEntry()],
    ...overrides,
  };
}

describe('validatePromptPack', () => {
  it('accepts a minimal valid pack', () => {
    const r = validatePromptPack(validPack());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.kind).toBe(PROMPT_PACK_KIND);
    expect(r.pack.version).toBe(1);
    expect(r.pack.prompts).toHaveLength(1);
    expect(r.pack.prompts[0].origin).toBe('custom');
    expect(r.pack.prompts[0].name).toBe('My prompt');
  });

  it('rejects the wrong kind', () => {
    const r = validatePromptPack(validPack({ kind: 'tierwyn-schedule-pack' }));
    expect(r).toEqual({ ok: false, error: 'not a Tierwyn prompt pack' });
  });

  it('rejects the wrong version', () => {
    const r = validatePromptPack(validPack({ version: 2 }));
    expect(r).toEqual({ ok: false, error: 'unsupported pack version' });
  });

  it('rejects missing prompts', () => {
    const r = validatePromptPack(validPack({ prompts: undefined }));
    expect(r).toEqual({ ok: false, error: 'prompts must be an array' });
  });

  it('rejects an empty prompts array', () => {
    const r = validatePromptPack(validPack({ prompts: [] }));
    expect(r).toEqual({ ok: false, error: 'prompts must contain at least 1 prompt' });
  });

  it('rejects more than 200 prompts', () => {
    const prompts = Array.from({ length: PROMPT_PACK_MAX_PROMPTS + 1 }, (_, i) =>
      validEntry({ name: `p${i}` }),
    );
    const r = validatePromptPack(validPack({ prompts }));
    expect(r).toEqual({ ok: false, error: `at most ${PROMPT_PACK_MAX_PROMPTS} prompts` });
  });

  it('rejects a document over 256 KiB', () => {
    const r = validatePromptPack(validPack({ padding: 'x'.repeat(PROMPT_PACK_DOC_MAX_BYTES) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/exceeds/);
  });

  it('surfaces a per-entry failure as prompts[i] and returns ok:false (atomic)', () => {
    const r = validatePromptPack(validPack({
      prompts: [
        validEntry({ name: 'one' }),
        validEntry({ name: 'two' }),
        validEntry({ name: '' }),
      ],
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('prompts[2]: name is required');
  });

  it("forces origin 'preset' to 'custom'", () => {
    const r = validatePromptPack(validPack({
      prompts: [validEntry({ origin: 'preset', id: 'abc-123' })],
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.prompts[0].origin).toBe('custom');
  });

  it("rejects an entry with id 'preset-x'", () => {
    const r = validatePromptPack(validPack({
      prompts: [validEntry({ id: 'preset-x' })],
    }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('prompts[0]: id cannot start with preset-');
  });

  it('rejects an over-long title', () => {
    const r = validatePromptPack(validPack({ title: 't'.repeat(PROMPT_NAME_MAX + 1) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/title must be/);
  });
});

describe('buildPromptPack', () => {
  it('round-trips variables through validatePromptPack byte-identical', () => {
    const entry = {
      id: 'abc-123',
      name: 'Scoped review',
      description: 'Review a named scope',
      body: 'Review {{scope}}',
      origin: 'custom' as const,
      variables: [{ name: 'scope', label: 'Scope', default: 'src/' }],
    };
    const pack = buildPromptPack([entry], 'My pack');
    const result = validatePromptPack(pack);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.stringify(result.pack.prompts[0].variables))
      .toBe(JSON.stringify(entry.variables));
    expect(result.pack.title).toBe('My pack');
  });

  it('strips a preset id and forces origin custom', () => {
    const preset = PRESET_PROMPTS[0];
    const pack = buildPromptPack([preset]);
    expect(pack.prompts[0].origin).toBe('custom');
    expect(pack.prompts[0].id).toBeUndefined();
    expect(pack.prompts[0].createdAt).toBeUndefined();
    expect(pack.prompts[0].updatedAt).toBeUndefined();
    const result = validatePromptPack(pack);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pack.prompts[0].origin).toBe('custom');
    expect(result.pack.prompts[0].id.startsWith('preset-')).toBe(false);
  });
});
