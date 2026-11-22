import { describe, it, expect } from 'vitest';
import {
  validateSchedulePack,
  jobNameToSlug,
  PACK_PROMPT_MAX_BYTES,
  PACK_STEPS_MAX,
  PACK_SLUG_RE,
  PACK_DOC_MAX_BYTES,
} from './packs.js';

function validPack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'verify-after-change',
    title: 'Verify after change',
    description: 'Delayed verification.',
    version: 1,
    origin: 'shipped',
    job: {
      cadence: { kind: 'once', fireInMs: 3_600_000 },
      promptTemplate: 'Verify [[goal]].',
    },
    ...overrides,
  };
}

describe('PACK_SLUG_RE', () => {
  it('accepts a kebab slug up to 48 chars starting with alphanumeric', () => {
    expect(PACK_SLUG_RE.test('a')).toBe(true);
    expect(PACK_SLUG_RE.test('verify-after-change')).toBe(true);
    expect(PACK_SLUG_RE.test('a'.repeat(48))).toBe(true);
  });

  it('rejects empty, uppercase, underscore, or 49 chars', () => {
    expect(PACK_SLUG_RE.test('')).toBe(false);
    expect(PACK_SLUG_RE.test('ABC')).toBe(false);
    expect(PACK_SLUG_RE.test('a_b')).toBe(false);
    expect(PACK_SLUG_RE.test('a'.repeat(49))).toBe(false);
    expect(PACK_SLUG_RE.test('-abc')).toBe(false);
  });
});

describe('jobNameToSlug', () => {
  it('strips a leading [prefix] and kebab-cases the rest', () => {
    expect(jobNameToSlug('[feature-wave] Tierwyn evolve wave', 'feature-wave'))
      .toBe('tierwyn-evolve-wave');
  });

  it('collapses punctuation and trims hyphens', () => {
    expect(jobNameToSlug('Docs / Campaign!!', 'feature-wave')).toBe('docs-campaign');
  });

  it('falls back to the pack slug for a non-latin name', () => {
    expect(jobNameToSlug('日本語タイトル', 'feature-wave')).toBe('feature-wave');
  });

  it('falls back when the name is punctuation-only', () => {
    expect(jobNameToSlug('!!!', 'pr-review')).toBe('pr-review');
  });

  it('caps at 48 characters', () => {
    const long = 'word-'.repeat(20);
    const slug = jobNameToSlug(long, 'pack');
    expect(slug.length).toBeLessThanOrEqual(48);
    expect(PACK_SLUG_RE.test(slug)).toBe(true);
  });
});

