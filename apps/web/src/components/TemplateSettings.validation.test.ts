import { describe, it, expect } from 'vitest';
import type { AgentProfile, SpawnTemplate, SpawnTemplateRole } from '@tierwyn/shared';
import { validateTemplateDraft, matchesRoleSearch, sanitizeRoleForProfile, stripUninjectableMcp } from './TemplateSettings.js';

describe('validateTemplateDraft', () => {
  it('rejects null draft', () => {
    expect(validateTemplateDraft(null)).toBe('No template to save.');
  });

  it('rejects empty or whitespace template name', () => {
    const draft: SpawnTemplate = {
      name: '   ',
      roles: [{ role: 'coder', profileId: 'claude-code:sonnet', when: '' }],
    };
    expect(validateTemplateDraft(draft)).toBe('Template name is required.');
  });

  it('rejects draft with empty roles list', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [],
    };
    expect(validateTemplateDraft(draft)).toBe('At least one role is required.');
  });

  it('rejects a role missing a model', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [
        { role: 'Planner', profileId: 'claude-code:opus', when: '' },
        { role: 'Antigravity Opus 4.6', profileId: '', when: '' },
      ],
    };
    expect(validateTemplateDraft(draft)).toBe(
      'Role "Antigravity Opus 4.6" is missing a model — pick one before saving.',
    );
  });

  it('rejects a role missing a role name', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [
        { role: '', profileId: 'claude-code:opus', when: '' },
      ],
    };
    expect(validateTemplateDraft(draft)).toBe(
      'Role 1 is missing a role name — enter one before saving.',
    );
  });

  it('rejects a completely blank role row', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [
        { role: 'Planner', profileId: 'claude-code:opus', when: '' },
        { role: '   ', profileId: '', when: '' },
      ],
    };
    expect(validateTemplateDraft(draft)).toBe(
      'Role 2 needs a name and a model. Fill in the empty role row before saving.',
    );
  });

  it('accepts a valid draft', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [
        { role: 'Planner', profileId: 'claude-code:opus', when: 'planning' },
        { role: 'Implementer', profileId: 'grok-build:grok-4.6', when: 'coding' },
      ],
    };
    expect(validateTemplateDraft(draft)).toBeNull();
  });

  it('rejects a draft with invalid template-level mcpServers', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [{ role: 'Planner', profileId: 'claude-code:opus', when: 'planning' }],
      mcpServers: ['INVALID_UPPERCASE'],
    };
    expect(validateTemplateDraft(draft)).toContain('Template default MCP servers: invalid id');
  });

  it('rejects a draft with duplicate template-level mcpServers', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [{ role: 'Planner', profileId: 'claude-code:opus', when: 'planning' }],
      mcpServers: ['github', 'github'],
    };
    expect(validateTemplateDraft(draft)).toBe('Template default MCP servers: duplicate ids');
  });

  it('rejects a role with invalid mcpServers', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      roles: [
        {
          role: 'Planner',
          profileId: 'claude-code:opus',
          when: 'planning',
          mcpServers: ['bad id with spaces'],
        },
      ],
    };
    expect(validateTemplateDraft(draft)).toContain('Role "Planner" MCP servers: invalid id');
  });

  it('accepts valid mcpServers on template and roles', () => {
    const draft: SpawnTemplate = {
      name: 'team',
      mcpServers: ['github', 'postgres'],
      roles: [
        {
          role: 'Planner',
          profileId: 'claude-code:opus',
          when: 'planning',
          mcpServers: ['filesystem'],
        },
      ],
    };
    expect(validateTemplateDraft(draft)).toBeNull();
  });
});

