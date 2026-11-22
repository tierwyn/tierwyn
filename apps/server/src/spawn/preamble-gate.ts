import type { AgentProfile } from '@tierwyn/shared';

/** Whether a conversation at spawn-policy `depth` should receive the
 *  delegation preamble. Depth 0 (true roots + schedule ⏱ runs under
 *  schedule_home) uses maxConcurrentSpawns; deeper agent-spawned parents use
 *  maxGrandchildSpawns. Callers must pass spawnPolicyDepth, not raw tree depth. */
export function shouldInjectPreamble(args: {
  depth: number; hasTemplate: boolean; maxDepth: number;
  profile: Pick<AgentProfile, 'maxConcurrentSpawns' | 'maxGrandchildSpawns'> | undefined;
}): boolean {
  const { depth, hasTemplate, maxDepth, profile } = args;
  if (!hasTemplate || depth >= maxDepth || !profile) return false;
  const cap = depth === 0 ? profile.maxConcurrentSpawns : profile.maxGrandchildSpawns;
  return (cap ?? 0) > 0;
}
