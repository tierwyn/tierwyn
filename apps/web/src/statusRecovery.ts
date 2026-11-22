import type { AgentStatus } from '@tierwyn/shared';

/**
 * Conversation ids whose REST-cached `lastStatus: 'error'` has been superseded
 * by later non-error activity observed on this client (page-session state).
 *
 * The rule this encodes: an error dot is sticky only while the conversation is
 * unviewed AND no newer non-error activity has been seen. Without it, the dot
 * re-reddens from the stale REST snapshot as soon as the live map empties at
 * the end of a successful resume (see the plan's RC1).
 *
 * `'activity'` covers non-status signals that still prove liveness: an
 * optimistic prompt/command send, `session_started`, and `subscribe`.
 *
 * Semantics note (adversary F1): `subscribe` alone adds the id — so once a
 * conversation has been *opened* in this page session, a later error that
 * arrives only via REST `lastStatus` (no live WS status frame) stays
 * suppressed until reload. Live `error` frames still un-recover via
 * `status === 'error'`. A timestamped/generation map would tighten the
 * disconnect window if that case matters in practice.
 */
export function applyRecovery(
  prev: ReadonlySet<string>,
  conversationId: string,
  status: AgentStatus | 'activity',
): ReadonlySet<string> {
  if (status === 'error') {
    if (!prev.has(conversationId)) return prev;
    const next = new Set(prev);
    next.delete(conversationId);
    return next;
  }
  if (prev.has(conversationId)) return prev;
  const next = new Set(prev);
  next.add(conversationId);
  return next;
}
