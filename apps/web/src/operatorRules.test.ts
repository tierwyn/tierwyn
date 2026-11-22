import { describe, it, expect } from 'vitest';
import {
  conversationHasAppliedRules,
  livePreview,
  rulesByteLength,
  RULES_MAX_BYTES,
  RULES_CHAIN_GUARD_DEPTH,
} from './operatorRules.js';

describe('rulesByteLength', () => {
  it('counts utf8 bytes not characters', () => {
    expect(rulesByteLength('abc')).toBe(3);
    expect(rulesByteLength('é')).toBe(2);
    expect(RULES_MAX_BYTES).toBe(4096);
  });
});

describe('conversationHasAppliedRules', () => {
  it('is false for system projects and empty chain', () => {
    const conv = { id: 'c1', rules: 'x' };
    expect(conversationHasAppliedRules({ system: true, rules: 'p' }, conv, new Map())).toBe(false);
    expect(conversationHasAppliedRules({ rules: undefined }, { id: 'c1' }, new Map())).toBe(false);
  });

  it('is true for project rules or an ancestor conversation', () => {
    expect(conversationHasAppliedRules({ rules: 'p' }, { id: 'c1' }, new Map())).toBe(true);
    const root = { id: 'r', rules: 'root' };
    const child = { id: 'c', parentConversationId: 'r' };
    expect(conversationHasAppliedRules({}, child, new Map([['r', root]]))).toBe(true);
    expect(conversationHasAppliedRules({}, child, new Map())).toBe(false);
  });

  it('is true when only presets apply', () => {
    expect(conversationHasAppliedRules({ rulePresetIds: ['p1'] }, { id: 'c1' }, new Map())).toBe(true);
    const root = { id: 'r', rulePresetIds: ['p1'] };
    const child = { id: 'c', parentConversationId: 'r' };
    expect(conversationHasAppliedRules({}, child, new Map([['r', root]]))).toBe(true);
  });

  it('walks past depth 10', () => {
    expect(RULES_CHAIN_GUARD_DEPTH).toBe(64);
    const byId = new Map<string, { id: string; rules?: string; parentConversationId?: string }>();
    for (let i = 0; i < 12; i++) {
      byId.set(`c${i}`, { id: `c${i}`, parentConversationId: i === 0 ? undefined : `c${i - 1}`, rules: i === 0 ? 'root' : undefined });
    }
    const leaf = { id: 'c11', parentConversationId: 'c10' };
    expect(conversationHasAppliedRules({}, leaf, byId)).toBe(true);
  });
});

describe('livePreview', () => {
  it('shows level headers and live custom text', () => {
    const { rendered, omitted } = livePreview([
      {
        customLabel: 'Project',
        custom: 'project custom',
        presets: [{ id: 'a', name: 'Tone', content: 'be terse', available: true }],
      },
      {
        customLabel: 'Conversation: Child',
        custom: 'unsaved child',
        presets: [],
      },
    ]);
    expect(omitted).toBe(0);
    expect(rendered).toContain('### Preset: Tone');
    expect(rendered).toContain('### Project');
    expect(rendered).toContain('### Conversation: Child');
    expect(rendered).toContain('unsaved child');
  });
});
