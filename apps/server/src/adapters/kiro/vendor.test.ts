import { describe, it, expect } from 'vitest';
import { mapKiroVendor } from './mapping.js';

describe('mapKiroVendor', () => {
  it('maps _kiro.dev/metadata contextUsagePercentage: 42 to contextPct 42', () => {
    const out = mapKiroVendor('_kiro.dev/metadata', { contextUsagePercentage: 42 });
    expect(out.contextPct).toBe(42);
  });

  it('ignores non-finite contextUsagePercentage and clamps 140 to 100', () => {
    expect(mapKiroVendor('_kiro.dev/metadata', { contextUsagePercentage: 'nope' }).contextPct).toBeUndefined();
    expect(mapKiroVendor('_kiro.dev/metadata', { contextUsagePercentage: NaN }).contextPct).toBeUndefined();
    expect(mapKiroVendor('_kiro.dev/metadata', { contextUsagePercentage: 140 }).contextPct).toBe(100);
  });

  it('maps numeric meteringUsage.credits to status.payload.costUsd and drops non-numeric', () => {
    const withCredits = mapKiroVendor('_kiro.dev/metadata', { meteringUsage: { credits: 0.05 } });
    expect(withCredits.status?.type).toBe('status');
    expect(withCredits.status && withCredits.status.type === 'status' && withCredits.status.payload.costUsd).toBe(0.05);

    const missing = mapKiroVendor('_kiro.dev/metadata', {});
    expect(missing.status).toBeUndefined();

    const nonNumeric = mapKiroVendor('_kiro.dev/metadata', { meteringUsage: { credits: '0.05' } });
    expect(nonNumeric.status).toBeUndefined();
  });

  it('does not map turnDurationMs anywhere', () => {
    const out = mapKiroVendor('_kiro.dev/metadata', {
      contextUsagePercentage: 10,
      meteringUsage: { credits: 0.05 },
      turnDurationMs: 1234,
    });
    expect(JSON.stringify(out)).not.toMatch(/turnDuration/i);
    expect(out).not.toHaveProperty('turnDurationMs');
    if (out.status && out.status.type === 'status') {
      expect(out.status.payload).not.toHaveProperty('turnDurationMs');
    }
  });

  it('maps _kiro.dev/commands/available to CommandDescriptors, strips / prefix, drops nameless', () => {
    const out = mapKiroVendor('_kiro.dev/commands/available', {
      commands: [
        { name: '/review', description: 'Review diff' },
        { name: 'compact', description: 'Compact context' },
        { name: '', description: 'empty' },
        { description: 'no name' },
        { name: '/' },
      ],
    });
    expect(out.commands).toEqual([
      { name: 'review', label: 'review', description: 'Review diff', sourceDetail: 'builtin' },
      { name: 'compact', label: 'compact', description: 'Compact context', sourceDetail: 'builtin' },
    ]);
  });

  it('returns {} for unknown _kiro.dev/* methods including subagent list_update', () => {
    expect(mapKiroVendor('_kiro.dev/subagent/list_update', { agents: [] })).toEqual({});
    expect(mapKiroVendor('_kiro.dev/mystery', { foo: 1 })).toEqual({});
  });
});
