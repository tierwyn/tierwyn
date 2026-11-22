import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storageGet, storageSet, storageRemove, lsGet, lsSet, lsRemove } from './prefixedStorage.js';

class MemoryStorage implements Storage {
  private map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

describe('prefixedStorage', () => {
  let store: MemoryStorage;

  beforeEach(() => {
    store = new MemoryStorage();
    vi.stubGlobal('localStorage', store);
  });

  it('reads tierwyn.* directly', () => {
    store.setItem('tierwyn.hideToolCalls', '1');
    expect(storageGet(store, 'tierwyn.hideToolCalls')).toBe('1');
  });

  it('copies nuncii.* to tierwyn.* on read when tierwyn.* is absent, keeping nuncii.*', () => {
    store.setItem('nuncii.hideToolCalls', '1');
    expect(storageGet(store, 'tierwyn.hideToolCalls')).toBe('1');
    expect(store.getItem('tierwyn.hideToolCalls')).toBe('1');
    expect(store.getItem('nuncii.hideToolCalls')).toBe('1');
  });

  it('prefers tierwyn.* over nuncii.*', () => {
    store.setItem('tierwyn.hideToolCalls', 'from-tierwyn');
    store.setItem('nuncii.hideToolCalls', 'from-nuncii');
    expect(storageGet(store, 'tierwyn.hideToolCalls')).toBe('from-tierwyn');
  });

  it('returns null when no key exists', () => {
    expect(storageGet(store, 'tierwyn.hideToolCalls')).toBeNull();
  });

  it('storageSet writes and drops the nuncii.* key', () => {
    store.setItem('nuncii.promptOptions.sticky.v1', 'old');
    storageSet(store, 'tierwyn.promptOptions.sticky.v1', 'new');
    expect(store.getItem('tierwyn.promptOptions.sticky.v1')).toBe('new');
    expect(store.getItem('nuncii.promptOptions.sticky.v1')).toBeNull();
  });

  it('storageRemove removes tierwyn.* and nuncii.*', () => {
    store.setItem('tierwyn.tts.job', 'a');
    store.setItem('nuncii.tts.job', 'b');
    storageRemove(store, 'tierwyn.tts.job');
    expect(store.getItem('tierwyn.tts.job')).toBeNull();
    expect(store.getItem('nuncii.tts.job')).toBeNull();
  });

  it('colon keys (tierwyn:*) pass straight through', () => {
    storageSet(store, 'tierwyn:sidebar-width', '400');
    expect(storageGet(store, 'tierwyn:sidebar-width')).toBe('400');
    storageRemove(store, 'tierwyn:sidebar-width');
    expect(storageGet(store, 'tierwyn:sidebar-width')).toBeNull();
  });

  it('lsGet / lsSet / lsRemove use global localStorage', () => {
    lsSet('tierwyn.test', 'hello');
    expect(lsGet('tierwyn.test')).toBe('hello');
    lsRemove('tierwyn.test');
    expect(lsGet('tierwyn.test')).toBeNull();
  });
});
