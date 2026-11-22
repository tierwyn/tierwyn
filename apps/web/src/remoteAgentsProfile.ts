import type { AgentProfile, Project } from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';

export function isRemoteAgentsProject(projectId: string | undefined): boolean {
  return projectId === REMOTE_AGENTS_PROJECT_ID;
}

export function isGrokBotProject(project: Partial<Project> | null | undefined): boolean {
  if (!project) return false;
  return Boolean(project.system || project.id === REMOTE_AGENTS_PROJECT_ID || project.name === 'Grok Bots');
}

export function resolveRemoteAgentProfile(
  profiles: AgentProfile[],
  selectedProfileId: string,
  lastSessionProfileId: string | undefined,
  conversationTitle: string | undefined,
): AgentProfile {
  const match = profiles.find((p) => p.id === selectedProfileId && p.agentType === 'grok-bot');
  if (match) return match;

  const candidateId = selectedProfileId.startsWith('grok-bot:')
    ? selectedProfileId
    : (lastSessionProfileId?.startsWith('grok-bot:') ? lastSessionProfileId : '');

  const botId = candidateId.startsWith('grok-bot:')
    ? candidateId.slice('grok-bot:'.length)
    : 'default';

  return {
    id: candidateId || `grok-bot:${botId}`,
    agentType: 'grok-bot',
    model: botId,
    label: conversationTitle ? `Grok Bot · ${conversationTitle}` : 'Grok Bot',
    description: '',
    vision: false,
    steer: true,
    enabled: true,
  };
}

export function resolveConversationProfile(
  profiles: AgentProfile[],
  selectedProfileId: string,
  projectId: string | undefined,
  lastSessionProfileId: string | undefined,
  conversationTitle: string | undefined,
): AgentProfile | undefined {
  if (isRemoteAgentsProject(projectId)) {
    return resolveRemoteAgentProfile(profiles, selectedProfileId, lastSessionProfileId, conversationTitle);
  }
  return profiles.find((p) => p.id === selectedProfileId) ?? profiles[0];
}
