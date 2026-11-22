import { describe, it, expect } from 'vitest';
import { profileAvailableOnHost, isCloneUrlAllowed, AGENT_LOGIN_HINTS, HUB_TO_NODE_METHODS, NODE_FEATURES, NODE_TO_HUB_METHODS, REMOTE_LOGIN_AGENTS, isRemoteLoginAgent } from './node.js';
import type { NodeAgentInfo, RemoteHostView } from './node.js';

const claude = { agentType: 'claude-code', model: 'claude-sonnet-4-6' };
const grok = { agentType: 'grok-bot', model: 'default' };

function host(
  over: { state?: 'connected' | 'disconnected' | 'pending' | 'untrusted' | 'disabled'; agents?: Record<string, { installed: boolean; methods: string[] }>; models?: Record<string, string[]> } = {},
) {
  return {
    state: over.state ?? 'connected' as const,
    hello: {
      agents: over.agents ?? { 'claude-code': { installed: true, methods: [] } },
      models: over.models ?? { 'claude-code': ['claude-sonnet-4-6'] },
    },
  };
}

describe('profileAvailableOnHost', () => {
  it('agent_not_remote for grok-bot', () => {
    expect(profileAvailableOnHost(grok, host())).toEqual({ ok: false, reason: 'agent_not_remote' });
  });

  it('host_disconnected when host is missing', () => {
    expect(profileAvailableOnHost(claude, undefined)).toEqual({ ok: false, reason: 'host_disconnected' });
  });

  it('host_disconnected when state is not connected', () => {
    expect(profileAvailableOnHost(claude, host({ state: 'disconnected' })))
      .toEqual({ ok: false, reason: 'host_disconnected' });
    expect(profileAvailableOnHost(claude, host({ state: 'pending' })))
      .toEqual({ ok: false, reason: 'host_disconnected' });
  });

  it('agent_not_installed when the type is missing or not installed', () => {
    expect(profileAvailableOnHost(claude, host({ agents: {}, models: {} })))
      .toEqual({ ok: false, reason: 'agent_not_installed' });
    expect(profileAvailableOnHost(claude, host({
      agents: { 'claude-code': { installed: false, methods: [] } },
    }))).toEqual({ ok: false, reason: 'agent_not_installed' });
  });

  it('model_not_on_host when models[type] is non-empty and missing the model', () => {
    expect(profileAvailableOnHost(claude, host({
      models: { 'claude-code': ['claude-opus-4-8'] },
    }))).toEqual({ ok: false, reason: 'model_not_on_host' });
  });

  it('ok for a seed-only adapter with models[type] = []', () => {
    expect(profileAvailableOnHost(
      { agentType: 'copilot', model: 'gpt-5' },
      host({
        agents: { copilot: { installed: true, methods: [] } },
        models: { copilot: [] },
      }),
    )).toEqual({ ok: true });
  });

  it('ok when the model is listed', () => {
    expect(profileAvailableOnHost(claude, host())).toEqual({ ok: true });
  });

  it('ok when the model matches case-insensitively (e.g. GLM-5.3-Flash vs glm-5.3-flash)', () => {
    expect(profileAvailableOnHost(
      { agentType: 'hermes', model: 'GLM-5.3-Flash' },
      host({
        agents: { hermes: { installed: true, methods: [] } },
        models: { hermes: ['glm-5.3-flash'] },
      }),
    )).toEqual({ ok: true });
  });
});

describe('isCloneUrlAllowed', () => {
  const accepted = [
    'https://github.com/a/b.git',
    'https://github.com/a/b',
    'https://hub.example.com:8443/team/repo.git',
    'ssh://git@host:22/a/b',
    'ssh://host/path/to/repo',
    'git@github.com:a/b.git',
  ];
  it.each(accepted)('accepts %s', (url) => {
    expect(isCloneUrlAllowed(url)).toBe(true);
  });

  const rejected: Array<[string, string]> = [
    ['https://tok@github.com/a/b', 'userinfo on https'],
    ['https://u:p@h/x', 'user:pass on https'],
    ['file:///etc', 'file scheme'],
    ['ext::sh -c id', 'ext::'],
    ['/tmp/repo', 'local path'],
    ['-uhack', 'leading dash'],
    ['https://h/a b', 'space'],
    ['https://h/x\ty', 'control char'],
    ['git@h:-oProxyCommand=x', 'scp path starting with dash'],
    ['ssh://-oProxyCommand=x/a', 'ssh host starting with dash'],
    ['a'.repeat(2049), 'over 2048 chars'],
  ];
  it.each(rejected)('rejects %j (%s)', (url) => {
    expect(isCloneUrlAllowed(url)).toBe(false);
  });

  it('accepts a 2048-char url', () => {
    const long = `https://github.com/a/${'b'.repeat(2027)}`;
    expect(long.length).toBe(2048);
    expect(isCloneUrlAllowed(long)).toBe(true);
  });

  it('rejects non-string input', () => {
    expect(isCloneUrlAllowed(undefined as unknown as string)).toBe(false);
  });
});

