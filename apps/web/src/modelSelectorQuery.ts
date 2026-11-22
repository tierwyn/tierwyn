/** Storage helper for persisting and restoring ModelSelector filter query across sessions. */
import { storageGet, storageSet, storageRemove } from './prefixedStorage.js';

export const MODEL_SELECTOR_QUERY_KEY = 'tierwyn:model-selector-query';

export function readStoredModelQuery(
  storage: Storage | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined,
): string {
  try {
    if (storage) {
      return storageGet(storage, MODEL_SELECTOR_QUERY_KEY) ?? '';
    }
  } catch {
    /* private browsing / quota / security error */
  }
  return '';
}

export function writeStoredModelQuery(
  query: string,
  storage: Storage | undefined = typeof localStorage !== 'undefined' ? localStorage : undefined,
): void {
  try {
    if (storage) {
      if (query) {
        storageSet(storage, MODEL_SELECTOR_QUERY_KEY, query);
      } else {
        storageRemove(storage, MODEL_SELECTOR_QUERY_KEY);
      }
    }
  } catch {
    /* private browsing / quota / security error */
  }
}
