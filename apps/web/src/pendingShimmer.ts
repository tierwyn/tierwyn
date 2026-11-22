/** Last-turn “thinking” bar. Conversation-global running is not enough:
 *  a hidden subagent_notify turn can be last while tokens stream on an
 *  older live session. */
export function shouldShowPendingShimmer(opts: {
  isLastTurn: boolean;
  agentStatus: string;
  hasStreamedContent: boolean;
  turnSessionId?: string;
  liveSessionId?: string | null;
}): boolean {
  if (!opts.isLastTurn) return false;
  if (opts.agentStatus !== 'running' && opts.agentStatus !== 'waiting') return false;
  if (opts.hasStreamedContent) return false;
  if (
    opts.turnSessionId &&
    opts.liveSessionId &&
    opts.turnSessionId !== opts.liveSessionId
  ) {
    return false;
  }
  return true;
}
