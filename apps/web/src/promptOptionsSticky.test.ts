import { describe, it, expect, beforeEach } from 'vitest';
import { stickyKey, loadSticky, saveSticky, clearSticky } from './promptOptionsSticky.js';

function installMemoryLocalStorage(): void {
  const store = new Map<string, string>();
  const ls = {
    getItem(key: string) { return store.has(key) ? store.get(key)! : null; },
    setItem(key: string, value: string) { store.set(key, String(value)); },
    removeItem(key: string) { store.delete(key); },
    clear() { store.clear(); },
    key(i: number) { return [...store.keys()][i] ?? null; },
    get length() { return store.size; },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: ls, configurable: true });
}

beforeEach(() => {
  installMemoryLocalStorage();
});

describe('promptOptionsSticky', () => {
  it('builds stickyKey as conversationId::agentType', () => {
    expect(stickyKey('conv-a', 'grok-build')).toBe('conv-a::grok-build');
  });

  it('round-trips save → load', () => {
    saveSticky('c1', 'grok-build', { sticky: true, options: { sandbox: 'workspace' } });
    expect(loadSticky('c1', 'grok-build')).toEqual({
      sticky: true,
      options: { sandbox: 'workspace' },
    });
  });

  it('isolates bags by agentType within the same conversation', () => {
    saveSticky('c1', 'grok-build', { sticky: true, options: { sandbox: 'workspace' } });
    saveSticky('c1', 'codex', { sticky: true, options: { sandbox: 'read-only' } });
    expect(loadSticky('c1', 'grok-build').options).toEqual({ sandbox: 'workspace' });
    expect(loadSticky('c1', 'codex').options).toEqual({ sandbox: 'read-only' });
  });

  it('isolates bags by conversation for the same agentType', () => {
    saveSticky('c1', 'grok-build', { sticky: true, options: { sandbox: 'workspace' } });
    saveSticky('c2', 'grok-build', { sticky: true, options: { sandbox: 'strict' } });
    expect(loadSticky('c1', 'grok-build').options).toEqual({ sandbox: 'workspace' });
    expect(loadSticky('c2', 'grok-build').options).toEqual({ sandbox: 'strict' });
  });

  it('returns empty entry for corrupt JSON without throwing', () => {
    localStorage.setItem('tierwyn.promptOptions.sticky.v1', '{not-json');
    expect(loadSticky('c1', 'grok-build')).toEqual({ sticky: false, options: {} });
  });

  it('returns empty entry when sanitise throws PromptOptionError', () => {
    saveSticky('c1', 'antigravity', { sticky: true, options: { jsonSchema: 'not json' } });
    // Corrupt the stored bag to an invalid JSON schema that throws on load
    localStorage.setItem(
      'tierwyn.promptOptions.sticky.v1',
      JSON.stringify({
        'c1::antigravity': { sticky: true, options: { jsonSchema: 'not json' } },
      }),
    );
    expect(loadSticky('c1', 'antigravity')).toEqual({ sticky: false, options: {} });
  });

  it('narrows bags with keys the agent no longer supports', () => {
    localStorage.setItem(
      'tierwyn.promptOptions.sticky.v1',
      JSON.stringify({
        'c1::grok-build': {
          sticky: true,
          options: { sandbox: 'workspace', bogus: true, reasoningEffort: 'high' },
        },
      }),
    );
    expect(loadSticky('c1', 'grok-build')).toEqual({
      sticky: true,
      options: { sandbox: 'workspace', reasoningEffort: 'high' },
    });
  });

  it('deletes the key when saving sticky:false with an empty bag', () => {
    saveSticky('c1', 'grok-build', { sticky: true, options: { sandbox: 'workspace' } });
    saveSticky('c1', 'grok-build', { sticky: false, options: {} });
    expect(loadSticky('c1', 'grok-build')).toEqual({ sticky: false, options: {} });
    const raw = localStorage.getItem('tierwyn.promptOptions.sticky.v1');
    expect(raw === null || !JSON.parse(raw!)['c1::grok-build']).toBe(true);
  });

  it('caps the map at 50 entries, dropping oldest first', () => {
    for (let i = 0; i < 55; i++) {
      saveSticky(`c${i}`, 'grok-build', { sticky: true, options: { sandbox: 'workspace' } });
    }
    const raw = JSON.parse(localStorage.getItem('tierwyn.promptOptions.sticky.v1')!);
    expect(Object.keys(raw)).toHaveLength(50);
    expect(raw['c0::grok-build']).toBeUndefined();
    expect(raw['c54::grok-build']).toBeTruthy();
  });

  it('clearSticky removes only the named key', () => {
    saveSticky('c1', 'grok-build', { sticky: true, options: { sandbox: 'workspace' } });
    saveSticky('c1', 'codex', { sticky: true, options: { sandbox: 'read-only' } });
    clearSticky('c1', 'grok-build');
    expect(loadSticky('c1', 'grok-build')).toEqual({ sticky: false, options: {} });
    expect(loadSticky('c1', 'codex').options).toEqual({ sandbox: 'read-only' });
  });

  it('returns empty when agentType is missing', () => {
    expect(loadSticky('c1', undefined)).toEqual({ sticky: false, options: {} });
  });
});
