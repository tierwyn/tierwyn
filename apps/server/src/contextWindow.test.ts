import { describe, it, expect } from 'vitest';
import { normaliseContextWindow, resolveContextWindowWithFallback } from './contextWindow.js';

describe('normaliseContextWindow', () => {
  it('keeps positive finite integers', () => {
    expect(normaliseContextWindow(1_000_000)).toBe(1_000_000);
    expect(normaliseContextWindow(128_000)).toBe(128_000);
  });

  it('floors fractional values', () => {
    expect(normaliseContextWindow(200_000.7)).toBe(200_000);
  });

  it('maps unknown / non-positive / non-finite to null (never a fake 0)', () => {
    expect(normaliseContextWindow(undefined)).toBeNull();
    expect(normaliseContextWindow(null)).toBeNull();
    expect(normaliseContextWindow(0)).toBeNull();
    expect(normaliseContextWindow(-1)).toBeNull();
    expect(normaliseContextWindow(Number.NaN)).toBeNull();
    expect(normaliseContextWindow(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('resolveContextWindowWithFallback', () => {
  const live = (models: { name: string; contextWindow?: number }[]) => async () => models;

  it('uses the live listModels hit when present', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'GLM-5.2',
      storedContextWindow: 128_000,
      listModels: live([{ name: 'GLM-5.2', contextWindow: 1_000_000 }]),
    });
    expect(got).toBe(1_000_000);
  });

  it('prefers a live hit over a stale stored value (live is fresher)', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'claude-opus-5',
      storedContextWindow: 200_000,          // stale catalogue row
      listModels: live([{ name: 'claude-opus-5', contextWindow: 1_000_000 }]),
    });
    expect(got).toBe(1_000_000);
  });

  it('falls back to the stored window when listModels returns []', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'GLM-5.2',
      storedContextWindow: 1_000_000,
      listModels: live([]),
    });
    expect(got).toBe(1_000_000);
  });

  it('falls back to the stored window when listModels throws', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'ollama/qwen',
      storedContextWindow: 128_000,
      listModels: async () => { throw new Error('CLI not on PATH'); },
    });
    expect(got).toBe(128_000);
  });

  it('falls back to the stored window when the live list omits the model', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'GLM-5.2',
      storedContextWindow: 1_000_000,
      listModels: live([{ name: 'some-other-model', contextWindow: 400_000 }]),
    });
    expect(got).toBe(1_000_000);
  });

  it('prefers the stored window over the naming default', async () => {
    // claude-sonnet-* would regex-default to 200k; a persisted 1M must win,
    // otherwise a guess beats an adapter-advertised number.
    const got = await resolveContextWindowWithFallback({
      modelName: 'claude-sonnet-4-6',
      storedContextWindow: 1_000_000,
      listModels: live([]),
    });
    expect(got).toBe(1_000_000);
  });

  it('falls back to the naming default when nothing is stored', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'claude-opus-5',
      storedContextWindow: undefined,
      listModels: live([]),
    });
    expect(got).toBe(1_000_000);
  });

  it('ignores a non-positive stored window instead of returning a fake 0', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'claude-sonnet-4-6',
      storedContextWindow: 0,
      listModels: live([]),
    });
    expect(got).toBe(200_000);   // naming default, not 0
  });

  it('returns undefined when live, stored and naming all miss (no fabrication)', async () => {
    const got = await resolveContextWindowWithFallback({
      modelName: 'ollama/qwen',
      storedContextWindow: undefined,
      listModels: live([]),
    });
    expect(got).toBeUndefined();
  });
});