describe('P2c contract additions', () => {
  it('HUB_TO_NODE_METHODS contains node.hello, fs.clone, agents.install', () => {
    expect(HUB_TO_NODE_METHODS).toContain('node.hello');
    expect(HUB_TO_NODE_METHODS).toContain('fs.clone');
    expect(HUB_TO_NODE_METHODS).toContain('agents.install');
  });

  it('NodeAgentInfo allows allowed/installable/loggedIn flags', () => {
    const info: NodeAgentInfo = { installed: true, methods: [], allowed: true, installable: false, loggedIn: true };
    expect(info.allowed).toBe(true);
  });

  it('RemoteHostView accepts installs entries', () => {
    const view: RemoteHostView = {
      id: 'h', name: 'h', state: 'connected', hello: {}, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 0,
      installs: [{ agentType: 'codex', running: false, ok: true, tail: 'done', at: 1 }],
    };
    expect(view.installs?.[0]?.agentType).toBe('codex');
  });

  it('NODE_FEATURES contains agents.login', () => {
    expect(NODE_FEATURES).toContain('agents.login');
  });

  it('NODE_FEATURES contains agents.login.claude', () => {
    expect(NODE_FEATURES).toContain('agents.login.claude');
  });

  it('NODE_FEATURES contains agents.loginStatus', () => {
    expect(NODE_FEATURES).toContain('agents.loginStatus');
  });

  it('does not advertise interactive login features for agents past wave 2b cursor', () => {
    expect(NODE_FEATURES).toContain('agents.login.copilot');
    expect(NODE_FEATURES).toContain('agents.login.grok');
    expect(NODE_FEATURES).toContain('agents.login.cursor');
    expect(NODE_FEATURES).not.toContain('agents.login.kimi');
    expect(NODE_FEATURES).not.toContain('agents.login.kiro');
    expect(NODE_FEATURES).not.toContain('agents.login.kilo');
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

  it('RemoteHostView accepts a logins array', () => {
    const view: RemoteHostView = {
      id: 'h', name: 'h', state: 'connected', hello: {}, allowMcpSecrets: false, allowAgentEnvSecrets: false, createdAt: 0,
      logins: [{ agentType: 'codex', running: true, url: 'https://auth.openai.com/codex/device', userCode: 'TAEF-M7I6R' }],
    };
    expect(view.logins?.[0]?.userCode).toBe('TAEF-M7I6R');
  });
});

describe('REMOTE_LOGIN_AGENTS', () => {
  it('covers Codex and Claude with the shipped feature ids', () => {
    expect(REMOTE_LOGIN_AGENTS.codex).toEqual(expect.objectContaining({
      feature: 'agents.login',
      label: 'Codex',
    }));
    expect(REMOTE_LOGIN_AGENTS['claude-code']).toEqual(expect.objectContaining({
      feature: 'agents.login.claude',
      label: 'Claude',
    }));
    expect(NODE_FEATURES).toContain(REMOTE_LOGIN_AGENTS.codex.feature);
    expect(NODE_FEATURES).toContain(REMOTE_LOGIN_AGENTS['claude-code'].feature);
  });

  it('isRemoteLoginAgent is true only for table keys', () => {
    expect(isRemoteLoginAgent('codex')).toBe(true);
    expect(isRemoteLoginAgent('claude-code')).toBe(true);
    expect(isRemoteLoginAgent('copilot')).toBe(true);
    expect(isRemoteLoginAgent('grok-build')).toBe(true);
    expect(isRemoteLoginAgent('cursor')).toBe(true);
    expect(isRemoteLoginAgent('pi')).toBe(false);
    expect(isRemoteLoginAgent('kimi')).toBe(false);
  });

  it('Copilot and Grok have per-agent feature ids in NODE_FEATURES', () => {
    expect(REMOTE_LOGIN_AGENTS.copilot.feature).toBe('agents.login.copilot');
    expect(REMOTE_LOGIN_AGENTS['grok-build'].feature).toBe('agents.login.grok');
    expect(NODE_FEATURES).toContain('agents.login.copilot');
    expect(NODE_FEATURES).toContain('agents.login.grok');
  });

  it('Cursor is url-only with agents.login.cursor', () => {
    expect(REMOTE_LOGIN_AGENTS.cursor).toEqual({
      feature: 'agents.login.cursor',
      label: 'Cursor',
      flow: 'url',
    });
    expect(NODE_FEATURES).toContain('agents.login.cursor');
  });
});

describe('AGENT_LOGIN_HINTS', () => {
  it('names the real CLI login commands', () => {
    expect(AGENT_LOGIN_HINTS['grok-build']?.cmd).toBe('grok login');
    expect(AGENT_LOGIN_HINTS.cursor?.cmd).toBe('cursor-agent login');
    expect(AGENT_LOGIN_HINTS.kimi?.cmd).toBe('kimi login');
    expect(AGENT_LOGIN_HINTS.copilot?.cmd).toBe('copilot login');
    expect(AGENT_LOGIN_HINTS.kiro?.cmd).toBe('kiro-cli login');
  });

  it('points at the vault env where one exists', () => {
    expect(AGENT_LOGIN_HINTS.kiro?.env).toBe('KIRO_API_KEY');
    expect(AGENT_LOGIN_HINTS.cursor?.env).toBe('CURSOR_API_KEY');
    expect(AGENT_LOGIN_HINTS.kimi?.env).toBe('KIMI_API_KEY');
    expect(AGENT_LOGIN_HINTS.copilot?.env).toBe('COPILOT_GITHUB_TOKEN');
    expect(AGENT_LOGIN_HINTS['grok-build']?.env).toBe('XAI_API_KEY');
  });

  it('does not cover Codex, Claude, or Kilo', () => {
    expect(AGENT_LOGIN_HINTS.codex).toBeUndefined();
    expect(AGENT_LOGIN_HINTS['claude-code']).toBeUndefined();
    expect(AGENT_LOGIN_HINTS.kilocode).toBeUndefined();
  });
});
