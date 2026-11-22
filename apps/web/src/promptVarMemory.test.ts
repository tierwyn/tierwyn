import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PromptVariable } from '@tierwyn/shared';
import { substitutePromptVariables } from '@tierwyn/shared';
import {
  PROMPT_VAR_SKIP,
  initialPromptVarValues,
  loadPromptVarMemory,
  promptVarFieldKind,
  promptVarsRosterBlocked,
  promptVarsForSubstitute,
  savePromptVarMemory,
} from './promptVarMemory.js';

const planner: PromptVariable = {
  name: 'planner',
  label: 'Roster role to plan',
  default: 'Claude Opus 5 Planner',
  source: 'roster',
};
const feature: PromptVariable = {
  name: 'feature',
  label: 'Feature to add',
  default: 'a login form',
};
const roster = ['Claude Opus 5 Planner', 'Grok 4.6 Implementer'];

function memoryStore(): Storage {
  const data: Record<string, string> = {};
  return {
    getItem: (k: string) => (Object.hasOwn(data, k) ? data[k] : null),
    setItem: (k: string, v: string) => { data[k] = v; },
    removeItem: (k: string) => { delete data[k]; },
    clear: () => { for (const k of Object.keys(data)) delete data[k]; },
    key: () => null,
    get length() { return Object.keys(data).length; },
  } as Storage;
}

describe('initialPromptVarValues', () => {
  it('starts every field empty on first load, ignoring compiled defaults', () => {
    expect(initialPromptVarValues([planner, feature], { roles: roster })).toEqual({
      planner: '',
      feature: '',
    });
  });

  it('restores a remembered roster role that is still on this conversation and leaves free-text empty', () => {
    expect(initialPromptVarValues([planner, feature], {
      roles: roster,
      remembered: { planner: 'Grok 4.6 Implementer', feature: 'dark mode' },
    })).toEqual({
      planner: 'Grok 4.6 Implementer',
      feature: '',
    });
  });

  it('falls back to empty when the remembered role is not on this roster', () => {
    expect(initialPromptVarValues([planner], {
      roles: roster,
      remembered: { planner: 'Haiku' },
    })).toEqual({ planner: '' });
  });

  it('keeps a remembered empty roster value as empty (None)', () => {
    expect(initialPromptVarValues([planner], {
      roles: roster,
      remembered: { planner: '' },
    })).toEqual({ planner: '' });
  });

  it('does not restore free-text memoization even when remembered', () => {
    expect(initialPromptVarValues([feature], {
      remembered: { feature: 'search' },
    })).toEqual({ feature: '' });
  });

  it('does not restore a remembered roster value when the conversation has no roster and leaves free-text empty', () => {
    expect(initialPromptVarValues([planner, feature], {
      remembered: { planner: 'Cursor Grok 4.6', feature: 'search' },
    })).toEqual({ planner: '', feature: '' });
  });
});

describe('promptVarFieldKind', () => {
  it('uses a select when a roster-sourced field has roles', () => {
    expect(promptVarFieldKind('roster', roster)).toBe('select');
  });

  it('blocks a roster-sourced field when the conversation has no roles', () => {
    expect(promptVarFieldKind('roster', [])).toBe('blocked');
    expect(promptVarFieldKind('roster', undefined)).toBe('blocked');
  });

  it('keeps free-text fields as text even with no roster', () => {
    expect(promptVarFieldKind(undefined, [])).toBe('text');
  });
});

describe('promptVarsRosterBlocked', () => {
  it('is true when any variable is roster-sourced and roles are missing', () => {
    expect(promptVarsRosterBlocked([planner, feature], [])).toBe(true);
    expect(promptVarsRosterBlocked([planner], undefined)).toBe(true);
  });

  it('is false when the roster is present or the prompt has no roster fields', () => {
    expect(promptVarsRosterBlocked([planner, feature], roster)).toBe(false);
    expect(promptVarsRosterBlocked([feature], [])).toBe(false);
  });
});

describe('promptVarsForSubstitute', () => {
  it('maps an empty roster field to the skip instruction', () => {
    expect(promptVarsForSubstitute(
      { planner: '', feature: 'dark mode' },
      [planner, feature],
    )).toEqual({
      planner: PROMPT_VAR_SKIP,
      feature: 'dark mode',
    });
  });

  it('treats whitespace-only roster values as skip', () => {
    expect(promptVarsForSubstitute({ planner: '  \n' }, [planner])).toEqual({
      planner: PROMPT_VAR_SKIP,
    });
  });

  it('leaves an empty free-text field empty, not the skip phrase', () => {
    expect(promptVarsForSubstitute({ feature: '' }, [feature])).toEqual({
      feature: '',
    });
  });

  it('passes through a chosen roster role unchanged', () => {
    expect(promptVarsForSubstitute(
      { planner: 'Claude Opus 5 Planner' },
      [planner],
    )).toEqual({ planner: 'Claude Opus 5 Planner' });
  });

  it('substitutes an empty planner to the skip phrase in a prompt body', () => {
    const filled = substitutePromptVariables(
      'Delegate planning to {{planner}}.',
      promptVarsForSubstitute({ planner: '' }, [planner]),
    );
    expect(filled).toBe(`Delegate planning to ${PROMPT_VAR_SKIP}.`);
  });
});

describe('loadPromptVarMemory / savePromptVarMemory', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = memoryStore();
  });

  it('returns null when nothing has been saved for that prompt', () => {
    expect(loadPromptVarMemory('preset-orch-add-feature', storage)).toBeNull();
  });

  it('round-trips the last submitted values per prompt id', () => {
    savePromptVarMemory('preset-orch-add-feature', {
      planner: 'Grok 4.6 Implementer',
      feature: 'dark mode',
    }, storage);
    expect(loadPromptVarMemory('preset-orch-add-feature', storage)).toEqual({
      planner: 'Grok 4.6 Implementer',
      feature: 'dark mode',
    });
    expect(loadPromptVarMemory('preset-orchestrate-pipeline', storage)).toBeNull();
  });

  it('returns null for corrupt JSON rather than throwing', () => {
    storage.setItem('tierwyn.promptVars.preset-orch-add-feature', '{not json');
    expect(loadPromptVarMemory('preset-orch-add-feature', storage)).toBeNull();
  });

  it('swallows storage failures', () => {
    const broken = {
      getItem: () => { throw new Error('quota'); },
      setItem: () => { throw new Error('quota'); },
    } as unknown as Storage;
    expect(() => savePromptVarMemory('x', { a: '1' }, broken)).not.toThrow();
    expect(loadPromptVarMemory('x', broken)).toBeNull();
  });
});

describe('localStorage default backing store', () => {
  beforeEach(() => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v; },
      removeItem: (k: string) => { delete store[k]; },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads and writes the per-browser store when no storage is passed', () => {
    savePromptVarMemory('preset-debug', { scope: 'adapters' });
    expect(loadPromptVarMemory('preset-debug')).toEqual({ scope: 'adapters' });
  });
});
