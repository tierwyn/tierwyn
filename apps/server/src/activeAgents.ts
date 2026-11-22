import type {
  ActiveSessionsResponse, ActiveAgentSessionDto, ActiveAgentConversationDto,
  AgentStatus, EffortLevel, ConversationKind,
} from '@tierwyn/shared';
import { liveAgentStatusFromSession } from './liveStatus.js';

/** Structural subset of SessionRecord this module needs — keeps the builder
 *  free of adapters/AbortControllers so it is unit-testable with plain objects. */
export interface ActiveAgentSessionLike {
  id: string;
  conversationId: string;
  agentType: string;
  profileId: string;
  model: string;
  startedAt: number;
  effort?: EffortLevel;
  lastStatus?: AgentStatus;
  /** Length of SessionRecord.steerQueue. Stamped at the GET /sessions/active
   *  route; omitted/0 means no pending follow-up. */
  steerQueueLength?: number;
}

/**
 * Parked hold-open: last observed status is settled (`done`/`idle`) AND the
 * steer queue is empty. Mirrors SessionManager.waitForConversationSettle
 * ("Parked hold-open (status:done + empty queue) counts as settled") and the
 * inverse of hasPendingSteerWork, via liveAgentStatusFromSession rather than
 * SessionManager.TERMINAL so `error` stays visible for the operator to stop.
 *
 * liveAgentStatusFromSession(undefined) is `'running'` → NOT parked.
 * A non-empty steer queue means work is pending → NOT parked.
 */
export function isParkedSession(
  s: Pick<ActiveAgentSessionLike, 'lastStatus' | 'steerQueueLength'>,
): boolean {
  return liveAgentStatusFromSession(s.lastStatus) === undefined
    && (s.steerQueueLength ?? 0) === 0;
}

export interface ActiveAgentConversationRow {
  id: string;
  title: string;
  projectId: string;
  parentConversationId?: string;
  kind?: ConversationKind;
  description?: string;
  tags?: string[];
}

/** Cycle/runaway guard on the parentConversationId walk. */
export const MAX_ANCESTOR_DEPTH = 32;

export function buildActiveSessionsResponse(
  sessions: readonly ActiveAgentSessionLike[],
  lookupConversation: (id: string) => ActiveAgentConversationRow | undefined,
  lookupProject: (id: string) => { id: string; name: string } | undefined,
  now: number,
): ActiveSessionsResponse {
  // Filter here — not in SessionManager.activeSessions(). Other subsystems
  // (notifyParent, native-availability) still need parked hold-opens.
  const visible = sessions.filter((s) => !isParkedSession(s));

  const sessionDtos: ActiveAgentSessionDto[] = visible.map((s) => {
    const status = liveAgentStatusFromSession(s.lastStatus) ?? 'idle';
    return {
      sessionId: s.id,
      conversationId: s.conversationId,
      agentType: s.agentType,
      profileId: s.profileId,
      model: s.model,
      status,
      startedAt: s.startedAt,
      ...(s.effort ? { effort: s.effort } : {}),
    };
  });

  const conversations: ActiveAgentConversationDto[] = [];
  const seen = new Set<string>();

  const emitConversation = (id: string, depth: number): void => {
    if (seen.has(id)) return;
    if (depth > MAX_ANCESTOR_DEPTH) return;
    seen.add(id);
    const row = lookupConversation(id);
    if (!row) {
      conversations.push({ id, title: '(deleted conversation)', projectId: '' });
      return;
    }
    conversations.push({
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      ...(row.parentConversationId ? { parentConversationId: row.parentConversationId } : {}),
      ...(row.kind ? { kind: row.kind } : {}),
      ...(row.description ? { description: row.description } : {}),
      ...(row.tags && row.tags.length > 0 ? { tags: row.tags } : {}),
    });
    if (row.parentConversationId) {
      emitConversation(row.parentConversationId, depth + 1);
    }
  };

  for (const s of visible) {
    emitConversation(s.conversationId, 0);
  }

  const projects: { id: string; name: string }[] = [];
  const seenProjects = new Set<string>();
  for (const c of conversations) {
    if (!c.projectId || seenProjects.has(c.projectId)) continue;
    const p = lookupProject(c.projectId);
    if (!p) continue;
    seenProjects.add(p.id);
    projects.push({ id: p.id, name: p.name });
  }

  return { sessions: sessionDtos, conversations, projects, now };
}
