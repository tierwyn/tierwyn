import { describe, it, expect } from 'vitest';
import type {
  AgentProfile,
  GrokBotLifecycleStatus,
  Project,
  RemoteHostView,
} from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { forcedExecutionMode, isBarePromptProfile, scheduleProfilesFor } from './scheduleProfiles.js';

const BOT = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function profile(over: Partial<AgentProfile> & Pick<AgentProfile, 'id' | 'agentType' | 'model'>): AgentProfile {
  return {
    label: over.label ?? over.id,
    description: '',
    vision: false,
    steer: true,
    enabled: true,
    ...over,
  };
}

const CLAUDE = profile({ id: 'claude-code:opus-4.8', agentType: 'claude-code', model: 'opus-4.8', label: 'Claude Opus' });
const PI = profile({ id: 'pi:default', agentType: 'pi', model: 'default', label: 'Pi' });
const GROK_DEFAULT = profile({ id: 'grok-bot:default', agentType: 'grok-bot', model: 'default', label: 'Grok Bot Default' });
const GROK_BOT = profile({ id: `grok-bot:${BOT}`, agentType: 'grok-bot', model: BOT, label: 'Grok Bot · Inbox' });

const ALL = [CLAUDE, PI, GROK_DEFAULT, GROK_BOT];

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    name: 'App',
    rootPath: '/tmp/app',
    createdAt: 1,
    ...over,
  };
}

function status(state: GrokBotLifecycleStatus['state'], over: Partial<GrokBotLifecycleStatus> = {}): GrokBotLifecycleStatus {
  return {
    state,
    enabled: true,
    autoStart: 'on-demand',
    envLocks: { autostart: false, watch: false },
    launcher: null,
    attribution: null,
    layout: 'native',
    attempts: 0,
    nextAttemptAt: null,
    lastError: null,
    lastErrorAt: null,
    since: 1,
    ...over,
  };
}

function host(over: Partial<RemoteHostView> & { installed?: string[] } = {}): RemoteHostView {
  const installed = over.installed ?? ['claude-code'];
  const agents: Record<string, { installed: boolean; methods: string[] }> = {};
  for (const t of installed) agents[t] = { installed: true, methods: [] };
  return {
    id: 'host-1',
    name: 'node-a',
    state: 'connected',
    hello: {
      agents,
      models: { 'claude-code': ['opus-4.8'] },
    },
    allowMcpSecrets: true,
    allowAgentEnvSecrets: false,
    createdAt: 1,
    ...over,
  };
}

describe('isBarePromptProfile', () => {
  it('is true for grok-bot and false otherwise', () => {
    expect(isBarePromptProfile(GROK_BOT)).toBe(true);
    expect(isBarePromptProfile(CLAUDE)).toBe(false);
    expect(isBarePromptProfile(undefined)).toBe(false);
  });
});

describe('forcedExecutionMode', () => {
  it('returns resume for the Remote Agents project', () => {
    expect(forcedExecutionMode(
      project({ id: REMOTE_AGENTS_PROJECT_ID, name: 'Grok Bots', system: true }),
      CLAUDE,
    )).toBe('resume_conversation');
  });

  it('returns resume for a grok-bot profile in a normal project', () => {
    expect(forcedExecutionMode(project(), GROK_BOT)).toBe('resume_conversation');
  });

  it('returns null for claude-code in a normal project', () => {
    expect(forcedExecutionMode(project(), CLAUDE)).toBeNull();
  });
});

