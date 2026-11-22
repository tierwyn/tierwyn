import type {
  AgentProfile,
  ExecutionMode,
  GrokBotLifecycleStatus,
  Project,
  RemoteHostView,
} from '@tierwyn/shared';
import {
  agentTakesBarePrompt,
  grokBotUsable,
  profileAvailableOnHost,
} from '@tierwyn/shared';
import { isRemoteAgentsProject } from './remoteAgentsProfile.js';

export interface ScheduleProfilesInput {
  project: Project | undefined;
  profiles: AgentProfile[];               // enabled /profiles rows
  hosts: RemoteHostView[];
  grokBotInProjectChats: boolean;
  grokBotStatus?: GrokBotLifecycleStatus | null;
}

export interface ScheduleProfilesResult {
  profiles: AgentProfile[];
  hiddenForHost: number;                  // count hidden by profileAvailableOnHost
  hostName?: string;
  hostWarning?: string;                   // set when project's host is disconnected or unknown
  grokBotWarning?: string;                // set when grok-bot offered but !grokBotUsable
}

const GROK_DEFAULT = 'grok-bot:default';
const GROK_WARN =
  'Grok Bot app is not running — it will be started on demand when the job fires (if autostart allows).';

export function isBarePromptProfile(p: Pick<AgentProfile, 'agentType'> | undefined): boolean {
  return agentTakesBarePrompt(p?.agentType);
}

/**
 * When non-null, the create-schedule modal must lock to this execution mode.
 * Remote Agents and grok-bot profiles cannot spawn a new run each time (lease theft).
 */
export function forcedExecutionMode(
  project: Pick<Project, 'id'> | undefined | null,
  profile: Pick<AgentProfile, 'agentType'> | undefined | null,
): ExecutionMode | null {
  if (isRemoteAgentsProject(project?.id)) return 'resume_conversation';
  if (profile && agentTakesBarePrompt(profile.agentType)) return 'resume_conversation';
  return null;
}

export function scheduleProfilesFor(input: ScheduleProfilesInput): ScheduleProfilesResult {
  const { project, profiles, hosts, grokBotInProjectChats, grokBotStatus } = input;

  let list = profiles.filter((p) => p.id !== GROK_DEFAULT);

  if (isRemoteAgentsProject(project?.id)) {
    list = list.filter((p) => p.agentType === 'grok-bot');
  } else if (!grokBotInProjectChats) {
    list = list.filter((p) => p.agentType !== 'grok-bot');
  }

  let hiddenForHost = 0;
  let hostName: string | undefined;
  let hostWarning: string | undefined;
  if (project?.remoteHostId) {
    const host = hosts.find((h) => h.id === project.remoteHostId);
    hostName = host?.name || host?.hello?.hostname || project.remoteHostId;
    if (!host || host.state !== 'connected') {
      hostWarning =
        `${hostName} is disconnected — runs will fail until it reconnects (the job auto-disables after 3 consecutive misses).`;
    }
    const kept: AgentProfile[] = [];
    for (const p of list) {
      if (profileAvailableOnHost(p, host).ok) kept.push(p);
      else hiddenForHost += 1;
    }
    list = kept;
  }

  let grokBotWarning: string | undefined;
  if (list.some((p) => p.agentType === 'grok-bot') && !grokBotUsable(grokBotStatus)) {
    grokBotWarning = GROK_WARN;
  }

  return { profiles: list, hiddenForHost, hostName, hostWarning, grokBotWarning };
}
