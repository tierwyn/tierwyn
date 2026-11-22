import { describe, it, expect } from 'vitest';
import type { AgentProfile } from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import {
  isRemoteAgentsProject,
  isGrokBotProject,
  resolveRemoteAgentProfile,
  resolveConversationProfile,
} from './remoteAgentsProfile.js';

const mockProfiles: AgentProfile[] = [
  {
    id: 'claude-code:claude-opus-5',
    agentType: 'claude-code',
    model: 'claude-opus-5',
    label: 'Claude Code · Opus 5',
    description: '',
    vision: true,
    steer: true,
    enabled: true,
  },
  {
    id: 'grok-bot:bot-123',
    agentType: 'grok-bot',
    model: 'bot-123',
    label: 'Grok Bot · Existing Bot',
    description: '',
    vision: false,
    steer: true,
    enabled: true,
  },
];

describe('remoteAgentsProfile', () => {
  it('identifies remote agents project correctly', () => {
    expect(isRemoteAgentsProject(REMOTE_AGENTS_PROJECT_ID)).toBe(true);
    expect(isRemoteAgentsProject('regular-project-id')).toBe(false);
    expect(isRemoteAgentsProject(undefined)).toBe(false);
  });

  it('identifies grok-bot project folder correctly', () => {
    expect(isGrokBotProject({ id: REMOTE_AGENTS_PROJECT_ID, name: 'Grok Bots', rootPath: '/tmp', createdAt: 0 })).toBe(true);
    expect(isGrokBotProject({ id: 'any-id', system: true, name: 'Grok Bots', rootPath: '/tmp', createdAt: 0 })).toBe(true);
    expect(isGrokBotProject({ id: 'any-id', name: 'Grok Bots', rootPath: '/tmp', createdAt: 0 })).toBe(true);
    expect(isGrokBotProject({ id: 'other', name: 'Other', rootPath: '/tmp', createdAt: 0 })).toBe(false);
    expect(isGrokBotProject(null)).toBe(false);
    expect(isGrokBotProject(undefined)).toBe(false);
  });

  describe('resolveRemoteAgentProfile', () => {
    it('returns matched grok-bot profile when present in profiles list', () => {
      const p = resolveRemoteAgentProfile(mockProfiles, 'grok-bot:bot-123', undefined, 'Existing Bot');
      expect(p.id).toBe('grok-bot:bot-123');
      expect(p.agentType).toBe('grok-bot');
      expect(p.label).toBe('Grok Bot · Existing Bot');
    });

    it('synthesizes grok-bot profile when new bot is not yet in profiles list', () => {
      const p = resolveRemoteAgentProfile(
        mockProfiles,
        'grok-bot:new-bot-uuid',
        undefined,
        'My New Bot',
      );
      expect(p.id).toBe('grok-bot:new-bot-uuid');
      expect(p.agentType).toBe('grok-bot');
      expect(p.model).toBe('new-bot-uuid');
      expect(p.label).toBe('Grok Bot · My New Bot');
      expect(p.steer).toBe(true);
      expect(p.enabled).toBe(true);
    });

    it('falls back to lastSessionProfileId when selectedProfileId is blank or non-grok', () => {
      const p = resolveRemoteAgentProfile(
        mockProfiles,
        '',
        'grok-bot:seeded-bot-uuid',
        'Seeded Bot',
      );
      expect(p.id).toBe('grok-bot:seeded-bot-uuid');
      expect(p.agentType).toBe('grok-bot');
      expect(p.model).toBe('seeded-bot-uuid');
    });

    it('never returns a non-grok-bot profile even if selectedProfileId points to one', () => {
      const p = resolveRemoteAgentProfile(
        mockProfiles,
        'claude-code:claude-opus-5',
        undefined,
        'Some Bot',
      );
      expect(p.agentType).toBe('grok-bot');
      expect(p.id).toBe('grok-bot:default');
    });
  });

  describe('resolveConversationProfile', () => {
    it('uses remote agent resolver for remote agents project', () => {
      const p = resolveConversationProfile(
        mockProfiles,
        'unlisted-bot-profile',
        REMOTE_AGENTS_PROJECT_ID,
        'grok-bot:1e420bf4-b456-47bd-b344-4a6261495992',
        'New Bot',
      );
      expect(p?.agentType).toBe('grok-bot');
      expect(p?.id).toBe('grok-bot:1e420bf4-b456-47bd-b344-4a6261495992');
      expect(p?.model).toBe('1e420bf4-b456-47bd-b344-4a6261495992');
    });

    it('falls back to profiles[0] for standard project when profile is not found', () => {
      const p = resolveConversationProfile(
        mockProfiles,
        'non-existent-profile',
        'standard-project-id',
        undefined,
        'General Chat',
      );
      expect(p?.id).toBe('claude-code:claude-opus-5');
      expect(p?.agentType).toBe('claude-code');
    });
  });
});