describe('scheduleProfilesFor', () => {
  it('Remote Agents keeps only grok-bot Bot-id profiles and drops grok-bot:default', () => {
    const r = scheduleProfilesFor({
      project: project({ id: REMOTE_AGENTS_PROJECT_ID, name: 'Grok Bots', system: true }),
      profiles: ALL,
      hosts: [],
      grokBotInProjectChats: false,
      grokBotStatus: status('running'),
    });
    expect(r.profiles.map((p) => p.id)).toEqual([`grok-bot:${BOT}`]);
    expect(r.hiddenForHost).toBe(0);
    expect(r.grokBotWarning).toBeUndefined();
  });

  it('normal project drops grok-bot when grokBotInProjectChats=false', () => {
    const r = scheduleProfilesFor({
      project: project(),
      profiles: ALL,
      hosts: [],
      grokBotInProjectChats: false,
      grokBotStatus: status('running'),
    });
    expect(r.profiles.map((p) => p.id)).toEqual(['claude-code:opus-4.8', 'pi:default']);
  });

  it('normal project keeps grok-bot (not default) when grokBotInProjectChats=true', () => {
    const r = scheduleProfilesFor({
      project: project(),
      profiles: ALL,
      hosts: [],
      grokBotInProjectChats: true,
      grokBotStatus: status('running'),
    });
    expect(r.profiles.map((p) => p.id)).toEqual(['claude-code:opus-4.8', 'pi:default', `grok-bot:${BOT}`]);
  });

  it('remote-host project hides uninstalled agents and grok-bot; counts hiddenForHost', () => {
    const h = host({ installed: ['claude-code'] });
    const r = scheduleProfilesFor({
      project: project({ remoteHostId: h.id }),
      profiles: ALL,
      hosts: [h],
      grokBotInProjectChats: true,
      grokBotStatus: status('running'),
    });
    // PI not installed, GROK_BOT agent_not_remote; GROK_DEFAULT already dropped
    expect(r.profiles.map((p) => p.id)).toEqual(['claude-code:opus-4.8']);
    expect(r.hiddenForHost).toBe(2);
    expect(r.hostName).toBe('node-a');
  });

  it('disconnected host hides all profiles', () => {
    const h = host({ state: 'disconnected', installed: ['claude-code', 'pi'] });
    const r = scheduleProfilesFor({
      project: project({ remoteHostId: h.id }),
      profiles: [CLAUDE, PI],
      hosts: [h],
      grokBotInProjectChats: false,
    });
    expect(r.profiles).toEqual([]);
    expect(r.hiddenForHost).toBe(2);
    expect(r.hostName).toBe('node-a');
  });

  it('disconnected host sets hostWarning', () => {
    const h = host({ state: 'disconnected', installed: ['claude-code'] });
    const r = scheduleProfilesFor({
      project: project({ remoteHostId: h.id }),
      profiles: [CLAUDE],
      hosts: [h],
      grokBotInProjectChats: false,
    });
    expect(r.hostWarning).toBe(
      'node-a is disconnected — runs will fail until it reconnects (the job auto-disables after 3 consecutive misses).',
    );
  });

  it('connected host leaves hostWarning unset', () => {
    const h = host({ state: 'connected', installed: ['claude-code'] });
    const r = scheduleProfilesFor({
      project: project({ remoteHostId: h.id }),
      profiles: [CLAUDE],
      hosts: [h],
      grokBotInProjectChats: false,
    });
    expect(r.hostWarning).toBeUndefined();
  });

  it('non-remote project leaves hostWarning unset', () => {
    const r = scheduleProfilesFor({
      project: project(),
      profiles: [CLAUDE],
      hosts: [host()],
      grokBotInProjectChats: false,
    });
    expect(r.hostWarning).toBeUndefined();
  });

  it('unknown host id in hosts sets hostWarning', () => {
    const r = scheduleProfilesFor({
      project: project({ remoteHostId: 'missing-host' }),
      profiles: [CLAUDE],
      hosts: [host()],
      grokBotInProjectChats: false,
    });
    expect(r.hostWarning).toBe(
      'missing-host is disconnected — runs will fail until it reconnects (the job auto-disables after 3 consecutive misses).',
    );
  });

  it('stopped Grok app keeps grok-bot profiles and sets grokBotWarning', () => {
    const r = scheduleProfilesFor({
      project: project(),
      profiles: ALL,
      hosts: [],
      grokBotInProjectChats: true,
      grokBotStatus: status('stopped'),
    });
    expect(r.profiles.some((p) => p.id === `grok-bot:${BOT}`)).toBe(true);
    expect(r.grokBotWarning).toBe(
      'Grok Bot app is not running — it will be started on demand when the job fires (if autostart allows).',
    );
  });
});