describe('validateSchedulePack', () => {
  it('accepts a minimal valid document and normalises it', () => {
    const r = validateSchedulePack(validPack());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.slug).toBe('verify-after-change');
    expect(r.pack.title).toBe('Verify after change');
    expect(r.pack.job.cadence).toEqual({ kind: 'once', fireInMs: 3_600_000 });
    expect(r.pack.job.promptTemplate).toBe('Verify [[goal]].');
  });

  it('rejects a missing required field', () => {
    expect(validateSchedulePack(validPack({ slug: undefined })).ok).toBe(false);
    expect(validateSchedulePack(validPack({ title: undefined })).ok).toBe(false);
    expect(validateSchedulePack({ slug: 'a', title: 't' }).ok).toBe(false);
    const noPrompt = validPack();
    (noPrompt.job as Record<string, unknown>).promptTemplate = undefined;
    expect(validateSchedulePack(noPrompt).ok).toBe(false);
    const noCadence = validPack();
    (noCadence.job as Record<string, unknown>).cadence = undefined;
    expect(validateSchedulePack(noCadence).ok).toBe(false);
  });

  it('ignores and strips unknown optional keys', () => {
    const r = validateSchedulePack(validPack({ extra: 'nope', editorColor: '#f00' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack).not.toHaveProperty('extra');
    expect(r.pack).not.toHaveProperty('editorColor');
  });

  it('rejects a bad slug', () => {
    const r = validateSchedulePack(validPack({ slug: 'NOT_VALID' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/slug/);
  });

  it('rejects an oversize promptTemplate', () => {
    const r = validateSchedulePack(validPack({
      job: {
        cadence: { kind: 'once', fireInMs: 60_000 },
        promptTemplate: 'x'.repeat(PACK_PROMPT_MAX_BYTES + 1),
      },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/promptTemplate/);
  });

  it('rejects more than PACK_STEPS_MAX steps', () => {
    const steps = Array.from({ length: PACK_STEPS_MAX + 1 }, (_, i) => ({
      title: `S${i}`, body: 'b',
    }));
    const r = validateSchedulePack(validPack({
      job: {
        cadence: { kind: 'once', fireInMs: 60_000 },
        promptTemplate: 'p',
        steps,
      },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/steps/);
  });

  it('rejects cadence.everyMs below the 5-minute floor', () => {
    const r = validateSchedulePack(validPack({
      job: {
        cadence: { kind: 'interval', everyMs: 299_999 },
        promptTemplate: 'p',
      },
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/everyMs/);
  });

  it('forces origin to imported even when the document says shipped', () => {
    const r = validateSchedulePack(validPack({ origin: 'shipped' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.origin).toBe('imported');
  });

  it('keeps valid job.variables and rejects invalid ones', () => {
    const ok = validateSchedulePack(validPack({
      job: {
        cadence: { kind: 'once', fireInMs: 60_000 },
        promptTemplate: 'p',
        variables: { stages: 'plan,implement,review', commitOnTick: 'true', mode: 'closed' },
      },
    }));
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.pack.job.variables).toEqual({
        stages: 'plan,implement,review',
        commitOnTick: 'true',
        mode: 'closed',
      });
    }

    const bad = validateSchedulePack(validPack({
      job: {
        cadence: { kind: 'once', fireInMs: 60_000 },
        promptTemplate: 'p',
        variables: { 'bad-key': 'x' },
      },
    }));
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^job.variables:/);
  });

  it('accepts a steer of exactly PACK_PROMPT_MAX_BYTES and rejects over', () => {
    const ok = validateSchedulePack(validPack({
      job: {
        cadence: { kind: 'once', fireInMs: 60_000 },
        promptTemplate: 'p',
        steer: 's'.repeat(PACK_PROMPT_MAX_BYTES),
      },
    }));
    expect(ok.ok).toBe(true);
    const bad = validateSchedulePack(validPack({
      job: {
        cadence: { kind: 'once', fireInMs: 60_000 },
        promptTemplate: 'p',
        steer: 's'.repeat(PACK_PROMPT_MAX_BYTES + 1),
      },
    }));
    expect(bad.ok).toBe(false);
  });

  it('rejects a whole document over PACK_DOC_MAX_BYTES', () => {
    const r = validateSchedulePack(validPack({
      junk: 'x'.repeat(PACK_DOC_MAX_BYTES),
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/too large|256|document/i);
  });

  it('rejects duplicate file kinds and oversize file bodies', () => {
    const dup = validateSchedulePack(validPack({
      files: [
        { kind: 'prompt', body: 'a' },
        { kind: 'prompt', body: 'b' },
      ],
    }));
    expect(dup.ok).toBe(false);
    const over = validateSchedulePack(validPack({
      files: [{ kind: 'prompt', body: 'y'.repeat(65_537) }],
    }));
    expect(over.ok).toBe(false);
  });

  it('defaults a missing description to empty and version to 1', () => {
    const doc = validPack();
    delete doc.description;
    delete doc.version;
    const r = validateSchedulePack(doc);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.description).toBe('');
    expect(r.pack.version).toBe(1);
  });

  describe('requiredStages', () => {
    it('accepts valid requiredStages and normalises onto the pack', () => {
      const r = validateSchedulePack(validPack({ requiredStages: ['plan', 'implement'] }));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pack.requiredStages).toEqual(['plan', 'implement']);
    });

    it('omits requiredStages when undefined', () => {
      const r = validateSchedulePack(validPack());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.pack.requiredStages).toBeUndefined();
    });

    it('rejects non-array requiredStages', () => {
      const r = validateSchedulePack(validPack({ requiredStages: 'implement' }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/must be an array/);
    });

    it('rejects more than PIPELINE_MAX_STAGES stages', () => {
      const r = validateSchedulePack(validPack({
        requiredStages: ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9'],
      }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/≤ 8/);
    });

    it('rejects invalid stage ids', () => {
      const r = validateSchedulePack(validPack({ requiredStages: ['Plan'] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/must match/);
    });

    it('rejects duplicate stage ids', () => {
      const r = validateSchedulePack(validPack({ requiredStages: ['plan', 'plan'] }));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/duplicate stage/);
    });
  });
});
