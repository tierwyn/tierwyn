/**
 * Mid-turn composer routing for onSteer.
 *
 * After Send, the client marks the conversation running immediately, but
 * `currentSessionId` only arrives with `session_started`. A follow-up in that
 * gap must not fall back to a plain prompt — that path adopts the live session
 * with intent `auto` and silently queues, skipping Queue vs Interrupt & Send.
 */
export type SteerDispatch =
  | { kind: 'steer'; sessionId: string }
  | { kind: 'defer' }
  | { kind: 'prompt' };

export function decideSteerDispatch(opts: {
  isRunning: boolean;
  currentSessionId: string | null | undefined;
}): SteerDispatch {
  if (!opts.isRunning) return { kind: 'prompt' };
  if (!opts.currentSessionId) return { kind: 'defer' };
  return { kind: 'steer', sessionId: opts.currentSessionId };
}
