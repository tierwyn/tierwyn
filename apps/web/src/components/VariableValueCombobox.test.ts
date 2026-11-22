import { describe, it, expect } from 'vitest';
import type { AgentProfile, SpawnTemplate } from '@tierwyn/shared';
import {
  buildComboboxItems,
  filterAndGroupComboboxItems,
  detectVarMode,
} from './VariableValueCombobox.js';

const dummyProfiles: AgentProfile[] = [
  {
    id: 'claude-code:claude-opus-5',
    agentType: 'claude-code',
    model: 'claude-opus-5',
    description: 'Anthropic Opus',
    label: 'Claude Code · Claude Opus 5',
    vision: true,
    steer: false,
    enabled: true,
  },
  {
    id: 'cursor:cursor-grok-4.6-high',
    agentType: 'cursor',
    model: 'cursor-grok-4.6-high',
    description: 'Cursor Grok',
    label: 'Cursor · Grok 4.6',
    vision: true,
    steer: false,
    enabled: true,
  },
  {
    id: 'antigravity:gemini-3.8-flash-medium',
    agentType: 'antigravity',
    model: 'gemini-3.8-flash-medium',
    description: 'Antigravity Flash',
    label: 'Antigravity · Flash 3.8',
    vision: true,
    steer: false,
    enabled: true,
  },
];

const dummyTemplates: SpawnTemplate[] = [
  {
    name: 'Mixed',
    roles: [
      { role: 'Planner', profileId: 'claude-code:claude-opus-5', when: 'specs or plans' },
      { role: 'Implementer', profileId: 'cursor:cursor-grok-4.6-high', when: 'code changes' },
    ],
  },
  {
    name: 'Documentation',
    roles: [
      { role: 'Writer', profileId: 'cursor:cursor-grok-4.6-high', when: 'docs' },
    ],
  },
];

describe('buildComboboxItems', () => {
  it('categorizes active roster roles, roster models, available rosters, and other models', () => {
    const items = buildComboboxItems(dummyTemplates, dummyProfiles, 'Mixed');

    const roles = items.filter((i) => i.category === 'roster_role');
    expect(roles).toHaveLength(2);
    expect(roles.map((r) => r.value)).toEqual(['Planner', 'Implementer']);
    expect(roles[0].categoryLabel).toBe('Roster Roles (Mixed)');
    expect(roles[0].badge).toBe('Role');
    expect(roles[0].description).toBe('Model: claude-code:claude-opus-5');

    const rosterModels = items.filter((i) => i.category === 'roster_model');
    expect(rosterModels).toHaveLength(2);
    expect(rosterModels.map((m) => m.value)).toEqual([
      'claude-code:claude-opus-5',
      'cursor:cursor-grok-4.6-high',
    ]);
    expect(rosterModels[0].badge).toBe('Roster Model');

    const rosters = items.filter((i) => i.category === 'template');
    expect(rosters).toHaveLength(2);
    expect(rosters.map((t) => t.value)).toEqual(['Mixed', 'Documentation']);

    // Other models should exclude models already in the active roster
    const otherModels = items.filter((i) => i.category === 'system_model');
    expect(otherModels).toHaveLength(1);
    expect(otherModels[0].value).toBe('antigravity:gemini-3.8-flash-medium');
    expect(otherModels[0].badge).toBe('antigravity');
  });

  it('works when no template is selected', () => {
    const items = buildComboboxItems(dummyTemplates, dummyProfiles, undefined);

    const roles = items.filter((i) => i.category === 'roster_role');
    expect(roles).toHaveLength(0);

    const rosterModels = items.filter((i) => i.category === 'roster_model');
    expect(rosterModels).toHaveLength(0);

    const rosters = items.filter((i) => i.category === 'template');
    expect(rosters).toHaveLength(2);

    // All system models appear under other models
    const otherModels = items.filter((i) => i.category === 'system_model');
    expect(otherModels).toHaveLength(3);
  });
});

