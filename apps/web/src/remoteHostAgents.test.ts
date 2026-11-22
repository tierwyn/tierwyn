import { describe, it, expect } from 'vitest';
import {
  agentLoginAvailable,
  descriptionPatch,
  hostDeleteConfirm,
  inFlightLogins,
  loginAgentLabel,
  loginFor,
  loginResumeKey,
  loginResumeMessage,
  notLoggedInTitle,
  remoteHostAgentRows,
  remoteUpdateAction,
  shouldShowLoginModal,
  shouldShowLoginResume,
} from './remoteHostAgents.js';
import type { NodeAgentInfo, RemoteHostView } from '@tierwyn/shared';

const agent = (over: Partial<NodeAgentInfo> = {}): NodeAgentInfo => ({
  installed: false,
  methods: [],
  ...over,
});

function host(opts: {
  agents?: Record<string, NodeAgentInfo>;
  installs?: Array<{ agentType: string; running: boolean; ok?: boolean; tail?: string; at: number }>;
  features?: string[];
} = {}): RemoteHostView {
  return {
    id: 'h1',
    name: 'box',
    state: 'connected',
    hello: {
      hostname: 'box', os: 'linux', arch: 'x64',
      agents: opts.agents ?? {},
      ...(opts.features ? { features: opts.features as RemoteHostView['hello']['features'] } : {}),
    },
    allowMcpSecrets: false,
    allowAgentEnvSecrets: false,
    createdAt: 1,
    ...(opts.installs ? { installs: opts.installs } : {}),
  } as RemoteHostView;
}

describe('remoteHostAgentRows', () => {
  it('only includes types allowed or installed', () => {
    const rows = remoteHostAgentRows(host({
      agents: {
        'claude-code': agent({ allowed: true }),
        pi: agent({ installed: true }),
        codex: agent({ allowed: false, installed: false }),
      },
    }));
    expect(rows.map((r) => r.type).sort()).toEqual(['claude-code', 'pi']);
  });

  it('omits types the hub no longer serves (stale node hello)', () => {
    const rows = remoteHostAgentRows(host({
      agents: {
        'claude-code': agent({ allowed: true, installed: true }),
        openclaude: agent({ allowed: true, installed: true }),
      },
    }));
    expect(rows.map((r) => r.type)).toEqual(['claude-code']);
  });

  it('old node without allowed → installed-only fallback', () => {
    const rows = remoteHostAgentRows(host({
      agents: {
        'claude-code': { installed: true, methods: [] },
        pi: { installed: false, methods: [] },
      },
    }));
    expect(rows.map((r) => r.type)).toEqual(['claude-code']);
  });

  it('installed → ready', () => {
    const [row] = remoteHostAgentRows(host({ agents: { 'claude-code': agent({ allowed: true, installed: true, loggedIn: true }) } }));
    expect(row.state).toBe('ready');
    expect(row.lastError).toBeUndefined();
  });

  it('installed with loggedIn === false → not_logged_in', () => {
    const [row] = remoteHostAgentRows(host({ agents: { 'claude-code': agent({ allowed: true, installed: true, loggedIn: false }) } }));
    expect(row.state).toBe('not_logged_in');
  });

  it('installed but a run is in flight → installing', () => {
    const [row] = remoteHostAgentRows(host({
      agents: { 'claude-code': agent({ allowed: true, installed: true }) },
      installs: [{ agentType: 'claude-code', running: true, at: 5 }],
    }));
    expect(row.state).toBe('installing');
  });

  it('not installed → missing with installable flag', () => {
    const rows = remoteHostAgentRows(host({
      agents: { 'claude-code': agent({ allowed: true, installed: false, installable: true }) },
    }));
    expect(rows[0].state).toBe('missing');
    expect(rows[0].installable).toBe(true);
    expect(rows[0].state).not.toBe('ready');
  });

  it('latest failed install → lastError = last log line', () => {
    const [row] = remoteHostAgentRows(host({
      agents: { 'claude-code': agent({ allowed: true, installed: false }) },
      installs: [
        { agentType: 'claude-code', running: false, ok: true, tail: 'added', at: 1 },
        { agentType: 'claude-code', running: false, ok: false, tail: 'npm warn deprecated\n' + 'x'.repeat(500) + '\nfatal: boom', at: 2 },
      ],
    }));
    expect(row.state).toBe('missing');
    expect(row.lastError).toBe('fatal: boom');
  });

  it('last log line longer than 300 chars is capped', () => {
    const [row] = remoteHostAgentRows(host({
      agents: { 'claude-code': agent({ allowed: true }) },
      installs: [{ agentType: 'claude-code', running: false, ok: false, tail: 'y'.repeat(400), at: 3 }],
    }));
    expect(row.lastError).toBe('y'.repeat(300));
  });

  it('a passing latest install clears lastError', () => {
    const [row] = remoteHostAgentRows(host({
      agents: { 'claude-code': agent({ allowed: true, installed: true }) },
      installs: [{ agentType: 'claude-code', running: false, ok: true, tail: 'added', at: 9 }],
    }));
    expect(row.lastError).toBeUndefined();
  });

  it('no agents on the host → empty rows', () => {
    expect(remoteHostAgentRows(host())).toEqual([]);
  });

  it('maps version, latestVersion and behind from hello', () => {
    const [row] = remoteHostAgentRows(host({
      agents: { 'claude-code': agent({ allowed: true, installed: true, version: '1.2.3', latestVersion: '2.0.0', behind: true }) },
    }));
    expect(row.version).toBe('1.2.3');
    expect(row.latestVersion).toBe('2.0.0');
    expect(row.behind).toBe(true);
  });

  it('forwards behind:false (known current) and leaves an absent behind absent', () => {
    const rows = remoteHostAgentRows(host({
      agents: {
        'claude-code': agent({ allowed: true, installed: true, behind: false }),
        pi: agent({ allowed: true, installed: true }),
      },
    }));
    expect(rows.find((r) => r.type === 'claude-code')!.behind).toBe(false);
    expect(rows.find((r) => r.type === 'pi')!.behind).toBeUndefined();
  });

  it('type in installBatch.remaining and not running → queued', () => {
    const h = {
      ...host({ agents: { 'claude-code': agent({ allowed: true, installed: false, installable: true }) } }),
      installBatch: { running: true, remaining: ['claude-code'] },
    } as RemoteHostView;
    expect(remoteHostAgentRows(h)[0].state).toBe('queued');
  });

  it('a running install wins over the queued state', () => {
    const h = {
      ...host({
        agents: { 'claude-code': agent({ allowed: true, installed: false, installable: true }) },
        installs: [{ agentType: 'claude-code', running: true, at: 5 }],
      }),
      installBatch: { running: true, remaining: ['claude-code'] },
    } as RemoteHostView;
    expect(remoteHostAgentRows(h)[0].state).toBe('installing');
  });

  it('lastOkAt is the latest settled successful run (success feedback window)', () => {
    const [row] = remoteHostAgentRows(host({
      agents: { 'claude-code': agent({ allowed: true, installed: true }) },
      installs: [
        { agentType: 'claude-code', running: false, ok: true, tail: 'added', at: 100 },
        { agentType: 'claude-code', running: true, at: 200 },
      ],
    }));
    expect(row.lastOkAt).toBe(100);
  });
});

