/**
 * Storage helpers with lazy fallback for branded keys:
 * Reads tierwyn.* first; if missing, falls back to legacy nuncii.* and copies
 * the value to the new tierwyn key. lsSet / lsRemove also clean the legacy key.
 */

export function storageGet(store: Storage, key: string): string | null {
  try {
    const next = store.getItem(key);
    if (next !== null) return next;
    if (key.startsWith('tierwyn.')) {
      const legacy = store.getItem(`nuncii.${key.slice('tierwyn.'.length)}`);
      if (legacy !== null) {
        try { store.setItem(key, legacy); } catch { /* ignore quota / private mode */ }
        return legacy;
      }
    }
  } catch {
    return null;
  }
  return null;
}

export function storageSet(store: Storage, key: string, value: string): void {
  try {
    store.setItem(key, value);
    if (key.startsWith('tierwyn.')) store.removeItem(`nuncii.${key.slice('tierwyn.'.length)}`);
  } catch { /* private mode / quota */ }
}

export function storageRemove(store: Storage, key: string): void {
  try {
    store.removeItem(key);
    if (key.startsWith('tierwyn.')) store.removeItem(`nuncii.${key.slice('tierwyn.'.length)}`);
  } catch { /* private mode / quota */ }
}

export function lsGet(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return storageGet(localStorage, key);
  } catch {
    return null;
  }
}

export function lsRemove(key: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    storageRemove(localStorage, key);
  } catch { /* private mode / quota */ }
}

export function lsSet(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    storageSet(localStorage, key, value);
  } catch { /* private mode / quota */ }
}
