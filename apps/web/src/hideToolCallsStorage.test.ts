import { describe, it, expect, vi, beforeEach } from 'vitest';
import { lsGet, lsSet } from './prefixedStorage.js';

const HIDE_TOOL_CALLS_KEY = 'tierwyn.hideToolCalls';

describe('hideToolCalls localStorage', () => {
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });

  it('persists hide/show preference globally', () => {
    lsSet(HIDE_TOOL_CALLS_KEY, '1');
    expect(lsGet(HIDE_TOOL_CALLS_KEY)).toBe('1');
    lsSet(HIDE_TOOL_CALLS_KEY, '0');
    expect(lsGet(HIDE_TOOL_CALLS_KEY)).toBe('0');
  });
});
