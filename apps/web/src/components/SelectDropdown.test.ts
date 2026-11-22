import { describe, it, expect, afterEach } from 'vitest';
import {
  toggleMultiValue,
  multiTriggerLabel,
  panelPosition,
  type SelectDropdownOption,
} from './SelectDropdown.js';

const OPTIONS: SelectDropdownOption[] = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
  { value: 'c', label: 'Charlie' },
  { value: 'd', label: 'Delta' },
  { value: 'e', label: 'Echo' },
];

describe('toggleMultiValue', () => {
  it('adds a missing value', () => {
    expect(toggleMultiValue(OPTIONS, [], 'c')).toEqual(['c']);
    expect(toggleMultiValue(OPTIONS, ['a'], 'c')).toEqual(['a', 'c']);
  });

  it('removes a present value', () => {
    expect(toggleMultiValue(OPTIONS, ['a', 'c'], 'a')).toEqual(['c']);
    expect(toggleMultiValue(OPTIONS, ['c'], 'c')).toEqual([]);
  });

  it('keeps option order regardless of click order', () => {
    expect(toggleMultiValue(OPTIONS, ['c'], 'a')).toEqual(['a', 'c']);
    expect(toggleMultiValue(OPTIONS, ['e', 'a'], 'c')).toEqual(['a', 'c', 'e']);
    expect(toggleMultiValue(OPTIONS, [], 'e')).toEqual(['e']);
    expect(toggleMultiValue(OPTIONS, ['e'], 'b')).toEqual(['b', 'e']);
  });
});

describe('multiTriggerLabel', () => {
  it('returns the placeholder (or default) when nothing is selected', () => {
    expect(multiTriggerLabel(OPTIONS, [])).toBe('None selected');
    expect(multiTriggerLabel(OPTIONS, [], 'No built-in tags enabled')).toBe('No built-in tags enabled');
  });

  it('returns All (n) when every option is selected', () => {
    expect(multiTriggerLabel(OPTIONS, OPTIONS.map((o) => o.value))).toBe('All (5)');
  });

  it('joins 1–3 selected labels with comma-space', () => {
    expect(multiTriggerLabel(OPTIONS, ['a'])).toBe('Alpha');
    expect(multiTriggerLabel(OPTIONS, ['a', 'c'])).toBe('Alpha, Charlie');
    expect(multiTriggerLabel(OPTIONS, ['a', 'c', 'e'])).toBe('Alpha, Charlie, Echo');
  });

  it('returns "k of n selected" when more than 3 (and not all) are selected', () => {
    expect(multiTriggerLabel(OPTIONS, ['a', 'b', 'c', 'd'])).toBe('4 of 5 selected');
  });

  it('ignores unknown values in the selection set', () => {
    expect(multiTriggerLabel(OPTIONS, ['zzz'])).toBe('None selected');
    expect(multiTriggerLabel(OPTIONS, ['a', 'nope'])).toBe('Alpha');
    expect(multiTriggerLabel(OPTIONS, OPTIONS.map((o) => o.value).concat('junk'))).toBe('All (5)');
  });
});

describe('panelPosition mobile alignment and width', () => {
  const originalInnerWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const originalInnerHeight = typeof window !== 'undefined' ? window.innerHeight : 768;

  afterEach(() => {
    if (typeof window !== 'undefined') {
      (window as any).innerWidth = originalInnerWidth;
      (window as any).innerHeight = originalInnerHeight;
    }
  });

  it('aligns panel with trigger left and matches width on mobile for wide/centered triggers', () => {
    if (typeof window === 'undefined') (globalThis as any).window = {};
    (window as any).innerWidth = 390;
    (window as any).innerHeight = 800;

    const trigger = {
      left: 48,
      right: 342,
      top: 20,
      bottom: 64,
      width: 294,
      height: 44,
      x: 48,
      y: 20,
      toJSON: () => {},
    } as DOMRect;

    const { style } = panelPosition(trigger, 'bottom', true);
    expect(style.left).toBe(48);
    expect(style.width).toBe(294);
    expect(style.minWidth).toBe(294);
    expect(style.maxWidth).toBe(294);
  });

  it('matches full-width modal select in MemoriesModal on mobile', () => {
    if (typeof window === 'undefined') (globalThis as any).window = {};
    (window as any).innerWidth = 390;
    (window as any).innerHeight = 800;

    const trigger = {
      left: 30,
      right: 360,
      top: 100,
      bottom: 130,
      width: 330,
      height: 30,
      x: 30,
      y: 100,
      toJSON: () => {},
    } as DOMRect;

    const { style } = panelPosition(trigger, 'bottom', true);
    expect(style.left).toBe(30);
    expect(style.width).toBe(330);
    expect(style.minWidth).toBe(330);
    expect(style.maxWidth).toBe(330);
  });

  it('preserves desktop positioning without premature 8px shift', () => {
    if (typeof window === 'undefined') (globalThis as any).window = {};
    (window as any).innerWidth = 1200;
    (window as any).innerHeight = 800;

    const trigger = {
      left: 300,
      right: 580,
      top: 100,
      bottom: 138,
      width: 280,
      height: 38,
      x: 300,
      y: 100,
      toJSON: () => {},
    } as DOMRect;

    const { style } = panelPosition(trigger, 'bottom', true);
    expect(style.left).toBe(300);
    expect(style.minWidth).toBe(280);
    expect(style.width).toBe('max-content');
  });
});
