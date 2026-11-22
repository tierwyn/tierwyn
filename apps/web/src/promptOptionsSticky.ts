import { sanitisePromptOptions, PromptOptionError, type PromptOptions } from '@tierwyn/shared';
import { lsGet, lsSet, lsRemove } from './prefixedStorage.js';

const KEY = 'tierwyn.promptOptions.sticky.v1';
const MAX_ENTRIES = 50;

export interface StickyEntry {
  sticky: boolean;
  options: PromptOptions;
}

type StickyMap = Record<string, StickyEntry>;

export function stickyKey(conversationId: string, agentType: string): string {
  return `${conversationId}::${agentType}`;
}

function emptyEntry(): StickyEntry {
  return { sticky: false, options: {} };
}

function isEmptyOptions(options: PromptOptions): boolean {
  return Object.keys(options).length === 0;
}

function readMap(): StickyMap {
  const raw = lsGet(KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as StickyMap;
  } catch {
    return {};
  }
}

function writeMap(map: StickyMap): void {
  if (Object.keys(map).length === 0) {
    lsRemove(KEY);
    return;
  }
  lsSet(KEY, JSON.stringify(map));
}

function isValidEntry(value: unknown): value is StickyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as StickyEntry;
  if (typeof entry.sticky !== 'boolean') return false;
  if (!entry.options || typeof entry.options !== 'object' || Array.isArray(entry.options)) return false;
  return true;
}

export function loadSticky(conversationId: string, agentType: string | undefined): StickyEntry {
  if (!conversationId || !agentType) return emptyEntry();
  const map = readMap();
  const entry = map[stickyKey(conversationId, agentType)];
  if (!isValidEntry(entry)) return emptyEntry();
  try {
    const sanitised = sanitisePromptOptions(agentType, entry.options) ?? {};
    return { sticky: entry.sticky, options: sanitised };
  } catch (err) {
    if (err instanceof PromptOptionError) return emptyEntry();
    return emptyEntry();
  }
}

export function saveSticky(conversationId: string, agentType: string, entry: StickyEntry): void {
  if (!conversationId || !agentType) return;
  const key = stickyKey(conversationId, agentType);
  const map = readMap();

  if (!entry.sticky && isEmptyOptions(entry.options)) {
    if (key in map) {
      delete map[key];
      writeMap(map);
    }
    return;
  }

  // Drop oldest-inserted keys first when over capacity (Object.keys insertion order).
  if (!(key in map) && Object.keys(map).length >= MAX_ENTRIES) {
    const keys = Object.keys(map);
    const overflow = Object.keys(map).length - MAX_ENTRIES + 1;
    for (let i = 0; i < overflow; i++) {
      delete map[keys[i]!];
    }
  }

  map[key] = { sticky: entry.sticky, options: entry.options };
  writeMap(map);
}

export function clearSticky(conversationId: string, agentType: string): void {
  if (!conversationId || !agentType) return;
  const map = readMap();
  const key = stickyKey(conversationId, agentType);
  if (!(key in map)) return;
  delete map[key];
  writeMap(map);
}
