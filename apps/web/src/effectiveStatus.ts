import type { AgentStatus } from '@tierwyn/shared';

/**
 * Header / composer live status. The WS map is authoritative for
 * running/waiting; a transcript tail of `running` is not enough — after
 * hold-open `status:done` the server clears the map immediately via
 * `conversation_updated` while the event rAF buffer can still say running.
 */
export function resolveEffectiveStatus(opts: {
  wsStatus: AgentStatus | undefined;
  eventsStatus: AgentStatus;
  staleRunning: boolean;
}): AgentStatus {
  const { wsStatus, eventsStatus, staleRunning } = opts;
  if (wsStatus === 'running' || wsStatus === 'waiting') return wsStatus;
  if (staleRunning) return 'idle';
  if (wsStatus === 'error' && eventsStatus !== 'done' && eventsStatus !== 'idle') {
    return 'error';
  }
  // WS map empty + transcript still running/waiting = stale buffer or parked
  // hold-open after conversation_updated cleared the live entry. Do not keep
  // the composer in steer mode — Send must start a new prompt.
  if (eventsStatus === 'running' || eventsStatus === 'waiting') return 'idle';
  return eventsStatus;
}

/**
 * Wrapping-up window: the WS live map already dropped the conversation (turn
 * done / hold-open teardown) but the transcript buffer still streams and the
 * session record is still addressable. The composer offers a dimmed force-Stop
 * here — worst case the server answers "already ended". Zombie sessions
 * (staleRunning) require `hasCurrentSession` false, so they never qualify:
 * there is nothing left to stop.
 */
export function isWrappingUp(opts: {
  connected: boolean;
  effectiveStatus: AgentStatus;
  eventsStatus: AgentStatus;
  hasCurrentSession: boolean;
}): boolean {
  if (!opts.connected || !opts.hasCurrentSession) return false;
  if (opts.effectiveStatus !== 'idle') return false;
  return opts.eventsStatus === 'running' || opts.eventsStatus === 'waiting';
}
