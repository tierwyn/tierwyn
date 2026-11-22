import type { Database } from 'better-sqlite3';
import type { AgentProfile, ScheduleJob } from '@tierwyn/shared';
import { SCHEDULE_INHERIT_PROFILE_ID } from '@tierwyn/shared';
import { catalogue } from '../catalogue.js';
import { lastSessionForConversation } from '../repositories/sessions.js';

/** Resolve the profile a tick will run with. 'inherit' → bound conversation's last session agentModelId. */
export function resolveJobProfile(db: Database, job: ScheduleJob):
  | { ok: true; profile: AgentProfile }
  | { ok: false; error: string } {
  if (job.profileId === SCHEDULE_INHERIT_PROFILE_ID) {
    if (!job.boundConversationId) {
      return { ok: false, error: 'bound conversation has no previous agent to inherit' };
    }
    const last = lastSessionForConversation(db, job.boundConversationId);
    const inheritedId = last?.agentModelId;
    if (!inheritedId) {
      return { ok: false, error: 'bound conversation has no previous agent to inherit' };
    }
    const profile = catalogue.getProfile(inheritedId);
    if (!profile || !profile.enabled) {
      return { ok: false, error: `unknown or disabled profile: ${inheritedId}` };
    }
    return { ok: true, profile };
  }

  const profile = catalogue.getProfile(job.profileId);
  if (!profile || !profile.enabled) {
    return { ok: false, error: `unknown or disabled profile: ${job.profileId}` };
  }
  return { ok: true, profile };
}
