import type { Database } from 'better-sqlite3';
import type { Conversation, Project, ResolvedAgentSearchScope } from '@tierwyn/shared';
import { resolveAgentSearchScope } from '@tierwyn/shared';
import { resolveSandboxFor } from './repositories/sandboxSettings.js';
import { lastSessionForConversation } from './repositories/sessions.js';
import { getGeneralSettings } from './repositories/settings.js';

export function effectiveAgentSearchScope(
  db: Database,
  conv: Conversation,
  project: Project | undefined,
  sandboxOn?: boolean,
): ResolvedAgentSearchScope {
  const on = sandboxOn
    ?? (!!project && resolveSandboxFor(
      db, conv, project, lastSessionForConversation(db, conv.id)?.agentId ?? '', null,
    ).on);
  return resolveAgentSearchScope({
    projectScope: project?.agentSearchScope ?? null,
    globalScope: getGeneralSettings(db).agentSearchScope,
    sandboxOn: on || !!project?.remoteHostId,
  });
}