describe('filterAndGroupComboboxItems', () => {
  it('returns all items grouped by category when query is empty', () => {
    const items = buildComboboxItems(dummyTemplates, dummyProfiles, 'Mixed');
    const groups = filterAndGroupComboboxItems(items, '');

    expect(groups.length).toBe(4);
    expect(groups.map((g) => g.label)).toEqual([
      'Roster Roles (Mixed)',
      'Roster Models (Mixed)',
      'Available Rosters / Templates',
      'Other System Models',
    ]);
  });

  it('filters items case-insensitively by value, label, or description', () => {
    const items = buildComboboxItems(dummyTemplates, dummyProfiles, 'Mixed');

    // Filter by role name matches the role itself and the model with description 'Used by role: Planner'
    const plannerMatches = filterAndGroupComboboxItems(items, 'planner');
    expect(plannerMatches.length).toBe(2);
    expect(plannerMatches[0].items[0].value).toBe('Planner');
    expect(plannerMatches[1].items[0].value).toBe('claude-code:claude-opus-5');

    // Filter by model substring
    const grokMatches = filterAndGroupComboboxItems(items, 'grok');
    const allGrokItems = grokMatches.flatMap((g) => g.items);
    expect(allGrokItems.some((i) => i.value === 'cursor:cursor-grok-4.6-high')).toBe(true);

    // Filter by roster name
    const docMatches = filterAndGroupComboboxItems(items, 'doc');
    const allDocItems = docMatches.flatMap((g) => g.items);
    expect(allDocItems.some((i) => i.value === 'Documentation')).toBe(true);
  });

  it('returns empty group list when nothing matches', () => {
    const items = buildComboboxItems(dummyTemplates, dummyProfiles, 'Mixed');
    const noMatches = filterAndGroupComboboxItems(items, 'nonexistent-xyz-query');
    expect(noMatches.length).toBe(0);
  });
});

describe('detectVarMode', () => {
  it('detects text mode for numbers, booleans, and count/limit variables', () => {
    expect(detectVarMode('maxMintsPerTick', '1', 'Mixed', dummyTemplates, dummyProfiles)).toBe('text');
    expect(detectVarMode('maxPendingProposals', '5', 'Mixed', dummyTemplates, dummyProfiles)).toBe('text');
    expect(detectVarMode('maxTicks', '3', 'Mixed', dummyTemplates, dummyProfiles)).toBe('text');
    expect(detectVarMode('zeroActionStopStreak', '6', 'Mixed', dummyTemplates, dummyProfiles)).toBe('text');
    expect(detectVarMode('timeout', '5000', 'Mixed', dummyTemplates, dummyProfiles)).toBe('text');
    expect(detectVarMode('enabled', 'true', 'Mixed', dummyTemplates, dummyProfiles)).toBe('text');
    expect(detectVarMode('mode', 'open-propose', 'Mixed', dummyTemplates, dummyProfiles)).toBe('text');
  });

  it('detects dropdown mode for role, profile, model, and template variables', () => {
    expect(detectVarMode('plannerRole', 'Claude Opus 5 Planner', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
    expect(detectVarMode('coderRole', 'Antigravity Flash 3.8', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
    expect(detectVarMode('reviewerRole', 'Cursor Opus', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
    expect(detectVarMode('implementerProfileId', 'cursor:cursor-grok-4.6-high', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
    expect(detectVarMode('implementerTemplateName', 'Mixed', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
  });

  it('detects dropdown mode when value matches a known roster role or model even if key is arbitrary', () => {
    expect(detectVarMode('specialAssignee', 'Planner', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
    expect(detectVarMode('leadAgent', 'cursor:cursor-grok-4.6-high', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
    expect(detectVarMode('chosenRoster', 'Documentation', 'Mixed', dummyTemplates, dummyProfiles)).toBe('dropdown');
  });
});
