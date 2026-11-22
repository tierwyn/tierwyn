import { describe, it, expect } from 'vitest';
import { shouldInjectPreamble } from './preamble-gate.js';

const prof = (over: Partial<{ maxConcurrentSpawns: number; maxGrandchildSpawns: number }>) =>
  ({ maxConcurrentSpawns: 0, maxGrandchildSpawns: 0, ...over } as any);

describe('shouldInjectPreamble', () => {
  it('root with a template and concurrency budget injects', () => {
    expect(shouldInjectPreamble({ depth: 0, hasTemplate: true, maxDepth: 2, profile: prof({ maxConcurrentSpawns: 2 }) })).toBe(true);
  });
  it('child injects only when maxGrandchildSpawns > 0', () => {
    expect(shouldInjectPreamble({ depth: 1, hasTemplate: true, maxDepth: 2, profile: prof({ maxGrandchildSpawns: 0 }) })).toBe(false);
    expect(shouldInjectPreamble({ depth: 1, hasTemplate: true, maxDepth: 2, profile: prof({ maxGrandchildSpawns: 3 }) })).toBe(true);
  });
  it('no template never injects', () => {
    expect(shouldInjectPreamble({ depth: 0, hasTemplate: false, maxDepth: 2, profile: prof({ maxConcurrentSpawns: 9 }) })).toBe(false);
  });
  it('at or past the depth ceiling never injects', () => {
    expect(shouldInjectPreamble({ depth: 2, hasTemplate: true, maxDepth: 2, profile: prof({ maxGrandchildSpawns: 9 }) })).toBe(false);
  });
});