describe('matchesRoleSearch', () => {
  const dummyProfiles = [
    {
      id: 'antigravity:gemini-3.8-flash-medium',
      label: 'Antigravity · Gemini 3.8 Flash (Medium)',
      agentType: 'antigravity',
      model: 'gemini-3.8-flash-medium',
      provider: 'antigravity',
      enabled: true,
    },
    {
      id: 'claude-code:claude-opus-5.5',
      label: 'Claude Code · Claude Opus 5.5',
      agentType: 'claude-code',
      model: 'claude-opus-5.5',
      provider: 'anthropic',
      enabled: true,
    },
  ] as any[];

  const profileMap = new Map(dummyProfiles.map((p) => [p.id, p]));

  const dummyPresets = [
    { id: 'research', name: 'Light research', when: 'Quick information retrieval' },
  ];

  it('matches all roles when query is empty or whitespace', () => {
    const role = { role: 'Planner', profileId: 'claude-code:claude-opus-5.5', when: 'planning' };
    expect(matchesRoleSearch(role, '', profileMap, dummyPresets)).toBe(true);
    expect(matchesRoleSearch(role, '   ', profileMap, dummyPresets)).toBe(true);
  });

  it('matches on role name (case-insensitive)', () => {
    const role = { role: 'Senior Coder', profileId: 'claude-code:claude-opus-5.5', when: '' };
    expect(matchesRoleSearch(role, 'senior', profileMap, dummyPresets)).toBe(true);
    expect(matchesRoleSearch(role, 'CODER', profileMap, dummyPresets)).toBe(true);
    expect(matchesRoleSearch(role, 'tester', profileMap, dummyPresets)).toBe(false);
  });

  it('matches on profile ID', () => {
    const role = { role: 'UI Builder', profileId: 'antigravity:gemini-3.8-flash-medium', when: '' };
    expect(matchesRoleSearch(role, 'gemini-3.8', profileMap, dummyPresets)).toBe(true);
  });

  it('matches on profile label, agentType, and model name', () => {
    const role = { role: 'Architect', profileId: 'antigravity:gemini-3.8-flash-medium', when: '' };
    expect(matchesRoleSearch(role, 'Antigravity', profileMap, dummyPresets)).toBe(true);
    expect(matchesRoleSearch(role, 'Flash', profileMap, dummyPresets)).toBe(true);
  });

  it('matches on when description', () => {
    const role = { role: 'Researcher', profileId: 'claude-code:claude-opus-5.5', when: 'Use for PRD and spec planning' };
    expect(matchesRoleSearch(role, 'PRD', profileMap, dummyPresets)).toBe(true);
    expect(matchesRoleSearch(role, 'spec planning', profileMap, dummyPresets)).toBe(true);
  });

  it('matches on matched preset name', () => {
    const role = { role: 'Helper', profileId: 'claude-code:claude-opus-5.5', when: 'Quick information retrieval' };
    expect(matchesRoleSearch(role, 'Light research', profileMap, dummyPresets)).toBe(true);
  });

  it('matches on workdir', () => {
    const role = { role: 'Isolated', profileId: 'claude-code:claude-opus-5.5', when: '', defaultWorkdir: 'worktree' as const };
    expect(matchesRoleSearch(role, 'worktree', profileMap, dummyPresets)).toBe(true);
    expect(matchesRoleSearch(role, 'shared', profileMap, dummyPresets)).toBe(false);
  });

  it('matches on designation', () => {
    const role = { role: 'Lead', profileId: 'claude-code:claude-opus-5.5', when: '', defaultDesignation: 'lead-dev' };
    expect(matchesRoleSearch(role, 'lead-dev', profileMap, dummyPresets)).toBe(true);
  });

  it('returns false when no fields match', () => {
    const role = { role: 'Lead', profileId: 'claude-code:claude-opus-5.5', when: 'Review tasks', defaultDesignation: 'reviewer' };
    expect(matchesRoleSearch(role, 'nonexistentxyz', profileMap, dummyPresets)).toBe(false);
  });
});

describe('stripUninjectableMcp', () => {
  const withMcp: SpawnTemplateRole = {
    role: 'impl',
    profileId: 'x',
    when: '',
    mcpServers: ['github'],
  };

  it('strips mcpServers for cursor', () => {
    expect(stripUninjectableMcp(withMcp, 'cursor').mcpServers).toBeUndefined();
  });

  it('keeps mcpServers for claude-code', () => {
    expect(stripUninjectableMcp(withMcp, 'claude-code').mcpServers).toEqual(['github']);
  });

  it('keeps mcpServers when agentType is undefined', () => {
    expect(stripUninjectableMcp(withMcp, undefined).mcpServers).toEqual(['github']);
  });
});

describe('sanitizeRoleForProfile', () => {
  function profile(over: Partial<AgentProfile>): AgentProfile {
    return {
      id: 'x', agentType: 'claude-code', model: 'sonnet', label: 'Claude Code · Sonnet',
      description: '', vision: false, steer: true, enabled: true, ...over,
    };
  }
  const withEffort: SpawnTemplateRole = {
    role: 'impl', profileId: 'x', when: '', effort: 'high',
  };

  it('drops effort for a cursor profile', () => {
    expect(sanitizeRoleForProfile(withEffort, profile({ agentType: 'cursor' })).effort).toBeUndefined();
  });

  it('keeps high for claude-code', () => {
    expect(sanitizeRoleForProfile(withEffort, profile({ agentType: 'claude-code' })).effort).toBe('high');
  });

  it('drops max for codex (codex levels are low/medium/high)', () => {
    expect(sanitizeRoleForProfile(
      { ...withEffort, effort: 'max' },
      profile({ agentType: 'codex' }),
    ).effort).toBeUndefined();
  });
});
