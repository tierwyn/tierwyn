import { describe, it, expect } from 'vitest';
import { resolveAgentSearchScope, type AgentSearchScopeSetting } from './search.js';

const SCOPES: AgentSearchScopeSetting[] = ['off', 'project', 'all'];

describe('resolveAgentSearchScope', () => {
  it.each(SCOPES)('project null inherits global %s, source global, uncapped', (globalScope) => {
    expect(resolveAgentSearchScope({
      projectScope: null,
      globalScope,
      sandboxOn: false,
    })).toEqual({ effective: globalScope, source: 'global', cappedBySandbox: false });
  });

  it.each(SCOPES)('project %s overrides a different global, source project, uncapped', (projectScope) => {
    const globalScope: AgentSearchScopeSetting = projectScope === 'off' ? 'all' : 'off';
    expect(resolveAgentSearchScope({
      projectScope,
      globalScope,
      sandboxOn: false,
    })).toEqual({ effective: projectScope, source: 'project', cappedBySandbox: false });
  });

  it('project all + sandbox caps to project / capped / source project', () => {
    expect(resolveAgentSearchScope({
      projectScope: 'all',
      globalScope: 'off',
      sandboxOn: true,
    })).toEqual({ effective: 'project', source: 'project', cappedBySandbox: true });
  });

  it('global all + sandbox + project null caps to project / capped / source global', () => {
    expect(resolveAgentSearchScope({
      projectScope: null,
      globalScope: 'all',
      sandboxOn: true,
    })).toEqual({ effective: 'project', source: 'global', cappedBySandbox: true });
  });

  it('off + sandbox stays off uncapped', () => {
    expect(resolveAgentSearchScope({
      projectScope: 'off',
      globalScope: 'all',
      sandboxOn: true,
    })).toEqual({ effective: 'off', source: 'project', cappedBySandbox: false });
  });

  it('project + sandbox stays project uncapped', () => {
    expect(resolveAgentSearchScope({
      projectScope: 'project',
      globalScope: 'all',
      sandboxOn: true,
    })).toEqual({ effective: 'project', source: 'project', cappedBySandbox: false });
  });
});
