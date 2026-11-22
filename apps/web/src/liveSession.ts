/**
 * A terminal status / session_ended must only tear down conversation-level
 * live UI (amber dot, Stop, steer composer) when it belongs to the session
 * the client is tracking. A late session_ended from a reaped hold-open, or
 * from an overlapping mesh wake, must not grey the row while another session
 * is still running.
 *
 * conversation_updated frames have no sessionId — callers treat those as
 * applying (server must not fan a terminal status when another session is live).
 */
export function terminalAppliesToTrackedSession(
  currentSessionId: string | null,
  eventSessionId: string | undefined,
): boolean {
  if (!currentSessionId || !eventSessionId) return true;
  return currentSessionId === eventSessionId;
}

/**
 * For the subscribed conversation, ensure the session_ended frame matches
 * the tracked live session (and isn't a late event from a reaped hold-open session).
 * For background conversations, currentSessionId does not belong to that
 * conversation, so the frame always applies.
 */
export function sessionEndedApplies(
  subscribedConversationId: string | null,
  eventConversationId: string,
  currentSessionId: string | null,
  eventSessionId: string | undefined,
): boolean {
  if (eventConversationId !== subscribedConversationId) return true;
  return terminalAppliesToTrackedSession(currentSessionId, eventSessionId);
}

