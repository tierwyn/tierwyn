import type { PromptVariable } from '@tierwyn/shared';
import { storageGet, storageSet } from './prefixedStorage.js';

/** Inserted for an empty roster field so the agent skips that stage. */
export const PROMPT_VAR_SKIP = 'none (do not use this instruction)';

const KEY_PREFIX = 'tierwyn.promptVars.';

function keyFor(promptId: string): string {
  return `${KEY_PREFIX}${promptId}`;
}

function backingStore(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return localStorage;
  } catch {
    return null;
  }
}

export function loadPromptVarMemory(
  promptId: string,
  storage?: Storage,
): Record<string, string> | null {
  try {
    const store = backingStore(storage);
    if (!store) return null;
    const raw = storageGet(store, keyFor(promptId));
    if (raw == null || raw === '') return null;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}

export function savePromptVarMemory(
  promptId: string,
  values: Record<string, string>,
  storage?: Storage,
): void {
  try {
    const store = backingStore(storage);
    if (!store) return;
    storageSet(store, keyFor(promptId), JSON.stringify(values));
  } catch {
    /* private mode / quota */
  }
}

export type PromptVarFieldKind = 'select' | 'blocked' | 'text';

/** Roster fields need a spawn template; without one they are blocked, not free text. */
export function promptVarFieldKind(
  source: PromptVariable['source'] | undefined,
  roles: readonly string[] | undefined,
): PromptVarFieldKind {
  if (source !== 'roster') return 'text';
  return roles && roles.length > 0 ? 'select' : 'blocked';
}

export function promptVarsRosterBlocked(
  variables: PromptVariable[],
  roles: readonly string[] | undefined,
): boolean {
  return variables.some((v) => promptVarFieldKind(v.source, roles) === 'blocked');
}

export function initialPromptVarValues(
  variables: PromptVariable[],
  opts: { roles?: string[]; remembered?: Record<string, string> | null } = {},
): Record<string, string> {
  const remembered = opts.remembered ?? null;
  const roster = opts.roles && opts.roles.length > 0 ? opts.roles : undefined;
  const init: Record<string, string> = {};
  for (const v of variables) {
    if (v.source !== 'roster') {
      // Free-text fields are not memoized; always start empty.
      init[v.name] = '';
      continue;
    }
    const saved = remembered && Object.hasOwn(remembered, v.name) ? remembered[v.name] : undefined;
    if (saved === undefined) {
      init[v.name] = '';
      continue;
    }
    init[v.name] = roster && (saved === '' || roster.includes(saved)) ? saved : '';
  }
  return init;
}

/** Empty roster fields become a skip instruction; free-text empties stay empty. */
export function promptVarsForSubstitute(
  values: Record<string, string>,
  variables: PromptVariable[],
): Record<string, string> {
  const byName = new Map(variables.map((v) => [v.name, v]));
  const out: Record<string, string> = {};
  for (const [name, raw] of Object.entries(values)) {
    const trimmed = raw.trim();
    const meta = byName.get(name);
    if (meta?.source === 'roster' && trimmed === '') {
      out[name] = PROMPT_VAR_SKIP;
    } else {
      out[name] = trimmed;
    }
  }
  return out;
}
