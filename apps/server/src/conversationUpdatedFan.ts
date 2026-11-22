import type { AgentStatus, ServerFrame } from '@tierwyn/shared';

/** Pull AgentStatus off a SessionManager broadcast frame, if it is a status event. */
export function statusFromSessionFrame(frame: ServerFrame): AgentStatus | undefined {
  if (frame.type === 'event' && frame.event.type === 'status') {
    return frame.event.payload.status;
  }
  return undefined;
}

/**
 * Operator-global sidebar unread/live-status frame. Same shape the index.ts
 * SessionManager.broadcast wrapper fans to every open WebSocket.
 */
export function conversationUpdatedFromSessionFrame(
  conversationId: string,
  frame: ServerFrame,
  ts: number,
): Extract<ServerFrame, { type: 'conversation_updated' }> {
  return {
    type: 'conversation_updated',
    conversationId,
    ts,
    status: statusFromSessionFrame(frame),
  };
}

/**
 * Hold a terminal `conversation_updated` frame until the Jev verdict is in, then fan it
 * stamped with `interruptWorthy` (plain frame when the verdict is undefined). A frame made
 * stale by a newer status frame (`isStale()`) is dropped so it cannot grey a live badge.
 * Resolves the verdict either way so the caller can still push.
 */
export async function holdTerminalFrame(
  frame: Extract<ServerFrame, { type: 'conversation_updated' }>,
  verdict: Promise<boolean | undefined>,
  isStale: () => boolean,
  fan: (f: ServerFrame) => void,
): Promise<boolean | undefined> {
  const w = await verdict.catch(() => undefined);
  if (!isStale()) fan(w === undefined ? frame : { ...frame, interruptWorthy: w });
  return w;
}
