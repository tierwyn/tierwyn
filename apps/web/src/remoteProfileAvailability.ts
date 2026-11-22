import { profileAvailableOnHost, type AgentProfile, type RemoteHostView } from '@tierwyn/shared';

const LABELS = {
  host_disconnected: 'host offline',
  agent_not_installed: 'not installed on host',
  model_not_on_host: 'model not on host',
  agent_not_remote: 'local only',
} as const;

export function remoteProfileAvailability(
  profiles: AgentProfile[],
  host: RemoteHostView | undefined,
): Record<string, string> {
  if (!host) return {};
  const out: Record<string, string> = {};
  for (const profile of profiles) {
    const avail = profileAvailableOnHost(profile, host);
    if (!avail.ok) out[profile.id] = LABELS[avail.reason];
  }
  return out;
}
