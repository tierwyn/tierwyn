import type { AgentStatus } from '@tierwyn/shared';

/**
 * Derive a sidebar/dot status from an active session's last observed status.
 * Returns undefined for parked hold-open sessions (done/idle) so refresh does
 * not stick an amber dot on an idle subprocess.
 */
export function liveAgentStatusFromSession(lastStatus: AgentStatus | undefined): AgentStatus | undefined {
  if (!lastStatus) return 'running';
  if (lastStatus === 'running' || lastStatus === 'waiting' || lastStatus === 'error') {
    return lastStatus;
  }
  return undefined;
}

export function liveAgentStatusForSession(
  session: { lastStatus?: AgentStatus } | undefined,
): AgentStatus | undefined {
  if (!session) return undefined;
  return liveAgentStatusFromSession(session.lastStatus);
}

/** True when another session on this conversation is still mid-turn.
 *  Used so a terminal status from session A cannot grey the conversation
 *  while session B is live (overlapping mesh wakes / late hold-open reap). */
export function hasOtherInFlightSession(
  sessions: ReadonlyArray<{ id: string; conversationId: string; lastStatus?: AgentStatus }>,
  conversationId: string,
  exceptSessionId: string,
): boolean {
  return sessions.some((s) =>
    s.conversationId === conversationId
    && s.id !== exceptSessionId
    && liveAgentStatusFromSession(s.lastStatus) !== undefined);
}

/**
 * Resolve the session id for a steer frame. Clients may send a stale/empty id
 * in the pre-session_started window; fall back to the conversation's in-flight
 * session so queue/force intent is not lost via a prompt-adopt path.
 */
export function resolveSteerTargetSessionId(
  requestedSessionId: string,
  conversationId: string,
  getSession: (id: string) => { id: string } | undefined,
  inFlightForConversation: (conversationId: string) => { id: string } | undefined,
): string {
  if (requestedSessionId && getSession(requestedSessionId)) return requestedSessionId;
  return inFlightForConversation(conversationId)?.id ?? requestedSessionId;
}
