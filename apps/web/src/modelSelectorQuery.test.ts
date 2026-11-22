import { describe, it, expect, beforeEach } from 'vitest';
import {
  MODEL_SELECTOR_QUERY_KEY,
  readStoredModelQuery,
  writeStoredModelQuery,
} from './modelSelectorQuery.js';

class MockStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number { return this.store.size; }
  clear(): void { this.store.clear(); }
  getItem(key: string): string | null { return this.store.get(key) ?? null; }
  key(index: number): string | null { return Array.from(this.store.keys())[index] ?? null; }
  removeItem(key: string): void { this.store.delete(key); }
  setItem(key: string, value: string): void { this.store.set(key, value); }
}

describe('modelSelectorQuery', () => {
  let storage: MockStorage;

  beforeEach(() => {
    storage = new MockStorage();
  });

  it('reads empty string when no query is saved', () => {
    expect(readStoredModelQuery(storage)).toBe('');
  });

  it('reads saved query when present', () => {
    storage.setItem(MODEL_SELECTOR_QUERY_KEY, 'haiku');
    expect(readStoredModelQuery(storage)).toBe('haiku');
  });

  it('writes query to storage', () => {
    writeStoredModelQuery('sonnet', storage);
    expect(storage.getItem(MODEL_SELECTOR_QUERY_KEY)).toBe('sonnet');
    expect(readStoredModelQuery(storage)).toBe('sonnet');
  });

  it('removes storage key when query is emptied', () => {
    storage.setItem(MODEL_SELECTOR_QUERY_KEY, 'opus');
    writeStoredModelQuery('', storage);
    expect(storage.getItem(MODEL_SELECTOR_QUERY_KEY)).toBeNull();
    expect(readStoredModelQuery(storage)).toBe('');
  });

  it('handles storage exceptions gracefully', () => {
    const throwingStorage = {
      getItem: () => { throw new Error('QuotaExceeded'); },
      setItem: () => { throw new Error('QuotaExceeded'); },
      removeItem: () => { throw new Error('QuotaExceeded'); },
    } as unknown as Storage;

    expect(readStoredModelQuery(throwingStorage)).toBe('');
    expect(() => writeStoredModelQuery('test', throwingStorage)).not.toThrow();
  });

  it('handles undefined storage in node / non-browser environments', () => {
    expect(readStoredModelQuery(undefined)).toBe('');
    expect(() => writeStoredModelQuery('test', undefined)).not.toThrow();
  });
});
