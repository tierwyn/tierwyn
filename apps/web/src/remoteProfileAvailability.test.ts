import { describe, it, expect } from 'vitest';
import type { AgentProfile, RemoteHostView } from '@tierwyn/shared';
import { remoteProfileAvailability } from './remoteProfileAvailability.js';

function profile(id: string, agentType: string, model: string): AgentProfile {
  return {
    id,
    agentType,
    model,
    label: id,
    description: '',
    vision: false,
    steer: false,
    enabled: true,
  };
}

function host(over: Partial<RemoteHostView> = {}): RemoteHostView {
  return {
    id: 'h1',
    name: 'box',
    state: 'connected',
    hello: {},
    allowMcpSecrets: true,
    allowAgentEnvSecrets: false,
    createdAt: 0,
    ...over,
  };
}

const claude = profile('claude-code:sonnet', 'claude-code', 'claude-sonnet-4-6');
const opus = profile('claude-code:opus', 'claude-code', 'claude-opus-4-8');
const copilot = profile('copilot:gpt-5', 'copilot', 'gpt-5');
const grok = profile('grok-bot:default', 'grok-bot', 'default');

const installedClaude: RemoteHostView['hello'] = {
  agents: { 'claude-code': { installed: true, methods: [] } },
  models: { 'claude-code': ['claude-sonnet-4-6'] },
};

describe('remoteProfileAvailability', () => {
  it('returns {} for a local project (host undefined)', () => {
    expect(remoteProfileAvailability([claude, grok], undefined)).toEqual({});
  });

  it('greys every profile on a disconnected host', () => {
    const disconnected = host({ state: 'disconnected', hello: installedClaude });
    expect(remoteProfileAvailability([claude, grok], disconnected)).toEqual({
      [claude.id]: 'host offline',
      [grok.id]: 'local only',
    });
  });

  it('greys an uninstalled agent with not installed on host', () => {
    const h = host({
      hello: {
        agents: { 'claude-code': { installed: false, methods: [] } },
        models: {},
      },
    });
    expect(remoteProfileAvailability([claude], h)).toEqual({
      [claude.id]: 'not installed on host',
    });
  });

  it('keeps a seed-only adapter available when models is []', () => {
    const h = host({
      hello: {
        agents: { copilot: { installed: true, methods: [] } },
        models: { copilot: [] },
      },
    });
    expect(remoteProfileAvailability([copilot], h)).toEqual({});
  });

  it('keeps a seed-only adapter available when models is missing', () => {
    const h = host({
      hello: {
        agents: { copilot: { installed: true, methods: [] } },
      },
    });
    expect(remoteProfileAvailability([copilot], h)).toEqual({});
  });

  it('greys a model missing from a non-empty list', () => {
    const h = host({ hello: installedClaude });
    expect(remoteProfileAvailability([claude, opus], h)).toEqual({
      [opus.id]: 'model not on host',
    });
  });

  it("labels grok-bot as local only", () => {
    const h = host({
      hello: {
        agents: { 'grok-bot': { installed: true, methods: [] } },
        models: {},
      },
    });
    expect(remoteProfileAvailability([grok], h)).toEqual({
      [grok.id]: 'local only',
    });
  });
});
