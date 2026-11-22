import { revokeSpawnTokensForConversation } from './tokens.js';

/** SessionManager surface this helper needs — tests stub the same shape. */
export interface CapabilityRefreshSessions {
  reapParkedSessions(conversationId: string, opts: { all: true }): Promise<unknown>;
  reissueSpawnToken(conversationId: string): Promise<unknown>;
  hasLiveSession?(conversationId: string): boolean;
}

/**
 * Kill parked sessions and live tokens for a conversation after its capability
 * profile changes. Re-issue only when a live session is still running — minting
 * without a session would leave an orphan token bound to a random sessionId
 * that nothing ever revokes.
 */
export async function refreshConversationCapabilityTokens(
  conversationId: string,
  sessionManager?: CapabilityRefreshSessions,
): Promise<void> {
  if (!sessionManager) {
    revokeSpawnTokensForConversation(conversationId);
    return;
  }
  await sessionManager.reapParkedSessions(conversationId, { all: true });
  const live = sessionManager.hasLiveSession?.(conversationId) === true;
  revokeSpawnTokensForConversation(conversationId);
  if (live) await sessionManager.reissueSpawnToken(conversationId);
}
