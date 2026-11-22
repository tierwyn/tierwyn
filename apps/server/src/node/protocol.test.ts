import { describe, it, expect } from 'vitest';
import { isTunnelPathAllowed, HUB_TO_NODE_METHODS, NODE_TO_HUB_METHODS, hostHasFeature, NODE_FEATURES } from '@tierwyn/shared';

describe('isTunnelPathAllowed', () => {
  // Task 11 must replay with http.request and the raw, already-checked path.
  // Never new URL() / fetch() — WHATWG pathname normalisation would decode
  // %2e%2e into `..` after this check if we only looked at decoded segments.
  const cases: Array<[string, string, boolean]> = [
    ['POST', '/spawn/raw', true],
    ['POST', '/spawn/abc/message', true],
    ['GET', '/agent/plugins/x/help', true],
    ['GET', '/agent/help', true],
    ['GET', '/agent/help/spawn', true],
    ['GET', '/agent/schedule-help', true],
    ['GET', '/agent/memory?q=a', true],
    ['GET', '/agent/search?q=foo', true],
    ['GET', '/agent/conversations/abc/context?eventId=e1', true],
    ['POST', '/agent/memory', true],
    ['POST', '/agent/memory/m_1/supersede', true],
    ['GET', '/spawn/abc/result?parentConversationId=p', true],
    ['GET', '/settings', false],
    ['POST', '/auth/login', false],
    ['POST', '/agent/../settings', false],
    ['POST', '//spawn', false],
    ['POST', '/spawn%2f..%2fsettings', false],
    ['POST', '/SPAWN', false],
    ['GET', '/conversations/x/transcript', false],
    ['DELETE', '/spawn/abc/message', false],
    ['GET', '/agent/%2e%2e/settings', false],
    ['GET', '/agent/.%2e/auth/login', false],
    ['GET', '/agent/%2E%2E/conversations/x/transcript', false],
    ['GET', '/schedules/job-abc/steps', true],
    ['PUT', '/schedules/job-abc/steps', true],
    ['PATCH', '/schedules/job-abc/steps', true],
    ['PATCH', '/schedules/job-abc/steps/step-1', true],
    ['POST', '/schedules/job-abc/steps/complete-all', true],
    ['POST', '/schedules/job-abc/complete-job', true],
    ['DELETE', '/agent/mcp/n8n', true],
    ['DELETE', '/agent/plugins/x', false],
    ['DELETE', '/agent/mcp/a/b', false],
  ];

  it.each(cases)('%s %s → %s', (method, path, expected) => {
    expect(isTunnelPathAllowed(method, path)).toBe(expected);
  });
});

describe('hostHasFeature', () => {
  it('true only when the hello lists the feature', () => {
    const hello = { features: ['tunnel.stream'] };
    expect(hostHasFeature(hello as never, 'tunnel.stream')).toBe(true);
    expect(hostHasFeature(hello as never, 'files.write')).toBe(false);
  });
  it('missing features / missing hello → false', () => {
    expect(hostHasFeature(undefined, 'tunnel.stream')).toBe(false);
    expect(hostHasFeature({} as never, 'tunnel.stream')).toBe(false);
    expect(hostHasFeature({ features: [] } as never, 'tunnel.stream')).toBe(false);
  });
  it('NODE_FEATURES covers the P3 capability set', () => {
    expect(NODE_FEATURES).toContain('tunnel.stream');
    expect(NODE_FEATURES).toContain('mcp.native');
    expect(NODE_FEATURES).toContain('files.write');
    expect(NODE_FEATURES).toContain('artifacts.sweep');
    expect(NODE_FEATURES).toContain('git.worktree');
    expect(NODE_FEATURES).toContain('git.shadow');
    expect(NODE_FEATURES).toContain('node.selfUpdate');
    expect(NODE_FEATURES).toContain('fs.mkdir');
    expect(NODE_FEATURES).toContain('fs.move');
    expect(NODE_FEATURES).toContain('trust_repo_config');
    expect(NODE_FEATURES).toContain('sandbox');
    expect(NODE_FEATURES).toContain('sandbox_paths');
    expect(NODE_FEATURES).toContain('schedule.packFiles');
  });
});

describe('artifact RPC methods', () => {
  it('HUB_TO_NODE_METHODS includes the three artifact methods', () => {
    expect(HUB_TO_NODE_METHODS).toContain('artifact.read');
    expect(HUB_TO_NODE_METHODS).toContain('artifact.write');
    expect(HUB_TO_NODE_METHODS).toContain('artifact.purge');
  });
});

describe('git.call protocol', () => {
  it('HUB_TO_NODE_METHODS contains git.call', () => {
    expect(HUB_TO_NODE_METHODS).toContain('git.call');
  });
  it('HUB_TO_NODE_METHODS contains node.selfUpdate', () => {
    expect(HUB_TO_NODE_METHODS).toContain('node.selfUpdate');
  });
  it('HUB_TO_NODE_METHODS contains fs.mkdir', () => {
    expect(HUB_TO_NODE_METHODS).toContain('fs.mkdir');
  });
  it('HUB_TO_NODE_METHODS contains fs.move', () => {
    expect(HUB_TO_NODE_METHODS).toContain('fs.move');
  });
  it('HUB_TO_NODE_METHODS contains schedule.packFiles', () => {
    expect(HUB_TO_NODE_METHODS).toContain('schedule.packFiles');
  });
});

describe('agentEnv.sync protocol', () => {
  it('NODE_FEATURES contains agent_env', () => {
    expect(NODE_FEATURES).toContain('agent_env');
  });
  it('HUB_TO_NODE_METHODS contains agentEnv.sync', () => {
    expect(HUB_TO_NODE_METHODS).toContain('agentEnv.sync');
  });
});

describe('agents.login protocol', () => {
  it('NODE_FEATURES contains agents.login', () => {
    expect(NODE_FEATURES).toContain('agents.login');
  });
  it('NODE_FEATURES contains agents.login.claude', () => {
    expect(NODE_FEATURES).toContain('agents.login.claude');
  });
  it('NODE_FEATURES contains agents.login.copilot and agents.login.grok', () => {
    expect(NODE_FEATURES).toContain('agents.login.copilot');
    expect(NODE_FEATURES).toContain('agents.login.grok');
  });
  it('NODE_FEATURES contains agents.login.cursor', () => {
    expect(NODE_FEATURES).toContain('agents.login.cursor');
  });
  it('NODE_FEATURES contains agents.loginStatus', () => {
    expect(NODE_FEATURES).toContain('agents.loginStatus');
  });
  it('HUB_TO_NODE_METHODS contains agents.login', () => {
    expect(HUB_TO_NODE_METHODS).toContain('agents.login');
  });
  it('HUB_TO_NODE_METHODS contains agents.loginStatus', () => {
    expect(HUB_TO_NODE_METHODS).toContain('agents.loginStatus');
  });
  it('NODE_TO_HUB_METHODS contains agents.loginEvent', () => {
    expect(NODE_TO_HUB_METHODS).toContain('agents.loginEvent');
  });
});
