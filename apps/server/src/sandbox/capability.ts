import { isAgentSandboxCapable, type NodeHello } from '@tierwyn/shared';
import { hasSandboxProfile } from './profiles.js';
import { bwrapAvailable } from './bwrap.js';

/** Server-side capability for resolveSandbox's `capable` input. */
export function sandboxCapability(
  hostId: string,
  agentType: string,
  hello?: Partial<NodeHello> | null,
): { ok: boolean; forced?: boolean; reason?: string } | null {
  const hasProfile = hasSandboxProfile(agentType);
  if (hostId === 'hub' || !hostId) {
    return isAgentSandboxCapable(agentType, {
      hasProfile,
      available: bwrapAvailable(),
      remote: false,
    });
  }
  return isAgentSandboxCapable(agentType, {
    hasProfile,
    available: hello?.sandbox?.available,
    features: hello?.features,
    policy: hello?.sandbox?.policy,
    remote: true,
  });
}