describe('remoteUpdateAction', () => {
  it('update when behind, none when known current, reinstall when unknown', () => {
    const row = (behind?: boolean): Parameters<typeof remoteUpdateAction>[0] => ({
      type: 'claude-code',
      state: 'ready',
      installable: true,
      ...(behind !== undefined ? { behind } : {}),
    });
    expect(remoteUpdateAction(row(true))).toBe('update');
    expect(remoteUpdateAction(row(false))).toBeNull();
    expect(remoteUpdateAction(row(undefined))).toBe('reinstall');
  });
});

describe('loginAgentLabel', () => {
  it('uses REMOTE_LOGIN_AGENTS labels for Codex and Claude', () => {
    expect(loginAgentLabel('codex')).toBe('Codex');
    expect(loginAgentLabel('claude-code')).toBe('Claude');
    expect(loginAgentLabel('copilot')).toBe('Copilot');
    expect(loginAgentLabel('grok-build')).toBe('Grok');
    expect(loginAgentLabel('cursor')).toBe('Cursor');
    expect(loginAgentLabel('pi')).toBe('pi');
  });
});

describe('agentLoginAvailable', () => {
  it('false without the agents.login feature', () => {
    expect(agentLoginAvailable(host({
      agents: { codex: agent({ installed: true }) },
    }), 'codex')).toBe(false);
  });

  it('false when codex is not installed', () => {
    expect(agentLoginAvailable(host({
      features: ['agents.login'],
      agents: { codex: agent({ installed: false, allowed: true }) },
    }), 'codex')).toBe(false);
  });

  it('false when only pi is installed', () => {
    expect(agentLoginAvailable(host({
      features: ['agents.login'],
      agents: { pi: agent({ installed: true }) },
    }), 'codex')).toBe(false);
  });

  it('true when feature and installed codex', () => {
    expect(agentLoginAvailable(host({
      features: ['agents.login'],
      agents: { codex: agent({ installed: true }) },
    }), 'codex')).toBe(true);
  });

  it('false when host is not connected', () => {
    expect(agentLoginAvailable({
      ...host({
        features: ['agents.login'],
        agents: { codex: agent({ installed: true }) },
      }),
      state: 'disconnected',
    }, 'codex')).toBe(false);
  });

  it('claude-code needs agents.login.claude, not agents.login', () => {
    expect(agentLoginAvailable(host({ features: ['agents.login'], agents: { 'claude-code': agent({ installed: true }) } }), 'claude-code')).toBe(false);
    expect(agentLoginAvailable(host({ features: ['agents.login.claude'], agents: { 'claude-code': agent({ installed: true }) } }), 'claude-code')).toBe(true);
  });
  it('false while disconnected', () => {
    expect(agentLoginAvailable({
      ...host({ features: ['agents.login.claude'], agents: { 'claude-code': agent({ installed: true }) } }),
      state: 'disconnected',
    }, 'claude-code')).toBe(false);
  });
  it('other agents are never available', () => {
    expect(agentLoginAvailable(host({ features: ['agents.login', 'agents.login.claude'], agents: { pi: agent({ installed: true }) } }), 'pi')).toBe(false);
  });
  it('copilot needs agents.login.copilot and grok-build needs agents.login.grok', () => {
    expect(agentLoginAvailable(host({ features: ['agents.login'], agents: { copilot: agent({ installed: true }) } }), 'copilot')).toBe(false);
    expect(agentLoginAvailable(host({ features: ['agents.login.copilot'], agents: { copilot: agent({ installed: true }) } }), 'copilot')).toBe(true);
    expect(agentLoginAvailable(host({ features: ['agents.login.copilot'], agents: { 'grok-build': agent({ installed: true }) } }), 'grok-build')).toBe(false);
    expect(agentLoginAvailable(host({ features: ['agents.login.grok'], agents: { 'grok-build': agent({ installed: true }) } }), 'grok-build')).toBe(true);
  });
  it('cursor needs agents.login.cursor', () => {
    expect(agentLoginAvailable(host({ features: ['agents.login'], agents: { cursor: agent({ installed: true }) } }), 'cursor')).toBe(false);
    expect(agentLoginAvailable(host({ features: ['agents.login.cursor'], agents: { cursor: agent({ installed: true }) } }), 'cursor')).toBe(true);
  });
  it('a delivered token renders ready, so the login chip path is never reached', () => {
    const [row] = remoteHostAgentRows(host({ features: ['agents.login.claude'], agents: { 'claude-code': agent({ installed: true, allowed: true, loggedIn: true }) } }));
    expect(row.state).toBe('ready');
  });
});

