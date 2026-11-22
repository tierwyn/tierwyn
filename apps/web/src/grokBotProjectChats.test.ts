import { describe, expect, it } from 'vitest';
import { REMOTE_AGENTS_PROJECT_ID, type AgentProfile, type GrokBotLifecycleStatus } from '@tierwyn/shared';
import { filterProfilesForProjectChats } from './grokBotProjectChats.js';

function profile(partial: Partial<AgentProfile> & Pick<AgentProfile, 'id' | 'agentType'>): AgentProfile {
  return {
    label: partial.id,
    model: 'm',
    provider: 'x',
    enabled: true,
    vision: false,
    steer: false,
    ...partial,
  } as AgentProfile;
}

describe('filterProfilesForProjectChats', () => {
  const list = [
    profile({ id: 'claude-code:sonnet', agentType: 'claude-code' }),
    profile({ id: 'grok-bot:default', agentType: 'grok-bot' }),
    profile({ id: 'grok-bot:abc', agentType: 'grok-bot' }),
  ];

  it('keeps grok-bot when the flag is on', () => {
    expect(filterProfilesForProjectChats(list, {
      projectId: 'proj-1',
      grokBotInProjectChats: true,
    })).toHaveLength(3);
  });

  it('hides grok-bot in normal projects when the flag is off', () => {
    const out = filterProfilesForProjectChats(list, {
      projectId: 'proj-1',
      grokBotInProjectChats: false,
    });
    expect(out.map((p) => p.id)).toEqual(['claude-code:sonnet']);
  });

  it('keeps grok-bot in the Remote Agents project when the flag is off', () => {
    expect(filterProfilesForProjectChats(list, {
      projectId: REMOTE_AGENTS_PROJECT_ID,
      grokBotInProjectChats: false,
    })).toHaveLength(3);
  });

  it('drops grok-bot when status is unusable even in Remote Agents / with project chats on', () => {
    const unusable: GrokBotLifecycleStatus = {
      state: 'stopped',
      enabled: true,
      autoStart: 'off',
      envLocks: { autostart: false, watch: false },
      launcher: null,
      attribution: null,
      layout: 'native',
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lastErrorAt: null,
      since: 1,
    };
    const remote = filterProfilesForProjectChats(list, {
      projectId: REMOTE_AGENTS_PROJECT_ID,
      grokBotInProjectChats: false,
      grokBotStatus: unusable,
    });
    const projectOn = filterProfilesForProjectChats(list, {
      projectId: 'proj-1',
      grokBotInProjectChats: true,
      grokBotStatus: unusable,
    });
    expect(remote.map((p) => p.id)).toEqual(['claude-code:sonnet']);
    expect(projectOn.map((p) => p.id)).toEqual(['claude-code:sonnet']);
  });

  it('keeps grok-bot when status is null', () => {
    expect(filterProfilesForProjectChats(list, {
      projectId: 'proj-1',
      grokBotInProjectChats: true,
      grokBotStatus: null,
    })).toHaveLength(3);
  });
});
