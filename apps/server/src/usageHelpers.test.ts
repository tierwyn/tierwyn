import { describe, it, expect } from 'vitest';
import {
  contextWindowOccupancy,
  computeContextWindowPct,
  windowSizeForModel,
  defaultContextWindowForModel,
  resolveContextWindowSize,
} from '@tierwyn/shared';

describe('contextWindowOccupancy', () => {
  it('sums input + cache_read + cache_creation', () => {
    expect(
      contextWindowOccupancy({ inputTokens: 1000, cacheReadTokens: 90000, cacheCreationTokens: 9000 }),
    ).toBe(100000);
  });

  it('treats missing fields as zero', () => {
    expect(contextWindowOccupancy({})).toBe(0);
    expect(contextWindowOccupancy({ inputTokens: 500 })).toBe(500);
  });
});

describe('computeContextWindowPct', () => {
  it('rounds occupancy / size to a clamped percentage', () => {
    expect(computeContextWindowPct(100000, 200000)).toBe(50);
    expect(computeContextWindowPct(50000, 200000)).toBe(25);
    expect(computeContextWindowPct(250000, 200000)).toBe(100); // clamped
  });

  it('returns undefined when the window size is unknown or non-positive', () => {
    expect(computeContextWindowPct(1000, undefined)).toBeUndefined();
    expect(computeContextWindowPct(1000, 0)).toBeUndefined();
    expect(computeContextWindowPct(1000, -1)).toBeUndefined();
  });

  it('returns undefined when occupancy is not finite or negative', () => {
    expect(computeContextWindowPct(Number.NaN, 200000)).toBeUndefined();
    expect(computeContextWindowPct(-1, 200000)).toBeUndefined();
  });
});

describe('windowSizeForModel', () => {
  it('finds the matching model', () => {
    expect(
      windowSizeForModel(
        [
          { name: 'a', contextWindow: 100 },
          { name: 'b', contextWindow: 200000 },
        ],
        'b',
      ),
    ).toBe(200000);
  });

  it('returns undefined when the model is not listed', () => {
    expect(windowSizeForModel([{ name: 'a', contextWindow: 100 }], 'z')).toBeUndefined();
  });
});

describe('defaultContextWindowForModel', () => {
  it('returns 1M for opus/fable-class Anthropic models', () => {
    expect(defaultContextWindowForModel('claude-opus-5')).toBe(1_000_000);
    expect(defaultContextWindowForModel('claude-fable-5')).toBe(1_000_000);
  });

  it('returns 200k for sonnet/haiku-class Anthropic models', () => {
    expect(defaultContextWindowForModel('claude-sonnet-4-6')).toBe(200_000);
    expect(defaultContextWindowForModel('claude-haiku-4-5')).toBe(200_000);
  });

  it('returns undefined for unrelated model ids', () => {
    expect(defaultContextWindowForModel('GLM-5.1')).toBeUndefined();
  });
});

describe('resolveContextWindowSize', () => {
  it('prefers listModels metadata over naming fallback', () => {
    expect(
      resolveContextWindowSize([{ name: 'claude-opus-5', contextWindow: 500_000 }], 'claude-opus-5'),
    ).toBe(500_000);
  });

  it('falls back to naming heuristics when the model is absent from listModels', () => {
    expect(resolveContextWindowSize([], 'claude-opus-5')).toBe(1_000_000);
  });
});