describe('inFlightLogins / resume prompt', () => {
  it('never tells the operator a failed login is still in progress', () => {
    expect(loginResumeMessage({ agentType: 'codex', running: true })).toContain('still in progress');
    const failed = loginResumeMessage({ agentType: 'codex', running: false, error: 'denied' });
    expect(failed).not.toContain('still in progress');
    expect(failed).toContain('denied');
    expect(loginResumeMessage({ agentType: 'codex', running: true }, 'this hub')).toContain('on this hub');
    expect(loginResumeMessage({ agentType: 'codex', running: false, error: 'denied' }, 'this hub')).toContain('on this hub');
  });

  const claude = { agentType: 'claude-code', running: true, url: 'https://claude.example/auth' };
  const errored = { agentType: 'codex', running: false, error: 'denied' };

  it('surfaces running and error leftover logins, not idle hosts', () => {
    const a = { ...host(), id: 'h1', name: 'box', logins: [claude, errored] };
    const b = { ...host(), id: 'h2', name: 'quiet' };
    const found = inFlightLogins([a, b]);
    expect(found.map((x) => `${x.hostId}:${x.agentType}`).sort()).toEqual(['h1:claude-code', 'h1:codex']);
    expect(found.find((x) => x.agentType === 'codex')?.login.error).toBe('denied');
  });

  it('prompt shows on load for in-flight state; reopen/restart/dismiss are the three actions', () => {
    const k = loginResumeKey('h1', 'claude-code');
    expect(k).toBe('h1:claude-code');
    const loadKeys = new Set([k]);
    const base = { hostId: 'h1', agentType: 'claude-code', primed: true, loadKeys, opened: new Set<string>(), dismissed: new Set<string>() };
    expect(shouldShowLoginResume(base)).toBe(true);
    expect(shouldShowLoginModal(base)).toBe(false);

    const reopened = { ...base, opened: new Set([k]) };
    expect(shouldShowLoginResume(reopened)).toBe(false);
    expect(shouldShowLoginModal(reopened)).toBe(true);

    const restarted = { ...base, opened: new Set([k]) };
    expect(shouldShowLoginModal(restarted)).toBe(true);
    expect(shouldShowLoginResume(restarted)).toBe(false);

    const dismissed = { ...base, dismissed: new Set([k]) };
    expect(shouldShowLoginResume(dismissed)).toBe(false);
    expect(shouldShowLoginModal(dismissed)).toBe(false);
  });

  it('a login started after load auto-opens without a prompt', () => {
    const opts = {
      hostId: 'h1', agentType: 'codex', primed: true,
      loadKeys: new Set([loginResumeKey('h1', 'claude-code')]),
      opened: new Set<string>(), dismissed: new Set<string>(),
    };
    expect(shouldShowLoginResume(opts)).toBe(false);
    expect(shouldShowLoginModal(opts)).toBe(true);
  });

  it('does not show modal or prompt before the first list fetch primes', () => {
    const opts = {
      hostId: 'h1', agentType: 'codex', primed: false,
      loadKeys: new Set([loginResumeKey('h1', 'codex')]),
      opened: new Set<string>(), dismissed: new Set<string>(),
    };
    expect(shouldShowLoginResume(opts)).toBe(false);
    expect(shouldShowLoginModal(opts)).toBe(false);
  });
});

