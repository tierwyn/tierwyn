import type {
  AgentProfile, Conversation, GrokBotLifecycleState, GrokBotLifecycleStatus, Project,
} from '@tierwyn/shared';
import { REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';
import { isRemoteAgentsProject } from './remoteAgentsProfile.js';

export type GrokBotBanner = {
  text: string;
  severity: 'info' | 'warn' | 'error' | 'muted';
  action: 'start' | 'retry' | null;
  spinner: boolean;
};

/** Client-side of server `namesEnabledNonGrok`: `/profiles` is already
 *  enabled-only, so presence of any row for that agentType counts as enabled. */
export function namesEnabledNonGrok(
  profiles: AgentProfile[] | undefined,
  profileId: string | null | undefined,
  agent?: string | null,
): boolean {
  if ((profileId ?? '').startsWith('grok-bot:') || agent === 'grok-bot') return false;
  const agentId = agent || (profileId ? profileId.split(':')[0] : '');
  if (!agentId) return false;
  return (profiles ?? []).some((p) => p.agentType === agentId);
}

export function isGrokBotChat(
  conversation: Conversation | null | undefined,
  selectedProfile: AgentProfile | null | undefined,
  identity?: { lastSessionProfileId?: string | null; selectedProfileId?: string | null },
  profiles?: AgentProfile[],
): boolean {
  if (!conversation) return false;
  if (isRemoteAgentsProject(conversation.projectId)) return true;
  const selectedId = selectedProfile?.id ?? identity?.selectedProfileId;
  const selectedAgent = selectedProfile?.agentType;
  if (namesEnabledNonGrok(profiles, selectedId, selectedAgent)) return false;
  if (selectedProfile?.agentType === 'grok-bot') return true;
  if (identity?.lastSessionProfileId?.startsWith('grok-bot:')) return true;
  if (identity?.selectedProfileId?.startsWith('grok-bot:')) return true;
  return false;
}

/** Drop a GET snapshot that is older than the last WS (or later GET) apply.
 *  Frames apply on since >= prev even when the state differs at equal since
 *  (a genuine transition must not be dropped). Older frames still lose. */
export function applyGrokBotStatus(
  prev: GrokBotLifecycleStatus | null,
  next: GrokBotLifecycleStatus,
  source: 'get' | 'frame' = 'get',
): GrokBotLifecycleStatus {
  if (prev == null) return next;
  if (next.since < prev.since) return prev;
  if (source === 'get' && next.since === prev.since && next.state !== prev.state) return prev;
  return next;
}

export function grokBotEnabledFromProfiles(profiles: AgentProfile[], profilesLoaded = true): boolean {
  if (!profilesLoaded) return true;
  return profiles.some((p) => p.agentType === 'grok-bot');
}

export function filterGrokBotProject(projects: Project[], enabled: boolean): Project[] {
  if (enabled) return projects;
  return projects.filter((p) => !(p.system && p.id === REMOTE_AGENTS_PROJECT_ID));
}

export function statusDotColor(state: GrokBotLifecycleState): string {
  switch (state) {
    case 'running': return 'var(--green, #22c55e)';
    case 'starting':
    case 'backoff': return 'var(--amber, #f59e0b)';
    case 'failed':
    case 'running-no-cdp':
    case 'port-conflict': return 'var(--red, #ef4444)';
    default: return 'var(--text-muted, #888)';
  }
}

export function statusBanner(
  status: GrokBotLifecycleStatus | null | undefined,
  opts: { enabled: boolean; isGrokChat: boolean },
): GrokBotBanner | null {
  if (!opts.isGrokChat) return null;
  if (!opts.enabled || status?.state === 'disabled') {
    return {
      text: 'Grok Bot is disabled — enable in Settings → Grok Bot',
      severity: 'muted',
      action: null,
      spinner: false,
    };
  }
  if (!status) {
    return {
      text: 'Checking Grok Bot…',
      severity: 'muted',
      action: null,
      spinner: true,
    };
  }
  if (status.state === 'running') return null;

  const err = status.lastError ? `: ${status.lastError}` : '';
  switch (status.state) {
    case 'starting':
      return { text: 'Starting Grok Bot…', severity: 'info', action: null, spinner: true };
    case 'backoff': {
      const soon = status.nextAttemptAt != null && status.nextAttemptAt - Date.now() < 30_000;
      if (soon) return { text: 'Starting Grok Bot…', severity: 'info', action: null, spinner: true };
      return { text: `Starting Grok Bot${err}`, severity: 'warn', action: 'retry', spinner: false };
    }
    case 'failed':
    case 'running-no-cdp':
    case 'port-conflict':
      return {
        text: status.lastError
          ?? (status.state === 'running-no-cdp'
            ? 'Grok Bot is running without remote debugging'
            : status.state === 'port-conflict'
              ? 'Something else is answering on the Grok Bot CDP port'
              : 'Grok Bot failed to start'),
        severity: 'error',
        action: 'retry',
        spinner: false,
      };
    case 'no-display':
      return { text: 'No graphical session — log in to the desktop', severity: 'muted', action: null, spinner: false };
    case 'stopped':
      return { text: "Grok Bot isn't running", severity: 'muted', action: 'start', spinner: false };
    case 'not-installed':
      return { text: status.lastError ?? 'Grok Bot is not installed', severity: 'error', action: null, spinner: false };
    case 'unsupported':
      return { text: 'Grok Bot auto-start is only supported on Linux', severity: 'muted', action: null, spinner: false };
    default:
      return { text: status.lastError ?? `Grok Bot is ${status.state}`, severity: 'warn', action: null, spinner: false };
  }
}
