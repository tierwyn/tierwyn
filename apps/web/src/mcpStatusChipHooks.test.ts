import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// Regression: McpStatusChip returned null before its useLayoutEffect/useEffect,
// so when agentType/hasLiveSession flipped on conversation load React threw
// "Rendered more hooks than during the previous render" and the app went white.
describe('McpStatusChip hook order', () => {
  const src = readFileSync(new URL('./components/McpStatusChip.tsx', import.meta.url), 'utf8');
  const start = src.indexOf('function McpStatusChipInner(');
  const body = src.slice(start, src.indexOf('\nclass McpChipBoundary', start));

  it('has no early return before the last hook', () => {
    const lastHook = Math.max(...[...body.matchAll(/\buse[A-Z]\w*\(/g)].map((m) => m.index ?? -1));
    const firstReturnNull = body.indexOf('return null');
    expect(lastHook).toBeGreaterThan(0);
    expect(firstReturnNull).toBeGreaterThan(lastHook);
  });

  it('is wrapped in an error boundary', () => {
    expect(src).toMatch(/getDerivedStateFromError/);
    expect(src).toMatch(/<McpChipBoundary><McpStatusChipInner/);
  });
});

// Native overrides are only enforced by claude-code; elsewhere the popover must be read-only.
describe('McpStatusChip native rows honesty', () => {
  const src = readFileSync(new URL('./components/McpStatusChip.tsx', import.meta.url), 'utf8');
  it('gates native checkboxes and All/Off on nativeEnforced', () => {
    expect(src).toMatch(/nativeEnforced = capability\?\.nativeOverrides === 'enforced'/);
    expect(src).toMatch(/\{nativeEnforced && <div style=\{\{ display: 'inline-flex'/);
    expect(src).toMatch(/\{nativeEnforced \? \(\s*<input/);
    expect(src).toContain('Tierwyn overrides are not enforced');
  });
});