describe('loginFor', () => {
  it('returns only that agent\'s login state', () => {
    const h = {
      ...host(),
      logins: [
        { agentType: 'claude-code', running: true, url: 'https://claude.example/auth' },
        { agentType: 'codex', running: true, userCode: 'TAEF-M7I6R' },
      ],
    };
    expect(loginFor(h, 'codex')?.userCode).toBe('TAEF-M7I6R');
    expect(loginFor(h, 'codex')?.url).toBeUndefined();
    expect(loginFor(h, 'claude-code')?.url).toBe('https://claude.example/auth');
    expect(loginFor(h, 'claude-code')?.userCode).toBeUndefined();
    expect(loginFor(h, 'pi')).toBeUndefined();
  });
});

describe('notLoggedInTitle', () => {
  it('keeps Claude wording', () => {
    expect(notLoggedInTitle('claude-code')).toBe('run "claude auth login" on the host, then Refresh');
  });

  it('keeps Codex wording with no env mention', () => {
    expect(notLoggedInTitle('codex')).toBe('run "codex login" on the host, then Refresh');
  });

  it('uses grok login, not grok-build login', () => {
    expect(notLoggedInTitle('grok-build')).toContain('"grok login"');
    expect(notLoggedInTitle('grok-build')).not.toContain('grok-build login');
    expect(notLoggedInTitle('grok-build')).toContain('XAI_API_KEY');
    expect(notLoggedInTitle('grok-build')).toContain('Settings → Agents');
  });

  it('uses cursor-agent login and CURSOR_API_KEY', () => {
    expect(notLoggedInTitle('cursor')).toContain('"cursor-agent login"');
    expect(notLoggedInTitle('cursor')).toContain('CURSOR_API_KEY');
  });

  it('uses kimi login and KIMI_API_KEY', () => {
    expect(notLoggedInTitle('kimi')).toContain('"kimi login"');
    expect(notLoggedInTitle('kimi')).toContain('KIMI_API_KEY');
  });

  it('uses copilot login and COPILOT_GITHUB_TOKEN', () => {
    expect(notLoggedInTitle('copilot')).toContain('"copilot login"');
    expect(notLoggedInTitle('copilot')).toContain('COPILOT_GITHUB_TOKEN');
  });

  it('uses kiro-cli login and KIRO_API_KEY', () => {
    expect(notLoggedInTitle('kiro')).toContain('"kiro-cli login"');
    expect(notLoggedInTitle('kiro')).toContain('KIRO_API_KEY');
    expect(notLoggedInTitle('kiro')).toContain('Settings → Agents');
  });

  it('does not invent a kilo login hint', () => {
    expect(notLoggedInTitle('kilocode')).not.toContain('kilo auth');
  });
});

describe('hostDeleteConfirm', () => {
  it('plain delete when no project is bound', () => {
    const c = hostDeleteConfirm(host());
    expect(c.unbind).toBe(false);
    expect(c.confirmLabel).toBe('Delete');
    expect(c.body).toMatch(/not uninstalled/i);
  });

  it('unbinds named projects when the host is in use', () => {
    const c = hostDeleteConfirm({
      ...host(),
      boundProjects: [{ id: 'p1', name: 'IronRDP' }],
    });
    expect(c.unbind).toBe(true);
    expect(c.confirmLabel).toBe('Delete and unbind');
    expect(c.body).toContain('IronRDP');
  });
});

describe('descriptionPatch', () => {
  it('returns undefined when unchanged', () => expect(descriptionPatch('a', ' a ')).toBeUndefined());
  it('returns undefined when both empty', () => expect(descriptionPatch(undefined, '  ')).toBeUndefined());
  it('returns null to clear', () => expect(descriptionPatch('a', '  ')).toBeNull());
  it('returns trimmed value', () => expect(descriptionPatch('a', 'b')).toBe('b'));
});
