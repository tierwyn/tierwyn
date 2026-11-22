import type { AgentProfile, GrokBotLifecycleStatus } from '@tierwyn/shared';
import { grokBotUsable, REMOTE_AGENTS_PROJECT_ID } from '@tierwyn/shared';

/** Drop grok-bot profiles from the chat picker when project chats are disabled
 *  or the Grok Bot app is unusable. */
export function filterProfilesForProjectChats(
  profiles: AgentProfile[],
  opts: {
    projectId: string | undefined | null;
    grokBotInProjectChats: boolean;
    grokBotStatus?: GrokBotLifecycleStatus | null;
  },
): AgentProfile[] {
  if (!grokBotUsable(opts.grokBotStatus)) return profiles.filter((p) => p.agentType !== 'grok-bot');
  if (opts.grokBotInProjectChats) return profiles;
  if (opts.projectId === REMOTE_AGENTS_PROJECT_ID) return profiles;
  return profiles.filter((p) => p.agentType !== 'grok-bot');
}
